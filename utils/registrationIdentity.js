const { normalizePhone: basicPhone } = require("./veriffPolicy");
const { parsePhoneNumberFromString } = require("libphonenumber-js/max");

function parsePhone(value) {
  const basic = basicPhone(value);
  const parsed = basic && parsePhoneNumberFromString(basic, { extract: false });
  return parsed?.isPossible() ? parsed : null;
}
function normalizePhone(value) { return parsePhone(value)?.number || null; }
const digitPattern = value => value.split("").join("[\\s().-]*");
function phonePattern(value) {
  const parsed = parsePhone(value);
  if (!parsed) return null;
  const zeroVariant = parsePhoneNumberFromString(`+${parsed.countryCallingCode}0${parsed.nationalNumber}`);
  const trunk = zeroVariant?.number === parsed.number ? "(?:0[\\s().-]*)?" : "";
  return new RegExp(`^\\s*(?:\\+|00)?${digitPattern(parsed.countryCallingCode)}[\\s().-]*${trunk}${digitPattern(parsed.nationalNumber)}\\s*$`);
}
function legacyNationalPattern(value) {
  const parsed = parsePhone(value);
  if (!parsed) return null;
  // A legacy number lacking a calling code is ambiguous. Reserve it for support
  // review rather than create a potentially duplicate client identity.
  return new RegExp(`^\\s*(?:0[\\s().-]*)?${digitPattern(parsed.nationalNumber)}\\s*$`);
}

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}
function emailPattern(value) {
  const email = normalizeEmail(value);
  return email ? new RegExp(`^\\s*${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") : null;
}
const maskedPhone = phone => `${phone.slice(0, 3)}${"•".repeat(Math.max(3, phone.length - 7))}${phone.slice(-4)}`;
module.exports = { normalizeEmail, emailPattern, normalizePhone, phonePattern, legacyNationalPattern, maskedPhone };
