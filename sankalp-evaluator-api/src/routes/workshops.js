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

// Helper to calculate capacity and seat stats for a workshop
async function computeWorkshopSeatStats(workshopDocData, workshopId) {
  const totalSeats = Number(workshopDocData.totalSeats || workshopDocData.maxSeats || 25);
  const nowMs = Date.now();

  const regsSnap = await db.collection('workshopRegistrations')
    .where('workshopId', '==', workshopId)
    .get();

  let confirmedCount = 0;
  let activeReservedCount = 0;

  regsSnap.forEach(doc => {
    const data = doc.data();
    if (data.status === 'CONFIRMED') {
      confirmedCount++;
    } else if (data.status === 'RESERVED') {
      let expiryTime = 0;
      if (data.expiresAt) {
        expiryTime = data.expiresAt.toDate ? data.expiresAt.toDate().getTime() : new Date(data.expiresAt).getTime();
      }
      if (expiryTime > nowMs) {
        activeReservedCount++;
      }
    }
  });

  const occupiedSeats = confirmedCount + activeReservedCount;
  const availableSeats = Math.max(0, totalSeats - occupiedSeats);

  let seatStatus = 'OPEN';
  if (availableSeats <= 0) {
    seatStatus = 'FULL';
  } else if (occupiedSeats / totalSeats >= 0.5) {
    seatStatus = 'FILLING_FAST';
  }

  return {
    totalSeats,
    confirmedSeats: confirmedCount,
    reservedSeats: activeReservedCount,
    occupiedSeats,
    availableSeats,
    seatStatus
  };
}

// Helper to fetch private meet URL (Admin SDK only)
async function getPrivateMeetUrl(workshopId) {
  try {
    const privDoc = await db.collection('workshops').doc(workshopId).collection('private').doc('details').get();
    if (privDoc.exists && privDoc.data().googleMeetUrl) {
      return privDoc.data().googleMeetUrl;
    }
    const wDoc = await db.collection('workshops').doc(workshopId).get();
    if (wDoc.exists && wDoc.data().googleMeetUrl) {
      return wDoc.data().googleMeetUrl;
    }
  } catch (e) {
    console.error('Failed to get private meet URL:', e);
  }
  return '';
}

// ── STUDENT & PUBLIC ENDPOINTS ──

// 1. List workshops (Public/Student)
router.get('/list', async (req, res) => {
  try {
    const snapshot = await db.collection('workshops').get();
    const workshops = [];

    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (data.status === 'DRAFT') continue;

      const stats = await computeWorkshopSeatStats(data, doc.id);

      workshops.push({
        id: doc.id,
        name: data.name || 'Workshop',
        description: data.description || '',
        date: data.date || '',
        startTime: data.startTime || '',
        endTime: data.endTime || '',
        price: Number(data.price || 0),
        totalSeats: stats.totalSeats,
        confirmedSeats: stats.confirmedSeats,
        reservedSeats: stats.reservedSeats,
        availableSeats: stats.availableSeats,
        seatStatus: stats.seatStatus,
        rules: data.rules || '',
        bannerUrl: data.bannerUrl || '',
        status: data.status || 'PUBLISHED',
        createdAt: data.createdAt ? (data.createdAt.toDate ? data.createdAt.toDate().toISOString() : data.createdAt) : null
      });
    }

    workshops.sort((a, b) => new Date(a.date) - new Date(b.date));

    res.json({ ok: true, workshops });
  } catch (e) {
    console.error('Error fetching workshops:', e);
    res.status(500).json({ error: 'failed_to_fetch_workshops', message: e.message });
  }
});

// 2. Fetch student's confirmed workshops (with unlocked Google Meet URLs)
router.get('/my-workshops', verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection('workshopRegistrations')
      .where('userId', '==', req.user.uid)
      .where('status', '==', 'CONFIRMED')
      .get();

    const myWorkshops = [];

    for (const doc of snapshot.docs) {
      const regData = doc.data();
      const wDoc = await db.collection('workshops').doc(regData.workshopId).get();

      if (wDoc.exists) {
        const wData = wDoc.data();
        const meetUrl = await getPrivateMeetUrl(regData.workshopId);

        myWorkshops.push({
          registrationId: doc.id,
          workshopId: regData.workshopId,
          name: wData.name || 'Workshop',
          description: wData.description || '',
          date: wData.date || '',
          startTime: wData.startTime || '',
          endTime: wData.endTime || '',
          price: Number(wData.price || 0),
          rules: wData.rules || '',
          bannerUrl: wData.bannerUrl || '',
          googleMeetUrl: meetUrl,
          registrationStatus: regData.status,
          paymentStatus: regData.paymentStatus,
          paymentId: regData.paymentId || '',
          confirmedAt: regData.confirmedAt ? (regData.confirmedAt.toDate ? regData.confirmedAt.toDate().toISOString() : regData.confirmedAt) : null
        });
      }
    }

    myWorkshops.sort((a, b) => new Date(b.confirmedAt || 0) - new Date(a.confirmedAt || 0));

    res.json({ ok: true, workshops: myWorkshops });
  } catch (e) {
    console.error('Error fetching student workshops:', e);
    res.status(500).json({ error: 'failed_to_fetch_my_workshops', message: e.message });
  }
});

