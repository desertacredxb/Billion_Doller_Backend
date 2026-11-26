// routes/paymentRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const access = require("../middleware/accessControl");

const withdrawalLimiter = require("../middleware/withdrawalLimiter");
const checkMargin = require("../middleware/checkMargin");

const { handleDigipayDeposit, handlePaymentCallback } = require("../controllers/payments/digipay.controller");
const { handleRameeDeposit, handleRameeCallback } = require("../controllers/payments/rameePay.controller");
const { handleCryptoDeposit, handleCryptoCallback } = require("../controllers/payments/crypto.controller");
const { handleTrustpay24Deposit, handleTrustpay24Callback } = require("../controllers/payments/trustpay24.controller");
const { handleTruepay9Callback } = require("../controllers/payments/truepay9.controller");
const { handleCregisCallback } = require("../controllers/payments/cregis.controller");
const { handleManualPaymentRequest } = require("../controllers/payments/manualPayment.controller");
const { getFloxyQuote, createFloxyDeposit, getFloxyPayoutBalance, refreshFloxyPayout } = require("../controllers/payments/floxy.controller");
const rameeGlobalLkr = require("../controllers/payments/rameeGlobalLkr.controller");
const rameeGlobalIdr = require("../controllers/payments/rameeGlobalIdr.controller");

const { createCregisCheckout } = require("../controllers/paymentOrder.controller");
const { createPayoutRequest, approvePayoutReq, rejectPayoutRequest, getGlobalpayoutmethod } = require("../controllers/payout.controller");
const {
  reconcileOrders,
  listWithdrawals,
  getDepositsByAccount,
  getWithdrawalsByAccount,
  listAllDeposits,
  listAllWithdrawals,
} = require("../controllers/paymentAdmin.controller");

// ---------------------------------------------------------------------------
// Admin utilities
// ---------------------------------------------------------------------------

router.post("/reconcile-orders", auth, access.principal, access.admin, reconcileOrders);

// ---------------------------------------------------------------------------
// Provider webhook callbacks
// ---------------------------------------------------------------------------

router.post("/callback", handlePaymentCallback);
router.post("/rameePay/callback", handleRameeCallback);
router.post("/crypto/callback", handleCryptoCallback);
router.post("/truepay9/callback", handleTruepay9Callback);
router.post("/trustpay24/callback", handleTrustpay24Callback);
router.post("/cregis/callback", handleCregisCallback);
router.route("/ramee-global/callback")
  .head((_req, res) => res.status(204).end())
  .post(rameeGlobalIdr.depositCallback, rameeGlobalLkr.depositCallback);
router.route("/ramee-global/payout-callback")
  .head((_req, res) => res.status(204).end())
  .post(rameeGlobalIdr.payoutCallback, rameeGlobalLkr.payoutCallback);

// ---------------------------------------------------------------------------
// Deposit routes
// ---------------------------------------------------------------------------

router.use(auth, access.principal);
router.post("/deposit", access.accountOwner("body", "merchant_user_id"), handleDigipayDeposit);
router.post("/cregis/deposit", access.accountOwner(), createCregisCheckout);
router.post("/trustpay24/deposit", access.accountOwner(), handleTrustpay24Deposit);
router.post("/ramee/deposit", access.accountOwner(), handleRameeDeposit);
router.post("/crypto/deposit", access.accountOwner(), handleCryptoDeposit);
// Floxy webhook is mounted separately in index.js (raw body, before express.json).
router.get("/floxy/quote", getFloxyQuote);
router.post("/floxy/deposit", access.accountOwner(), createFloxyDeposit);
router.post("/ramee-global/deposit", access.accountOwner(), rameeGlobalLkr.createDeposit);
router.post("/ramee-global/deposits/:orderid/refresh", access.owner, rameeGlobalLkr.refreshDeposit);
router.post("/ramee-global/idr/deposit", access.accountOwner(), rameeGlobalIdr.createDeposit);
router.post("/ramee-global/idr/deposits/:orderid/refresh", access.owner, rameeGlobalIdr.refreshDeposit);

// ---------------------------------------------------------------------------
// Withdrawal routes
// ---------------------------------------------------------------------------

router.post("/request", access.accountOwner(), withdrawalLimiter, createPayoutRequest);
router.post("/request_v2", rameeGlobalLkr.requireSupportedWithdrawalCurrency, access.accountOwner(), withdrawalLimiter, checkMargin, handleManualPaymentRequest);
router.post("/approve/:id", access.admin, approvePayoutReq);
router.post("/reject/:id", access.admin, rejectPayoutRequest);
router.get("/floxy/payout-balance", access.admin, getFloxyPayoutBalance);
router.post("/floxy/payouts/:id/refresh", access.admin, refreshFloxyPayout);
router.get("/ramee-global/payout-methods", access.owner, rameeGlobalLkr.payoutMethods);

router.get("/ramee/globalpayoutmethod", getGlobalpayoutmethod);

// ---------------------------------------------------------------------------
// Listing / query routes
// ---------------------------------------------------------------------------

router.get("/withdrawals", access.admin, listWithdrawals);
router.get("/deposit/:accountNo", access.accountOwner("params"), getDepositsByAccount);
router.get("/withdrawal/:accountNo", access.accountOwner("params"), getWithdrawalsByAccount);
router.get("/deposit", access.admin, listAllDeposits);
router.get("/withdrawal", access.admin, listAllWithdrawals);

module.exports = router;
