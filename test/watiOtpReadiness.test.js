const test = require("node:test");
const assert = require("node:assert/strict");
const { createSender, isConfigured, inspectWatiReadiness } = require("../utils/sendWhatsAppOTP");

const baseEnv = { WHATSAPP_OTP_PROVIDER: "wati", WATI_API_TOKEN: "synthetic-not-live",
  WATI_TENANT_ID: "358063", WATI_CHANNEL_NUMBER: "12363059090", WATI_OTP_TEMPLATE_NAME: "bdfx_registration_otp" };
const enabledEnv = () => ({ ...baseEnv, WATI_PLUS1236_OTP_ENABLED: "true" });
const approvedTemplate = () => ({ name: "bdfx_registration_otp", language_option: { value: "en" },
  category: "AUTHENTICATION", status: "approved", buttons_type: "otp", expires_in: 5,
  include_expiry_time: true, add_security_recommendation: true, custom_params: [{ name: "1", value: "123456" }],
  body: "{{1}} is your verification code. For your security, do not share this code.", buttons: [{ type: "copy_code" }] });

function fixture({ phones, templates = [approvedTemplate()], phoneStatus = 200, templateStatus = 200,
  postResponse = { status: 200, data: { result: true, private: "must not escape" } } } = {}) {
  const calls = [];
  return { calls, http: {
    get: async (url, options) => {
      calls.push({ method: "GET", url, options });
      if (url.endsWith("/phoneNumbers")) return { status: phoneStatus, data: phones || [
        { phoneNumber: "441157911131", wabaId: "1072739535734104", enabled: true },
        { phoneNumber: "1236-305-9090", wabaContextId: "1446367963604978", enabled: true },
      ] };
      return { status: templateStatus, data: { templates } };
    },
    post: async (url, body, options) => { calls.push({ method: "POST", url, body, options }); return postResponse; },
  } };
}

test("+1236 is opt-in only; unsupported sender, tenant or template never causes I/O", async () => {
  for (const env of [baseEnv, { ...baseEnv, WATI_PLUS1236_OTP_ENABLED: "TRUE" },
    { ...enabledEnv(), WATI_CHANNEL_NUMBER: "other" }, { ...enabledEnv(), WATI_CHANNEL_NUMBER: "constructor" },
    { ...enabledEnv(), WATI_TENANT_ID: "other" }, { ...enabledEnv(), WATI_OTP_TEMPLATE_NAME: "accounts_combined_report_v2" },
    { ...enabledEnv(), WATI_API_TOKEN: " " }]) {
    const f = fixture();
    assert.equal(isConfigured(env), false);
    assert.deepEqual(await createSender({ env, http: f.http })("+12025550123", "123456"), { success: false });
    assert.equal(f.calls.length, 0);
  }
});

test("read-only preflight checks exact sender and template without enabling or sending", async () => {
  const f = fixture();
  const result = await inspectWatiReadiness({ env: baseEnv, http: f.http });
  assert.deepEqual(result, { configurationValid: true, sender: "12363059090", template: "bdfx_registration_otp",
    releaseEnabled: false, senderVerified: true, templateStatus: "APPROVED", templateVerified: true,
    readyForActivation: true, canSend: false, blocker: "RELEASE_DISABLED" });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].options.params, { page_number: 1, page_size: 100, channel: "12363059090" });
  for (const call of f.calls) {
    assert.equal(call.method, "GET");
    assert.equal(call.options.maxRedirects, 0);
    assert.equal(call.options.timeout, 12000);
    assert.equal(call.options.headers.Authorization, "Bearer synthetic-not-live");
  }
  assert.equal(JSON.stringify(result).includes(baseEnv.WATI_API_TOKEN), false);
});

test("a default-account approval cannot unlock a disabled, missing, duplicate or wrong-WABA +1236 sender", async () => {
  const phone = { phoneNumber: "12363059090", wabaContextId: "1446367963604978", enabled: true };
  for (const phones of [[{ phoneNumber: "441157911131", wabaId: "1072739535734104", enabled: true }],
    [{ ...phone, enabled: false }], [{ ...phone, wabaContextId: "1072739535734104" }], [phone, phone]]) {
    const f = fixture({ phones });
    assert.deepEqual(await createSender({ env: enabledEnv(), http: f.http })("+12025550123", "123456"), { success: false });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].method, "GET");
  }
});

