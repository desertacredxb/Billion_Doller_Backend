const { randomUUID } = require("node:crypto");
const Call = require("../models/CrmCall");
const Lead = require("../models/CrmLead");
const Staff = require("../models/AdminAccount");
const { normalizePhone } = require("../utils/registrationIdentity");
const { CrmError, staffFilter, hashmiAgentPattern, ensureCrmIndexes } = require("./crm.service");
const { settings } = require("./crmHashmi.service");

const OUTBOUND = new Set(["Quick Call", "Click To Call"]);
const ATTEMPTED = new Set(["Both Answered", "Cust. Failed - Agent Ans.", "Cust. Unans - Agent Ans.",
  "From Ans. - To Unans.", "From Ans. - To Failed", "Cust. Ans. - Agent Unans.", "Cust. Ans - Agent Failed"]);
const AGENT_ONLY = new Set(["Agent Unanswered", "Agent Failed", "From Unanswered", "From Failed"]);
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const field = value => typeof value === "string" ? value.trim() : "";

function exportTime(date, time, offset) {
  const match = field(date).match(/^(\d{1,2})\/([a-z]{3})\/(\d{4})$/i);
  const clock = field(time).match(/^(\d{1,2}):([0-5]\d):([0-5]\d)\s*(am|pm)$/i);
  if (!match || !clock || Number(clock[1]) < 1 || Number(clock[1]) > 12) return null;
  const month = MONTHS.indexOf(match[2].toLowerCase()) + 1;
  if (!month) return null;
  const pad = value => String(value).padStart(2, "0");
  const day = `${match[3]}-${pad(month)}-${pad(match[1])}`;
  const hour = Number(clock[1]) % 12 + (clock[4].toLowerCase() === "pm" ? 12 : 0);
  const at = new Date(`${day}T${pad(hour)}:${clock[2]}:${clock[3]}${offset}`);
  if (!Number.isFinite(+at) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return null;
  return at;
}

function duration(value) {
  const parts = field(value).match(/^(\d{1,2}):([0-5]\d):([0-5]\d)$/);
  return parts ? Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3]) : null;
}

function exportRow(row, agents, offset) {
  if (!OUTBOUND.has(field(row?.type))) return { skipped: true };
  const ids = [...new Set((Array.isArray(row.agents) ? row.agents : []).filter(id => typeof id === "string" && hashmiAgentPattern.test(id)))];
  const agent = ids.length === 1 && agents.get(ids[0]);
  if (!agent) return { error: "Use a report row for one mapped BDFX caller." };
  const callId = field(row.callId);
  if (!/^[a-z\d_-]{1,120}$/i.test(callId)) return { error: "Hashmi call ID is missing or invalid." };
  const national = field(row.phone);
  const phone = normalizePhone(/^\d{10}$/.test(national) ? "+91" + national : national);
  if (!phone) return { error: "Caller number is missing or invalid." };
  const occurredAt = exportTime(row.date, row.time, offset);
  if (!occurredAt) return { error: "Hashmi call date or time is invalid." };
  const status = field(row.status);
  if (status && !ATTEMPTED.has(status) && !AGENT_ONLY.has(status)) return { error: "Hashmi call status is not recognized." };
  const connected = status === "Both Answered";
  const talkSeconds = connected ? duration(row.talkDuration) : 0;
  if (talkSeconds === null) return { error: "Hashmi talk duration is invalid." };
  return { callId, phone, agent, occurredAt, status, attempted: ATTEMPTED.has(status), connected, talkSeconds };
}

async function importHashmiRows(rows, { staff = Staff, leads = Lead, calls = Call, ensureIndexes = ensureCrmIndexes,
  account = settings(), now = () => new Date() } = {}) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 100) throw new CrmError(400, "Upload up to 100 Hashmi report rows per request.");
  const offset = /^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(account.offset) ? account.offset : "+05:30";
  const staffRows = await staff.find({ ...staffFilter, crmHashmiAgentId: hashmiAgentPattern }).select("_id crmHashmiAgentId").lean();
  const agents = new Map(staffRows.map(item => [item.crmHashmiAgentId, item._id]));
  const summary = { added: 0, updated: 0, existing: 0, leadsAdded: 0, skipped: 0, rejected: [] };
  const records = new Map();
  for (const [index, row] of rows.entries()) {
    const line = Number.isSafeInteger(row?.row) && row.row > 0 ? row.row : index + 2;
    const parsed = exportRow(row, agents, offset);
    if (parsed.error) summary.rejected.push({ row: line, reason: parsed.error });
    else if (parsed.skipped) summary.skipped++;
    else if (records.has(parsed.callId)) summary.existing++;
    else records.set(parsed.callId, { ...parsed, line });
  }
  if (!records.size) return summary;

  await Promise.all([ensureIndexes(leads), ensureIndexes(calls)]);
  const eventKeys = [...records.keys()].map(id => "hashmi:" + id);
  const history = await calls.find({ eventKey: { $in: eventKeys } })
    .select("eventKey agent lead attempted connected talkSeconds hashmiExportStatus").lean();
  const known = new Map(history.map(item => [item.eventKey, item]));
  const valid = [];
  for (const record of records.values()) {
    const eventKey = "hashmi:" + record.callId;
    const previous = known.get(eventKey);
    if (previous && String(previous.agent) !== String(record.agent)) {
      summary.rejected.push({ row: record.line, reason: "This Hashmi call is credited to another CRM caller." });
    } else valid.push({ ...record, eventKey, previous });
  }
  if (!valid.length) return summary;

  const phones = [...new Set(valid.map(item => item.phone))];
  const at = now();
  const leadResult = await leads.bulkWrite(phones.map(phone => ({ updateOne: {
    filter: { phone }, update: { $setOnInsert: { phone, leadId: "BDFX-" + randomUUID(), source: "Hashmi call history",
      status: "new", assignedTo: null, assignmentPending: false, createdAt: at, updatedAt: at } }, upsert: true, timestamps: false,
  } })), { ordered: false });
  summary.leadsAdded = leadResult.upsertedCount;
  const leadRows = await leads.find({ phone: { $in: phones } }).select("_id phone").lean();
  const leadByPhone = new Map(leadRows.map(item => [item.phone, item._id]));

  const writes = valid.flatMap(record => {
    const { eventKey, agent, callId, occurredAt, previous, status, phone } = record;
    const lead = leadByPhone.get(phone);
    if (!lead) throw new Error("Hashmi contact could not be resolved");
    const attempted = status ? record.attempted : Boolean(previous?.attempted);
    const connected = status ? record.connected : Boolean(previous?.connected);
    const talkSeconds = status ? record.talkSeconds : (previous?.talkSeconds || 0);
    const exportStatus = status || previous?.hashmiExportStatus || "";
    if (previous && String(previous.lead) === String(lead) && (previous.hashmiExportStatus || "") === exportStatus &&
        previous.attempted === attempted && previous.connected === connected && previous.talkSeconds === talkSeconds) {
      summary.existing++;
      return [];
    }
    return [{ updateOne: { filter: { eventKey, agent }, upsert: true, update: {
      $setOnInsert: { eventKey, kind: "hashmi", agent, occurredAt, providerCallId: callId },
      $set: { lead, attempted, connected, talkSeconds, ...(status ? { hashmiExportStatus: status } : {}) },
    } } }];
  });
  if (writes.length) {
    const result = await calls.bulkWrite(writes, { ordered: false });
    summary.added = result.upsertedCount;
    summary.updated = result.modifiedCount;
    summary.existing += writes.length - summary.added - summary.updated;
  }
  return summary;
}

module.exports = { importHashmiRows, exportRow };
