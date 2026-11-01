function formatBdfxDailyReport(input, now = new Date(), test = false) {
  const local = new Date(now.getTime() + 4 * 3600000).toISOString();
  const date = local.slice(0, 10), time = local.slice(11, 16);
  const header = `${test ? 'TEST • ' : ''}BDFX DAILY REPORT\nDubai: ${date} ${time}`;
  const data = input && Object.hasOwn(input, 'body') ? input.body : input;
  try {
    const validCount = value => { if (!Number.isSafeInteger(value) || value < 0) throw new Error(); return value; };
    const generated = new Date(data.generatedAt);
    if (input.statusCode && input.statusCode !== 200) throw new Error();
    if (data.version !== 1 || data.source !== 'BDFX daily operations' || data.period?.timezone !== 'Asia/Dubai' || data.period.date !== date || !Number.isFinite(generated.getTime()) || Math.abs(now - generated) > 120000) throw new Error();
    const clients = data.registeredClients, registrations = data.newRegistrations;
    for (const row of [clients, registrations]) if (validCount(row.total) !== validCount(row.kycApproved) + validCount(row.kycNotApproved)) throw new Error();
    if (registrations.total > clients.total) throw new Error();
    const dep = data.depositRequestsToday, pay = data.withdrawalRequestsToday;
    for (const row of [dep, pay]) if (validCount(row.total) !== Object.values(row.byStatus).reduce((sum, value) => sum + validCount(value), 0)) throw new Error();
    const c = validCount, lines = [header, `Today: 00:00–${new Date(generated.getTime() + 4 * 3600000).toISOString().slice(11,16)} Dubai`, '',
      `NEW REGISTRATIONS: ${c(registrations.total)}`,
      `• KYC approved: ${c(registrations.kycApproved)}`,
      `• KYC not approved: ${c(registrations.kycNotApproved)}`, '',
      `REGISTERED CLIENTS: ${c(clients.total)}`,
      `• KYC approved: ${c(clients.kycApproved)}`,
      `• KYC not approved: ${c(clients.kycNotApproved)}`,
      `  Not started: ${c(clients.byKycStatus.not_started)} | In progress: ${c(clients.byKycStatus.in_progress)}`,
      `  Review: ${c(clients.byKycStatus.review)} | Resubmit: ${c(clients.byKycStatus.resubmission_requested)}`,
      `  Declined: ${c(clients.byKycStatus.declined)} | Other unapproved: ${c(clients.byKycStatus.other_non_approved + clients.byKycStatus.other)}`, '',
      `DEPOSIT REQUESTS TODAY: ${c(dep.total)}`,
      `Success: ${c(dep.byStatus.SUCCESS)} | Pending: ${c(dep.byStatus.PENDING)} | Partial: ${c(dep.byStatus.PARTIALLY_PAID)} | Failed: ${c(dep.byStatus.FAILED)} | Other: ${c(dep.byStatus.other)}`, '',
      `WITHDRAWAL REQUESTS TODAY: ${c(pay.total)}`,
      `Completed: ${c(pay.byStatus.Completed)} | Pending: ${c(pay.byStatus.Pending)} | Processing: ${c(pay.byStatus.Processing)} | Failed: ${c(pay.byStatus.Failed)} | Rejected: ${c(pay.byStatus.Rejected)} | Other: ${c(pay.byStatus.other)}`,
      `All pending/processing withdrawals: ${c(data.queues.pendingWithdrawals)}`, '',
      `New MT5 live accounts: ${c(data.newLiveAccounts)}`,
      `Open tickets: ${c(data.queues.openTickets)} | Pending IB: ${c(data.queues.pendingIbApplications)}`, '',
      'BUDDY • CONSENTED SAVED SESSIONS',
      `Started: ${c(data.buddy.sessionsStarted)} | With activity: ${c(data.buddy.sessionsWithActivity)}`,
      `Contact requests: ${c(data.buddy.contactRequests)} | Support handoffs: ${c(data.buddy.supportHandoffs)}`, '',
      'Non-approved includes pending/incomplete KYC; not all are rejections. New registrations exclude unfinished OTP attempts.',
      'Payment counts show current status of requests created today, not bank settlement amounts. Queues are current snapshots. Buddy does not count unsaved visits.',
      `Source checked: ${generated.toISOString()}`,
    ];
    return { summary: lines.join('\n'), sourceVerified: true, generatedAt: data.generatedAt, periodDate: date };
  } catch {
    return { summary: `${header}\n\nBDFX source unavailable or unverified. No client, KYC or payment totals are reported as zero. Please check the BDFX reporting connection.`, sourceVerified: false, generatedAt: now.toISOString(), periodDate: date };
  }
}
module.exports = { formatBdfxDailyReport };
