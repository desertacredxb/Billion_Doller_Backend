const dns = require("dns");
// Force Node to use public DNS instead of the broken localhost resolver
dns.setServers(["1.1.1.1", "8.8.8.8"]);
console.log("DNS Servers:", dns.getServers());

const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const connect = require("./config/db");
const authRoutes = require("./routes/authRoutes");
const brokerRoutes = require("./routes/brokerRoutes");
const moneyplantRoutes = require("./routes/moneyplant.routes");
const ticketRoutes = require("./routes/ticketRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const IBRoutes = require("./routes/IBRoutes");
const mt5Routes = require("./routes/mt5Routes");
const dealRoutes = require("./routes/dealRoutes");
const aiRoutes = require("./routes/ai.routes");
const veriffRoutes = require("./routes/veriffRoutes");
const enquiryRoutes = require("./routes/enquiryRoutes");
const blogRoutes = require("./routes/blogRoutes");
const enquiryNotifications = require("./services/enquiryNotifications.service");
const { checkOnStartup } = require("./services/veriffReadiness.service");

const startServer = async () => {
  await connect(); // ⛔ BLOCK until Mongo connects
  await checkOnStartup();
  enquiryNotifications.start();

  const app = express();
  app.set("trust proxy", 1);

  app.use(cors());
  app.use("/api/veriff", veriffRoutes);
  app.use("/api/blogs", blogRoutes);
  app.use(express.json());

  app.get("/check-ip", async (req, res) => {
    try {
      const { data: ip } = await axios.get("https://api.ipify.org");
      res.send({ ip });
    } catch (e) {
      res.status(500).send({ error: e.message });
    }
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/brokers", brokerRoutes);
  app.use("/api/moneyplant", moneyplantRoutes);
  app.use("/api/mt5", mt5Routes);
  app.use("/api/deals", dealRoutes);
  app.use("/api/tickets", ticketRoutes);
  app.use("/api/payment", paymentRoutes);
  app.use("/api/ib", IBRoutes);
  app.use("/api/ai", aiRoutes);
  app.use("/api/enquiries", enquiryRoutes);

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error("Request failed:", error.name || "Error");
    const status = error.type === "entity.too.large" ? 413 : error.type === "entity.parse.failed" ? 400 : 500;
    res.status(status).json({ message: status === 413 ? "This request is too large." : status === 400 ? "Enter valid request details." : "Unable to complete this request. Please try again shortly." });
  });

  app.get("/", (req, res) => {
    res.send("I ..I...AM ...IRONMAN🫰");
  });

  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
};

startServer();
