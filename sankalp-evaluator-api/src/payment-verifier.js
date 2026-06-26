const Razorpay = require('razorpay');
const { admin, db } = require('./firebase');

let razorpay = null;

function getRazorpayInstance() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return null;
  if (razorpay) return razorpay;
  razorpay = new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
  return razorpay;
}

/**
 * Checks for any pending ('created') payment orders in Firestore for the given user.
 * If found, queries Razorpay to see if they were paid/captured, and automatically credits the user.
 */
async function autoReconcileUserPayments(userId) {
  if (!userId) return;
  try {
    const rzp = getRazorpayInstance();
    if (!rzp) return;

    // Fetch pending orders from paymentOrders
    const paymentOrdersRef = db.collection('paymentOrders')
      .where('userId', '==', userId)
      .where('status', '==', 'created');
      
    // Fetch pending orders from predictorOrders (legacy)
    const predictorOrdersRef = db.collection('predictorOrders')
      .where('userId', '==', userId)
      .where('status', '==', 'created');

    const [paymentOrdersSnap, predictorOrdersSnap] = await Promise.all([
      paymentOrdersRef.get(),
      predictorOrdersRef.get()
    ]);

    const pendingOrders = [];
    paymentOrdersSnap.forEach(doc => pendingOrders.push({ id: doc.id, collectionName: 'paymentOrders', ...doc.data() }));
    predictorOrdersSnap.forEach(doc => pendingOrders.push({ id: doc.id, collectionName: 'predictorOrders', ...doc.data() }));

    if (pendingOrders.length === 0) return;

    console.log(`[Auto-Reconcile] Found ${pendingOrders.length} pending orders for user ${userId}. Checking status on Razorpay...`);

    // Fetch user details once if we need to credit
    let userData = null;

    for (const order of pendingOrders) {
      try {
        const paymentsResponse = await rzp.orders.fetchPayments(order.id);
        const items = paymentsResponse.items || [];
        const successfulPayment = items.find(p => p.status === 'captured' || p.status === 'authorized');

        if (successfulPayment) {
          console.log(`[Auto-Reconcile] Order ${order.id} was paid on Razorpay (Payment ID: ${successfulPayment.id}). Crediting user...`);

          if (!userData) {
            const userDoc = await db.collection('users').doc(userId).get();
            userData = userDoc.exists ? userDoc.data() : {};
          }

          const product = order.product || 'college_predictor';
          const productId = order.productId || null;
          const productKey = ['mock_test', 'mock_test_series'].includes(product) ? `${product}_${productId}` : product;
          
          const purchaseRef = db.collection('purchases').doc(`${userId}_${productKey}`);

          // 1. Create purchase record
          await purchaseRef.set({
            userId: userId,
            email: userData.email || '',
            name: userData.name || userData.displayName || 'Student',
            paymentId: successfulPayment.id,
            orderId: order.id,
            amount: order.price || (successfulPayment.amount / 100),
            purchasedAt: admin.FieldValue?.serverTimestamp ? admin.FieldValue.serverTimestamp() : admin.firestore.FieldValue.serverTimestamp(),
            product: product,
            productId: productId,
            status: 'success'
          });

          if (product === 'college_predictor') {
            await db.collection('users').doc(userId).set({
              predictorPurchased: true
            }, { merge: true });
            console.log(`[Auto-Reconcile] Marked predictorPurchased: true for user ${userId}`);
          }

          // 2. Grant subscription if mock_test_subscription
          if (product === 'mock_test_subscription') {
            const validUntil = new Date();
            validUntil.setFullYear(validUntil.getFullYear() + 1);
            await db.collection('subscriptions').doc(userId).set({
              userId: userId,
              planName: 'WBJEE Mock Test Pass',
              purchasedAt: admin.FieldValue?.serverTimestamp ? admin.FieldValue.serverTimestamp() : admin.firestore.FieldValue.serverTimestamp(),
              validUntil: validUntil
            });
            console.log(`[Auto-Reconcile] Subscription granted until ${validUntil.toISOString()}`);
          }

          // 3. Mark order as success
          await db.collection(order.collectionName).doc(order.id).set({
            status: 'success',
            paymentId: successfulPayment.id,
            verifiedAt: admin.FieldValue?.serverTimestamp ? admin.FieldValue.serverTimestamp() : admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });

          console.log(`[Auto-Reconcile] Successfully credited order ${order.id}.`);
        }
      } catch (err) {
        console.error(`[Auto-Reconcile] Error processing order ${order.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error(`[Auto-Reconcile] Error in auto-reconcile for user ${userId}:`, err);
  }
}

module.exports = { autoReconcileUserPayments };
