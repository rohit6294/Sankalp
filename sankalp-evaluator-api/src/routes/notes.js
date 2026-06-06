const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { admin, db } = require('../firebase');
const { verifyToken, requirePermission } = require('../auth');

const router = express.Router();

// ── Razorpay helpers (reuse pattern from payment.js) ─────────────────────────
let razorpay = null;
let razorpayKeyId = null;

function getRazorpayInstance() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw new Error('Razorpay credentials not set.');
  if (razorpay && razorpayKeyId === keyId) return razorpay;
  razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
  razorpayKeyId = keyId;
  return razorpay;
}

function signaturesMatch(a, b) {
  const sigA = Buffer.from(String(a || ''), 'utf8');
  const sigB = Buffer.from(String(b || ''), 'utf8');
  return sigA.length === sigB.length && crypto.timingSafeEqual(sigA, sigB);
}

// ══════════════════════════════════════════════════════════════════════════════
// CATEGORY MANAGEMENT (Admin)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/notes/categories — fetch all categories (any authenticated user)
router.get('/categories', verifyToken, async (_req, res) => {
  try {
    const snap = await db.collection('noteCategories').get();
    const categories = [];
    snap.forEach(doc => categories.push({ id: doc.id, ...doc.data() }));
    categories.sort((a, b) => (a.order || 0) - (b.order || 0));
    res.json({ ok: true, categories });
  } catch (e) {
    res.status(500).json({ error: 'categories_load_failed', message: e.message });
  }
});

// POST /api/notes/categories — create a category (admin only)
router.post('/categories', verifyToken, requirePermission('content', 'edit'), async (req, res) => {
  const { name, type, parentId, order } = req.body || {};
  if (!name || !type) return res.status(400).json({ error: 'missing_fields', message: 'name and type are required.' });
  if (!['subject', 'section', 'subsection'].includes(type)) {
    return res.status(400).json({ error: 'invalid_type', message: 'type must be subject, section, or subsection.' });
  }
  try {
    const data = {
      name: String(name).trim(),
      type,
      parentId: parentId || null,
      order: typeof order === 'number' ? order : 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const ref = await db.collection('noteCategories').add(data);
    res.json({ ok: true, id: ref.id, ...data });
  } catch (e) {
    res.status(500).json({ error: 'category_create_failed', message: e.message });
  }
});

// PUT /api/notes/categories/:id — update a category (admin only)
router.put('/categories/:id', verifyToken, requirePermission('content', 'edit'), async (req, res) => {
  const { id } = req.params;
  const updates = {};
  if (req.body.name !== undefined) updates.name = String(req.body.name).trim();
  if (req.body.order !== undefined) updates.order = Number(req.body.order);
  if (req.body.parentId !== undefined) updates.parentId = req.body.parentId || null;
  try {
    await db.collection('noteCategories').doc(id).update(updates);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'category_update_failed', message: e.message });
  }
});

