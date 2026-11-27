const test = require("node:test");
const assert = require("node:assert/strict");
const { transfer } = require("../services/crmIbWallet.service");
const { randomUUID } = require("node:crypto");
const valid = { accountNo: "12345", amount: "10.00", requestId: randomUUID() };
const agent = { adminRole: "manager", permissions: ["crm"], id: "111111111111111111111111" };

test("financial actions require a CRM agent and positive cent-precision amount", async () => {
  for (const principal of [{ adminRole: "owner" }, { adminRole: "manager", permissions: ["crm_view"] }]) {
    await assert.rejects(transfer(principal, valid), { status: 403 });
  }
  for (const input of [{ ...valid, amount: "-1" }, { ...valid, amount: "0" }, { ...valid, amount: "1.001" },
    { ...valid, accountNo: "other-account" }, { ...valid, requestId: "not-a-transfer" }]) {
    await assert.rejects(transfer(agent, input), { status: 400 });
  }
});
