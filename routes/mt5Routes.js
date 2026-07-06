// routes/moneyplant.routes.js
const express = require("express");
const router = express.Router();
const { registerUserWithMT5 } = require("../controllers/mt5Controller.js");

router.post("/register", registerUserWithMT5);
module.exports = router;
