const { createService, REPORT_DAYS } = require("../services/websiteAnalytics.service");
const { reportingFailure, reportingLog } = require("../services/websiteAnalyticsErrors");
function createController({ service = createService(), logger = console } = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    const days = req.query.days ?? "7";
    const yesterday = days === "yesterday";
    if (Object.keys(req.query).some(key => key !== "days") || (!yesterday && !REPORT_DAYS.some(value => String(value) === days))) {
      return res.status(400).json({ message: "Choose Today, Yesterday, or 7, 28 or 90 days." });
    }
    try { res.json(await service.report(yesterday ? 1 : Number(days), yesterday ? 1 : 0)); }
    catch (error) {
      const failure = reportingFailure(error);
      logger.error(reportingLog(error, failure));
      res.status(503).json(failure);
    }
  };
}
module.exports = { createController, reportingFailure };
