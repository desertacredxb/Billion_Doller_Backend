const express = require("express");
const { rateLimit } = require("express-rate-limit");
const auth = require("../middleware/authMiddleware");
const access = require("../middleware/accessControl");
const { createController } = require("../controllers/supportChatController");
function createRouter({ controller = createController(), authorization = access } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  const limit = maximum => rateLimit({ windowMs: 900000, limit: maximum, standardHeaders: "draft-7", legacyHeaders: false,
    message: { message: "Too many support requests. Please try again later." } });
  router.post("/sessions", limit(10), controller.create);
  router.post("/sessions/:id/events", limit(180), controller.event);
  router.post("/sessions/:id/contact", limit(5), controller.contact);
  router.use("/admin", auth, authorization.principal, authorization.admin);
  router.get("/admin/sessions", controller.list);
  router.get("/admin/sessions/:id", controller.detail);
  router.patch("/admin/sessions/:id", limit(60), controller.update);
  return router;
}
module.exports = createRouter();
module.exports.createRouter = createRouter;
