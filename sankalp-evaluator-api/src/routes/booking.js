const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { admin, db } = require('../firebase');
const { verifyToken, requireAdmin } = require('../auth');
const { sendEmail } = require('../mailer');

const router = express.Router();

let razorpay = null;
let razorpayKeyId = null;

function getRazorpayInstance() {
  const keyId = (process.env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
  if (!keyId || !keySecret) {
    throw new Error('Razorpay credentials not set in environment.');
  }
  if (razorpay && razorpayKeyId === keyId) return razorpay;
  razorpay = new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
  razorpayKeyId = keyId;
  return razorpay;
}

function signaturesMatch(a, b) {
  const sigA = Buffer.from(String(a || ''), 'utf8');
  const sigB = Buffer.from(String(b || ''), 'utf8');
  return sigA.length === sigB.length && crypto.timingSafeEqual(sigA, sigB);
}

// Helper to generate slots
function generateSlotsList(date, startTime, endTime, slotDuration, breakDuration) {
  const generated = [];
  const [startH, startM] = startTime.split(':').map(Number);
  const [endH, endM] = endTime.split(':').map(Number);
  
  let current = new Date(Date.UTC(2000, 0, 1, startH, startM));
  const end = new Date(Date.UTC(2000, 0, 1, endH, endM));
  
  while (current < end) {
    const slotStart = new Date(current);
    const slotEnd = new Date(current.getTime() + slotDuration * 60 * 1000);
    
    if (slotEnd > end) break;
    
    const formatTime = (dateObj) => {
      let hours = dateObj.getUTCHours();
      const minutes = String(dateObj.getUTCMinutes()).padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      hours = hours ? hours : 12;
      return `${hours}:${minutes} ${ampm}`;
    };
    
    generated.push({
      startTime: formatTime(slotStart),
      endTime: formatTime(slotEnd),
      startRaw: `${String(slotStart.getUTCHours()).padStart(2, '0')}:${String(slotStart.getUTCMinutes()).padStart(2, '0')}`,
      endRaw: `${String(slotEnd.getUTCHours()).padStart(2, '0')}:${String(slotEnd.getUTCMinutes()).padStart(2, '0')}`
    });
    
    current = new Date(slotEnd.getTime() + breakDuration * 60 * 1000);
  }
  
  return generated;
}

// ── STUDENT ENDPOINTS ──

// Get available slots for a specific date
router.get('/slots', verifyToken, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'missing_date' });

  try {
    const snapshot = await db.collection('slots').where('date', '==', date).get();
    const slots = [];
    const now = Date.now();

    snapshot.forEach(doc => {
      const data = doc.data();
      let status = data.status || 'available';

      // Lock expiration check (5 minutes)
      if (status === 'locked' && data.lockedAt) {
        const lockedTime = data.lockedAt.toDate().getTime();
        if (now - lockedTime > 5 * 60 * 1000) {
          status = 'available';
        }
      }

      // Show if available, or locked by the current user
      if (status === 'available' || (status === 'locked' && data.lockedBy === req.user.uid)) {
        slots.push({
          id: doc.id,
          date: data.date,
          startTime: data.startTime,
          endTime: data.endTime,
          status,
          price: data.price || 0,
          lockedByMe: data.lockedBy === req.user.uid
        });
      }
    });

    // Sort slots by start time
    slots.sort((a, b) => a.startTime.localeCompare(b.startTime));

    res.json({ ok: true, slots });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_fetch_slots', message: e.message });
  }
});

