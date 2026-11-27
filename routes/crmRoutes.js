const express = require("express");
const multer = require("multer");
const auth = require("../middleware/authMiddleware");
const access = require("../middleware/accessControl");
const crm = require("../services/crm.service");
const refills = require("../services/crmOutcomeRefill.service");
const referrals = require("../services/crmIbClients.service");
const dialer = require("../services/crmDial.service");
const indiaVoice = require("../services/crmIndiaVoice.service");
const hashmi = require("../services/crmHashmi.service");
const { importHashmiRows } = require("../services/crmHashmiImport.service");
const { AUDIO_LIMIT, createCrmAssistant } = require("../services/crmAssistant.service");

const callPay = require("../services/crmCallPay.service");
const batches = require("../services/crmDistribution.service");
const router = express.Router();
const assistant = createCrmAssistant();
const uploadQuestion = multer({ storage: multer.memoryStorage(), limits: { fileSize: AUDIO_LIMIT, files: 1, fields: 0 } }).single("audio");

const run = handler => async (req, res, next) => {
  try { await handler(req, res); }
  catch (error) {
    if (error instanceof crm.CrmError) return res.status(error.status).json({ message: error.message });
    next(error);
  }
};

router.get("/hashmi/report", run((req, res) => {
  if (!hashmi.authorizedReport(req.query.key)) return res.sendStatus(404);
  res.type("text").send("GODBLESSYOU");
}));

router.post("/hashmi/report", run(async (req, res) => {
  if (!hashmi.authorizedReport(req.query.key)) return res.sendStatus(404);
  await hashmi.recordReport(req.body);
  res.type("text").send("GODBLESSYOU");
}));

const indiaVoiceReport = run(async (req, res) => {
  if (!indiaVoice.reportAuthorized(req.query.key)) return res.sendStatus(404);
  await indiaVoice.recordReport(req.method === "GET" ? req.query : req.body);
  res.sendStatus(200);
});
router.get("/9ance/report", indiaVoiceReport);
router.post("/9ance/report", express.urlencoded({ extended: false, limit: "16kb", parameterLimit: 64 }), indiaVoiceReport);

router.use(auth, access.principal, access.admin);
router.use("/owner/channels", require("./crmOwnerChannels"));
router.use("/inbox", require("./crmInboxRoutes").router);

router.post("/assistant", run(async (req, res) => res.json(await assistant.ask(req.body?.question))));
router.post("/assistant/transcribe", (req, res, next) => uploadQuestion(req, res, error => {
  if (error) return res.status(400).json({ message: "Record a short voice question or type it instead." });
  next();
}), run(async (req, res) => res.json(await assistant.transcribe(req.file))));

router.get("/overview", run(async (req, res) => {
  const report = await crm.overview(req.principal, req.query.day);
  res.json({ ...report, ...hashmi.connectionState() });
}));
router.get("/leads", run(async (req, res) => {
  if (req.query.view === "ib_clients") {
    res.set("Cache-Control", "no-store");
    return res.json(await referrals.listIbClients(req.principal, req.query));
  }
  const read = req.query.view === "clients" ? crm.listClients : crm.listLeads;
  res.json(await read(req.principal, req.query));
}));
router.get("/leads/:id/history", run(async (req, res) => res.json(await crm.history(req.principal, req.params.id))));

router.patch("/leads/:id/name", run(async (req, res) => {
  const result = await crm.renameLead(req.principal, req.params.id, req.body?.name);
  req.auditEvent = "crm:lead-name-edited";
  req.auditDetails = { leadId: req.params.id, changedFields: ["name"] };
  res.json(result);
}));

router.post("/import", access.owner, run(async (req, res) => {
  const summary = await crm.importLeads(req.body?.rows, req.body?.reserve === true);
  req.auditEvent = "crm:import";
  req.auditDetails = { imported: summary.imported, duplicate: summary.duplicates, rejected: summary.rejected.length };
  res.json(summary);
}));

router.patch("/leads/:id/email", run(async (req, res) => {
  const result = await crm.setLeadEmail(req.principal, req.params.id, req.body?.email);
  req.auditEvent = "crm:lead-email-edited";
  req.auditDetails = { leadId: req.params.id, changedFields: ["email"] };
  res.json(result);
}));

