const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { admin, db } = require('../firebase');
const { verifyToken } = require('../auth');
const { normalizePredictorSettings } = require('../predictor-settings');

const router = express.Router();

let razorpay = null;
let razorpayKeyId = null;

function getRazorpayErrorMessage(err) {
  return err?.error?.description
    || err?.description
    || err?.message
    || 'Failed to initialize payment order.';
}

function getRazorpayInstance() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error('Razorpay credentials (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET) are not set in environment.');
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

// ── 1. Create Razorpay Order ──────────────────────────────────────────────────
async function createOrder(req, res) {
  try {
    const rzp = getRazorpayInstance();

    // Fetch dynamic pricing settings from Firestore
    const settingsDoc = await db.collection('settings').doc('college_predictor').get();
    const settings = normalizePredictorSettings(settingsDoc.exists ? settingsDoc.data() : {});
    if (!settings.enabled) {
      return res.status(403).json({
        error: 'feature_disabled',
        message: 'College Predictor is currently disabled.',
      });
    }
    if (!settings.requiresPayment) {
      return res.status(409).json({
        error: 'paywall_disabled',
        message: 'College Predictor is currently available without payment.',
      });
    }

    const price = settings.price;
    const amountPaise = Math.round(price * 100);
    const requestedAmount = req.body?.amount !== undefined ? Number(req.body.amount) : amountPaise;
    const requestedCurrency = typeof req.body?.currency === 'string'
      ? req.body.currency.trim().toUpperCase()
      : 'INR';

    if (isNaN(amountPaise) || amountPaise < 100) {
      return res.status(400).json({
        error: 'invalid_amount',
        message: 'Amount must be at least 100 paise (₹1).'
      });
    }
    if (!Number.isFinite(requestedAmount) || requestedAmount < 100) {
      return res.status(400).json({
        error: 'invalid_amount',
        message: 'Requested amount must be at least 100 paise (INR 1).'
      });
    }
    if (requestedAmount !== amountPaise) {
      return res.status(400).json({
        error: 'amount_mismatch',
        message: 'Requested amount does not match the configured predictor price.'
      });
    }
    if (requestedCurrency !== 'INR') {
      return res.status(400).json({
        error: 'invalid_currency',
        message: 'College Predictor payments must use INR.'
      });
    }

    const requestedReceipt = typeof req.body?.receipt === 'string'
      ? req.body.receipt.trim().slice(0, 40)
      : '';
    const receiptId = requestedReceipt || `receipt_pred_${req.user.uid.substring(0, 8)}_${Date.now()}`;

    const options = {
      amount: amountPaise,
      currency: requestedCurrency,
      receipt: receiptId,
    };

    const order = await rzp.orders.create(options);
    await db.collection('predictorOrders').doc(order.id).set({
      userId: req.user.uid,
      product: 'college_predictor',
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
      key_id: process.env.RAZORPAY_KEY_ID
    });
  } catch (err) {
    console.error('Failed to create Razorpay order:', err);
    res.status(err?.statusCode === 401 ? 401 : 500).json({
      error: 'order_creation_failed',
      message: getRazorpayErrorMessage(err)
    });
  }
}

router.post('/create-order', verifyToken, createOrder);

// ── 2. Verify Razorpay Payment Signature ──────────────────────────────────────
async function verifyPayment(req, res) {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body || {};

  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
    return res.status(400).json({
      error: 'missing_fields',
      message: 'Missing required Razorpay payment information.'
    });
  }

  try {
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return res.status(500).json({
        error: 'missing_credentials',
        message: 'Razorpay configuration error.'
      });
    }

    // Cryptographically compute HMAC-SHA256 signature
    const text = `${razorpay_order_id}|${razorpay_payment_id}`;
    const generated_signature = crypto
      .createHmac('sha256', keySecret)
      .update(text)
      .digest('hex');

    if (!signaturesMatch(generated_signature, razorpay_signature)) {
      return res.status(400).json({
        error: 'signature_mismatch',
        message: 'Payment verification failed. Signature mismatch.'
      });
    }

    const orderRef = db.collection('predictorOrders').doc(razorpay_order_id);
    const orderDoc = await orderRef.get();
    if (!orderDoc.exists || orderDoc.data().userId !== req.user.uid) {
      return res.status(400).json({
        error: 'order_mismatch',
        message: 'Payment order does not belong to the signed-in student.',
      });
    }

    const pendingOrder = orderDoc.data();
    const payment = await getRazorpayInstance().payments.fetch(razorpay_payment_id);
    if (
      payment.order_id !== razorpay_order_id
      || Number(payment.amount) !== Number(pendingOrder.amount)
      || payment.currency !== pendingOrder.currency
      || payment.status !== 'captured'
    ) {
      return res.status(400).json({
        error: 'payment_not_captured',
        message: 'Payment has not been captured for the expected order amount.',
      });
    }

    // Retrieve user details from firestore to make recent transactions extra informative
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const name = userData.name || userData.displayName || 'Unknown Student';
    const email = userData.email || req.user.email || 'no-email@sankalp.in';

    // Log successful transaction in Firestore
    const purchaseRef = db.collection('purchases').doc(`${req.user.uid}_college_predictor`);
    await purchaseRef.set({
      userId: req.user.uid,
      email,
      name,
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      amount: pendingOrder.price,
      purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
      product: 'college_predictor',
      status: 'success'
    });
    await orderRef.set({
      status: 'success',
      paymentId: razorpay_payment_id,
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    res.json({ success: true, message: 'Payment verified successfully.' });
  } catch (err) {
    console.error('Failed to verify payment signature:', err);
    res.status(500).json({
      error: 'verification_failed',
      message: err.message || 'Payment signature verification failed.'
    });
  }
}

router.post('/verify', verifyToken, verifyPayment);
router.post('/verify-payment', verifyToken, verifyPayment);

module.exports = router;
