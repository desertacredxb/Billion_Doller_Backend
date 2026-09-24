const countries = require('i18n-iso-countries');

// The provider requires ISO 3166-1 alpha-3. Never pass through an unknown
// three-letter string as if it were a validated country.
function normalizeCountry(value) {
  if (typeof value !== 'string' || value.length > 100) return null;
  const input = value.trim();
  if (!input) return null;
  const upper = input.toUpperCase();
  if (upper === 'UAE') return 'ARE';
  if (/^[A-Z]{3}$/.test(upper) && countries.alpha3ToAlpha2(upper)) return upper;
  if (/^[A-Z]{2}$/.test(upper)) return countries.alpha2ToAlpha3(upper) || null;
  return countries.getAlpha3Code(input, 'en') || null;
}

module.exports = { normalizeCountry, isUae: value => normalizeCountry(value) === 'ARE' };
