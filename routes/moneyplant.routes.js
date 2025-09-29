// routes/moneyplant.routes.js
const express = require("express");
const router = express.Router();
const {
  registerUserWithMoneyPlant,
  getAccountSummary,
  updatePassword,
  addBalance,
  getTransactions,
  getDeals,
} = require("../controllers/moneyplant.controller");

router.post("/register", registerUserWithMoneyPlant);
router.post("/checkBalance", getAccountSummary);
router.post("/updatePassword", updatePassword);
router.post("/add-balance", addBalance);
router.post("/getTransactions", getTransactions);
router.post("/getDeals", getDeals);

module.exports = router;