// Lock a slot and initiate order creation
router.post('/lock-slot', verifyToken, async (req, res) => {
  const { slotId, topic, phone, email } = req.body || {};
  if (!slotId || !topic || !phone || !email) {
    return res.status(400).json({ error: 'missing_fields', message: 'All booking fields are required.' });
  }

  const userDoc = await db.collection('users').doc(req.user.uid).get();
  const userName = userDoc.exists ? (userDoc.data().name || userDoc.data().displayName || 'Student') : 'Student';

  try {
    const slotRef = db.collection('slots').doc(slotId);
    let razorpayOrder = null;
    let finalPrice = 0;

    await db.runTransaction(async (transaction) => {
      const slotDoc = await transaction.get(slotRef);
      if (!slotDoc.exists) {
        throw new Error('Slot does not exist.');
      }

      const data = slotDoc.data();
      const now = Date.now();
      let status = data.status || 'available';

      if (status === 'locked' && data.lockedAt) {
        const lockedTime = data.lockedAt.toDate().getTime();
        if (now - lockedTime > 5 * 60 * 1000) {
          status = 'available';
        }
      }

      if (status !== 'available' && data.lockedBy !== req.user.uid) {
        throw new Error('Slot is already booked or locked by another student.');
      }

      finalPrice = data.price || 0;

      // Lock updates
      transaction.update(slotRef, {
        status: 'locked',
        lockedBy: req.user.uid,
        lockedAt: admin.firestore.FieldValue.serverTimestamp(),
        studentName: userName,
        studentEmail: email,
        studentPhone: phone,
        topic: topic
      });
    });

    // If price is 0, complete booking instantly
    if (finalPrice === 0) {
      await slotRef.update({
        status: 'booked',
        bookedBy: req.user.uid,
        bookedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Send emails asynchronously
      sendConfirmationEmails(slotId, userName, email, phone, topic, 'Free', 'Free Session').catch(console.error);

      return res.json({ ok: true, free: true });
    }

    // Create Razorpay Order
    const rzp = getRazorpayInstance();
    const amountPaise = Math.round(finalPrice * 100);
    const receiptId = `bk_${slotId.substring(0, 12)}_${Date.now()}`;
    
    razorpayOrder = await rzp.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: receiptId
    });

    await slotRef.update({
      razorpayOrderId: razorpayOrder.id
    });

    res.json({
      ok: true,
      free: false,
      order_id: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      key_id: (process.env.RAZORPAY_KEY_ID || '').trim()
    });

  } catch (e) {
    const errorMsg = (e.error && e.error.description) ? e.error.description : e.message;
    console.error('Lock slot error:', e);
    res.status(409).json({ error: 'lock_failed', message: errorMsg || 'Unknown error occurred during lock slot.' });
  }
});

// Release a locked slot manually (if student cancels payment)
router.post('/unlock-slot', verifyToken, async (req, res) => {
  const { slotId } = req.body || {};
  if (!slotId) return res.status(400).json({ error: 'missing_slotId' });

  try {
    const slotRef = db.collection('slots').doc(slotId);
    const slotDoc = await slotRef.get();
    if (slotDoc.exists) {
      const data = slotDoc.data();
      if (data.status === 'locked' && data.lockedBy === req.user.uid) {
        await slotRef.update({
          status: 'available',
          lockedBy: null,
          lockedAt: null,
          studentName: null,
          studentEmail: null,
          studentPhone: null,
          topic: null,
          razorpayOrderId: null
        });
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'unlock_failed', message: e.message });
  }
});

// Verify signature and finalize booking
router.post('/verify-payment', verifyToken, async (req, res) => {
  const { slotId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!slotId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'missing_fields', message: 'Missing payment signature components.' });
  }

  try {
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) throw new Error('Razorpay secret configuration error.');

    const text = `${razorpay_order_id}|${razorpay_payment_id}`;
    const generated = crypto.createHmac('sha256', keySecret).update(text).digest('hex');

    if (!signaturesMatch(generated, razorpay_signature)) {
      return res.status(400).json({ error: 'signature_mismatch', message: 'Payment verification failed.' });
    }

    const slotRef = db.collection('slots').doc(slotId);
    let bookingDetails = {};

    await db.runTransaction(async (transaction) => {
      const slotDoc = await transaction.get(slotRef);
      if (!slotDoc.exists) throw new Error('Slot not found.');
      const data = slotDoc.data();
      if (data.razorpayOrderId !== razorpay_order_id) throw new Error('Payment order mismatch.');

      bookingDetails = {
        name: data.studentName,
        email: data.studentEmail,
        phone: data.studentPhone,
        topic: data.topic,
        price: data.price
      };

      transaction.update(slotRef, {
        status: 'booked',
        bookedBy: req.user.uid,
        bookedAt: admin.firestore.FieldValue.serverTimestamp(),
        razorpayPaymentId: razorpay_payment_id
      });
    });

    // Send emails asynchronously
    sendConfirmationEmails(
      slotId,
      bookingDetails.name,
      bookingDetails.email,
      bookingDetails.phone,
      bookingDetails.topic,
      `₹${bookingDetails.price}`,
      razorpay_payment_id
    ).catch(console.error);

    res.json({ ok: true, message: 'Booking confirmed successfully.' });
  } catch (e) {
    res.status(500).json({ error: 'payment_verification_failed', message: e.message });
  }
});

