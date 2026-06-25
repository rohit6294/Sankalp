const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getCollegeMetadata } = require('../src/college-metadata');

test('getCollegeMetadata: retrieves correct data for Jadavpur University B.Tech', () => {
  // General (non-TFW) CSE seat
  const cseMeta = getCollegeMetadata('JADAVPUR UNIVERSITY', 'COMPUTER SCIENCE', 'OPEN');
  assert.equal(cseMeta.tuitionFee, 5210);
  assert.equal(cseMeta.averagePackage, 20.5);
  assert.equal(cseMeta.isTfw, false);

  // General (non-TFW) IT seat (which has a higher fee of ~30k)
  const itMeta = getCollegeMetadata('JADAVPUR UNIVERSITY', 'INFORMATION TECHNOLOGY', 'OPEN');
  assert.equal(itMeta.tuitionFee, 30000);
  assert.equal(itMeta.averagePackage, 18.0);
  assert.equal(itMeta.isTfw, false);

  // General (non-TFW) Chemical seat (which uses base fee and base package)
  const chemMeta = getCollegeMetadata('JADAVPUR UNIVERSITY', 'CHEMICAL ENGINEERING', 'OPEN');
  assert.equal(chemMeta.tuitionFee, 5210);
  assert.equal(chemMeta.averagePackage, 11.0);
  assert.equal(chemMeta.isTfw, false);
});

test('getCollegeMetadata: handles TFW seat waiver correctly', () => {
  // Jadavpur CSE TFW seat
  const tfwCse = getCollegeMetadata('JADAVPUR UNIVERSITY', 'COMPUTER SCIENCE', 'TFW');
  assert.equal(tfwCse.tuitionFee, 0); // waived
  assert.equal(tfwCse.averagePackage, 20.5); // package remains same
  assert.equal(tfwCse.isTfw, true);

  // Heritage IT TFW seat
  const tfwHeritage = getCollegeMetadata('HERITAGE INSTITUTE OF TECHNOLOGY, KOLKATA', 'INFORMATION TECHNOLOGY', 'TFW');
  assert.equal(tfwHeritage.tuitionFee, 0); // waived
  assert.equal(tfwHeritage.averagePackage, 6.0);
  assert.equal(tfwHeritage.isTfw, true);
});

test('getCollegeMetadata: handles Private and Government fallbacks correctly', () => {
  // Unlisted Private Engineering College
  const unlistedPrivate = getCollegeMetadata('SOME RANDOM PRIVATE COLLEGE OF TECHNOLOGY', 'CSE', 'OPEN');
  assert.equal(unlistedPrivate.tuitionFee, 100000);
  assert.equal(unlistedPrivate.averagePackage, 4.0);
  assert.equal(unlistedPrivate.isTfw, false);

  // Unlisted Government Engineering College
  const unlistedGovt = getCollegeMetadata('SOME NEW GOVERNMENT COLLEGE OF ENGINEERING', 'CSE', 'OPEN');
  assert.equal(unlistedGovt.tuitionFee, 14000);
  assert.equal(unlistedGovt.averagePackage, 4.8);
  assert.equal(unlistedGovt.isTfw, false);
});
