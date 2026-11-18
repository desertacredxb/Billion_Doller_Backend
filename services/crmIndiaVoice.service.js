const { timingSafeEqual } = require("node:crypto");
const axios = require("axios");
const Staff = require("../models/AdminAccount");
const Lead = require("../models/CrmLead");
const Call = require("../models/CrmCall");
const { CrmError, asId, staffFilter, ensureCrmIndexes } = require("./crm.service");
const { normalizePhone } = require("../utils/registrationIdentity");
const { indiaVoiceConfigured } = require("./crmIndiaVoiceConfig");

const endpoint = "https://indiavoice.rpdigitalphone.com/api_v3/click_to_call_v2";
const deskphonePattern = /^\*?\d{2,16}$/;
const callIdPattern = /^[a-z\d_.-]{1,120}$/i;

async function setAgent(id, input, staff = Staff) {
  const filter = { ...staffFilter, _id: asId(id) };
  if (typeof input?.deskphone !== "string" || typeof input.agentNumber !== "string") {
    throw new CrmError(400, "Enter the 9ance deskphone and the agent's calling number.");
  }
  const deskphone = input.deskphone.trim();
  const number = input.agentNumber.trim();
  const clear = !deskphone && !number;
  const phone = normalizePhone(number);
  if (!clear && (!deskphonePattern.test(deskphone) || !number.startsWith("+") || !phone)) {
    throw new CrmError(400, "Use the assigned deskphone and an agent number with country code.");
  }
  if (!clear) {
    await Promise.all(["crmIndiaVoiceDeskphone", "crmIndiaVoiceAgentNumber"].map(field =>
      staff.collection.createIndex({ [field]: 1 }, { unique: true, sparse: true })));
    filter.crmHashmiAgentId = null;
  }
  const update = clear ? { $unset: { crmIndiaVoiceDeskphone: "", crmIndiaVoiceAgentNumber: "" } }
    : { $set: { crmIndiaVoiceDeskphone: deskphone, crmIndiaVoiceAgentNumber: phone } };
  try {
    const result = await staff.updateOne(filter, update, { runValidators: true });
    if (!result.matchedCount) {
      if (!clear && await staff.exists({ ...staffFilter, _id: filter._id, crmHashmiAgentId: { $type: "string" } })) {
        throw new CrmError(409, "This agent is assigned to Hashmi. Clear that mapping before switching dialers.");
      }
      throw new CrmError(404, "Active CRM agent not found.");
    }
  } catch (error) {
    if (error.code === 11000) throw new CrmError(409, "That deskphone or calling number belongs to another CRM agent.");
    throw error;
  }
}

async function requestCall(phone, agent, get = axios.get, env = process.env) {
  const params = {
    calling_party_a: agent.crmIndiaVoiceAgentNumber.replace(/^\+/, ""),
    calling_party_b: phone.replace(/^\+/, ""),
    deskphone: agent.crmIndiaVoiceDeskphone,
    call_from_did: 1, waittime: 30,
  };
  if (env.BDFX_INDIAVOICE_UID?.trim()) params.uid = env.BDFX_INDIAVOICE_UID.trim();
  const { data } = await get(endpoint, {
    params, auth: { username: env.BDFX_INDIAVOICE_API_USERNAME.trim(), password: env.BDFX_INDIAVOICE_API_PASSWORD },
    timeout: 10000, maxRedirects: 0, headers: { Accept: "application/json" },
  });
  if (data?.success === false || ["failed", "error", "rejected"].includes(data?.status)) return { state: "rejected" };
  if (data?.success === true || data?.status === "success") {
    const sid = data.CallSid || data.callid;
    return { state: "accepted", ...(typeof sid === "string" && callIdPattern.test(sid) ? { callId: sid } : {}) };
  }
  return { state: "unconfirmed" };
}

function reportAuthorized(provided, expected = process.env.BDFX_INDIAVOICE_REPORT_KEY) {
  if (typeof expected !== "string" || expected.length < 32 || typeof provided !== "string") return false;
  const actual = Buffer.from(provided);
  const key = Buffer.from(expected);
  return actual.length === key.length && timingSafeEqual(actual, key);
}

// IndiaVoice call timestamps without an offset are local to the provider account.
function reportDate(value, offset) {
  if (typeof value !== "string") return null;
  let iso = value.trim().replace(" ", "T");
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?$/.test(iso)) return null;
  if (!/(?:Z|[+-]\d\d:\d\d)$/.test(iso)) {
    if (!/^[+-]\d\d:\d\d$/.test(offset || "")) return null;
    iso += offset;
  }
  const date = new Date(iso);
  return Number.isFinite(+date) ? date : null;
}

function reportPhone(value) {
  if (typeof value !== "string" || !/^[+\d ()-]{7,24}$/.test(value)) return null;
  const digits = value.replace(/\D/g, "");
  if (value.startsWith("+")) return normalizePhone(value);
  if (digits.startsWith("00")) return normalizePhone("+" + digits.slice(2));
  if (/^0?[6-9]\d{9}$/.test(digits)) return normalizePhone("+91" + digits.slice(-10));
  return normalizePhone("+" + digits);
}

async function recordReport(payload, offset = process.env.BDFX_INDIAVOICE_REPORT_UTC_OFFSET) {
  if (payload?.type !== "call_report" || typeof payload.CallSid !== "string" || !callIdPattern.test(payload.CallSid)) return false;
  const occurredAt = reportDate(payload.StartTime, offset);
  const agentPhone = reportPhone(payload.SourceNumber);
  const clientPhone = reportPhone(payload.DestinationNumber);
  const end = reportDate(payload.EndTime, offset);
  if (!occurredAt || !end || end < occurredAt || !agentPhone || !clientPhone || agentPhone === clientPhone) return false;
  const agent = await Staff.findOne({ ...staffFilter, crmIndiaVoiceAgentNumber: agentPhone }).select("_id").lean();
  if (!agent) return false;
  // Require evidence that the customer leg started. Ringing the agent alone is not an attempt.
  const customerStart = reportDate(payload.LegB_Start_time, offset);
  const pickedUp = reportDate(payload.LegB_Picked_time, offset);
  if ((!customerStart && !pickedUp) || (customerStart && (customerStart < occurredAt || customerStart > end)) ||
      (pickedUp && (pickedUp < (customerStart || occurredAt) || pickedUp > end))) return false;
  const lead = await Lead.findOne({ assignedTo: agent._id, phone: clientPhone, assignedAt: { $lte: occurredAt } }).select("_id").lean();
  if (!lead) return false;
  const seconds = pickedUp ? Math.floor((end - pickedUp) / 1000) : 0;
  const reported = /^\d+$/.test(String(payload.TalkDuration ?? "")) ? Number(payload.TalkDuration) : seconds;
  const eventKey = "indiavoice:" + payload.CallSid;
  await ensureCrmIndexes(Call);
  try {
    await Call.updateOne({ eventKey, agent: agent._id, lead: lead._id }, { $setOnInsert: {
      eventKey, kind: "indiavoice", providerCallId: payload.CallSid, agent: agent._id, lead: lead._id,
      attempted: true, connected: Boolean(pickedUp), talkSeconds: pickedUp ? Math.min(seconds, reported) : 0, occurredAt,
    } }, { upsert: true });
  } catch (err) { if (err.code === 11000) return false; throw err; }
  await Lead.updateOne({ _id: lead._id, assignedTo: agent._id, status: "new" }, { $set: { status: "worked" } });
  return true;
}

module.exports = { setAgent, requestCall, recordReport, reportAuthorized, configured: indiaVoiceConfigured };
