const test = require('node:test'), assert = require('node:assert/strict');
const express = require('express');
const { createDailyReportService, clientTotals, totals, DEPOSIT } = require('../services/bdfxDailyReport.service');
const { createRouter } = require('../routes/buddyN8nRoutes');
const at = new Date('2026-11-01T14:30:00.000Z');
function fixture(overrides = {}) {
  const queries = {};
  const aggregate = (name, data) => ({ aggregate: pipeline => { queries[name] = pipeline; return Promise.resolve(data); } });
  const counter = (name, value) => ({ countDocuments: filter => { queries[name] = filter; return Promise.resolve(value); } });
  return { queries, service: createDailyReportService({ now: () => at,
    users: aggregate('users', [{ all: [{ _id:'approved',count:100 },{ _id:'declined',count:3 },{ _id:'review',count:2 }], today:[{ _id:'approved',count:4 },{ _id:'not_started',count:2 }] }]),
    orders: aggregate('deposits', [{ _id:'SUCCESS',count:3 },{ _id:'PENDING',count:1 }]),
    withdrawals: { ...aggregate('payouts', [{ _id:'Completed',count:2 }]), ...counter('pendingPayouts',5) },
    accounts: counter('accounts',4), tickets:counter('tickets',2), ibs:counter('ibs',1),
    buddy:async days=>{ assert.equal(days,'1'); return {sessionsStarted:6,sessionsWithActivity:5,contactRequests:1,supportHandoffs:2,email:'private@example.invalid'}; }, ...overrides }) };
}
test('daily report separates all-client and new-registration KYC counts without exposing personal data', async()=>{
  const {service}=fixture();const report=await service();
  assert.equal(report.registeredClients.total,105);assert.equal(report.registeredClients.kycApproved,100);assert.equal(report.registeredClients.kycNotApproved,5);
  assert.equal(report.newRegistrations.total,6);assert.equal(report.newRegistrations.kycApproved,4);assert.equal(report.newRegistrations.kycNotApproved,2);
  assert.equal(report.depositRequestsToday.byStatus.SUCCESS,3);assert.equal(report.withdrawalRequestsToday.byStatus.Completed,2);
  assert.equal(report.queues.pendingWithdrawals,5);assert.equal(report.buddy.sessionsStarted,6);
  assert.equal(JSON.stringify(report).includes('private@example.invalid'),false);
  assert.match(report.notes.join(' '),/unfinished OTP attempts are excluded/);assert.match(report.notes.join(' '),/does not mean all were rejected/);
});
test('Dubai cumulative reporting bounds stop at the actual check time and account counts exclude demo accounts',async()=>{
  const {service,queries}=fixture();const report=await service();
  assert.equal(report.period.date,'2026-11-01');assert.equal(report.period.start,'2026-10-31T20:00:00.000Z');assert.equal(report.period.asOf,at.toISOString());
  assert.deepEqual(queries.deposits[0].$match.createdAt,{$gte:new Date('2026-10-31T20:00:00.000Z'),$lte:at});
  assert.equal(queries.users[0].$match.isVerified,true);assert.equal(queries.accounts.accountType,'LIVE');
  assert.equal(queries.users[1].$project._id,0);assert.deepEqual(Object.keys(queries.users[1].$project).sort(),['_id','createdAt','kycState']);
});
test('unknown status labels cannot inject contact data into an aggregate report and invalid counts are rejected',()=>{
  const summary=totals([{_id:'private@example.invalid',count:2}],DEPOSIT);assert.equal(summary.byStatus.other,2);assert.equal(JSON.stringify(summary).includes('@'),false);
  for(const count of [-1,0.2,Infinity,NaN,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>clientTotals([{_id:'approved',count}]));
  assert.equal(clientTotals([]).total,0);
});
test('unavailable data fails the report instead of substituting zero counts',async()=>{
  await assert.rejects(fixture({users:{aggregate:async()=>{throw new Error('private db error');}}}).service());
  await assert.rejects(fixture({users:{aggregate:async()=>[]}}).service());
});
async function withServer(env, dailyReport, run) {
  const app=express();app.use('/n8n',createRouter({env,dailyReport,worker:{complete:async()=>({})},buddy:{available:()=>false}}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try{await run(`http://127.0.0.1:${server.address().port}/n8n`);}finally{await new Promise(resolve=>server.close(resolve));}
}
test('business report credential authorizes only the aggregate GET route and legacy/chat keys cannot read it',async()=>{
  const token='b'.repeat(64),env={BDFX_N8N_BUSINESS_REPORT_TOKEN:token,BDFX_N8N_REPORT_TOKEN:'c'.repeat(64),BDFX_BUDDY_N8N_TOKEN:'d'.repeat(64)};let calls=0;
  await withServer(env,async()=>{calls++;return {version:1};},async base=>{
    for(const key of ['',env.BDFX_N8N_REPORT_TOKEN,env.BDFX_BUDDY_N8N_TOKEN,'x'.repeat(64)]) assert.equal((await fetch(base+'/business-report',{headers:{'X-BDFX-Business-Report-Key':key}})).status,401);
    assert.equal(calls,0);
    const headers={'X-BDFX-Business-Report-Key':token};const response=await fetch(base+'/business-report',{headers});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(calls,1);
    assert.equal((await fetch(base+'/business-report?date=2026-11-01',{headers})).status,400);
    assert.equal((await fetch(base+'/report?days=1',{headers})).status,401);
    assert.equal((await fetch(base+'/business-report',{method:'POST',headers})).status,404);
  });
  await withServer({...env,BDFX_N8N_BUSINESS_REPORT_TOKEN:env.BDFX_BUDDY_N8N_TOKEN},async()=>assert.fail(),async base=>assert.equal((await fetch(base+'/business-report',{headers:{'X-BDFX-Business-Report-Key':env.BDFX_BUDDY_N8N_TOKEN}})).status,401));
});
test('business report errors return a redacted unavailable response',async()=>{
  const token='e'.repeat(64);await withServer({BDFX_N8N_BUSINESS_REPORT_TOKEN:token},async()=>{throw new Error('private@example.invalid');},async base=>{
    const response=await fetch(base+'/business-report',{headers:{'X-BDFX-Business-Report-Key':token}});assert.equal(response.status,503);assert.deepEqual(await response.json(),{code:'REPORT_UNAVAILABLE'});
  });
});
const {formatBdfxDailyReport}=require('../integrations/n8n/bdfx-report-format');
test('Telegram summary separates approved and non-approved registrations and labels the source coverage',async()=>{
 const report=await fixture().service();const formatted=formatBdfxDailyReport({statusCode:200,body:report},at,true);
 assert.equal(formatted.sourceVerified,true);assert.match(formatted.summary,/TEST • BDFX DAILY REPORT/);assert.match(formatted.summary,/NEW REGISTRATIONS: 6/);assert.match(formatted.summary,/KYC approved: 4/);assert.match(formatted.summary,/KYC not approved: 2/);assert.match(formatted.summary,/not all are rejections/);assert.ok(formatted.summary.length<4096);
});
test('Telegram never represents unauthorized, missing, stale or inconsistent data as zero business',async()=>{
 const report=await fixture().service();
 for(const bad of [{statusCode:401,body:report},{error:'private key must not be repeated'},null,{...report,generatedAt:'2026-10-31T14:00:00Z'},{...report,newRegistrations:{total:6,kycApproved:4,kycNotApproved:1}}]){
  const formatted=formatBdfxDailyReport(bad,at);assert.equal(formatted.sourceVerified,false);assert.match(formatted.summary,/unavailable or unverified/);assert.equal(formatted.summary.includes('private key'),false);assert.equal(formatted.summary.includes('NEW REGISTRATIONS: 0'),false);
 }
});