// DELETE /api/notes/categories/:id — delete a category (admin only)
router.delete('/categories/:id', verifyToken, requirePermission('content', 'edit'), async (req, res) => {
  const { id } = req.params;
  try {
    // Also delete child categories
    const children = await db.collection('noteCategories').where('parentId', '==', id).get();
    const batch = db.batch();
    children.forEach(doc => {
      batch.delete(doc.ref);
    });
    batch.delete(db.collection('noteCategories').doc(id));
    await batch.commit();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'category_delete_failed', message: e.message });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// NOTES LISTING & ACCESS (Student)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/notes/list — fetch notes for students
router.get('/list', verifyToken, async (req, res) => {
  try {
    const snap = await db.collection('notes').orderBy('createdAt', 'desc').get();
    const notes = [];
    snap.forEach(doc => {
      const d = doc.data();
      if (d.status === 'active') {
        if (req.query.subjectId && d.subjectId !== req.query.subjectId) return;
        if (req.query.sectionId && d.sectionId !== req.query.sectionId) return;
        if (req.query.subsectionId && d.subsectionId !== req.query.subsectionId) return;
        
        notes.push({
          id: doc.id,
          title: d.title,
          description: d.description,
          subject: d.subject,
          subjectId: d.subjectId,
          sectionId: d.sectionId,
          subsectionId: d.subsectionId,
          sectionName: d.sectionName,
          subsectionName: d.subsectionName,
          fileName: d.fileName,
          fileType: d.fileType || 'pdf',
          fileSize: d.fileSize,
          access: d.access || 'free',
          price: d.price || 0,
          viewCount: d.viewCount || 0,
          purchaseCount: d.purchaseCount || 0,
          createdAt: d.createdAt,
        });
      }
    });
    res.json({ ok: true, notes });
  } catch (e) {
    res.status(500).json({ error: 'notes_load_failed', message: e.message });
  }
});

// GET /api/notes/access/:noteId — check if user has access to a note
router.get('/access/:noteId', verifyToken, async (req, res) => {
  const { noteId } = req.params;
  const uid = req.user.uid;
  try {
    // First check if note is free
    const noteDoc = await db.collection('notes').doc(noteId).get();
    if (!noteDoc.exists) return res.status(404).json({ error: 'not_found' });
    const note = noteDoc.data();
    
    if (note.access === 'free') {
      return res.json({ ok: true, hasAccess: true, type: 'free', fileUrl: note.fileUrl, files: note.files });
    }
    
    // Check purchase record
    const purchaseDoc = await db.collection('notePurchases').doc(`${noteId}_${uid}`).get();
    if (purchaseDoc.exists) {
      return res.json({ ok: true, hasAccess: true, type: 'purchased', fileUrl: note.fileUrl, files: note.files });
    }
    
    return res.json({ ok: true, hasAccess: false, price: note.price, files: note.files });
  } catch (e) {
    res.status(500).json({ error: 'access_check_failed', message: e.message });
  }
});

// POST /api/notes/log-access — log a note view event
router.post('/log-access', verifyToken, async (req, res) => {
  const { noteId, noteTitle } = req.body || {};
  if (!noteId) return res.status(400).json({ error: 'missing_noteId' });
  const uid = req.user.uid;
  try {
    // Get user info
    const userDoc = await db.collection('users').doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    
    await db.collection('noteAccessLogs').add({
      noteId,
      userId: uid,
      userName: userData.name || userData.displayName || 'Unknown',
      userEmail: userData.email || req.user.email || '',
      noteTitle: noteTitle || '',
      action: 'viewed',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
    
    // Increment view count
    await db.collection('notes').doc(noteId).update({
      viewCount: admin.firestore.FieldValue.increment(1),
    });
    
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'log_failed', message: e.message });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// PAYMENT FOR NOTES (Student)
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/notes/create-order — create Razorpay order for a paid note
router.post('/create-order', verifyToken, async (req, res) => {
  const { noteId } = req.body || {};
  if (!noteId) return res.status(400).json({ error: 'missing_noteId' });
  
  try {
    const rzp = getRazorpayInstance();
    
    // Get note details from Firestore (server-side price validation)
    const noteDoc = await db.collection('notes').doc(noteId).get();
    if (!noteDoc.exists) return res.status(404).json({ error: 'note_not_found' });
    const note = noteDoc.data();
    
    if (note.access === 'free') {
      return res.status(400).json({ error: 'note_is_free', message: 'This note is free. No payment required.' });
    }
    
    // Check if already purchased
    const existingPurchase = await db.collection('notePurchases').doc(`${noteId}_${req.user.uid}`).get();
    if (existingPurchase.exists) {
      return res.status(409).json({ error: 'already_purchased', message: 'You have already purchased this note.' });
    }
    
    const price = Number(note.price);
    const amountPaise = Math.round(price * 100);
    if (isNaN(amountPaise) || amountPaise < 100) {
      return res.status(400).json({ error: 'invalid_price', message: 'Note price is invalid.' });
    }
    
    const receiptId = `receipt_note_${req.user.uid.substring(0, 8)}_${Date.now()}`;
    const order = await rzp.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: receiptId,
    });
    
    // Store order in Firestore
    await db.collection('noteOrders').doc(order.id).set({
      userId: req.user.uid,
      noteId,
      noteTitle: note.title || '',
      product: 'note',
      amount: order.amount,
      price,
      currency: order.currency,
      status: 'created',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    
    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error('Failed to create note order:', err);
    res.status(500).json({ error: 'order_creation_failed', message: err.message });
  }
});

// POST /api/notes/verify-payment — verify payment & grant access
router.post('/verify-payment', verifyToken, async (req, res) => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature, noteId } = req.body || {};
  
  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature || !noteId) {
    return res.status(400).json({ error: 'missing_fields', message: 'Missing required payment fields.' });
  }
  
  try {
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) return res.status(500).json({ error: 'missing_credentials' });
    
    // Verify signature
    const text = `${razorpay_order_id}|${razorpay_payment_id}`;
    const generated = crypto.createHmac('sha256', keySecret).update(text).digest('hex');
    if (!signaturesMatch(generated, razorpay_signature)) {
      return res.status(400).json({ error: 'signature_mismatch', message: 'Payment verification failed.' });
    }
    
    // Verify order belongs to this user
    const orderRef = db.collection('noteOrders').doc(razorpay_order_id);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists || orderDoc.data().userId !== req.user.uid) {
      return res.status(400).json({ error: 'order_mismatch', message: 'Order does not belong to you.' });
    }
    
    const pendingOrder = orderDoc.data();
    
    // Fetch payment from Razorpay to verify capture
    const payment = await getRazorpayInstance().payments.fetch(razorpay_payment_id);
    if (
      payment.order_id !== razorpay_order_id
      || Number(payment.amount) !== Number(pendingOrder.amount)
      || payment.status !== 'captured'
    ) {
      return res.status(400).json({ error: 'payment_not_captured', message: 'Payment was not captured correctly.' });
    }
    
    // Get user details
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const name = userData.name || userData.displayName || 'Unknown Student';
    const email = userData.email || req.user.email || '';
    
    // Get note details
    const noteDoc = await db.collection('notes').doc(noteId).get();
    const noteData = noteDoc.exists ? noteDoc.data() : {};
    
    // Record purchase
    const purchaseRef = db.collection('notePurchases').doc(`${noteId}_${req.user.uid}`);
    await purchaseRef.set({
      noteId,
      userId: req.user.uid,
      noteTitle: noteData.title || pendingOrder.noteTitle || '',
      userName: name,
      userEmail: email,
      amount: pendingOrder.price,
      type: 'purchase',
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      accessedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    
    // Also log in purchases collection (unified purchase log)
    await db.collection('purchases').doc(`${req.user.uid}_note_${noteId}`).set({
      userId: req.user.uid,
      email,
      name,
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      amount: pendingOrder.price,
      purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
      product: 'note',
      productId: noteId,
      productTitle: noteData.title || '',
      status: 'success',
    });
    
    // Log access event
    await db.collection('noteAccessLogs').add({
      noteId,
      userId: req.user.uid,
      userName: name,
      userEmail: email,
      noteTitle: noteData.title || '',
      action: 'purchased',
      amount: pendingOrder.price,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
    
    // Increment purchase count on note
    await db.collection('notes').doc(noteId).update({
      purchaseCount: admin.firestore.FieldValue.increment(1),
    });
    
    // Update order status
    await orderRef.set({
      status: 'success',
      paymentId: razorpay_payment_id,
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    
    res.json({ success: true, message: 'Payment verified. You now have access to this note.', fileUrl: noteData.fileUrl });
  } catch (err) {
    console.error('Note payment verification failed:', err);
    res.status(500).json({ error: 'verification_failed', message: err.message });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// ADMIN LOG VIEWING
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/notes/logs/:noteId — fetch access logs for a specific note (admin)
router.get('/logs/:noteId', verifyToken, requirePermission('content', 'view'), async (req, res) => {
  const { noteId } = req.params;
  try {
    const snap = await db.collection('noteAccessLogs')
      .where('noteId', '==', noteId)
      .orderBy('timestamp', 'desc')
      .limit(200)
      .get();
    const logs = [];
    snap.forEach(doc => {
      const d = doc.data();
      logs.push({
        id: doc.id,
        ...d,
        timestamp: d.timestamp?.toDate?.() || d.timestamp,
      });
    });
    res.json({ ok: true, logs });
  } catch (e) {
    res.status(500).json({ error: 'logs_load_failed', message: e.message });
  }
});

// GET /api/notes/user-logs/:userId — fetch all note activity for a specific student (admin)
router.get('/user-logs/:userId', verifyToken, requirePermission('students', 'view'), async (req, res) => {
  const { userId } = req.params;
  try {
    const snap = await db.collection('noteAccessLogs')
      .where('userId', '==', userId)
      .orderBy('timestamp', 'desc')
      .limit(200)
      .get();
    const logs = [];
    snap.forEach(doc => {
      const d = doc.data();
      logs.push({
        id: doc.id,
        ...d,
        timestamp: d.timestamp?.toDate?.() || d.timestamp,
      });
    });
    
    // Also fetch purchase records
    const purchasesSnap = await db.collection('notePurchases')
      .where('userId', '==', userId)
      .get();
    const purchases = [];
    purchasesSnap.forEach(doc => {
      const d = doc.data();
      purchases.push({
        id: doc.id,
        ...d,
        accessedAt: d.accessedAt?.toDate?.() || d.accessedAt,
      });
    });
    
    res.json({ ok: true, logs, purchases });
  } catch (e) {
    res.status(500).json({ error: 'user_logs_failed', message: e.message });
  }
});

// GET /api/notes/purchases — fetch all note purchases (admin, for filtering)
router.get('/purchases', verifyToken, requirePermission('content', 'view'), async (req, res) => {
  try {
    let query = db.collection('notePurchases');
    if (req.query.noteId) {
      query = query.where('noteId', '==', req.query.noteId);
    }
    const snap = await query.get();
    const purchases = [];
    snap.forEach(doc => {
      const d = doc.data();
      purchases.push({
        id: doc.id,
        ...d,
        accessedAt: d.accessedAt?.toDate?.() || d.accessedAt,
      });
    });
    res.json({ ok: true, purchases });
  } catch (e) {
    res.status(500).json({ error: 'purchases_load_failed', message: e.message });
  }
});



// GET /api/notes/all — fetch ALL notes including draft (admin only, for logs UI)
router.get('/all', verifyToken, requirePermission('content', 'view'), async (req, res) => {
  try {
    const snap = await db.collection('notes').orderBy('createdAt', 'desc').get();
    const notes = [];
    snap.forEach(doc => {
      notes.push({ id: doc.id, ...doc.data() });
    });
    res.json({ ok: true, notes });
  } catch (e) {
    res.status(500).json({ error: 'notes_load_failed', message: e.message });
  }
});

// POST /api/notes — create a note (admin only)
router.post('/', verifyToken, requirePermission('content', 'edit'), async (req, res) => {
  try {
    const data = { ...req.body, createdAt: admin.firestore.FieldValue.serverTimestamp() };
    const ref = await db.collection('notes').add(data);
    res.json({ ok: true, id: ref.id });
  } catch (e) {
    res.status(500).json({ error: 'note_create_failed', message: e.message });
  }
});

// PUT /api/notes/:id — update a note (admin only)
router.put('/:id', verifyToken, requirePermission('content', 'edit'), async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection('notes').doc(id).update(req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'note_update_failed', message: e.message });
  }
});

// DELETE /api/notes/:id — delete a note (admin only)
router.delete('/:id', verifyToken, requirePermission('content', 'edit'), async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection('notes').doc(id).delete();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'note_delete_failed', message: e.message });
  }
});


module.exports = router;
