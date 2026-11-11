const express = require("express");
const auth = require("../middleware/authMiddleware");
const access = require("../middleware/accessControl");
const crm = require("../services/crm.service");
const hashmi = require("../services/crmHashmi.service");

const router = express.Router();

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

router.use(auth, access.principal, access.admin);

router.get("/overview", run(async (req, res) => {
  const report = await crm.overview(req.principal, req.query.day);
  res.json({ ...report, ...hashmi.connectionState() });
}));
router.get("/leads", run(async (req, res) => {
  const read = req.query.view === "clients" ? crm.listClients : crm.listLeads;
  res.json(await read(req.principal, req.query));
}));
router.get("/leads/:id/history", run(async (req, res) => res.json(await crm.history(req.principal, req.params.id))));

router.post("/import", access.owner, run(async (req, res) => {
  const summary = await crm.importLeads(req.body?.rows);
  req.auditEvent = "crm:import";
  req.auditDetails = { imported: summary.imported, duplicate: summary.duplicates, rejected: summary.rejected.length };
  res.json(summary);
}));
router.post("/import/outcomes", access.owner, run(async (req, res) => {
  const summary = await crm.importOutcomes(req.body?.rows);
  req.auditEvent = "crm:import-outcomes";
  req.auditDetails = { imported: summary.imported, duplicate: summary.duplicates, rejected: summary.rejected.length };
  res.json(summary);
}));
router.post("/distribute", run(async (req, res) => {
  const result = await crm.distribute();
  res.json(req.principal.adminRole === "owner" ? result : { ready: true });
}));
router.patch("/team/:id/hashmi", access.owner, run(async (req, res) => {
  await hashmi.setAgent(req.params.id, req.body?.hashmiId);
  req.auditEvent = "crm:hashmi-agent-mapped";
  res.json({ saved: true });
}));
router.post("/leads/:id/outcome", run(async (req, res) => {
  const result = await crm.recordOutcome(req.principal, req.params.id, req.body);
  const distribution = await crm.distribute();
  res.json({ ...result, refreshQueue: !distribution.busy });
}));
router.post("/leads/:id/dial", run(async (req, res) => {
  res.json(await hashmi.dial(req.principal, req.params.id, req.body?.requestId));
}));

module.exports = router;
