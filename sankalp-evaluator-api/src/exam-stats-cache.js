const { admin, db } = require('./firebase');

async function getStatsDocRef(examId) {
  return db.collection('exams').doc(examId).collection('stats').doc('scores');
}

/**
 * Retrieve scores array from the unified stats document.
 * If not present, falls back to a collection scan to build it, write it, and return.
 */
async function getExamScores(examId) {
  try {
    const statsRef = await getStatsDocRef(examId);
    const statsDoc = await statsRef.get();
    
    if (statsDoc.exists) {
      const data = statsDoc.data();
      if (Array.isArray(data.totals)) {
        return data.totals;
      }
    }

    // Fallback: build from submissions
    console.log(`[Stats-Cache] Stats cache doc not found for exam ${examId}. Building from submissions...`);
    const submissionsSnap = await db.collection('submissions').where('examId', '==', examId).get();
    const totals = [];
    submissionsSnap.forEach(doc => {
      const s = doc.data().scores || {};
      const total = s.total ?? s.engineering ?? 0;
      totals.push(total);
    });

    // Save the built totals
    await statsRef.set({
      totals,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`[Stats-Cache] Created stats cache doc for exam ${examId} with ${totals.length} scores.`);
    return totals;
  } catch (err) {
    console.error(`[Stats-Cache] Error getting scores for exam ${examId}:`, err);
    // If anything fails, return an empty array to prevent crashes
    return [];
  }
}

/**
 * Append a score to the totals array inside a transaction to prevent race conditions.
 */
async function addExamScore(examId, score) {
  try {
    const statsRef = await getStatsDocRef(examId);
    await db.runTransaction(async (transaction) => {
      const statsDoc = await transaction.get(statsRef);
      let totals = [];
      if (statsDoc.exists) {
        totals = statsDoc.data().totals || [];
      } else {
        // Fallback: build from existing submissions
        const submissionsSnap = await db.collection('submissions').where('examId', '==', examId).get();
        submissionsSnap.forEach(doc => {
          const s = doc.data().scores || {};
          const total = s.total ?? s.engineering ?? 0;
          totals.push(total);
        });
      }
      
      totals.push(score);
      
      transaction.set(statsRef, {
        totals,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });
    console.log(`[Stats-Cache] Appended score ${score} to exam ${examId}.`);
  } catch (err) {
    console.error(`[Stats-Cache] Failed to add score to exam ${examId} cache:`, err);
  }
}

/**
 * Remove a score from the totals array inside a transaction.
 * Usually called when a submission is deleted/reset.
 */
async function removeExamScore(examId, score) {
  try {
    const statsRef = await getStatsDocRef(examId);
    await db.runTransaction(async (transaction) => {
      const statsDoc = await transaction.get(statsRef);
      if (!statsDoc.exists) return;
      
      const totals = statsDoc.data().totals || [];
      const idx = totals.indexOf(score);
      if (idx !== -1) {
        totals.splice(idx, 1);
        transaction.set(statsRef, {
          totals,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log(`[Stats-Cache] Removed score ${score} from exam ${examId}.`);
      }
    });
  } catch (err) {
    console.error(`[Stats-Cache] Failed to remove score from exam ${examId} cache:`, err);
  }
}

module.exports = {
  getExamScores,
  addExamScore,
  removeExamScore
};
