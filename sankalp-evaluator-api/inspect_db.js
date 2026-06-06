require('dotenv').config();
const { db } = require('./src/firebase');

async function run() {
  console.log('Fetching noteCategories...');
  const catSnap = await db.collection('noteCategories').get();
  console.log(`Found ${catSnap.size} categories:`);
  catSnap.forEach(doc => {
    console.log(`- ID: ${doc.id}, Type: ${doc.data().type}, Name: ${doc.data().name}, ParentId: ${doc.data().parentId}, Order: ${doc.data().order}`);
  });

  console.log('\nFetching notes...');
  const notesSnap = await db.collection('notes').get();
  console.log(`Found ${notesSnap.size} notes:`);
  notesSnap.forEach(doc => {
    const d = doc.data();
    console.log(`- ID: ${doc.id}, Title: ${d.title}, Subject: ${d.subject}, Section: ${d.sectionName || d.sectionId}, Subsection: ${d.subsectionName || d.subsectionId}, Access: ${d.access}, Price: ${d.price}`);
  });

  process.exit(0);
}

run().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
