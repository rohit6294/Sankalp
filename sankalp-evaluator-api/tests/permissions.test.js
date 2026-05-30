const { test } = require('node:test');
const assert = require('node:assert/strict');

const { allPermissions, hasPermission, normalizePermissions } = require('../src/permissions');

test('permissions: college predictor is controlled separately from evaluators', () => {
  const permissions = normalizePermissions({
    evaluators: { view: true, edit: true },
    collegePredictor: { view: false, edit: true },
  });

  assert.equal(hasPermission(permissions, 'evaluators', 'view'), true);
  assert.equal(hasPermission(permissions, 'evaluators', 'edit'), true);
  assert.equal(hasPermission(permissions, 'collegePredictor', 'view'), false);
  assert.equal(hasPermission(permissions, 'collegePredictor', 'edit'), false);
});

test('permissions: college predictor edit requires view permission', () => {
  const permissions = normalizePermissions({
    collegePredictor: { view: true, edit: true },
  });

  assert.equal(hasPermission(permissions, 'collegePredictor', 'view'), true);
  assert.equal(hasPermission(permissions, 'collegePredictor', 'edit'), true);
});

test('permissions: super admin all-permissions includes college predictor', () => {
  const permissions = allPermissions();

  assert.equal(hasPermission(permissions, 'collegePredictor', 'view'), true);
  assert.equal(hasPermission(permissions, 'collegePredictor', 'edit'), true);
});
