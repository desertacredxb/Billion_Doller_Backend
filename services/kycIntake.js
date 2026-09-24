const crypto = require('node:crypto');
const axios = require('axios');
const FormData = require('form-data');
const mongoose = require('mongoose');
const KycIntake = require('../models/KycIntake');
const User = require('../models/User');
const IB = require('../models/Broker.model');
const sumsub = require('./sumsubApi');
const { enqueueKycNotice } = require('./kycNotices');
const { normalizeCountry } = require('../utils/kycCountries');

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const LEASE_MS = 180000;
const RETRY_BASE_MS = 60000;
const GENERIC_REASON = 'Your identity document could not be verified. Please submit a valid supported government ID.';
const UNSUPPORTED_REASON = 'This document type is not supported. Please submit an accepted government ID.';
const UAE_REASON = "We don't accept clients from the UAE.";
const TYPES = { Passport: 'PASSPORT', 'National ID Card': 'ID_CARD', 'PAN Card': 'ID_CARD', 'Aadhaar Card': 'ID_CARD' };

function intakeKey(userId, documentUrl, documentBackUrl = '') {
  return crypto.createHash('sha256').update(JSON.stringify([String(userId), documentUrl, documentBackUrl || ''])).digest('hex');
}

function validateDocumentUrl(value, env = process.env) {
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  if (!/^[a-zA-Z0-9_-]+$/.test(cloudName || '')) throw Object.assign(new Error('Document storage unavailable'), { code: 'STORAGE_UNAVAILABLE' });
  let url;
  try { url = new URL(value); } catch { throw Object.assign(new Error('Invalid document URL'), { code: 'DOCUMENT_INVALID' }); }
  // Accept only original versioned uploads in this application's folder.
  // No transformations, remote fetch paths, credentials, ports or redirects.
  const expectedPath = new RegExp(`^/${cloudName}/(?:image|raw)/upload/v[0-9]+/Billio-dollar-FX/[a-zA-Z0-9_-]+\\.(?:jpe?g|png|pdf)$`);
  if (url.protocol !== 'https:' || url.hostname !== 'res.cloudinary.com' || url.port ||
      url.username || url.password || url.search || url.hash || !expectedPath.test(url.pathname)) {
    throw Object.assign(new Error('Invalid document URL'), { code: 'DOCUMENT_INVALID' });
  }
  return url.href;
}

function documentMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_DOCUMENT_BYTES) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return null;
}

async function fetchDocument(value, { env = process.env, http = axios } = {}) {
  const url = validateDocumentUrl(value, env);
  const response = await http.get(url, { responseType: 'stream', timeout: 15000, maxRedirects: 0,
    proxy: false, maxContentLength: MAX_DOCUMENT_BYTES, maxBodyLength: MAX_DOCUMENT_BYTES,
    headers: { Accept: 'image/jpeg, image/png, application/pdf' } });
  const stream = response.data;
  try {
    const contentType = String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!['image/jpeg', 'image/png', 'application/pdf'].includes(contentType) ||
        Number(response.headers?.['content-length']) > MAX_DOCUMENT_BYTES) throw new Error('Invalid document response');
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_DOCUMENT_BYTES) throw new Error('Document too large');
      chunks.push(bytes);
    }
    const buffer = Buffer.concat(chunks, size);
    const mime = documentMime(buffer);
    if (!mime || mime !== contentType) throw new Error('Invalid document type');
    return { buffer, mime };
  } catch {
    stream.destroy?.();
    throw Object.assign(new Error('Invalid document response'), { code: 'DOCUMENT_INVALID' });
  }
}

function multipartDocument(metadata, file) {
  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata), { contentType: 'application/json' });
  const extension = file.mime === 'application/pdf' ? 'pdf' : file.mime === 'image/png' ? 'png' : 'jpg';
  form.append('content', file.buffer, { filename: `identity.${extension}`, contentType: file.mime });
  // Sign and send the exact same multipart bytes, including boundaries.
  const body = form.getBuffer();
  return { body, headers: { ...form.getHeaders(), 'Content-Length': String(body.length), 'X-Return-Doc-Warnings': 'true' } };
}

