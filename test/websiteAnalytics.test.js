const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const { createService, period, PROPERTY_ID, createClientProvider } = require("../services/websiteAnalytics.service");
const { createController } = require("../controllers/websiteAnalyticsController");
const { createRouter } = require("../routes/websiteAnalyticsRoutes");
const { createAccessControl } = require("../middleware/accessControl");
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
  await createController({ service: { report: async () => { throw new Error("private-key-or-token-must-not-leak"); } } })({ query: {} }, res);
  assert.equal(res.code, 503); assert.equal(res.data.totals, undefined); assert.equal(JSON.stringify(res.data).includes("private-key-or-token"), false);
});
