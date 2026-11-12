const { timingSafeEqual } = require("node:crypto");
const axios = require("axios");
const Lead = require("../models/CrmLead");
const Call = require("../models/CrmCall");
const Staff = require("../models/AdminAccount");
const identity = require("../utils/registrationIdentity");
const { CrmError, asId, assertRequestId, staffFilter } = require("./crm.service");

const CLICK_TO_CALL = "https://v4-api.deepcall.com/api/v3/clickToCall/para";
const agentPattern = /^[1-9]\d{0,11}$/;
const callPattern = /^[a-z\d_-]{1,120}$/i;
const quickCallCustomerLeg = new Set([3, 4, 5, 6, 8, 9, 14, 15, 16, 18, 19]);

function settings(env = process.env) {
  const userId = env.BDFX_HASHMI_USER_ID?.trim() || "";
  const token = env.BDFX_HASHMI_API_TOKEN?.trim() || "";
  const key = env.BDFX_HASHMI_REPORT_KEY || "";
  return {
    userId, token, key,
    offset: env.BDFX_HASHMI_REPORT_UTC_OFFSET || "",
    mode: env.BDFX_HASHMI_MODE === "live" ? "live" : "developer",
  };
}

function connectionState(env = process.env) {
  const config = settings(env);
  return {
    dialerMode: config.userId && config.token ? config.mode : "unconfigured",
    reportEnabled: Boolean(config.userId && config.key.length >= 32),
  };
}

async function setAgent(id, value, { staff = Staff, config = settings() } = {}) {
  if (typeof value !== "string" || (value !== "" && !agentPattern.test(value))) {
    throw new CrmError(400, "Enter the numeric Hashmi agent ID.");
  }
  if (value && value === config.userId) throw new CrmError(400, "Use the employee's Agent ID from Hashmi Employees.");
  const filter = { ...staffFilter, _id: asId(id) };
  if (value) {
    try {
      const indexes = await staff.listIndexes();
      const hasMappingIndex = indexes.some(index => index.unique && index.sparse && index.key?.crmHashmiAgentId === 1 && Object.keys(index.key).length === 1);
      if (!hasMappingIndex) {
        await staff.collection.createIndex({ crmHashmiAgentId: 1 }, { name: "crmHashmiAgentId_1", unique: true, sparse: true });
      }
    } catch (error) {
      console.error("Hashmi mapping index unavailable:", error.name || "Error", Number.isInteger(error.code) ? error.code : "");
      throw new CrmError(503, "Hashmi mapping storage is unavailable. Please try again shortly.");
    }
  }
  const update = value ? { $set: { crmHashmiAgentId: value } } : { $unset: { crmHashmiAgentId: "" } };
  try {
    const updated = await staff.findOneAndUpdate(filter, update, { new: true, runValidators: true }).select("_id").lean();
    if (!updated) throw new CrmError(404, "Active CRM agent not found.");
  } catch (error) {
    if (error.code === 11000) throw new CrmError(409, "That Hashmi agent ID is already mapped.");
    throw error;
  }
}

function buildCallParameters(config, phone, hashmiId) {
  return new URLSearchParams({
    user_id: config.userId, token: config.token, callFirst: "agent",
    customer: phone.replace(/^\+/, ""), agentType: "agent_id", agent_id: hashmiId,
    mode: config.mode,
  });
}

async function dial(principal, leadId, key, request = axios.post) {
  assertRequestId(key);
  const config = settings();
  if (!config.userId || !config.token) throw new CrmError(503, "Hashmi API access is not configured.");
  const id = asId(leadId);
  const assignedTo = asId(principal.id);
  const agent = await Staff.findOne({ ...staffFilter, _id: assignedTo }).select("crmHashmiAgentId").lean();
  if (!agentPattern.test(agent?.crmHashmiAgentId || "")) throw new CrmError(400, "Ask the owner to map your Hashmi agent ID.");
  const now = new Date();
  const lead = await Lead.findOneAndUpdate({
    _id: id, assignedTo, status: { $ne: "closed" }, "dialRequest.key": { $ne: key },
    $or: [
      { "dialRequest.state": { $ne: "pending" } },
      { "dialRequest.startedAt": { $lt: new Date(+now - 45_000) } },
    ],
  }, { $set: { dialRequest: { key, state: "pending", startedAt: now } } }, { new: true }).lean();
  if (!lead) {
    const current = await Lead.findOne({ _id: id, assignedTo }).select("dialRequest status").lean();
    if (!current) throw new CrmError(404, "Assigned lead not found.");
    if (current.status === "closed") throw new CrmError(409, "This lead is closed.");
    if (current.dialRequest?.key === key) return { state: current.dialRequest.state, mode: config.mode };
    throw new CrmError(409, "A Hashmi request is already in progress for this lead.");
  }
  let state = "unconfirmed";
  let callId;
  try {
    const response = await request(CLICK_TO_CALL, buildCallParameters(config, lead.phone, agent.crmHashmiAgentId).toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10_000, maxRedirects: 0,
    });
    if (response.data?.status === "success" && callPattern.test(response.data.callid || "")) {
      callId = response.data.callid;
      state = "accepted";
    } else if (response.data?.status === "error") {
      state = "rejected";
    }
  } catch {
    // A timed-out response may have initiated a call. Never resend it automatically.
  }
  await Lead.updateOne({ _id: id, assignedTo, "dialRequest.key": key }, {
    $set: { "dialRequest.state": state, ...(callId ? { "dialRequest.callId": callId } : {}) },
  });
  return { state, mode: config.mode };
}

