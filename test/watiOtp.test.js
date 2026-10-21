const test = require("node:test");
const assert = require("node:assert/strict");
const { createSender, isConfigured } = require("../utils/sendWhatsAppOTP");
const env = { WHATSAPP_OTP_PROVIDER: "wati", WATI_API_TOKEN: "synthetic-token", WATI_TENANT_ID: "358063", WATI_CHANNEL_NUMBER: "441157911131", WATI_OTP_TEMPLATE_NAME: "bdfx_registration_otp" };
test("WATI OTP routes only the approved BDFX tenant/channel and redacts responses", async () => {
  let calls = [];
  const sender = createSender({ env, http: { post: async (...args) => { calls.push(args); return { status: 200, data: { result: true, private: "hidden" } }; } } });
  assert.deepEqual(await sender("+12025550123", "123456"), { success: true });
  const [url, body, options] = calls[0];
  assert.equal(url, "https://live-mt-server.wati.io/358063/api/v1/sendTemplateMessage");
  assert.equal(body.channel_number, "441157911131");
  assert.deepEqual(body.parameters, [{ name: "1", value: "123456" }]);
  assert.equal(options.params.whatsappNumber, "12025550123");
  assert.equal(options.maxRedirects, 0);
  assert.equal(isConfigured({ ...env, WATI_CHANNEL_NUMBER: "other" }), false);
  assert.equal(isConfigured({ ...env, WATI_TENANT_ID: "other" }), false);
  assert.equal(isConfigured({ ...env, WATI_API_TOKEN: "" }), false);
  assert.equal(isConfigured({ ...env, WHATSAPP_OTP_PROVIDER: "unknown" }), false);
  assert.deepEqual(await sender("+12025550123", "bad"), { success: false });
  assert.equal(calls.length, 1);
});
test("WATI rejection, ambiguous response and transport failure never verify delivery", async () => {
  for (const response of [{ status: 200, data: { result: false } }, { status: 200, data: {} }, { status: 403, data: { result: true } }]) {
    assert.deepEqual(await createSender({ env, http: { post: async () => response } })("+12025550123", "123456"), { success: false });
  }
  assert.deepEqual(await createSender({ env, http: { post: async () => { throw Error("private provider error"); } } })("+12025550123", "123456"), { success: false });
});
