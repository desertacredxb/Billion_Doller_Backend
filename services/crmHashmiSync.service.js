const axios = require("axios");
const Call = require("../models/CrmCall");
const Staff = require("../models/AdminAccount");
const { dubaiDay, staffFilter, hashmiAgentPattern } = require("./crm.service");
const { settings, parseReport, recordVerifiedCall } = require("./crmHashmi.service");

const REPORTS = "https://v4-api.deepcall.com/api/v2/CallReport/";
const INTERVAL_MS = 30_000;
const PAGE_SIZE = 100;
const DETAIL_CONCURRENCY = 4;
const MAX_PAGES = 200;
const CALL_ID = /^[a-z\d_-]{1,120}$/i;
const STATUS_BY_LABEL = new Map([
  ["both answered", 3], ["cust. ans. - agent unans.", 4], ["cust. unans - agent ans.", 6],
  ["agent unanswered", 7], ["agent failed", 13], ["cust. failed - agent ans.", 14], ["agent busy", 17],
]);

function providerTime(date, offset) {
  const minutes = Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4));
  return new Date(+date + (offset[0] === "-" ? -1 : 1) * minutes * 60_000).toISOString().slice(0, 19).replace("T", " ");
}

function callId(row) {
  const id = row?.callId ?? row?.clId ?? row?.cId ?? row?.id;
  return typeof id === "string" && CALL_ID.test(id) ? id : null;
}

function callTime(value) {
  const number = typeof value === "string" && /^\d{10}(?:\d{3})?$/.test(value) ? Number(value) : value;
  if (Number.isSafeInteger(number) && number >= 1_000_000_000 && number <= 4_000_000_000) return new Date(number * 1000).toISOString();
  if (Number.isSafeInteger(number) && number >= 1_000_000_000_000 && number <= 4_000_000_000_000) return new Date(number).toISOString();
  return value;
}

function rawDetail(response) {
  const data = response?.data ?? response;
  return Array.isArray(data) && data.length === 1 ? data[0] : data;
}

function statusCode(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const code = typeof value === "number" || /^\d{1,2}$/.test(text) ? Number(value) : STATUS_BY_LABEL.get(text.toLowerCase());
  return Number.isInteger(code) && code >= 1 && code <= 21 ? code : undefined;
}

function seconds(value) {
  if (typeof value === "string" && /^\d{1,2}:[0-5]\d:[0-5]\d$/.test(value)) {
    const [hours, minutes, seconds] = value.split(":").map(Number);
    return hours * 3600 + minutes * 60 + seconds;
  }
  if (typeof value === "string" && /^\d{1,5}$/.test(value)) value = Number(value);
  return Number.isFinite(value) && value >= 0 && value <= 86_400 ? Math.floor(value) : undefined;
}

