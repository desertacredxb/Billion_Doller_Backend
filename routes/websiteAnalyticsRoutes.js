const express = require("express");
const auth = require("../middleware/authMiddleware");
const access = require("../middleware/accessControl");
function createRouter({ authentication = auth, principal = access.principal, owner = access.owner, controller = require("../controllers/websiteAnalyticsController").createController() } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/report", authentication, principal, owner, controller);
  return router;
}
module.exports = createRouter();
module.exports.createRouter = createRouter;
