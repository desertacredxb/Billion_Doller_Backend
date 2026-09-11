// One-off backfill: populate User.referredByIB for users who already have a
// referralCode string but no referredByIB link (i.e. they registered before
// that field existed). Can only recover the link where the code still
// resolves to a live IB record - a referral code that was later revoked
// (rejected-after-approval) has been unset from the IB document and is
// unrecoverable by this script; those users keep referralCode for display
// but referredByIB stays null.
//
// Usage: node scripts/backfillReferredByIB.js
require("dotenv").config();
const connectDB = require("../config/db");
const mongoose = require("mongoose");
const User = require("../models/User");
const IB = require("../models/Broker.model");

async function run() {
  await connectDB();

  const users = await User.find({
    referralCode: { $exists: true, $ne: "" },
    referredByIB: null,
  });

  console.log(`Found ${users.length} users with a referralCode but no referredByIB link.`);

  let linked = 0;
  let unresolved = 0;

  for (const user of users) {
    const ib = await IB.findOne({ referralCode: user.referralCode });
    if (ib) {
      user.referredByIB = ib._id;
      await user.save();
      linked++;
    } else {
      unresolved++;
      console.warn(
        `⚠️ Could not resolve referralCode "${user.referralCode}" for ${user.email} - code no longer exists on any IB record (likely revoked).`
      );
    }
  }

  console.log(`Done. Linked: ${linked}, unresolved: ${unresolved}.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
