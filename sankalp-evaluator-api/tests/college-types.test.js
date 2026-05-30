const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyCollegeType } = require('../src/college-types');

test('classifyCollegeType: keeps known government engineering colleges in the government bucket', () => {
  assert.equal(
    classifyCollegeType('Jalpaiguri Goverment Engineering College,Jalpaiguri', 'Computer Science & Engineering'),
    'State Government Engineering College',
  );

  assert.equal(
    classifyCollegeType('RAMKRISHNA MAHATO GOVERNMENT ENGINEERING COLLEGE, PURULIA', 'Civil Engineering'),
    'State Government Engineering College',
  );
});

test('classifyCollegeType: separates central government engineering college', () => {
  assert.equal(
    classifyCollegeType('GHANI KHAN CHOUDHURY INSTITUTE OF ENGINEERING & TECHNOLOGY, MALDA', 'Food Technology'),
    'Central Government Engineering College',
  );
});

test('classifyCollegeType: separates private universities from government university bucket', () => {
  assert.equal(
    classifyCollegeType('Sister Nivedita University, New Town', 'Computer Science & Engineering - TFW'),
    'Private University',
  );

  assert.equal(
    classifyCollegeType('SCHOOL OF PHARMACY, TECHNO INDIA UNIVERSITY, SALT LAKE', 'Pharmacy'),
    'Private University',
  );
});

test('classifyCollegeType: keeps Jalpaiguri pharmacy college as state government pharmacy', () => {
  assert.equal(
    classifyCollegeType('Institute of Pharmacy, Jalpaiguri', 'Pharmacy'),
    'State Government Pharmacy College',
  );
});

test('classifyCollegeType: keeps standalone private pharmacy colleges separate', () => {
  assert.equal(
    classifyCollegeType('BCDA College of Pharmacy & Technology, Hridaypur, Barasat', 'Pharmacy'),
    'Stand Alone Private Pharmacy College',
  );
});
