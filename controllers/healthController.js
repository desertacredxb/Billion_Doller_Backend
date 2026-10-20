function createHealth({ connection, now = () => new Date() }) {
  return (_req, res) => {
    const ready = connection.readyState === 1;
    res.set("Cache-Control", "no-store");
    res.status(ready ? 200 : 503).json({ status: ready ? "ok" : "unavailable", database: ready ? "connected" : "unavailable", checkedAt: now() });
  };
}
module.exports = { createHealth };
