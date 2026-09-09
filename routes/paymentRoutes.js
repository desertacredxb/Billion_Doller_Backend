// routes/paymentRoutes.js
const express = require("express");
const router = express.Router();

const withdrawalLimiter = require("../middleware/withdrawalLimiter");
const checkMargin = require("../middleware/checkMargin");

const { handleDigipayDeposit, handlePaymentCallback } = require("../controllers/payments/digipay.controller");
const { handleRameeDeposit, handleRameeCallback } = require("../controllers/payments/rameePay.controller");
const { handleCryptoDeposit, handleCryptoCallback } = require("../controllers/payments/crypto.controller");
const { handleTrustpay24Deposit, handleTrustpay24Callback } = require("../controllers/payments/trustpay24.controller");
const { handleTruepay9Callback } = require("../controllers/payments/truepay9.controller");
const { handleCregisCallback } = require("../controllers/payments/cregis.controller");
const { handleManualPaymentRequest } = require("../controllers/payments/manualPayment.controller");

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

router.post("/reconcile-orders", reconcileOrders);

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

router.post("/deposit", handleDigipayDeposit);
router.post("/cregis/deposit", createCregisCheckout);
router.post("/trustpay24/deposit", handleTrustpay24Deposit);
router.post("/ramee/deposit", handleRameeDeposit);
router.post("/crypto/deposit", handleCryptoDeposit);

// ---------------------------------------------------------------------------
// Withdrawal routes
// ---------------------------------------------------------------------------

router.post("/request", withdrawalLimiter, createPayoutRequest);
router.post("/request_v2", withdrawalLimiter, checkMargin, handleManualPaymentRequest);
router.post("/approve/:id", approvePayoutReq);
router.post("/reject/:id", rejectPayoutRequest);

// ---------------------------------------------------------------------------
// Listing / query routes
// ---------------------------------------------------------------------------

router.get("/withdrawals", listWithdrawals);
router.get("/deposit/:accountNo", getDepositsByAccount);
router.get("/withdrawal/:accountNo", getWithdrawalsByAccount);
router.get("/deposit", listAllDeposits);
router.get("/withdrawal", listAllWithdrawals);

module.exports = router;
