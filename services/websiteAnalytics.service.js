const { BetaAnalyticsDataClient } = require("@google-analytics/data");
const crypto = require("node:crypto");
const { reportingFailure } = require("./websiteAnalyticsErrors");
const PROPERTY_ID = "559982387";
const ANALYTICS_URL = "https://analytics.google.com/analytics/web/#/a412813918p559982387/realtime/overview";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const REPORT_DAYS = [1, 7, 28, 90];
const COUNTRIES = ["India", "Pakistan", "Vietnam"];
const META_EVENTS = ["bdfx_meta_paid_landing", "bdfx_meta_landing"];
const META_TRACKING_START = "2026-11-12";
const PUBLIC_PATHS = ["/", "/about", "/accounts", "/platform", "/contact", "/help-centre", "/ib-broker", "/education", "/analytical-tools", "/economic-calendar", "/currency-converter", "/currency-calculator", "/forex", "/metals", "/indices", "/commodities", "/crypto", "/oil", "/blogs", "/news", "/cashback", "/career", "/learn", "/learn/india/en", "/learn/india/hi", "/learn/pakistan/en", "/learn/pakistan/ur", "/learn/vietnam/en", "/learn/vietnam/vi"];
function period(days, now, daysAgo = 0) {
  const to = new Date(now.getTime() + 4 * 3600000 - daysAgo * 86400000).toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10);
  return { from, to, days, timezone: "Asia/Dubai" };
}
function createClientProvider(env = process.env) {
  let fingerprint, client;
  return () => {
    const raw = env.GA4_REPORTING_CREDENTIALS_JSON;
    if (!raw) return null;
    const next = crypto.createHash("sha256").update(raw).digest("hex");
    if (next === fingerprint) return client;
    let credentials;
    try { credentials = JSON.parse(raw); }
    catch { throw Object.assign(new Error("Reporting connection invalid"), { code: "GA4_CREDENTIALS_INVALID" }); }
    if (!credentials || credentials.type !== "service_account" || typeof credentials.client_email !== "string" || !credentials.client_email.endsWith(".iam.gserviceaccount.com") || typeof credentials.private_key !== "string" || !credentials.private_key.includes("BEGIN PRIVATE KEY")) throw Object.assign(new Error("Reporting connection invalid"), { code: "GA4_CREDENTIALS_INVALID" });
    // Fixed property, read-only scope, no delegated user or caller-supplied endpoint.
    const replacement = new BetaAnalyticsDataClient({ credentials: { client_email: credentials.client_email, private_key: credentials.private_key }, scopes: [SCOPE], fallback: true });
    client?.close().catch(() => {});
    client = replacement; fingerprint = next;
    return client;
  };
}
const REPORT_HEADERS = new Set(["totalUsers", "sessions", "screenPageViews", "eventCount", "activeUsers", "date", "eventName", "pagePath", "sessionDefaultChannelGroup", "country"]);
function invalidResponse(report, stage, problem) {
  const names = headers => Array.isArray(headers) ? headers.map(h => REPORT_HEADERS.has(h?.name) ? h.name : "other").join(",") || "empty" : "missing";
  return Object.assign(new Error("Reporting response invalid"), { reportingDiagnostic: {
    stage, problem, metrics: names(report?.metricHeaders), dimensions: names(report?.dimensionHeaders),
    rows: Array.isArray(report?.rows) ? (report.rows.length ? "present" : "empty") : "missing",
    rowCount: report?.rowCount === 0 ? "zero" : report?.rowCount === undefined ? "missing" : "nonzero",
  } });
}
function parseRows(report, dimensions, metrics, stage) {
  if (!report) throw invalidResponse(report, stage, "missing_report");
  // GA4 realtime can return an explicit zero-row response without headers when
  // nobody is active. Only that complete empty shape is a valid zero report.
  if (stage === "realtime" && report.rowCount === 0 && [report.rows, report.metricHeaders, report.dimensionHeaders].every(value => Array.isArray(value) && value.length === 0)) return [];
  if (metrics.some((name, i) => report.metricHeaders?.[i]?.name !== name)) throw invalidResponse(report, stage, "metric_headers");
  if (dimensions.some((name, i) => report.dimensionHeaders?.[i]?.name !== name)) throw invalidResponse(report, stage, "dimension_headers");
  return (report.rows || []).map(row => {
    const values = metrics.map((_, i) => Number(row.metricValues?.[i]?.value));
    if (values.some(n => !Number.isFinite(n) || n < 0)) throw invalidResponse(report, stage, "metric_values");
    return { dimensions: dimensions.map((_, i) => String(row.dimensionValues?.[i]?.value || "")), values };
  });
}

