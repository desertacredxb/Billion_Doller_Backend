const test = require("node:test");
const assert = require("node:assert/strict");
const { credit, monthlyTotals } = require("../services/crmCallPay.service");
const { summarize } = require("../services/crmAttendance.service");
const { validate } = require("../services/crmDistribution.service");

test("daily credit is capped before summing across rates and currencies", () => {
  assert.equal(credit(45, { dailyMinor: 10000 }).payMinor, 5000);
  assert.equal(credit(150, { dailyMinor: 10000 }).payMinor, 10000);
  assert.equal(credit(1, null).payMinor, null);
  const days = [120, 0, 45, 90].map((unique, i) => ({ _id: { agent: "a", day: "2026-05-0" + (i + 1) }, unique, unresolved: 0, repeats: 2 }));
  const rates = [{ agent: "a", effectiveFrom: "2026-05-04", dailyMinor: 20000, currency: "AED" },
    { agent: "a", effectiveFrom: "2026-05-02", dailyMinor: 10000, currency: "INR" }];
  const result = monthlyTotals(days, rates).get("a");
  assert.equal(result.missingRates, 1); assert.equal(result.units, 225);
  assert.deepEqual(result.amounts, { INR: 5000, AED: 20000 });
});

test("midnight and overlapping sessions count only the actual worked time", () => {
  const start = new Date("2026-05-01T20:00:00Z"), end = new Date(+start + 86400000);
  const shifts = [{ agent: "a", start: new Date(+start - 3600000), end: new Date(+start + 1800000) },
    { agent: "a", start: new Date(+start + 900000), end: new Date(+start + 3600000) }];
  const live = summarize(shifts, start, end, new Date(+start + 2700000)).get("a");
  assert.equal(live.onDuty, true); assert.equal(live.seconds, 2700); assert.equal(live.lastOut, null);
  const ended = summarize(shifts, start, end, end).get("a");
  assert.equal(ended.onDuty, false); assert.equal(ended.seconds, 3600); assert.deepEqual(ended.lastOut, shifts[1].end);
});

test("distribution rejects duplicate seats and invalid totals before reserving stock", () => {
  const body = { requestId: "00000000-1111-2222-3333-444444444444", source: "Fixture", agents: ["000000000000000000000001"], quantity: 3 };
  assert.deepEqual(validate(body), body.agents);
  assert.throws(() => validate({ ...body, agents: body.agents.concat(body.agents) }), { status: 400 });
  assert.throws(() => validate({ ...body, quantity: -1 }), { status: 400 });
});
