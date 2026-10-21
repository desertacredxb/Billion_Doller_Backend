const { createService } = require("../services/websiteAnalytics.service");
function createController({ service = createService() } = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (Object.keys(req.query).some(key => key !== "days") || (req.query.days !== undefined && !["7", "28", "90"].includes(req.query.days))) return res.status(400).json({ message: "Choose 7, 28 or 90 days." });
    try { res.json(await service.report(Number(req.query.days || 7))); }
    catch { res.status(503).json({ message: "Google reporting is unavailable. Please retry shortly." }); }
  };
}
module.exports = { createController };
