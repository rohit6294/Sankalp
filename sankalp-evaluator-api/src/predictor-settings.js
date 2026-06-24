const DEFAULT_PREDICTOR_SETTINGS = Object.freeze({
  enabled: true,
  requiresPayment: false,
  price: 299,
  choiceFillingEnabled: true,
  choiceFillingRequiresPayment: true,
  choiceFillingPrice: 199,
  choiceFillingMaxAttempts: 30,
});

function normalizePredictorSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const price = Number(source.price);
  const cfPrice = Number(source.choiceFillingPrice);
  const cfMaxAttempts = Number(source.choiceFillingMaxAttempts);

  return {
    enabled: source.enabled !== false,
    requiresPayment: source.requiresPayment === true,
    price: Number.isFinite(price) && price >= 1
      ? price
      : DEFAULT_PREDICTOR_SETTINGS.price,
    choiceFillingEnabled: source.choiceFillingEnabled !== false,
    choiceFillingRequiresPayment: source.choiceFillingRequiresPayment !== false,
    choiceFillingPrice: Number.isFinite(cfPrice) && cfPrice >= 1
      ? cfPrice
      : DEFAULT_PREDICTOR_SETTINGS.choiceFillingPrice,
    choiceFillingMaxAttempts: Number.isFinite(cfMaxAttempts) && cfMaxAttempts >= 1
      ? cfMaxAttempts
      : DEFAULT_PREDICTOR_SETTINGS.choiceFillingMaxAttempts,
  };
}

function validatePredictorSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const price = Number(source.price);
  const cfPrice = Number(source.choiceFillingPrice);
  const cfMaxAttempts = Number(source.choiceFillingMaxAttempts);

  if (typeof source.enabled !== 'boolean') {
    return { error: 'invalid_enabled', message: 'Predictor visibility must be enabled or disabled.' };
  }
  if (typeof source.requiresPayment !== 'boolean') {
    return { error: 'invalid_paywall', message: 'Predictor paywall status must be enabled or disabled.' };
  }
  if (!Number.isFinite(price) || price < 1) {
    return { error: 'invalid_price', message: 'Predictor price must be at least INR 1.' };
  }

  if (typeof source.choiceFillingEnabled !== 'boolean') {
    return { error: 'invalid_cf_enabled', message: 'Choice Filling visibility must be enabled or disabled.' };
  }
  if (typeof source.choiceFillingRequiresPayment !== 'boolean') {
    return { error: 'invalid_cf_paywall', message: 'Choice Filling paywall status must be enabled or disabled.' };
  }
  if (!Number.isFinite(cfPrice) || cfPrice < 1) {
    return { error: 'invalid_cf_price', message: 'Choice Filling price must be at least INR 1.' };
  }
  if (!Number.isFinite(cfMaxAttempts) || cfMaxAttempts < 1) {
    return { error: 'invalid_cf_attempts', message: 'Choice Filling max attempts must be at least 1.' };
  }

  return {
    settings: {
      enabled: source.enabled,
      requiresPayment: source.requiresPayment,
      price,
      choiceFillingEnabled: source.choiceFillingEnabled,
      choiceFillingRequiresPayment: source.choiceFillingRequiresPayment,
      choiceFillingPrice: cfPrice,
      choiceFillingMaxAttempts: cfMaxAttempts,
    },
  };
}

module.exports = {
  DEFAULT_PREDICTOR_SETTINGS,
  normalizePredictorSettings,
  validatePredictorSettings,
};
