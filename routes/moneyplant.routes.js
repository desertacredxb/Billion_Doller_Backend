// routes/moneyplant.routes.js
const express = require("express");
const router = express.Router();
const {
  registerUserWithMoneyPlant,
  getAccountSummary,
  updatePassword,
  addBalance,
} = require("../controllers/moneyplant.controller");

router.post("/register", registerUserWithMoneyPlant);
router.post("/checkBalance", getAccountSummary);
router.post("/updatePassword", updatePassword);
router.post("/add-balance", addBalance);

module.exports = router;
