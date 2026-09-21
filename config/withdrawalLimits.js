// Withdrawal request limits, centralized here so they can be tuned (e.g. for
// testing) in one place instead of hunting through every route/controller and
// frontend form that validates a withdrawal request.
module.exports = {
  MIN_WITHDRAWAL_USD: 1,
  MIN_WITHDRAWAL_INR: 10,
  // Minimum time a user must wait between two withdrawal requests.
  WITHDRAWAL_COOLDOWN_MINUTES: 1,
  // Maximum number of withdrawal requests a single account can submit per day.
  MAX_WITHDRAWALS_PER_DAY: 15,

  // RameePay's own hard limits on its Withdrawal Account (INR) API -
  // "Transaction amount must be between 100 and 100000." This is enforced by
  // RameePay itself, NOT something we control - lowering MIN_WITHDRAWAL_INR
  // below this for testing will still get rejected at the gateway.
  RAMEEPAY_MIN_INR: 1000,
  RAMEEPAY_MAX_INR: 100000,
};
