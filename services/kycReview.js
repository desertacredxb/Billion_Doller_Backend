const crypto = require('node:crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const IB = require('../models/Broker.model');
const Job = require('../models/KycReview');
const provider = require('./sumsubApi');
const { enqueueKycNotice } = require('./kycNotices');
const { normalizeCountry } = require('../utils/kycCountries');

const REASONS = Object.freeze({
  uae: "We don't accept clients from the UAE.",
  generic: 'Your identity document could not be verified. Please submit a valid supported government ID.',
  expired: 'Your identity document has expired. Please submit a valid document.',
  unreadable: 'The document image is unclear or incomplete. Please upload a clear image of the full document.',
  unsupported: 'This document type is not supported. Please submit an accepted government ID.',
  residence: 'We could not confirm your country of residence from the verification. Please complete the required country-of-residence check.',
});
const uae = value => /^(ARE|AE|UAE|UNITED ARAB EMIRATES)$/i.test(String(value || '').trim());
const country = value => normalizeCountry(value);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reviewFingerprint = status => hash([status?.reviewStatus, status?.levelName, status?.reviewId,
  status?.attemptId, status?.reviewDate, status?.reviewResult?.reviewAnswer,
  status?.reviewResult?.reviewRejectType, status?.reviewResult?.rejectLabels]);
const parseDate = value => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(date.getTime()) ? date : null;
};

function resolveDecision({ user, applicant, status, identity, poa, env = process.env }) {
  const binding = user.kycAutomation?.applicantId;
  if (!binding || applicant?.id !== binding || applicant.externalUserId !== String(user._id) ||
      applicant.clientId !== env.SUMSUB_CLIENT_ID || applicant.type !== 'individual' ||
      status?.levelName !== env.SUMSUB_LEVEL_NAME) throw new Error('provider_binding_mismatch');
  if (status.reviewStatus !== 'completed') return null;
  if (!['GREEN', 'RED'].includes(status.reviewResult?.reviewAnswer)) throw new Error('provider_result_invalid');
  const reviewedAt = parseDate(status.reviewDate);
  if (!reviewedAt || !status.reviewId || !status.attemptId) throw new Error('provider_review_identity_missing');
  // A previous attempt must not approve documents that were uploaded afterward.
  if (user.kycAutomation.submittedAt && reviewedAt < new Date(user.kycAutomation.submittedAt)) return null;
  const steps = ['IDENTITY', 'IDENTITY2', 'IDENTITY3', 'IDENTITY4'].map(key => identity?.[key]).filter(Boolean);
  const poaCheck = poa?.checks?.[0];
  const residence = poaCheck?.answer === 'GREEN' ? country(poaCheck.inputDoc?.address?.country) : null;
  let result;
  if ([user.country, user.nationality, user.idProof1?.issuingCountry, applicant.info?.nationality, residence,
    ...steps.map(step => step.country)].some(uae)) {
    result = { status: 'rejected', reason: REASONS.uae };
  } else if (status.reviewResult.reviewAnswer === 'RED') {
    const labels = status.reviewResult.rejectLabels || [];
    const reason = labels.includes('DOCUMENT_EXPIRATION') ? REASONS.expired :
      labels.includes('UNSATISFACTORY_PHOTOS') ? REASONS.unreadable : REASONS.generic;
    result = { status: status.reviewResult.reviewRejectType === 'RETRY' ? 'action_required' : 'rejected', reason };
  } else if (!steps.length || steps.some(step => step.reviewResult?.reviewAnswer !== 'GREEN' ||
      !country(step.country) || !['PASSPORT', 'ID_CARD'].includes(step.idDocType))) {
    result = { status: 'action_required', reason: REASONS.unsupported };
  } else if (!residence) {
    // Nationality and info.country are not proof of residence. A single ID can
    // serve as PoA only when the configured provider level verifies its address.
    result = { status: 'action_required', reason: REASONS.residence };
  } else {
    result = { status: 'approved', reason: '' };
  }
  return { ...result, reviewedAt, reviewId: status.reviewId,
    key: hash([env.SUMSUB_CLIENT_ID, binding, status.levelName, status.reviewId,
      status.attemptId, status.reviewDate, result.status, result.reason]) };
}

function shouldApply(user, decision) {
  if (user.kycAutomation?.reviewKey === decision.key) return false;
  const previous = user.kycAutomation?.reviewedAt && new Date(user.kycAutomation.reviewedAt);
  if (previous && previous > decision.reviewedAt) return false;
  // Equal-time conflicting events can remove approval, but cannot restore it.
  if (previous && +previous === +decision.reviewedAt &&
      ((user.kycAutomation.status === 'rejected' && decision.status !== 'rejected') ||
       (user.kycAutomation.status === 'action_required' && decision.status === 'approved'))) return false;
  return true;
}

