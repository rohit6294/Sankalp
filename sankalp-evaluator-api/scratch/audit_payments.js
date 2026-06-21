const path = require('path');
const fs = require('fs');

// Load environment variables from api's .env
const apiDir = 'C:\\Users\\rohit\\Desktop\\Sankalp Learning\\sankalp-evaluator-api';
const envPath = path.join(apiDir, '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
  console.log('Loaded .env from:', envPath);
} else {
  console.error('Could not find .env at:', envPath);
  process.exit(1);
}

const { admin, db } = require(path.join(apiDir, 'src/firebase'));
const Razorpay = require('razorpay');

const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;

if (!keyId || !keySecret) {
  console.error('Missing Razorpay credentials in env.');
  process.exit(1);
}

const rzp = new Razorpay({
  key_id: keyId,
  key_secret: keySecret,
});

async function audit() {
  console.log('Fetching paymentOrders...');
  const paymentOrdersSnap = await db.collection('paymentOrders').get();
  const paymentOrders = [];
  paymentOrdersSnap.forEach(doc => {
    paymentOrders.push({ id: doc.id, collectionName: 'paymentOrders', ...doc.data() });
  });

  console.log('Fetching predictorOrders...');
  const predictorOrdersSnap = await db.collection('predictorOrders').get();
  const predictorOrders = [];
  predictorOrdersSnap.forEach(doc => {
    predictorOrders.push({ id: doc.id, collectionName: 'predictorOrders', ...doc.data() });
  });

  const allOrders = [...paymentOrders, ...predictorOrders];
  console.log(`Found ${allOrders.length} total orders in Firestore.`);

  let createdCount = 0;
  let paidButNotCredited = [];

  for (const order of allOrders) {
    if (order.status === 'created') {
      createdCount++;
      try {
        const paymentsResponse = await rzp.orders.fetchPayments(order.id);
        const items = paymentsResponse.items || [];
        const successfulPayment = items.find(p => p.status === 'captured' || p.status === 'authorized');
        
        if (successfulPayment) {
          paidButNotCredited.push({
            order,
            payment: successfulPayment
          });
        }
      } catch (err) {
        if (err.statusCode !== 404) {
          console.error(`Error fetching Razorpay payments for order ${order.id}:`, err.message);
        }
      }
    }
  }

  console.log('\n--- AUDIT SUMMARY ---');
  console.log(`Total Orders: ${allOrders.length}`);
  console.log(`Created (Pending) Orders: ${createdCount}`);
  console.log(`Paid on Razorpay but pending in Firestore: ${paidButNotCredited.length}`);
  console.log('---------------------\n');

  for (const item of paidButNotCredited) {
    console.log(`Order ID: ${item.order.id} (${item.order.collectionName})`);
    console.log(`  User ID: ${item.order.userId}`);
    console.log(`  Product: ${item.order.product}`);
    console.log(`  Amount: ${item.order.amount / 100} INR`);
    console.log(`  Payment ID: ${item.payment.id} (Status: ${item.payment.status})`);
    console.log(`  Created At: ${item.order.createdAt ? (item.order.createdAt.toDate ? item.order.createdAt.toDate().toISOString() : item.order.createdAt) : 'N/A'}`);
    console.log('---');
  }
}

audit().catch(console.error);
