const email = value => typeof value === "string" && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value) && !/[\r\n]/.test(value);
function mailConfig(env = process.env) {
  const user = env.SMTP_USER || env.EMAIL_USER;
  const pass = env.SMTP_PASS || env.EMAIL_PASS;
  const requestedFrom = env.SMTP_FROM || env.EMAIL_FROM || user;
  if (!email(user) || !pass || !email(requestedFrom)) throw new Error("Mail configuration is incomplete.");
  // Received BDFX mail shows consumer Gmail rewriting an unverified domain
  // From address. Keep the authenticated mailbox unless its alias has actually
  // been verified. This does not configure domain DKIM or promise inbox placement.
  const gmailTransport = !env.SMTP_HOST || /^(?:smtp\.)?gmail\.com$/i.test(env.SMTP_HOST);
  const consumerGmail = /@(?:gmail|googlemail)\.com$/i.test(user);
  const from = gmailTransport && consumerGmail && env.SMTP_FROM_VERIFIED !== "true" ? user : requestedFrom;
  let transport;
  if (env.SMTP_HOST) {
    const port = Number(env.SMTP_PORT || 465);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-z\d.-]+$/i.test(env.SMTP_HOST)) throw new Error("Mail transport configuration is invalid.");
    transport = { host: env.SMTP_HOST, port, secure: port === 465, requireTLS: port !== 465, auth: { user, pass } };
  } else {
    transport = { service: "gmail", auth: { user, pass } };
  }
  return { transport: { ...transport, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 }, from: { name: "Billion Dollar FX", address: from }, replyTo: "support@billiondollarfx.com" };
}
module.exports = { mailConfig };