function agentId(value) {
  if (typeof value === "object" && value !== null) return agentId(value.agentId ?? value.aId ?? value.id);
  const text = String(value ?? "");
  return hashmiAgentPattern.test(text) ? text : text.match(/^#([1-9]\d{0,11})(?:\s|$)/)?.[1];
}

function rawReport(response, row, id, config) {
  const raw = rawDetail(response);
  if (!raw || typeof raw !== "object" || callId(raw) !== id || typeof raw.cType !== "string") return undefined;
  if (!["CTC", "QC"].includes(raw.cType)) return null;
  const status = statusCode(raw.callStatus) ?? statusCode(row.st);
  if (status === undefined) return undefined;
  const reportedAgent = agentId(raw.masterAgent) || agentId(raw.mAgent) || agentId(row.mAgt);
  const history = Array.isArray(raw.aH) ? [...new Set(raw.aH.map(agentId).filter(Boolean))] : [];
  const masterAgent = reportedAgent || (history.length === 1 ? history[0] : undefined);
  const customer = String(raw.cNumber ?? "").replace(/^\+/, "");
  const customerLegs = (Array.isArray(raw.nHDetail) ? raw.nHDetail : [])
    .filter(item => customer && String(item?.number ?? "").replace(/^\+/, "") === customer);
  const singleTalkTime = customerLegs.length === 1 ? seconds(customerLegs[0].talkDuration) : undefined;
  const listedTalkTime = Array.isArray(row.tkTmDurAr) && row.tkTmDurAr.length === 1 ? row.tkTmDurAr[0] : row.tkTmDurAr;
  const talkDuration = seconds(raw.talkDuration) ?? singleTalkTime ?? seconds(listedTalkTime);
  const timeCandidates = [raw.ivrSTime, row.clSTm, raw.startTime, row.tm, raw.clickTime, raw.insertTime];
  for (const value of timeCandidates) {
    const report = parseReport({ ...raw, callId: id, masterAgent, callStatus: status, ivrSTime: callTime(value),
      custAnswerSTime: callTime(raw.custAnswerSTime), talkDuration }, config);
    if (!report?.agentIds.length) continue;
    if (status === 3) return talkDuration === undefined ? undefined : { ...report, attempted: true, connected: true, talkSeconds: talkDuration };
    return report;
  }
  return undefined;
}

function describeFields(value) {
  const item = Array.isArray(value) ? value[0] : value;
  return item && typeof item === "object" ? Object.keys(item)
    .filter(key => /^[a-zA-Z][a-zA-Z_0-9]{0,39}$/.test(key)).slice(0, 100).join(",") : "none";
}

function describeValue(value) {
  if (Array.isArray(value)) return `array(${value.length}) ${describeFields(value)}`;
  return value && typeof value === "object" ? `object ${describeFields(value)}` : typeof value;
}

function createHashmiSync({ request = axios.post, config = settings, staff = Staff, calls = Call, save = recordVerifiedCall,
  now = () => new Date(), logger = console } = {}) {
  let running = false;
  let window;
  let checked = new Set();
  let loggedScope;
  let loggedFormat = false;

  async function vendor(endpoint, payload, account) {
    const response = await request(REPORTS + endpoint, { userId: account.userId, token: account.token, ...payload }, {
      timeout: 7_000, maxRedirects: 0, maxContentLength: 2 * 1024 * 1024,
    });
    if (response.data?.status === "error") {
      const error = new Error("Hashmi rejected the report request");
      error.providerCode = Number(response.data.code);
      throw error;
    }
    return response.data;
  }

  async function tick() {
    if (running) return;
    const account = config();
    if (!account.userId || !account.token || account.mode !== "live") return;
    account.offset = /^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(account.offset) ? account.offset : "+05:30";
    running = true;
    try {
      const at = now();
      const { day, start } = dubaiDay(undefined, at);
      const agents = await staff.find({ ...staffFilter, crmHashmiAgentId: hashmiAgentPattern }).select("_id crmHashmiAgentId").lean();
      const byId = new Map(agents.map(agent => [agent.crmHashmiAgentId, agent]));
      if (!byId.size) return;
      const agentIds = [...byId.keys()].sort();
      const scope = day + ":" + agentIds.join(",");
      if (!window || window.scope !== scope) {
        checked = new Set();
        window = { scope, end: at, page: 0 };
      }
      const since = new Date(+start - 15 * 60_000);
      const response = await vendor("list", {
        filter: { agtIds: agentIds, dtGte: providerTime(since, account.offset), dtLte: providerTime(window.end, account.offset) },
        sz: PAGE_SIZE, page: window.page, rcrdPg: false,
      }, account);
      if (!Array.isArray(response?.data)) throw new Error("Hashmi report list shape is unsupported");
      const rows = response.data;
      const byCall = new Map(rows.map(row => [callId(row), row]).filter(([id]) => id));
      const ids = [...byCall.keys()];
      if (rows.length && !ids.length) {
        logger.warn("CRM Hashmi report has no recognized call IDs. Row fields:", describeFields(rows));
        return;
      }
      const pending = ids.filter(id => !checked.has(id));
      const existing = pending.length ? await calls.distinct("providerCallId", { kind: "hashmi", providerCallId: { $in: pending } }) : [];
      for (const id of existing) checked.add(id);
      const queue = pending.filter(id => !checked.has(id));
      let saved = 0;
      let unrecognized = 0;
      for (let index = 0; index < queue.length; index += DETAIL_CONCURRENCY) {
        const results = await Promise.allSettled(queue.slice(index, index + DETAIL_CONCURRENCY).map(async id => {
          const detail = await vendor("detail", { clId: id, rType: "allDetail" }, account);
          const row = byCall.get(id);
          const report = rawReport(detail, row, id, account);
          if (report === undefined) {
            unrecognized++;
            if (!loggedFormat) {
              loggedFormat = true;
              const raw = rawDetail(detail);
              logger.warn("CRM Hashmi call detail format:", "status", describeValue(row.st), statusCode(row.st) ?? "unknown",
                "master agent", describeValue(raw?.mAgent), describeValue(row.mAgt), "start", describeValue(raw?.startTime),
                describeValue(row.clSTm), describeValue(row.tm), "talk time", describeValue(row.tkTmDurAr),
                "number legs", describeValue(raw?.nHDetail));
            }
            return;
          }
          const agent = report?.agentIds.length === 1 && byId.get(report.agentIds[0]);
          if (agent && report.attempted && +report.occurredAt >= +since && +report.occurredAt <= +at) {
            if (await save(report, agent)) saved++;
          }
          checked.add(id);
        }));
        const failure = results.find(result => result.status === "rejected");
        if (failure) throw failure.reason;
      }
      if (saved || loggedScope !== scope) {
        logger.log("CRM Hashmi report synced:", saved, "new verified calls from", rows.length, "scoped report rows;", unrecognized, "unrecognized.");
        loggedScope = scope;
      }
      if (rows.length < PAGE_SIZE || window.page + 1 >= MAX_PAGES) {
        window = { scope, end: at, page: 0 };
      } else {
        window.page++;
      }
    } catch (error) {
      const code = error.providerCode || error.response?.status;
      logger.warn("CRM Hashmi report unavailable:", Number.isInteger(code) ? code : "request or report format");
    } finally {
      running = false;
    }
  }

  function start() {
    void tick();
    const timer = setInterval(tick, INTERVAL_MS);
    timer.unref();
    return timer;
  }

  return { tick, start };
}

module.exports = { ...createHashmiSync(), createHashmiSync };
