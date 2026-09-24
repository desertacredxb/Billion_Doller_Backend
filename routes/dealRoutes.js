// routes/dealRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const { loadPrincipal } = require("../middleware/accessControl");
const {
  getDealsController,
  getDealByOrderController,
} = require("../controllers/dealController.js");

router.use(auth, loadPrincipal);
router.get("/", getDealsController); // ?login=&from=2025-01-01&to=2025-01-31&page=&limit=
router.get("/:order", getDealByOrderController);

module.exports = router;
