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

function createClient({ env = process.env, http = axios } = {}) {
  const baseURL = (env.FLOXY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");

  async function call(method, path, { body, idempotencyKey } = {}) {
    if (!env.FLOXY_API_KEY) throw new FloxyError("Floxy is not configured");
    const headers = { Authorization: `Bearer ${env.FLOXY_API_KEY}`, "Content-Type": "application/json" };
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    try {
      const { data } = await http.request({ method, url: `${baseURL}${path}`, data: body, headers, timeout: 15000 });
      return data;
    } catch (error) {
      // Branch on error.code, never on the message text (guide section 5).
      const status = error.response?.status;
      const code = error.response?.data?.error?.code;
      throw new FloxyError(`Floxy ${method.toUpperCase()} ${path} failed${code ? `: ${code}` : ""}`, { status, code });
    }
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

module.exports = { createClient, verifySignature, isConfigured, FloxyError };
