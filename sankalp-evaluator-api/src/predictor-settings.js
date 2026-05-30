const DEFAULT_PREDICTOR_SETTINGS = Object.freeze({
  enabled: true,
  requiresPayment: false,
  price: 299,
});

function normalizePredictorSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const price = Number(source.price);

  return {
    enabled: source.enabled !== false,
    requiresPayment: source.requiresPayment === true,
    price: Number.isFinite(price) && price >= 1
      ? price
      : DEFAULT_PREDICTOR_SETTINGS.price,
  };
}

function validatePredictorSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const price = Number(source.price);

  if (typeof source.enabled !== 'boolean') {
    return { error: 'invalid_enabled', message: 'Feature visibility must be enabled or disabled.' };
  }
  if (typeof source.requiresPayment !== 'boolean') {
    return { error: 'invalid_paywall', message: 'Paywall status must be enabled or disabled.' };
  }
  if (!Number.isFinite(price) || price < 1) {
    return { error: 'invalid_price', message: 'Price must be at least INR 1.' };
  }

  return {
    settings: {
      enabled: source.enabled,
      requiresPayment: source.requiresPayment,
      price,
    },
  };
}

module.exports = {
  DEFAULT_PREDICTOR_SETTINGS,
  normalizePredictorSettings,
  validatePredictorSettings,
};
