const test = require("node:test");
const assert = require("node:assert/strict");
const provider = require("../services/crmInboxProvider");
const inbox = require("../services/crmInbox.service");
const { Account, Thread, Message } = require("../models/CrmInbox");
const Lead = require("../models/CrmLead");
test("WhatsApp credentials are encrypted and authentication tags are checked", t => {
  const original = process.env.BDFX_INBOX_ENCRYPTION_KEY;
  process.env.BDFX_INBOX_ENCRYPTION_KEY = "bb".repeat(32);
  t.after(() => { if (original)
    process.env.BDFX_INBOX_ENCRYPTION_KEY = original;
  else
    delete process.env.BDFX_INBOX_ENCRYPTION_KEY; });
  const sealed = provider.seal("test-only-token");
  assert.ok(!sealed.includes("test-only-token"));
  assert.equal(provider.unseal(sealed), "test-only-token");
  assert.throws(() => provider.unseal(sealed.replace(/^[^.]+/, "AAAAAAAAAAAAAAAA")));
  assert.equal(provider.equal(undefined, undefined), false);
});
test("Telegram private messages outside a connected business chat are ignored", async (t) => {
  const lookup = t.mock.method(Account, "findOne", () => { throw Error("Unexpected lookup"); });
  await inbox.telegramEvent({ message: { text: "personal content", chat: { id: 25, type: "private" }, from: { id: 25 } } });
  assert.equal(lookup.mock.callCount(), 0);
});
test("WhatsApp contact or history sync does not import private messages", async (t) => {
  const lookup = t.mock.method(Account, "findOne", () => { throw Error("Unexpected lookup"); });
  await inbox.whatsappEvent({ entry: [{ changes: [{ field: "history", value: { messages: [{ id: "private" }] } }, { field: "smb_app_state_sync", value: {} }] }] });
  assert.equal(lookup.mock.callCount(), 0);
});
test("disabled and unmapped business accounts cannot ingest messages", async (t) => {
  t.mock.method(Account, "findOne", () => ({ lean: async () => null }));
  const lookup = t.mock.method(Thread, "findOne", () => { throw Error("Unexpected lookup"); });
  await inbox.telegramEvent({ business_message: { business_connection_id: "none", chat: { id: 2, type: "private" } } });
  await inbox.whatsappEvent({ entry: [{ id: "10", changes: [{ field: "messages", value: { metadata: { phone_number_id: "20" }, messages: [{ id: "1" }] } }] }] });
  assert.equal(lookup.mock.callCount(), 0);
});
test("the owner can read a lead but cannot send under a team member's name", async (t) => {
  t.mock.method(Lead, "findOne", () => ({ select: () => ({ lean: async () => ({ assignedTo: "a", status: "new" }) }) }));
  const write = t.mock.method(Message, "create", () => { throw Error("Unexpected provider send"); });
  await assert.rejects(inbox.reply({ id: "0".repeat(24), adminRole: "owner" }, "1".repeat(24), {}), { status: 403 });
  assert.equal(write.mock.callCount(), 0);
});
test("an agent can read only current assigned leads and their own conversation threads", async (t) => {
  const id = "1".repeat(24), agent = "2".repeat(24);
  let scope;
  t.mock.method(Lead, "findOne", filter => {
    assert.equal(String(filter._id), id);
    assert.equal(String(filter.assignedTo), agent);
    return { select: () => ({ lean: async () => ({ _id: id, assignedTo: agent }) }) };
  });
  t.mock.method(Thread, "find", filter => { scope = filter; return { select: () => ({ lean: async () => [] }) }; });
  assert.deepEqual(await inbox.history({ adminRole: "manager", id: agent }, id), []);
  assert.equal(String(scope.agent), agent);
});

test("a signed-in agent cannot send to an unassigned or closed lead", async t => {
  let closed = false;
  t.mock.method(Lead, "findOne", filter => {
    assert.equal(String(filter.assignedTo), "2".repeat(24));
    return { select: () => ({ lean: async () => closed ? { assignedTo: filter.assignedTo, status: "closed" } : null }) };
  });
  const send = t.mock.method(provider, "telegram", () => { throw Error("Unexpected send"); });
  const agent = { adminRole: "manager", id: "2".repeat(24) };
  await assert.rejects(inbox.reply(agent, "1".repeat(24), {}), { status: 404 });
  closed = true;
  await assert.rejects(inbox.reply(agent, "1".repeat(24), {}), { status: 409 });
  assert.equal(send.mock.callCount(), 0);
});

test("an assigned WhatsApp client and a Business app echo appear in the same work thread", async t => {
  const staff = require("../models/AdminAccount");
  const account = { _id: "acct", agent: "agent", channel: "whatsapp", connectedAt: new Date(0) };
  t.mock.method(staff, "exists", async () => true);
  t.mock.method(Account, "findOne", filter => {
    assert.equal(filter.externalId, "1234");
    assert.equal(filter.connectionId, "1000");
    return { lean: async () => account };
  });
  t.mock.method(Lead, "findOne", filter => ({ select: () => ({
    lean: async () => filter.assignedTo === "agent" && filter.phone === "+12025550111" ? { _id: "lead" } : null,
  }) }));
  t.mock.method(Thread, "findOneAndUpdate", filter => {
    assert.deepEqual(filter, { account: "acct", lead: "lead" });
    return { lean: async () => ({ _id: "thread" }) };
  });
  const stored = [];
  t.mock.method(Message, "updateOne", async (_, change) => stored.push(change.$set));
  t.mock.method(Thread, "updateOne", async () => {});
  const value = { metadata: { phone_number_id: "1234" } };
  await inbox.whatsappEvent({entry:[{id:"1000",changes:[
    {field:"messages",value:{...value,messages:[{id:"m1",from:"12025550111",timestamp:"100",text:{body:"Question"}},{id:"private",from:"12025550199",timestamp:"100",text:{body:"Personal"}}]}},
    {field:"smb_message_echoes",value:{...value,message_echoes:[{id:"m2",to:"12025550111",timestamp:"101",text:{body:"Reply"}}]}},
  ]}]});
  assert.deepEqual(stored.map(m=>[m.text,m.outbound]),[["Question",false],["Reply",true]]);
});
