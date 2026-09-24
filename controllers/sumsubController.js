const crypto = require('node:crypto');
const User = require('../models/User');
const { providerReady, sumsubRequest } = require('../services/sumsubApi');
const { enqueueReview } = require('../services/kycReview');
const { enqueueKycNotice } = require('../services/kycNotices');
const enabled = () => process.env.BDFX_KYC_AUTOMATION_ENABLED === 'true';

// This persists a notice; transports never determine applicant approval.
async function notify(user, status, reason = '', { session, eventKey } = {}) {
  const key = eventKey || crypto.createHash('sha256').update(JSON.stringify([
    String(user._id), status, reason, user.kycAutomation?.intakeKey || '',
  ])).digest('hex');
  return enqueueKycNotice(user, status, reason, key, { session });
}

exports.getVerificationStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.sendStatus(404);
    return res.json({ country: user.country || user.nationality || '',
      hasSubmittedDocuments: Boolean(user.hasSubmittedDocuments),
      isKycVerified: Boolean(user.isKycVerified),
      kycAutomation: { status: user.kycAutomation?.status || 'not_started', reason: user.kycAutomation?.reason || '' },
      automationEnabled: providerReady(),
      idProof1: { docType: user.idProof1?.docType || '',
        docNumber: user.idProof1?.docNumber ? `••••${String(user.idProof1.docNumber).slice(-4)}` : '' },
    });
  } catch { return res.status(503).json({ message: 'Unable to load verification status. Please try again.' }); }
};

// Hosted flow is a fallback for another step requested by the configured level.
// Normal CRM uploads are sent automatically by the durable intake worker.
exports.createVerificationLink = async (req, res) => {
  if (!providerReady()) return res.status(503).json({ message: 'Automated verification is not available yet.' });
  try {
    const user = await User.findById(req.user.id);
    if (!user || !user.isVerified) return res.status(403).json({ message: 'Complete account registration first.' });
    if (user.isKycVerified || user.kycAutomation?.status === 'rejected')
      return res.status(409).json({ message: 'This verification is already complete.' });
    if (!user.kycAutomation?.applicantId || user.kycAutomation?.status !== 'action_required')
      return res.status(409).json({ message: 'Your uploaded document is being processed. Please check its status.' });
    const response = await sumsubRequest('POST', '/resources/sdkIntegrations/levels/-/websdkLink', {
      levelName: process.env.SUMSUB_LEVEL_NAME, userId: String(user._id),
      applicantIdentifiers: { email: user.email }, ttlInSecs: 1800,
    });
    const target = new URL(response?.url || '');
    if (target.protocol !== 'https:' || target.username || target.password) throw new Error('invalid_provider_link');
    return res.json({ url: target.href });
  } catch {
    console.error('KYC hosted link creation failed');
    return res.status(502).json({ message: 'Unable to open verification. Please try again.' });
  }
};

function validDigest(raw, headers) {
  if (!Buffer.isBuffer(raw) || headers['x-payload-digest-alg'] !== 'HMAC_SHA256_HEX' || !process.env.SUMSUB_WEBHOOK_SECRET) return false;
  const claimed = headers['x-payload-digest'];
  if (typeof claimed !== 'string' || !/^[a-f\d]{64}$/i.test(claimed)) return false;
  const expected = crypto.createHmac('sha256', process.env.SUMSUB_WEBHOOK_SECRET).update(raw).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(claimed, 'hex'));
}

exports.handleWebhook = async (req, res) => {
  if (!enabled()) return res.sendStatus(503);
  if (!validDigest(req.body, req.headers)) return res.sendStatus(401);
  let event;
  try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return res.sendStatus(400);
  if (event.type !== 'applicantReviewed') return res.sendStatus(200);
  if (event.testMode === true || event.sandboxMode !== false) return res.sendStatus(200);
  if (!providerReady()) return res.sendStatus(503);
  if (event.clientId !== process.env.SUMSUB_CLIENT_ID) return res.sendStatus(401);
  if (event.levelName !== process.env.SUMSUB_LEVEL_NAME || event.reviewStatus !== 'completed' ||
      event.applicantType !== 'individual' ||
      !/^[a-f\d]{24}$/i.test(String(event.externalUserId || '')) ||
      !/^[a-f\d]{24}$/i.test(String(event.applicantId || '')) ||
      !['GREEN', 'RED'].includes(event.reviewResult?.reviewAnswer)) return res.sendStatus(200);
  try {
    // Acknowledge only after persistence; fetch current provider results before
    // atomically committing User, IB, and notification records.
    await enqueueReview(event, req.body);
    return res.sendStatus(200);
  } catch {
    console.error('KYC webhook persistence failed');
    return res.sendStatus(503);
  }
};
exports.validDigest = validDigest;
exports.notify = notify;
