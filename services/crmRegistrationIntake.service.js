const User = require("../models/User");
const Account = require("../models/account.model");
const { normalizePhone } = require("../utils/registrationIdentity");
const { isUae } = require("../utils/veriffPolicy");
const { syncRegisteredLeads, distribute } = require("./crm.service");

const INTERVAL_MS = 60_000;
const BATCH_SIZE = 100;
const liveClientAccount = { accountType: "LIVE", userType: { $ne: "ADMIN" } };

function registrationLead(user) {
  const locations = [user.residenceCountry, user.country, user.nationality];
  if (locations.some(isUae) || typeof user.phone !== "string") return null;
  const compact = user.phone.trim().replace(/[\s().-]/g, "");
  const isIndia = locations.some(value => typeof value === "string" && /^(IN|IND|India)$/i.test(value.trim()));
  const nationalMobile = isIndia && /^0?[6-9]\d{9}$/.test(compact);
  const phone = normalizePhone(nationalMobile ? "+91" + compact.slice(-10) : user.phone);
  const registeredAt = user.phoneVerifiedAt || user.emailVerifiedAt || user.createdAt;
  if (!phone || phone.startsWith("+971") || !(registeredAt instanceof Date) || !Number.isFinite(+registeredAt)) return null;
  return { userId: user._id, name: user.fullName, phone, registeredAt };
}

function createIntake({ users = User, accounts = Account, save = syncRegisteredLeads, assign = distribute,
  now = () => new Date(), logger = console } = {}) {
  let checkedAt;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    const startedAt = now();
    try {
      const filter = { isVerified: true };
      if (checkedAt) {
        // Replay overlapping writes so activation and account opening cannot fall between passes.
        const since = new Date(+checkedAt - 2 * INTERVAL_MS);
        const opened = await accounts.distinct("user", { ...liveClientAccount, createdAt: { $gte: since } });
        filter.$or = [{ updatedAt: { $gte: since } }, { _id: { $in: opened } }];
      }
      const cursor = users.find(filter).select("_id fullName phone phoneVerifiedAt emailVerifiedAt createdAt nationality country residenceCountry")
        .lean().cursor({ batchSize: BATCH_SIZE });
      let batch = [];
      let imported = 0;
      async function flush() {
        const opened = new Set((await accounts.distinct("user", {
          ...liveClientAccount, user: { $in: batch.map(lead => lead.userId) },
        })).map(String));
        imported += await save(batch.map(lead => ({ ...lead, accountOpened: opened.has(String(lead.userId)) })));
        batch = [];
      }
      for await (const user of cursor) {
        const lead = registrationLead(user);
        if (!lead) continue;
        batch.push(lead);
        if (batch.length === BATCH_SIZE) await flush();
      }
      if (batch.length) await flush();
      const firstPass = !checkedAt;
      checkedAt = startedAt;
      const result = await assign();
      if (firstPass || imported) logger.log("CRM registration intake completed:", imported, "new leads,", result.assigned, "assigned.");
    } catch (error) {
      logger.error("CRM registration intake failed:", error.name || "Error", Number.isInteger(error.code) ? error.code : "");
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

module.exports = { ...createIntake(), createIntake };
