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
    choiceFillingEnabled: true,
    choiceFillingRequiresPayment: true,
    choiceFillingPrice: 199,
    choiceFillingMaxAttempts: 30,
  });
});

test('normalizePredictorSettings: preserves persisted values', () => {
  assert.deepEqual(normalizePredictorSettings({
    enabled: false,
    requiresPayment: true,
    price: '499',
    choiceFillingEnabled: false,
    choiceFillingRequiresPayment: false,
    choiceFillingPrice: '249',
    choiceFillingMaxAttempts: '45',
  }), {
    enabled: false,
    requiresPayment: true,
    price: 499,
    choiceFillingEnabled: false,
    choiceFillingRequiresPayment: false,
    choiceFillingPrice: 249,
    choiceFillingMaxAttempts: 45,
  });
});

test('validatePredictorSettings: accepts a complete settings payload', () => {
  assert.deepEqual(validatePredictorSettings({
    enabled: true,
    requiresPayment: true,
    price: 199,
    choiceFillingEnabled: true,
    choiceFillingRequiresPayment: true,
    choiceFillingPrice: 149,
    choiceFillingMaxAttempts: 30,
  }), {
    settings: {
      enabled: true,
      requiresPayment: true,
      price: 199,
      choiceFillingEnabled: true,
      choiceFillingRequiresPayment: true,
      choiceFillingPrice: 149,
      choiceFillingMaxAttempts: 30,
    },
  });
});

test('validatePredictorSettings: rejects incomplete or invalid settings', () => {
  assert.equal(validatePredictorSettings({ requiresPayment: true, price: 299 }).error, 'invalid_enabled');
  assert.equal(validatePredictorSettings({ enabled: true, price: 299 }).error, 'invalid_paywall');
  assert.equal(validatePredictorSettings({ enabled: true, requiresPayment: true, price: 0 }).error, 'invalid_price');
  assert.equal(validatePredictorSettings({ enabled: true, requiresPayment: true, price: 299 }).error, 'invalid_cf_enabled');
  assert.equal(validatePredictorSettings({ enabled: true, requiresPayment: true, price: 299, choiceFillingEnabled: true }).error, 'invalid_cf_paywall');
  assert.equal(validatePredictorSettings({ enabled: true, requiresPayment: true, price: 299, choiceFillingEnabled: true, choiceFillingRequiresPayment: true, choiceFillingPrice: 0 }).error, 'invalid_cf_price');
  assert.equal(validatePredictorSettings({ enabled: true, requiresPayment: true, price: 299, choiceFillingEnabled: true, choiceFillingRequiresPayment: true, choiceFillingPrice: 199, choiceFillingMaxAttempts: 0 }).error, 'invalid_cf_attempts');
});
