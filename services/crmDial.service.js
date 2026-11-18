const Lead = require("../models/CrmLead");
const Staff = require("../models/AdminAccount");
const hashmi = require("./crmHashmi.service");
const indiaVoice = require("./crmIndiaVoice.service");
const { CrmError, asId, assertRequestId, staffFilter, hashmiAgentPattern: agentPattern, contactable } = require("./crm.service");

async function dial(principal, leadId, key, request) {
  assertRequestId(key);
  const id = asId(leadId);
  const assignedTo = asId(principal.id);
  const agent = await Staff.findOne({ ...staffFilter, _id: assignedTo }).select("crmHashmiAgentId crmIndiaVoiceDeskphone crmIndiaVoiceAgentNumber").lean();
  const provider = agent?.crmIndiaVoiceDeskphone && !agent.crmHashmiAgentId ? "9ance" : "hashmi";
  const config = hashmi.settings();
  const mode = provider === "9ance" ? "live" : config.mode;
  if (provider === "9ance") {
    if (!indiaVoice.configured() || !agent.crmIndiaVoiceAgentNumber) throw new CrmError(503, "9ance calling is awaiting provider setup.");
  } else {
    if (!config.userId || !config.token) throw new CrmError(503, "Hashmi API access is not configured.");
    if (!agentPattern.test(agent?.crmHashmiAgentId || "")) throw new CrmError(400, "Ask the owner to map your dialer account.");
  }
  const now = new Date();
  const lead = await Lead.findOneAndUpdate({
    _id: id, assignedTo, status: { $ne: "closed" }, ...contactable, "dialRequest.key": { $ne: key },
    $or: [
      { "dialRequest.state": { $ne: "pending" } },
      { "dialRequest.startedAt": { $lt: new Date(+now - 45_000) } },
    ],
  }, { $set: { dialRequest: { key, state: "pending", startedAt: now, provider } } }, { new: true }).lean();
  if (!lead) {
    const current = await Lead.findOne({ _id: id, assignedTo }).select("dialRequest status lastOutcome").lean();
    if (!current) throw new CrmError(404, "Assigned lead not found.");
    if (current.lastOutcome === "do_not_call") throw new CrmError(409, "This lead is marked Do not call back.");
    if (current.status === "closed") throw new CrmError(409, "This lead is closed.");
    if (current.dialRequest?.key === key) return { state: current.dialRequest.state, mode, provider: current.dialRequest.provider || "hashmi" };
    throw new CrmError(409, "A call request is already in progress for this lead.");
  }
  let state = "unconfirmed";
  let callId;
  try {
    const result = provider === "9ance"
      ? await indiaVoice.requestCall(lead.phone, agent)
      : await hashmi.requestHashmiCall(lead.phone, agent.crmHashmiAgentId, config, request);
    state = result.state;
    callId = result.callId;
  } catch {
    // A timed-out response may have initiated a call. Never resend it automatically.
  }
  await Lead.updateOne({ _id: id, assignedTo, "dialRequest.key": key }, {
    $set: { "dialRequest.state": state, ...(callId ? { "dialRequest.callId": callId } : {}) },
  });
  return { state, mode, provider };
}

module.exports = { dial };
