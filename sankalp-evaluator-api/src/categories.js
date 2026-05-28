const RANGES = {
  math:      { cat1: [1, 50],  cat2: [51, 65], cat3: [66, 75] },
  physics:   { cat1: [1, 30],  cat2: [31, 35], cat3: [36, 40] },
  chemistry: { cat1: [41, 70], cat2: [71, 75], cat3: [76, 80] },
};

const START = {
  math: 1,
  physics: 1,
  chemistry: 41,
};

const END = {
  math: 75,
  physics: 40,
  chemistry: 80,
};

function categoryFor(subject, qNo) {
  const r = RANGES[subject];
  if (!r) throw new Error(`unknown subject: ${subject}`);
  if (qNo >= r.cat1[0] && qNo <= r.cat1[1]) return 1;
  if (qNo >= r.cat2[0] && qNo <= r.cat2[1]) return 2;
  if (qNo >= r.cat3[0] && qNo <= r.cat3[1]) return 3;
  throw new Error(`question ${qNo} out of range for ${subject}`);
}

const COUNTS = {
  math: 75,
  physics: 40,
  chemistry: 40,
};

module.exports = { RANGES, COUNTS, START, END, categoryFor };
