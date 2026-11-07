const axios = require("axios");

const TEMPLATE = "bdfx_registration_otp";
const PROFILES = Object.freeze({
  "441157911131": Object.freeze({ channel: "441157911131", waba: "1072739535734104", staged: false }),
  "12363059090": Object.freeze({ channel: "12363059090", waba: "1446367963604978", staged: true }),
});

function profileFor(env = process.env) {
  if (env.WHATSAPP_OTP_PROVIDER !== "wati" || env.WATI_TENANT_ID !== "358063"
    || env.WATI_OTP_TEMPLATE_NAME !== TEMPLATE
    || typeof env.WATI_API_TOKEN !== "string" || !env.WATI_API_TOKEN.trim()) return null;
  return Object.hasOwn(PROFILES, env.WATI_CHANNEL_NUMBER) ? PROFILES[env.WATI_CHANNEL_NUMBER] : null;
}

function releaseEnabled(profile, env = process.env) {
  return !!profile && (!profile.staged || env.WATI_PLUS1236_OTP_ENABLED === "true");
}

// This is a read-only check: it never sends an OTP, creates a template, or changes an account.
async function inspectWatiReadiness({ http = axios, env = process.env } = {}) {
  const profile = profileFor(env);
  const state = { configurationValid: !!profile, sender: profile?.channel || null, template: TEMPLATE,
    releaseEnabled: releaseEnabled(profile, env), senderVerified: false, templateStatus: "NOT_CHECKED",
    templateVerified: false, readyForActivation: false, canSend: false };
  if (!profile) return { ...state, blocker: "CONFIGURATION_MISSING_OR_UNSUPPORTED" };
  const options = { timeout: 12000, maxRedirects: 0, maxContentLength: 262144,
    headers: { Authorization: `Bearer ${env.WATI_API_TOKEN.trim()}` } };
  try {
    const phones = await http.get("https://live-mt-server.wati.io/358063/api/v2/whatsapp/phoneNumbers", options);
    if (phones.status !== 200 || !Array.isArray(phones.data)) return { ...state, blocker: "SENDER_INVENTORY_UNAVAILABLE" };
    const matches = phones.data.filter(p => String(p.phoneNumber || "").replace(/\D/g, "") === profile.channel);
    if (matches.length !== 1 || matches[0].enabled !== true
      || String(matches[0].wabaContextId || matches[0].wabaId) !== profile.waba) {
      return { ...state, blocker: "EXACT_SENDER_NOT_ENABLED" };
    }
    state.senderVerified = true;
    const response = await http.get("https://live-mt-server.wati.io/api/ext/v3/messageTemplates", {
      ...options, params: { page_number: 1, page_size: 100, channel: profile.channel },
    });
    if (response.status !== 200 || !Array.isArray(response.data?.templates)) {
      return { ...state, blocker: "TEMPLATE_INVENTORY_UNAVAILABLE" };
    }
    const templates = response.data.templates.filter(t => t.name === TEMPLATE && t.language_option?.value === "en");
    if (templates.length !== 1) return { ...state, templateStatus: "MISSING_OR_AMBIGUOUS", blocker: "EXACT_TEMPLATE_UNAVAILABLE" };
    const template = templates[0];
    const status = String(template.status || "UNKNOWN").toUpperCase();
    state.templateStatus = ["APPROVED", "DRAFT", "PENDING", "REJECTED", "PAUSED", "DISABLED", "DELETED"].includes(status) ? status : "UNKNOWN";
    if (state.templateStatus !== "APPROVED") return { ...state, blocker: "TEMPLATE_NOT_APPROVED" };
    const params = template.custom_params, buttons = template.buttons;
    if (template.category !== "AUTHENTICATION" || template.buttons_type !== "otp"
      || template.include_expiry_time !== true || Number(template.expires_in) !== 5
      || template.add_security_recommendation !== true
      || !Array.isArray(params) || params.length !== 1 || params[0].name !== "1"
      || !Array.isArray(buttons) || buttons.length !== 1 || buttons[0].type !== "copy_code"
      || String(template.body || "").replace(/\s+/g, " ").trim()
        !== "{{1}} is your verification code. For your security, do not share this code.") {
      return { ...state, blocker: "AUTHENTICATION_TEMPLATE_CONTRACT_MISMATCH" };
    }
    return { ...state, templateVerified: true, readyForActivation: true,
      canSend: state.releaseEnabled, blocker: state.releaseEnabled ? null : "RELEASE_DISABLED" };
  } catch {
    // Provider errors can contain the bearer token or private account metadata.
    return { ...state, blocker: "WATI_READ_UNAVAILABLE" };
  }
}

module.exports = { profileFor, releaseEnabled, inspectWatiReadiness };
