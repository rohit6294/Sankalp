function predictRank(total, rankRows) {
  if (!Array.isArray(rankRows) || !rankRows.length) return null;
  const row = rankRows.find(
    (r) => total >= Number(r.marksMin) && total <= Number(r.marksMax)
  );
  return row ? { min: Number(row.rankMin), max: Number(row.rankMax) } : null;
}

module.exports = { predictRank };
