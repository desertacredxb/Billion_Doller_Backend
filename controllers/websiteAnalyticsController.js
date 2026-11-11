const { createService } = require("../services/websiteAnalytics.service");
const { reportingFailure, reportingLog } = require("../services/websiteAnalyticsErrors");
function createController({ service = createService(), logger = console } = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    const { days = "7" } = req.query;
    if (Object.keys(req.query).some(key => key !== "days") || !["today", "yesterday", "7", "28", "90"].includes(days)) return res.status(400).json({ message: "Choose today, yesterday, 7, 28 or 90 days." });
    try { res.json(await service.report(days === "today" || days === "yesterday" ? days : Number(days))); }
    catch (error) {
      const failure = reportingFailure(error);
      logger.error(reportingLog(error, failure));
      res.status(503).json(failure);
    }
  };
}
module.exports = { createController, reportingFailure };
