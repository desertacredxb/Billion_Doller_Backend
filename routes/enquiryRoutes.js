const express = require("express");
const { rateLimit } = require("express-rate-limit");
const auth = require("../middleware/authMiddleware");
const access = require("../middleware/accessControl");
const notifications = require("../services/enquiryNotifications.service");
const { createController } = require("../controllers/enquiryController");
const controller = createController({ notify: notifications.processPending });
const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60000, limit: 5, standardHeaders: "draft-7", legacyHeaders: false,
  message: { message: "Too many enquiries submitted. Please try again later or contact support." } });
router.post("/", limiter, controller.create);
router.get("/", auth, access.principal, access.admin, controller.list);
router.patch("/:id", auth, access.principal, access.admin, controller.update);
module.exports = router;
