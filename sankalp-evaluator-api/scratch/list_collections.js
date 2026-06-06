require('dotenv').config();
const { admin, db } = require('../src/firebase');

async function run() {
  const collections = await db.listCollections();
  console.log("--- COLLECTIONS ---");
  for (const c of collections) {
    const snap = await c.limit(5).get();
    console.log(`Collection: ${c.id} (${snap.size} docs)`);
    snap.forEach(doc => {
      console.log("  ", doc.id, "=>", doc.data());
    });
  }
  process.exit(0);
}

run().catch(console.error);
