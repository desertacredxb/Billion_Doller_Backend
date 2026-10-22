const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { createService, period, PROPERTY_ID, createClientProvider } = require("../services/websiteAnalytics.service");
const { createController, reportingFailure } = require("../controllers/websiteAnalyticsController");
const { createRouter } = require("../routes/websiteAnalyticsRoutes");
const { createAccessControl } = require("../middleware/accessControl");
const { checkOnStartup } = require("../services/websiteAnalyticsReadiness.service");
const { reportingLog } = require("../services/websiteAnalyticsErrors");
function fakeClient({ fail = false } = {}) {
  const calls = [];
  const result = async (request, options) => {
    calls.push({ request, options });
    if (fail) throw new Error("private-key-or-token-must-not-leak");
    const names = request.metrics.map(m => m.name), dims = (request.dimensions || []).map(d => d.name);
    let rows = [];
    if (!dims.length) rows = [{ dimensions: [], values: names[0] === "activeUsers" ? [2] : [17, 21, 32] }];
    else if (dims[0] === "date") rows = [{ dimensions: ["20261021"], values: [9] }];
    else if (dims[0] === "eventName") rows = [{ dimensions: ["generate_lead"], values: [3] }];
    else if (dims[0] === "pagePath") rows = [{ dimensions: ["/"], values: [24] }, { dimensions: ["/dashboard?email=private@example.invalid"], values: [99] }];
    else rows = [{ dimensions: ["Organic Search"], values: [7] }];
    return [{ metricHeaders: names.map(name => ({ name })), dimensionHeaders: dims.map(name => ({ name })), rows: rows.map(r => ({ dimensionValues: r.dimensions.map(value => ({ value })), metricValues: r.values.map(value => ({ value: String(value) })) })) }];
  };
  return { calls, runReport: result, runRealtimeReport: result };
}
test("analytics periods include complete Dubai dates across UTC midnight", () => {
  const r = period(7, new Date("2026-10-20T22:00:00Z"));
  assert.deepEqual(r, { from: "2026-10-15", to: "2026-10-21", days: 7, timezone: "Asia/Dubai" });
});
test("missing reporting credentials returns a connection state, never fabricated zero metrics", async () => {
  const report = await createService({ clientProvider: () => null }).report(7);
  assert.equal(report.connected, false); assert.equal(report.totals, undefined);
  assert.equal(createClientProvider({})(), null);
  assert.throws(() => createClientProvider({ GA4_REPORTING_CREDENTIALS_JSON: '{"type":"user","private_key":"secret"}' })());
});
test("reports use only the fixed BDFX property, distinct-period totals, bounded calls and public page paths", async () => {
  const client = fakeClient();
  const service = createService({ clientProvider: () => client, now: () => new Date("2026-10-21T12:00:00Z") });
  const report = await service.report(7);
  assert.equal(client.calls.length, 6);
  assert.ok(client.calls.every(c => c.request.property === `properties/${PROPERTY_ID}` && c.options.timeout === 8000));
  assert.deepEqual(report.totals, { users: 17, sessions: 21, views: 32, leads: 3, signups: 0, activeUsers30Minutes: 2 });
  assert.equal(report.daily.length, 7); assert.equal(report.daily.at(-1).views, 9);
  assert.deepEqual(report.pages, [{ path: "/", views: 24 }]);
  assert.equal(JSON.stringify(report).includes("private@example.invalid"), false);
  const events = client.calls.find(c => c.request.dimensions?.[0]?.name === "eventName");
  assert.deepEqual(events.request.dimensionFilter.filter.inListFilter.values, ["generate_lead", "sign_up"]);
});
test("concurrent refreshes coalesce and refresh only after expiry; failures never become cached zeros", async () => {
  let time = Date.parse("2026-10-21T12:00:00Z"); const client = fakeClient();
  const service = createService({ clientProvider: () => client, now: () => new Date(time) });
  const [first, second] = await Promise.all([service.report(7), service.report(7)]);
  assert.deepEqual(first, second); assert.equal(client.calls.length, 6);
  await service.report(7); assert.equal(client.calls.length, 6);
  time += 60001; await service.report(7); assert.equal(client.calls.length, 12);
  const broken = fakeClient({ fail: true }); const failing = createService({ clientProvider: () => broken });
  await assert.rejects(() => failing.report(7)); await assert.rejects(() => failing.report(7)); assert.equal(broken.calls.length, 12);
});
test("the actual HTTP route blocks anonymous, client, manager and stale sessions before reports; owner responses are no-store", async () => {
  process.env.JWT_SECRET = "synthetic-analytics-test-key";
  process.env.ADMIN_OWNER_EMAILS = "owner@example.invalid";
  const access = createAccessControl({ admins: { findOne: async f => f.authVersion === 1 ? { _id: f._id, email: f.email, enabled: true, role: "manager", permissions: ["reports"], invitedBy: "owner" } : null }, users: { findById: () => ({ select: async () => ({ _id: "client", email: "client@example.invalid", isVerified: true }) }) } });
  let calls = 0;
  const app = express(); app.use("/api/analytics", createRouter({ principal: access.principal, owner: access.owner, controller: createController({ service: { report: async () => { calls++; return { connected: false }; } } }) }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/analytics/report`;
  const token = (email, version = 1) => jwt.sign({ kind: "admin", sub: "owner-id", email, version, iss: "bdfx-auth", aud: "bdfx-admin" }, process.env.JWT_SECRET);
  try {
    const client = jwt.sign({ id: "client", role: "owner" }, process.env.JWT_SECRET);
    for (const [auth, status] of [[null, 401], [client, 403], [token("manager@example.invalid"), 403], [token("owner@example.invalid", 2), 401]]) {
      const r = await fetch(url, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} }); assert.equal(r.status, status); assert.equal(r.headers.get("cache-control"), "no-store");
    }
    assert.equal(calls, 0);
    const headers = { Authorization: `Bearer ${token("owner@example.invalid")}` };
    for (const query of ["?days=365", "?days=7&propertyId=123", "?days[]=7"]) assert.equal((await fetch(url + query, { headers })).status, 400);
    assert.equal(calls, 0);
    const r = await fetch(url + "?days=28", { headers }); assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "no-store"); assert.deepEqual(await r.json(), { connected: false }); assert.equal(calls, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test("provider errors are redacted and not converted into misleading success cards", async () => {
  const res = { code: 200, set() {}, status(code) { this.code = code; return this; }, json(value) { this.data = value; } };
  const logs = [];
  await createController({ logger: { error: line => logs.push(line) }, service: { report: async () => { throw new Error("private-key-or-token-must-not-leak"); } } })({ query: {} }, res);
  assert.equal(res.code, 503); assert.equal(res.data.totals, undefined); assert.equal(JSON.stringify(res.data).includes("private-key-or-token"), false);
  assert.deepEqual(logs, ["[website-analytics] GA4_UNAVAILABLE"]);
});
test("reporting failures give actionable, allowlisted diagnostics without provider data", () => {
  for (const [error, code] of [
    [{ code: 7, reason: "SERVICE_DISABLED", message: "private-secret-project-details" }, "GA4_API_DISABLED"],
    [{ code: 7, message: "private-property-and-email" }, "GA4_ACCESS_DENIED"],
    [{ code: 16, message: "private-token" }, "GA4_AUTH_FAILED"],
    [{ message: "invalid_grant: private-token" }, "GA4_AUTH_FAILED"],
    [{ code: 4, message: "private-request" }, "GA4_TIMEOUT"],
    [{ code: 8, message: "private-project" }, "GA4_QUOTA"],
    [{ code: 3, message: "private-payload" }, "GA4_REQUEST_INVALID"],
    [{ message: "Reporting response invalid" }, "GA4_RESPONSE_INVALID"],
    [{ code: "arbitrary-private-code", message: "private-key" }, "GA4_UNAVAILABLE"],
  ]) {
    const failure = reportingFailure(error);
    assert.equal(failure.code, code);
    assert.equal(JSON.stringify(failure).includes("private-"), false);
  }
  for (const raw of ["{broken-private-json", "null", "{}"])
    assert.throws(() => createClientProvider({ GA4_REPORTING_CREDENTIALS_JSON: raw })(), { code: "GA4_CREDENTIALS_INVALID" });
});
test("startup verification skips absent credentials and logs no report or credential data", async () => {
  let calls = 0;
  const logs = [], logger = { info: line => logs.push(line), error: line => logs.push(line) };
  const service = { report: async days => { calls++; assert.equal(days, 7); return { connected: true, totals: { users: 123456 }, private: "private-value" }; } };
  assert.deepEqual(await checkOnStartup({ env: {}, service, logger }), { connected: false });
  assert.equal(calls, 0); assert.deepEqual(logs, ["[website-analytics] UNCONFIGURED"]);
  logs.length = 0;
  assert.deepEqual(await checkOnStartup({ env: { GA4_REPORTING_CREDENTIALS_JSON: "private-key" }, service, logger }), { connected: true });
  assert.equal(calls, 1); assert.deepEqual(logs, ["[website-analytics] READY"]);
  const broken = { report: async () => { throw Object.assign(new Error("private-key-and-provider-body"), { code: 7, reason: "SERVICE_DISABLED" }); } };
  assert.deepEqual(await checkOnStartup({ env: { GA4_REPORTING_CREDENTIALS_JSON: "private-key" }, service: broken, logger }), { connected: false, code: "GA4_API_DISABLED" });
  assert.deepEqual(logs, ["[website-analytics] READY", "[website-analytics] GA4_API_DISABLED"]);
});
test("malformed reports identify only allowlisted report structure, never raw rows or unknown headers", async () => {
  const client = fakeClient(), runReport = client.runReport;
  client.runReport = async (request, options) => {
    const response = await runReport(request, options);
    if (!request.dimensions.length) response[0].metricHeaders[0].name = "private-person@example.invalid";
    return response;
  };
  await assert.rejects(() => createService({ clientProvider: () => client }).report(7), error => {
    const log = reportingLog(error, reportingFailure(error));
    assert.match(log, /stage=summary problem=metric_headers metrics=other,sessions,screenPageViews/);
    assert.equal(log.includes("private-person"), false);
    return true;
  });
  const bad = { message: "Reporting response invalid", reportingDiagnostic: { stage: "private-key", problem: "metric_values", metrics: "private-email", rows: "present" } };
  assert.equal(reportingLog(bad, reportingFailure(bad)).includes("private-"), false);
});