// Helper to send emails
async function sendConfirmationEmails(slotId, name, email, phone, topic, priceText, paymentId) {
  const [datePart, timePart] = slotId.split('_');

  const studentHtml = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eeeeee; border-radius: 8px;">
      <h2 style="color: #C94E1F; margin-top: 0;">Counseling Slot Booked! 🎯</h2>
      <p>Hello ${name},</p>
      <p>Your payment of <strong>${priceText}</strong> has been verified. Your 1-on-1 counseling slot is confirmed!</p>
      
      <div style="background: #F8FAFC; border: 1px solid #E2E8F0; padding: 16px; border-radius: 8px; margin: 20px 0;">
        <h4 style="margin: 0 0 8px 0; color: #1E293B;">Booking Details:</h4>
        <ul style="margin: 0; padding-left: 20px; color: #475569;">
          <li><strong>Topic:</strong> ${topic}</li>
          <li><strong>Date:</strong> ${datePart}</li>
          <li><strong>Time:</strong> ${timePart}</li>
          <li><strong>WhatsApp Mobile:</strong> ${phone}</li>
          <li><strong>Payment ID:</strong> ${paymentId}</li>
        </ul>
      </div>

      <h4 style="color: #EF4444; margin-top: 20px;">⚠️ Critical Session Guidelines:</h4>
      <ol style="color: #475569; padding-left: 20px; line-height: 1.8;">
        <li>Your Google Meet session link will be sent directly to your WhatsApp number (<strong>${phone}</strong>) right before the meeting.</li>
        <li><strong>Please join on time.</strong> If you join late, your session time will not be extended.</li>
        <li>The meeting will close strictly at the scheduled time limit.</li>
        <li>Do not share the meeting link with anyone else.</li>
        <li>The booking amount is strictly non-refundable.</li>
      </ol>

      <hr style="border: 0; border-top: 1px solid #eeeeee; margin: 25px 0;">
      <p style="font-size: 12px; color: #777777; margin-bottom: 0;">Good luck with your counseling plans,<br><strong>Sankalp Team</strong></p>
    </div>
  `;

  await sendEmail({
    to: email,
    subject: `1-on-1 Counseling Booking Confirmed - ${topic}`,
    html: studentHtml
  }).catch(console.error);

  let adminEmail = 'rohitgupta6294@gmail.com';
  try {
    const automationsDoc = await db.collection('settings').doc('email_automations').get();
    if (automationsDoc.exists && automationsDoc.data().adminEmail) {
      adminEmail = automationsDoc.data().adminEmail;
    }
  } catch (err) {
    console.error('Failed to load admin email config:', err);
  }

  const adminHtml = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eeeeee; border-radius: 8px;">
      <h2 style="color: #4F46E5; margin-top: 0;">New 1-on-1 Session Booked 👨‍🏫</h2>
      <p>Hello Admin,</p>
      <p>A student has successfully booked and paid for a counseling slot.</p>
      
      <div style="background: #F8FAFC; border: 1px solid #E2E8F0; padding: 16px; border-radius: 8px; margin: 20px 0;">
        <h4 style="margin: 0 0 8px 0; color: #1E293B;">Student Details:</h4>
        <ul style="margin: 0; padding-left: 20px; color: #475569;">
          <li><strong>Name:</strong> ${name}</li>
          <li><strong>Email:</strong> ${email}</li>
          <li><strong>WhatsApp Mobile:</strong> ${phone}</li>
        </ul>
      </div>

      <div style="background: #F8FAFC; border: 1px solid #E2E8F0; padding: 16px; border-radius: 8px; margin: 20px 0;">
        <h4 style="margin: 0 0 8px 0; color: #1E293B;">Appointment Details:</h4>
        <ul style="margin: 0; padding-left: 20px; color: #475569;">
          <li><strong>Topic:</strong> ${topic}</li>
          <li><strong>Date:</strong> ${datePart}</li>
          <li><strong>Time Slot:</strong> ${timePart}</li>
          <li><strong>Amount Paid:</strong> ${priceText}</li>
          <li><strong>Payment ID:</strong> ${paymentId}</li>
        </ul>
      </div>

      <p>Please open the Admin Dashboard, configure the Google Meet Link, and click "Share on WhatsApp" to notify the student.</p>
    </div>
  `;

  await sendEmail({
    to: adminEmail,
    subject: `New Counseling Booking - ${name} (${timePart})`,
    html: adminHtml
  }).catch(console.error);
}

// ── ADMIN ENDPOINTS ──

