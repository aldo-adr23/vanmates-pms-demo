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

  window.AR_CORE = { BUCKETS, KINDS, STALE_HOURS, daysLate, bucketOf, money, moneyShort, addDays, summarize, tenantIndex, customerRows, matches, invoiceInBucket, sortCustomers, customersCsv, invoicesCsv, freshness, qboInvoiceUrl, qboCustomerUrl, canSee };
  if (typeof document === 'undefined') return;

  const S = { tab: 'customers', q: '', kind: '', city: '', bucket: '' };
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
        const [inv, un, run, links] = await Promise.all([
          sb().from('ar_open_invoices').select('*').order('due_date', { ascending: true }).limit(10000),
          sb().from('ar_unapplied_payments').select('*').limit(10000),
          sb().from('ar_sync_runs').select('*').order('synced_at', { ascending: false }).limit(1),
          sb().from('tenant_qb_links').select('tenant_id,qb_customer_id').limit(10000),
        ]);
        for (const r of [inv, un, run]) if (r.error) throw r.error;
        data = { invoices: inv.data || [], unapplied: un.data || [], lastRun: (run.data || [])[0] || null, links: links.error ? [] : (links.data || []) };
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
      : `${fr.stale ? `<span class="tag-pill red" style="font-size:11px">Out of date</span> ` : ''}QuickBooks copy from <b>${e(when(data.lastRun.synced_at))}</b> · read-only · refreshed by Lu every 2 hours, 8:50–20:50 Vancouver`;

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
    if (tabs) tabs.innerHTML = [['customers', 'Customers', list.length], ['invoices', 'Invoices', invRows.length]]
      .map(([k, l, n]) => `<button type="button" class="tab${S.tab === k ? ' active' : ''}" role="tab" aria-selected="${S.tab === k}" data-ar-tab="${k}">${l} <span class="name-sub">${n}</span></button>`).join('');

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
    const text = S.tab === 'customers' ? customersCsv(list) : invoicesCsv(list.flatMap(c => c.invoices.filter(i => invoiceInBucket(i, S.bucket, t)).map(i => ({ i, c }))), t);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = `ar-${S.tab}-${t}.csv`;
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
    let tm = null;
    on('ar-search', 'input', ev => { S.q = ev.target.value; clearTimeout(tm); tm = setTimeout(render, 150); });
    on('ar-kind', 'change', ev => { S.kind = ev.target.value; render(); });
    on('ar-city', 'change', ev => { S.city = ev.target.value; render(); });
    on('ar-refresh', 'click', () => load(true));
    on('ar-export', 'click', exportCsv);
    on('ar-tabs', 'click', ev => { const b = ev.target.closest('[data-ar-tab]'); if (b) { S.tab = b.dataset.arTab; render(); } });
    const bucketClick = ev => { const b = ev.target.closest('[data-ar-bucket]'); if (!b) return; const v = b.dataset.arBucket; S.bucket = S.bucket === v ? '' : v; render(); };
    on('ar-cards', 'click', bucketClick);
    on('ar-aging', 'click', bucketClick);
    const body = document.getElementById('ar-body');
    if (body) {
      body.addEventListener('click', ev => { const tr = ev.target.closest('[data-ar-open]'); if (tr) open(tr.dataset.arOpen); });
      body.addEventListener('keydown', ev => { if (ev.key !== 'Enter') return; const tr = ev.target.closest('[data-ar-open]'); if (tr) open(tr.dataset.arOpen); });
    }
    const pb = document.getElementById('panel-body');
    if (pb) pb.addEventListener('click', ev => {
      const a = ev.target.closest('[data-ar-tenant]'); if (!a) return;
      ev.preventDefault();
      if (typeof openTenant === 'function') openTenant(a.dataset.arTenant);
    });
    // Live: Lu's refresh replaces the copy while the page is open.
    try {
      if (sb() && sb().channel) sb().channel('ar_sync_live').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ar_sync_runs' }, () => { if (data) { clearTimeout(wire._t); wire._t = setTimeout(() => load(true), 1500); } }).subscribe();
    } catch (_) {}
    fromHash();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
