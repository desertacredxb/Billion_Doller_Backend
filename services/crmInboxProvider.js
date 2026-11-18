const crypto = require("node:crypto");
const { CrmError } = require("./crm.service");
const env = () => process.env;
const graphVersion = () => /^v\d+\.\d+$/.test(env().BDFX_META_GRAPH_VERSION || "") ? env().BDFX_META_GRAPH_VERSION : "v25.0";
function settings() {
  const e = env();
  const telegram = !!(e.BDFX_INBOX_BOT_TOKEN && /^[a-z\d_]{5,32}$/i.test(e.BDFX_INBOX_BOT_NAME || "") && /^[a-z\d_-]{32,256}$/i.test(e.BDFX_INBOX_TELEGRAM_SECRET || ""));
  const whatsapp = !!(e.BDFX_META_APP_ID && e.BDFX_META_APP_SECRET && e.BDFX_META_CONFIG_ID && e.BDFX_META_VERIFY_TOKEN && /^[a-f\d]{64}$/i.test(e.BDFX_INBOX_ENCRYPTION_KEY || ""));
  return { telegram, whatsapp, bot: telegram ? e.BDFX_INBOX_BOT_NAME : null, appId: whatsapp ? e.BDFX_META_APP_ID : null, configId: whatsapp ? e.BDFX_META_CONFIG_ID : null, version: graphVersion() };
}
function equal(a, b) {
  if (!a || typeof a !== "string" || typeof b !== "string")
    return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function seal(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(env().BDFX_INBOX_ENCRYPTION_KEY, "hex"), iv);
  const data = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(v => v.toString("base64")).join(".");
}
function unseal(value) {
  const [iv, tag, data] = value.split(".").map(v => Buffer.from(v, "base64"));
  const cipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(env().BDFX_INBOX_ENCRYPTION_KEY, "hex"), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8");
}
async function request(url, options) {
  const res = await fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(10000) });
  const data = await res.json();
  if (!res.ok || data.error || data.ok === false) {
    throw new CrmError(502, "The messaging provider declined this request. Check the account connection and reply permissions.");
  }
  return data;
}
function telegram(method, payload) {
  return request("https://api.telegram.org/bot" + env().BDFX_INBOX_BOT_TOKEN + "/" + method, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
}
function graph(path, token, body) {
  return request("https://graph.facebook.com/" + graphVersion() + "/" + path, {
    method: body ? "POST" : "GET", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function exchange(code, waba, phone) {
  const e = env();
  const auth = await request("https://graph.facebook.com/" + graphVersion() + "/oauth/access_token", {
    method: "POST", body: new URLSearchParams({ client_id: e.BDFX_META_APP_ID, client_secret: e.BDFX_META_APP_SECRET, code }),
  });
  if (!auth.access_token)
    throw new CrmError(400, "Meta did not authorize the account.");
  const phones = await graph(waba + "/phone_numbers?fields=id,display_phone_number,is_on_biz_app", auth.access_token);
  const canonical = v => String(v || "").replace(/\D/g, "");
  const match = phones.data?.filter(p => canonical(p.display_phone_number) === canonical(phone) && p.is_on_biz_app === true);
  if (match?.length !== 1)
    throw new CrmError(409, "The authorized WhatsApp Business number must match your work number.");
  return { phoneId: match[0].id, token: auth.access_token };
}
module.exports = { settings, equal, seal, unseal, telegram, graph, exchange };
