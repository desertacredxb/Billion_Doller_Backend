const test = require('node:test');
const assert = require('node:assert/strict');
const { createKycReviewService, resolveDecision, shouldApply, REASONS } = require('../services/kycReview');

const clone = value => structuredClone(value);
const NOW = new Date('2026-09-24T12:02:00Z');

function fixture() {
  return {
    env: {
      BDFX_KYC_AUTOMATION_ENABLED: 'true', BDFX_KYC_RELEASE_APPROVED: 'true',
      SUMSUB_MODE: 'production', SUMSUB_LEVEL_NAME: 'bdfx-production', SUMSUB_CLIENT_ID: 'test-client',
    },
    user: {
      _id: '507f1f77bcf86cd799439011', email: 'review@example.invalid', phone: '+447911123457',
      isVerified: true, isKycVerified: false, isApprovedIB: false,
      country: 'GBR', nationality: 'IND', idProof1: { issuingCountry: 'IND' },
      kycAutomation: { applicantId: 'applicant-one', status: 'pending', submittedAt: new Date('2026-09-24T12:00:00Z') },
    },
    applicant: { id: 'applicant-one', externalUserId: '507f1f77bcf86cd799439011', clientId: 'test-client', type: 'individual', info: { nationality: 'IND' } },
    status: {
      levelName: 'bdfx-production', reviewStatus: 'completed', reviewDate: '2026-09-24 12:01:00+0000',
      reviewId: 'review-one', attemptId: 'attempt-one', reviewResult: { reviewAnswer: 'GREEN' },
    },
    identity: { IDENTITY: { country: 'IND', idDocType: 'PASSPORT', reviewResult: { reviewAnswer: 'GREEN' } } },
    poa: { checks: [{ answer: 'GREEN', inputDoc: { address: { country: 'GBR' } } }] },
  };
}

test('bound GREEN supported ID and verified non-UAE residence approve', () => {
  const input = fixture();
  const decision = resolveDecision(input);
  assert.equal(decision.status, 'approved');
  assert.equal(decision.reason, '');
  assert.equal(decision.reviewId, input.status.reviewId);
  assert.equal(decision.reviewedAt.toISOString(), '2026-09-24T12:01:00.000Z');
  assert.match(decision.key, /^[a-f\d]{64}$/);
  assert.equal(resolveDecision(clone(input)).key, decision.key);
});

test('UAE issuing country, verified residence, or provider nationality rejects a GREEN review', () => {
  for (const change of [
    input => { input.identity.IDENTITY.country = 'ARE'; },
    input => { input.poa.checks[0].inputDoc.address.country = 'AE'; },
    input => { input.applicant.info.nationality = 'ARE'; },
  ]) {
    const input = fixture();
    change(input);
    const decision = resolveDecision(input);
    assert.equal(decision.status, 'rejected');
    assert.equal(decision.reason, REASONS.uae);
  }
});

test('missing or unverified residence requests correction despite declared non-UAE residence', () => {
  for (const poa of [{}, { checks: [] }, { checks: [{ answer: 'RED', inputDoc: { address: { country: 'GBR' } } }] }]) {
    const decision = resolveDecision({ ...fixture(), poa });
    assert.equal(decision.status, 'action_required');
    assert.equal(decision.reason, REASONS.residence);
  }
});

test('unknown alpha3 codes and unsupported ID types cannot approve', () => {
  for (const change of [
    input => { input.identity.IDENTITY.country = 'ZZZ'; },
    input => { input.poa.checks[0].inputDoc.address.country = 'ZZZ'; },
    input => { input.identity.IDENTITY.idDocType = 'UNSUPPORTED_DOCUMENT'; },
  ]) {
    const input = fixture();
    change(input);
    assert.equal(resolveDecision(input).status, 'action_required');
  }
});

test('RED RETRY requests correction with safe reasons while final RED rejects', () => {
  const input = fixture();
  input.status.reviewResult = { reviewAnswer: 'RED', reviewRejectType: 'RETRY', rejectLabels: ['DOCUMENT_EXPIRATION'], moderationComment: 'PRIVATE_COMMENT' };
  const retry = resolveDecision(input);
  assert.equal(retry.status, 'action_required');
  assert.equal(retry.reason, REASONS.expired);
  assert.equal(JSON.stringify(retry).includes('PRIVATE'), false);
  input.status.reviewResult.reviewRejectType = 'FINAL';
  assert.equal(resolveDecision(input).status, 'rejected');
});

