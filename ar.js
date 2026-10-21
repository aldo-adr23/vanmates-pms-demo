/* AR (portal): accounts receivable, read-only — what customers owe, straight from QuickBooks.
   Reads ar_open_invoices / ar_unapplied_payments / ar_sync_runs through RLS (ar-2026-10-19.sql): admins, accountants and
   anyone granted the "ar" page. Lu (the Slack bookkeeper) replaces the copy every 2 hours (8:50-20:50, full at 6:50 Vancouver).
   Nothing here writes anywhere: QuickBooks stays the system of record.
   Tenant link = tenant_qb_links (Lu's nightly tenant sync) + window.tenants. Unlinked customers (agencies, partners,
   tenants Lu could not match) show as "Other".
   Loaded by index.html after the main script (uses esc, showToast, CURRENT_USER, window.tenants, window.vmDb.sb,
   openTenant and the shared detail panel). */
(function(){
  const BUCKETS = [['current', 'Not due yet'], ['1-30', '1–30 days'], ['31-60', '31–60 days'], ['61-90', '61–90 days'], ['90+', '90+ days']];
  const KINDS = [['', 'All customers'], ['tenant', 'Tenants'], ['other', 'Other (agencies, partners, not linked)']];
  const STALE_HOURS = 6;
  const COLS = 7;

  // ── pure helpers (window.AR_CORE, tested in test/ar.test.js) ──
  const DAY = 86400000;
  const daysLate = (due, today) => (due ? Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(String(due).slice(0, 10) + 'T00:00:00Z')) / DAY) : 0);
  function bucketOf(due, today){
    const d = daysLate(due, today);
    return d <= 0 ? 'current' : d <= 30 ? '1-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : '90+';
  }
  const emptyBuckets = () => ({ current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 });
  const money = (cents) => (cents == null || !isFinite(Number(cents)) ? '—' : (Number(cents) < 0 ? '−' : '') + '$' + (Math.abs(Number(cents)) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const moneyShort = (cents) => { const v = Math.abs(Number(cents) || 0) / 100; return (Number(cents) < 0 ? '−' : '') + '$' + (v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e4 ? Math.round(v / 1e3) + 'k' : v.toLocaleString('en-CA', { maximumFractionDigits: 0 })); };
  const addDays = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);

  // Header numbers. Due-soon windows count invoices not yet late whose due date is within N days (today included).
  function summarize(invoices, unapplied, today){
    const b = emptyBuckets();
    let open = 0, due7 = 0, due30 = 0;
    const customers = new Set();
    for (const i of invoices) {
      const c = Number(i.balance_cents) || 0;
      open += c; b[bucketOf(i.due_date, today)] += c; customers.add(String(i.customer_id));
      const d = daysLate(i.due_date, today);
      if (d <= 0 && d > -7) due7 += c;
      if (d <= 0 && d > -30) due30 += c;
    }
    const un = (unapplied || []).reduce((s, p) => s + (Number(p.unapplied_cents) || 0), 0);
    return { openCents: open, overdueCents: open - b.current, over90Cents: b['90+'], due7Cents: due7, due30Cents: due30, buckets: b,
      invoiceCount: invoices.length, customerCount: customers.size, unappliedCents: un, unappliedCount: (unapplied || []).length };
  }

  // QuickBooks customer id -> portal tenant (prefers a current tenant when several share one customer).
  function tenantIndex(links, tenants){
    const byId = new Map((tenants || []).filter(t => t && t.id != null).map(t => [String(t.id), t]));
    const idx = new Map();
    const rank = (t) => (/^(active|current|notice)/i.test(String(t.status || '')) ? 0 : 1);
    for (const l of links || []) {
      const t = byId.get(String(l.tenant_id));
      if (!t) continue;
      const k = String(l.qb_customer_id), prev = idx.get(k);
      if (!prev) idx.set(k, { tenant: t, count: 1 });
      else { prev.count++; if (rank(t) < rank(prev.tenant)) prev.tenant = t; }
    }
    return idx;
  }

  // One row per QuickBooks customer: what they owe, how late, who they are in the portal.
  function customerRows(invoices, unapplied, idx, today){
    const m = new Map();
    const get = (id, name) => {
      let r = m.get(id);
      if (!r) {
        const hit = idx.get(id);
        const t = hit ? hit.tenant : null;
        r = { customerId: id, name: name || '', kind: t ? 'tenant' : 'other', tenantId: t ? String(t.id) : null, tenantName: t ? (t.name || '') : '',
          tenantCount: hit ? hit.count : 0, property: t ? (t.property || '') : '', city: t ? (t.city || '') : '', email: '',
          openCents: 0, overdueCents: 0, buckets: emptyBuckets(), oldestDue: null, maxDays: 0, invoices: [], unappliedCents: 0, payments: [] };
        m.set(id, r);
      }
      if (!r.name && name) r.name = name;
      return r;
    };
    for (const i of invoices) {
      const r = get(String(i.customer_id), i.customer_name);
      const c = Number(i.balance_cents) || 0, bk = bucketOf(i.due_date, today), d = daysLate(i.due_date, today);
      r.openCents += c; r.buckets[bk] += c; if (bk !== 'current') r.overdueCents += c;
      if (d > r.maxDays) r.maxDays = d;
      if (i.due_date && (!r.oldestDue || i.due_date < r.oldestDue)) r.oldestDue = i.due_date;
      if (!r.email && i.bill_email) r.email = i.bill_email;
      r.invoices.push(i);
    }
    for (const p of unapplied || []) { const r = get(String(p.customer_id), p.customer_name); r.unappliedCents += Number(p.unapplied_cents) || 0; r.payments.push(p); }
    for (const r of m.values()) r.invoices.sort((a, b) => String(a.due_date || '').localeCompare(String(b.due_date || '')));
    return [...m.values()];
  }

  // Filters shared by both tabs. bucket '' = any; 'overdue' = anything late.
  function matches(r, f){
    if (f.kind && r.kind !== f.kind) return false;
    if (f.city && (f.city === '—' ? !!r.city : String(r.city || '').slice(0, 3).toLowerCase() !== f.city.slice(0, 3).toLowerCase())) return false;
    if (f.bucket === 'overdue' && !(r.overdueCents > 0)) return false;
    if (f.bucket === 'unapplied' && !(r.unappliedCents > 0)) return false;
    if (f.bucket && !['overdue', 'unapplied'].includes(f.bucket) && !(r.buckets[f.bucket] > 0)) return false;
    const q = String(f.q || '').trim().toLowerCase();
    if (q && ![r.name, r.tenantName, r.property, r.city, r.email, r.customerId, ...r.invoices.map(i => i.doc_number)].some(v => String(v || '').toLowerCase().includes(q))) return false;
    return true;
  }
  // Invoices tab: which of a matching customer's invoices to list for the chosen bucket.
  function invoiceInBucket(i, bucket, today){
    if (!bucket || bucket === 'unapplied') return true;
    if (bucket === 'overdue') return daysLate(i.due_date, today) > 0;
    return bucketOf(i.due_date, today) === bucket;
  }
  // Customers: most overdue money first, then most open.
  const sortCustomers = (list) => list.slice().sort((a, b) => b.overdueCents - a.overdueCents || b.openCents - a.openCents || String(a.name).localeCompare(String(b.name)));

  const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function customersCsv(list){
    const head = ['QuickBooks customer', 'Customer #', 'Type', 'Portal tenant', 'Property', 'City', 'Email', 'Open', 'Overdue', 'Not due yet', '1-30', '31-60', '61-90', '90+', 'Unapplied credit', 'Oldest due', 'Open invoices'];
    const amt = (c) => (Number(c || 0) / 100).toFixed(2);
    return [head, ...list.map(r => [r.name, r.customerId, r.kind === 'tenant' ? 'Tenant' : 'Other', r.tenantName, r.property, r.city, r.email, amt(r.openCents), amt(r.overdueCents),
      amt(r.buckets.current), amt(r.buckets['1-30']), amt(r.buckets['31-60']), amt(r.buckets['61-90']), amt(r.buckets['90+']), amt(r.unappliedCents), r.oldestDue || '', r.invoices.length])]
      .map(row => row.map(csvCell).join(',')).join('\n');
  }
  function invoicesCsv(rows, today){
    const head = ['Invoice #', 'QuickBooks id', 'Customer', 'Customer #', 'Type', 'Property', 'City', 'Invoice date', 'Due date', 'Days late', 'Total', 'Balance', 'Class', 'Item', 'Email status'];
    return [head, ...rows.map(({ i, c }) => [i.doc_number, i.qb_invoice_id, i.customer_name, i.customer_id, c.kind === 'tenant' ? 'Tenant' : 'Other', c.property, c.city, i.txn_date, i.due_date,
      Math.max(0, daysLate(i.due_date, today)), (Number(i.total_cents) / 100).toFixed(2), (Number(i.balance_cents) / 100).toFixed(2), i.class_name, i.item_name, i.email_status])]
      .map(row => row.map(csvCell).join(',')).join('\n');
  }

  // How old the copy is. No run yet = never synced.
  function freshness(lastRun, now){
    if (!lastRun || !lastRun.synced_at) return { stale: true, hours: null };
    const h = (now - new Date(lastRun.synced_at).getTime()) / 3600000;
    return { stale: h > STALE_HOURS, hours: h };
  }
  const qboInvoiceUrl = (id) => 'https://qbo.intuit.com/app/invoice?txnId=' + encodeURIComponent(id);
  const qboCustomerUrl = (id) => 'https://qbo.intuit.com/app/customerdetail?nameId=' + encodeURIComponent(id);
  // Same rule as vm_ar_member(): admins, accountants, and anyone granted the AR page.
  const canSee = (u) => !!u && (['admin', 'accountant'].includes(String(u.role || '')) || (Array.isArray(u.allowed_pages) && u.allowed_pages.includes('ar')));

  const qboPaymentUrl = (id) => 'https://qbo.intuit.com/app/recvpayment?txnId=' + encodeURIComponent(id);

  // Incoming tab (phase 2): Stripe / e-transfer payments Lu saw arrive, checked against the payments in QuickBooks.
  // Problems first: entered twice, not in QuickBooks, needs a person's check.
  const INCOMING = {
    duplicate: ['Entered twice', 'red', 'Lu posted it and a matching payment was also entered by hand'],
    missing: ['Not in QuickBooks', 'red', 'No matching QuickBooks payment after 3 days (or it was booked another way, e.g. inside a deposit)'],
    possible: ['Check match', 'amber', 'A QuickBooks payment has the same amount but nothing ties it to this payer'],
    waiting: ['Waiting', '', 'Received in the last 3 days; bookkeepers usually enter it within 1–3 days'],
    recorded: ['In QuickBooks', 'green', 'Found in QuickBooks'],
    posted_by_lu: ['Posted by Lu', 'blue', 'Lu entered it in QuickBooks'],
  };
  const INCOMING_ORDER = Object.keys(INCOMING);
  const isIncomingProblem = (r) => ['duplicate', 'missing', 'possible'].includes(r.state);
  function incomingSummary(rows){
    const s = { count: rows.length, cents: 0, recorded: 0, problems: 0, missingCents: 0, byState: {} };
    for (const r of rows) {
      const c = Number(r.amount_cents || 0);
      s.cents += c;
      s.byState[r.state] = (s.byState[r.state] || 0) + 1;
      if (r.state === 'recorded' || r.state === 'posted_by_lu') s.recorded++;
      if (isIncomingProblem(r)) s.problems++;
      if (r.state === 'missing' || r.state === 'duplicate') s.missingCents += c;
    }
    return s;
  }
  const sortIncoming = (rows) => rows.slice().sort((a, b) => INCOMING_ORDER.indexOf(a.state) - INCOMING_ORDER.indexOf(b.state) || String(b.received_on || '').localeCompare(String(a.received_on || '')) || Number(b.proposal_id) - Number(a.proposal_id));
  function incomingMatches(r, q, state){
    if (state === 'problems' ? !isIncomingProblem(r) : state && r.state !== state) return false;
    const n = String(q || '').trim().toLowerCase();
    if (!n) return true;
    return [r.payer_name, r.payer_email, r.memo, r.qb_customer_name, r.suggested_customer_name, r.source_ref, r.qb_payment_id, money(r.amount_cents)].some(v => String(v || '').toLowerCase().includes(n));
  }
  function incomingCsv(rows){
    const head = ['Received', 'Source', 'Reference', 'Payer', 'Payer email', 'Amount', 'Status', 'QuickBooks payment', 'QuickBooks customer', 'QuickBooks date', 'Matched by', 'Suggested customer', 'Possible QuickBooks payments', 'Memo'];
    const lines = rows.map(r => [r.received_on, r.source === 'stripe' ? 'Stripe' : 'e-Transfer', r.source_ref, r.payer_name, r.payer_email, (Number(r.amount_cents || 0) / 100).toFixed(2),
      (INCOMING[r.state] || [r.state])[0], r.qb_payment_id, r.qb_customer_name, r.qb_txn_date || '', r.how, r.suggested_customer_name, (r.candidates || []).join(' '), r.memo]);
    return [head, ...lines].map(l => l.map(csvCell).join(',')).join('\n');
  }

  // Billing tab (phase 3b): QuickBooks recurring rent vs the portal's tenants, checked by Lu every morning.
  const BILLING = {
    billed_after_leaving: ['Billed after leaving', 'red', 'A QuickBooks recurring invoice bills after the lease ends, or the tenant has moved out'],
    billed_twice: ['Billed twice', 'red', 'Two recurring invoices bill this tenant on the same date'],
    not_billed: ['Not billed', 'amber', 'Staying next month but no QuickBooks recurring rent bills it (paid up front or by an agency? otherwise set it up)'],
    amount_differs: ['Amount differs', '', 'The recurring amount matches neither the portal rent nor rent + 3% fee'],
  };
  const sortBilling = (rows) => rows.slice().sort((a, b) => Object.keys(BILLING).indexOf(a.kind) - Object.keys(BILLING).indexOf(b.kind) || Number(b.rent_cents || b.template_cents || 0) - Number(a.rent_cents || a.template_cents || 0));
  function billingMatches(r, q, kind){
    if (kind && r.kind !== kind) return false;
    const n = String(q || '').trim().toLowerCase();
    return !n || [r.tenant_name, r.property, r.qb_customer_name, r.detail].some(v => String(v || '').toLowerCase().includes(n));
  }
  function billingCsv(rows){
    const head = ['Issue', 'Tenant', 'Property', 'Move in', 'Lease end', 'Portal rent', 'QuickBooks customer', 'QuickBooks customer #', 'Recurring amount', 'Next invoice', 'Templates', 'Detail', 'First seen'];
    const amt = (c) => (Number(c || 0) / 100).toFixed(2);
    return [head, ...rows.map(r => [(BILLING[r.kind] || [r.kind])[0], r.tenant_name, r.property, r.move_in || '', r.lease_end || '', amt(r.rent_cents), r.qb_customer_name, r.qb_customer_id,
      amt(r.template_cents), r.next_date || '', (r.template_ids || []).join(' '), r.detail, String(r.first_seen || '').slice(0, 10)])].map(l => l.map(csvCell).join(',')).join('\n');
  }

  // Collections tab (phase 3c): who Lu reminds, who is paused and why, reminders sent. Lu keeps the holds; staff ask
  // here to pause or resume (ar_collection_action) and Lu applies it within 10 minutes, always before a batch is sent.
  const COLLECT = {
    needs_person: ['Needs a person', 'red', 'Lu will not remind: a person has to act (dispute, reply to read, over 120 days, small balance, unapplied credit)'],
    will_remind: ['Will be reminded', 'blue', 'In the next reminder batch (weekdays 9:00), sent only after approval in Slack'],
    held: ['Paused', 'amber', 'Reminders paused: promise to pay, payment plan, paused by staff, or says they paid'],
    waiting: ['Waiting', '', 'Not yet: under 3 days late, reminded in the last 3 days, or a payment is on its way into QuickBooks'],
    not_reminded: ['Not reminded', '', 'Never reminded automatically: not a tenant, or no email on file'],
  };
  const PAUSE_REASONS = [['dispute', 'Disputes the balance'], ['promise_to_pay', 'Promised to pay by…'], ['payment_plan', 'On a payment plan until…'], ['manual', 'Pause (other reason)']];
  const HOLD_LABEL = { dispute: 'Disputed', promise_to_pay: 'Promised to pay', payment_plan: 'Payment plan', manual: 'Paused by staff', replied: 'Replied to a reminder',
    payment_claimed: 'Says they paid', rtb: 'RTB matter', deposit_matter: 'Deposit matter' };
  const STAGE_LABEL = { friendly: 'Friendly reminder', firm: 'Firm reminder', final: 'Final notice' };
  const sortCollections = (rows) => rows.slice().sort((a, b) => Object.keys(COLLECT).indexOf(a.status) - Object.keys(COLLECT).indexOf(b.status) || Number(b.total_cents || 0) - Number(a.total_cents || 0));
  function collectionMatches(r, q, status){
    if (status === 'escalated' ? !r.escalated : status && r.status !== status) return false;
    const n = String(q || '').trim().toLowerCase();
    return !n || [r.name, r.property, r.email, r.customer_id, r.detail, HOLD_LABEL[r.hold_reason], r.hold_note].some(v => String(v || '').toLowerCase().includes(n));
  }
  /** The newest request for this customer that Lu has not applied yet. */
  const pendingAction = (actions, customerId) => (actions || []).filter(a => String(a.customer_id) === String(customerId) && a.status === 'pending').sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
  function collectionsCsv(rows){
    const head = ['Status', 'Tenant', 'Property', 'Email', 'QuickBooks customer #', 'Overdue', 'Days late', '14+ days', 'What happens next', 'Paused because', 'Paused until', 'Pause note', 'Paused by', 'Reminders sent', 'Last reminder'];
    return [head, ...rows.map(r => [(COLLECT[r.status] || [r.status])[0], r.name, r.property, r.email, r.customer_id, (Number(r.total_cents || 0) / 100).toFixed(2), r.max_days, r.escalated ? 'yes' : '',
      r.detail, HOLD_LABEL[r.hold_reason] || r.hold_reason || '', r.hold_until || '', r.hold_note || '', String(r.hold_by || '').replace(/^portal:/, ''), (r.reminders || []).length,
      (r.reminders || [])[0] ? `${r.reminders[0].on} ${STAGE_LABEL[r.reminders[0].stage] || r.reminders[0].stage}` : ''])].map(l => l.map(csvCell).join(',')).join('\n');
  }

  // Month-end tab (phase 3e): QuickBooks A/R aging + Balance Sheet AS OF each month end, with the tie-out (Lu, 1st-15th).
  const ME_BUCKETS = [['current', 'Current'], ['1-30', '1–30'], ['31-60', '31–60'], ['61-90', '61–90'], ['91+', '91+']];
  const monthLabel = (m) => { const [y, mo] = String(m || '').split('-').map(Number); return y && mo ? new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : String(m || ''); };
  /** Month-end lines -> one row per customer with the five buckets, largest balance first. */
  function monthCustomers(lines){
    const by = new Map();
    for (const l of lines || []) {
      const k = l.customer_id || l.customer_name || '?';
      const c = by.get(k) || by.set(k, { customerId: l.customer_id || '', name: l.customer_name || '', buckets: Object.fromEntries(ME_BUCKETS.map(([b]) => [b, 0])), totalCents: 0, lines: [] }).get(k);
      const cents = Number(l.open_cents || 0);
      c.buckets[ME_BUCKETS.some(([b]) => b === l.bucket) ? l.bucket : 'current'] += cents; c.totalCents += cents; c.lines.push(l);
    }
    return [...by.values()].sort((a, b) => b.totalCents - a.totalCents || a.name.localeCompare(b.name));
  }
  function monthEndCsv(lines){
    const head = ['Customer', 'QuickBooks customer #', 'Type', 'Num', 'Date', 'Due', 'Days past due', 'Aging', 'Amount', 'Open balance'];
    const amt = (c) => (Number(c || 0) / 100).toFixed(2);
    return [head, ...(lines || []).map(l => [l.customer_name, l.customer_id, l.txn_type, l.doc_number, l.txn_date || '', l.due_date || '', l.days_past_due, (ME_BUCKETS.find(([b]) => b === l.bucket) || [, l.bucket])[1], amt(l.amount_cents), amt(l.open_cents)])]
      .map(l => l.map(csvCell).join(',')).join('\n');
  }
  const tiesOut = (rep) => !!rep && (rep.checks || []).length > 0 && (rep.checks || []).every(c => c.ok);

  window.AR_CORE = { BUCKETS, KINDS, STALE_HOURS, daysLate, bucketOf, money, moneyShort, addDays, summarize, tenantIndex, customerRows, matches, invoiceInBucket, sortCustomers, customersCsv, invoicesCsv, freshness, qboInvoiceUrl, qboCustomerUrl, qboPaymentUrl, canSee,
    INCOMING, incomingSummary, sortIncoming, incomingMatches, incomingCsv, BILLING, sortBilling, billingMatches, billingCsv,
    COLLECT, PAUSE_REASONS, HOLD_LABEL, STAGE_LABEL, sortCollections, collectionMatches, pendingAction, collectionsCsv,
    ME_BUCKETS, monthLabel, monthCustomers, monthEndCsv, tiesOut };
  if (typeof document === 'undefined') return;

  const S = { tab: 'customers', q: '', kind: '', city: '', bucket: '', inState: '', billKind: '', colState: '', month: '' };
  const meLines = {}; // month -> lines (loaded when the Month-end tab shows that month)
  let data = null, loading = null;
  const e = (s) => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const toast = (m) => { if (typeof showToast === 'function') showToast(m); };
  const sb = () => window.vmDb && window.vmDb.sb;
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
  const when = (ts) => { if (!ts) return '—'; const d = new Date(ts); return isNaN(d) ? String(ts) : d.toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }); };
  const H = (t) => `<h4 style="margin:22px 0 6px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)">${e(t)}</h4>`;
  const late = (d) => d > 0 ? `<span class="tag-pill ${d > 60 ? 'red' : d > 30 ? 'amber' : ''}" style="font-size:11px">${d} d late</span>` : `<span class="name-sub">not due</span>`;
  const kindPill = (r) => r.kind === 'tenant' ? `<span class="tag-pill blue" style="font-size:11px">Tenant</span>` : `<span class="tag-pill" style="font-size:11px">Other</span>`;
  const msg = (t) => { const b = document.getElementById('ar-body'); if (b) b.innerHTML = `<tr><td colspan="${COLS}" class="name-sub">${t}</td></tr>`; };

  async function load(force){
    if (loading) return loading;
    if (data && !force) { render(); return; }
    if (!sb()) { msg('Not connected to the database.'); return; }
    if (!data) msg('Loading…');
    loading = (async () => {
      try {
        const [inv, un, run, links, inc, bill, col, acts, me] = await Promise.all([
          sb().from('ar_open_invoices').select('*').order('due_date', { ascending: true }).limit(10000),
          sb().from('ar_unapplied_payments').select('*').limit(10000),
          sb().from('ar_sync_runs').select('*').order('synced_at', { ascending: false }).limit(1),
          sb().from('tenant_qb_links').select('tenant_id,qb_customer_id').limit(10000),
          sb().from('ar_incoming_payments').select('*').limit(5000),
          sb().from('ar_billing_issues').select('*').limit(5000),
          sb().from('ar_collections').select('*').limit(5000),
          sb().from('ar_collection_actions').select('*').order('id', { ascending: false }).limit(1000),
          sb().from('ar_month_end').select('*').order('month', { ascending: false }).limit(36),
        ]);
        for (const r of [inv, un, run]) if (r.error) throw r.error;
        // Incoming is optional: before ar-incoming-2026-10-20.sql runs the tab just says so.
        data = { invoices: inv.data || [], unapplied: un.data || [], lastRun: (run.data || [])[0] || null, links: links.error ? [] : (links.data || []), incoming: inc.error ? null : (inc.data || []), billing: bill.error ? null : (bill.data || []),
          collections: col.error ? null : (col.data || []), actions: acts.error ? [] : (acts.data || []), monthEnd: me.error ? null : (me.data || []) };
        for (const k of Object.keys(meLines)) delete meLines[k];
        render();
      } catch (err) {
        console.error('[ar] load failed', err);
        const m = String(err && err.message || err);
        msg(/ar_open_invoices|ar_sync_runs/.test(m) && /exist|schema cache/i.test(m) ? 'AR is not set up in the database yet (run ar-2026-10-19.sql).' : 'Could not load AR: ' + e(m));
      } finally { loading = null; }
    })();
    return loading;
  }

  function model(){
    const t = today();
    const idx = tenantIndex(data.links, window.tenants || (typeof tenants !== 'undefined' ? tenants : []));
    const cust = customerRows(data.invoices, data.unapplied, idx, t);
    return { t, cust, sum: summarize(data.invoices, data.unapplied, t) };
  }

  function render(){
    if (!data) return;
    const { t, cust, sum } = model();
    const badge = document.querySelector('.nav-item[data-view="ar"] .nav-count');
    if (badge) badge.textContent = moneyShort(sum.overdueCents);

    const fr = freshness(data.lastRun, Date.now());
    const fresh = document.getElementById('ar-fresh');
    if (fresh) fresh.innerHTML = !data.lastRun ? `<span class="tag-pill red" style="font-size:11px">Not synced yet</span> Lu fills this from QuickBooks every 2 hours (8:50–20:50 Vancouver).`
      : `${fr.stale ? `<span class="tag-pill red" style="font-size:11px">Out of date</span> ` : ''}QuickBooks copy from <b>${e(when(data.lastRun.synced_at))}</b> · read-only · refreshed by Lu every 2 hours, 8:50–20:50 Vancouver${data.lastRun.incoming_at ? ` · incoming payments checked ${e(when(data.lastRun.incoming_at))}` : ''}${data.lastRun.billing_at ? ` · billing checked ${e(when(data.lastRun.billing_at))}` : ''}${data.lastRun.collections_at ? ` · collections ${e(when(data.lastRun.collections_at))}` : ''}`;

    const cards = document.getElementById('ar-cards');
    if (cards) cards.innerHTML = [
      ['Open AR', sum.openCents, `${sum.invoiceCount} invoices · ${sum.customerCount} customers`, ''],
      ['Overdue', sum.overdueCents, sum.openCents ? Math.round(100 * sum.overdueCents / sum.openCents) + '% of open' : '', 'overdue'],
      ['90+ days late', sum.over90Cents, '', '90+'],
      ['Due in 7 days', sum.due7Cents, `${money(sum.due30Cents)} in 30 days`, 'current'],
      ['Unapplied credits', sum.unappliedCents, `${sum.unappliedCount} payment(s) not applied`, 'unapplied'],
    ].map(([l, c, sub, b]) => `<button type="button" class="card" data-ar-bucket="${b}" style="text-align:left;padding:14px 16px;cursor:pointer;border:1px solid ${S.bucket === b && b ? 'var(--accent,#B94A3F)' : 'var(--line,#e5e2dc)'}">
        <div class="name-sub">${e(l)}</div><div style="font-size:22px;font-weight:600;margin-top:4px">${e(money(c))}</div>${sub ? `<div class="name-sub">${e(sub)}</div>` : ''}</button>`).join('');

    const aging = document.getElementById('ar-aging');
    if (aging) {
      const tot = sum.openCents || 1;
      const col = { current: 'var(--green,#5C8A6B)', '1-30': '#C8923A', '31-60': '#D07A3A', '61-90': '#B94A3F', '90+': '#7A2E28' };
      aging.innerHTML = `<div style="display:flex;height:12px;border-radius:6px;overflow:hidden;background:var(--line,#e5e2dc)">${BUCKETS.map(([k]) => `<div title="${e(k)}" style="width:${(100 * sum.buckets[k] / tot).toFixed(2)}%;background:${col[k]}"></div>`).join('')}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${BUCKETS.map(([k, l]) => `<button type="button" class="btn btn-ghost btn-mini" data-ar-bucket="${k}" style="${S.bucket === k ? 'outline:2px solid var(--accent,#B94A3F)' : ''}"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${col[k]};margin-right:6px"></span>${e(l)} · <b>${e(money(sum.buckets[k]))}</b></button>`).join('')}
        ${S.bucket ? `<button type="button" class="btn btn-ghost btn-mini" data-ar-bucket="">Clear</button>` : ''}</div>`;
    }

    const tabs = document.getElementById('ar-tabs');
    const f = { q: S.q, kind: S.kind, city: S.city, bucket: S.bucket };
    const list = sortCustomers(cust.filter(r => matches(r, f)));
    const invRows = [];
    for (const c of list) for (const i of c.invoices) if (invoiceInBucket(i, S.bucket, t)) invRows.push({ i, c });
    invRows.sort((a, b) => String(a.i.due_date || '').localeCompare(String(b.i.due_date || '')) || Number(b.i.balance_cents) - Number(a.i.balance_cents));
    const incAll = data.incoming || [];
    const incSum = incomingSummary(incAll);
    if (tabs) tabs.innerHTML = [['customers', 'Customers', list.length], ['invoices', 'Invoices', invRows.length], ['incoming', 'Incoming payments', incSum.problems ? `<span class="tag-pill red" style="font-size:11px">${incSum.problems} to check</span>` : incAll.length],
      ['billing', 'Billing', (data.billing || []).length ? `<span class="tag-pill amber" style="font-size:11px">${(data.billing || []).length} to check</span>` : 0],
      ['collections', 'Collections', (() => { const np = (data.collections || []).filter(r => r.status === 'needs_person').length; return np ? `<span class="tag-pill red" style="font-size:11px">${np} need a person</span>` : (data.collections || []).length; })()],
      ['monthend', 'Month-end', (() => { const m = (data.monthEnd || [])[0]; return !m ? '' : tiesOut(m) ? `<span class="name-sub">${e(monthLabel(m.month))}</span>` : `<span class="tag-pill red" style="font-size:11px">${e(monthLabel(m.month))}: check</span>`; })()]]
      .map(([k, l, n]) => `<button type="button" class="tab${S.tab === k ? ' active' : ''}" role="tab" aria-selected="${S.tab === k}" data-ar-tab="${k}">${l} <span class="name-sub">${n}</span></button>`).join('');
    const side = S.tab === 'incoming' || S.tab === 'billing' || S.tab === 'collections' || S.tab === 'monthend';
    for (const [id, show] of [['ar-kind', !side], ['ar-city', !side], ['ar-instate', S.tab === 'incoming'], ['ar-billkind', S.tab === 'billing'], ['ar-colstate', S.tab === 'collections'], ['ar-month', S.tab === 'monthend']]) { const el = document.getElementById(id); if (el) el.style.display = show ? '' : 'none'; }
    if (S.tab === 'monthend') return renderMonthEnd();
    if (S.tab === 'incoming') return renderIncoming(incAll, incSum);
    if (S.tab === 'billing') return renderBilling(data.billing);
    if (S.tab === 'collections') return renderCollections(data.collections);

    const total = S.tab === 'customers' ? list.reduce((s, r) => s + r.openCents, 0) : invRows.reduce((s, x) => s + Number(x.i.balance_cents || 0), 0);
    const cnt = document.getElementById('ar-count'); if (cnt) cnt.textContent = S.tab === 'customers' ? `${list.length} customers` : `${invRows.length} invoices`;
    const tot = document.getElementById('ar-total'); if (tot) tot.textContent = money(total);
    const head = document.getElementById('ar-head');
    const body = document.getElementById('ar-body');
    const empty = document.getElementById('ar-empty');
    const shown = S.tab === 'customers' ? list.length : invRows.length;
    if (empty) empty.style.display = shown ? 'none' : '';
    if (S.tab === 'customers') {
      if (head) head.innerHTML = `<tr><th>Customer</th><th>Type</th><th>Property · city</th><th style="text-align:right">Open</th><th style="text-align:right">Overdue</th><th>Oldest due</th><th style="text-align:right">Invoices</th></tr>`;
      if (body) body.innerHTML = list.map(r => `<tr class="clickable" data-ar-open="${e(r.customerId)}" tabindex="0" style="cursor:pointer">
          <td><b>${e(r.name || 'Customer ' + r.customerId)}</b><div class="name-sub">${r.tenantName && r.tenantName !== r.name ? 'Portal: ' + e(r.tenantName) + ' · ' : ''}${e(r.email || '#' + r.customerId)}</div></td>
          <td>${kindPill(r)}</td>
          <td>${e(r.property || '—')}<div class="name-sub">${e(r.city || '')}</div></td>
          <td style="text-align:right;white-space:nowrap"><b>${e(money(r.openCents))}</b>${r.unappliedCents ? `<div class="name-sub">credit ${e(money(r.unappliedCents))}</div>` : ''}</td>
          <td style="text-align:right;white-space:nowrap">${r.overdueCents ? e(money(r.overdueCents)) : '<span class="name-sub">—</span>'}</td>
          <td>${e(r.oldestDue || '—')}<div>${r.invoices.length ? late(r.maxDays) : ''}</div></td>
          <td style="text-align:right">${r.invoices.length}</td></tr>`).join('');
    } else {
      if (head) head.innerHTML = `<tr><th>Invoice</th><th>Customer</th><th>Type</th><th>Due</th><th style="text-align:right">Total</th><th style="text-align:right">Balance</th><th>For</th></tr>`;
      if (body) body.innerHTML = invRows.slice(0, 1000).map(({ i, c }) => `<tr class="clickable" data-ar-open="${e(c.customerId)}" tabindex="0" style="cursor:pointer">
          <td><a href="${e(qboInvoiceUrl(i.qb_invoice_id))}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${e(i.doc_number || '#' + i.qb_invoice_id)} ↗</a><div class="name-sub">${e(i.txn_date || '')}</div></td>
          <td><b>${e(i.customer_name || c.name)}</b><div class="name-sub">${e(c.property || '')}</div></td>
          <td>${kindPill(c)}</td>
          <td>${e(i.due_date || '—')}<div>${late(daysLate(i.due_date, t))}</div></td>
          <td style="text-align:right;white-space:nowrap">${e(money(i.total_cents))}</td>
          <td style="text-align:right;white-space:nowrap"><b>${e(money(i.balance_cents))}</b></td>
          <td>${e(i.item_name || '')}<div class="name-sub">${e(i.class_name || '')}</div></td></tr>`).join('');
    }
  }

  const inPill = (st) => { const x = INCOMING[st] || [st, '']; return `<span class="tag-pill ${x[1]}" style="font-size:11px" title="${e(x[2] || '')}">${e(x[0])}</span>`; };
  const srcLabel = (r) => r.source === 'stripe' ? 'Stripe' : 'e-Transfer';
  const LU_STATUS = { proposed: 'open in #bookkeping-review', recorded_in_qbo: 'closed: already in QuickBooks', approved: 'approved', shadow_posted: 'approved (test mode, nothing written)', posted: 'posted by Lu', failed: 'QuickBooks write failed', skipped: 'skipped' };
  const HOW = { stripe_ref: 'Stripe id in the QuickBooks reference', customer: "payer's QuickBooks customer", name: "payer's name" };

  function renderIncoming(all, sum){
    const rows = sortIncoming(all.filter(r => incomingMatches(r, S.q, S.inState)));
    const cnt = document.getElementById('ar-count'); if (cnt) cnt.textContent = `${rows.length} payment(s)` + (sum.problems ? ` · ${sum.problems} to check` : '');
    const tot = document.getElementById('ar-total'); if (tot) tot.textContent = money(rows.reduce((s, r) => s + Number(r.amount_cents || 0), 0));
    const head = document.getElementById('ar-head'), body = document.getElementById('ar-body'), empty = document.getElementById('ar-empty');
    if (head) head.innerHTML = `<tr><th>Received</th><th>Payer</th><th style="text-align:right">Amount</th><th>Status</th><th>QuickBooks</th><th>Memo</th></tr>`;
    if (data.incoming === null) { if (empty) empty.style.display = 'none'; msg('Incoming payments are not set up in the database yet (run ar-incoming-2026-10-20.sql).'); return; }
    if (empty) { empty.style.display = rows.length ? 'none' : ''; empty.textContent = all.length ? 'Nothing matches these filters.' : 'No Stripe or e-Transfer payments in the last 60 days yet.'; }
    if (body) body.innerHTML = rows.slice(0, 1000).map(r => `<tr class="clickable" data-ar-inc="${e(r.proposal_id)}" tabindex="0" style="cursor:pointer">
        <td>${e(r.received_on || '—')}<div class="name-sub">${e(srcLabel(r))}</div></td>
        <td><b>${e(r.payer_name || r.payer_email || '—')}</b>${r.payer_name && r.payer_email ? `<div class="name-sub">${e(r.payer_email)}</div>` : ''}</td>
        <td style="text-align:right;white-space:nowrap"><b>${e(money(r.amount_cents))}</b></td>
        <td>${inPill(r.state)}</td>
        <td>${r.qb_payment_id ? `<a href="${e(qboPaymentUrl(r.qb_payment_id))}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Payment #${e(r.qb_payment_id)} ↗</a><div class="name-sub">${e(r.qb_customer_name || '')}${r.qb_txn_date ? ' · ' + e(r.qb_txn_date) : ''}</div>`
          : (r.candidates || []).length ? `<span class="name-sub">Same amount: ${(r.candidates || []).map(id => `<a href="${e(qboPaymentUrl(id))}" target="_blank" rel="noopener" onclick="event.stopPropagation()">#${e(id)}</a>`).join(', ')}</span>`
          : r.suggested_customer_name ? `<span class="name-sub">Likely customer: ${e(r.suggested_customer_name)}</span>` : '<span class="name-sub">—</span>'}</td>
        <td><span class="name-sub">${e(String(r.memo || '').slice(0, 80))}</span></td></tr>`).join('');
  }

  const stay = (r) => `${r.move_in || '?'} → ${r.lease_end || 'no end date'}`;
  function renderBilling(all){
    const head = document.getElementById('ar-head'), body = document.getElementById('ar-body'), empty = document.getElementById('ar-empty');
    if (head) head.innerHTML = `<tr><th>Issue</th><th>Tenant</th><th>Stay</th><th style="text-align:right">Portal rent</th><th>QuickBooks recurring</th><th>What to check</th></tr>`;
    if (all === null) { if (empty) empty.style.display = 'none'; msg('The billing check is not set up in the database yet (run ar-billing-2026-10-20.sql).'); return; }
    const rows = sortBilling(all.filter(r => billingMatches(r, S.q, S.billKind)));
    const cnt = document.getElementById('ar-count'); if (cnt) cnt.textContent = `${rows.length} to check`;
    const tot = document.getElementById('ar-total'); if (tot) tot.textContent = `${money(rows.reduce((s, r) => s + Number(r.rent_cents || 0), 0))} monthly rent involved`;
    if (empty) { empty.style.display = rows.length ? 'none' : ''; empty.textContent = all.length ? 'Nothing matches these filters.' : 'Nothing to check: QuickBooks recurring rent matches the portal.'; }
    if (body) body.innerHTML = rows.slice(0, 1000).map(r => { const x = BILLING[r.kind] || [r.kind, '']; return `<tr class="clickable" data-ar-bill="${e(r.issue_key)}" tabindex="0" style="cursor:pointer">
        <td><span class="tag-pill ${x[1]}" style="font-size:11px" title="${e(x[2] || '')}">${e(x[0])}</span></td>
        <td><b>${e(r.tenant_name || '—')}</b><div class="name-sub">${e(r.property || '')}</div></td>
        <td style="white-space:nowrap">${e(stay(r))}</td>
        <td style="text-align:right;white-space:nowrap">${r.rent_cents ? e(money(r.rent_cents)) : '<span class="name-sub">—</span>'}</td>
        <td>${r.template_cents ? `${e(money(r.template_cents))}${r.next_date ? `<div class="name-sub">next ${e(r.next_date)}</div>` : ''}` : '<span class="name-sub">none</span>'}</td>
        <td><span class="name-sub">${e(String(r.detail || '').slice(0, 140))}</span></td></tr>`; }).join('');
  }

  function renderMonthEnd(){
    const head = document.getElementById('ar-head'), body = document.getElementById('ar-body'), empty = document.getElementById('ar-empty');
    if (empty) empty.style.display = 'none';
    if (head) head.innerHTML = `<tr><th>Customer</th>${ME_BUCKETS.map(([, l]) => `<th style="text-align:right">${e(l)}</th>`).join('')}<th style="text-align:right">Total</th></tr>`;
    if (data.monthEnd === null) { msg('The month-end report is not set up in the database yet (run ar-month-end-2026-10-20.sql).'); return; }
    const reps = data.monthEnd || [];
    const sel = document.getElementById('ar-month');
    if (sel) { sel.innerHTML = reps.map(r => `<option value="${e(r.month)}">${e(monthLabel(r.month))}</option>`).join(''); if (!S.month && reps[0]) S.month = reps[0].month; sel.value = S.month; }
    const rep = reps.find(r => r.month === S.month);
    if (!rep) { msg('No month-end report yet. Lu makes it on the 1st of each month (and refreshes it until the 15th) from QuickBooks.'); return; }
    if (!meLines[rep.month]) {
      msg('Loading ' + e(monthLabel(rep.month)) + '…');
      sb().from('ar_month_end_lines').select('*').eq('month', rep.month).order('line_no').limit(20000)
        .then(({ data: rows, error }) => { if (error) { msg('Could not load the lines: ' + e(error.message)); return; } meLines[rep.month] = rows || []; render(); });
      return;
    }
    const n = String(S.q || '').trim().toLowerCase();
    const custs = monthCustomers(meLines[rep.month]).filter(c => !n || [c.name, c.customerId, ...c.lines.map(l => l.doc_number)].some(v => String(v || '').toLowerCase().includes(n)));
    const cnt = document.getElementById('ar-count'); if (cnt) cnt.textContent = `${custs.length} customers`;
    const tot = document.getElementById('ar-total'); if (tot) tot.textContent = money(custs.reduce((s, c) => s + c.totalCents, 0));
    const b = rep.buckets || {};
    const checks = (rep.checks || []).map(c => `<div style="display:flex;gap:8px;align-items:baseline"><span class="tag-pill ${c.ok ? 'green' : 'red'}" style="font-size:11px">${c.ok ? 'OK' : 'Off by ' + e(money(c.diffCents))}</span>
        <span>${e(c.label)}${c.ok ? '' : ` <span class="name-sub">(${e(money(c.aCents))} vs ${e(money(c.bCents))}). ${e(c.note || '')}</span>`}</span></div>`).join('');
    const summary = `<tr><td colspan="${COLS}" style="background:var(--panel,#faf8f5)">
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px">
        <div><div class="name-sub">Outstanding AR at ${e(rep.as_of)}</div><div style="font-size:22px;font-weight:600">${e(money(rep.total_cents))}</div><div class="name-sub">${e(rep.customer_count)} customers · ${e(rep.invoice_count)} invoices</div></div>
        <div><div class="name-sub">Balance Sheet A/R</div><div style="font-size:16px;font-weight:600">${rep.ar_account_cents == null ? '—' : e(money(rep.ar_account_cents))}</div></div>
        ${ME_BUCKETS.map(([k, l]) => `<div><div class="name-sub">${e(l)}</div><div style="font-weight:600">${e(money(b[k] || 0))}</div></div>`).join('')}
      </div>
      <div style="display:grid;gap:4px">${checks}</div>
      <div class="name-sub" style="margin-top:8px">From QuickBooks (A/R Aging Detail and Balance Sheet as of ${e(rep.as_of)}), made by Lu ${e(when(rep.generated_at))}. Late entries dated in the month change it: Lu refreshes it every morning until the 15th. Credits and unapplied payments count as negatives.</div>
    </td></tr>`;
    if (body) body.innerHTML = summary + custs.slice(0, 2000).map(c => `<tr class="clickable" data-ar-me="${e(c.customerId || c.name)}" tabindex="0" style="cursor:pointer">
        <td><b>${e(c.name || 'Customer ' + c.customerId)}</b><div class="name-sub">${e(c.lines.length)} line(s)${c.customerId ? ' · #' + e(c.customerId) : ''}</div></td>
        ${ME_BUCKETS.map(([k]) => `<td style="text-align:right;white-space:nowrap">${c.buckets[k] ? e(money(c.buckets[k])) : '<span class="name-sub">—</span>'}</td>`).join('')}
        <td style="text-align:right;white-space:nowrap"><b>${e(money(c.totalCents))}</b></td></tr>`).join('');
  }

  function openMonthEndCustomer(key){
    const c = monthCustomers(meLines[S.month] || []).find(x => (x.customerId || x.name) === key);
    if (!c) return;
    document.getElementById('panel-hero').textContent = String(c.name || '?').slice(0, 1).toUpperCase();
    document.getElementById('panel-title').innerHTML = e(c.name || 'Customer ' + c.customerId);
    document.getElementById('panel-sub').textContent = `${money(c.totalCents)} open at ${monthLabel(S.month)} end`;
    document.getElementById('panel-meta').innerHTML = c.customerId ? `<a href="${e(qboCustomerUrl(c.customerId))}" target="_blank" rel="noopener">QuickBooks customer #${e(c.customerId)} ↗</a>` : '';
    document.getElementById('panel-body').innerHTML = `<table class="table" style="width:100%;font-size:13px"><thead><tr><th>Type</th><th>Num</th><th>Due</th><th style="text-align:right">Days</th><th style="text-align:right">Open</th></tr></thead><tbody>
      ${c.lines.map(l => `<tr><td>${e(l.txn_type)}</td><td>${/invoice/i.test(l.txn_type) && l.txn_id ? `<a href="${e(qboInvoiceUrl(l.txn_id))}" target="_blank" rel="noopener">${e(l.doc_number || l.txn_id)} ↗</a>` : e(l.doc_number || '—')}</td><td>${e(l.due_date || '')}</td>
        <td style="text-align:right">${e(l.days_past_due)}</td><td style="text-align:right">${e(money(l.open_cents))}</td></tr>`).join('')}</tbody></table>
      <p class="name-sub" style="margin-top:14px">As QuickBooks had it on ${e(S.month)} month end. Today's balance is on the Customers tab.</p>`;
    document.getElementById('detail-panel').classList.add('open');
    document.getElementById('detail-panel').setAttribute('aria-hidden', 'false');
    document.getElementById('panel-backdrop').classList.add('open');
  }

  function openBilling(key){
    const r = data && (data.billing || []).find(x => x.issue_key === key);
    if (!r) return;
    const x = BILLING[r.kind] || [r.kind, '', ''];
    document.getElementById('panel-hero').textContent = String(r.tenant_name || '?').slice(0, 1).toUpperCase();
    document.getElementById('panel-title').innerHTML = e(r.tenant_name || 'Tenant');
    document.getElementById('panel-sub').textContent = `${x[0]} · ${r.property || ''}`;
    document.getElementById('panel-meta').innerHTML = `<span class="tag-pill ${x[1]}" style="font-size:11px">${e(x[0])}</span>`;
    const field = (l, v) => v ? `<div style="display:flex;gap:10px"><span class="name-sub" style="min-width:150px">${e(l)}</span><span>${v}</span></div>` : '';
    document.getElementById('panel-body').innerHTML = `<div data-ar-bill-id="${e(r.issue_key)}">
      <p style="margin:0 0 12px">${e(r.detail || x[2])}</p>
      <div style="display:grid;gap:6px">
        ${field('Property', e(r.property))}
        ${field('Stay (portal)', e(stay(r)))}
        ${field('Portal rent', r.rent_cents ? e(money(r.rent_cents)) + ` <span class="name-sub">(${e(money(Math.round(r.rent_cents * 1.03)))} with 3% fee)</span>` : '')}
        ${field('QuickBooks customer', r.qb_customer_id ? `<a href="${e(qboCustomerUrl(r.qb_customer_id))}" target="_blank" rel="noopener">${e(r.qb_customer_name || 'Customer #' + r.qb_customer_id)} ↗</a>` : '')}
        ${field('Recurring amount', r.template_cents ? e(money(r.template_cents)) : '<span class="name-sub">no recurring invoice</span>')}
        ${field('Next invoice', e(r.next_date))}
        ${field('Templates', (r.template_ids || []).map(id => '#' + e(id)).join(', '))}
        ${field('First seen', e(String(r.first_seen || '').slice(0, 10)))}
      </div>
      <p class="name-sub" style="margin-top:18px">Nothing here changes QuickBooks. Fix the recurring invoice in QuickBooks (Sales → Recurring transactions) or the tenant's dates and rent in the portal; the item disappears after Lu's next morning check.</p>
    </div>`;
    document.getElementById('detail-panel').classList.add('open');
    document.getElementById('detail-panel').setAttribute('aria-hidden', 'false');
    document.getElementById('panel-backdrop').classList.add('open');
  }

  const colPill = (status) => { const x = COLLECT[status] || [status, '', '']; return `<span class="tag-pill ${x[1]}" style="font-size:11px" title="${e(x[2])}">${e(x[0])}</span>`; };
  const lastRem = (r) => { const x = (r.reminders || [])[0]; return x ? `${e(STAGE_LABEL[x.stage] || x.stage)}<div class="name-sub">${e(x.on)}${r.reminders.length > 1 ? ` · ${r.reminders.length} sent` : ''}</div>` : '<span class="name-sub">none yet</span>'; };
  function renderCollections(all){
    const head = document.getElementById('ar-head'), body = document.getElementById('ar-body'), empty = document.getElementById('ar-empty');
    if (head) head.innerHTML = `<tr><th>Status</th><th>Tenant</th><th style="text-align:right">Overdue</th><th>Last reminder</th><th>What happens next</th></tr>`;
    if (all === null) { if (empty) empty.style.display = 'none'; msg('Collections are not set up in the database yet (run ar-collections-2026-10-20.sql).'); return; }
    const rows = sortCollections(all.filter(r => collectionMatches(r, S.q, S.colState)));
    const cnt = document.getElementById('ar-count'); if (cnt) cnt.textContent = `${rows.length} customers with overdue rent`;
    const tot = document.getElementById('ar-total'); if (tot) tot.textContent = `${money(rows.reduce((s, r) => s + Number(r.total_cents || 0), 0))} overdue`;
    if (empty) { empty.style.display = rows.length ? 'none' : ''; empty.textContent = all.length ? 'Nothing matches these filters.' : 'Nobody owes overdue rent.'; }
    if (body) body.innerHTML = rows.slice(0, 1000).map(r => { const p = pendingAction(data.actions, r.customer_id); return `<tr class="clickable" data-ar-col="${e(r.customer_id)}" tabindex="0" style="cursor:pointer">
        <td>${colPill(r.status)}${r.escalated ? ' <span class="tag-pill red" style="font-size:11px" title="14+ days late: accounting / manager review (AR spec 5.4)">14+ days</span>' : ''}</td>
        <td><b>${e(r.name || 'Customer ' + r.customer_id)}</b><div class="name-sub">${e(r.property || '')}</div></td>
        <td style="text-align:right;white-space:nowrap">${e(money(r.total_cents))}<div class="name-sub">${e(r.max_days)} d late</div></td>
        <td style="white-space:nowrap">${lastRem(r)}</td>
        <td><span class="name-sub">${r.hold_reason ? `<b>${e(HOLD_LABEL[r.hold_reason] || r.hold_reason)}</b>${r.hold_until ? ' until ' + e(r.hold_until) : ' until resumed'}.${r.hold_note ? ' “' + e(String(r.hold_note).slice(0, 120)) + '”' : ''}` : e(String(r.detail || '').slice(0, 160))}</span>
          ${p ? `<div><span class="tag-pill amber" style="font-size:11px">${p.action === 'pause' ? 'Pause' : 'Resume'} requested, Lu applies it within 10 min</span></div>` : ''}</td></tr>`; }).join('');
  }

  function openCollection(customerId){
    const r = data && (data.collections || []).find(x => String(x.customer_id) === String(customerId));
    if (!r) return;
    const x = COLLECT[r.status] || [r.status, '', ''];
    const mine = (data.actions || []).filter(a => String(a.customer_id) === String(r.customer_id)).slice(0, 8);
    const p = pendingAction(data.actions, r.customer_id);
    document.getElementById('panel-hero').textContent = String(r.name || '?').slice(0, 1).toUpperCase();
    document.getElementById('panel-title').innerHTML = e(r.name || 'Customer ' + r.customer_id);
    document.getElementById('panel-sub').textContent = `${money(r.total_cents)} overdue · ${r.max_days} days late${r.property ? ' · ' + r.property : ''}`;
    document.getElementById('panel-meta').innerHTML = colPill(r.status) + (r.escalated ? ' <span class="tag-pill red" style="font-size:11px">14+ days</span>' : '');
    const field = (l, v) => v ? `<div style="display:flex;gap:10px"><span class="name-sub" style="min-width:150px">${e(l)}</span><span>${v}</span></div>` : '';
    const minDate = today(), maxDate = addDays(today(), 180);
    document.getElementById('panel-body').innerHTML = `<div data-ar-col-id="${e(r.customer_id)}">
      <p style="margin:0 0 12px">${e(r.detail || x[2])}</p>
      <div style="display:grid;gap:6px">
        ${field('Overdue', `<b>${e(money(r.total_cents))}</b> <span class="name-sub">${e(r.invoice_count)} invoice(s) · <a href="#ar=${e(r.customer_id)}">see invoices</a></span>`)}
        ${field('Email', e(r.email) || '<span class="name-sub">none on file</span>')}
        ${field('QuickBooks', `<a href="${e(qboCustomerUrl(r.customer_id))}" target="_blank" rel="noopener">Customer #${e(r.customer_id)} ↗</a>`)}
        ${field('Next reminder', r.next_stage ? e(STAGE_LABEL[r.next_stage] || r.next_stage) : '')}
        ${field('In a batch', e(r.in_batch))}
        ${r.hold_reason ? field('Paused because', `<b>${e(HOLD_LABEL[r.hold_reason] || r.hold_reason)}</b>${r.hold_until ? ' until ' + e(r.hold_until) : ' until resumed'}`) : ''}
        ${field('Pause note', e(r.hold_note))}
        ${field('Paused by', e(String(r.hold_by || '').replace(/^portal:/, '')))}
      </div>
      ${H(`Reminders sent (${(r.reminders || []).length})`)}
      <div style="display:grid;gap:4px">${(r.reminders || []).map(m => `<div class="name-sub">${e(m.on)} · ${e(STAGE_LABEL[m.stage] || m.stage)} · ${e(money(m.total_cents))}</div>`).join('') || '<div class="name-sub">None yet</div>'}</div>
      ${H('Pause or resume reminders')}
      ${p ? `<p class="name-sub"><span class="tag-pill amber" style="font-size:11px">Waiting for Lu</span> ${p.action === 'pause' ? `Pause (${e(HOLD_LABEL[p.reason] || p.reason)}${p.until ? ' until ' + e(String(p.until).slice(0, 10)) : ''})` : 'Resume'} requested by ${e(p.created_by)}. Lu applies it within 10 minutes, and always before sending a batch.</p>` : ''}
      <form data-ar-pause style="display:grid;gap:8px;max-width:420px">
        <select name="reason" class="form-input" aria-label="Why pause">${PAUSE_REASONS.map(([v, l]) => `<option value="${v}">${e(l)}</option>`).join('')}</select>
        <label class="name-sub">Until (required for a promise or payment plan; empty = until someone resumes)<input type="date" name="until" class="form-input" min="${minDate}" max="${maxDate}"></label>
        <input type="text" name="note" class="form-input" maxlength="500" placeholder="Note for the team (what they said, the plan…)">
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="submit" class="btn btn-primary btn-mini">Pause reminders</button>
          ${r.hold_reason || r.status === 'held' ? `<button type="button" class="btn btn-ghost btn-mini" data-ar-resume>Resume reminders</button>` : ''}</div>
        <div class="name-sub" data-ar-pause-msg></div>
      </form>
      ${mine.length ? H('Requests') + `<div style="display:grid;gap:4px">${mine.map(a => `<div class="name-sub">${e(when(a.created_at))} · ${a.action === 'pause' ? `Pause: ${e(HOLD_LABEL[a.reason] || a.reason)}${a.until ? ' until ' + e(String(a.until).slice(0, 10)) : ''}` : 'Resume'} · ${e(a.created_by)} · <b>${e(a.status)}</b>${a.result ? ' · ' + e(a.result) : ''}${a.note ? ` · “${e(a.note)}”` : ''}</div>`).join('')}</div>` : ''}
      <p class="name-sub" style="margin-top:18px">Pausing only stops Lu's reminder emails; nothing changes in QuickBooks. Lu decides with the same rules every morning and posts changes made here in #bookkeping-review.</p>
    </div>`;
    document.getElementById('detail-panel').classList.add('open');
    document.getElementById('detail-panel').setAttribute('aria-hidden', 'false');
    document.getElementById('panel-backdrop').classList.add('open');
  }

  async function requestAction(customerId, action, reason, until, note, out){
    if (out) out.textContent = 'Saving…';
    const { error } = await sb().rpc('ar_collection_action', { p_customer_id: String(customerId), p_action: action, p_reason: action === 'pause' ? reason : null, p_until: until || null, p_note: note || '' });
    if (error) { if (out) out.textContent = 'Not saved: ' + (error.message || error); return; }
    toast(action === 'pause' ? 'Pause requested. Lu applies it within 10 minutes.' : 'Resume requested. Lu applies it within 10 minutes.');
    const acts = await sb().from('ar_collection_actions').select('*').order('id', { ascending: false }).limit(1000);
    if (!acts.error) data.actions = acts.data || [];
    render(); openCollection(customerId);
    pollActions();
  }
  // While a request waits for Lu, re-read the requests every 30 s (up to 15 min) so the drawer shows when it is applied.
  function pollActions(n = 0){
    clearTimeout(pollActions._t);
    if (n > 30 || !(data.actions || []).some(a => a.status === 'pending')) return;
    pollActions._t = setTimeout(async () => {
      const acts = await sb().from('ar_collection_actions').select('*').order('id', { ascending: false }).limit(1000);
      if (!acts.error) {
        const was = new Set((data.actions || []).filter(a => a.status === 'pending').map(a => a.id));
        data.actions = acts.data || [];
        if (data.actions.some(a => was.has(a.id) && a.status !== 'pending')) { await load(true); const open = document.querySelector('[data-ar-col-id]'); if (open) openCollection(open.dataset.arColId); }
      }
      pollActions(n + 1);
    }, 30000);
  }

  function openIncoming(id){
    const r = data && (data.incoming || []).find(x => String(x.proposal_id) === String(id));
    if (!r) return;
    const x = INCOMING[r.state] || [r.state, '', ''];
    document.getElementById('panel-hero').textContent = '$';
    document.getElementById('panel-title').innerHTML = `${e(money(r.amount_cents))} · ${e(srcLabel(r))}`;
    document.getElementById('panel-sub').textContent = `${r.payer_name || r.payer_email || 'Unknown payer'} · received ${r.received_on || '—'}`;
    document.getElementById('panel-meta').innerHTML = inPill(r.state);
    const field = (l, v) => v ? `<div style="display:flex;gap:10px"><span class="name-sub" style="min-width:150px">${e(l)}</span><span>${v}</span></div>` : '';
    const withAr = new Set((data.invoices || []).map(i => String(i.customer_id)));
    const custLink = (cid, name) => !cid ? e(name) : `${withAr.has(String(cid)) ? `<a href="#ar=${e(cid)}">${e(name || 'Customer #' + cid)}</a> <span class="name-sub">(has open invoices)</span>` : e(name || 'Customer #' + cid)} <a href="${e(qboCustomerUrl(cid))}" target="_blank" rel="noopener" class="name-sub">QuickBooks ↗</a>`;
    document.getElementById('panel-body').innerHTML = `<div data-ar-inc-id="${e(r.proposal_id)}">
      <p style="margin:0 0 12px">${e(x[2] || '')}</p>
      <div style="display:grid;gap:6px">
        ${field('Payer', e(r.payer_name))}
        ${field('Payer email', e(r.payer_email))}
        ${field('Amount', `<b>${e(money(r.amount_cents))}</b>`)}
        ${field('Received', e(r.received_on))}
        ${field(r.source === 'stripe' ? 'Stripe payment' : 'Interac reference', e(r.source_ref))}
        ${field('Memo', e(r.memo))}
        ${field('QuickBooks payment', r.qb_payment_id ? `<a href="${e(qboPaymentUrl(r.qb_payment_id))}" target="_blank" rel="noopener">#${e(r.qb_payment_id)} ↗</a>${r.qb_txn_date ? ' · dated ' + e(r.qb_txn_date) : ''}` : '')}
        ${field('QuickBooks customer', r.qb_customer_id || r.qb_customer_name ? custLink(r.qb_customer_id, r.qb_customer_name) : '')}
        ${field('Matched by', e(HOW[r.how] || ''))}
        ${field('Possible payments', (r.candidates || []).map(cid => `<a href="${e(qboPaymentUrl(cid))}" target="_blank" rel="noopener">#${e(cid)} ↗</a>`).join(', '))}
        ${!r.qb_payment_id ? field('Likely customer', r.suggested_customer_id ? custLink(r.suggested_customer_id, r.suggested_customer_name) : '<span class="name-sub">Not identified</span>') : ''}
        ${field("Lu's proposal", `#${e(r.proposal_id)} · ${e(LU_STATUS[r.lu_status] || r.lu_status || '')}`)}
      </div>
      <p class="name-sub" style="margin-top:18px">Nothing here writes to QuickBooks. Enter or fix the payment in QuickBooks; Lu checks again every 2 hours. When Lu finds it, it closes its own proposal in #bookkeping-review so the payment cannot be entered twice.</p>
    </div>`;
    document.getElementById('detail-panel').classList.add('open');
    document.getElementById('detail-panel').setAttribute('aria-hidden', 'false');
    document.getElementById('panel-backdrop').classList.add('open');
  }

  function open(customerId){
    if (!data) return;
    const { t, cust } = model();
    const r = cust.find(x => x.customerId === String(customerId));
    if (!r) return;
    document.getElementById('panel-hero').textContent = String(r.name || '?').slice(0, 1).toUpperCase();
    document.getElementById('panel-title').innerHTML = e(r.name || 'Customer ' + r.customerId);
    document.getElementById('panel-sub').textContent = `${money(r.openCents)} open · ${money(r.overdueCents)} overdue${r.property ? ' · ' + r.property : ''}`;
    document.getElementById('panel-meta').innerHTML = kindPill(r) + (r.maxDays > 0 ? ' ' + late(r.maxDays) : '');
    const field = (l, v) => v ? `<div style="display:flex;gap:10px"><span class="name-sub" style="min-width:130px">${e(l)}</span><span>${v}</span></div>` : '';
    document.getElementById('panel-body').innerHTML = `<div data-ar-id="${e(r.customerId)}">
      <div style="display:grid;gap:6px">
        ${field('QuickBooks', `<a href="${e(qboCustomerUrl(r.customerId))}" target="_blank" rel="noopener">Customer #${e(r.customerId)} ↗</a>`)}
        ${field('Email', e(r.email))}
        ${field('Portal tenant', r.tenantId ? `<a href="#" data-ar-tenant="${e(r.tenantId)}">${e(r.tenantName || 'Open profile')}</a>${r.tenantCount > 1 ? ` <span class="name-sub">+${r.tenantCount - 1} more linked to this customer</span>` : ''}` : '<span class="name-sub">Not linked (agency, partner, or a tenant Lu could not match)</span>')}
        ${field('Property', e(r.property))}
        ${field('City', e(r.city))}
        ${field('Open', `<b>${e(money(r.openCents))}</b>`)}
        ${field('Overdue', e(money(r.overdueCents)))}
        ${r.unappliedCents ? field('Unapplied credit', `<b>${e(money(r.unappliedCents))}</b> <span class="name-sub">received but not applied to an invoice in QuickBooks</span>`) : ''}
      </div>
      ${H('Aging')}<div style="display:grid;grid-template-columns:auto auto;gap:2px 16px;max-width:300px">${BUCKETS.map(([k, l]) => `<span class="name-sub">${e(l)}</span><span style="text-align:right">${e(money(r.buckets[k]))}</span>`).join('')}</div>
      ${H(`Open invoices (${r.invoices.length})`)}
      <div style="display:grid;gap:8px">${r.invoices.map(i => `<div style="border:1px solid var(--line,#e5e2dc);border-radius:8px;padding:8px 10px">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><a href="${e(qboInvoiceUrl(i.qb_invoice_id))}" target="_blank" rel="noopener"><b>${e(i.doc_number || '#' + i.qb_invoice_id)}</b> ↗</a><b>${e(money(i.balance_cents))}</b></div>
        <div class="name-sub">Dated ${e(i.txn_date || '—')} · due ${e(i.due_date || '—')} · ${daysLate(i.due_date, t) > 0 ? daysLate(i.due_date, t) + ' days late' : 'not due yet'}${Number(i.total_cents) !== Number(i.balance_cents) ? ` · total ${e(money(i.total_cents))}` : ''}</div>
        <div class="name-sub">${e([i.item_name, i.class_name, i.description].filter(Boolean).join(' · '))}${i.email_status ? ' · email: ' + e(i.email_status) : ''}</div></div>`).join('') || '<div class="name-sub">None</div>'}</div>
      ${r.payments.length ? H('Unapplied payments') + `<div style="display:grid;gap:4px">${r.payments.map(p => `<div class="name-sub">${e(p.txn_date || '')} · ${e(money(p.unapplied_cents))} of ${e(money(p.total_cents))} not applied${p.ref_num ? ' · ref ' + e(p.ref_num) : ''}</div>`).join('')}</div>` : ''}
      <p class="name-sub" style="margin-top:18px">Read-only copy of QuickBooks. Record payments, credits and changes in QuickBooks; they show here after Lu's next refresh.</p>
    </div>`;
    document.getElementById('detail-panel').classList.add('open');
    document.getElementById('detail-panel').setAttribute('aria-hidden', 'false');
    document.getElementById('panel-backdrop').classList.add('open');
  }

  function exportCsv(){
    if (!data) return;
    const { t, cust } = model();
    const f = { q: S.q, kind: S.kind, city: S.city, bucket: S.bucket };
    const list = sortCustomers(cust.filter(r => matches(r, f)));
    const text = S.tab === 'monthend' ? monthEndCsv(meLines[S.month] || [])
      : S.tab === 'collections' ? collectionsCsv(sortCollections((data.collections || []).filter(r => collectionMatches(r, S.q, S.colState))))
      : S.tab === 'billing' ? billingCsv(sortBilling((data.billing || []).filter(r => billingMatches(r, S.q, S.billKind))))
      : S.tab === 'incoming' ? incomingCsv(sortIncoming((data.incoming || []).filter(r => incomingMatches(r, S.q, S.inState))))
      : S.tab === 'customers' ? customersCsv(list) : invoicesCsv(list.flatMap(c => c.invoices.filter(i => invoiceInBucket(i, S.bucket, t)).map(i => ({ i, c }))), t);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = S.tab === 'monthend' ? `ar-month-end-${S.month}.csv` : `ar-${S.tab}-${t}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    toast('CSV downloaded.');
  }

  function fromHash(){
    const m = (location.hash || '').match(/^#ar(?:=(\d+))?$/);
    if (!m) return false;
    if (typeof goToView === 'function') goToView('ar');
    if (m[1]) load().then(() => open(m[1]));
    return true;
  }
  window.loadAr = load;
  window.openArCustomer = open;
  window.addEventListener('hashchange', fromHash);

  function wire(){
    const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    const k = document.getElementById('ar-kind');
    if (k) k.innerHTML = KINDS.map(([v, l]) => `<option value="${v}">${e(l)}</option>`).join('');
    const city = document.getElementById('ar-city');
    if (city && !document.getElementById('ar-instate')) {
      const st = document.createElement('select');
      st.id = 'ar-instate'; st.className = 'form-input'; st.style.cssText = 'max-width:220px;display:none'; st.setAttribute('aria-label', 'Payment status');
      st.innerHTML = `<option value="">All statuses</option><option value="problems">To check (not found, unclear, twice)</option>` + Object.entries(INCOMING).map(([v, x]) => `<option value="${v}">${e(x[0])}</option>`).join('');
      city.after(st);
    }
    const inst = document.getElementById('ar-instate');
    if (inst && !document.getElementById('ar-billkind')) {
      const bk = document.createElement('select');
      bk.id = 'ar-billkind'; bk.className = 'form-input'; bk.style.cssText = 'max-width:220px;display:none'; bk.setAttribute('aria-label', 'Billing issue');
      bk.innerHTML = `<option value="">All issues</option>` + Object.entries(BILLING).map(([v, x]) => `<option value="${v}">${e(x[0])}</option>`).join('');
      inst.after(bk);
    }
    const bkSel = document.getElementById('ar-billkind');
    if (bkSel && !document.getElementById('ar-colstate')) {
      const cs = document.createElement('select');
      cs.id = 'ar-colstate'; cs.className = 'form-input'; cs.style.cssText = 'max-width:220px;display:none'; cs.setAttribute('aria-label', 'Collections status');
      cs.innerHTML = `<option value="">All statuses</option><option value="escalated">14+ days late</option>` + Object.entries(COLLECT).map(([v, x]) => `<option value="${v}">${e(x[0])}</option>`).join('');
      bkSel.after(cs);
    }
    const csSel = document.getElementById('ar-colstate');
    if (csSel && !document.getElementById('ar-month')) {
      const ms = document.createElement('select');
      ms.id = 'ar-month'; ms.className = 'form-input'; ms.style.cssText = 'max-width:220px;display:none'; ms.setAttribute('aria-label', 'Month');
      csSel.after(ms);
    }
    let tm = null;
    on('ar-search', 'input', ev => { S.q = ev.target.value; clearTimeout(tm); tm = setTimeout(render, 150); });
    on('ar-kind', 'change', ev => { S.kind = ev.target.value; render(); });
    on('ar-city', 'change', ev => { S.city = ev.target.value; render(); });
    on('ar-instate', 'change', ev => { S.inState = ev.target.value; render(); });
    on('ar-billkind', 'change', ev => { S.billKind = ev.target.value; render(); });
    on('ar-colstate', 'change', ev => { S.colState = ev.target.value; render(); });
    on('ar-month', 'change', ev => { S.month = ev.target.value; render(); });
    on('ar-refresh', 'click', () => load(true));
    on('ar-export', 'click', exportCsv);
    on('ar-tabs', 'click', ev => { const b = ev.target.closest('[data-ar-tab]'); if (b) { S.tab = b.dataset.arTab; render(); } });
    const bucketClick = ev => { const b = ev.target.closest('[data-ar-bucket]'); if (!b) return; const v = b.dataset.arBucket; S.bucket = S.bucket === v ? '' : v; render(); };
    on('ar-cards', 'click', bucketClick);
    on('ar-aging', 'click', bucketClick);
    const body = document.getElementById('ar-body');
    if (body) {
      const pick = (ev) => { const tr = ev.target.closest('[data-ar-open]'); if (tr) return open(tr.dataset.arOpen); const ti = ev.target.closest('[data-ar-inc]'); if (ti) return openIncoming(ti.dataset.arInc); const tb = ev.target.closest('[data-ar-bill]'); if (tb) return openBilling(tb.dataset.arBill); const tc = ev.target.closest('[data-ar-col]'); if (tc) return openCollection(tc.dataset.arCol); const tm2 = ev.target.closest('[data-ar-me]'); if (tm2) openMonthEndCustomer(tm2.dataset.arMe); };
      body.addEventListener('click', pick);
      body.addEventListener('keydown', ev => { if (ev.key === 'Enter') pick(ev); });
    }
    const pb = document.getElementById('panel-body');
    if (pb) pb.addEventListener('submit', ev => {
      const f = ev.target.closest('[data-ar-pause]'); if (!f) return;
      ev.preventDefault();
      const wrap = f.closest('[data-ar-col-id]'), out = f.querySelector('[data-ar-pause-msg]');
      const reason = f.reason.value, until = f.until.value;
      if ((reason === 'promise_to_pay' || reason === 'payment_plan') && !until) { out.textContent = 'Pick the date for a promise or a payment plan.'; return; }
      requestAction(wrap.dataset.arColId, 'pause', reason, until, f.note.value.trim(), out);
    });
    if (pb) pb.addEventListener('click', ev => {
      const rs = ev.target.closest('[data-ar-resume]');
      if (rs) { const wrap = rs.closest('[data-ar-col-id]'); requestAction(wrap.dataset.arColId, 'resume', null, null, '', wrap.querySelector('[data-ar-pause-msg]')); return; }
      const a = ev.target.closest('[data-ar-tenant]'); if (!a) return;
      ev.preventDefault();
      if (typeof openTenant === 'function') openTenant(a.dataset.arTenant);
    });
    // Live: Lu's refresh replaces the copy while the page is open (a new run, then its incoming-payments stamp).
    try {
      if (sb() && sb().channel) sb().channel('ar_sync_live').on('postgres_changes', { event: '*', schema: 'public', table: 'ar_sync_runs' }, () => { if (data) { clearTimeout(wire._t); wire._t = setTimeout(() => load(true), 1500); } }).subscribe();
    } catch (_) {}
    fromHash();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
