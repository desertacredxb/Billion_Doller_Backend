// routes/moneyplant.routes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const access = require("../middleware/accessControl");
const {
  registerUserWithMT5,
  getMT5User,
  changeMT5Password,
  updateUserMT5balance,
  getMT5DealsController,
  getMT5DealsTotalController,
  getMT5AccountController,
  getMT5SymbolListController,
} = require("../controllers/mt5Controller.js");
const { receiveIbCommissionWebhook } = require("../controllers/mt5WebhookController.js");

// Provider callbacks do not use a browser session.
router.post("/IbCommisionWebhook", receiveIbCommissionWebhook);
router.use(auth, access.principal);
router.post("/register", access.emailOwner("body"), registerUserWithMT5);
router.get("/user", access.accountOwner("query", "login"), getMT5User);
router.post("/change_password", access.accountOwner("body", "login"), changeMT5Password);
router.post("/update_balance", access.admin, updateUserMT5balance);

// Referral-system services - not yet used by IB commission calculation,
// exposed standalone for verification/manual lookups.
router.get("/deals", access.accountOwner("query", "login"), getMT5DealsController);
router.get("/deals/total", access.accountOwner("query", "login"), getMT5DealsTotalController);
router.get("/account", access.accountOwner("query", "login"), getMT5AccountController);
router.get("/symbols", getMT5SymbolListController);

module.exports = router;
