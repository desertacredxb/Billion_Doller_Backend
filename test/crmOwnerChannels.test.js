const test = require("node:test");
const assert = require("node:assert/strict");
const { recordingUrl, mediaFromReport, messages, roster } = require("../services/crmOwnerChannels");
const router = require("../routes/crmOwnerChannels");
const Staff = require("../models/AdminAccount");
const { Account, Thread } = require("../models/CrmInbox");

test("the owner guard runs before every communication and playback route", () => {
  const first = router.stack[0];
  assert.equal(first.handle, require("../middleware/accessControl").owner);
  for (const principal of [null, { isAdmin: true, adminRole: "manager", permissions: ["crm_team"] }]) {
    let code;
    const res = { status(n) { code = n; return this; }, json() {} };
    first.handle({ principal }, res, () => assert.fail("Not an owner"));
    assert.ok(code === 401 || code === 403);
  }
});

test("recordings stay on the permitted provider media paths", () => {
  const sample = "https://callrecords.rpdigitalphone.com/outgoing/India/test/example.wav";
  assert.equal(recordingUrl("indiavoice", sample), sample);
  for (const url of [sample.replace("https:", "http:"), sample.replace(".com/", ".com.example/"),
    sample.replace("outgoing", "internal"), sample.replace(".com", ".com:8443"), sample.replace("https://", "https://user@")]) {
    assert.equal(recordingUrl("indiavoice", url), null);
  }
  const mp3 = "https://v4-api.deepcall.com/api/v2/recording/directstream/example/mp3/12/2026/01/15/test.mp3";
  assert.equal(mediaFromReport([{ file: "https://example.com/file.mp3" }, { recording: mp3 }]), mp3);
  assert.equal(recordingUrl("indiavoice", mp3), null);
});

test("messaging roster includes active CRM agents without a dialer or messaging connection", async t => {
  let filter;
  t.mock.method(Staff, "find", q => { filter = q; return { select: () => ({ sort: () => ({ lean: () => [{ _id: "a", fullName: "New agent" }] }) }) }; });
  t.mock.method(Account, "find", () => ({ select: () => ({ lean: () => [] }) }));
  const team = await roster("telegram");
  assert.equal(team[0].name, "New agent");
  assert.equal(filter.permissions, "crm");
  assert.equal(filter.crmHashmiAgentId, undefined);
  assert.equal(filter.crmIndiaVoiceDeskphone, undefined);
});

test("an owner conversation is bound to the selected member and channel", async t => {
  const id = "1".repeat(24), agent = "2".repeat(24);
  t.mock.method(Thread, "exists", async f => {
    assert.equal(String(f.agent), agent);
    assert.equal(f.channel, "telegram");
    assert.equal(String(f._id), id);
    return false;
  });
  await assert.rejects(messages("telegram", agent, id, 1), { status: 404 });
});

test("owner playback gets audio from the dialer and returns only the audio bytes", async t => {
  const axios = require("axios");
  const { Readable, Writable } = require("node:stream");
  const Call = require("../models/CrmCall");
  const { play } = require("../services/crmOwnerChannels");
  const media = "https://callrecords.rpdigitalphone.com/outgoing/India/example/recording.wav";
  const bytes = Buffer.from("RIFF-test-audio");
  const agent = "1".repeat(24), id = "2".repeat(24);
  t.mock.method(Call, "findOne", f => {
    assert.equal(String(f.agent), agent);
    assert.equal(String(f._id), id);
    assert.equal(f.connected, true);
    assert.equal(f.kind, "indiavoice");
    return { select: () => ({ lean: () => ({ recordingUrl: media }) }) };
  });
  t.mock.method(axios, "get", async (url, opts) => {
    assert.equal(url, media);
    assert.equal(opts.maxRedirects, 0);
    return { headers: { "content-type": "audio/wav" }, data: Readable.from([bytes]) };
  });
  const received = [];
  const out = new Writable({ write(chunk, _encoding, callback) { received.push(chunk); callback(); } });
  out.set = headers => assert.equal(headers["Cache-Control"], "private, no-store");
  await play("9ance", agent, id, out);
  assert.deepEqual(Buffer.concat(received), bytes);
});
