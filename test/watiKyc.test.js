const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const axios = require('axios');
const { sendKycWhatsApp } = require('../services/watiKyc');

test('does not send when the BDFX sender or approved template is missing', async () => {
  delete process.env.BDFX_WATI_KYC_REJECTED_TEMPLATE;
  const post = mock.method(axios, 'post', async () => { throw new Error('unexpected send'); });
  try { assert.equal(await sendKycWhatsApp('+447911123456', 'rejected', 'Unsupported ID'), false); }
  finally { post.mock.restore(); }
});

test('uses the configured rejection template and passes only its reason', async () => {
  Object.assign(process.env, {
    BDFX_WATI_BASE_URL: 'https://example.wati.io/tenant', BDFX_WATI_API_TOKEN: 'test-token',
    BDFX_WATI_CHANNEL_NUMBER: '441157911131', BDFX_WATI_KYC_REJECTED_TEMPLATE: 'bdfx_kyc_rejected',
  });
  let sent;
  const post = mock.method(axios, 'post', async (...args) => { sent = args; return { status: 200, data: { result: true } }; });
  try {
    assert.equal(await sendKycWhatsApp('+447911123457', 'rejected', 'UAE IDs are not accepted'), true);
    assert.equal(sent[0], 'https://example.wati.io/tenant/api/v1/sendTemplateMessage');
    assert.equal(sent[1].template_name, 'bdfx_kyc_rejected');
    assert.equal(sent[1].channel_number, '441157911131');
    assert.deepEqual(sent[1].parameters, [{ name: '1', value: 'UAE IDs are not accepted' }]);
    assert.equal(sent[2].params.whatsappNumber, '447911123457');
  } finally { post.mock.restore(); }
});

test('refuses to route BDFX notifications through any other WATI channel', async () => {
  process.env.BDFX_WATI_CHANNEL_NUMBER = '+447911123456';
  const post = mock.method(axios, 'post', async () => { throw new Error('unexpected send'); });
  try { assert.equal(await sendKycWhatsApp('+447911123457', 'rejected', 'Unsupported ID'), false); }
  finally { post.mock.restore(); }
});

test('uses the confirmed BDFX WATI sender when no override is configured', async () => {
  delete process.env.BDFX_WATI_CHANNEL_NUMBER;
  let sender;
  const post = mock.method(axios, 'post', async (url, body) => {
    sender = body.channel_number;
    return { status: 200, data: { result: true } };
  });
  try {
    assert.equal(await sendKycWhatsApp('+447911123457', 'rejected', 'Unsupported ID'), true);
    assert.equal(sender, '441157911131');
  } finally { post.mock.restore(); }
});

test('uses a separate correction template for resubmission notices', async () => {
  process.env.BDFX_WATI_KYC_RESUBMISSION_TEMPLATE = 'bdfx_kyc_resubmission';
  let body;
  const post = mock.method(axios, 'post', async (url, value) => {
    body = value;
    return { status: 200, data: { result: true } };
  });
  try {
    assert.equal(await sendKycWhatsApp('+447911123457', 'resubmission', 'Please correct your document.'), true);
    assert.equal(body.template_name, 'bdfx_kyc_resubmission');
    assert.equal(body.channel_number, '441157911131');
    assert.deepEqual(body.parameters, [{ name: '1', value: 'Please correct your document.' }]);
  } finally { post.mock.restore(); }
});

test('does not report an ambiguous HTTP 200 response as provider acceptance', async () => {
  const post = mock.method(axios, 'post', async () => ({ status: 200, data: {} }));
  try { await assert.rejects(sendKycWhatsApp('+447911123457', 'rejected', 'Unsupported ID'), /WATI rejected/); }
  finally { post.mock.restore(); }
});

test('refuses an insecure WATI endpoint before transmitting the token', async () => {
  const previous = process.env.BDFX_WATI_BASE_URL;
  process.env.BDFX_WATI_BASE_URL = 'http://example.wati.io/tenant';
  const post = mock.method(axios, 'post', async () => { throw new Error('unexpected send'); });
  try { assert.equal(await sendKycWhatsApp('+447911123457', 'rejected', 'Unsupported ID'), false); }
  finally { process.env.BDFX_WATI_BASE_URL = previous; post.mock.restore(); }
});
