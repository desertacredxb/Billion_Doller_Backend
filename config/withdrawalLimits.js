// Minimum withdrawal amounts, centralized here so they can be tuned (e.g. for
// testing) in one place instead of hunting through every route/controller and
// frontend form that validates a withdrawal amount.
module.exports = {
  MIN_WITHDRAWAL_USD: 1,
  MIN_WITHDRAWAL_INR: 10,
};
