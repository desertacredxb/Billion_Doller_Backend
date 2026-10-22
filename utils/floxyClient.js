// Floxy merchant API client (payment links + read-only lookups) and webhook
// signature verification, per the Floxy Merchant Guide sections 5, 6 and 9.
// Payment-link management and GET calls take plain JSON; only money-moving
// endpoints (payments, payouts, refunds) need the encrypted envelope, which
// deposits via payment links do not use.
const axios = require("axios");
const crypto = require("crypto");

const DEFAULT_BASE_URL = "https://floxymoney.com";
const SIGNATURE_TOLERANCE_SECONDS = 300;
const ID_PATTERN = /^[A-Za-z0-9_]{1,100}$/;

class FloxyError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "FloxyError";
    this.status = status;
    this.code = code;
  }
}

function isConfigured(env = process.env) {
  return Boolean(env.FLOXY_API_KEY && env.FLOXY_WEBHOOK_SECRET);
}

// "Sealed responses" (APIs page setting): every answer arrives as {"data": "<base64>"},
// AES-256-CBC encrypted with the account's Secret Key + Secret IV (both hex).
function sealKeys(env) {
  if (!env.FLOXY_SECRET_KEY || !env.FLOXY_SECRET_IV) return null;
  const key = Buffer.from(env.FLOXY_SECRET_KEY.trim(), "hex");
  const iv = Buffer.from(env.FLOXY_SECRET_IV.trim(), "hex");
  if (key.length !== 32 || iv.length !== 16) {
    throw new FloxyError(`FLOXY_SECRET_KEY must be 64 hex chars and FLOXY_SECRET_IV 32 hex chars (got ${key.length} and ${iv.length} bytes)`);
  }
  return { key, iv };
}

function isSealed(body) {
  return Boolean(body) && typeof body === "object" && !Array.isArray(body) &&
    typeof body.data === "string" && Object.keys(body).length === 1;
}

function unseal(body, env = process.env) {
  if (!isSealed(body)) return body;
  const keys = sealKeys(env);
  if (!keys) throw new FloxyError("Floxy sent a sealed response but FLOXY_SECRET_KEY / FLOXY_SECRET_IV are not set");
  try {
    const decipher = crypto.createDecipheriv("aes-256-cbc", keys.key, keys.iv);
    return JSON.parse(decipher.update(body.data, "base64", "utf8") + decipher.final("utf8"));
  } catch {
    throw new FloxyError("Could not decrypt Floxy's sealed response (check FLOXY_SECRET_KEY / FLOXY_SECRET_IV)");
  }
}

function seal(value, env = process.env) {
  const keys = sealKeys(env);
  if (!keys) throw new FloxyError("FLOXY_SECRET_KEY / FLOXY_SECRET_IV are not set");
  const cipher = crypto.createCipheriv("aes-256-cbc", keys.key, keys.iv);
  return { data: cipher.update(JSON.stringify(value), "utf8", "base64") + cipher.final("base64") };
}

function createClient({ env = process.env, http = axios } = {}) {
  const baseURL = (env.FLOXY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");

  async function call(method, path, { body, idempotencyKey } = {}) {
    if (!env.FLOXY_API_KEY) throw new FloxyError("Floxy is not configured");
    const headers = { Authorization: `Bearer ${env.FLOXY_API_KEY}`, "Content-Type": "application/json" };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    let response;
    try {
      response = await http.request({ method, url: `${baseURL}${path}`, data: body, headers, timeout: 15000 });
    } catch (error) {
      // Branch on error.code, never on the message text (guide section 5).
      // Error bodies may be sealed too; a body we cannot open still yields the status.
      const status = error.response?.status;
      let errorBody = error.response?.data;
      try { errorBody = unseal(errorBody, env); } catch { errorBody = undefined; }
      const code = errorBody?.error?.code;
      throw new FloxyError(`Floxy ${method.toUpperCase()} ${path} failed${code ? `: ${code}` : status ? ` (HTTP ${status})` : ""}`, { status, code });
    }
    return unseal(response.data, env);
  }

  function id(value) {
    if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new FloxyError("Invalid Floxy id");
    return value;
  }

  return {
    createPaymentLink: (body, idempotencyKey) => {
      if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8) throw new FloxyError("Idempotency-Key must be 8+ characters");
      return call("post", "/v1/payment-links", { body, idempotencyKey });
    },
    getPaymentLink: linkId => call("get", `/v1/payment-links/${id(linkId)}`),
    getPayment: paymentId => call("get", `/v1/payments/${id(paymentId)}`),
  };
}

// Floxy-Signature: t=<unix seconds>,v1=<hex>; HMAC-SHA256 over `${t}.${rawBody}`.
function verifySignature(rawBody, header, secret, nowSeconds = Date.now() / 1000) {
  if (!Buffer.isBuffer(rawBody) || typeof header !== "string" || !secret) return false;
  const parts = {};
  for (const piece of header.split(",")) {
    const at = piece.indexOf("=");
    if (at > 0) parts[piece.slice(0, at).trim()] = piece.slice(at + 1).trim();
  }
  if (!/^\d{1,12}$/.test(parts.t || "") || !/^[0-9a-f]{64}$/i.test(parts.v1 || "")) return false;
  if (Math.abs(nowSeconds - Number(parts.t)) >= SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = crypto.createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${parts.t}.`), rawBody]))
    .digest();
  return crypto.timingSafeEqual(expected, Buffer.from(parts.v1, "hex"));
}

module.exports = { createClient, verifySignature, isConfigured, seal, unseal, FloxyError };
