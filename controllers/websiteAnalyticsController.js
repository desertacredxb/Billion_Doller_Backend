const { createService } = require("../services/websiteAnalytics.service");
const { reportingFailure } = require("../services/websiteAnalyticsErrors");
function createController({ service = createService(), logger = console } = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (Object.keys(req.query).some(key => key !== "days") || (req.query.days !== undefined && !["7", "28", "90"].includes(req.query.days))) return res.status(400).json({ message: "Choose 7, 28 or 90 days." });
    try { res.json(await service.report(Number(req.query.days || 7))); }
    catch (error) {
      const failure = reportingFailure(error);
      logger.error(`[website-analytics] ${failure.code}`);
      res.status(503).json(failure);
    }
  };
}
module.exports = { createController, reportingFailure };
