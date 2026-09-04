// routes/moneyplant.routes.js
const express = require("express");
const router = express.Router();
const { registerUserWithMT5, getMT5User, changeMT5Password } = require("../controllers/mt5Controller.js");

router.post("/register", registerUserWithMT5);
router.get("/user", getMT5User);
router.post("/change_password", changeMT5Password);
module.exports = router;
