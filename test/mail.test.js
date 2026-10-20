const test = require("node:test");
const assert = require("node:assert/strict");
const { mailConfig } = require("../utils/mailConfig");
const { createMailer } = require("../utils/sendEmail");
const env = { EMAIL_USER: "sender@example.invalid", EMAIL_PASS: "mock-password" };
test("mail uses the authenticated sender by default and never disables TLS certificate verification", () => {
  const config = mailConfig(env);
  assert.equal(config.from.address, env.EMAIL_USER); assert.equal(config.transport.service, "gmail"); assert.equal(config.transport.tls, undefined);
  const smtp = mailConfig({ ...env, SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587", SMTP_FROM: "verified@example.invalid" });
  assert.equal(smtp.transport.requireTLS, true); assert.equal(smtp.transport.secure, false); assert.equal(smtp.from.address, "verified@example.invalid");
  assert.equal(mailConfig({ ...env, SMTP_HOST: "smtp.example.invalid" }).transport.secure, true);
  for (const patch of [{ EMAIL_USER: "bad" }, { EMAIL_FROM: "x\r\nBcc: other@example.invalid" }, { SMTP_HOST: "bad/host" }, { SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "NaN" }]) assert.throws(() => mailConfig({ ...env, ...patch }));
});
test("mail errors fail OTP callers safely without logging message content or provider secrets", async () => {
  const logs = [];
  const send = createMailer({ env, mail: { createTransport: () => ({ sendMail: async () => { throw new Error("private provider response"); } }) }, logger: { info: value => logs.push(value), error: value => logs.push(value) } });
  await assert.rejects(send({ subject: "OTP", text: "private OTP", throwOnError: true }), /Email delivery failed/);
  assert.equal(logs.join(" ").includes("private"), false);
});