test('provider applicant, user, client, type and level must match the server binding', () => {
  for (const change of [
    input => { input.applicant.id = 'different-applicant'; },
    input => { input.applicant.externalUserId = 'different-user'; },
    input => { input.applicant.clientId = 'different-client'; },
    input => { input.applicant.type = 'company'; },
    input => { input.status.levelName = 'different-level'; },
  ]) {
    const input = fixture();
    change(input);
    assert.throws(() => resolveDecision(input), /provider_binding_mismatch/);
  }
});

test('a completed review cannot approve documents submitted after its review time', () => {
  const input = fixture();
  input.user.kycAutomation.submittedAt = new Date('2026-09-24T12:01:01Z');
  assert.equal(resolveDecision(input), null);
});

test('duplicate and older decisions cannot replace the recorded outcome', () => {
  const input = fixture();
  const decision = resolveDecision(input);
  const current = clone(input.user);
  current.kycAutomation.reviewKey = decision.key;
  assert.equal(shouldApply(current, decision), false);
  current.kycAutomation.reviewKey = 'newer-key';
  current.kycAutomation.reviewedAt = new Date(+decision.reviewedAt + 1000);
  assert.equal(shouldApply(current, { ...decision, status: 'rejected' }), false);
});

test('equal-time conflicting outcomes cannot restore approval after correction or rejection', () => {
  const input = fixture();
  const decision = resolveDecision(input);
  for (const status of ['rejected', 'action_required']) {
    const current = clone(input.user);
    Object.assign(current.kycAutomation, { status, reviewedAt: decision.reviewedAt, reviewKey: 'previous-key' });
    assert.equal(shouldApply(current, decision), false);
  }
  const approved = clone(input.user);
  Object.assign(approved.kycAutomation, { status: 'approved', reviewedAt: decision.reviewedAt, reviewKey: 'previous-key' });
  assert.equal(shouldApply(approved, { ...decision, status: 'rejected' }), true);
});

// Each session receives an isolated working copy. Only a fulfilled transaction
// commits it, so a missing session or partial write becomes visible to tests.
// This tests service boundaries; it does not replace Mongo integration tests.
function harness(controls = {}) {
  const input = fixture();
  const env = input.env;
  const clock = { value: new Date(NOW) };
  let state = {
    user: clone(input.user),
    ib: { _id: 'ib-one', email: input.user.email, status: 'pending' },
    job: { _id: 'job-one', userId: input.user._id, applicantId: input.applicant.id,
      state: 'queued', attempts: 0, nextAttemptAt: new Date(NOW), lockedUntil: new Date(0) },
    notices: [],
  };
  const operations = [];
  const transactions = { committed: 0, rolledBack: 0 };
  let statusReads = 0;
  let activeSession;

  function dataFor(session) {
    if (!session) return state;
    assert.equal(session, activeSession, 'a model operation must use the active transaction session');
    return session.data;
  }
  function matches(document, filter) {
    return document && Object.entries(filter).every(([key, value]) => {
      if (value && typeof value === 'object' && !(value instanceof Date)) {
        if ('$in' in value) return value.$in.includes(document[key]);
        if ('$lte' in value) return document[key] <= value.$lte;
        if ('$gt' in value) return document[key] > value.$gt;
      }
      return document[key] === value;
    });
  }
  function apply(document, update) {
    Object.assign(document, clone(update.$set || {}));
    for (const [key, value] of Object.entries(update.$inc || {})) document[key] = (document[key] || 0) + value;
    for (const key of Object.keys(update.$unset || {})) delete document[key];
  }
  function documentFor(kind, session) {
    const value = dataFor(session)[kind];
    if (!value) return null;
    const document = clone(value);
    Object.defineProperty(document, 'save', { enumerable: false, value: async ({ session: saveSession } = {}) => {
      operations.push({ operation: `${kind}.save`, session: saveSession });
      assert.ok(saveSession, `${kind} writes must be transactional`);
      dataFor(saveSession)[kind] = clone(document);
      if (controls.failAt === kind) throw new Error('injected save failure');
      return document;
    } });
    return document;
  }
  function query(read) {
    return { then: (resolve, reject) => Promise.resolve().then(() => read()).then(resolve, reject),
      session: session => Promise.resolve().then(() => read(session)) };
  }
  const User = { findById: id => query(session => {
    operations.push({ operation: 'user.read', session });
    return dataFor(session).user?._id === id ? documentFor('user', session) : null;
  }) };
  const IB = { findOne: filter => query(session => {
    operations.push({ operation: 'ib.read', session });
    return matches(dataFor(session).ib, filter) ? documentFor('ib', session) : null;
  }) };
  const Job = {
    findOne: filter => query(session => {
      operations.push({ operation: 'job.read', session });
      const job = dataFor(session).job;
      return matches(job, filter) ? clone(job) : null;
    }),
    async findOneAndUpdate(filter, update) {
      operations.push({ operation: 'job.claim' });
      if (!matches(state.job, filter)) return null;
      apply(state.job, update);
      return clone(state.job);
    },
    async updateOne(filter, update, { session } = {}) {
      operations.push({ operation: update.$set?.state === 'done' ? 'job.ack' : 'job.retry', session });
      const job = dataFor(session).job;
      if (!matches(job, filter)) return { modifiedCount: 0 };
      apply(job, update);
      if (update.$set?.state === 'done') {
        assert.ok(session, 'final job acknowledgement must be transactional');
        if (controls.failAt === 'ack') throw new Error('injected acknowledgement failure');
      }
      return { modifiedCount: 1 };
    },
  };
  const provider = {
    providerReady: value => value.SUMSUB_MODE === 'production',
    fetchApplicant: async () => clone(input.applicant),
    fetchReviewStatus: async () => {
      statusReads += 1;
      if (statusReads % 2 === 0) controls.onLatestStatus?.({ state, env, input });
      return clone(input.status);
    },
    fetchIdentityStatus: async () => clone(input.identity),
    fetchPoaStatus: async () => clone(input.poa),
  };
  const transaction = async callback => {
    controls.beforeTransaction?.({ state, env, input });
    const session = { data: clone(state) };
    activeSession = session;
    try {
      const result = await callback(session);
      state = session.data;
      transactions.committed += 1;
      return result;
    } catch (error) {
      transactions.rolledBack += 1;
      throw error;
    } finally { activeSession = undefined; }
  };
  const enqueueNotice = async (user, status, reason, eventKey, { session } = {}) => {
    operations.push({ operation: 'notices.enqueue', session });
    assert.ok(session, 'notice writes must be transactional');
    for (const channel of ['email', 'whatsapp']) {
      dataFor(session).notices.push({ userId: user._id, channel, status, reason, eventKey });
    }
    if (controls.failAt === 'notices') throw new Error('injected notice failure');
  };
  const service = createKycReviewService({ User, IB, Job, provider, transaction, enqueueNotice, env, now: () => new Date(clock.value) });
  return { service, controls, input, env, clock, operations, transactions, get state() { return state; } };
}

