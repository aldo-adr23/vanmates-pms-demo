/* AP (portal): accounts payable — one list of everything Vanmates pays.
   Reads ap_items / ap_events through RLS (ap-2026-10-11.sql). Writes only through ap_staff_update / ap_staff_bulk
   (admins and accountants). Lu (the Slack bookkeeper) fills the list: cleaners' pay workbook, BC Hydro / FortisBC /
   internet bills from rent@ (PAD), and employee expenses (mirrored; those are approved on Lu's Slack card).
   Loaded by index.html after the main script (uses esc, showToast, CURRENT_USER, window.properties, window.vmDb.sb
   and the shared detail panel). */
(function(){
  const TYPES = { cleaning: 'Cleaning', utility: 'Utilities', internet: 'Internet', employee_expense: 'Employee expense', vendor: 'Vendor', b2b: 'B2B', refund: 'Refund', landlord_rent: 'Landlord rent', other: 'Other' };
  const TABS = [['all', 'All'], ['cleaning', 'Cleaning'], ['utility', 'Utilities'], ['internet', 'Internet'], ['employee_expense', 'Employee expenses'], ['vendor', 'Vendors'], ['b2b', 'B2B'], ['refund', 'Refunds'], ['landlord_rent', 'Landlords'], ['school', 'School properties']];
  const VIEWS = [['open', 'Open'], ['review', 'To review'], ['approved', 'Approved · to pay'], ['paid', 'Paid'], ['skipped', 'Skipped'], ['everything', 'Everything']];
  const STATUS = { needs_review: ['Needs review', 'red'], flagged: ['Flagged', 'red'], approved: ['Approved', 'blue'], paid: ['Paid', ''], recorded: ['In QuickBooks', ''], skipped: ['Skipped', ''] };
  const FLAGS = {
    no_etransfer_email: 'No e-transfer email', days_dont_add_up: "Days don't add up", sheet_total_mismatch: "Sheet total doesn't match",
    unmapped_account: 'Account has no property', amount_jump: 'Bigger than usual', unreadable: "Couldn't read amount", no_account_number: 'No account number',
    over_reimbursement_cap: 'Over reimbursement cap',
    no_cheque: 'No cheque this month', cheque_bounced: 'Cheque bounced', pad_missing: 'PAD not seen in the bank', amount_mismatch: "Amount doesn't match", landlord_says_unpaid: 'Landlord says unpaid',
  };
  // Refunds (ap-refunds-2026-10-30.sql): any service except checkout deposits, which run through Checkouts.
  const REFUND_KIND = { relocation: 'Relocation', homestay: 'Homestay', rent: 'Rent', special_housing: 'Special housing', coliving: 'Co-living', other: 'Other' };
  const METHOD = { etransfer: 'E-transfer', pad: 'PAD', payroll: 'Payroll', cheque: 'Cheque', card: 'Card', other: 'Other' };
  const COLS = 8;

  // ── pure helpers (window.AP_CORE, tested in test/ap.test.js) ──
  // Vendors / B2B also show employee receipts from a listed vendor (data.vendorKind, set by the database); they stay payroll items.
  const inTab = (r, tab) => tab === 'all' || r.type === tab || (['vendor', 'b2b'].includes(tab) && (r.data || {}).vendorKind === tab);
  function inView(r, view){
    if (view === 'everything') return true;
    if (view === 'open') return ['needs_review', 'flagged', 'approved'].includes(r.status);
    if (view === 'review') return ['needs_review', 'flagged'].includes(r.status);
    if (view === 'approved') return r.status === 'approved';
    if (view === 'paid') return ['paid', 'recorded'].includes(r.status);
    if (view === 'skipped') return r.status === 'skipped';
    return true;
  }
  const money = (cents) => (cents == null || !isFinite(Number(cents)) ? '—' : (Number(cents) < 0 ? '−' : '') + '$' + (Math.abs(Number(cents)) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  // Amount typed by staff ("1,234.50", "$99") -> cents, or null.
  function parseAmount(s){
    const t = String(s == null ? '' : s).replace(/[$,\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
    return Math.round(Number(t) * 100);
  }
  // Header cards: to review, approved (to pay by hand: not PAD / payroll), paid this month, flagged.
  function summarize(rows, ym){
    const sum = (l) => l.reduce((s, r) => s + Number(r.amount_cents || 0), 0);
    const review = rows.filter(r => ['needs_review', 'flagged'].includes(r.status));
    const toPay = rows.filter(r => r.status === 'approved' && !['pad', 'payroll'].includes(r.payment_method) && !(r.type === 'landlord_rent' && r.payment_method === 'cheque'));
    const paid = rows.filter(r => ['paid', 'recorded'].includes(r.status) && String(r.paid_at || '').slice(0, 7) === ym);
    return { review: review.length, reviewCents: sum(review), toPay: toPay.length, toPayCents: sum(toPay), paid: paid.length, paidCents: sum(paid), flagged: rows.filter(r => r.status === 'flagged').length };
  }
  // Oldest due first; undated last; then payee.
  function sortRows(list){
    const key = (r) => String(r.due_date || r.period_end || r.bill_date || '9999');
    return list.slice().sort((a, b) => key(a).localeCompare(key(b)) || String(a.payee).localeCompare(String(b.payee)));
  }
  const periodText = (r) => r.period_start && r.period_end ? `${r.period_start} → ${r.period_end}` : (r.bill_date || '');
  // What the drawer offers. Employee expenses are decided on Lu's Slack card, but can be edited or deleted here (Lu follows).
  // Once paid or in QuickBooks: details can still be fixed, the amount can't, and it can't be deleted.
  function actionsFor(r, canAct){
    const lu = r.type === 'employee_expense';
    const open = ['needs_review', 'flagged'].includes(r.status);
    const settled = ['paid', 'recorded'].includes(r.status) || !!r.qb_object_id;
    return {
      approve: canAct && !lu && open, skip: canAct && !lu && !['paid', 'recorded', 'skipped'].includes(r.status),
      reopen: canAct && !lu && ['skipped', 'approved'].includes(r.status), markPaid: canAct && !lu && r.status === 'approved',
      setProperty: canAct && !lu, setEmail: canAct && r.type === 'cleaning' && !['paid', 'recorded'].includes(r.status),
      edit: canAct, editAmount: canAct && !settled, remove: canAct && !settled, note: canAct,
    };
  }
  // Fields the edit form shows (ap_staff_edit allows the same). Employee expenses: what was on the receipt.
  const EDIT_FIELDS = {
    employee_expense: ['vendor', 'bill_date', 'amount_cents', 'property'],
    other: ['payee', 'property', 'bill_date', 'period_start', 'period_end', 'due_date', 'amount_cents', 'tax_cents', 'payment_method'],
  };
  const editFields = (r) => EDIT_FIELDS[r.type === 'employee_expense' ? 'employee_expense' : 'other'];
  // The edit form's values -> only what changed ({ patch }), or { error }. Amounts are typed in dollars.
  function editPatch(r, v){
    const patch = {};
    const cur = (k) => k === 'vendor' ? ((r.data || {}).vendor || '') : String(r[k] == null ? '' : r[k]).slice(0, k.endsWith('_date') || k.startsWith('period_') ? 10 : undefined);
    for (const k of editFields(r)) {
      if (!(k in v)) continue;
      const raw = String(v[k] == null ? '' : v[k]).trim();
      if (k === 'amount_cents' || k === 'tax_cents') {
        const c = raw === '' && k === 'tax_cents' ? 0 : parseAmount(raw);
        if (c == null) return { error: `Type the ${k === 'tax_cents' ? 'tax' : 'amount'} like 1234.50` };
        if (c !== Number(r[k] || 0)) patch[k] = c;
      } else if (k === 'payee' && !raw) return { error: 'The payee cannot be empty.' };
      else if (raw !== cur(k)) patch[k] = raw;
    }
    if ((patch.period_start || r.period_start) && (patch.period_end || r.period_end) && String(patch.period_end ?? r.period_end).slice(0, 10) < String(patch.period_start ?? r.period_start).slice(0, 10)) return { error: 'The period ends before it starts.' };
    return { patch };
  }
  // E-transfer list for the bank: tab-separated, header first, cleaners only, approved, with an email.
  function etransferList(rows){
    const ok = rows.filter(r => r.type === 'cleaning' && r.status === 'approved' && r.payee_email);
    return { text: ['Name\tE-transfer email\tAmount', ...ok.map(r => `${r.payee}\t${r.payee_email}\t${(Number(r.amount_cents) / 100).toFixed(2)}`)].join('\n'), count: ok.length, cents: ok.reduce((s, r) => s + Number(r.amount_cents), 0), missing: rows.filter(r => r.type === 'cleaning' && r.status === 'approved' && !r.payee_email).length };
  }
  // ── landlords: post-dated cheques ──
  // A batch typed by staff -> one cheque per month, consecutive numbers (zero padding kept), on the pay day (max 28).
  function batchPreview(b){
    const first = String(b.firstNo == null ? '' : b.firstNo).trim(), count = Number(b.count);
    if (!/^\d{1,12}$/.test(first)) return { error: 'The first cheque number must be digits.' };
    if (!Number.isInteger(count) || count < 1 || count > 24) return { error: 'Between 1 and 24 cheques.' };
    const m = /^(\d{4})-(\d{2})$/.exec(String(b.firstMonth || ''));
    if (!m) return { error: 'Pick the first month.' };
    if (!(Number(b.amountCents) > 0)) return { error: 'Type the amount of each cheque.' };
    const day = Math.min(28, Math.max(1, Number(b.payDay) || 1));
    const out = [];
    for (let i = 0; i < count; i++) {
      const mi = Number(m[2]) - 1 + i, y = Number(m[1]) + Math.floor(mi / 12), mo = (mi % 12) + 1;
      out.push({ cheque_no: String(BigInt(first) + BigInt(i)).padStart(first.length, '0'), dated_for: `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`, amount_cents: Number(b.amountCents) });
    }
    return out;
  }
  // Cheques still with the landlord, dated after today, for one payment set-up (or the landlord, for cheques with no set-up).
  const mineCheque = (c, term) => c.term_id ? c.term_id === term.id : c.landlord_id === term.landlord_id;
  const futureCheques = (cheques, term, today) => cheques.filter(c => mineCheque(c, term) && c.status === 'with_landlord' && String(c.dated_for) > today);
  const chequesLeft = (cheques, term, today) => futureCheques(cheques, term, today).length;
  // One row per set-up; cheque set-ups get a warning: none (0 left), low (1-2), ok. Worst first.
  function landlordSummary(terms, cheques, today){
    const rank = { none: 0, low: 1, unknown: 2, ok: 3 };
    return terms.map(term => {
      const fut = term.method === 'cheque' ? futureCheques(cheques, term, today) : [];
      const left = fut.length;
      // A cheque set-up whose current batch was never entered (made from bank records): count unknown, not an alarm.
      const warn = term.method !== 'cheque' ? null : (left === 0 && term.cheques_tracked === false) ? 'unknown' : left === 0 ? 'none' : left <= 2 ? 'low' : 'ok';
      return { term, left, lastDated: fut.map(c => String(c.dated_for)).sort().pop() || null, warn };
    }).sort((a, b) => (a.warn == null) - (b.warn == null) || (rank[a.warn] ?? 9) - (rank[b.warn] ?? 9) || a.left - b.left || String(a.term.landlord_name || '').localeCompare(String(b.term.landlord_name || '')));
  }
  // ── internet / utility accounts and school properties (ap-accounts-2026-10-21.sql) ──
  const ACC_STATUS = { active: ['Active', 'blue'], canceled: ['Canceled', ''] };
  // Where an account is: its portal property, else its school property, else the building as the sheet wrote it.
  const accountPlace = (a, schoolNames) => a.property || (a.school_property_id && (schoolNames || {})[a.school_property_id]) || a.building || '';
  // Accounts of one type (internet | utility) or at one school property, by status and search. Active first, then place and unit.
  function accountsFor(accounts, f, schoolNames){
    const q = String(f.q || '').trim().toLowerCase();
    return accounts.filter(a => (!f.type || a.type === f.type) && (!f.school || a.school_property_id === f.school) && (!f.status || a.status === f.status)
      && (!q || [a.provider, a.service, a.account_no, a.unit, a.building, a.address, a.property, a.login, a.payment_method, a.notes, accountPlace(a, schoolNames)].some(v => String(v || '').toLowerCase().includes(q))))
      .sort((x, y) => (x.status === 'active' ? 0 : 1) - (y.status === 'active' ? 0 : 1) || accountPlace(x, schoolNames).localeCompare(accountPlace(y, schoolNames))
        || String(x.unit || '').localeCompare(String(y.unit || ''), undefined, { numeric: true }));
  }
  // One row per school property: its active accounts by type, their monthly total and the units they cover.
  function schoolSummary(schools, accounts){
    return schools.map(s => {
      const mine = accounts.filter(a => a.school_property_id === s.id && a.status === 'active');
      return { s, internet: mine.filter(a => a.type === 'internet').length, utility: mine.filter(a => a.type === 'utility').length,
        monthlyCents: mine.reduce((t, a) => t + Number(a.monthly_cents || 0), 0),
        units: [...new Set(mine.map(a => String(a.unit || '').replace(/C$/, '')).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) };
    }).sort((a, b) => (b.s.active === false ? 0 : 1) - (a.s.active === false ? 0 : 1) || String(a.s.name).localeCompare(String(b.s.name)));
  }
  // ── vendors and B2B partners (ap-vendors-2026-10-30.sql) ──
  // One row per list entry of a kind: its items (by data.vendorId), what is still open, what was paid in the last 12 months.
  function vendorSummary(vendors, rows, kind, today, q){
    const since = new Date(new Date((today || new Date().toISOString().slice(0, 10)) + 'T12:00:00Z').getTime() - 365 * 864e5).toISOString().slice(0, 10);
    const t = String(q || '').trim().toLowerCase();
    return vendors.filter(v => v.kind === kind && (!t || [v.name, v.category, v.email, v.city, v.notes, ...(v.aliases || [])].some(x => String(x || '').toLowerCase().includes(t))))
      .map(v => {
        const mine = rows.filter(r => (r.data || {}).vendorId === v.id);
        const open = mine.filter(r => ['needs_review', 'flagged', 'approved'].includes(r.status));
        const paid = mine.filter(r => ['paid', 'recorded'].includes(r.status) && String(r.paid_at || r.bill_date || '').slice(0, 10) >= since);
        const sum = (l) => l.reduce((s, r) => s + Number(r.amount_cents || 0), 0);
        return { v, items: mine.length, open: open.length, openCents: sum(open), paidCents: sum(paid),
          last: mine.map(r => String(r.bill_date || r.created_at || '').slice(0, 10)).filter(Boolean).sort().pop() || null };
      })
      .sort((a, b) => (b.v.active === false ? 0 : 1) - (a.v.active === false ? 0 : 1) || b.open - a.open || String(a.v.name).localeCompare(String(b.v.name)));
  }
  // Aliases typed in the form: "Obox, Obox Solutions" -> ['Obox', 'Obox Solutions'] (trimmed, no blanks, no repeats).
  const parseAliases = (s) => [...new Set(String(s || '').split(',').map(x => x.trim()).filter(Boolean))];
  /** Add property form defaults from a bill: "1200 Rue Jeanne-Mance # 1609, MONTRÉAL QC H2X0E8" -> that street as the name
   * (or the bill's property when it is not a portal property yet), the address, and the city when the form lists it. */
  function newPropertyPrefill(r, names){
    const addr = String(((r && r.data) || {}).serviceAddress || '').trim();
    const city = /montr[eé]al/i.test(addr) ? 'Montréal' : /toronto/i.test(addr) ? 'Toronto' : /vancouver/i.test(addr) ? 'Vancouver' : '';
    const street = addr.split(',')[0].replace(/\s*#\s*/, ' · ').trim();
    return { name: r && r.property && !(names || []).includes(r.property) ? r.property : street, addr, city };
  }
  // Same rule as vm_ap_approver(): admins, accountants, and anyone granted the AP page.
  const canAct = (u) => !!u && (['admin', 'accountant'].includes(String(u.role || '')) || (Array.isArray(u.allowed_pages) && u.allowed_pages.includes('ap')));
  window.AP_CORE = { TYPES, TABS, VIEWS, STATUS, FLAGS, METHOD, inTab, inView, money, parseAmount, summarize, sortRows, actionsFor, editFields, editPatch, etransferList, canAct, periodText, batchPreview, chequesLeft, landlordSummary, ACC_STATUS, accountPlace, accountsFor, schoolSummary, newPropertyPrefill, vendorSummary, parseAliases, REFUND_KIND };
  if (typeof document === 'undefined') return;

  const S = { tab: 'all', view: 'open', q: '', city: '', sel: new Set() };
  let rows = null, loading = null, openSeq = 0;
  const e = (s) => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const toast = (m) => { if (typeof showToast === 'function') showToast(m); };
  const me = () => { const u = (typeof CURRENT_USER !== 'undefined' && CURRENT_USER) || {}; return { email: String(u.email || '').toLowerCase(), role: String(u.role || ''), allowed_pages: Array.isArray(u.allowed_pages) ? u.allowed_pages : [] }; };
  const sb = () => window.vmDb && window.vmDb.sb;
  const pill = (s) => { const [l, c] = STATUS[s] || [s, '']; return `<span class="tag-pill ${c}" style="font-size:11px">${e(l)}</span>`; };
  const flag = (f) => `<span class="tag-pill red" style="font-size:11px;margin:1px">${e(FLAGS[f] || f.replace(/_/g, ' '))}</span>`;
  const H = (t) => `<h4 style="margin:22px 0 6px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)">${e(t)}</h4>`;
  const when = (ts) => { if (!ts) return '—'; const d = new Date(ts); return isNaN(d) ? String(ts) : d.toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }); };
  const ym = () => new Date().toISOString().slice(0, 7);
  const SELECT = 'id,type,status,payee,payee_email,account_no,property,city,period_start,period_end,bill_date,due_date,amount_cents,tax_cents,payment_method,paid_at,paid_ref,source,source_ref,doc_url,flags,notes,qb_object_id,approved_by,approved_at,data,created_at,updated_at';

  async function load(force){
    if (loading) return loading;
    if (rows && !force) { render(); return; }
    const body = document.getElementById('ap-body');
    if (!sb()) { if (body) body.innerHTML = `<tr><td colspan="${COLS}" class="name-sub">Not connected to the database.</td></tr>`; return; }
    if (body && !rows) body.innerHTML = `<tr><td colspan="${COLS}" class="name-sub">Loading…</td></tr>`;
    loading = (async () => {
      try {
        const r = await sb().from('ap_items').select(SELECT).is('deleted_at', null).order('created_at', { ascending: false }).limit(5000);
        if (r.error) throw r.error;
        rows = r.data || [];
        const ids = new Set(rows.map(x => x.id));
        S.sel.forEach(id => { if (!ids.has(id)) S.sel.delete(id); });
        render();
      } catch (err) {
        console.error('[ap] load failed', err);
        const msg = String(err && err.message || err);
        const missing = /ap_items/.test(msg) && /exist|schema cache/i.test(msg);
        if (body) body.innerHTML = `<tr><td colspan="${COLS}" class="name-sub">${missing ? 'AP is not set up in the database yet (run ap-2026-10-11.sql).' : 'Could not load AP: ' + e(msg)}</td></tr>`;
      } finally { loading = null; }
    })();
    return loading;
  }

  function filtered(){
    const q = S.q.trim().toLowerCase();
    return (rows || []).filter(r => inTab(r, S.tab) && inView(r, S.view)
      && (!S.city || String(r.city || '').toLowerCase().startsWith(S.city.toLowerCase().slice(0, 3)))
      && (!q || [r.payee, r.payee_email, r.property, r.account_no, r.paid_ref, r.notes, (r.data || {}).vendor, (r.data || {}).reason, REFUND_KIND[(r.data || {}).refundKind]].some(v => String(v || '').toLowerCase().includes(q))));
  }

  function render(){
    if (!rows) return;
    const sum = summarize(rows, ym());
    const badge = document.querySelector('.nav-item[data-view="ap"] .nav-count');
    if (badge) badge.textContent = String(sum.review);
    const cards = document.getElementById('ap-cards');
    if (cards) cards.innerHTML = [
      ['To review', sum.review, sum.reviewCents, 'review'], ['Approved · to pay', sum.toPay, sum.toPayCents, 'approved'],
      ['Paid this month', sum.paid, sum.paidCents, 'paid'], ['Flagged', sum.flagged, null, 'review'],
    ].map(([l, n, c, v]) => `<button type="button" class="card" data-ap-view="${v}" style="text-align:left;padding:14px 16px;cursor:pointer;border:1px solid var(--line,#e5e2dc)">
        <div class="name-sub">${e(l)}</div><div style="font-size:22px;font-weight:600;margin-top:4px">${e(n)}</div>${c != null ? `<div class="name-sub">${e(money(c))}</div>` : ''}</button>`).join('');
    const tabs = document.getElementById('ap-tabs');
    const tabCount = (k) => k === 'school' ? (ACC.schools ? ACC.schools.filter(x => x.active !== false).length : '') : rows.filter(r => inTab(r, k) && inView(r, S.view)).length;
    if (tabs) tabs.innerHTML = TABS.map(([k, l]) => `<button type="button" class="tab${S.tab === k ? ' active' : ''}" role="tab" aria-selected="${S.tab === k}" data-ap-tab="${k}">${l} <span class="name-sub">${tabCount(k)}</span></button>`).join('');
    const vsel = document.getElementById('ap-view'); if (vsel && vsel.value !== S.view) vsel.value = S.view;
    const list = sortRows(filtered());
    const cnt = document.getElementById('ap-count'); if (cnt) cnt.textContent = list.length;
    const tot = document.getElementById('ap-total'); if (tot) tot.textContent = money(list.reduce((s, r) => s + Number(r.amount_cents || 0), 0));
    const empty = document.getElementById('ap-empty'); if (empty) empty.style.display = list.length ? 'none' : '';
    const body = document.getElementById('ap-body');
    if (body) body.innerHTML = list.map(r => `<tr class="clickable" data-ap-open="${e(r.id)}" tabindex="0" style="cursor:pointer">
        <td onclick="event.stopPropagation()"><input type="checkbox" data-ap-sel="${e(r.id)}" ${S.sel.has(r.id) ? 'checked' : ''} aria-label="Select ${e(r.payee)}"></td>
        <td>${e(TYPES[r.type] || r.type)}<div class="name-sub">${e([r.type === 'refund' ? REFUND_KIND[(r.data || {}).refundKind] : '', METHOD[r.payment_method]].filter(Boolean).join(' · '))}</div></td>
        <td><b>${e(r.payee)}</b>${r.payee_email ? `<div class="name-sub">${e(r.payee_email)}</div>` : r.account_no ? `<div class="name-sub">Acct ${e(r.account_no)}</div>` : (r.data || {}).vendor ? `<div class="name-sub">${e(r.data.vendor)}</div>` : ''}</td>
        <td>${e(r.property || '—')}<div class="name-sub">${e(r.city || '')}</div></td>
        <td>${e(periodText(r) || '—')}${r.due_date ? `<div class="name-sub">Due ${e(r.due_date)}</div>` : ''}</td>
        <td style="text-align:right;white-space:nowrap"><b>${e(money(r.amount_cents))}</b></td>
        <td>${pill(r.status)}</td>
        <td>${(r.flags || []).map(flag).join(' ')}</td>
      </tr>`).join('');
    bulkBar(list);
    layout();
  }

  function bulkBar(list){
    const bar = document.getElementById('ap-bulk');
    if (!bar) return;
    const picked = (rows || []).filter(r => S.sel.has(r.id));
    const act = canAct(me());
    if (!picked.length) {
      const visibleApprovedCleaning = list.filter(r => r.type === 'cleaning' && r.status === 'approved');
      bar.innerHTML = visibleApprovedCleaning.length ? `<span class="name-sub">${visibleApprovedCleaning.length} approved cleaner payment(s) shown.</span>
        <button class="btn btn-ghost" type="button" data-ap-bulk="copy-visible">Copy e-transfer list</button>` : `<span class="name-sub">Tick rows to approve, pay or skip several at once.</span>`;
      return;
    }
    const total = picked.reduce((s, r) => s + Number(r.amount_cents || 0), 0);
    bar.innerHTML = `<b>${picked.length} selected · ${e(money(total))}</b>
      ${act ? `<button class="btn btn-primary" type="button" data-ap-bulk="approve">Approve</button>
      <input class="form-input" id="ap-bulk-ref" placeholder="Payment reference (optional)" style="max-width:220px">
      <button class="btn" type="button" data-ap-bulk="mark_paid">Mark paid</button>
      <button class="btn btn-ghost" type="button" data-ap-bulk="skip">Skip</button>
      <button class="btn btn-ghost" type="button" data-ap-bulk="delete" style="color:var(--red,#b42318)">Delete</button>` : ''}
      <button class="btn btn-ghost" type="button" data-ap-bulk="copy">Copy e-transfer list</button>
      <button class="btn btn-ghost" type="button" data-ap-bulk="clear">Clear</button>`;
  }

  async function copyList(list){
    const x = etransferList(list);
    if (!x.count) { toast(x.missing ? `None of these have an e-transfer email yet (${x.missing} missing).` : 'Approve cleaner payments first; only approved ones go on the list.'); return; }
    try { await navigator.clipboard.writeText(x.text); toast(`Copied ${x.count} e-transfer(s), ${money(x.cents)}${x.missing ? ` · ${x.missing} without an email left out` : ''}.`); }
    catch { toast('Could not copy to the clipboard.'); }
  }

  async function bulk(action){
    const picked = (rows || []).filter(r => S.sel.has(r.id));
    if (action === 'clear') { S.sel.clear(); render(); return; }
    if (action === 'copy') return copyList(picked);
    if (action === 'copy-visible') return copyList(sortRows(filtered()));
    if (action === 'delete') return bulkDelete(picked);
    const eligible = picked.filter(r => { const a = actionsFor(r, true); return action === 'approve' ? a.approve : action === 'mark_paid' ? a.markPaid : a.skip; });
    if (!eligible.length) { toast(action === 'mark_paid' ? 'Only approved items can be marked paid.' : action === 'approve' ? 'Nothing selected can be approved here (employee expenses are approved on Lu\'s Slack card).' : 'Nothing selected can be skipped.'); return; }
    const ref = (document.getElementById('ap-bulk-ref') || {}).value || '';
    try {
      const r = await sb().rpc('ap_staff_bulk', { p_ids: eligible.map(x => x.id), p_action: action, p_patch: action === 'mark_paid' ? { paid_ref: ref } : {} });
      if (r.error) throw r.error;
      toast(`${r.data} item(s) ${action === 'approve' ? 'approved' : action === 'mark_paid' ? 'marked paid' : 'skipped'}${eligible.length < picked.length ? ` · ${picked.length - eligible.length} left as they were` : ''}.`);
      S.sel.clear();
      await load(true);
    } catch (err) { toast('Could not update: ' + (err && err.message || err)); }
  }

  // One at a time (each is its own event, so Lu sees every employee expense that goes).
  async function bulkDelete(picked){
    const ok = picked.filter(r => actionsFor(r, true).remove);
    if (!ok.length) { toast('Paid items and items already in QuickBooks cannot be deleted.'); return; }
    const lu = ok.filter(r => r.type === 'employee_expense').length;
    if (!confirm(`Delete ${ok.length} item(s), ${money(ok.reduce((s, r) => s + Number(r.amount_cents || 0), 0))}?${lu ? `\n\n${lu} employee expense(s): Lu takes them out of payroll too.` : ''}${ok.length < picked.length ? `\n\n${picked.length - ok.length} paid item(s) stay.` : ''}`)) return;
    let n = 0;
    for (const r of ok) {
      const res = await sb().rpc('ap_staff_delete', { p_id: r.id, p_reason: null });
      if (res.error) { toast(`Deleted ${n}; ${r.payee} failed: ${res.error.message}`); break; }
      n++;
    }
    if (n === ok.length) toast(`${n} item(s) deleted.`);
    S.sel.clear();
    await load(true);
  }

  async function saveEdit(id, patch){
    try {
      const r = await sb().rpc('ap_staff_edit', { p_id: id, p_patch: patch });
      if (r.error) throw r.error;
      const i = (rows || []).findIndex(x => x.id === id);
      if (i >= 0 && r.data) rows[i] = Object.assign({}, rows[i], r.data);
      toast('Saved.');
      render();
      await open(id);
    } catch (err) { toast('Could not save: ' + (err && err.message || err)); }
  }

  async function removeItem(id, reason){
    try {
      const r = await sb().rpc('ap_staff_delete', { p_id: id, p_reason: reason || null });
      if (r.error) throw r.error;
      rows = (rows || []).filter(x => x.id !== id);
      S.sel.delete(id);
      closePanel();
      render();
      toast('Deleted.');
    } catch (err) { toast('Could not delete: ' + (err && err.message || err)); }
  }

  function closePanel(){
    const p = document.getElementById('detail-panel'); if (p) { p.classList.remove('open'); p.setAttribute('aria-hidden', 'true'); }
    const b = document.getElementById('panel-backdrop'); if (b) b.classList.remove('open');
  }

  // The edit form, hidden until "Edit" is clicked.
  function editForm(r, a){
    const d = r.data || {};
    const date = (v) => String(v || '').slice(0, 10);
    const dollars = (c) => (Number(c || 0) / 100).toFixed(2);
    const inp = (name, label, val, attrs) => `<label style="display:grid;gap:3px;min-width:0"><span class="name-sub">${e(label)}</span><input class="form-input" name="${name}" value="${e(val)}" style="width:100%;min-width:0;box-sizing:border-box" ${attrs || ''}></label>`;
    const F = {
      payee: () => inp('payee', 'Payee', r.payee, 'required'),
      vendor: () => inp('vendor', 'Vendor', d.vendor || ''),
      property: () => `<label style="display:grid;gap:3px;min-width:0;grid-column:1/-1"><span class="name-sub">Property</span><select class="form-input" name="property" style="width:100%;min-width:0;box-sizing:border-box">${propertyOptions(r.property)}</select></label>`,
      bill_date: () => inp('bill_date', r.type === 'employee_expense' ? 'Receipt date' : 'Bill date', date(r.bill_date), 'type="date"'),
      period_start: () => inp('period_start', 'Period from', date(r.period_start), 'type="date"'),
      period_end: () => inp('period_end', 'Period to', date(r.period_end), 'type="date"'),
      due_date: () => inp('due_date', 'Due', date(r.due_date), 'type="date"'),
      amount_cents: () => inp('amount_cents', 'Amount ($)', dollars(r.amount_cents), `inputmode="decimal"${a.editAmount ? '' : ' disabled title="Paid or in QuickBooks: the amount is locked"'}`),
      tax_cents: () => inp('tax_cents', 'Tax included ($)', dollars(r.tax_cents), `inputmode="decimal"${a.editAmount ? '' : ' disabled'}`),
      payment_method: () => `<label style="display:grid;gap:3px;min-width:0"><span class="name-sub">Paid by</span><select class="form-input" name="payment_method" style="width:100%;min-width:0;box-sizing:border-box"><option value="">—</option>${Object.entries(METHOD).map(([k, l]) => `<option value="${k}" ${k === r.payment_method ? 'selected' : ''}>${e(l)}</option>`).join('')}</select></label>`,
    };
    return `<form data-ap-form="edit" style="display:none;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:10px">
      ${editFields(r).map(k => F[k]()).join('')}
      <div style="grid-column:1/-1;display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-ghost" type="button" data-ap-do="edit-cancel">Cancel</button><button class="btn btn-primary" type="submit">Save changes</button></div>
      ${r.type === 'employee_expense' ? `<div class="name-sub" style="grid-column:1/-1">Lu updates the receipt within ~10 minutes, so payroll reimburses the new amount.</div>` : ''}
    </form>`;
  }

  async function act(id, action, patch){
    try {
      const r = await sb().rpc('ap_staff_update', { p_id: id, p_action: action, p_patch: patch || {} });
      if (r.error) throw r.error;
      const i = (rows || []).findIndex(x => x.id === id);
      if (i >= 0 && r.data) rows[i] = Object.assign({}, rows[i], r.data);
      render();
      await open(id);
      return true;
    } catch (err) { toast('Could not update: ' + (err && err.message || err)); return false; }
  }

  function propertyOptions(current, withNew){
    const names = [...new Set(((window.properties || [])).map(p => p && p.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return `<option value="">— choose —</option>` + names.map(n => `<option ${n === current ? 'selected' : ''}>${e(n)}</option>`).join('') + (current && !names.includes(current) ? `<option selected>${e(current)}</option>` : '')
      + (withNew && typeof window.openAddProperty === 'function' ? `<option value="${NEW_PROP}">+ Add new property…</option>` : '');
  }
  const NEW_PROP = '__new_property__';

  async function open(id){
    const r = (rows || []).find(x => x.id === id);
    if (!r) return;
    const tok = ++openSeq;
    const d = r.data || {};
    document.getElementById('panel-hero').textContent = String(r.payee || '?').slice(0, 1).toUpperCase();
    document.getElementById('panel-title').innerHTML = e(r.payee);
    document.getElementById('panel-sub').textContent = `${TYPES[r.type] || r.type} · ${money(r.amount_cents)}${r.property ? ' · ' + r.property : ''}`;
    document.getElementById('panel-meta').innerHTML = pill(r.status) + ' ' + (r.flags || []).map(flag).join(' ');
    document.getElementById('panel-body').innerHTML = `<div data-ap-tok="${tok}" class="name-sub" style="padding:18px 0">Loading…</div>`;
    document.getElementById('detail-panel').classList.add('open');
    document.getElementById('detail-panel').setAttribute('aria-hidden', 'false');
    document.getElementById('panel-backdrop').classList.add('open');
    let events = [];
    try { const ev = await sb().from('ap_events').select('action,actor,detail,created_at').eq('item_id', id).order('created_at', { ascending: true }); events = ev.data || []; } catch (_) {}
    if (tok !== openSeq || !document.querySelector(`#panel-body [data-ap-tok="${tok}"]`)) return;
    const a = actionsFor(r, canAct(me()));
    const field = (l, v) => v ? `<div style="display:flex;gap:10px"><span class="name-sub" style="min-width:120px">${e(l)}</span><span>${v}</span></div>` : '';
    const days = d.days && typeof d.days === 'object' ? Object.entries(d.days).sort() : [];
    document.getElementById('panel-body').innerHTML = `<div data-ap-tok="${tok}" data-ap-id="${e(r.id)}">
      <div style="display:grid;gap:6px">
        ${field('Amount', `<b>${e(money(r.amount_cents))}</b>${r.tax_cents ? ` <span class="name-sub">incl. tax ${e(money(r.tax_cents))}</span>` : ''}`)}
        ${field('Type', e(TYPES[r.type] || r.type) + (r.payment_method ? ' · ' + e(METHOD[r.payment_method] || r.payment_method) : ''))}
        ${field('Period', e(periodText(r)))}
        ${field('Due', e(r.due_date || ''))}
        ${field('E-transfer to', e(r.payee_email || ''))}
        ${field('Account', e(r.account_no || ''))}
        ${field('Property', e(r.property || ''))}
        ${field('City', e(r.city || ''))}
        ${field('Service address', e(d.serviceAddress || ''))}
        ${r.type === 'refund' ? field('Refund for', e(REFUND_KIND[d.refundKind] || d.refundKind || '')) + field('Reason', e(d.reason || '')) : ''}
        ${field('Vendor', e(d.vendor || ''))}
        ${d.vendorId ? field('On the list', `${e(d.vendorName || '')} <span class="tag-pill" style="font-size:11px">${d.vendorKind === 'b2b' ? 'B2B' : 'Vendor'}</span>`) : ''}
        ${field('Paid', r.paid_at ? e(when(r.paid_at)) + (r.paid_ref ? ' · ' + e(r.paid_ref) : '') : '')}
        ${field('Approved', r.approved_at ? e(when(r.approved_at)) + ' · ' + e(r.approved_by || '') : '')}
        ${field('Source', r.doc_url ? `<a class="btn btn-ghost btn-mini" style="text-decoration:none" href="${e(r.doc_url)}" target="_blank" rel="noopener">${r.type === 'employee_expense' ? 'View receipt' : 'Open the original'} ↗</a>` : e(r.source))}
        ${d.recentAverageCents ? field('Usual amount', e(money(d.recentAverageCents))) : ''}
      </div>
      ${a.edit || a.remove ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
        ${a.edit ? `<button class="btn" type="button" data-ap-do="${r.type === 'refund' ? 'refund-edit' : 'edit-open'}" ${r.type === 'refund' && !a.editAmount ? 'disabled title="Paid: a paid refund cannot change"' : ''}>Edit</button>` : ''}
        ${a.remove ? `<button class="btn btn-ghost" type="button" data-ap-do="delete-open" style="color:var(--red,#b42318)">Delete</button>` : ''}</div>
        ${a.edit ? editForm(r, a) : ''}
        ${a.remove ? `<form data-ap-form="delete" style="display:none;gap:8px;margin-top:10px;padding:12px;border:1px solid var(--line,#e5e2dc);border-radius:8px">
          <b>Delete this ${e((TYPES[r.type] || 'item').toLowerCase())}?</b>
          <span class="name-sub">${r.type === 'employee_expense' ? `It leaves this list and Lu takes it out of ${e(r.payee)}'s payroll reimbursement.` : 'It leaves this list. Use Skip instead if it is real but we are not paying it.'}</span>
          <input class="form-input" name="reason" placeholder="Why (optional): duplicate, wrong amount…">
          <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-ghost" type="button" data-ap-do="delete-cancel">Cancel</button><button class="btn btn-primary" type="submit" style="background:var(--red,#b42318);border-color:var(--red,#b42318)">Delete</button></div>
        </form>` : ''}` : ''}
      ${days.length ? H('By day') + `<div style="display:grid;grid-template-columns:auto auto;gap:2px 16px;max-width:280px">${days.map(([k, v]) => `<span class="name-sub">${e(k)}</span><span style="text-align:right">${e(money(v))}</span>`).join('')}</div>` : ''}
      ${r.type === 'employee_expense' ? `<p class="name-sub" style="margin-top:16px">Employee expenses are approved on Lu's card in Slack (#bookkeping-review) and paid through payroll. Edits and deletes made here reach Lu too.</p>` : ''}
      ${a.approve || a.skip || a.reopen ? H('Decision') + `<div style="display:flex;gap:8px;flex-wrap:wrap">
        ${a.approve ? `<button class="btn btn-primary" type="button" data-ap-do="approve">Approve</button>` : ''}
        ${a.reopen ? `<button class="btn" type="button" data-ap-do="reopen">Back to review</button>` : ''}
        ${a.skip ? `<button class="btn btn-ghost" type="button" data-ap-do="skip">Skip</button>` : ''}</div>` : ''}
      ${a.markPaid ? H('Mark paid') + `<form data-ap-form="mark_paid" style="display:flex;gap:8px;flex-wrap:wrap"><input class="form-input" name="ref" placeholder="E-transfer reference / cheque # (optional)" style="max-width:280px"><button class="btn btn-primary" type="submit">Mark paid</button></form>` : ''}
      ${a.setEmail ? H('E-transfer email') + `<form data-ap-form="set_email" style="display:flex;gap:8px;flex-wrap:wrap"><input class="form-input" name="email" type="email" value="${e(r.payee_email || '')}" placeholder="name@example.com" style="max-width:280px" required><button class="btn" type="submit">Save</button></form><div class="name-sub">Remembered for ${e(r.payee)}'s next pay period.</div>` : ''}
      ${a.setProperty ? H('Property') + `<form data-ap-form="set_property" style="display:flex;gap:8px;flex-wrap:wrap"><select class="form-input" name="property" style="max-width:320px" data-ap-prop>${propertyOptions(r.property, true)}</select><button class="btn" type="submit">Save</button></form>${['utility', 'internet'].includes(r.type) && r.account_no ? `<div class="name-sub">Account ${e(r.account_no)} will use this property for future bills.</div>` : ''}` : ''}
      ${a.note ? H('Note') + `<form data-ap-form="note" style="display:grid;gap:8px"><textarea class="form-input" name="note" rows="2">${e(r.notes || '')}</textarea><div style="display:flex;justify-content:flex-end"><button class="btn btn-ghost" type="submit">Save note</button></div></form>` : (r.notes ? H('Note') + `<div>${e(r.notes)}</div>` : '')}
      ${H('History')}<div style="display:grid;gap:4px">${events.map(ev => `<div class="name-sub">${e(when(ev.created_at))} · ${e(ev.actor || '')} · ${e(String(ev.action).replace(/_/g, ' '))}${ev.detail && ev.detail.paid_ref ? ' · ' + e(ev.detail.paid_ref) : ''}${ev.detail && ev.detail.status && ev.action !== 'delete' ? ' → ' + e(ev.detail.status) : ''}${ev.action === 'edit' && ev.detail && ev.detail.changes ? ' · ' + e(Object.keys(ev.detail.changes).map(k => k.replace(/_cents$/, '').replace(/_/g, ' ')).join(', ')) : ''}</div>`).join('') || '<div class="name-sub">—</div>'}</div>
    </div>`;
  }

  // ───────────── AP → Landlords: monthly rent · cheques · payment set-up ─────────────
  const LL = { view: 'month', month: ym(), terms: null, cheques: null, loading: null, generated: false, q: '', status: 'with_landlord', landlord: '' };
  const CHQ = { with_landlord: ['With landlord', 'blue'], cashed: ['Cashed', ''], void: ['Void', ''], bounced: ['Bounced', 'red'] };
  const WARN = { none: ['No cheques left', 'red'], low: ['Needs cheques', 'red'], unknown: ['Batch not entered', ''], ok: ['OK', ''] };
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
  const chip = ([l, c]) => `<span class="tag-pill ${c}" style="font-size:11px">${e(l)}</span>`;
  const shiftMonth = (m, d) => { const [y, mo] = m.split('-').map(Number); const t = new Date(Date.UTC(y, mo - 1 + d, 1)); return t.toISOString().slice(0, 7); };
  const monthName = (m) => new Date(m + '-15T12:00:00Z').toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
  // Active landlords with their leases (LL-CORE, index.html). Archived ones only when they still have a set-up.
  function llLandlords(){
    const list = Array.isArray(window.landlords) ? window.landlords : (typeof landlords !== 'undefined' && Array.isArray(landlords) ? landlords : []);
    const leases = (l) => (typeof llContracts === 'function' ? llContracts(l) : (l.contracts || []));
    return list.filter(l => l && l.id).map(l => ({ l, leases: leases(l) }));
  }

  async function llLoad(force){
    if (LL.loading) return LL.loading;
    if (LL.terms && LL.cheques && !force) { renderLL(); return; }
    LL.loading = (async () => {
      try {
        if (!LL.generated && canAct(me())) {
          LL.generated = true;  // make sure this month and next have their lines (idempotent)
          await sb().rpc('ap_landlord_rent_generate', { p_month: today() });
          await sb().rpc('ap_landlord_rent_generate', { p_month: shiftMonth(today().slice(0, 7), 1) + '-01' });
          await load(true);
        }
        const [t, c] = await Promise.all([
          sb().from('ap_landlord_terms').select('*').order('landlord_name'),
          sb().from('ap_cheques').select('*').order('dated_for', { ascending: true }).limit(5000),
        ]);
        if (t.error) throw t.error; if (c.error) throw c.error;
        LL.terms = t.data || []; LL.cheques = c.data || [];
        renderLL();
      } catch (err) {
        console.error('[ap] landlords load failed', err);
        const msg = String(err && err.message || err);
        const note = document.getElementById('ap-ll-note');
        if (note) note.textContent = /ap_cheques|ap_landlord_terms/.test(msg) && /exist|schema cache/i.test(msg) ? 'Landlords is not set up in the database yet (run ap-landlords-2026-10-11.sql).' : 'Could not load landlords: ' + msg;
      } finally { LL.loading = null; }
    })();
    return LL.loading;
  }

  // Landlords and School properties replace the bills list; Internet and Utilities show their accounts under it.
  function layout(){
    const on = S.tab === 'landlord_rent', school = S.tab === 'school', acc = school || ['internet', 'utility'].includes(S.tab);
    const ll = document.getElementById('ap-ll'), list = document.getElementById('ap-list-card'), bar = document.getElementById('ap-filter-bar'), card = document.getElementById('ap-acc');
    if (ll) ll.style.display = on ? '' : 'none';
    if (list) list.style.display = on || school ? 'none' : '';
    if (bar) bar.style.display = on || school ? 'none' : '';
    if (card) card.style.display = acc ? '' : 'none';
    const addRf = document.getElementById('ap-add-refund');
    if (addRf) addRf.style.display = S.tab === 'refund' && canAct(me()) ? '' : 'none';
    const ven = ['vendor', 'b2b'].includes(S.tab), vcard = document.getElementById('ap-ven');
    if (vcard) vcard.style.display = ven ? '' : 'none';
    if (on) { if (!LL.terms) llLoad(); else renderLL(); }
    if (acc) { if (!ACC.accounts) accLoad(); else renderAcc(); }
    if (ven) { if (!VEN.list) venLoad(); else renderVen(); }
  }

  function renderLL(){
    if (S.tab !== 'landlord_rent') return;
    const views = document.getElementById('ap-ll-views'), tools = document.getElementById('ap-ll-tools'), head = document.getElementById('ap-ll-head'),
      body = document.getElementById('ap-ll-body'), note = document.getElementById('ap-ll-note'), empty = document.getElementById('ap-ll-empty');
    if (!views || !body) return;
    const terms = LL.terms || [], cheques = LL.cheques || [], t0 = today();
    const summary = landlordSummary(terms.filter(t => t.active), cheques, t0);
    const warnN = summary.filter(r => r.warn === 'none' || r.warn === 'low').length;
    views.innerHTML = [['month', 'This month'], ['cheques', 'Cheques'], ['landlords', 'Landlords']].map(([k, l]) =>
      `<button type="button" class="tab${LL.view === k ? ' active' : ''}" role="tab" aria-selected="${LL.view === k}" data-ll-view="${k}">${l}${k === 'landlords' && warnN ? ` <span class="tag-pill red" style="font-size:10px">${warnN}</span>` : ''}</button>`).join('');
    let html = '', n = 0;
    if (LL.view === 'month') {
      const lines = (rows || []).filter(r => r.type === 'landlord_rent' && String(r.period_start || '').slice(0, 7) === LL.month)
        .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)) || String(a.payee).localeCompare(String(b.payee)));
      const sum = (l) => l.reduce((s, r) => s + Number(r.amount_cents || 0), 0);
      const paid = lines.filter(r => ['paid', 'recorded'].includes(r.status));
      const probs = lines.filter(r => r.status === 'flagged' || (r.flags || []).length);
      tools.innerHTML = `<button class="btn btn-ghost" type="button" data-ll-month="-1" aria-label="Previous month">‹</button><b style="min-width:130px;text-align:center">${e(monthName(LL.month))}</b><button class="btn btn-ghost" type="button" data-ll-month="1" aria-label="Next month">›</button>`
        + (canAct(me()) ? `<button class="btn btn-ghost" type="button" data-ll-do="generate">Refresh lines</button>` : '');
      note.textContent = lines.length ? `${lines.length} lease(s) · ${money(sum(lines))} · paid ${paid.length} (${money(sum(paid))})${probs.length ? ` · ${probs.length} need attention` : ''}` : 'No rent lines for this month. Set up how each landlord is paid in the Landlords view.';
      head.innerHTML = '<tr><th>Landlord</th><th>Property</th><th>Method</th><th>Due</th><th style="text-align:right">Amount</th><th>Cheque</th><th>Status</th><th>Flags</th></tr>';
      html = lines.map(r => `<tr class="clickable" data-ap-open="${e(r.id)}" tabindex="0" style="cursor:pointer">
        <td><b>${e(r.payee)}</b></td><td>${e(r.property || '—')}<div class="name-sub">${e(r.city || '')}</div></td><td>${e(METHOD[r.payment_method] || '')}</td>
        <td>${e(r.due_date || '')}</td><td style="text-align:right;white-space:nowrap"><b>${e(money(r.amount_cents))}</b></td>
        <td>${(r.data || {}).cheque_no ? '#' + e(r.data.cheque_no) : '—'}</td><td>${pill(r.status)}</td><td>${(r.flags || []).map(flag).join(' ')}</td></tr>`).join('');
      n = lines.length;
    } else if (LL.view === 'cheques') {
      const names = [...new Set(cheques.map(c => c.landlord_name))].sort((a, b) => a.localeCompare(b));
      tools.innerHTML = `<input class="form-input" id="ap-ll-q" placeholder="Cheque # or landlord" value="${e(LL.q)}" style="max-width:180px">
        <select class="form-input" id="ap-ll-status" style="max-width:160px"><option value="">All statuses</option>${Object.entries(CHQ).map(([k, [l]]) => `<option value="${k}" ${LL.status === k ? 'selected' : ''}>${e(l)}</option>`).join('')}</select>
        <select class="form-input" id="ap-ll-landlord" style="max-width:200px"><option value="">All landlords</option>${names.map(x => `<option ${LL.landlord === x ? 'selected' : ''}>${e(x)}</option>`).join('')}</select>`;
      const q = LL.q.trim().toLowerCase().replace(/^#/, '');
      const list = cheques.filter(c => (!LL.status || c.status === LL.status) && (!LL.landlord || c.landlord_name === LL.landlord)
        && (!q || String(c.cheque_no).replace(/^0+/, '').includes(q.replace(/^0+/, '')) || String(c.landlord_name).toLowerCase().includes(q)));
      note.textContent = `${list.length} cheque(s) · ${money(list.reduce((s, c) => s + Number(c.amount_cents || 0), 0))}${LL.status === 'with_landlord' ? ' still with landlords' : ''}`;
      head.innerHTML = '<tr><th>Cheque</th><th>Landlord</th><th>Dated for</th><th style="text-align:right">Amount</th><th>Status</th><th>Photo</th></tr>';
      html = list.map(c => `<tr class="clickable" data-ll-cheque="${e(c.id)}" tabindex="0" style="cursor:pointer">
        <td><b>#${e(c.cheque_no)}</b><div class="name-sub">Book ${e(c.book)}</div></td><td>${e(c.landlord_name)}<div class="name-sub">${e((c.props || []).join(', '))}</div></td>
        <td>${e(c.dated_for)}</td><td style="text-align:right"><b>${e(money(c.amount_cents))}</b></td><td>${chip(CHQ[c.status] || [c.status, ''])}${c.cashed_on ? `<div class="name-sub">${e(c.cashed_on)}</div>` : ''}</td>
        <td onclick="event.stopPropagation()">${c.photo_url ? `<a href="${e(c.photo_url)}" target="_blank" rel="noopener">Photo</a>` : ''}</td></tr>`).join('');
      n = list.length;
    } else {
      tools.innerHTML = `<input class="form-input" id="ap-ll-q" placeholder="Landlord or property" value="${e(LL.q)}" style="max-width:200px">`;
      const q = LL.q.trim().toLowerCase();
      const byLandlord = new Map(summary.map(r => [r.term.landlord_id, (summary.filter(x => x.term.landlord_id === r.term.landlord_id))]));
      const setUp = summary.filter(r => !q || [r.term.landlord_name, ...(r.term.props || [])].some(v => String(v || '').toLowerCase().includes(q)));
      const notSet = llLandlords().filter(x => !x.l.archived && !byLandlord.has(String(x.l.id)) && (!q || [x.l.name, x.l.company, ...(x.l.props || [])].some(v => String(v || '').toLowerCase().includes(q))));
      note.textContent = `${summary.length} payment set-up(s)${warnN ? ` · ${warnN} running low on cheques` : ''} · ${notSet.length} active landlord(s) not set up yet`;
      head.innerHTML = '<tr><th>Landlord</th><th>Property</th><th>Method</th><th style="text-align:right">Rent</th><th>Cheques left</th><th>Last cheque</th><th></th></tr>';
      html = setUp.map(r => `<tr class="clickable" data-ll-landlord="${e(r.term.landlord_id)}" tabindex="0" style="cursor:pointer">
          <td><b>${e(r.term.landlord_name)}</b></td><td>${e((r.term.props || []).join(', ') || '—')}</td><td>${e(METHOD[r.term.method] || r.term.method)}<div class="name-sub">Day ${e(r.term.pay_day)}</div></td>
          <td style="text-align:right">${e(money(r.term.amount_cents))}</td><td>${r.term.method === 'cheque' ? (r.warn === 'unknown' ? '<span class="name-sub">?</span>' : `<b>${e(r.left)}</b>`) : '—'}</td><td>${e(r.lastDated || '—')}</td>
          <td>${r.warn && r.warn !== 'ok' ? chip(WARN[r.warn]) : ''}</td></tr>`).join('')
        + notSet.map(x => `<tr class="clickable" data-ll-landlord="${e(x.l.id)}" tabindex="0" style="cursor:pointer;opacity:.75">
          <td><b>${e(x.l.name)}</b>${x.l.company ? `<div class="name-sub">${e(x.l.company)}</div>` : ''}</td><td>${e((x.l.props || []).join(', ') || '—')}</td>
          <td colspan="4" class="name-sub">Not set up — click to choose cheque, PAD or e-transfer</td><td></td></tr>`).join('');
      n = setUp.length + notSet.length;
    }
    body.innerHTML = html;
    empty.style.display = n ? 'none' : '';
  }

  function openPanel(hero, title, sub, meta){
    document.getElementById('panel-hero').textContent = String(hero || '?').slice(0, 1).toUpperCase();
    document.getElementById('panel-title').innerHTML = e(title);
    document.getElementById('panel-sub').textContent = sub;
    document.getElementById('panel-meta').innerHTML = meta || '';
    document.getElementById('detail-panel').classList.add('open');
    document.getElementById('detail-panel').setAttribute('aria-hidden', 'false');
    document.getElementById('panel-backdrop').classList.add('open');
  }

  function openCheque(id){
    const c = (LL.cheques || []).find(x => x.id === id);
    if (!c) return;
    const act = canAct(me());
    const field = (l, v) => v ? `<div style="display:flex;gap:10px"><span class="name-sub" style="min-width:120px">${e(l)}</span><span>${v}</span></div>` : '';
    openPanel('#', `Cheque #${c.cheque_no}`, `${c.landlord_name} · ${money(c.amount_cents)} · ${c.dated_for}`, chip(CHQ[c.status] || [c.status, '']));
    const next = { with_landlord: ['cashed', 'bounced', 'void'], cashed: ['bounced', 'with_landlord'], bounced: ['with_landlord', 'void'], void: ['with_landlord'] }[c.status] || [];
    const label = { cashed: 'Mark cashed', bounced: 'Bounced', void: 'Void', with_landlord: 'Back with landlord' };
    document.getElementById('panel-body').innerHTML = `<div data-ll-cq="${e(c.id)}">
      <div style="display:grid;gap:6px">
        ${field('Landlord', e(c.landlord_name))}${field('Property', e((c.props || []).join(', ')))}${field('Book', e(c.book))}
        ${field('Dated for', e(c.dated_for))}${field('Amount', `<b>${e(money(c.amount_cents))}</b>`)}${field('Cashed', e(c.cashed_on || ''))}
        ${field('QuickBooks', e(c.qb_ref || ''))}${field('Photo', c.photo_url ? `<a href="${e(c.photo_url)}" target="_blank" rel="noopener">Open</a>` : '')}
        ${field('Source', e(c.source))}${field('Note', e(c.note || ''))}
      </div>
      ${act ? H('Status') + `<form data-ll-form="status" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${next.includes('cashed') ? `<input class="form-input" type="date" name="cashed_on" value="${e(today())}" style="max-width:170px" aria-label="Cashed on">` : ''}
        ${next.map(s => `<button class="btn ${s === 'cashed' ? 'btn-primary' : 'btn-ghost'}" type="submit" name="to" value="${s}">${label[s]}</button>`).join('')}</form>
        <div class="name-sub">Lu marks cheques cashed from QuickBooks on its own; use this for corrections.</div>` : ''}
      ${act ? H('Edit') + `<form data-ll-form="edit" style="display:grid;gap:8px;max-width:360px">
        <label class="name-sub">Amount <input class="form-input" name="amount" inputmode="decimal" value="${e((Number(c.amount_cents) / 100).toFixed(2))}"></label>
        <label class="name-sub">Dated for <input class="form-input" type="date" name="dated_for" value="${e(c.dated_for)}"></label>
        <label class="name-sub">Photo link <input class="form-input" name="photo_url" value="${e(c.photo_url || '')}" placeholder="https://drive.google.com/…"></label>
        <label class="name-sub">Note <input class="form-input" name="note" value="${e(c.note || '')}"></label>
        <div><button class="btn" type="submit">Save</button></div></form>` : ''}
      ${H('History')}<div style="display:grid;gap:4px">${(Array.isArray(c.history) ? c.history : []).map(h => `<div class="name-sub">${e(when(h.at))} · ${e(h.by || '')} · ${e(h.status ? (CHQ[h.status] || [h.status])[0] : 'edited')}</div>`).join('') || '<div class="name-sub">—</div>'}</div>
    </div>`;
  }

  function openLandlord(landlordId){
    const x = llLandlords().find(v => String(v.l.id) === String(landlordId));
    const terms = (LL.terms || []).filter(t => t.landlord_id === String(landlordId));
    const name = x ? x.l.name : (terms[0] || {}).landlord_name || landlordId;
    const leases = x ? x.leases : [];
    const act = canAct(me()), t0 = today();
    const mine = (LL.cheques || []).filter(c => c.landlord_id === String(landlordId)).sort((a, b) => String(b.dated_for).localeCompare(String(a.dated_for)));
    const left = mine.filter(c => c.status === 'with_landlord' && String(c.dated_for) > t0).length;
    openPanel(name, name, `${terms.length ? terms.map(t => METHOD[t.method]).join(' + ') : 'Not set up'}${left ? ` · ${left} cheque(s) left` : ''}`, '');
    // One form per lease (or one for the landlord as a whole when it has no lease on file).
    const slots = leases.length ? leases.map(c => ({ c, t: terms.find(t => t.contract_id && t.contract_id === String(c.id || '')) || null }))
      : [{ c: null, t: terms.find(t => !t.contract_id) || terms[0] || null }];
    // A set-up made for the landlord as a whole (e.g. from the cheque import) fills the first lease without one.
    for (const t of terms) {
      if (slots.some(s => s.t && s.t.id === t.id)) continue;
      const free = !t.contract_id && slots.find(s => !s.t);
      if (free) free.t = t; else slots.push({ c: null, t });
    }
    const leaseText = (c) => c ? `${(c.props && c.props.length ? c.props.join(', ') : (x && x.l.props || []).join(', ')) || 'All properties'} · ${c.start || '?'} → ${c.end || (c.monthToMonth ? 'month to month' : 'open')}` : 'Landlord (no lease on file)';
    const form = (s, i) => {
      const t = s.t, c = s.c;
      const rentCents = t && t.amount_cents != null ? Number(t.amount_cents) : c && c.rent != null ? parseAmount(c.rent) : null;
      const props = t ? t.props : c && c.props && c.props.length ? c.props : (x && x.l.props) || [];
      return `<form data-ll-form="term" data-i="${i}" style="display:grid;gap:8px;max-width:420px;padding:10px 0;border-bottom:1px solid var(--line,#e5e2dc)">
        <div><b>${e(leaseText(c))}</b>${t && !t.active ? ' <span class="tag-pill" style="font-size:11px">Off</span>' : ''}</div>
        <input type="hidden" name="contract_id" value="${e(t ? t.contract_id || '' : c ? c.id || '' : '')}"><input type="hidden" name="props" value="${e(JSON.stringify(props))}">
        <label class="name-sub">Paid by <select class="form-input" name="method" ${act ? '' : 'disabled'}>${['cheque', 'pad', 'etransfer'].map(m => `<option value="${m}" ${(t ? t.method : '') === m ? 'selected' : ''}>${e(METHOD[m])}</option>`).join('')}</select></label>
        <div style="display:flex;gap:8px"><label class="name-sub" style="flex:1">Monthly rent <input class="form-input" name="amount" inputmode="decimal" value="${rentCents != null ? e((rentCents / 100).toFixed(2)) : ''}" ${act ? '' : 'disabled'}></label>
        <label class="name-sub" style="width:110px">Day of month <input class="form-input" name="pay_day" type="number" min="1" max="28" value="${e(t ? t.pay_day : 1)}" ${act ? '' : 'disabled'}></label></div>
        <label class="name-sub">Shows in the bank as (for PAD / e-transfer matching) <input class="form-input" name="payee_alias" value="${e(t ? t.payee_alias || '' : '')}" placeholder="e.g. Q-14 HOLDINGS" ${act ? '' : 'disabled'}></label>
        <div style="display:flex;gap:8px"><label class="name-sub" style="flex:1">From <input class="form-input" type="date" name="starts_on" value="${e(t ? t.starts_on || '' : c ? c.start || '' : '')}" ${act ? '' : 'disabled'}></label>
        <label class="name-sub" style="flex:1">Until <input class="form-input" type="date" name="ends_on" value="${e(t ? t.ends_on || '' : c && !c.monthToMonth ? c.end || '' : '')}" ${act ? '' : 'disabled'}></label></div>
        <label class="name-sub"><input type="checkbox" name="active" ${!t || t.active ? 'checked' : ''} ${act ? '' : 'disabled'}> Active (create a rent line every month)</label>
        ${act ? `<div><button class="btn btn-primary" type="submit">${t ? 'Save' : 'Set up'}</button></div>` : ''}
      </form>`;
    };
    const chequeTerms = terms.filter(t => t.method === 'cheque');
    const lastNo = mine.map(c => c.cheque_no).sort((a, b) => Number(b) - Number(a))[0];
    const lastBook = (mine.slice().sort((a, b) => String(b.dated_for).localeCompare(String(a.dated_for)))[0] || {}).book || 'main';
    const nextMonth = (() => { const fut = mine.filter(c => c.status !== 'void').map(c => String(c.dated_for).slice(0, 7)).sort().pop(); return fut && fut >= t0.slice(0, 7) ? shiftMonth(fut, 1) : shiftMonth(t0.slice(0, 7), 1); })();
    document.getElementById('panel-body').innerHTML = `<div data-ll-host="${e(landlordId)}" data-ll-name="${e(name)}" data-ll-city="${e(x ? x.l.city || '' : (terms[0] || {}).city || '')}">
      ${H('How this landlord is paid')}${slots.map(form).join('')}
      ${chequeTerms.some(t => t.cheques_tracked === false) ? `<p class="name-sub" style="margin-top:12px">Set up from the bank records: we know this landlord is paid by cheque, not how many post-dated cheques they still hold. Add the current batch below and the count starts.</p>` : ''}
      ${chequeTerms.length && act ? H('Add a batch of post-dated cheques') + `<form data-ll-form="batch" style="display:grid;gap:8px;max-width:420px">
        ${chequeTerms.length > 1 ? `<label class="name-sub">Lease <select class="form-input" name="term_id">${chequeTerms.map(t => `<option value="${e(t.id)}">${e((t.props || []).join(', ') || t.landlord_name)}</option>`).join('')}</select></label>` : `<input type="hidden" name="term_id" value="${e(chequeTerms[0].id)}">`}
        <div style="display:flex;gap:8px"><label class="name-sub" style="flex:1">First cheque # <input class="form-input" name="first_no" inputmode="numeric" placeholder="${e(lastNo ? String(Number(lastNo) + 1) : '0901')}" required></label>
        <label class="name-sub" style="width:90px">How many <input class="form-input" name="count" type="number" min="1" max="24" value="6"></label></div>
        <div style="display:flex;gap:8px"><label class="name-sub" style="flex:1">First month <input class="form-input" type="month" name="first_month" value="${e(nextMonth)}"></label>
        <label class="name-sub" style="flex:1">Amount each <input class="form-input" name="amount" inputmode="decimal" value="${chequeTerms[0].amount_cents != null ? e((Number(chequeTerms[0].amount_cents) / 100).toFixed(2)) : ''}"></label></div>
        <div style="display:flex;gap:8px"><label class="name-sub" style="flex:1">Chequebook <input class="form-input" name="book" value="${e(lastBook)}"></label>
        <label class="name-sub" style="flex:2">Photo link (optional) <input class="form-input" name="photo_url" placeholder="https://drive.google.com/…"></label></div>
        <div class="name-sub" data-ll-preview></div>
        <div><button class="btn btn-primary" type="submit">Add cheques</button></div></form>` : ''}
      ${H(`Cheques (${mine.length})`)}<div style="display:grid;gap:4px">${mine.slice(0, 40).map(c => `<div style="display:flex;gap:10px;align-items:center;cursor:pointer" data-ll-cheque="${e(c.id)}">
        <span style="min-width:70px"><b>#${e(c.cheque_no)}</b></span><span class="name-sub" style="min-width:90px">${e(c.dated_for)}</span><span style="min-width:90px;text-align:right">${e(money(c.amount_cents))}</span>${chip(CHQ[c.status] || [c.status, ''])}</div>`).join('') || '<div class="name-sub">No cheques on file.</div>'}</div>
    </div>`;
    previewBatch();
  }

  function previewBatch(){
    const f = document.querySelector('#panel-body [data-ll-form="batch"]');
    if (!f) return;
    const fd = new FormData(f), t = (LL.terms || []).find(x => x.id === fd.get('term_id')) || {};
    const p = batchPreview({ firstNo: fd.get('first_no'), count: Number(fd.get('count')), firstMonth: fd.get('first_month'), payDay: t.pay_day, amountCents: parseAmount(fd.get('amount')) });
    const out = f.querySelector('[data-ll-preview]');
    if (out) out.textContent = p.error ? (String(fd.get('first_no') || '') ? p.error : '') : `#${p[0].cheque_no} (${p[0].dated_for}) → #${p[p.length - 1].cheque_no} (${p[p.length - 1].dated_for}) · ${p.length} × ${money(p[0].amount_cents)} = ${money(p.length * p[0].amount_cents)}`;
  }

  async function llRpc(fn, args, done){
    try { const r = await sb().rpc(fn, args); if (r.error) throw r.error; if (done) toast(done(r.data)); await load(true); await llLoad(true); return r.data; }
    catch (err) { toast('Could not save: ' + (err && err.message || err)); return null; }
  }

  async function llSubmit(f){
    const kind = f.dataset.llForm, fd = new FormData(f);
    const host = f.closest('[data-ll-host]'), cq = f.closest('[data-ll-cq]');
    if (kind === 'term' && host) {
      const amount = String(fd.get('amount') || '').trim() ? parseAmount(fd.get('amount')) : null;
      if (String(fd.get('amount') || '').trim() && amount == null) return toast('Type the rent like 3950.00');
      let props = []; try { props = JSON.parse(String(fd.get('props') || '[]')); } catch (_) {}
      const ok = await llRpc('ap_landlord_term_save', { p: { landlord_id: host.dataset.llHost, landlord_name: host.dataset.llName, city: host.dataset.llCity, contract_id: String(fd.get('contract_id') || ''),
        props, method: fd.get('method'), pay_day: Number(fd.get('pay_day')) || 1, amount_cents: amount, payee_alias: String(fd.get('payee_alias') || ''),
        starts_on: String(fd.get('starts_on') || ''), ends_on: String(fd.get('ends_on') || ''), active: !!fd.get('active') } }, () => 'Saved. Rent lines for this month and next are up to date.');
      if (ok) openLandlord(host.dataset.llHost);
    } else if (kind === 'batch' && host) {
      const t = (LL.terms || []).find(x => x.id === fd.get('term_id')) || {};
      const p = batchPreview({ firstNo: fd.get('first_no'), count: Number(fd.get('count')), firstMonth: fd.get('first_month'), payDay: t.pay_day, amountCents: parseAmount(fd.get('amount')) });
      if (p.error) return toast(p.error);
      const n = await llRpc('ap_cheques_add_batch', { p: { term_id: t.id, first_no: String(fd.get('first_no')).trim(), count: p.length, first_month: fd.get('first_month'), amount_cents: p[0].amount_cents,
        book: String(fd.get('book') || 'main'), photo_url: String(fd.get('photo_url') || '') } }, (k) => `${k} cheque(s) added.`);
      if (n) openLandlord(host.dataset.llHost);
    } else if (kind === 'status' && cq) {
      const to = (f._submitter && f._submitter.value) || '';
      if (!to) return;
      const r = await llRpc('ap_cheque_update', { p_id: cq.dataset.llCq, p_action: to, p_patch: to === 'cashed' ? { cashed_on: String(fd.get('cashed_on') || today()) } : {} }, () => 'Cheque updated.');
      if (r) openCheque(cq.dataset.llCq);
    } else if (kind === 'edit' && cq) {
      const amount = parseAmount(fd.get('amount'));
      if (amount == null) return toast('Type the amount like 3950.00');
      const r = await llRpc('ap_cheque_update', { p_id: cq.dataset.llCq, p_action: 'edit', p_patch: { amount_cents: amount, dated_for: String(fd.get('dated_for') || ''), photo_url: String(fd.get('photo_url') || ''), note: String(fd.get('note') || '') } }, () => 'Cheque saved.');
      if (r) openCheque(cq.dataset.llCq);
    }
  }

  function wireLL(){
    const ll = document.getElementById('ap-ll');
    if (!ll) return;
    ll.addEventListener('click', ev => {
      const v = ev.target.closest('[data-ll-view]'); if (v) { LL.view = v.dataset.llView; LL.q = ''; renderLL(); return; }
      const m = ev.target.closest('[data-ll-month]'); if (m) { LL.month = shiftMonth(LL.month, Number(m.dataset.llMonth)); renderLL(); return; }
      const g = ev.target.closest('[data-ll-do="generate"]');
      if (g) { llRpc('ap_landlord_rent_generate', { p_month: LL.month + '-01' }, (k) => `${k} rent line(s) up to date for ${monthName(LL.month)}.`); return; }
      const it = ev.target.closest('[data-ap-open]'); if (it) { open(it.dataset.apOpen); return; }
      const c = ev.target.closest('[data-ll-cheque]'); if (c) { openCheque(c.dataset.llCheque); return; }
      const l = ev.target.closest('[data-ll-landlord]'); if (l) openLandlord(l.dataset.llLandlord);
    });
    ll.addEventListener('keydown', ev => { if (ev.key !== 'Enter') return; const r = ev.target.closest('[data-ap-open],[data-ll-cheque],[data-ll-landlord]'); if (r) r.click(); });
    let t = null;
    ll.addEventListener('input', ev => { if (ev.target.id === 'ap-ll-q') { LL.q = ev.target.value; clearTimeout(t); t = setTimeout(() => { renderLL(); const q = document.getElementById('ap-ll-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }, 250); } });
    ll.addEventListener('change', ev => { if (ev.target.id === 'ap-ll-status') { LL.status = ev.target.value; renderLL(); } if (ev.target.id === 'ap-ll-landlord') { LL.landlord = ev.target.value; renderLL(); } });
    const pb = document.getElementById('panel-body');
    if (pb) {
      pb.addEventListener('click', ev => { const b = ev.target.closest('[data-ll-form] button[type="submit"]'); if (b) b.form._submitter = b; const c = ev.target.closest('[data-ll-cheque]'); if (c) openCheque(c.dataset.llCheque); });
      pb.addEventListener('input', ev => { if (ev.target.closest('[data-ll-form="batch"]')) previewBatch(); });
      pb.addEventListener('submit', ev => { const f = ev.target.closest('[data-ll-form]'); if (!f) return; ev.preventDefault(); llSubmit(f); });
    }
    try {
      if (sb() && sb().channel) sb().channel('ap_cheques_live').on('postgres_changes', { event: '*', schema: 'public', table: 'ap_cheques' }, () => { if (LL.cheques) { clearTimeout(wireLL._t); wireLL._t = setTimeout(() => llLoad(true), 800); } }).subscribe();
    } catch (_) {}
  }

  // ───────────── AP → Internet / Utilities accounts · School properties ─────────────
  const ACC = { accounts: null, schools: null, loading: null, q: '', status: 'active' };
  const ACC_SHEET = 'https://docs.google.com/spreadsheets/d/1ItaP3NbmBBT0JkCb_x5xuAXsFB6U4Ucp4B464Zv54q0/edit';
  const schoolNames = () => Object.fromEntries((ACC.schools || []).map(x => [x.id, x.name]));

  async function accLoad(force){
    if (ACC.loading) return ACC.loading;
    if (ACC.accounts && ACC.schools && !force) { renderAcc(); return; }
    ACC.loading = (async () => {
      try {
        const [a, s] = await Promise.all([
          sb().from('ap_service_accounts').select('*').order('provider').limit(5000),
          sb().from('ap_school_properties').select('*').order('name'),
        ]);
        if (a.error) throw a.error; if (s.error) throw s.error;
        ACC.accounts = a.data || []; ACC.schools = s.data || [];
        render();
      } catch (err) {
        console.error('[ap] accounts load failed', err);
        const msg = String(err && err.message || err);
        const note = document.getElementById('ap-acc-note');
        if (note) note.textContent = /ap_service_accounts|ap_school_properties/.test(msg) && /exist|schema cache/i.test(msg) ? 'Accounts are not set up in the database yet (run ap-accounts-2026-10-21.sql).' : 'Could not load accounts: ' + msg;
      } finally { ACC.loading = null; }
    })();
    return ACC.loading;
  }

  function renderAcc(){
    const title = document.getElementById('ap-acc-title'), tools = document.getElementById('ap-acc-tools'), note = document.getElementById('ap-acc-note'),
      head = document.getElementById('ap-acc-head'), body = document.getElementById('ap-acc-body'), empty = document.getElementById('ap-acc-empty');
    if (!body || !ACC.accounts) return;
    const act = canAct(me()), names = schoolNames(), sheet = `<a href="${e(ACC_SHEET)}" target="_blank" rel="noopener">Utilities TORONTO sheet</a>`;
    const search = (ph) => `<input class="form-input" id="ap-acc-q" placeholder="${e(ph)}" value="${e(ACC.q)}" style="max-width:220px">`;
    let n = 0;
    if (S.tab === 'school') {
      title.innerHTML = '<b>School properties</b>';
      tools.innerHTML = search('Name, address or unit') + (act ? `<button class="btn btn-primary" type="button" data-acc-do="add-school">Add school property</button>` : '');
      const q = ACC.q.trim().toLowerCase();
      const list = schoolSummary(ACC.schools, ACC.accounts).filter(r => !q || [r.s.name, r.s.address, r.s.city, ...r.units].some(v => String(v || '').toLowerCase().includes(q)));
      note.innerHTML = `Buildings we pay internet or utilities for that are not portal properties. Their accounts show here and in the Internet / Utilities tabs. Logins and passwords: ${sheet}.`;
      head.innerHTML = '<tr><th>School property</th><th>Address</th><th>Units</th><th>Internet</th><th>Utilities</th><th style="text-align:right">Monthly (active)</th></tr>';
      body.innerHTML = list.map(r => `<tr class="clickable" data-acc-school="${e(r.s.id)}" tabindex="0" style="cursor:pointer${r.s.active === false ? ';opacity:.6' : ''}">
          <td><b>${e(r.s.name)}</b>${r.s.active === false ? ' <span class="tag-pill" style="font-size:11px">Inactive</span>' : ''}<div class="name-sub">${e(r.s.city || '')}</div></td>
          <td>${e(r.s.address || '—')}</td><td>${e(r.units.join(', ') || '—')}</td><td>${e(r.internet)}</td><td>${e(r.utility)}</td>
          <td style="text-align:right">${r.monthlyCents ? `<b>${e(money(r.monthlyCents))}</b>` : '—'}</td></tr>`).join('');
      n = list.length;
    } else {
      const type = S.tab;
      title.innerHTML = `<b>${type === 'internet' ? 'Internet' : 'Utility'} accounts</b>`;
      tools.innerHTML = search('Unit, building, account #, provider')
        + `<select class="form-input" id="ap-acc-status" style="max-width:140px" aria-label="Account status"><option value="active" ${ACC.status === 'active' ? 'selected' : ''}>Active</option><option value="canceled" ${ACC.status === 'canceled' ? 'selected' : ''}>Canceled</option><option value="" ${!ACC.status ? 'selected' : ''}>All</option></select>`
        + (act ? `<button class="btn btn-primary" type="button" data-acc-do="add" data-type="${type}">Add account</button>` : '');
      const list = accountsFor(ACC.accounts, { type, status: ACC.status, q: ACC.q }, names);
      const monthly = list.filter(a => a.status === 'active').reduce((t, a) => t + Number(a.monthly_cents || 0), 0);
      note.innerHTML = `${list.length} account(s)${monthly ? ` · ${e(money(monthly))} a month (active, where the sheet has an amount)` : ''} · Logins and passwords: ${sheet}.`;
      head.innerHTML = '<tr><th>Provider</th><th>Where</th><th>Unit</th><th>Account #</th><th style="text-align:right">Monthly</th><th>Paid by</th><th>Status</th></tr>';
      body.innerHTML = list.map(a => {
        const school = a.school_property_id && names[a.school_property_id];
        return `<tr class="clickable" data-acc-open="${e(a.id)}" tabindex="0" style="cursor:pointer">
          <td><b>${e(a.provider)}</b><div class="name-sub">${e(a.service || '')}</div></td>
          <td>${e(accountPlace(a, names) || '—')}${school && !a.property ? ' <span class="tag-pill" style="font-size:10px">School</span>' : ''}<div class="name-sub">${e(a.address || '')}</div></td>
          <td>${e(a.unit || '—')}</td><td>${e(a.account_no || '—')}</td>
          <td style="text-align:right">${a.monthly_cents != null ? e(money(a.monthly_cents)) : '—'}</td><td>${e(a.payment_method || '—')}</td>
          <td>${chip(ACC_STATUS[a.status] || [a.status, ''])}</td></tr>`;
      }).join('');
      n = list.length;
    }
    empty.style.display = n ? 'none' : '';
  }

  function schoolOptions(current){
    return `<option value="">— none —</option>` + (ACC.schools || []).map(x => `<option value="${e(x.id)}" ${x.id === current ? 'selected' : ''}>${e(x.name)}</option>`).join('');
  }

  // One account: edit form (or a new one with defaults), opened from a row or a school property.
  function openAccount(id, defaults){
    const a = id ? (ACC.accounts || []).find(x => x.id === id) : Object.assign({ type: 'internet', status: 'active', city: 'Toronto' }, defaults || {});
    if (!a) return;
    const act = canAct(me()), dis = act ? '' : 'disabled', names = schoolNames();
    const inp = (name, label, v, extra) => `<label class="name-sub">${e(label)} <input class="form-input" name="${name}" value="${e(v == null ? '' : v)}" ${dis} ${extra || ''}></label>`;
    openPanel(a.provider || '+', id ? `${a.provider}${a.unit ? ' · ' + a.unit : ''}` : 'New account', id ? `${a.service || TYPES[a.type]} · ${accountPlace(a, names) || 'no property'}` : 'Internet or utility account',
      id ? chip(ACC_STATUS[a.status] || [a.status, '']) : '');
    document.getElementById('panel-body').innerHTML = `<form data-acc-form="account" data-acc-id="${e(id || '')}" style="display:grid;gap:8px;max-width:440px">
      <div style="display:flex;gap:8px"><label class="name-sub" style="flex:1">Type <select class="form-input" name="type" ${dis}>${['internet', 'utility'].map(t => `<option value="${t}" ${a.type === t ? 'selected' : ''}>${e(TYPES[t])}</option>`).join('')}</select></label>
        <label class="name-sub" style="flex:1">Status <select class="form-input" name="status" ${dis}>${Object.entries(ACC_STATUS).map(([k, [l]]) => `<option value="${k}" ${a.status === k ? 'selected' : ''}>${e(l)}</option>`).join('')}</select></label></div>
      <div style="display:flex;gap:8px"><div style="flex:1">${inp('provider', 'Provider', a.provider, 'required placeholder="Rogers"')}</div><div style="flex:1">${inp('service', 'Service', a.service, 'placeholder="Internet, Electricity…"')}</div></div>
      <div style="display:flex;gap:8px"><div style="flex:2">${inp('account_no', 'Account #', a.account_no)}</div><div style="flex:1">${inp('unit', 'Unit', a.unit)}</div></div>
      <label class="name-sub">Portal property <select class="form-input" name="property" ${dis}>${propertyOptions(a.property)}</select></label>
      <label class="name-sub">School property (not in the portal) <select class="form-input" name="school_property_id" ${dis}>${schoolOptions(a.school_property_id)}</select></label>
      <div style="display:flex;gap:8px"><div style="flex:1">${inp('building', 'Building', a.building)}</div><div style="flex:1">${inp('city', 'City', a.city)}</div></div>
      ${inp('address', 'Service address', a.address)}
      <div style="display:flex;gap:8px"><div style="flex:1">${inp('monthly', 'Monthly charge', a.monthly_cents != null ? (Number(a.monthly_cents) / 100).toFixed(2) : '', 'inputmode="decimal"')}</div><div style="flex:1">${inp('payment_method', 'Paid by', a.payment_method, 'placeholder="PAD - 0670"')}</div></div>
      ${inp('login', 'Login (email / user name)', a.login)}
      <div class="name-sub">Passwords stay in the <a href="${e(ACC_SHEET)}" target="_blank" rel="noopener">Utilities TORONTO sheet</a>, not in the portal.</div>
      <label class="name-sub">Notes <textarea class="form-input" name="notes" rows="3" ${dis}>${e(a.notes || '')}</textarea></label>
      ${act ? `<div><button class="btn btn-primary" type="submit">${id ? 'Save' : 'Add account'}</button></div>` : ''}
      ${id ? `<div class="name-sub">${a.updated_by ? `Last change ${e(when(a.updated_at))} · ${e(a.updated_by)}` : ''}</div>` : ''}
    </form>`;
  }

  function openSchool(id){
    const s = id ? (ACC.schools || []).find(x => x.id === id) : { city: 'Toronto', active: true };
    if (!s) return;
    const act = canAct(me()), dis = act ? '' : 'disabled';
    const mine = id ? accountsFor(ACC.accounts || [], { school: id }, schoolNames()) : [];
    const active = mine.filter(a => a.status === 'active');
    openPanel(s.name || '+', id ? s.name : 'New school property', id ? `${active.length} active account(s) · ${money(active.reduce((t, a) => t + Number(a.monthly_cents || 0), 0))} a month` : 'A building we pay for that is not in the portal', '');
    document.getElementById('panel-body').innerHTML = `<form data-acc-form="school" data-acc-id="${e(id || '')}" style="display:grid;gap:8px;max-width:440px">
      <label class="name-sub">Name <input class="form-input" name="name" value="${e(s.name || '')}" required placeholder="Markham · 38 Simcoe Promenade" ${dis}></label>
      <label class="name-sub">Address <input class="form-input" name="address" value="${e(s.address || '')}" ${dis}></label>
      <label class="name-sub">City <input class="form-input" name="city" value="${e(s.city || '')}" ${dis}></label>
      <label class="name-sub">Notes <textarea class="form-input" name="notes" rows="2" ${dis}>${e(s.notes || '')}</textarea></label>
      <label class="name-sub"><input type="checkbox" name="active" ${s.active !== false ? 'checked' : ''} ${dis}> Active</label>
      ${act ? `<div><button class="btn btn-primary" type="submit">${id ? 'Save' : 'Add school property'}</button></div>` : ''}
    </form>
    ${id ? H(`Accounts (${mine.length})`) + `<div style="display:grid;gap:4px">${mine.map(a => `<div style="display:flex;gap:10px;align-items:center;cursor:pointer" data-acc-open="${e(a.id)}">
        <span style="min-width:70px"><b>${e(a.unit || '—')}</b></span><span style="min-width:110px">${e(a.provider)} <span class="name-sub">${e(a.service || '')}</span></span>
        <span class="name-sub" style="min-width:90px">${e(a.account_no || '')}</span><span style="min-width:70px;text-align:right">${a.monthly_cents != null ? e(money(a.monthly_cents)) : ''}</span>${chip(ACC_STATUS[a.status] || [a.status, ''])}</div>`).join('') || '<div class="name-sub">No accounts yet.</div>'}</div>
      ${act ? `<div style="display:flex;gap:8px;margin-top:10px"><button class="btn" type="button" data-acc-do="add-here" data-type="internet" data-school="${e(id)}">Add internet account</button><button class="btn btn-ghost" type="button" data-acc-do="add-here" data-type="utility" data-school="${e(id)}">Add utility account</button></div>` : ''}` : ''}`;
  }

  async function accSubmit(f){
    const fd = new FormData(f), id = f.dataset.accId || '', str = (k) => String(fd.get(k) || '').trim();
    try {
      if (f.dataset.accForm === 'school') {
        const r = await sb().rpc('ap_school_property_save', { p: { id, name: str('name'), address: str('address'), city: str('city'), notes: str('notes'), active: !!fd.get('active') } });
        if (r.error) throw r.error;
        toast(id ? 'School property saved.' : 'School property added.');
        await accLoad(true); openSchool(r.data.id);
      } else {
        const monthly = str('monthly') ? parseAmount(str('monthly')) : null;
        if (str('monthly') && monthly == null) return toast('Type the monthly charge like 137.86');
        const r = await sb().rpc('ap_account_save', { p: { id, type: str('type'), status: str('status'), provider: str('provider'), service: str('service'), account_no: str('account_no'), unit: str('unit'),
          property: str('property'), school_property_id: str('school_property_id'), building: str('building'), city: str('city'), address: str('address'),
          monthly_cents: monthly, payment_method: str('payment_method'), login: str('login'), notes: String(fd.get('notes') || '') } });
        if (r.error) throw r.error;
        toast(id ? 'Account saved.' : 'Account added.');
        await accLoad(true); openAccount(r.data.id);
      }
    } catch (err) { toast('Could not save: ' + (err && err.message || err)); }
  }

  function wireAcc(){
    const card = document.getElementById('ap-acc');
    if (!card) return;
    const add = (b) => b.dataset.accDo === 'add-school' ? openSchool(null) : openAccount(null, { type: b.dataset.type || 'internet', school_property_id: b.dataset.school || null });
    card.addEventListener('click', ev => {
      const b = ev.target.closest('[data-acc-do]'); if (b) { add(b); return; }
      const a = ev.target.closest('[data-acc-open]'); if (a) { openAccount(a.dataset.accOpen); return; }
      const s = ev.target.closest('[data-acc-school]'); if (s) openSchool(s.dataset.accSchool);
    });
    card.addEventListener('keydown', ev => { if (ev.key !== 'Enter') return; const r = ev.target.closest('[data-acc-open],[data-acc-school]'); if (r) r.click(); });
    let t = null;
    card.addEventListener('input', ev => { if (ev.target.id === 'ap-acc-q') { ACC.q = ev.target.value; clearTimeout(t); t = setTimeout(() => { renderAcc(); const q = document.getElementById('ap-acc-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }, 250); } });
    card.addEventListener('change', ev => { if (ev.target.id === 'ap-acc-status') { ACC.status = ev.target.value; renderAcc(); } });
    const pb = document.getElementById('panel-body');
    if (pb) {
      pb.addEventListener('click', ev => {
        const b = ev.target.closest('[data-acc-do]'); if (b) { add(b); return; }
        const a = ev.target.closest('[data-acc-open]'); if (a && !ev.target.closest('form')) openAccount(a.dataset.accOpen);
      });
      pb.addEventListener('submit', ev => { const f = ev.target.closest('[data-acc-form]'); if (!f) return; ev.preventDefault(); accSubmit(f); });
    }
    try {
      if (sb() && sb().channel) sb().channel('ap_accounts_live').on('postgres_changes', { event: '*', schema: 'public', table: 'ap_service_accounts' }, () => { if (ACC.accounts) { clearTimeout(wireAcc._t); wireAcc._t = setTimeout(() => accLoad(true), 800); } }).subscribe();
    } catch (_) {}
  }

  // ───────────── AP → Refunds: add / change one ─────────────
  function openRefund(id){
    const r = id ? (rows || []).find(x => x.id === id) : { payment_method: 'etransfer', data: { refundKind: 'relocation' } };
    if (!r) return;
    const d = r.data || {};
    const inp = (name, label, val, extra) => `<label class="name-sub">${e(label)} <input class="form-input" name="${name}" value="${e(val == null ? '' : val)}" ${extra || ''}></label>`;
    openPanel(r.payee || '+', id ? `Change refund · ${r.payee}` : 'New refund', id ? `${REFUND_KIND[d.refundKind] || 'Refund'} · ${money(r.amount_cents)}` : 'Money Vanmates owes back for a service (not checkout deposits: those are in Checkouts)', id ? pill(r.status) : '');
    document.getElementById('panel-body').innerHTML = `<form data-rf-form data-rf-id="${e(id || '')}" style="display:grid;gap:8px;max-width:440px">
      <label class="name-sub">Refund for <select class="form-input" name="kind">${Object.entries(REFUND_KIND).map(([k, l]) => `<option value="${k}" ${d.refundKind === k ? 'selected' : ''}>${e(l)}</option>`).join('')}</select></label>
      ${inp('payee', 'Who gets it', r.payee, 'required placeholder="Full name (or company)"')}
      <div style="display:flex;gap:8px"><div style="flex:1">${inp('amount', 'Amount ($)', r.amount_cents ? (Number(r.amount_cents) / 100).toFixed(2) : '', 'required inputmode="decimal" placeholder="1200.00"')}</div>
        <div style="flex:1"><label class="name-sub">Pay by <select class="form-input" name="payment_method">${['etransfer', 'cheque', 'card', 'other'].map(k => `<option value="${k}" ${r.payment_method === k ? 'selected' : ''}>${e(METHOD[k])}</option>`).join('')}</select></label></div></div>
      ${inp('payee_email', 'E-transfer email', r.payee_email, 'type="email" placeholder="name@example.com"')}
      ${inp('reason', 'Reason', d.reason, 'placeholder="Relocation cancelled, never found a host, overpaid rent…"')}
      <div style="display:flex;gap:8px"><div style="flex:1">${inp('due_date', 'Pay by date', String(r.due_date || '').slice(0, 10), 'type="date"')}</div><div style="flex:1">${inp('city', 'City', r.city)}</div></div>
      <label class="name-sub">Property (if any) <select class="form-input" name="property">${propertyOptions(r.property)}</select></label>
      <label class="name-sub">Notes <textarea class="form-input" name="notes" rows="2">${e(r.notes || '')}</textarea></label>
      <div style="display:flex;gap:8px">${id ? `<button class="btn btn-ghost" type="button" data-rf-back="${e(id)}">Cancel</button>` : ''}<button class="btn btn-primary" type="submit">${id ? 'Save' : 'Add refund'}</button></div>
      <div class="name-sub">It goes to review, then Approve → Mark paid, like any AP item.</div>
    </form>`;
  }

  async function refundSubmit(f){
    const fd = new FormData(f), id = f.dataset.rfId || '', str = (k) => String(fd.get(k) || '').trim();
    const cents = parseAmount(str('amount'));
    if (cents == null || cents <= 0) return toast('Type the amount like 1200.00');
    try {
      const r = await sb().rpc('ap_refund_save', { p: { id, kind: str('kind'), payee: str('payee'), amount_cents: cents, payment_method: str('payment_method'), payee_email: str('payee_email'),
        reason: str('reason'), due_date: str('due_date'), city: str('city'), property: str('property'), notes: String(fd.get('notes') || '') } });
      if (r.error) throw r.error;
      toast(id ? 'Refund saved.' : 'Refund added for review.');
      await load(true);
      open(r.data.id);
    } catch (err) { toast('Could not save: ' + (err && err.message || err)); }
  }

  function wireRefunds(){
    const btn = document.getElementById('ap-add-refund');
    if (btn) btn.addEventListener('click', () => openRefund(null));
    const pb = document.getElementById('panel-body');
    if (!pb) return;
    pb.addEventListener('submit', ev => { const f = ev.target.closest('[data-rf-form]'); if (!f) return; ev.preventDefault(); ev.stopImmediatePropagation(); refundSubmit(f); }, true);
    pb.addEventListener('click', ev => { const b = ev.target.closest('[data-rf-back]'); if (b) open(b.dataset.rfBack); });
  }

  // ───────────── AP → Vendors / B2B list ─────────────
  const VEN = { list: null, loading: null, q: '' };
  const VEN_KIND = { vendor: ['Vendor', 'Vendors', 'Suppliers we pay: accounting, laundry, bedding, appliances…'], b2b: ['B2B partner', 'B2B partners', 'Agencies and partners we pay a commission to'] };

  async function venLoad(force){
    if (VEN.loading) return VEN.loading;
    if (VEN.list && !force) { renderVen(); return; }
    VEN.loading = (async () => {
      try {
        const r = await sb().from('ap_vendors').select('*').order('name');
        if (r.error) throw r.error;
        VEN.list = r.data || [];
        renderVen();
      } catch (err) {
        console.error('[ap] vendors load failed', err);
        const msg = String(err && err.message || err);
        const note = document.getElementById('ap-ven-note');
        if (note) note.textContent = /ap_vendors/.test(msg) && /exist|schema cache/i.test(msg) ? 'Vendors are not set up in the database yet (run ap-vendors-2026-10-30.sql).' : 'Could not load vendors: ' + msg;
      } finally { VEN.loading = null; }
    })();
    return VEN.loading;
  }

  function renderVen(){
    const kind = S.tab;
    if (!['vendor', 'b2b'].includes(kind) || !VEN.list) return;
    const title = document.getElementById('ap-ven-title'), tools = document.getElementById('ap-ven-tools'), note = document.getElementById('ap-ven-note'),
      head = document.getElementById('ap-ven-head'), body = document.getElementById('ap-ven-body'), empty = document.getElementById('ap-ven-empty');
    if (!body) return;
    const act = canAct(me()), [one, many, what] = VEN_KIND[kind];
    const list = vendorSummary(VEN.list, rows || [], kind, today(), VEN.q);
    title.innerHTML = `<b>${e(many)}</b> <span class="name-sub">${e(VEN.list.filter(v => v.kind === kind && v.active !== false).length)}</span>`;
    tools.innerHTML = `<input class="form-input" id="ap-ven-q" placeholder="Name, alias, category" value="${e(VEN.q)}" style="max-width:220px">`
      + (act ? `<button class="btn btn-primary" type="button" data-ven-do="add">Add ${e(one.toLowerCase())}</button>` : '');
    note.textContent = `${what}. A bill sent to rent@ or a receipt sent to Lu lands in this tab when it names one of these (name or alias). Receipts an employee paid themselves stay in Employee expenses too, so payroll pays them back.`;
    head.innerHTML = '<tr><th>Name</th><th>Category</th><th>Also called</th><th>Items</th><th style="text-align:right">Open</th><th style="text-align:right">Paid · 12 months</th><th>Last</th></tr>';
    body.innerHTML = list.map(x => `<tr class="clickable" data-ven-open="${e(x.v.id)}" tabindex="0" style="cursor:pointer${x.v.active === false ? ';opacity:.6' : ''}">
        <td><b>${e(x.v.name)}</b>${x.v.active === false ? ' <span class="tag-pill" style="font-size:11px">Inactive</span>' : ''}<div class="name-sub">${e(x.v.email || x.v.city || '')}</div></td>
        <td>${e(x.v.category || '—')}</td><td class="name-sub">${e((x.v.aliases || []).join(', ') || '—')}</td><td>${e(x.items)}</td>
        <td style="text-align:right">${x.open ? `<b>${e(money(x.openCents))}</b><div class="name-sub">${e(x.open)} open</div>` : '—'}</td>
        <td style="text-align:right">${x.paidCents ? e(money(x.paidCents)) : '—'}</td><td>${e(x.last || '—')}</td></tr>`).join('');
    empty.style.display = list.length ? 'none' : '';
  }

  function openVendor(id, kind){
    const v = id ? (VEN.list || []).find(x => x.id === id) : { kind: kind || 'vendor', active: true, aliases: [] };
    if (!v) return;
    const act = canAct(me()), dis = act ? '' : 'disabled';
    const inp = (name, label, val, extra) => `<label class="name-sub">${e(label)} <input class="form-input" name="${name}" value="${e(val == null ? '' : val)}" ${dis} ${extra || ''}></label>`;
    const mine = id ? sortRows((rows || []).filter(r => (r.data || {}).vendorId === id)).reverse() : [];
    openPanel(v.name || '+', id ? v.name : `New ${VEN_KIND[v.kind][0].toLowerCase()}`, id ? `${VEN_KIND[v.kind][0]}${v.category ? ' · ' + v.category : ''} · ${mine.length} item(s)` : 'Bills and receipts that name it go to its tab',
      id && v.active === false ? chip(['Inactive', '']) : '');
    document.getElementById('panel-body').innerHTML = `<form data-ven-form="vendor" data-ven-id="${e(id || '')}" style="display:grid;gap:8px;max-width:440px">
      <label class="name-sub">List <select class="form-input" name="kind" ${dis}>${Object.entries(VEN_KIND).map(([k, [l]]) => `<option value="${k}" ${v.kind === k ? 'selected' : ''}>${e(l)}</option>`).join('')}</select></label>
      ${inp('name', 'Name', v.name, 'required placeholder="Obox Solution"')}
      ${inp('aliases', 'Also called (comma separated)', (v.aliases || []).join(', '), 'placeholder="Obox, Obox Solutions Inc"')}
      <div class="name-sub">A bill or receipt goes to this tab when its payee or vendor contains the name or one of these words.</div>
      <div style="display:flex;gap:8px"><div style="flex:1">${inp('category', 'Category', v.category, 'placeholder="Accounting, Laundry, Agency commission…"')}</div><div style="flex:1">${inp('city', 'City', v.city)}</div></div>
      <div style="display:flex;gap:8px"><div style="flex:1">${inp('email', 'Email / e-transfer', v.email)}</div><div style="flex:1">${inp('payment_method', 'Usually paid by', v.payment_method, 'placeholder="E-transfer, cheque, card…"')}</div></div>
      <label class="name-sub">Notes <textarea class="form-input" name="notes" rows="3" ${dis}>${e(v.notes || '')}</textarea></label>
      <label class="name-sub"><input type="checkbox" name="active" ${v.active !== false ? 'checked' : ''} ${dis}> Active</label>
      ${act ? `<div><button class="btn btn-primary" type="submit">${id ? 'Save' : 'Add'}</button></div>` : ''}
      ${id && v.updated_by ? `<div class="name-sub">Last change ${e(when(v.updated_at))} · ${e(v.updated_by)}</div>` : ''}
    </form>
    ${id ? H(`Bills and receipts (${mine.length})`) + `<div style="display:grid;gap:4px">${mine.map(r => `<div style="display:flex;gap:10px;align-items:center;cursor:pointer" data-ven-item="${e(r.id)}">
        <span class="name-sub" style="min-width:84px">${e(String(r.bill_date || r.created_at || '').slice(0, 10))}</span><span style="flex:1;min-width:0">${e(r.payee)}${r.type === 'employee_expense' ? ' <span class="name-sub">(employee)</span>' : ''}</span>
        <span style="min-width:80px;text-align:right">${e(money(r.amount_cents))}</span>${pill(r.status)}</div>`).join('') || '<div class="name-sub">Nothing yet.</div>'}</div>` : ''}`;
  }

  async function venSubmit(f){
    const fd = new FormData(f), id = f.dataset.venId || '', str = (k) => String(fd.get(k) || '').trim();
    try {
      const r = await sb().rpc('ap_vendor_save', { p: { id, kind: str('kind'), name: str('name'), aliases: parseAliases(fd.get('aliases')), category: str('category'),
        email: str('email'), payment_method: str('payment_method'), city: str('city'), notes: String(fd.get('notes') || ''), active: !!fd.get('active') } });
      if (r.error) throw r.error;
      toast(id ? 'Saved. Matching bills and receipts moved to its tab.' : 'Added. Matching bills and receipts moved to its tab.');
      await Promise.all([venLoad(true), load(true)]);
      openVendor(r.data.id);
    } catch (err) { toast('Could not save: ' + (/ap_vendors_name_uq|duplicate/i.test(String(err && err.message)) ? 'that name is already on the list.' : (err && err.message || err))); }
  }

  function wireVen(){
    const card = document.getElementById('ap-ven');
    if (!card) return;
    card.addEventListener('click', ev => {
      if (ev.target.closest('[data-ven-do="add"]')) { openVendor(null, S.tab); return; }
      const r = ev.target.closest('[data-ven-open]'); if (r) openVendor(r.dataset.venOpen);
    });
    card.addEventListener('keydown', ev => { if (ev.key !== 'Enter') return; const r = ev.target.closest('[data-ven-open]'); if (r) r.click(); });
    let t = null;
    card.addEventListener('input', ev => { if (ev.target.id === 'ap-ven-q') { VEN.q = ev.target.value; clearTimeout(t); t = setTimeout(() => { renderVen(); const q = document.getElementById('ap-ven-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }, 250); } });
    const pb = document.getElementById('panel-body');
    if (pb) {
      pb.addEventListener('click', ev => { const it = ev.target.closest('[data-ven-item]'); if (it) open(it.dataset.venItem); });
      pb.addEventListener('submit', ev => { const f = ev.target.closest('[data-ven-form]'); if (!f) return; ev.preventDefault(); venSubmit(f); });
    }
    try {
      if (sb() && sb().channel) sb().channel('ap_vendors_live').on('postgres_changes', { event: '*', schema: 'public', table: 'ap_vendors' }, () => { if (VEN.list) { clearTimeout(wireVen._t); wireVen._t = setTimeout(() => venLoad(true), 800); } }).subscribe();
    } catch (_) {}
  }

  function fromHash(){
    const m = (location.hash || '').match(/^#ap(?:=(ap-[0-9a-f]+))?$/);
    if (!m) return false;
    if (typeof goToView === 'function') goToView('ap');
    if (m[1]) load().then(() => open(m[1]));
    return true;
  }
  window.loadAp = load;
  window.openApItem = open;
  window.apFromHash = fromHash;
  window.addEventListener('hashchange', fromHash);

  function wire(){
    const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    const v = document.getElementById('ap-view');
    if (v) v.innerHTML = VIEWS.map(([k, l]) => `<option value="${k}">${e(l)}</option>`).join('');
    let t = null;
    on('ap-search', 'input', ev => { S.q = ev.target.value; clearTimeout(t); t = setTimeout(render, 150); });
    on('ap-view', 'change', ev => { S.view = ev.target.value; render(); });
    on('ap-filter-city', 'change', ev => { S.city = ev.target.value; render(); });
    on('ap-refresh', 'click', () => load(true));
    on('ap-tabs', 'click', ev => { const b = ev.target.closest('[data-ap-tab]'); if (b) { S.tab = b.dataset.apTab; render(); } });
    on('ap-cards', 'click', ev => { const b = ev.target.closest('[data-ap-view]'); if (b) { S.view = b.dataset.apView; render(); } });
    on('ap-bulk', 'click', ev => { const b = ev.target.closest('[data-ap-bulk]'); if (b) bulk(b.dataset.apBulk); });
    on('ap-select-all', 'change', ev => { const list = sortRows(filtered()); list.forEach(r => ev.target.checked ? S.sel.add(r.id) : S.sel.delete(r.id)); render(); });
    const body = document.getElementById('ap-body');
    if (body) {
      body.addEventListener('change', ev => { const c = ev.target.closest('[data-ap-sel]'); if (!c) return; c.checked ? S.sel.add(c.dataset.apSel) : S.sel.delete(c.dataset.apSel); bulkBar(sortRows(filtered())); });
      body.addEventListener('click', ev => { if (ev.target.closest('[data-ap-sel]')) return; const tr = ev.target.closest('[data-ap-open]'); if (tr) open(tr.dataset.apOpen); });
      body.addEventListener('keydown', ev => { if (ev.key !== 'Enter') return; const tr = ev.target.closest('[data-ap-open]'); if (tr) open(tr.dataset.apOpen); });
    }
    const pb = document.getElementById('panel-body');
    if (pb) pb.addEventListener('click', ev => {
      const b = ev.target.closest('[data-ap-do]'); if (!b) return;
      const host = ev.target.closest('[data-ap-id]'); if (!host) return;
      const toggle = (sel, show) => { const f = host.querySelector(sel); if (f) { f.style.display = show ? 'grid' : 'none'; if (show) { const i = f.querySelector('input:not([disabled]),select'); if (i) i.focus(); } } };
      if (b.dataset.apDo === 'refund-edit') { openRefund(host.dataset.apId); return; }
      if (b.dataset.apDo === 'edit-open') { toggle('[data-ap-form="delete"]', false); toggle('[data-ap-form="edit"]', true); return; }
      if (b.dataset.apDo === 'edit-cancel') { toggle('[data-ap-form="edit"]', false); return; }
      if (b.dataset.apDo === 'delete-open') { toggle('[data-ap-form="edit"]', false); toggle('[data-ap-form="delete"]', true); return; }
      if (b.dataset.apDo === 'delete-cancel') { toggle('[data-ap-form="delete"]', false); return; }
      act(host.dataset.apId, b.dataset.apDo, {});
    });
    // "+ Add new property…": open the portal's Add property form; the new one is then picked here (Save still sets it).
    if (pb) pb.addEventListener('focusin', ev => { const sel = ev.target.closest('[data-ap-prop]'); if (sel && sel.value !== NEW_PROP) sel.dataset.prev = sel.value; });
    if (pb) pb.addEventListener('change', ev => {
      const sel = ev.target.closest('[data-ap-prop]'); if (!sel || sel.value !== NEW_PROP) return;
      const host = sel.closest('[data-ap-id]'), r = host && (rows || []).find(x => x.id === host.dataset.apId);
      sel.value = sel.dataset.prev || '';
      if (!r) return;
      window.openAddProperty(newPropertyPrefill(r, ((window.properties || [])).map(p => p && p.name)), name => {
        if (!sel.isConnected) return;
        sel.innerHTML = propertyOptions(name, true);
        sel.value = name;
        sel.focus();
        toast(`${name} added. Press Save to use it for this bill.`);
      });
    });
    if (pb) pb.addEventListener('submit', ev => {
      const f = ev.target.closest('[data-ap-form]'); if (!f) return;
      ev.preventDefault();
      const host = f.closest('[data-ap-id]'); if (!host) return;
      const kind = f.dataset.apForm, fd = new FormData(f);
      if (kind === 'mark_paid') act(host.dataset.apId, 'mark_paid', { paid_ref: String(fd.get('ref') || '') });
      else if (kind === 'set_email') act(host.dataset.apId, 'set_email', { email: String(fd.get('email') || '') });
      else if (kind === 'set_property' && fd.get('property') === NEW_PROP) return;
      else if (kind === 'set_property') act(host.dataset.apId, 'set_property', { property: String(fd.get('property') || '') });
      else if (kind === 'note') act(host.dataset.apId, 'note', { note: String(fd.get('note') || '') });
      else if (kind === 'delete') removeItem(host.dataset.apId, String(fd.get('reason') || ''));
      else if (kind === 'edit') {
        const r = (rows || []).find(x => x.id === host.dataset.apId); if (!r) return;
        const v = {}; for (const k of editFields(r)) { const el = f.elements[k]; if (el && !el.disabled) v[k] = el.value; }
        const x = editPatch(r, v);
        if (x.error) toast(x.error); else if (!Object.keys(x.patch).length) toast('Nothing changed.'); else saveEdit(r.id, x.patch);
      }
    });
    // Live: Lu adds items while the page is open.
    try {
      if (sb() && sb().channel) sb().channel('ap_items_live').on('postgres_changes', { event: '*', schema: 'public', table: 'ap_items' }, () => { if (rows) { clearTimeout(wire._t); wire._t = setTimeout(() => load(true), 800); } }).subscribe();
    } catch (_) {}
    wireLL();
    wireAcc();
    wireVen();
    wireRefunds();
    fromHash();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
