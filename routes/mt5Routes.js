// routes/moneyplant.routes.js
const express = require("express");
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const accountRegistration = require('../middleware/accountRegistration');
const { loadPrincipal, requireAdmin, requireOwnerEmail, requireAccountOwner } = require('../middleware/accessControl');
const signedIn = [authMiddleware, loadPrincipal];
const accountOwner = source => [...signedIn, requireAccountOwner(source, 'login')];
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

router.post("/register", ...signedIn, requireOwnerEmail('body', 'email'), accountRegistration, registerUserWithMT5);
router.get("/user", ...accountOwner('query'), getMT5User);
router.post("/change_password", ...accountOwner('body'), changeMT5Password);
router.post("/update_balance", ...signedIn, requireAdmin, updateUserMT5balance);

// Referral-system services - not yet used by IB commission calculation,
// exposed standalone for verification/manual lookups.
router.get("/deals", ...accountOwner('query'), getMT5DealsController);
router.get("/deals/total", ...accountOwner('query'), getMT5DealsTotalController);
router.get("/account", ...accountOwner('query'), getMT5AccountController);
router.get("/symbols", ...signedIn, getMT5SymbolListController);

router.post("/IbCommisionWebhook", receiveIbCommissionWebhook);

module.exports = router;
