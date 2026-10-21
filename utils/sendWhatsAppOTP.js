const axios = require("axios");

function configuration(env = process.env) {
  return {
    token: env.TELEOBI_API_TOKEN,
    numberId: env.TELEOBI_PHONE_NUMBER_ID || env.TELEOBO_NUMBER_ID,
    // An old hard-coded template does not establish approval for this business.
    templateId: env.TELEOBI_OTP_TEMPLATE_ID,
  };
}
function isConfigured(env = process.env) {
  return Object.values(configuration(env)).every(value => typeof value === "string" && value.trim());
}
function createSender({ http = axios, env = process.env } = {}) {
  return async (phone, code) => {
    if (!isConfigured(env) || !/^\+[1-9]\d{6,14}$/.test(phone) || !/^\d{6}$/.test(code)) return { success: false };
    const config = configuration(env);
    const payload = new URLSearchParams({ apiToken: config.token, phone_number_id: config.numberId,
      template_id: config.templateId, phone_number: phone.slice(1), "templateVariable-OTP-1": code });
    try {
      const response = await http.post("https://dash.teleobi.com/api/v1/whatsapp/send/template", payload.toString(), {
        timeout: 12000, maxRedirects: 0, maxContentLength: 32768,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      return { success: response.status >= 200 && response.status < 300 && response.data?.success === true };
    } catch { return { success: false }; }
  };
}
module.exports = Object.assign(createSender(), { isConfigured, createSender });
