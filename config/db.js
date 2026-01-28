// const mongoose = require("mongoose");
// require("dotenv").config();

// const connect = () => {
//   const MongoURL = process.env.MONGO_URI;
//   const DB = process.env.DB;

//   mongoose
//     .connect(`${MongoURL}/${DB}`, {})
//     .then(() => console.log("🚀 DataBase Connected"))
//     .catch((reason) => {
//       console.log(`💩 Unable to connect to DataBase \n${reason}`);
//     });
// };

// module.exports = { connect };

const mongoose = require("mongoose");
require("dotenv").config();

mongoose.set("bufferCommands", false); // 🚀 prevents 10s buffering

const connectDB = async () => {
  try {
    await mongoose.connect(`${process.env.MONGO_URI}/${process.env.DB}`, {
      serverSelectionTimeoutMS: 5000,
    });

    console.log("✅ MongoDB Connected");
  } catch (error) {
    console.error("❌ MongoDB connection failed:", error);
    process.exit(1); // stop app if DB fails
  }
};

module.exports = connectDB;
