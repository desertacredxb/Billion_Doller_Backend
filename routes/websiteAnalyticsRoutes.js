const express = require("express");
const auth = require("../middleware/authMiddleware");
const access = require("../middleware/accessControl");
function createRouter({ authentication = auth, principal = access.principal, admin = access.admin, controller = require("../controllers/websiteAnalyticsController").createController() } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/report", authentication, principal, admin, controller);
  return router;
}
module.exports = createRouter();
module.exports.createRouter = createRouter;
