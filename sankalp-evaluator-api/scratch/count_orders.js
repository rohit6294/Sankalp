const path = require('path');
const fs = require('fs');

const apiDir = 'C:\\Users\\rohit\\Desktop\\Sankalp Learning\\sankalp-evaluator-api';
const envPath = path.join(apiDir, '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const { db } = require(path.join(apiDir, 'src/firebase'));

async function count() {
  console.log('Querying paymentOrders...');
  const paymentOrdersSnap = await db.collection('paymentOrders').get();
  console.log('Querying predictorOrders...');
  const predictorOrdersSnap = await db.collection('predictorOrders').get();

  const summary = {};
  
  function processSnap(snap, name) {
    snap.forEach(doc => {
      const data = doc.data();
      const status = data.status || 'unknown';
      const product = data.product || 'unknown';
      const key = `${name} | ${product} | status:${status}`;
      summary[key] = (summary[key] || 0) + 1;
    });
  }

  processSnap(paymentOrdersSnap, 'paymentOrders');
  processSnap(predictorOrdersSnap, 'predictorOrders');

  console.log('\n--- ORDER SUMMARY ---');
  for (const [key, val] of Object.entries(summary)) {
    console.log(`${key}: ${val}`);
  }
  console.log('---------------------\n');
}

count().catch(console.error);
