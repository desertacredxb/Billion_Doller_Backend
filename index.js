const express = require("express");
const dotenv = require("dotenv");
const { connect } = require("./config/db");
const authRoutes = require("./routes/authRoutes");
const brokerRoutes = require("./routes/brokerRoutes");
const cors = require("cors");
const moneyplantRoutes = require("./routes/moneyplant.routes");
const ticketRoutes = require("./routes/ticketRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const IBRoutes = require("./routes/IBRoutes");
const axios = require("axios");

require("dotenv").config();
connect();

const app = express();

app.use(cors());
app.use(express.json());
app.use("/api/auth", authRoutes);
app.use("/api/brokers", brokerRoutes);
app.use("/api/moneyplant", moneyplantRoutes);
app.use("/api/tickets", ticketRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/ib", IBRoutes);

app.use("/", (req, res) => {
  res.send("I ..I...AM ...IRONMAN🫰");
});

app.get("/check-ip", async (req, res) => {
  try {
    const { data: ip } = await axios.get("https://api.ipify.org");
    res.send({ ip });
  } catch (e) {
    res.status(500).send({ error: e.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
