// routes/dealRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const access = require("../middleware/accessControl");
router.use(auth, access.principal);
const {
  getDealsController,
  getDealByOrderController,
} = require("../controllers/dealController.js");

router.get("/", access.accountOwner("query", "login"), getDealsController);
router.get("/:order", access.dealOwner, getDealByOrderController);

module.exports = router;
