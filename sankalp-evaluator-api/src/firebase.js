const admin = require('firebase-admin');

if (!admin.apps.length) {
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!json) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON env var is required');
  }
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(json);
  } catch (err) {
    console.error('==================================================');
    console.error('ERROR: Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON.');
    console.error('Please verify that the environment variable is a valid JSON string.');
    console.error('Error details:', err.message);
    console.error('==================================================');
    throw err;
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id,
  });
}

const db = admin.firestore();
const auth = admin.auth();

module.exports = { admin, db, auth };
