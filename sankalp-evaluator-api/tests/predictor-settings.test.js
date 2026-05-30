const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePredictorSettings,
  validatePredictorSettings,
} = require('../src/predictor-settings');

test('normalizePredictorSettings: applies stable defaults', () => {
  assert.deepEqual(normalizePredictorSettings(), {
    enabled: true,
    requiresPayment: false,
    price: 299,
  });
});

test('normalizePredictorSettings: preserves persisted values', () => {
  assert.deepEqual(normalizePredictorSettings({
    enabled: false,
    requiresPayment: true,
    price: '499',
  }), {
    enabled: false,
    requiresPayment: true,
    price: 499,
  });
});

test('validatePredictorSettings: accepts a complete settings payload', () => {
  assert.deepEqual(validatePredictorSettings({
    enabled: true,
    requiresPayment: true,
    price: 199,
  }), {
    settings: {
      enabled: true,
      requiresPayment: true,
      price: 199,
    },
  });
});

test('validatePredictorSettings: rejects incomplete or invalid settings', () => {
  assert.equal(validatePredictorSettings({ requiresPayment: true, price: 299 }).error, 'invalid_enabled');
  assert.equal(validatePredictorSettings({ enabled: true, price: 299 }).error, 'invalid_paywall');
  assert.equal(validatePredictorSettings({ enabled: true, requiresPayment: true, price: 0 }).error, 'invalid_price');
});
