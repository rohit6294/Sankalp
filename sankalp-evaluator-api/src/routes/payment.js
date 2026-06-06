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
    const product = req.body?.product || 'college_predictor';
    const productId = req.body?.productId || null; // for individual mock tests
    let price = 0;

    if (product === 'college_predictor') {
      const settingsDoc = await db.collection('settings').doc('college_predictor').get();
      const settings = normalizePredictorSettings(settingsDoc.exists ? settingsDoc.data() : {});
      if (!settings.enabled) return res.status(403).json({ error: 'feature_disabled', message: 'College Predictor is disabled.' });
      if (!settings.requiresPayment) return res.status(409).json({ error: 'paywall_disabled', message: 'Currently available without payment.' });
      price = settings.price;
    } else if (product === 'mock_test_subscription') {
      const settingsDoc = await db.collection('settings').doc('mock_test_subscription').get();
      const settings = settingsDoc.exists ? settingsDoc.data() : { price: 999 };
      price = settings.price || 999;
    } else if (product === 'mock_test_series') {
      if (!productId) return res.status(400).json({ error: 'missing_product_id', message: 'Series ID is required.' });
      const seriesDoc = await db.collection('mockTestSeries').doc(productId).get();
      if (!seriesDoc.exists) return res.status(404).json({ error: 'not_found', message: 'Test Series not found.' });
      const seriesData = seriesDoc.data();
      price = seriesData.price || 0;
    } else if (product === 'mock_test') {
      if (!productId) return res.status(400).json({ error: 'missing_product_id', message: 'Test ID is required.' });
      const testDoc = await db.collection('mockTests').doc(productId).get();
      if (!testDoc.exists) return res.status(404).json({ error: 'not_found', message: 'Mock test not found.' });
      const testData = testDoc.data();
      if (testData.accessType !== 'paid') return res.status(400).json({ error: 'invalid_product', message: 'This test is not paid.' });
      price = testData.price;
    } else {
      return res.status(400).json({ error: 'invalid_product', message: 'Unknown product type.' });
    }

    const amountPaise = Math.round(price * 100);
    const requestedAmount = req.body?.amount !== undefined ? Number(req.body.amount) : amountPaise;
    const requestedCurrency = typeof req.body?.currency === 'string' ? req.body.currency.trim().toUpperCase() : 'INR';

    if (isNaN(amountPaise) || amountPaise < 100) return res.status(400).json({ error: 'invalid_amount', message: 'Amount must be at least ₹1.' });
    if (requestedAmount !== amountPaise) return res.status(400).json({ error: 'amount_mismatch', message: 'Requested amount does not match price.' });
    if (requestedCurrency !== 'INR') return res.status(400).json({ error: 'invalid_currency', message: 'Must use INR.' });

    const receiptId = `receipt_${product.substring(0,4)}_${req.user.uid.substring(0, 8)}_${Date.now()}`;
    const options = { amount: amountPaise, currency: requestedCurrency, receipt: receiptId };
    
    const order = await rzp.orders.create(options);
    await db.collection('paymentOrders').doc(order.id).set({
      userId: req.user.uid,
      product,
      productId,
      amount: order.amount,
      price,
      currency: order.currency,
      status: 'created',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ order_id: order.id, amount: order.amount, currency: order.currency, key_id: process.env.RAZORPAY_KEY_ID });
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

    const orderRef = db.collection('paymentOrders').doc(razorpay_order_id);
    const orderDoc = await orderRef.get();
    
    // Fallback for older predictor orders which used predictorOrders collection
    let isLegacy = false;
    let pendingOrder;
    if (!orderDoc.exists) {
      const legacyRef = db.collection('predictorOrders').doc(razorpay_order_id);
      const legacyDoc = await legacyRef.get();
      if (!legacyDoc.exists || legacyDoc.data().userId !== req.user.uid) {
        return res.status(400).json({ error: 'order_mismatch', message: 'Payment order not found.' });
      }
      pendingOrder = legacyDoc.data();
      isLegacy = true;
    } else {
      if (orderDoc.data().userId !== req.user.uid) {
        return res.status(400).json({ error: 'order_mismatch', message: 'Order mismatch.' });
      }
      pendingOrder = orderDoc.data();
    }

    const payment = await getRazorpayInstance().payments.fetch(razorpay_payment_id);
    if (
      payment.order_id !== razorpay_order_id
      || Number(payment.amount) !== Number(pendingOrder.amount)
      || payment.currency !== pendingOrder.currency
      || payment.status !== 'captured'
    ) {
      return res.status(400).json({ error: 'payment_not_captured', message: 'Payment not captured.' });
    }

    const userDoc = await db.collection('users').doc(req.user.uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    
    // Log successful transaction
    const productKey = ['mock_test', 'mock_test_series'].includes(pendingOrder.product) ? `${pendingOrder.product}_${pendingOrder.productId}` : pendingOrder.product;
    const purchaseRef = db.collection('purchases').doc(`${req.user.uid}_${productKey}`);
    
    await purchaseRef.set({
      userId: req.user.uid,
      email: userData.email || req.user.email || '',
      name: userData.name || userData.displayName || 'Student',
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      amount: pendingOrder.price,
      purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
      product: pendingOrder.product,
      productId: pendingOrder.productId || null,
      status: 'success'
    });

    if (pendingOrder.product === 'mock_test_subscription') {
      const validUntil = new Date();
      validUntil.setFullYear(validUntil.getFullYear() + 1); // 1 year subscription by default
      await db.collection('subscriptions').doc(req.user.uid).set({
        userId: req.user.uid,
        planName: 'WBJEE Mock Test Pass',
        purchasedAt: admin.firestore.FieldValue.serverTimestamp(),
        validUntil: validUntil
      });
    }

    const updateRef = isLegacy ? db.collection('predictorOrders').doc(razorpay_order_id) : orderRef;
    await updateRef.set({
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
