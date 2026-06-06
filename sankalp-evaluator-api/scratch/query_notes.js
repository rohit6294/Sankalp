require('dotenv').config();
const { admin, db } = require('../src/firebase');

async function run() {
  const snap = await db.collection('notes').get();
  console.log("--- NOTES ---");
  snap.forEach(doc => {
    console.log(doc.id, "=>", doc.data());
  });
  process.exit(0);
}

run().catch(console.error);