test('approval commits User, IB, both channel notices and the final job acknowledgement together', async () => {
  const h = harness();
  assert.deepEqual(await h.service.processReviews({ limit: 1 }), { processed: 1 });
  assert.equal(h.state.user.isKycVerified, true);
  assert.equal(h.state.user.isApprovedIB, true);
  assert.equal(h.state.user.kycAutomation.status, 'approved');
  assert.equal(h.state.ib.status, 'approved');
  assert.match(h.state.ib.referralCode, /^IB[A-F\d]{16}$/);
  assert.deepEqual(h.state.notices.map(notice => notice.channel).sort(), ['email', 'whatsapp']);
  assert.ok(h.state.notices.every(notice => notice.status === 'approved' && notice.eventKey === h.state.user.kycAutomation.reviewKey));
  assert.equal(h.state.job.state, 'done');
  assert.equal(h.transactions.committed, 1);
  const writes = h.operations.filter(item => ['user.save', 'ib.save', 'notices.enqueue', 'job.ack'].includes(item.operation));
  assert.equal(writes.length, 4);
  assert.ok(writes.every(item => item.session === writes[0].session));
});

for (const failAt of ['ib', 'notices', 'ack']) {
  test(`${failAt} failure rolls back approval, IB and notices; durable retry later commits once`, async () => {
    const h = harness({ failAt });
    const originalUser = clone(h.state.user);
    const originalIb = clone(h.state.ib);
    assert.deepEqual(await h.service.processReviews({ limit: 1 }), { processed: 0 });
    assert.deepEqual(h.state.user, originalUser);
    assert.deepEqual(h.state.ib, originalIb);
    assert.deepEqual(h.state.notices, []);
    assert.equal(h.state.job.state, 'queued');
    assert.equal(h.state.job.attempts, 1);
    assert.equal(h.state.job.lastError, 'review_retry_required');
    assert.ok(h.state.job.nextAttemptAt > h.clock.value);
    assert.equal(h.state.job.lockToken, undefined);
    assert.equal(h.transactions.rolledBack, 1);
    assert.equal(h.transactions.committed, 0);
    h.controls.failAt = null;
    assert.equal((await h.service.processReviews({ limit: 1 })).processed, 0);
    h.clock.value = new Date(h.state.job.nextAttemptAt);
    assert.equal((await h.service.processReviews({ limit: 1 })).processed, 1);
    assert.equal(h.state.user.isKycVerified, true);
    assert.equal(h.state.ib.status, 'approved');
    assert.equal(h.state.notices.length, 2);
    assert.equal(h.state.job.state, 'done');
    assert.equal(h.state.job.attempts, 2);
  });
}

