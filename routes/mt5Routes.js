// routes/moneyplant.routes.js
const express = require("express");
const router = express.Router();
const {
  registerUserWithMT5,
  getMT5User,
  changeMT5Password,
  updateUserMT5balance,
  getMT5DealsController,
  getMT5DealsTotalController,
  getMT5AccountController,
} = require("../controllers/mt5Controller.js");

router.post("/register", registerUserWithMT5);
router.get("/user", getMT5User);
router.post("/change_password", changeMT5Password);
router.post("/update_balance", updateUserMT5balance); // <--- Added endpoint

// Referral-system services - not yet used by IB commission calculation,
// exposed standalone for verification/manual lookups.
router.get("/deals", getMT5DealsController); // ?login=&from=2025-01-01&to=2025-01-31&offset=&total= (from/to: any normal date/datetime, or a unix timestamp)
router.get("/deals/total", getMT5DealsTotalController); // ?login=&from=2025-01-01&to=2025-01-31
router.get("/account", getMT5AccountController); // ?login=

module.exports = router;