function createKycReviewService(deps = {}) {
  const users = deps.User || User;
  const ibs = deps.IB || IB;
  const jobs = deps.Job || Job;
  const api = deps.provider || provider;
  const enqueueNotice = deps.enqueueNotice || enqueueKycNotice;
  const transaction = deps.transaction || (fn => mongoose.connection.transaction(fn));
  const env = deps.env || process.env;
  const now = deps.now || (() => new Date());
  const allowed = () => env.BDFX_KYC_AUTOMATION_ENABLED === 'true' &&
    env.BDFX_KYC_RELEASE_APPROVED === 'true' && api.providerReady(env);

  async function enqueueReview(event, raw) {
    const key = crypto.createHash('sha256').update(raw).digest('hex');
    await jobs.updateOne({ _id: key }, { $setOnInsert: {
      userId: event.externalUserId, applicantId: event.applicantId,
      state: 'queued', nextAttemptAt: now(), lockedUntil: new Date(0), attempts: 0,
    } }, { upsert: true });
    return key;
  }

  async function reconcile(job) {
    if (!allowed()) throw new Error('review_disabled');
    const user = await users.findById(job.userId);
    if (!user || !user.isVerified || user.kycAutomation?.applicantId !== job.applicantId)
      throw new Error('provider_binding_mismatch');
    const applicant = await api.fetchApplicant(job.applicantId);
    const status = await api.fetchReviewStatus(job.applicantId);
    if (status.reviewStatus !== 'completed') throw new Error('provider_review_pending');
    const identity = await api.fetchIdentityStatus(job.applicantId);
    // Final provider denials never need an additional successful residence API.
    const poa = status.reviewResult?.reviewAnswer === 'GREEN' ? await api.fetchPoaStatus(job.applicantId) : {};
    const decision = resolveDecision({ user, applicant, status, identity, poa, env });
    if (!decision) throw new Error('provider_review_pending');
    // Re-read after supporting evidence: a queued GREEN may have become RED.
    const latest = await api.fetchReviewStatus(job.applicantId);
    if (reviewFingerprint(latest) !== reviewFingerprint(status)) throw new Error('provider_review_changed');
    await transaction(async session => {
      if (!allowed()) throw new Error('review_disabled');
      const current = await users.findById(job.userId).session(session);
      if (!current || !current.isVerified || current.kycAutomation?.applicantId !== job.applicantId) throw new Error('provider_binding_mismatch');
      const lease = await jobs.findOne({ _id: job._id, lockToken: job.lockToken, state: 'processing', lockedUntil: { $gt: now() } }).session(session);
      if (!lease) throw new Error('review_lease_lost');
      const currentDecision = resolveDecision({ user: current, applicant, status, identity, poa, env });
      if (currentDecision && shouldApply(current, currentDecision) &&
          (!current.kycAutomation.submittedAt || decision.reviewedAt >= new Date(current.kycAutomation.submittedAt))) {
        const decision = currentDecision;
        const approved = decision.status === 'approved';
        const ib = await ibs.findOne({ email: current.email }).session(session);
        if (ib) {
          ib.status = approved ? 'approved' : decision.status === 'rejected' ? 'rejected' : 'pending';
          if (approved && !ib.referralCode) ib.referralCode = `IB${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
          await ib.save({ session });
        }
        current.isKycVerified = approved;
        current.isApprovedIB = approved && Boolean(ib);
        Object.assign(current.kycAutomation, { status: decision.status, reason: decision.reason,
          provider: 'sumsub', reviewId: decision.reviewId, reviewKey: decision.key,
          reviewedAt: decision.reviewedAt, processedAt: now() });
        await current.save({ session });
        await enqueueNotice(current, decision.status === 'action_required' ? 'resubmission' : decision.status,
          decision.reason, decision.key, { session });
      }
      await jobs.updateOne({ _id: job._id, lockToken: job.lockToken }, {
        $set: { state: 'done', completedAt: now(), lockedUntil: new Date(0) }, $unset: { lockToken: '', lastError: '' },
      }, { session });
    });
  }

  async function processReviews({ limit = 10 } = {}) {
    if (!allowed()) return { disabled: true, processed: 0 };
    let processed = 0;
    for (let count = 0; count < Math.min(limit, 25); count++) {
      if (!allowed()) break;
      const at = now();
      const job = await jobs.findOneAndUpdate({ state: { $in: ['queued', 'processing'] }, nextAttemptAt: { $lte: at }, lockedUntil: { $lte: at } }, {
        $set: { state: 'processing', lockToken: crypto.randomUUID(), lockedUntil: new Date(+at + 180000) },
        $inc: { attempts: 1 },
      }, { new: true, sort: { nextAttemptAt: 1 } });
      if (!job) break;
      try { await reconcile(job); processed++; }
      catch (error) {
        const bindingFailure = error.message === 'provider_binding_mismatch';
        await jobs.updateOne({ _id: job._id, lockToken: job.lockToken }, { $set: {
          state: bindingFailure ? 'blocked' : 'queued',
          nextAttemptAt: new Date(+now() + Math.min(3600000, 15000 * 2 ** Math.min(job.attempts, 8))),
          lockedUntil: new Date(0), lastError: bindingFailure ? 'provider_binding_mismatch' : 'review_retry_required',
        }, $unset: { lockToken: '' } });
      }
    }
    return { processed };
  }

  function startReviewWorker({ intervalMs = 15000 } = {}) {
    let busy = false;
    const run = async () => {
      if (busy) return;
      busy = true;
      try { await processReviews(); } catch { console.error('KYC review queue retry required'); }
      finally { busy = false; }
    };
    const timer = setInterval(run, Math.max(5000, intervalMs));
    timer.unref();
    void run();
    return () => clearInterval(timer);
  }
  return { enqueueReview, reconcile, processReviews, startReviewWorker };
}

module.exports = { ...createKycReviewService(), createKycReviewService, resolveDecision, shouldApply, REASONS };
