const { createService } = require("./websiteAnalytics.service");
const { reportingFailure } = require("./websiteAnalyticsErrors");

// One read-only check per server start. Nothing is sent to a public route and
// neither report values nor provider error details are written to logs.
async function checkOnStartup({ env = process.env, service = createService(), logger = console } = {}) {
  if (!env.GA4_REPORTING_CREDENTIALS_JSON) {
    logger.info("[website-analytics] UNCONFIGURED");
    return { connected: false };
  }
  try {
    const report = await service.report(7);
    if (!report.connected) return { connected: false };
    logger.info("[website-analytics] READY");
    return { connected: true };
  } catch (error) {
    const { code } = reportingFailure(error);
    logger.error(`[website-analytics] ${code}`);
    return { connected: false, code };
  }
}

module.exports = { checkOnStartup };
