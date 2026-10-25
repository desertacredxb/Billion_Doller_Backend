import { workflow, node, trigger, sticky, newCredential, expr } from '@n8n/workflow-sdk';

const start = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Read Buddy report' }, output: [{}] });
const fetchReport = node({ type: 'n8n-nodes-base.httpRequest', version: 4.5,
  config: { name: 'Read consented BDFX aggregates', executeOnce: true, parameters: {
    method: 'GET', url: 'https://billion-doller-backend.onrender.com/api/support-chat/n8n/report?days=7',
    authentication: 'genericCredentialType', genericAuthType: 'httpTemplatedCustomAuth',
    options: { timeout: 10000, redirect: { redirect: { followRedirects: false } }, response: { response: { responseFormat: 'json' } } }
  }, credentials: { httpTemplatedCustomAuth: newCredential('BDFX Reports read-only') } },
  output: [{ version: 1, source: 'Schema example only', generatedAt: '2026-10-25T14:00:00Z', period: { from: '2026-10-19', to: '2026-10-25', timezone: 'Asia/Dubai' }, sessionsStarted: 0, sessionsWithActivity: 0, contactRequests: 0, supportHandoffs: 0, topicSelections: {}, eventsByLanguage: {}, answersViewed: {}, coverage: 'Saved sessions only; example schema, not a live report.' }] });
const format = node({ type: 'n8n-nodes-base.set', version: 3.5,
  config: { name: 'Buddy report', executeOnce: true, parameters: { mode: 'manual', includeOtherFields: true, assignments: { assignments: [
    { id: 'summary', name: 'summary', type: 'string', value: expr('BDFX Buddy report | {{ $json.period.from }} to {{ $json.period.to }} (Dubai)\nSessions started: {{ $json.sessionsStarted }}\nSessions with activity: {{ $json.sessionsWithActivity }}\nContact requests: {{ $json.contactRequests }}\nSupport handoffs: {{ $json.supportHandoffs }}\nTopic selections: {{ JSON.stringify($json.topicSelections) }}\nLanguages (events): {{ JSON.stringify($json.eventsByLanguage) }}\nCoverage: {{ $json.coverage }}\nGenerated at: {{ $json.generatedAt }}') }
  ] } } }, output: [{ summary: 'Example report layout only; connect the read-only credential to obtain real aggregates.' }] });
const setup = sticky('## Read-only report setup\nConfigure BDFX Reports read-only as a templated HTTP credential: {"headers":{"X-BDFX-Report-Key":"{{api_key}}"}}. Enter the secret in the credential UI; store the matching value only in Render BDFX_N8N_REPORT_TOKEN. Run manually after the backend route is deployed. This flow exports counts only, no contact details, private transcripts or financial records. No email/WhatsApp delivery or schedule is configured.');
export default workflow('bdfx-buddy-report-v1', 'BDFX | Buddy interaction report')
  .add(start).to(fetchReport).to(format).add(setup)
  .group('Consented activity report', [fetchReport, format], { description: 'Reads trusted aggregate support metrics and formats one report; no customer records or outbound messages.' });
