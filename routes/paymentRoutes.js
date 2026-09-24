// routes/paymentRoutes.js
const express = require("express");
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { loadPrincipal, requireAdmin, requireAccountOwner } = require('../middleware/accessControl');
const admin = [authMiddleware, loadPrincipal, requireAdmin];
const accountOwner = (source, key) => [authMiddleware, loadPrincipal, requireAccountOwner(source, key)];

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

router.post("/reconcile-orders", ...admin, reconcileOrders);

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

router.post("/deposit", ...accountOwner('body', 'merchant_user_id'), handleDigipayDeposit);
router.post("/cregis/deposit", ...accountOwner('body', 'accountNo'), createCregisCheckout);
router.post("/trustpay24/deposit", ...accountOwner('body', 'accountNo'), handleTrustpay24Deposit);
router.post("/ramee/deposit", ...accountOwner('body', 'accountNo'), handleRameeDeposit);
router.post("/crypto/deposit", ...accountOwner('body', 'accountNo'), handleCryptoDeposit);

// ---------------------------------------------------------------------------
// Withdrawal routes
// ---------------------------------------------------------------------------

router.post("/request", ...accountOwner('body', 'accountNo'), withdrawalLimiter, createPayoutRequest);
router.post("/request_v2", ...accountOwner('body', 'accountNo'), withdrawalLimiter, checkMargin, handleManualPaymentRequest);
router.post("/approve/:id", ...admin, approvePayoutReq);
router.post("/reject/:id", ...admin, rejectPayoutRequest);

// ---------------------------------------------------------------------------
// Listing / query routes
// ---------------------------------------------------------------------------

router.get("/withdrawals", ...admin, listWithdrawals);
router.get("/deposit/:accountNo", ...accountOwner('params', 'accountNo'), getDepositsByAccount);
router.get("/withdrawal/:accountNo", ...accountOwner('params', 'accountNo'), getWithdrawalsByAccount);
router.get("/deposit", ...admin, listAllDeposits);
router.get("/withdrawal", ...admin, listAllWithdrawals);

module.exports = router;
