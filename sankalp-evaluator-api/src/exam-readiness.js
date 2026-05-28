const { START, END } = require('./categories');

const SETS = ['A', 'B', 'C', 'D'];

function missingAnswerNumbers(subject, keyMap) {
  const missing = [];
  const start = START[subject];
  const end = END[subject];
  for (let qNo = start; qNo <= end; qNo += 1) {
    const value = keyMap ? keyMap[String(qNo)] : undefined;
    if (typeof value !== 'string' || !value.trim()) {
      missing.push(qNo);
    }
  }
  return missing;
}

async function getExamReadiness(examRef) {
  const problems = [];
  const refs = SETS.flatMap((setId) => [
    { setId, paper: 'math', ref: examRef.collection('answerKeys').doc(`math_${setId}`) },
    { setId, paper: 'physChem', ref: examRef.collection('answerKeys').doc(`physChem_${setId}`) },
  ]);

  const snapshots = await Promise.all(refs.map((item) => item.ref.get()));

  snapshots.forEach((snap, index) => {
    const item = refs[index];
    if (!snap.exists) {
      problems.push(`${item.paper} set ${item.setId} key missing`);
      return;
    }

    const data = snap.data() || {};
    if (item.paper === 'math') {
      const missing = missingAnswerNumbers('math', data.math || {});
      if (missing.length) problems.push(`math set ${item.setId} missing ${missing.length}`);
      return;
    }

    const missingPhysics = missingAnswerNumbers('physics', data.physics || {});
    const missingChemistry = missingAnswerNumbers('chemistry', data.chemistry || {});
    if (missingPhysics.length) problems.push(`physics set ${item.setId} missing ${missingPhysics.length}`);
    if (missingChemistry.length) problems.push(`chemistry set ${item.setId} missing ${missingChemistry.length}`);
  });

  return {
    ready: problems.length === 0,
    problems,
  };
}

module.exports = { SETS, getExamReadiness, missingAnswerNumbers };
