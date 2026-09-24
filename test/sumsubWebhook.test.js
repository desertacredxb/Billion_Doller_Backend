const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validDigest, handleWebhook } = require('../controllers/sumsubController');

test('checks HMAC over the exact raw webhook bytes', () => {
  process.env.SUMSUB_WEBHOOK_SECRET = 'test-only-secret';
  const raw = Buffer.from('{"type":"applicantReviewed"}');
  const digest = crypto.createHmac('sha256', process.env.SUMSUB_WEBHOOK_SECRET).update(raw).digest('hex');
  const headers = { 'x-payload-digest-alg': 'HMAC_SHA256_HEX', 'x-payload-digest': digest };
  assert.equal(validDigest(raw, headers), true);
  assert.equal(validDigest(Buffer.from('{"type": "applicantReviewed"}'), headers), false);
  assert.equal(validDigest(raw, { ...headers, 'x-payload-digest-alg': 'SHA256' }), false);
});

test('ignores a signed sandbox review even when automation is enabled', async () => {
  process.env.BDFX_KYC_AUTOMATION_ENABLED = 'true';
  process.env.SUMSUB_MODE = 'production';
  process.env.SUMSUB_WEBHOOK_SECRET = 'test-only-secret';
  const raw = Buffer.from(JSON.stringify({ type: 'applicantReviewed', testMode: true,
    levelName: 'bdfx-kyc-sandbox', externalUserId: '507f1f77bcf86cd799439011', applicantId: 'r1', sandboxMode: true,
    applicantType: 'individual', reviewStatus: 'completed',
    reviewResult: { reviewAnswer: 'GREEN' } }));
  const headers = { 'x-payload-digest-alg': 'HMAC_SHA256_HEX',
    'x-payload-digest': crypto.createHmac('sha256', process.env.SUMSUB_WEBHOOK_SECRET).update(raw).digest('hex') };
  const response = { sendStatus(code) { this.code = code; return this; } };
  await handleWebhook({ body: raw, headers }, response);
  assert.equal(response.code, 200);
  await handleWebhook({ body: Buffer.from('{}'), headers }, response);
  assert.equal(response.code, 401);
});
