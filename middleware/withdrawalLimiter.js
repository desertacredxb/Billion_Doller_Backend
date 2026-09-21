const rateLimit = require("express-rate-limit");

const withdrawalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 2,
  message: "Too many withdrawal attempts. Please wait.",
});

module.exports = withdrawalLimiter;