router.post("/import/emails", access.owner, run(async (req, res) => {
  const result = await crm.importLeadEmails(req.body?.rows);
  req.auditEvent = "crm:email-import";
  req.auditDetails = { emailsAdded: result.emailsAdded, rejected: result.rejected.length };
  res.json(result);
}));
router.post("/import/outcomes", access.owner, run(async (req, res) => {
  const summary = await crm.importOutcomes(req.body?.rows);
  req.auditEvent = "crm:import-outcomes";
  req.auditDetails = { imported: summary.imported, duplicate: summary.duplicates, rejected: summary.rejected.length };
  res.json(summary);
}));
router.post("/import/hashmi", access.owner, run(async (req, res) => {
  const summary = await importHashmiRows(req.body?.rows);
  req.auditEvent = "crm:import-hashmi";
  req.auditDetails = { added: summary.added, updated: summary.updated, leadsAdded: summary.leadsAdded, rejected: summary.rejected.length };
  res.json(summary);
}));
router.post("/attendance/session", run(async (req, res) => {
  if (req.principal.adminRole !== "manager" || !req.principal.permissions?.includes("crm")) throw new crm.CrmError(403, "CRM agent access required.");
  await require("../services/crmAttendance.service").checkIn(req.principal.id, req.user.version, new Date(req.user.iat * 1000), new Date(req.user.exp * 1000));
  res.json({ checkedIn: true });
}));
router.post("/check-out", run(async (req, res) => {
  if (req.principal.adminRole !== "manager" || !req.principal.permissions?.includes("crm")) throw new crm.CrmError(403, "CRM agent access required.");
  await require("../services/crmAttendance.service").checkOut(req.principal.id, req.user);
  req.auditEvent = "crm:check-out";
  res.json({ checkedOut: true });
}));
router.get("/call-pay/month", access.owner, run(async (req, res) => {
  res.set("Cache-Control", "no-store").json(await callPay.monthly(req.query.month));
}));
router.get("/call-pay", access.owner, run(async (req, res) => {
  res.set("Cache-Control", "no-store").json(await callPay.daily(req.query.day));
}));
router.post("/team/:id/call-pay-rate", access.owner, run(async (req, res) => {
  const result = await callPay.saveRate(req.params.id, req.body);
  req.auditEvent = "crm:daily-pay-rate";
  req.auditDetails = { agent: req.params.id, effectiveFrom: req.body.effectiveFrom };
  res.json(result);
}));
router.get("/distributions/sources", access.owner, run(async (_req, res) => res.json(await batches.sources())));
router.post("/distributions", access.owner, run(async (req, res) => {
  const result = await batches.assign(req.principal, req.body);
  req.auditEvent = "crm:lead-distribution";
  req.auditDetails = { assigned: result.assigned, requested: req.body.quantity };
  res.json(result);
}));
router.post("/distribute", run(async (req, res) => {
  const result = await refills.distributeWithRefills();
  res.json(req.principal.adminRole === "owner" ? result : { ready: true });
}));
router.patch("/team/:id/ib", access.owner, run(async (req, res) => {
  await referrals.linkIb(req.params.id, req.body?.code);
  req.auditEvent = "crm:ib-linked";
  req.auditDetails = { agent: req.params.id };
  res.json({ saved: true });
}));
router.patch("/team/:id/9ance", access.owner, run(async (req, res) => {
  await indiaVoice.setAgent(req.params.id, req.body);
  req.auditEvent = "crm:9ance-agent-mapped";
  req.auditDetails = { agent: req.params.id };
  res.json({ saved: true });
}));
router.patch("/team/:id/hashmi", access.owner, run(async (req, res) => {
  await hashmi.setAgent(req.params.id, req.body?.hashmiId);
  req.auditEvent = "crm:hashmi-agent-mapped";
  res.json({ saved: true });
}));
router.patch("/leads/:id/assignment", access.owner, run(async (req, res) => {
  const result = await crm.transferLead(req.principal, req.params.id, req.body);
  req.auditEvent = "crm:lead-transferred";
  req.auditDetails = { leadId: req.params.id, agent: result.assignedTo };
  res.json(result);
}));
router.patch("/leads/:id/reminder", run(async (req, res) => {
  const result = await crm.setReminder(req.principal, req.params.id, req.body);
  req.auditEvent = "crm:reminder-set";
  req.auditDetails = { leadId: req.params.id };
  res.json(result);
}));
router.post("/leads/:id/outcome", run(async (req, res) => {
  const result = await refills.saveOutcome(req.principal, req.params.id, req.body);
  if (req.body.outcome === "do_not_call") {
    req.auditEvent = "crm:do-not-call";
    req.auditDetails = { leadId: req.params.id };
  }
  res.json(result);
}));
router.post("/leads/:id/dial", run(async (req, res) => {
  res.json(await dialer.dial(req.principal, req.params.id, req.body?.requestId));
}));
router.post("/dial-by-number", run(async (req, res) => {
  const lead = await crm.assignedLeadByPhone(req.principal, req.body?.phone);
  res.json(await dialer.dial(req.principal, lead, req.body?.requestId));
}));

module.exports = router;
