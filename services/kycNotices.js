const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const KycNotice = require('../models/KycNotice');
const { normalizePhone } = require('../utils/phone');
const { sendKycWhatsApp } = require('./watiKyc');

const STATUSES = new Set(['pending', 'approved', 'rejected', 'resubmission']);
// Provider timestamps may have coarse precision. At equal time, a final refusal
// supersedes correction/approval, and any reviewed result supersedes pending.
const EVENT_PRIORITY = { pending: 0, approved: 1, resubmission: 2, rejected: 3 };
const GENERIC_REASON = 'Your identity document could not be verified. Please submit a valid supported government ID.';
const SAFE_REASONS = new Set([
  "We don't accept clients from the UAE.",
  GENERIC_REASON,
  'Your identity document has expired. Please submit a valid document.',
  'The document image is unclear or incomplete. Please upload a clear image of the full document.',
  'Your document details do not match your account details. Please correct them and resubmit.',
  'This document type is not supported. Please submit an accepted government ID.',
  'We could not confirm your country of residence from the verification. Please complete the required country-of-residence check.',
]);
const LEASE_MS = 120000;
const TRANSPORT_TIMEOUT_MS = 30000;
const RETRY_BASE_MS = 60000;
const RETRY_MAX_MS = 3600000;

function noticesEnabled(env = process.env) {
  return env.BDFX_KYC_AUTOMATION_ENABLED === 'true' && env.BDFX_KYC_RELEASE_APPROVED === 'true' && env.SUMSUB_MODE === 'production' &&
    Boolean(env.SUMSUB_LEVEL_NAME && env.SUMSUB_LEVEL_NAME !== 'bdfx-kyc-sandbox' &&
      env.SUMSUB_CLIENT_ID && env.SUMSUB_APP_TOKEN && env.SUMSUB_SECRET_KEY && env.SUMSUB_WEBHOOK_SECRET);
}

function safeReason(status, reason) {
  if (!['rejected', 'resubmission'].includes(status)) return '';
  return SAFE_REASONS.has(reason) ? reason : GENERIC_REASON;
}

function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim() : '';
  return email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : '';
}

function noticeKey(userId, status, eventKey, channel) {
  return crypto.createHash('sha256').update(JSON.stringify([String(userId), status, eventKey, channel])).digest('hex');
}

function subjectKeyFor(userId) {
  return crypto.createHash('sha256').update(JSON.stringify(['bdfx-kyc-subject', String(userId)])).digest('hex');
}

function eventTime(user, fallback) {
  const timestamps = [user.kycAutomation?.reviewedAt, user.kycAutomation?.submittedAt]
    .filter(Boolean).map(value => new Date(value).getTime()).filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)) : fallback;
}

function olderThan(notice, latest) {
  return latest && (+new Date(notice.eventAt) < +new Date(latest.eventAt) ||
    (+new Date(notice.eventAt) === +new Date(latest.eventAt) && notice.eventPriority < latest.eventPriority));
}

function emailContent(status, reason) {
  if (status === 'resubmission') return {
    subject: 'BDFX ID verification needs a new document',
    text: `${reason} Sign in to your BDFX account to correct your document and resubmit your verification.`,
  };
  return {
    subject: `BDFX verification ${status}`,
    text: status === 'rejected'
      ? `Your BDFX verification was rejected. Reason: ${reason} Please contact support if you believe this is incorrect.`
      : status === 'approved'
        ? 'Your BDFX identity verification is approved.'
        : 'Welcome to BDFX. Sign in to your account to complete any required identity verification steps.',
  };
}

function smtpConfiguration(env = process.env) {
  const user = env.BDFX_KYC_SMTP_USER || env.SMTP_USER || env.EMAIL_USER;
  const pass = env.BDFX_KYC_SMTP_PASS || env.SMTP_PASS || env.EMAIL_PASS;
  const from = env.BDFX_KYC_EMAIL_FROM || env.EMAIL_FROM || user;
  const host = env.BDFX_KYC_SMTP_HOST || env.SMTP_HOST;
  if (!user || !pass || !from || /[\r\n]/.test(from)) return null;
  const port = Number(env.BDFX_KYC_SMTP_PORT || env.SMTP_PORT || 465);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    from,
    transport: {
      ...(host ? { host, port, secure: port === 465, requireTLS: port !== 465 } : { service: 'gmail', secure: true }),
      auth: { user, pass },
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      dnsTimeout: 10000,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    },
  };
}

