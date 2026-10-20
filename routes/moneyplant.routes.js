// routes/moneyplant.routes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const access = require("../middleware/accessControl");
const {
  registerUserWithMoneyPlant,
  getAccountSummary,
  updatePassword,
  addBalance,
  getTransactions,
  getDeals,
} = require("../controllers/moneyplant.controller");

router.use(auth, access.principal);
router.post("/register", access.emailOwner("body"), registerUserWithMoneyPlant);
router.post("/checkBalance", access.accountOwner("body", "accountno"), getAccountSummary);
router.post("/updatePassword", access.accountOwner("body", "accountno"), updatePassword);
router.post("/add-balance", access.admin, addBalance);
router.post("/getTransactions", access.accountOwner("body", "accountno"), getTransactions);
router.post("/getDeals", access.accountOwner("body", "accountno"), getDeals);

module.exports = router;
