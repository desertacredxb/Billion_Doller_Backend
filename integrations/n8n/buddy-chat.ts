import { workflow, node, trigger, sticky, expr } from '@n8n/workflow-sdk';

const inbound = trigger({ type: 'n8n-nodes-base.webhook', version: 2.2,
  config: { name: 'BDFX website request', parameters: { httpMethod: 'POST', path: 'bdfx-buddy-v1', authentication: 'none', responseMode: 'responseNode' } },
  output: [{ body: { ticket: 'NON_RUNNABLE_SCHEMA_EXAMPLE' } }] });
const normalize = node({ type: 'n8n-nodes-base.set', version: 3.5,
  config: { name: 'Keep signed request only', parameters: { mode: 'manual', includeOtherFields: false, assignments: { assignments: [
    { id: 'ticket', name: 'ticket', type: 'string', value: expr('{{ $json.body.ticket }}') }
  ] } } }, output: [{ ticket: 'NON_RUNNABLE_SCHEMA_EXAMPLE' }] });
const assistant = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5,
  config: { name: 'Run one signed Buddy question', onError: 'continueErrorOutput', parameters: {
    method: 'POST', url: 'https://billion-doller-backend.onrender.com/api/support-chat/n8n/complete', authentication: 'none',
    sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: expr('{{ { ticket: $json.ticket } }}'),
    options: { timeout: 9500, redirect: { redirect: { followRedirects: false } }, response: { response: { responseFormat: 'json' } } }
  } }, output: [{ answer: 'Use Continue to Verify in the secure client area.', language: 'en' }] });
const reply = node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.5,
  config: { name: 'Reply to BDFX backend', parameters: { respondWith: 'json', responseBody: expr('{{ $json }}'), options: { responseCode: 200, enableStreaming: false } } },
  output: [{ answer: 'Use Continue to Verify in the secure client area.', language: 'en' }] });
const unavailable = node({ type: 'n8n-nodes-base.respondToWebhook', version: 1.5,
  config: { name: 'Return unavailable for local guide', parameters: { respondWith: 'json', responseBody: '{"code":"ASSISTANT_UNAVAILABLE"}', options: { responseCode: 503, enableStreaming: false } } },
  output: [{ code: 'ASSISTANT_UNAVAILABLE' }] });
const setup = sticky('## Signed single-question delegation\nOnly the BDFX backend can mint a valid ticket. Tickets expire in 30 seconds, are bound to one consented question and are consumed once before any AI call. Invalid or replayed tickets cannot use the model. Provider keys stay in the existing backend; no static key is embedded here. The backend caps input/output, disables provider request storage, reserves at most 200 requests per UTC date and exports no customer records. Keep success/error/manual execution payload saving OFF. This workflow has no payment, registration, OTP or report access. The separate first-class agent remains an unpublished alternative requiring its own model credential.');
export default workflow('bdfx-buddy-chat-v1', 'BDFX | Buddy website chat')
  .add(inbound).to(normalize).to(assistant.to(reply))
  .add(assistant.onError(unavailable)).add(setup)
  .group('Signed website guidance', [normalize, assistant], { description: 'One short-lived command through the existing backend AI connection; failures return to the local website guide.' });
