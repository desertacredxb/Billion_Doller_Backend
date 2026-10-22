const test = require("node:test");
const assert = require("node:assert/strict");
const { checkTargets, reportHealth, MARKER, TITLE } = require("../scripts/productionHealth");
const health = ok => ({ name: "Backend and database", ok, detail: ok ? "Healthy" : "HTTP 503" });
test("monitor requires the actual database readiness and expected website content", async () => {
  let results = await checkTargets(async url => url.endsWith("/health") ? { status: 200, json: async () => ({ status: "ok", database: "unavailable" }) } : { status: 200, text: async () => "Maintenance page" });
  assert.equal(results.every(result => !result.ok), true);
  results = await checkTargets(async url => url.endsWith("/health") ? { status: 200, json: async () => ({ status: "ok", database: "connected" }) } : { status: 200, text: async () => "Billion Dollar FX" });
  assert.equal(results.every(result => result.ok), true);
  results = await checkTargets(async () => { throw new Error("must not leak response details"); });
  assert.equal(JSON.stringify(results).includes("leak"), false);
});
test("outage alerts reuse one bot issue and recovery closes only that issue", async () => {
  const writes = []; let existing = null;
  const github = async (method, path, data) => {
    if (method === "GET") return [{ number: 1, title: TITLE, body: "Unrelated user issue" }, ...(existing ? [existing] : [])];
    writes.push({ method, path, data });
    if (method === "POST") existing = { number: 2, ...data };
    return {};
  };
  const run = results => reportHealth({ results, github, checkedAt: "2026-10-21", runUrl: "https://github.com/example/repo/actions/runs/1" });
  await run([health(true)]); assert.equal(writes.length, 0);
  await run([health(false)]); await run([health(false)]); await run([health(true)]);
  assert.deepEqual(writes.map(value => [value.method, value.path]), [["POST", "/issues"], ["PATCH", "/issues/2"], ["PATCH", "/issues/2"]]);
  assert.deepEqual(writes[0].data.assignees, ["desertacredxb"]);
  assert.deepEqual(writes[1].data.assignees, ["desertacredxb"]);
  assert.equal(writes[2].data.state, "closed"); assert.ok(writes[2].data.body.includes(MARKER));
});