async function sendKycEmail(message, { env = process.env, createTransport = nodemailer.createTransport } = {}) {
  const config = smtpConfiguration(env);
  if (!config) return { sent: false, code: 'configuration_unavailable' };
  const transport = createTransport(config.transport);
  let timer;
  try {
    // SMTP acceptance, not delivery to the inbox, is the durable success point.
    const result = await Promise.race([
      transport.sendMail({ ...message, from: config.from }),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('KYC email timed out')), TRANSPORT_TIMEOUT_MS);
      }),
    ]);
    const accepted = result?.accepted?.some(value => String(value).toLowerCase() === message.to.toLowerCase());
    return { sent: Boolean(accepted), code: accepted ? '' : 'provider_not_accepted' };
  } finally {
    clearTimeout(timer);
    transport.close?.();
  }
}

function createKycNoticeService({
  NoticeModel = KycNotice,
  sendEmail,
  sendWhatsApp = sendKycWhatsApp,
  env = process.env,
  now = () => new Date(),
  logger = console,
} = {}) {
  const emailSender = sendEmail || (message => sendKycEmail(message, { env }));

  async function latestNotice(subjectKey, session) {
    return NoticeModel.findOne({ subjectKey }, null, {
      sort: { eventAt: -1, eventPriority: -1 }, ...(session ? { session } : {}),
    });
  }

  // Callers guard KYC transitions. Persist notices even during a notification
  // configuration outage, and pass the outcome transaction session when present.
  async function enqueueKycNotice(user, status, reason, eventKey, { session } = {}) {
    if (!user?._id || !STATUSES.has(status) || typeof eventKey !== 'string' || !eventKey.trim()) {
      throw new Error('Invalid KYC notice identity');
    }
    const timestamp = now();
    const subjectKey = subjectKeyFor(user._id);
    const eventAt = eventTime(user, timestamp);
    const keys = [];
    for (const [channel, recipient] of [
      ['email', normalizeEmail(user.email)],
      ['whatsapp', normalizePhone(user.phone) || ''],
    ]) {
      const _id = noticeKey(user._id, status, eventKey, channel);
      keys.push(_id);
      try {
        await NoticeModel.updateOne({ _id }, { $setOnInsert: {
          _id, subjectKey, eventAt, eventPriority: EVENT_PRIORITY[status],
          channel, recipient, status, reason: safeReason(status, reason),
          state: recipient ? 'queued' : 'skipped', attempts: 0,
          nextAttemptAt: timestamp, leaseToken: null, leaseExpiresAt: null,
          lastAttemptAt: null, sentAt: null,
          lastErrorCode: recipient ? '' : 'recipient_missing',
          createdAt: timestamp, updatedAt: timestamp,
        } }, { upsert: true, timestamps: false, ...(session ? { session } : {}) });
      } catch (error) {
        // A concurrent upsert can lose the unique-key race. In a transaction
        // propagate it so the caller retries the entire transaction, not an
        // already-aborted session. The deterministic _id is always indexed.
        if (error?.code !== 11000 || session) throw error;
      }
    }
    // Compare with persisted events rather than arrival order: a delayed older
    // callback must cancel itself, never cancel a newer approval. This uses the
    // same transaction as the outcome when a session is supplied.
    const latest = await latestNotice(subjectKey, session);
    if (latest) await NoticeModel.updateMany({
      subjectKey, state: { $in: ['queued', 'retry', 'sending'] },
      $or: [
        { eventAt: { $lt: latest.eventAt } },
        { eventAt: latest.eventAt, eventPriority: { $lt: latest.eventPriority } },
      ],
    }, { $set: { state: 'cancelled', lastErrorCode: 'superseded', leaseToken: null, leaseExpiresAt: null } },
    { ...(session ? { session } : {}) });
    return { dedupKeys: keys };
  }

  async function processKycNotices({ limit = 25 } = {}) {
    const result = { claimed: 0, sent: 0, retry: 0, disabled: !noticesEnabled(env) };
    const batchSize = Math.min(Math.max(Number(limit) || 1, 1), 100);
    for (let count = 0; count < batchSize && noticesEnabled(env); count += 1) {
      const timestamp = now();
      const leaseToken = crypto.randomUUID();
      const notice = await NoticeModel.findOneAndUpdate({ $or: [
        { state: { $in: ['queued', 'retry'] }, nextAttemptAt: { $lte: timestamp } },
        { state: 'sending', leaseExpiresAt: { $lte: timestamp } },
      ] }, {
        $set: { state: 'sending', leaseToken, leaseExpiresAt: new Date(timestamp.getTime() + LEASE_MS), lastAttemptAt: timestamp },
        $inc: { attempts: 1 },
      }, { new: true, sort: { nextAttemptAt: 1, createdAt: 1 } });
      if (!notice) break;
      result.claimed += 1;
      const latest = notice.subjectKey ? await latestNotice(notice.subjectKey) : null;
      if (!notice.subjectKey || !notice.eventAt || olderThan(notice, latest)) {
        await NoticeModel.updateOne({ _id: notice._id, state: 'sending', leaseToken }, {
          $set: { state: 'cancelled', lastErrorCode: 'superseded', leaseToken: null, leaseExpiresAt: null },
        });
        continue;
      }
      // Enqueue may have cancelled this notice while a worker was claiming it.
      // Check the current lease immediately before dispatch. A provider request
      // already in flight cannot be recalled if a newer result arrives then.
      const lease = await NoticeModel.findOne({
        _id: notice._id, state: 'sending', leaseToken, leaseExpiresAt: { $gt: now() },
      });
      if (!lease) continue;
      let sent = false;
      let code = 'automation_disabled';
      if (noticesEnabled(env)) {
        try {
          const response = notice.channel === 'email'
            ? await emailSender({ to: notice.recipient, ...emailContent(notice.status, notice.reason),
              messageId: `<bdfx-kyc-${notice._id}@billiondollarfx.com>` })
            : await sendWhatsApp(notice.recipient, notice.status, notice.reason);
          sent = response === true || response?.sent === true;
          code = response?.code === 'configuration_unavailable' || response === false
            ? 'configuration_unavailable' : 'provider_not_accepted';
        } catch {
          code = 'send_failed';
        }
      }
      const completedAt = now();
      const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(Math.max(notice.attempts - 1, 0), 10));
      const saved = await NoticeModel.updateOne({ _id: notice._id, state: 'sending', leaseToken }, {
        $set: {
          state: sent ? 'sent' : 'retry', sentAt: sent ? completedAt : null,
          nextAttemptAt: new Date(completedAt.getTime() + (sent ? 0 : backoff)),
          leaseToken: null, leaseExpiresAt: null, lastErrorCode: sent ? '' : code,
        },
      });
      // Fence every completion with the lease token. An expired worker must not
      // overwrite another worker's result after a process stall/restart.
      if (saved.modifiedCount) result[sent ? 'sent' : 'retry'] += 1;
    }
    return result;
  }

  function startKycNoticeWorker({ intervalMs = 15000, limit = 25 } = {}) {
    let running = false;
    let stopped = false;
    const tick = async () => {
      if (running || stopped) return;
      running = true;
      try { await processKycNotices({ limit }); }
      catch { logger.error('BDFX KYC notice worker failed; queued work will be retried.'); }
      finally { running = false; }
    };
    const timer = setInterval(tick, Math.max(Number(intervalMs) || 15000, 1000));
    timer.unref?.();
    void tick();
    return () => { stopped = true; clearInterval(timer); };
  }

  return { enqueueKycNotice, processKycNotices, startKycNoticeWorker };
}

module.exports = {
  ...createKycNoticeService(),
  createKycNoticeService,
  noticesEnabled,
  noticeKey,
  sendKycEmail,
};