// Save default settings
router.post('/settings', verifyToken, requireAdmin, async (req, res) => {
  const { price, slotDuration, breakDuration } = req.body || {};
  if (price === undefined || slotDuration === undefined || breakDuration === undefined) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  try {
    await db.collection('settings').doc('booking_settings').set({
      price: Number(price),
      slotDuration: Number(slotDuration),
      breakDuration: Number(breakDuration),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_save_settings', message: e.message });
  }
});

// Load default settings
router.get('/settings', verifyToken, requireAdmin, async (req, res) => {
  try {
    const doc = await db.collection('settings').doc('booking_settings').get();
    const settings = doc.exists ? doc.data() : { price: 299, slotDuration: 15, breakDuration: 10 };
    res.json({ ok: true, settings });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_load_settings', message: e.message });
  }
});

// Set slot availability
router.post('/set-availability', verifyToken, requireAdmin, async (req, res) => {
  const { date, startTime, endTime, slotDuration, breakDuration, price } = req.body || {};
  if (!date || !startTime || !endTime || !slotDuration || !breakDuration || price === undefined) {
    return res.status(400).json({ error: 'missing_fields', message: 'All availability details are required.' });
  }

  try {
    const slots = generateSlotsList(date, startTime, endTime, Number(slotDuration), Number(breakDuration));
    const batch = db.batch();

    for (const slot of slots) {
      const slotId = `${date}_${slot.startTime.replace(/\s+/g, '')}`;
      const docRef = db.collection('slots').doc(slotId);
      const docSnap = await docRef.get();

      if (docSnap.exists && docSnap.data().status === 'booked') {
        continue;
      }

      batch.set(docRef, {
        date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        startRaw: slot.startRaw,
        endRaw: slot.endRaw,
        price: Number(price),
        status: docSnap.exists ? docSnap.data().status : 'available',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    await batch.commit();
    res.json({ ok: true, message: `Availability created successfully. Generated ${slots.length} slots.` });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_set_availability', message: e.message });
  }
});

// Get admin booking list
router.get('/list', verifyToken, requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('slots').get();
    const bookings = [];
    snapshot.forEach(doc => {
      bookings.push({
        id: doc.id,
        ...doc.data()
      });
    });

    bookings.sort((a, b) => {
      const dateDiff = a.date.localeCompare(b.date);
      if (dateDiff !== 0) return dateDiff;
      return a.startTime.localeCompare(b.startTime);
    });

    res.json({ ok: true, bookings });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_list_bookings', message: e.message });
  }
});

// Delete a generated slot (only if available)
router.post('/delete-slot', verifyToken, requireAdmin, async (req, res) => {
  const { slotId } = req.body || {};
  if (!slotId) return res.status(400).json({ error: 'missing_slotId' });

  try {
    const docRef = db.collection('slots').doc(slotId);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'not_found' });
    
    if (doc.data().status === 'booked' || doc.data().status === 'completed') {
      return res.status(400).json({ error: 'cannot_delete', message: 'Cannot delete a slot that is booked or completed.' });
    }

    await docRef.delete();
    res.json({ ok: true, message: 'Slot deleted successfully.' });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_delete', message: e.message });
  }
});

// Update an available slot
router.post('/update-slot', verifyToken, requireAdmin, async (req, res) => {
  const { slotId, price, startTime, endTime } = req.body || {};
  if (!slotId) return res.status(400).json({ error: 'missing_slotId' });

  try {
    const docRef = db.collection('slots').doc(slotId);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'not_found' });
    
    if (doc.data().status === 'booked' || doc.data().status === 'completed') {
      return res.status(400).json({ error: 'cannot_edit', message: 'Cannot edit a slot that is booked or completed.' });
    }

    const updates = {};
    if (price !== undefined) updates.price = Number(price);
    if (startTime) updates.startTime = startTime;
    if (endTime) updates.endTime = endTime;

    await docRef.update(updates);
    res.json({ ok: true, message: 'Slot updated successfully.' });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_update', message: e.message });
  }
});

// Save scheduled meeting link
router.post('/schedule-link', verifyToken, requireAdmin, async (req, res) => {
  const { slotId, meetingLink } = req.body || {};
  if (!slotId || !meetingLink) return res.status(400).json({ error: 'missing_fields' });

  try {
    await db.collection('slots').doc(slotId).update({
      meetingLink: String(meetingLink).trim()
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_save_link', message: e.message });
  }
});

// Confirm meeting completed
router.post('/mark-done', verifyToken, requireAdmin, async (req, res) => {
  const { slotId } = req.body || {};
  if (!slotId) return res.status(400).json({ error: 'missing_slotId' });

  try {
    await db.collection('slots').doc(slotId).update({
      status: 'completed'
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_mark_completed', message: e.message });
  }
});

// Reschedule slot (release old and set new slot time)
router.post('/reschedule', verifyToken, requireAdmin, async (req, res) => {
  const { slotId } = req.body || {};
  if (!slotId) return res.status(400).json({ error: 'missing_slotId' });

  try {
    await db.collection('slots').doc(slotId).update({
      status: 'available',
      bookedBy: null,
      bookedAt: null,
      studentName: null,
      studentEmail: null,
      studentPhone: null,
      topic: null,
      meetingLink: null,
      razorpayOrderId: null,
      razorpayPaymentId: null
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_reschedule', message: e.message });
  }
});

module.exports = router;
