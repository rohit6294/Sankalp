function defaultRankRows(type) {
  if (type === 'engineering') {
    return [
      { marksMin: 0, marksMax: 49, rankMin: 15000, rankMax: 50000 },
      { marksMin: 50, marksMax: 99, rankMin: 5000, rankMax: 14999 },
      { marksMin: 100, marksMax: 139, rankMin: 2000, rankMax: 4999 },
      { marksMin: 140, marksMax: 159, rankMin: 400, rankMax: 1999 },
      { marksMin: 160, marksMax: 200, rankMin: 1, rankMax: 399 },
    ];
  }
  return [
    { marksMin: 0, marksMax: 19, rankMin: 10000, rankMax: 30000 },
    { marksMin: 20, marksMax: 39, rankMin: 4000, rankMax: 9999 },
    { marksMin: 40, marksMax: 59, rankMin: 1000, rankMax: 3999 },
    { marksMin: 60, marksMax: 80, rankMin: 1, rankMax: 999 },
  ];
}

function predictRank(total, rankRows) {
  if (!Array.isArray(rankRows) || !rankRows.length) return null;
  const rows = [...rankRows].sort((a, b) => Number(a.marksMin) - Number(b.marksMin));
  const row = rows.find(
    (r) => total >= Number(r.marksMin) && total <= Number(r.marksMax)
  );
  if (!row && total < Number(rows[0].marksMin)) {
    const lowest = rows[0];
    return { min: Number(lowest.rankMin), max: Number(lowest.rankMax) };
  }
  if (!row && total > Number(rows[rows.length - 1].marksMax)) {
    const highest = rows[rows.length - 1];
    return { min: Number(highest.rankMin), max: Number(highest.rankMax) };
  }
  return row ? { min: Number(row.rankMin), max: Number(row.rankMax) } : null;
}

module.exports = { defaultRankRows, predictRank };