function createKycIntakeService({
  IntakeModel = KycIntake, UserModel = User, IBModel = IB, api = sumsub, notice = enqueueKycNotice,
  transaction = work => mongoose.connection.transaction(work),
  env = process.env, now = () => new Date(), download, logger = console,
} = {}) {
  const getDocument = download || (url => fetchDocument(url, { env }));
  const ready = () => sumsub.providerReady(env);

  async function enqueueKycIntake(user) {
    const documentUrl = user?.idProof1?.image;
    const documentBackUrl = user?.idProof1?.backImage || '';
    if (!user?._id || typeof documentUrl !== 'string' || !documentUrl || documentUrl.length > 2000) {
      throw new Error('A stored identity document is required');
    }
    if (typeof documentBackUrl !== 'string' || documentBackUrl.length > 2000) throw new Error('Invalid document back image');
    const key = intakeKey(user._id, documentUrl, documentBackUrl);
    const timestamp = now();
    try {
      await IntakeModel.updateOne({ _id: key }, { $setOnInsert: {
        _id: key, userId: user._id, documentUrl, documentBackUrl, documentType: user.idProof1.docType,
        issuingCountry: user.idProof1.issuingCountry, state: 'queued', uploadState: 'none', backUploadState: 'none',
        attempts: 0, nextAttemptAt: timestamp, createdAt: timestamp,
      } }, { upsert: true });
    } catch (error) { if (error?.code !== 11000) throw error; }
    // Repeating enqueue never resets an existing review or its start time.
    await UserModel.updateOne({ _id: user._id, 'idProof1.image': documentUrl, 'idProof1.backImage': documentBackUrl || null,
      isVerified: true, isKycVerified: { $ne: true },
      $or: [{ 'kycAutomation.status': { $in: ['not_started', 'action_required', 'pending'] } },
        { 'kycAutomation.status': { $exists: false } }],
      'kycAutomation.intakeKey': { $ne: key },
    }, { $set: { 'kycAutomation.intakeKey': key, 'kycAutomation.status': 'pending',
      'kycAutomation.reason': '', 'kycAutomation.provider': 'sumsub', 'kycAutomation.submittedAt': timestamp } });
    return { intakeKey: key };
  }

  function userFilter(job) {
    return { _id: job.userId, 'idProof1.image': job.documentUrl, 'kycAutomation.intakeKey': job._id,
      'idProof1.backImage': job.documentBackUrl || null,
      isVerified: true, isKycVerified: { $ne: true },
      'kycAutomation.status': { $in: ['pending', 'action_required'] } };
  }

  async function processJob(job) {
    const lease = { _id: job._id, state: 'processing', leaseToken: job.leaseToken };
    async function checkpoint(values = {}) {
      const saved = await IntakeModel.updateOne({ ...lease, leaseExpiresAt: { $gt: now() } }, {
        $set: { ...values, leaseExpiresAt: new Date(now().getTime() + LEASE_MS) },
      });
      if (!saved.modifiedCount && !saved.matchedCount) throw Object.assign(new Error('Intake lease lost'), { code: 'LEASE_LOST' });
      Object.assign(job, values);
    }
    async function finish(state, outcome, reason = '', code = '') {
      // Keep the job leased until its deduplicated notice is durable. A crash
      // retries this outcome, without repeating the provider upload.
      await checkpoint({ outcome, reason, lastErrorCode: code });
      const applyOutcome = async session => {
        const sessionOptions = session ? { session } : {};
        const user = await UserModel.findOneAndUpdate({ ...userFilter(job),
          'kycAutomation.status': { $in: state === 'done' ? ['pending'] :
            ['pending', 'action_required', ...(state === 'rejected' ? ['rejected'] : [])] },
        }, { $set: {
          'kycAutomation.status': state === 'done' ? 'pending' : state,
          'kycAutomation.reason': reason,
          ...(state === 'rejected' ? { isKycVerified: false, 'kycAutomation.reviewedAt': now() } : {}),
        } }, { new: true, ...sessionOptions });
        if (user) {
          if (state === 'rejected') {
            // The IB schema does not make email unique. Refuse every pending
            // application for this exact account, preserving existing finals.
            await IBModel.updateMany({ email: user.email, status: 'pending' }, { $set: { status: 'rejected' } }, sessionOptions);
          }
          await notice(user, outcome, reason, `intake:${job._id}:${outcome}`, sessionOptions);
        }
        const completion = await IntakeModel.updateOne({ ...lease, leaseExpiresAt: { $gt: now() } }, {
          $set: { state: user ? state : 'cancelled', leaseToken: null, leaseExpiresAt: null },
        }, sessionOptions);
        if (!completion.matchedCount) throw Object.assign(new Error('Intake lease lost'), { code: 'LEASE_LOST' });
      };
      // A refusal, its pending IB consequences, and the notice must either all
      // commit or all retry. Queue completion is fenced in that transaction too.
      if (state === 'rejected') await transaction(applyOutcome);
      else await applyOutcome();
    }

    const user = await UserModel.findById(job.userId);
    if (!user || !user.isVerified || user.isKycVerified || user.idProof1?.image !== job.documentUrl ||
        (user.idProof1?.backImage || '') !== (job.documentBackUrl || '') || user.kycAutomation?.intakeKey !== job._id) {
      await IntakeModel.updateOne(lease, { $set: { state: 'cancelled', leaseToken: null, leaseExpiresAt: null } });
      return;
    }
    if (job.outcome) return finish(job.outcome === 'pending' ? 'done' : job.outcome === 'rejected' ? 'rejected' : 'action_required', job.outcome, job.reason, job.lastErrorCode);
    if (['approved', 'rejected'].includes(user.kycAutomation?.status)) {
      await IntakeModel.updateOne(lease, { $set: { state: 'cancelled', leaseToken: null, leaseExpiresAt: null } });
      return;
    }
    if (['uploading', 'ambiguous'].includes(job.uploadState) || ['uploading', 'ambiguous'].includes(job.backUploadState)) {
      // There is no documented upload idempotency key. An interrupted upload
      // must be inspected/corrected through the existing hosted flow, not replayed.
      await checkpoint({ ...(job.uploadState === 'uploading' ? { uploadState: 'ambiguous' } : {}),
        ...(job.backUploadState === 'uploading' ? { backUploadState: 'ambiguous' } : {}) });
      return finish('action_required', 'resubmission', GENERIC_REASON, 'upload_ambiguous');
    }
    const country = normalizeCountry(job.issuingCountry);
    const idDocType = TYPES[job.documentType];
    if (!country || !idDocType || (['PAN Card', 'Aadhaar Card'].includes(job.documentType) && country !== 'IND')) {
      return finish('action_required', 'resubmission', UNSUPPORTED_REASON, 'document_metadata_invalid');
    }
    try {
      validateDocumentUrl(job.documentUrl, env);
      if (job.documentBackUrl) validateDocumentUrl(job.documentBackUrl, env);
    }
    catch (error) {
      if (error.code === 'STORAGE_UNAVAILABLE') throw error;
      return finish('action_required', 'resubmission', GENERIC_REASON, 'document_source_invalid');
    }

    let applicant;
    const boundId = user.kycAutomation?.applicantId || job.applicantId;
    try {
      applicant = boundId ? await api.fetchApplicant(boundId) : await api.fetchApplicantByExternalUserId(String(user._id));
    } catch (error) {
      if (boundId || error?.response?.status !== 404) throw error;
      await checkpoint();
      if (!ready()) throw Object.assign(new Error('Provider disabled'), { code: 'PROVIDER_DISABLED' });
      try {
        applicant = await api.sumsubRequest('POST', `/resources/applicants?levelName=${encodeURIComponent(env.SUMSUB_LEVEL_NAME)}`, {
          externalUserId: String(user._id), type: 'individual', email: user.email,
        });
      } catch (creationError) {
        // Creation may succeed before a connection breaks. Recover by our
        // stable external ID before any subsequent create attempt.
        try { applicant = await api.fetchApplicantByExternalUserId(String(user._id)); }
        catch { throw creationError; }
      }
    }
    if (!applicant || !/^[a-f0-9]{24}$/i.test(applicant.id || '') || applicant.clientId !== env.SUMSUB_CLIENT_ID ||
        applicant.externalUserId !== String(user._id) || applicant.type !== 'individual' || applicant.sandboxMode === true ||
        (boundId && applicant.id !== boundId)) {
      return finish('action_required', 'resubmission', GENERIC_REASON, 'applicant_binding_mismatch');
    }
    const binding = await UserModel.updateOne({ ...userFilter(job), $or: [
      { 'kycAutomation.applicantId': { $exists: false } }, { 'kycAutomation.applicantId': null },
      { 'kycAutomation.applicantId': '' }, { 'kycAutomation.applicantId': applicant.id },
    ] }, { $set: { 'kycAutomation.applicantId': applicant.id } });
    if (!binding.matchedCount) throw Object.assign(new Error('Applicant binding changed'), { code: 'LEASE_LOST' });
    await checkpoint({ applicantId: applicant.id });

    if (job.uploadState === 'none' || (job.documentBackUrl && job.backUploadState === 'none')) {
      const currentReview = await api.fetchReviewStatus(applicant.id);
      if (currentReview?.levelName !== env.SUMSUB_LEVEL_NAME) {
        return finish('action_required', 'resubmission', GENERIC_REASON, 'verification_level_mismatch');
      }
      if (['pending', 'queued', 'prechecked'].includes(currentReview?.reviewStatus)) {
        throw Object.assign(new Error('Applicant review in progress'), { code: 'REVIEW_BUSY' });
      }
    }
    for (const [documentUrl, stateField, hashField, side] of [
      [job.documentUrl, 'uploadState', 'documentHash', 'FRONT_SIDE'],
      [job.documentBackUrl, 'backUploadState', 'backDocumentHash', 'BACK_SIDE'],
    ]) {
      if (!documentUrl || job[stateField] === 'uploaded') continue;
      let file;
      try { file = await getDocument(documentUrl); }
      catch (error) {
        if (error.code !== 'DOCUMENT_INVALID') throw error;
        return finish('action_required', 'resubmission', GENERIC_REASON, 'document_invalid');
      }
      if (!documentMime(file.buffer) || documentMime(file.buffer) !== file.mime) {
        return finish('action_required', 'resubmission', GENERIC_REASON, 'document_invalid');
      }
      const metadata = { idDocType, country, ...(idDocType === 'ID_CARD' ? { idDocSubType: side } : {}) };
      const multipart = multipartDocument(metadata, file);
      await checkpoint({ [stateField]: 'uploading', [hashField]: crypto.createHash('sha256').update(file.buffer).digest('hex') });
      if (!ready()) {
        await checkpoint({ [stateField]: 'none' });
        throw Object.assign(new Error('Provider disabled'), { code: 'PROVIDER_DISABLED' });
      }
      let uploaded;
      try {
        uploaded = await api.sumsubRequest('POST', `/resources/applicants/${applicant.id}/info/idDoc`, multipart.body, multipart.headers);
      } catch {
        await checkpoint({ [stateField]: 'ambiguous' });
        return finish('action_required', 'resubmission', GENERIC_REASON, 'upload_ambiguous');
      }
      await checkpoint({ [stateField]: 'uploaded', providerCountry: uploaded?.country || '', providerDocumentType: uploaded?.idDocType || '' });
      if (normalizeCountry(uploaded?.country) === 'ARE') return finish('rejected', 'rejected', UAE_REASON, 'uae_document');
      if (uploaded?.errors?.length) {
        return finish('action_required', 'resubmission', GENERIC_REASON, 'provider_document_errors');
      }
    }

    // A known provider country is a sufficient refusal signal; local declared
    // country is never used to grant verification. Approval belongs to the
    // authenticated review reconciler with provider identity and PoA evidence.
    if (normalizeCountry(job.providerCountry) === 'ARE') return finish('rejected', 'rejected', UAE_REASON, 'uae_document');
    const review = await api.fetchReviewStatus(applicant.id);
    if (review?.levelName !== env.SUMSUB_LEVEL_NAME) {
      return finish('action_required', 'resubmission', GENERIC_REASON, 'verification_level_mismatch');
    }
    if (job.submittedAt && ['pending', 'queued', 'prechecked'].includes(review?.reviewStatus)) {
      return finish('done', 'pending');
    }
    if (job.submittedAt && review?.reviewStatus === 'completed' && new Date(review.reviewDate).getTime() >= new Date(job.submittedAt).getTime()) {
      // The webhook reconciler owns the final decision; never approve here.
      return finish('done', 'pending');
    }
    if (!job.submittedAt) {
      const submittedAt = now();
      await checkpoint({ submittedAt });
      const marked = await UserModel.updateOne(userFilter(job), { $set: {
        'kycAutomation.submittedAt': submittedAt, 'kycAutomation.status': 'pending',
      } });
      if (!marked.matchedCount) throw Object.assign(new Error('Document submission changed'), { code: 'LEASE_LOST' });
    }
    await checkpoint();
    if (!ready()) throw Object.assign(new Error('Provider disabled'), { code: 'PROVIDER_DISABLED' });
    try { await api.sumsubRequest('POST', `/resources/applicants/${applicant.id}/status/pending`); }
    catch (error) {
      if ([400, 409, 422].includes(error?.response?.status)) {
        return finish('action_required', 'resubmission', GENERIC_REASON, 'additional_verification_required');
      }
      throw error;
    }
    return finish('done', 'pending');
  }

  async function processKycIntakes({ limit = 10 } = {}) {
    const result = { claimed: 0, disabled: !ready() };
    if (ready()) {
      // Recover legacy pending uploads and a crash between document persistence
      // and enqueue. Never silently resubmit an action-required or final result.
      const awaiting = await UserModel.find({ isVerified: true, isKycVerified: false,
        hasSubmittedDocuments: true, 'idProof1.image': { $type: 'string', $ne: '' },
        $or: [{ 'kycAutomation.status': 'not_started' }, { 'kycAutomation.status': { $exists: false } }],
      }).limit(10);
      for (const user of awaiting) await enqueueKycIntake(user);
    }
    for (let index = 0; index < Math.min(Math.max(Number(limit) || 1, 1), 50) && ready(); index += 1) {
      const timestamp = now();
      const leaseToken = crypto.randomUUID();
      const job = await IntakeModel.findOneAndUpdate({ $or: [
        { state: { $in: ['queued', 'retry'] }, nextAttemptAt: { $lte: timestamp } },
        { state: 'processing', leaseExpiresAt: { $lte: timestamp } },
      ] }, { $set: { state: 'processing', leaseToken, leaseExpiresAt: new Date(timestamp.getTime() + LEASE_MS) },
        $inc: { attempts: 1 } }, { new: true, sort: { nextAttemptAt: 1, createdAt: 1 } });
      if (!job) break;
      result.claimed += 1;
      try { await processJob(job); }
      catch (error) {
        if (error.code === 'LEASE_LOST') continue;
        const delay = Math.min(3600000, RETRY_BASE_MS * 2 ** Math.min(Math.max(job.attempts - 1, 0), 6));
        await IntakeModel.updateOne({ _id: job._id, state: 'processing', leaseToken }, { $set: {
          state: 'retry', leaseToken: null, leaseExpiresAt: null, nextAttemptAt: new Date(now().getTime() + delay),
          lastErrorCode: ['PROVIDER_DISABLED', 'STORAGE_UNAVAILABLE', 'REVIEW_BUSY'].includes(error.code) ? error.code : 'provider_unavailable',
        } });
      }
    }
    return result;
  }

  function startKycIntakeWorker({ intervalMs = 15000, limit = 10 } = {}) {
    let running = false;
    let stopped = false;
    const tick = async () => {
      if (running || stopped) return;
      running = true;
      try { await processKycIntakes({ limit }); }
      catch { logger.error('BDFX KYC intake worker failed; queued work will be retried.'); }
      finally { running = false; }
    };
    const timer = setInterval(tick, Math.max(Number(intervalMs) || 15000, 1000));
    timer.unref?.();
    void tick();
    return () => { stopped = true; clearInterval(timer); };
  }

  return { enqueueKycIntake, queueKycIntake: enqueueKycIntake, processKycIntakes, startKycIntakeWorker };
}

module.exports = { ...createKycIntakeService(), createKycIntakeService, intakeKey,
  validateDocumentUrl, documentMime, fetchDocument, multipartDocument, MAX_DOCUMENT_BYTES };
