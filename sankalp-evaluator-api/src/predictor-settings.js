const DEFAULT_CHOICE_FILLING_TIERS = [
  { id: 'tier_1', price: 9, attempts: 3, label: '3 Attempts' },
  { id: 'tier_2', price: 19, attempts: 10, label: '10 Attempts' },
  { id: 'tier_3', price: 29, attempts: 40, label: '40 Attempts' },
  { id: 'tier_4', price: 99, attempts: -1, label: 'Unlimited' }
];

const DEFAULT_PREDICTOR_SETTINGS = Object.freeze({
  enabled: true,
  requiresPayment: false,
  price: 299,
  choiceFillingEnabled: true,
  choiceFillingRequiresPayment: true,
  choiceFillingPrice: 199,
  choiceFillingMaxAttempts: 30,
  choiceFillingTiers: DEFAULT_CHOICE_FILLING_TIERS,
});

function normalizeTiers(tiers) {
  if (!Array.isArray(tiers)) return [...DEFAULT_CHOICE_FILLING_TIERS];
  const normalized = tiers.map((t, idx) => {
    const price = Number(t.price);
    const attempts = Number(t.attempts);
    return {
      id: typeof t.id === 'string' && t.id ? t.id : `tier_${idx + 1}_${Date.now()}`,
      price: Number.isFinite(price) && price >= 1 ? price : 9,
      attempts: Number.isInteger(attempts) && (attempts >= 1 || attempts === -1) ? attempts : 3,
      label: typeof t.label === 'string' && t.label ? t.label : (attempts === -1 ? 'Unlimited' : `${attempts} Attempts`)
    };
  });
  return normalized.length > 0 ? normalized : [...DEFAULT_CHOICE_FILLING_TIERS];
}

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
    choiceFillingTiers: normalizeTiers(source.choiceFillingTiers),
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

  const tiers = normalizeTiers(source.choiceFillingTiers);

  return {
    settings: {
      enabled: source.enabled,
      requiresPayment: source.requiresPayment,
      price,
      choiceFillingEnabled: source.choiceFillingEnabled,
      choiceFillingRequiresPayment: source.choiceFillingRequiresPayment,
      choiceFillingPrice: cfPrice,
      choiceFillingMaxAttempts: cfMaxAttempts,
      choiceFillingTiers: tiers,
    },
  };
}

module.exports = {
  DEFAULT_PREDICTOR_SETTINGS,
  normalizePredictorSettings,
  validatePredictorSettings,
};
