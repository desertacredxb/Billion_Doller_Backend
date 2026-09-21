// Read-only smoke test for the new MT5 deal-history / account-state services
// (utils/MT5/mt5Deals.js). Does NOT touch the database and does NOT change
// any MT5 balance/user data - it only calls AccountGet and DealGetPage
// against a login you already have, to confirm whether the facade at
// MT5_SERVER:1950 actually supports these commands before anything in the
// app depends on them.
//
// Usage:
//   node scripts/testMT5DealServices.js <login> [daysBack]
//
// Example:
//   node scripts/testMT5DealServices.js 100123 30
require("dotenv").config();
const { getMT5Account, getMT5Deals, getMT5DealsTotal } = require("../utils/MT5/mt5Deals");

async function run() {
  const login = process.argv[2];
  const daysBack = Number(process.argv[3]) || 30;

  if (!login) {
    console.error("Usage: node scripts/testMT5DealServices.js <login> [daysBack]");
    process.exit(1);
  }

  const to = Math.floor(Date.now() / 1000);
  const from = to - daysBack * 24 * 60 * 60;

  console.log(`Testing MT5 deal/account services for login=${login}, range=${new Date(from * 1000).toISOString()} -> ${new Date(to * 1000).toISOString()}\n`);

  console.log("--- AccountGet ---");
  try {
    const account = await getMT5Account({ login });
    console.log("OK:", JSON.stringify(account, null, 2));
  } catch (err) {
    console.error("FAILED:", err);
  }

  console.log("\n--- DealGetTotal ---");
  try {
    const total = await getMT5DealsTotal({ login, from, to });
    console.log("OK:", JSON.stringify(total, null, 2));
  } catch (err) {
    console.error("FAILED:", err);
  }

  console.log("\n--- DealGetPage (first 10) ---");
  try {
    const deals = await getMT5Deals({ login, from, to, offset: 0, total: 10 });
    console.log("OK:", JSON.stringify(deals, null, 2));
  } catch (err) {
    console.error("FAILED:", err);
  }

  process.exit(0);
}

run().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
