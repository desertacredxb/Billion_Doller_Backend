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

function rawReport(response, id, config) {
  const raw = rawDetail(response);
  if (!raw || typeof raw !== "object" || callId(raw) !== id || typeof raw.cType !== "string") return undefined;
  if (!["CTC", "QC"].includes(raw.cType)) return null;
  const masterAgent = raw.masterAgent ?? (typeof raw.mAgent === "object" ? raw.mAgent?.agentId ?? raw.mAgent?.id : raw.mAgent);
  const time = callTime(raw.ivrSTime ?? raw.startTime ?? raw.clickTime);
  const status = Number(raw.callStatus);
  if (!Number.isInteger(status) || status < 1 || status > 21) return undefined;
  const report = parseReport({ ...raw, callId: id, masterAgent, ivrSTime: time, custAnswerSTime: callTime(raw.custAnswerSTime) }, config);
  if (!report?.agentIds.length) return undefined;
  return report;
}

function describeFields(value) {
  const item = Array.isArray(value) ? value[0] : value;
  return item && typeof item === "object" ? Object.keys(item)
    .filter(key => /^[a-zA-Z][a-zA-Z_0-9]{0,39}$/.test(key)).slice(0, 100).join(",") : "none";
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
      const ids = [...new Set(rows.map(callId).filter(Boolean))];
      if (rows.length && !ids.length) {
        logger.warn("CRM Hashmi report has no recognized call IDs. Row fields:", describeFields(rows));
        return;
      }
      const pending = ids.filter(id => !checked.has(id));
      const existing = pending.length ? await calls.distinct("providerCallId", { kind: "hashmi", providerCallId: { $in: pending } }) : [];
      for (const id of existing) checked.add(id);
      const queue = pending.filter(id => !checked.has(id));
      let saved = 0;
      for (let index = 0; index < queue.length; index += DETAIL_CONCURRENCY) {
        const results = await Promise.allSettled(queue.slice(index, index + DETAIL_CONCURRENCY).map(async id => {
          const detail = await vendor("detail", { clId: id, rType: "allDetail" }, account);
          const report = rawReport(detail, id, account);
          if (report === undefined) {
            if (!loggedFormat) {
              loggedFormat = true;
              const raw = rawDetail(detail);
              logger.warn("CRM Hashmi call details are not recognized. Fields:", describeFields(raw),
                "Master agent fields:", describeFields(raw?.mAgent), "Call list fields:", describeFields(rows),
                "Start time type:", typeof raw?.startTime, "Call status type:", typeof raw?.callStatus);
            }
            throw new Error("Hashmi call detail shape is unsupported");
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
        logger.log("CRM Hashmi report synced:", saved, "new verified calls from", rows.length, "scoped report rows.");
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
