const assert = require("node:assert/strict");
const test = require("node:test");
const indiaVoice = require("../services/crmIndiaVoice.service");
const { dial } = require("../services/crmDial.service");
const Staff = require("../models/AdminAccount");
const Lead = require("../models/CrmLead");
const Call = require("../models/CrmCall");

const id = "111111111111111111111111";
const lead = "222222222222222222222222";
const key = "198e1ff4-df44-4044-a322-11f8786ec761";
const staff = { crmIndiaVoiceDeskphone: "*12345", crmIndiaVoiceAgentNumber: "+919876543210" };
const query = value => ({ select() { return this; }, lean: async () => value });

test("9ance mapping cannot silently replace a Hashmi caller or take another extension", async () => {
  const model = { collection: { createIndex: async () => {} }, exists: async () => true,
    updateOne: async filter => { assert.equal(filter.crmHashmiAgentId, null); return { matchedCount: 0 }; } };
  await assert.rejects(indiaVoice.setAgent(id, { deskphone: "*12345", agentNumber: staff.crmIndiaVoiceAgentNumber }, model), { status: 409 });
  model.updateOne = async () => { throw Object.assign(new Error(), { code: 11000 }); };
  await assert.rejects(indiaVoice.setAgent(id, { deskphone: "*12345", agentNumber: staff.crmIndiaVoiceAgentNumber }, model), { status: 409 });
  await assert.rejects(indiaVoice.setAgent(id, { deskphone: "xyz", agentNumber: "" }, model), { status: 400 });
});

test("IndiaVoice uses Basic auth, an assigned deskphone and the selected client only; an unknown body is not accepted", async () => {
  const config = { BDFX_INDIAVOICE_API_USERNAME: "fixture", BDFX_INDIAVOICE_API_PASSWORD: "fixture" };
  let response = { status: "success", CallSid: "call-1" };
  const transport = async (url, options) => {
    assert.equal(url, "https://indiavoice.rpdigitalphone.com/api_v3/click_to_call_v2");
    assert.equal(options.params.calling_party_a, "09876543210");
    assert.equal(options.params.calling_party_b, "12025550101");
    assert.equal(options.params.deskphone, "*12345");
    assert.equal(options.auth.username, "fixture");
    assert.equal(options.maxRedirects, 0);
    return { data: response };
  };
  const request = () => indiaVoice.requestCall("+12025550101", staff, transport, config);
  assert.deepEqual(await request(), { state: "accepted", callId: "call-1" });
  response = { type: "success", campid: "campaign-1" };
  assert.deepEqual(await request(), { state: "accepted" });
  response = { type: "error", message: "Agent on break" };
  assert.deepEqual(await request(), { state: "rejected" });
  response = { type: "success", status: "rejected" };
  assert.deepEqual(await request(), { state: "rejected" });
  response = "<html>Sign in</html>";
  assert.deepEqual(await request(), { state: "unconfirmed" });
});

test("IndiaVoice keeps international agent and customer numbers distinct", async () => {
  const config = { BDFX_INDIAVOICE_API_USERNAME: "fixture", BDFX_INDIAVOICE_API_PASSWORD: "fixture" };
  await indiaVoice.requestCall("+919876543210", { ...staff, crmIndiaVoiceAgentNumber: "+12025550101" }, async (_url, { params }) => {
    assert.equal(params.calling_party_a, "12025550101");
    assert.equal(params.calling_party_b, "919876543210");
    return { data: { type: "success" } };
  }, config);
});

test("9ance uses the shared assigned-lead lock, returns prior requests and never falls through to Hashmi", async t => {
  t.mock.method(Staff, "findOne", () => query(staff));
  t.mock.method(indiaVoice, "configured", () => true);
  const reserve = t.mock.method(Lead, "findOneAndUpdate", (filter, change) => {
    assert.equal(String(filter.assignedTo), id);
    assert.equal(filter.status.$ne, "closed");
    assert.equal(change.$set.dialRequest.provider, "9ance");
    return { lean: async () => ({ phone: "+12025550101" }) };
  });
  t.mock.method(Lead, "updateOne", async () => {});
  const send = t.mock.method(indiaVoice, "requestCall", async () => ({ state: "accepted", callId: "call-2" }));
  await dial({ id }, lead, key, () => assert.fail("wrong provider"));
  reserve.mock.mockImplementation(() => ({ lean: async () => null }));
  t.mock.method(Lead, "findOne", () => query({ dialRequest: { provider: "9ance", key, state: "accepted" } }));
  assert.deepEqual(await dial({ id }, lead, key), { provider: "9ance", state: "accepted", mode: "live" });
  assert.equal(send.mock.callCount(), 1);
});

test("9ance records a final customer leg for the matched agent and lead, using a provider-scoped event ID", async t => {
  const report = { type: "call_report", StartTime: "2026-11-18 10:00:00", EndTime: "2026-11-18 10:01:00",
    LegB_Start_time: "2026-11-18 10:00:05", LegB_Picked_time: "2026-11-18 10:00:15", TalkDuration: "41",
    SourceNumber: "09876543210", DestinationNumber: "09987654321", CallSid: "fixture-1" };
  t.mock.method(Staff, "findOne", filter => { assert.equal(filter.crmIndiaVoiceAgentNumber, staff.crmIndiaVoiceAgentNumber); return query({ _id: id }); });
  t.mock.method(Lead, "findOne", filter => { assert.equal(filter.assignedTo, id); assert.equal(filter.phone, "+919987654321"); return query({ _id: lead }); });
  t.mock.method(Call.collection, "createIndex", async () => {});
  const insert = t.mock.method(Call, "updateOne", async (filter, update) => {
    assert.equal(filter.eventKey, "indiavoice:fixture-1");
    assert.equal(update.$setOnInsert.kind, "indiavoice");
    assert.equal(update.$setOnInsert.talkSeconds, 41);
    assert.equal(update.$setOnInsert.connected, true);
    assert.equal(update.$setOnInsert.occurredAt.toISOString(), "2026-11-18T04:30:00.000Z");
  });
  t.mock.method(Lead, "updateOne", async () => {});
  assert.equal(await indiaVoice.recordReport({ ...report, type: "live_call" }, "+05:30"), false);
  assert.equal(await indiaVoice.recordReport(report, ""), false);
  assert.equal(await indiaVoice.recordReport({ ...report, LegB_Start_time: "", LegB_Picked_time: "" }, "+05:30"), false);
  assert.equal(await indiaVoice.recordReport(report, "+05:30"), true);
  assert.equal(insert.mock.callCount(), 1);
  for (const value of ["wrong", undefined, ["x"]]) assert.equal(indiaVoice.reportAuthorized(value, "a".repeat(32)), false);
  assert.equal(indiaVoice.reportAuthorized("a".repeat(32), "a".repeat(32)), true);
});
