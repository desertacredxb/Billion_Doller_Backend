const crypto = require("node:crypto");
const axios = require("axios");

const isEnabled = () => process.env.VERIFF_ENABLED === "true";

function isVeriffUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      (!url.port || url.port === "443") &&
      ["veriff.com", "veriff.me"].some(host =>
        url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function getConfig() {
  const apiKey = process.env.VERIFF_API_KEY;
  const sharedSecret = process.env.VERIFF_SHARED_SECRET;
  const baseUrl = process.env.VERIFF_BASE_URL;
  const callbackUrl = process.env.VERIFF_CALLBACK_URL;
  const mode = process.env.VERIFF_MODE;
  const webhookType = process.env.VERIFF_WEBHOOK_TYPE || "decision";
  let validCallback = false;
  try {
    const callback = new URL(callbackUrl);
    validCallback = callback.protocol === "https:" && !callback.username && !callback.password;
  } catch { /* Configuration is incomplete. */ }
  if (!isEnabled() || !apiKey || !sharedSecret || !isVeriffUrl(baseUrl) ||
      !validCallback || !["test", "live"].includes(mode) ||
      !["decision", "fullauto"].includes(webhookType)) {
    const error = new Error("Identity verification is not configured. Please contact support.");
    error.status = 503;
    throw error;
  }
  const base = new URL(baseUrl);
  if (base.search || base.hash || !["/", "", "/v1", "/v1/"].includes(base.pathname)) {
    const error = new Error("Identity verification is not configured. Please contact support.");
    error.status = 503;
    throw error;
  }
  return {
    apiKey, sharedSecret, callbackUrl, mode, webhookType,
    apiUrl: `${base.origin}/v1/sessions`,
    keyHash: crypto.createHash("sha256").update(apiKey).digest("hex"),
  };
}

function constantEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authenticateWebhook(rawBody, headers, config) {
  if (!Buffer.isBuffer(rawBody) ||
      !constantEqual(headers["x-auth-client"], config.apiKey) ||
      typeof headers["x-hmac-signature"] !== "string" ||
      !/^[a-f0-9]{64}$/i.test(headers["x-hmac-signature"])) return false;
  const expected = crypto.createHmac("sha256", config.sharedSecret).update(rawBody).digest("hex");
  return constantEqual(expected, headers["x-hmac-signature"].toLowerCase());
}

async function createSession(reference, config) {
  // Opaque correlation only. Documents/selfie are collected in Veriff's hosted flow.
  const body = JSON.stringify({ verification: { callback: config.callbackUrl, vendorData: reference } });
  const response = await axios.post(config.apiUrl, body, {
    headers: {
      "Content-Type": "application/json",
      "X-AUTH-CLIENT": config.apiKey,
      "X-HMAC-SIGNATURE": crypto.createHmac("sha256", config.sharedSecret).update(body).digest("hex"),
    },
    timeout: 15000,
    maxRedirects: 0,
    maxContentLength: 64 * 1024,
  });
  const verification = response.data?.verification;
  if (response.data?.status !== "success" || !verification?.id ||
      verification.vendorData !== reference || !isVeriffUrl(verification.url)) {
    throw new Error("Invalid verification session response");
  }
  return { id: verification.id, url: verification.url };
}

async function fetchDecision(sessionId, reference, config) {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId || "")) throw Error("Invalid verification session");
  const response = await axios.get(`${config.apiUrl}/${sessionId}/decision`, {
    headers: { "Content-Type": "application/json", "X-AUTH-CLIENT": config.apiKey,
      "X-HMAC-SIGNATURE": crypto.createHmac("sha256", config.sharedSecret).update(sessionId).digest("hex") },
    responseType: "text", transformResponse: [value => value], timeout: 10000, maxRedirects: 0, maxContentLength: 256 * 1024,
  });
  if (!authenticateWebhook(Buffer.from(response.data), response.headers, config)) throw Error("Invalid decision signature");
  const payload = JSON.parse(response.data), decision = payload.verification;
  if (payload.status === "success" && decision === null) return null;
  if (payload.status !== "success" || !decision || decision.id !== sessionId || decision.vendorData !== reference) throw Error("Decision mismatch");
  return payload;
}

async function getDecision(sessionId, reference, config) {
  const payload = await fetchDecision(sessionId, reference, config);
  if (!payload) return null;
  const decision = require("../utils/veriffPolicy").normalizeDecision(payload, "decision");
  if (!decision) throw Error("Invalid verification decision");
  return decision;
}

async function getDecisionReason(sessionId, reference, config) {
  const payload = await fetchDecision(sessionId, reference, config);
  if (!payload) return null;
  const decision = payload.verification;
  return { status: decision.status, reasonCode: require("../utils/veriffReasons").reasonCode(decision.reasonCode) };
}

module.exports = { isEnabled, getConfig, isVeriffUrl, authenticateWebhook, createSession, getDecision, getDecisionReason };