test('a release gate disabled after provider reads prevents the transaction from approving', async () => {
  const h = harness({ beforeTransaction: ({ env }) => { env.BDFX_KYC_RELEASE_APPROVED = 'false'; } });
  assert.equal((await h.service.processReviews({ limit: 1 })).processed, 0);
  assert.equal(h.state.user.isKycVerified, false);
  assert.equal(h.state.ib.status, 'pending');
  assert.deepEqual(h.state.notices, []);
  assert.equal(h.state.job.state, 'queued');
  assert.equal(h.transactions.committed, 0);
  assert.equal(h.operations.some(item => item.operation === 'user.save'), false);
});

test('disabled reconciliation makes no provider or model reads', async () => {
  const h = harness();
  h.env.BDFX_KYC_AUTOMATION_ENABLED = 'false';
  await assert.rejects(h.service.reconcile(clone(h.state.job)), /review_disabled/);
  assert.deepEqual(await h.service.processReviews(), { disabled: true, processed: 0 });
  assert.equal(h.operations.length, 0);
});

test('the transaction reevaluates country changes made during provider I/O', async () => {
  const h = harness({ onLatestStatus: ({ state }) => { state.user.country = 'ARE'; } });
  assert.equal((await h.service.processReviews({ limit: 1 })).processed, 1);
  assert.equal(h.state.user.isKycVerified, false);
  assert.equal(h.state.user.isApprovedIB, false);
  assert.equal(h.state.user.kycAutomation.status, 'rejected');
  assert.equal(h.state.user.kycAutomation.reason, REASONS.uae);
  assert.equal(h.state.ib.status, 'rejected');
  assert.ok(h.state.notices.every(notice => notice.status === 'rejected'));
});

test('loss of registration verification during provider I/O cannot approve', async () => {
  const h = harness({ onLatestStatus: ({ state }) => { state.user.isVerified = false; } });
  assert.equal((await h.service.processReviews({ limit: 1 })).processed, 0);
  assert.equal(h.state.user.isKycVerified, false);
  assert.equal(h.state.ib.status, 'pending');
  assert.equal(h.state.notices.length, 0);
  assert.equal(h.state.job.state, 'blocked');
});

test('documents resubmitted during provider I/O cannot receive the previous review approval', async () => {
  const h = harness({ onLatestStatus: ({ state }) => {
    state.user.kycAutomation.submittedAt = new Date('2026-09-24T12:01:30Z');
  } });
  assert.equal((await h.service.processReviews({ limit: 1 })).processed, 1);
  assert.equal(h.state.user.isKycVerified, false);
  assert.equal(h.state.user.kycAutomation.status, 'pending');
  assert.equal(h.state.ib.status, 'pending');
  assert.equal(h.state.notices.length, 0);
  assert.equal(h.state.job.state, 'done');
  assert.equal(h.operations.some(item => item.operation === 'user.save'), false);
});

test('a provider result that changes during evidence fetch is retried before any outcome writes', async () => {
  const h = harness({ onLatestStatus: ({ input }) => { input.status.reviewResult.reviewAnswer = 'RED'; } });
  assert.equal((await h.service.processReviews({ limit: 1 })).processed, 0);
  assert.equal(h.state.user.isKycVerified, false);
  assert.equal(h.state.ib.status, 'pending');
  assert.equal(h.state.notices.length, 0);
  assert.equal(h.transactions.committed, 0);
  assert.equal(h.state.job.state, 'queued');
});

test('a stale completed review is acknowledged without changing the newer outcome or resending notices', async () => {
  const h = harness();
  Object.assign(h.state.user, { isKycVerified: true, isApprovedIB: true });
  Object.assign(h.state.user.kycAutomation, { status: 'approved', reviewedAt: new Date('2026-09-24T12:01:30Z'), reviewKey: 'newer-review' });
  Object.assign(h.state.ib, { status: 'approved', referralCode: 'IBEXISTINGCODE' });
  h.input.status.reviewResult = { reviewAnswer: 'RED', reviewRejectType: 'FINAL' };
  const originalUser = clone(h.state.user);
  const originalIb = clone(h.state.ib);
  assert.equal((await h.service.processReviews({ limit: 1 })).processed, 1);
  assert.deepEqual(h.state.user, originalUser);
  assert.deepEqual(h.state.ib, originalIb);
  assert.equal(h.state.notices.length, 0);
  assert.equal(h.state.job.state, 'done');
});
