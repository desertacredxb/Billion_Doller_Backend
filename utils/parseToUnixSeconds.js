// Parses a date/time value into unix seconds. Accepts any normal date/time
// string (ISO, "YYYY-MM-DD", etc.) or a raw numeric timestamp, auto-detecting
// ms vs seconds.
function parseToUnixSeconds(value, paramName) {
  const asDate = new Date(value);
  if (!isNaN(asDate.getTime())) {
    return Math.floor(asDate.getTime() / 1000);
  }

  const asNumber = Number(value);
  if (!isNaN(asNumber) && value !== "") {
    return asNumber > 1e12 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
  }

  throw new Error(
    `Invalid ${paramName}: "${value}" - pass a normal date (e.g. "2025-01-01" or an ISO datetime) or a unix timestamp.`
  );
}

module.exports = { parseToUnixSeconds };