async function readCountryTraffic(standard, range) {
  const countryFilter = { filter: { fieldName: "country", inListFilter: { values: COUNTRIES } } };
  const read = async (dimensions, metrics, options, stage) => {
    try {
      const report = await standard(dimensions, metrics, options);
      const empty = report?.rowCount === 0 &&
        [report.rows, report.metricHeaders, report.dimensionHeaders].every(value => Array.isArray(value) && !value.length);
      return {
        rows: empty ? [] : parseRows(report, dimensions, metrics, stage),
        missing: report.metadata?.subjectToThresholding || report.metadata?.dataLossFromOtherRow ? null : 0,
      };
    } catch (error) {
      console.error(`[website-analytics] ${stage} ${reportingFailure(error).code}`);
      return null;
    }
  };
  const [traffic, meta] = await Promise.all([
    read(["country"], ["activeUsers", "sessions"], { dimensionFilter: countryFilter, limit: COUNTRIES.length }, "countries"),
    range.to < META_TRACKING_START ? null : read(["country", "eventName"], ["eventCount"], {
      dateRanges: [{ startDate: range.from < META_TRACKING_START ? META_TRACKING_START : range.from, endDate: range.to }],
      dimensionFilter: { andGroup: { expressions: [countryFilter, {
        filter: { fieldName: "eventName", inListFilter: { values: META_EVENTS } },
      }] } },
      limit: COUNTRIES.length * META_EVENTS.length,
    }, "meta-landings"),
  ]);
  const rows = COUNTRIES.map(country => {
    const visits = traffic?.rows.find(row => row.dimensions[0] === country)?.values;
    const metaCount = event => meta?.rows.find(row => row.dimensions[0] === country && row.dimensions[1] === event)?.values[0] ?? meta?.missing ?? null;
    return {
      country,
      users: visits?.[0] ?? traffic?.missing ?? null,
      sessions: visits?.[1] ?? traffic?.missing ?? null,
      paidMetaLandings: metaCount(META_EVENTS[0]),
      otherMetaLandings: metaCount(META_EVENTS[1]),
    };
  });
  return { metaTrackingStart: META_TRACKING_START, rows };
}

function createService({ clientProvider = createClientProvider(), now = () => new Date() } = {}) {
  const cache = new Map(), pending = new Map();
  let lastClient;
  return {
    async report(days, daysAgo = 0) {
      if (!REPORT_DAYS.includes(days) || (daysAgo !== 0 && (daysAgo !== 1 || days !== 1))) throw new Error("Invalid report period");
      const client = clientProvider();
      if (!client) { cache.clear(); return { connected: false, analyticsUrl: ANALYTICS_URL }; }
      if (client !== lastClient) { cache.clear(); pending.clear(); lastClient = client; }
      const range = period(days, now(), daysAgo), key = `${range.from}:${range.to}`;
      const saved = cache.get(key);
      if (saved && now().getTime() - saved.at < 60000) return saved.report;
      if (pending.has(key)) return pending.get(key);
      const operation = (async () => {
        const standard = (dimensions, metrics, extra = {}) => client.runReport({ property: `properties/${PROPERTY_ID}`, dateRanges: [{ startDate: range.from, endDate: range.to }], dimensions: dimensions.map(name => ({ name })), metrics: metrics.map(name => ({ name })), ...extra }, { timeout: 8000 }).then(([r]) => r);
        const [summary, daily, events, pages, channels, realtime, countryTraffic] = await Promise.all([
          standard([], ["totalUsers", "sessions", "screenPageViews"]),
          standard(["date"], ["screenPageViews"], { limit: 90, orderBys: [{ dimension: { dimensionName: "date" } }] }),
          standard(["eventName"], ["eventCount"], { dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: ["generate_lead", "sign_up"] } } }, limit: 2 }),
          standard(["pagePath"], ["screenPageViews"], { dimensionFilter: { filter: { fieldName: "pagePath", inListFilter: { values: PUBLIC_PATHS } } }, orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }], limit: 10 }),
          standard(["sessionDefaultChannelGroup"], ["sessions"], { orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: 8 }),
          client.runRealtimeReport({ property: `properties/${PROPERTY_ID}`, metrics: [{ name: "activeUsers" }] }, { timeout: 8000 }).then(([r]) => r),
          readCountryTraffic(standard, range),
        ]);
        const totals = parseRows(summary, [], ["totalUsers", "sessions", "screenPageViews"], "summary")[0]?.values || [0, 0, 0];
        const conversionRows = parseRows(events, ["eventName"], ["eventCount"], "events");
        const conversion = name => conversionRows.find(r => r.dimensions[0] === name)?.values[0] || 0;
        const dailyValues = new Map(parseRows(daily, ["date"], ["screenPageViews"], "daily").map(r => [r.dimensions[0], r.values[0]]));
        const dailyRows = Array.from({ length: days }, (_, index) => {
          const date = new Date(Date.parse(`${range.from}T00:00:00Z`) + index * 86400000).toISOString().slice(0, 10);
          return { date, views: dailyValues.get(date.replaceAll("-", "")) || 0 };
        });
        const report = { connected: true, analyticsUrl: ANALYTICS_URL, generatedAt: now().toISOString(), range,
          totals: { users: totals[0], sessions: totals[1], views: totals[2], leads: conversion("generate_lead"), signups: conversion("sign_up"), activeUsers30Minutes: parseRows(realtime, [], ["activeUsers"], "realtime")[0]?.values[0] || 0 },
          daily: dailyRows,
          pages: parseRows(pages, ["pagePath"], ["screenPageViews"], "pages").filter(r => PUBLIC_PATHS.includes(r.dimensions[0])).map(r => ({ path: r.dimensions[0], views: r.values[0] })),
          channels: parseRows(channels, ["sessionDefaultChannelGroup"], ["sessions"], "channels").map(r => ({ channel: r.dimensions[0].slice(0, 100), sessions: r.values[0] })),
          countryTraffic,
          thresholded: [summary, daily, events, pages, channels, realtime].some(r => r.metadata?.subjectToThresholding === true),
        };
        // Never combine a failed request with stale or invented zero-valued cards.
        if (client === lastClient) { cache.clear(); cache.set(key, { at: now().getTime(), report }); }
        return report;
      })();
      pending.set(key, operation);
      try { return await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
    },
  };
}
module.exports = { createService, createClientProvider, period, PROPERTY_ID, REPORT_DAYS };
