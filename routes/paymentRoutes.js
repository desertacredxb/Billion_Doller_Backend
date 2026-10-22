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
const { getFloxyQuote, createFloxyDeposit } = require("../controllers/payments/floxy.controller");

const { createCregisCheckout } = require("../controllers/paymentOrder.controller");
const { createPayoutRequest, approvePayoutReq, rejectPayoutRequest } = require("../controllers/payout.controller");
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

// ---------------------------------------------------------------------------
// Withdrawal routes
// ---------------------------------------------------------------------------

router.post("/request", access.accountOwner(), withdrawalLimiter, createPayoutRequest);
router.post("/request_v2", access.accountOwner(), withdrawalLimiter, checkMargin, handleManualPaymentRequest);
router.post("/approve/:id", access.admin, approvePayoutReq);
router.post("/reject/:id", access.admin, rejectPayoutRequest);

// ---------------------------------------------------------------------------
// Listing / query routes
// ---------------------------------------------------------------------------

router.get("/withdrawals", access.admin, listWithdrawals);
router.get("/deposit/:accountNo", access.accountOwner("params"), getDepositsByAccount);
router.get("/withdrawal/:accountNo", access.accountOwner("params"), getWithdrawalsByAccount);
router.get("/deposit", access.admin, listAllDeposits);
router.get("/withdrawal", access.admin, listAllWithdrawals);

module.exports = router;