test("Draft, Pending, rejected, paused, disabled and unknown templates never send an OTP", async () => {
  for (const status of ["draft", "pending", "rejected", "paused", "disabled", "deleted", "unexpected-private-value"]) {
    const f = fixture({ templates: [{ ...approvedTemplate(), status }] });
    const result = await inspectWatiReadiness({ env: enabledEnv(), http: f.http });
    assert.equal(result.canSend, false);
    assert.equal(result.blocker, "TEMPLATE_NOT_APPROVED");
    assert.equal(result.templateStatus, status === "unexpected-private-value" ? "UNKNOWN" : status.toUpperCase());
    assert.deepEqual(await createSender({ env: enabledEnv(), http: f.http })("+12025550123", "123456"), { success: false });
    assert.equal(f.calls.filter(c => c.method === "POST").length, 0);
  }
});

test("only the exact English five-minute Authentication copy-code contract is eligible", async () => {
  for (const patch of [{ name: "another_template" }, { language_option: { value: "hi" } },
    { category: "UTILITY" }, { expires_in: 15 }, { include_expiry_time: false },
    { add_security_recommendation: false }, { custom_params: [] }, { custom_params: [{ name: "otp" }] },
    { buttons_type: "none" }, { buttons: [{ type: "quick_reply" }] }, { buttons: [] }, { body: "Unrelated message" }]) {
    const f = fixture({ templates: [{ ...approvedTemplate(), ...patch }] });
    assert.deepEqual(await createSender({ env: enabledEnv(), http: f.http })("+12025550123", "123456"), { success: false });
    assert.equal(f.calls.filter(c => c.method === "POST").length, 0);
  }
  for (const templates of [[], [approvedTemplate(), approvedTemplate()]]) {
    const result = await inspectWatiReadiness({ env: enabledEnv(), http: fixture({ templates }).http });
    assert.equal(result.blocker, "EXACT_TEMPLATE_UNAVAILABLE");
  }
});

test("enabled and freshly approved +1236 routing sends one OTP to only the registered phone", async () => {
  const f = fixture(), sender = createSender({ env: enabledEnv(), http: f.http });
  assert.deepEqual(await sender("+12025550123", "123456"), { success: true });
  assert.deepEqual(f.calls.map(c => c.method), ["GET", "GET", "POST"]);
  const call = f.calls[2];
  assert.equal(call.url, "https://live-mt-server.wati.io/358063/api/v1/sendTemplateMessage");
  assert.deepEqual(call.body, { template_name: "bdfx_registration_otp", broadcast_name: "bdfx_registration_otp",
    channel_number: "12363059090", parameters: [{ name: "1", value: "123456" }] });
  assert.deepEqual(call.options.params, { whatsappNumber: "12025550123" });
  assert.equal(call.options.maxRedirects, 0);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
  // Provider acceptance is not delivery or phone possession; existing registration code verification remains required.
});

test("approval is read freshly on every send and cannot be cached across a rejection", async () => {
  const template = approvedTemplate(), f = fixture({ templates: [template] });
  const sender = createSender({ env: enabledEnv(), http: f.http });
  assert.deepEqual(await sender("+12025550123", "123456"), { success: true });
  template.status = "rejected";
  assert.deepEqual(await sender("+12025550123", "654321"), { success: false });
  assert.equal(f.calls.filter(c => c.method === "GET").length, 4);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
});

test("unavailable reads and failed/ambiguous send responses stay closed, redacted and never retry", async () => {
  for (const patch of [{ phoneStatus: 403 }, { templateStatus: 401 }, { templateStatus: 429 }]) {
    const f = fixture(patch);
    assert.deepEqual(await createSender({ env: enabledEnv(), http: f.http })("+12025550123", "123456"), { success: false });
    assert.equal(f.calls.filter(c => c.method === "POST").length, 0);
  }
  const readError = { get: async () => { throw Error("private bearer token"); }, post: async () => assert.fail("must not send") };
  const result = await inspectWatiReadiness({ env: enabledEnv(), http: readError });
  assert.equal(result.blocker, "WATI_READ_UNAVAILABLE");
  assert.equal(JSON.stringify(result).includes("private"), false);
  for (const postResponse of [{ status: 200, data: {} }, { status: 200, data: { result: false } },
    { status: 403, data: { result: true } }]) {
    const f = fixture({ postResponse });
    assert.deepEqual(await createSender({ env: enabledEnv(), http: f.http })("+12025550123", "123456"), { success: false });
    assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
  }
});
