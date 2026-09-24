// routes/moneyplant.routes.js
const express = require("express");
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const accountRegistration = require('../middleware/accountRegistration');
const { loadPrincipal, requireAdmin, requireOwnerEmail, requireAccountOwner } = require('../middleware/accessControl');
const signedIn = [authMiddleware, loadPrincipal];
const accountOwner = [...signedIn, requireAccountOwner('body', 'accountno')];
const {
  registerUserWithMoneyPlant,
  getAccountSummary,
  updatePassword,
  addBalance,
  getTransactions,
  getDeals,
} = require("../controllers/moneyplant.controller");

router.post("/register", ...signedIn, requireOwnerEmail('body', 'email'), accountRegistration, registerUserWithMoneyPlant);
router.post("/checkBalance", ...accountOwner, getAccountSummary);
router.post("/updatePassword", ...accountOwner, updatePassword);
router.post("/add-balance", ...signedIn, requireAdmin, addBalance);
router.post("/getTransactions", ...accountOwner, getTransactions);
router.post("/getDeals", ...accountOwner, getDeals);

module.exports = router;
