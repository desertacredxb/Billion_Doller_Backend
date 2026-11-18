const axios = require("axios");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const Call = require("../models/CrmCall");
const Lead = require("../models/CrmLead");
const Staff = require("../models/AdminAccount");
const { Account, Thread, Message } = require("../models/CrmInbox");
const { asId, CrmError, dubaiDay, staffFilter } = require("./crm.service");
const { settings: inboxSettings } = require("./crmInboxProvider");
const { settings: hashmiSettings } = require("./crmHashmi.service");

const dialers = { hashmi: "hashmi", "9ance": "indiavoice" };
const channels = new Set(["9ance", "hashmi", "telegram", "whatsapp"]);
const limit = 40;
const maxAudio = 64 * 1024 * 1024;

function recordingUrl(kind, raw) {
  if (typeof raw !== "string" || raw.length > 3000) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash) return null;
  if (kind === "indiavoice" && url.hostname === "callrecords.rpdigitalphone.com" &&
      /^\/outgoing\/[\w/.-]+\.(?:wav|mp3)$/i.test(url.pathname)) return url.href;
  if (kind === "hashmi" && ["v4-api.deepcall.com", "cloud.hashmiinfonet.net"].includes(url.hostname) &&
      /^\/api\/v2\/recording\/directstream\/[\w.-]+\/(mp3|wav)\/[\w/.-]+\.(mp3|wav)$/i.test(url.pathname)) return url.href;
  return null;
}

function channelKey(key) {
  if (!channels.has(key)) throw new CrmError(400, "Unknown team channel.");
  return key;
}

function pageOffset(value) {
  const page = value === undefined ? 1 : Number(value);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new CrmError(400, "Invalid page.");
  return (page - 1) * limit;
}

async function roster(key) {
  channelKey(key);
  const agents = await Staff.find(staffFilter).select("fullName crmHashmiAgentId crmIndiaVoiceDeskphone").sort({ fullName: 1, _id: 1 }).lean();
  const isDialer = Boolean(dialers[key]);
  const accounts = isDialer ? [] : await Account.find({ channel: key, agent: { $in: agents.map(a => a._id) } }).select("agent enabled").lean();
  const connected = new Set(accounts.filter(a => a.enabled).map(a => String(a.agent)));
  const configured = inboxSettings()[key];
  return agents.map(a => {
    let status;
    if (isDialer) status = (key === "hashmi" ? a.crmHashmiAgentId : a.crmIndiaVoiceDeskphone) ? "Mapped" : "Unmapped";
    else status = !configured ? "Provider setup pending" : connected.has(String(a._id)) ? "Connected" : "Awaiting agent connection";
    return { id: a._id, name: a.fullName, status };
  });
}

async function entries(channel, agentId, { day, page }) {
  channelKey(channel);
  const skip = pageOffset(page), agent = asId(agentId), kind = dialers[channel];
  let records;
  if (kind) {
    const { start, end } = dubaiDay(day);
    records = await Call.find({ agent, kind, occurredAt: { $gte: start, $lt: end } })
      .select("lead occurredAt connected talkSeconds providerCallId +recordingUrl").sort({ occurredAt: -1, _id: -1 }).skip(skip).limit(limit + 1).lean();
  } else {
    records = await Thread.find({ agent, channel, peer: { $type: "string" } })
      .select("lead updatedAt").sort({ updatedAt: -1, _id: -1 }).skip(skip).limit(limit + 1).lean();
  }
  const hasMore = records.length > limit;
  records = records.slice(0, limit);
  const leads = await Lead.find({ _id: { $in: records.map(row => row.lead).filter(Boolean) } }).select("name contactName leadId phone").lean();
  const names = new Map(leads.map(l => [String(l._id), l.name || l.contactName || l.phone || l.leadId]));
  return { hasMore, rows: records.map(row => ({
    id: row._id, label: names.get(String(row.lead)) || row.providerCallId || "Client", at: row.occurredAt || row.updatedAt,
    ...(kind ? { connected: row.connected, talkSeconds: row.talkSeconds,
      playable: Boolean(row.connected && (kind === "hashmi" ? row.providerCallId : recordingUrl(kind, row.recordingUrl))) } : {}),
  })) };
}

async function messages(channel, agent, id, page) {
  channelKey(channel);
  if (dialers[channel]) throw new CrmError(400, "Choose a messaging channel.");
  if (!await Thread.exists({ _id: asId(id), agent: asId(agent), channel, peer: { $type: "string" } })) throw new CrmError(404, "Conversation not found.");
  const rows = await Message.find({ thread: asId(id), superseded: { $ne: true } }).select("text at state outbound").sort({ at: -1, _id: -1 }).skip(pageOffset(page)).limit(limit + 1).lean();
  return { hasMore: rows.length > limit, rows: rows.slice(0, limit).reverse() };
}

function mediaFromReport(value) {
  if (typeof value === "string") return recordingUrl("hashmi", value);
  if (value && typeof value === "object") {
    for (const part of Object.values(value)) {
      const found = mediaFromReport(part);
      if (found) return found;
    }
  }
  return null;
}

async function play(channel, agent, id, res) {
  const kind = dialers[channelKey(channel)];
  if (!kind) throw new CrmError(400, "Choose a dialer.");
  const call = await Call.findOne({ _id: asId(id), agent: asId(agent), kind, connected: true })
    .select("providerCallId +recordingUrl").lean();
  if (!call) throw new CrmError(404, "Connected call not found.");
  let media = recordingUrl(kind, call.recordingUrl);
  if (kind === "hashmi" && call.providerCallId) {
    const { token, userId } = hashmiSettings();
    if (!token || !userId) throw new CrmError(503, "Hashmi connection is unavailable.");
    const { data } = await axios.post("https://v4-api.deepcall.com/api/v2/CallReport/detail",
      { userId, token, clId: call.providerCallId, rType: "rcrd" }, { timeout: 10000, maxRedirects: 0, maxContentLength: 512000 });
    if (data?.status === "error") throw new CrmError(502, "Hashmi could not authorize recording access.");
    media = mediaFromReport(data?.data);
  }
  if (!media) throw new CrmError(404, "The dialer has not supplied a playable recording.");
  const upstream = await axios.get(media, { responseType: "stream", timeout: 20000, maxRedirects: 0 });
  const contentType = String(upstream.headers["content-type"] || "").split(";")[0];
  if ((!/^audio\//.test(contentType) && !["application/octet-stream", "binary/octet-stream", "application/x-wav"].includes(contentType)) ||
      Number(upstream.headers["content-length"]) > maxAudio) {
    upstream.data.destroy();
    throw new CrmError(502, "The dialer did not return a playable audio file.");
  }
  res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    "Content-Type": new URL(media).pathname.toLowerCase().endsWith(".wav") ? "audio/wav" : "audio/mpeg" });
  let size = 0;
  await pipeline(upstream.data, new Transform({ transform(chunk, _, done) {
    size += chunk.length;
    done(size > maxAudio ? new Error("Recording exceeds size limit") : null, chunk);
  } }), res);
}

module.exports = { roster, entries, messages, play, recordingUrl, mediaFromReport };
