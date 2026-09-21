// Minimum deposit amounts, centralized here so they can be tuned (e.g. for
// testing) in one place instead of hunting through every controller and
// frontend form that validates a deposit amount. Mirrors withdrawalLimits.js.
module.exports = {
  MIN_DEPOSIT_USD: 10,
  MIN_DEPOSIT_INR: 1000,
};