function authorizedReport(key, config = settings()) {
  if (!config.userId || config.key.length < 32 || typeof key !== "string") return false;
  const actual = Buffer.from(key);
  const expected = Buffer.from(config.key);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function vendorPhone(value) {
  if (!["string", "number"].includes(typeof value)) return null;
  const number = String(value).trim();
  return identity.normalizePhone(number.startsWith("+") ? number : "+" + number);
}

function reportTime(value, offset) {
  if (typeof value !== "string") return null;
  const time = value.replace(" ", "T");
  const hasOffset = /(?:Z|[+-]\d{2}:\d{2})$/.test(time);
  if (!hasOffset && !/^[+-]\d{2}:\d{2}$/.test(offset)) return null;
  const date = new Date(time + (hasOffset ? "" : offset));
  return Number.isFinite(+date) ? date : null;
}

function parseReport(report, config) {
  if (!config.userId || !report || String(report.userId || "") !== config.userId || !["QC", "CTC"].includes(report.cType) ||
      typeof report.callId !== "string" || !callPattern.test(report.callId)) return null;
  const phone = vendorPhone(report.cNumber);
  const occurredAt = reportTime(report.ivrSTime, config.offset);
  if (!phone || !occurredAt) return null;
  const details = Array.isArray(report.aHDetail) ? report.aHDetail : [];
  const master = String(report.masterAgent || "");
  const agentIds = agentPattern.test(master) ? [master] :
    [...new Set(details.map(item => String(item?.agentId || "")).filter(value => agentPattern.test(value)))];
  const history = Array.isArray(report.nH) ? report.nH : [];
  const customerAnswered = Boolean(reportTime(report.custAnswerSTime, config.offset));
  const status = Number(report.callStatus);
  const attempted = customerAnswered || history.some(value => vendorPhone(value) === phone) ||
    (report.cType === "QC" && quickCallCustomerLeg.has(status));
  const connected = attempted && status === 3;
  const duration = Number(report.talkDuration);
  const talkSeconds = connected && Number.isFinite(duration) ? Math.max(0, Math.floor(duration)) : 0;
  return { callId: report.callId, agentIds, occurredAt, phone, attempted, connected, talkSeconds };
}

async function recordReport(payload) {
  const report = parseReport(payload, settings());
  if (!report?.attempted || report.agentIds.length !== 1) return false;
  const agent = await Staff.findOne({ ...staffFilter, crmHashmiAgentId: report.agentIds[0] }).select("_id").lean();
  if (!agent) return false;
  const lead = await Lead.findOne({ assignedTo: agent._id, phone: report.phone, assignedAt: { $lte: report.occurredAt } }).select("_id").lean();
  const eventKey = "hashmi:" + report.callId;
  await Call.init();
  try {
    await Call.updateOne({ eventKey, agent: agent._id }, {
      $setOnInsert: { kind: "hashmi", agent: agent._id, occurredAt: report.occurredAt, providerCallId: report.callId },
      $set: { ...(lead ? { lead: lead._id } : {}), attempted: true, connected: report.connected, talkSeconds: report.talkSeconds },
    }, { upsert: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
    // A repeated report cannot change the credited agent.
    return false;
  }
  if (lead) {
    await Lead.updateOne({ _id: lead._id, assignedTo: agent._id, status: "new" }, { $set: { status: "worked" } });
  }
  return true;
}

module.exports = { connectionState, setAgent, dial, authorizedReport, recordReport, parseReport, buildCallParameters };
