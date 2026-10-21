function createController(service = require("../services/blogAutomation.service")) {
  return {
    async get(_req, res, next) {
      try { res.set("Cache-Control", "no-store"); res.json({ success: true, data: await service.status() }); } catch (error) { next(error); }
    },
    async update(req, res, next) {
      if (typeof req.body?.enabled !== "boolean" || Object.keys(req.body).some(key => key !== "enabled")) return res.status(400).json({ success: false, error: "Choose whether automatic publishing is enabled." });
      try { res.set("Cache-Control", "no-store"); res.json({ success: true, data: await service.setEnabled(req.body.enabled) }); } catch (error) { next(error); }
    },
  };
}
module.exports = { createController };
