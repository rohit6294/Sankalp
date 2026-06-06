require('dotenv').config();
const { admin, db } = require('../src/firebase');

async function run() {
  const snap = await db.collection('noteCategories').get();
  console.log("--- NOTE CATEGORIES ---");
  snap.forEach(doc => {
    console.log(doc.id, "=>", doc.data());
  });
  process.exit(0);
}

run().catch(console.error);