// 3. Get single workshop details
router.get('/:id', async (req, res) => {
  try {
    const doc = await db.collection('workshops').doc(req.params.id).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'not_found', message: 'Workshop not found.' });
    }

    const data = doc.data();
    const stats = await computeWorkshopSeatStats(data, doc.id);

    res.json({
      ok: true,
      workshop: {
        id: doc.id,
        name: data.name,
        description: data.description,
        date: data.date,
        startTime: data.startTime,
        endTime: data.endTime,
        price: Number(data.price || 0),
        totalSeats: stats.totalSeats,
        confirmedSeats: stats.confirmedSeats,
        reservedSeats: stats.reservedSeats,
        availableSeats: stats.availableSeats,
        seatStatus: stats.seatStatus,
        rules: data.rules,
        bannerUrl: data.bannerUrl,
        status: data.status
      }
    });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_fetch_workshop', message: e.message });
  }
});

// 4. Lock seat (5-minute atomic reservation with transactional locking)
router.post('/lock-seat', verifyToken, async (req, res) => {
  const { workshopId, studentName, studentEmail, studentPhone } = req.body || {};

  if (!workshopId || !studentName || !studentEmail || !studentPhone) {
    return res.status(400).json({ error: 'missing_fields', message: 'Name, email, phone, and workshop ID are required.' });
  }

  const regId = `reg_${workshopId}_${req.user.uid}`;
  const regRef = db.collection('workshopRegistrations').doc(regId);
  const wRef = db.collection('workshops').doc(workshopId);

  try {
    let finalPrice = 0;
    const nowMs = Date.now();
    const expiresAtMs = nowMs + 5 * 60 * 1000;
    const expiresAtDate = new Date(expiresAtMs);

    await db.runTransaction(async (transaction) => {
      // 1. Transaction read on wRef locks the workshop document across concurrent requests
      const wDoc = await transaction.get(wRef);
      if (!wDoc.exists) {
        throw new Error('Workshop does not exist.');
      }

      const wData = wDoc.data();
      if (wData.status !== 'PUBLISHED') {
        throw new Error('This workshop is currently not open for registration.');
      }

      finalPrice = Number(wData.price || 0);
      const totalSeats = Number(wData.totalSeats || wData.maxSeats || 25);

      // Check existing registration for this student
      const regDoc = await transaction.get(regRef);
      if (regDoc.exists) {
        const regData = regDoc.data();
        if (regData.status === 'CONFIRMED') {
          throw new Error('ALREADY_REGISTERED: You are already registered for this workshop.');
        }
      }

      // Query all registrations for this workshop inside the transaction (locks matched query range)
      const regsSnap = await transaction.get(
        db.collection('workshopRegistrations').where('workshopId', '==', workshopId)
      );

      let confirmedCount = 0;
      let activeReservedCount = 0;

      regsSnap.forEach(d => {
        const rd = d.data();
        if (rd.status === 'CONFIRMED') {
          confirmedCount++;
        } else if (rd.status === 'RESERVED') {
          let exp = 0;
          if (rd.expiresAt) {
            exp = rd.expiresAt.toDate ? rd.expiresAt.toDate().getTime() : new Date(rd.expiresAt).getTime();
          }
          if (exp > nowMs && rd.userId !== req.user.uid) {
            activeReservedCount++;
          }
        }
      });

      const totalOccupied = confirmedCount + activeReservedCount;
      if (totalOccupied >= totalSeats) {
        throw new Error('FULL: This workshop is currently full.');
      }

      // Record current user reservation expiry timestamp on wData
      const activeReservations = wData.activeReservations || {};
      activeReservations[req.user.uid] = expiresAtMs;

      transaction.update(wRef, {
        confirmedSeats: confirmedCount,
        activeReservations,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Create/update student registration document
      transaction.set(regRef, {
        registrationId: regId,
        workshopId,
        userId: req.user.uid,
        studentName: String(studentName).trim(),
        studentEmail: String(studentEmail).trim(),
        studentPhone: String(studentPhone).trim(),
        status: 'RESERVED',
        paymentStatus: 'PENDING',
        reservedAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromDate(expiresAtDate),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: regDoc.exists && regDoc.data().createdAt ? regDoc.data().createdAt : admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });

    // If free workshop (price == 0), confirm immediately
    if (finalPrice === 0) {
      await db.runTransaction(async (transaction) => {
        const wDoc = await transaction.get(wRef);
        if (wDoc.exists) {
          const wData = wDoc.data();
          const activeReservations = wData.activeReservations || {};
          delete activeReservations[req.user.uid];

          transaction.update(wRef, {
            confirmedSeats: admin.firestore.FieldValue.increment(1),
            activeReservations,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }

        transaction.update(regRef, {
          status: 'CONFIRMED',
          paymentStatus: 'SUCCESS',
          confirmedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });

      const meetUrl = await getPrivateMeetUrl(workshopId);

      return res.json({
        ok: true,
        free: true,
        message: 'Registration confirmed successfully!',
        googleMeetUrl: meetUrl
      });
    }

    // Create Razorpay Order for paid workshop
    const rzp = getRazorpayInstance();
    const amountPaise = Math.round(finalPrice * 100);
    const receiptId = `ws_${workshopId.substring(0, 8)}_${req.user.uid.substring(0, 6)}_${Date.now()}`;

    const razorpayOrder = await rzp.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: receiptId
    });

    await regRef.update({
      orderId: razorpayOrder.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      ok: true,
      free: false,
      registrationId: regId,
      order_id: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      key_id: (process.env.RAZORPAY_KEY_ID || '').trim(),
      expiresAt: expiresAtMs
    });

  } catch (e) {
    const errorMsg = (e.error && e.error.description) ? e.error.description : e.message;
    console.error('Lock seat error:', e);
    const isFull = errorMsg.includes('FULL');
    const isAlready = errorMsg.includes('ALREADY_REGISTERED');
    const status = isFull ? 409 : (isAlready ? 400 : 500);
    res.status(status).json({ error: isFull ? 'FULL' : 'lock_failed', message: errorMsg.replace(/^(FULL:|ALREADY_REGISTERED:)\s*/, '') });
  }
});

// 5. Verify Razorpay Payment Signature & Confirm Registration
router.post('/verify-payment', verifyToken, async (req, res) => {
  const { workshopId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};

  if (!workshopId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'missing_fields', message: 'Missing required Razorpay verification payload.' });
  }

  try {
    const keySecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
    if (!keySecret) throw new Error('Razorpay secret configuration error.');

    const text = `${razorpay_order_id}|${razorpay_payment_id}`;
    const generated = crypto.createHmac('sha256', keySecret).update(text).digest('hex');

    if (!signaturesMatch(generated, razorpay_signature)) {
      return res.status(400).json({ error: 'signature_mismatch', message: 'Payment verification failed. Signature mismatch.' });
    }

    const regId = `reg_${workshopId}_${req.user.uid}`;
    const regRef = db.collection('workshopRegistrations').doc(regId);
    const wRef = db.collection('workshops').doc(workshopId);

    let studentDetails = {};

    await db.runTransaction(async (transaction) => {
      const regDoc = await transaction.get(regRef);
      if (!regDoc.exists) {
        throw new Error('Registration record not found.');
      }

      const regData = regDoc.data();

      if (regData.status === 'CONFIRMED') {
        studentDetails = regData;
        return;
      }

      if (regData.orderId !== razorpay_order_id) {
        throw new Error('Order ID mismatch for this registration.');
      }

      studentDetails = {
        name: regData.studentName,
        email: regData.studentEmail,
        phone: regData.studentPhone
      };

      const wDoc = await transaction.get(wRef);
      if (wDoc.exists) {
        const wData = wDoc.data();
        const activeReservations = wData.activeReservations || {};
        delete activeReservations[req.user.uid];

        transaction.update(wRef, {
          confirmedSeats: admin.firestore.FieldValue.increment(1),
          activeReservations,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      transaction.update(regRef, {
        status: 'CONFIRMED',
        paymentStatus: 'SUCCESS',
        paymentId: razorpay_payment_id,
        confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    const meetUrl = await getPrivateMeetUrl(workshopId);

    sendWorkshopConfirmationEmail(workshopId, studentDetails.name, studentDetails.email, studentDetails.phone, razorpay_payment_id, meetUrl).catch(console.error);

    res.json({
      ok: true,
      message: 'Payment verified and workshop registration confirmed!',
      googleMeetUrl: meetUrl
    });

  } catch (e) {
    console.error('Workshop verify payment error:', e);
    res.status(500).json({ error: 'verification_failed', message: e.message });
  }
});

// Email confirmation helper
async function sendWorkshopConfirmationEmail(workshopId, name, email, phone, paymentId, meetUrl) {
  try {
    const wDoc = await db.collection('workshops').doc(workshopId).get();
    if (!wDoc.exists) return;
    const wData = wDoc.data();

    const studentHtml = `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eeeeee; border-radius: 8px;">
        <h2 style="color: #4F46E5; margin-top: 0;">Workshop Registration Confirmed! 🚀</h2>
        <p>Hello ${name},</p>
        <p>Your seat for <strong>${wData.name}</strong> is confirmed!</p>
        
        <div style="background: #F8FAFC; border: 1px solid #E2E8F0; padding: 16px; border-radius: 8px; margin: 20px 0;">
          <h4 style="margin: 0 0 8px 0; color: #1E293B;">Workshop Details:</h4>
          <ul style="margin: 0; padding-left: 20px; color: #475569;">
            <li><strong>Workshop:</strong> ${wData.name}</li>
            <li><strong>Date:</strong> ${wData.date}</li>
            <li><strong>Time:</strong> ${wData.startTime} ${wData.endTime ? '– ' + wData.endTime : ''}</li>
            <li><strong>Payment ID:</strong> ${paymentId}</li>
          </ul>
        </div>

        <div style="background: #EEF2FF; border: 1px solid #C7D2FE; padding: 16px; border-radius: 8px; margin: 20px 0;">
          <h4 style="margin: 0 0 8px 0; color: #3730A3;">📹 Google Meet Link:</h4>
          <p style="margin: 0; font-size: 15px;"><a href="${meetUrl}" target="_blank" style="color: #4F46E5; font-weight: bold;">Click Here to Join Workshop</a></p>
          <p style="margin: 6px 0 0 0; font-size: 12px; color: #6B7280;">(Please join with name <strong>${name}</strong> so the host can admit you)</p>
        </div>

        <h4 style="color: #EF4444; margin-top: 20px;">📌 Workshop Guidelines:</h4>
        <div style="color: #475569; font-size: 13px;">${(wData.rules || '').replace(/\n/g, '<br>')}</div>

        <hr style="border: 0; border-top: 1px solid #eeeeee; margin: 25px 0;">
        <p style="font-size: 12px; color: #777777; margin-bottom: 0;">See you in the workshop,<br><strong>Sankalp Team</strong></p>
      </div>
    `;

    await sendEmail({
      to: email,
      subject: `Registration Confirmed — ${wData.name}`,
      html: studentHtml
    });
  } catch (err) {
    console.error('Failed to send workshop confirmation email:', err);
  }
}

// ── ADMIN ENDPOINTS ──

// Create workshop (Admin)
router.post('/admin/create', verifyToken, requireAdmin, async (req, res) => {
  const { name, description, date, startTime, endTime, price, totalSeats, rules, googleMeetUrl, bannerUrl, status } = req.body || {};

  if (!name || !date || !startTime || totalSeats === undefined) {
    return res.status(400).json({ error: 'missing_fields', message: 'Name, date, start time, and total seats are required.' });
  }

  try {
    const wRef = db.collection('workshops').doc();
    const workshopId = wRef.id;

    await wRef.set({
      name: String(name).trim(),
      description: String(description || '').trim(),
      date: String(date).trim(),
      startTime: String(startTime).trim(),
      endTime: String(endTime || '').trim(),
      price: Number(price || 0),
      totalSeats: Number(totalSeats || 25),
      confirmedSeats: 0,
      activeReservations: {},
      rules: String(rules || '').trim(),
      bannerUrl: String(bannerUrl || '').trim(),
      status: status || 'DRAFT',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    if (googleMeetUrl) {
      await wRef.collection('private').doc('details').set({
        googleMeetUrl: String(googleMeetUrl).trim(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json({ ok: true, id: workshopId, message: 'Workshop created successfully.' });
  } catch (e) {
    console.error('Error creating workshop:', e);
    res.status(500).json({ error: 'create_failed', message: e.message });
  }
});

// Update workshop (Admin)
router.post('/admin/update', verifyToken, requireAdmin, async (req, res) => {
  const { workshopId, name, description, date, startTime, endTime, price, totalSeats, rules, googleMeetUrl, bannerUrl, status } = req.body || {};

  if (!workshopId) {
    return res.status(400).json({ error: 'missing_workshopId' });
  }

  try {
    const wRef = db.collection('workshops').doc(workshopId);
    const docSnap = await wRef.get();
    if (!docSnap.exists) {
      return res.status(404).json({ error: 'not_found', message: 'Workshop not found.' });
    }

    const updates = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (name !== undefined) updates.name = String(name).trim();
    if (description !== undefined) updates.description = String(description).trim();
    if (date !== undefined) updates.date = String(date).trim();
    if (startTime !== undefined) updates.startTime = String(startTime).trim();
    if (endTime !== undefined) updates.endTime = String(endTime).trim();
    if (price !== undefined) updates.price = Number(price);
    if (totalSeats !== undefined) updates.totalSeats = Number(totalSeats);
    if (rules !== undefined) updates.rules = String(rules).trim();
    if (bannerUrl !== undefined) updates.bannerUrl = String(bannerUrl).trim();
    if (status !== undefined) updates.status = String(status).trim();

    await wRef.update(updates);

    if (googleMeetUrl !== undefined) {
      await wRef.collection('private').doc('details').set({
        googleMeetUrl: String(googleMeetUrl).trim(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    res.json({ ok: true, message: 'Workshop updated successfully.' });
  } catch (e) {
    console.error('Error updating workshop:', e);
    res.status(500).json({ error: 'update_failed', message: e.message });
  }
});

// Delete workshop (Admin)
router.post('/admin/delete', verifyToken, requireAdmin, async (req, res) => {
  const { workshopId } = req.body || {};
  if (!workshopId) return res.status(400).json({ error: 'missing_workshopId' });

  try {
    const wRef = db.collection('workshops').doc(workshopId);
    await wRef.collection('private').doc('details').delete().catch(() => {});
    await wRef.delete();
    res.json({ ok: true, message: 'Workshop deleted successfully.' });
  } catch (e) {
    res.status(500).json({ error: 'delete_failed', message: e.message });
  }
});

// Get admin registration list for a workshop
router.get('/admin/registrations/:workshopId', verifyToken, requireAdmin, async (req, res) => {
  const { workshopId } = req.params;
  try {
    const regsSnap = await db.collection('workshopRegistrations')
      .where('workshopId', '==', workshopId)
      .get();

    const registrations = [];
    const nowMs = Date.now();

    regsSnap.forEach(doc => {
      const d = doc.data();
      let isExpired = false;
      if (d.status === 'RESERVED' && d.expiresAt) {
        const expTime = d.expiresAt.toDate ? d.expiresAt.toDate().getTime() : new Date(d.expiresAt).getTime();
        if (expTime < nowMs) {
          isExpired = true;
        }
      }

      registrations.push({
        id: doc.id,
        userId: d.userId,
        studentName: d.studentName || 'Student',
        studentEmail: d.studentEmail || '',
        studentPhone: d.studentPhone || '',
        status: isExpired ? 'EXPIRED' : d.status,
        paymentStatus: d.paymentStatus || 'PENDING',
        paymentId: d.paymentId || '',
        orderId: d.orderId || '',
        reservedAt: d.reservedAt ? (d.reservedAt.toDate ? d.reservedAt.toDate().toISOString() : d.reservedAt) : null,
        expiresAt: d.expiresAt ? (d.expiresAt.toDate ? d.expiresAt.toDate().toISOString() : d.expiresAt) : null,
        confirmedAt: d.confirmedAt ? (d.confirmedAt.toDate ? d.confirmedAt.toDate().toISOString() : d.confirmedAt) : null
      });
    });

    registrations.sort((a, b) => new Date(b.reservedAt || 0) - new Date(a.reservedAt || 0));

    res.json({ ok: true, registrations });
  } catch (e) {
    res.status(500).json({ error: 'failed_to_fetch_registrations', message: e.message });
  }
});

module.exports = router;
