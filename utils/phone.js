const { parsePhoneNumberFromString } = require('libphonenumber-js');

function normalizePhone(input) {
  const parsed = parsePhoneNumberFromString(String(input || '').trim());
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

module.exports = { normalizePhone };
