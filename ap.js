/* AP (portal): accounts payable — one list of everything Vanmates pays.
   Reads ap_items / ap_events through RLS (ap-2026-10-11.sql). Writes only through ap_staff_update / ap_staff_bulk
   (admins and accountants). Lu (the Slack bookkeeper) fills the list: cleaners' pay workbook, BC Hydro / FortisBC /
   internet bills from rent@ (PAD), and employee expenses (mirrored; those are approved on Lu's Slack card).
   Loaded by index.html after the main script (uses esc, showToast, CURRENT_USER, window.properties, window.vmDb.sb
   and the shared detail panel). */
(function(){
  const TYPES = { cleaning: 'Cleaning', utility: 'Utilities', internet: 'Internet', employee_expense: 'Employee expense', landlord_rent: 'Landlord rent', other: 'Other' };
  const TABS = [['all', 'All'], ['cleaning', 'Cleaning'], ['utility', 'Utilities'], ['internet', 'Internet'], ['employee_expense', 'Employee expenses'], ['landlord_rent', 'Landlords']];
  const VIEWS = [['open', 'Open'], ['review', 'To review'], ['approved', 'Approved · to pay'], ['paid', 'Paid'], ['skipped', 'Skipped'], ['everything', 'Everything']];
  const STATUS = { needs_review: ['Needs review', 'red'], flagged: ['Flagged', 'red'], approved: ['Approved', 'blue'], paid: ['Paid', ''], recorded: ['In QuickBooks', ''], skipped: ['Skipped', ''] };
  const FLAGS = {
    no_etransfer_email: 'No e-transfer email', days_dont_add_up: "Days don't add up", sheet_total_mismatch: "Sheet total doesn't match",
    unmapped_account: 'Account has no property', amount_jump: 'Bigger than usual', unreadable: "Couldn't read amount", no_account_number: 'No account number',
    over_reimbursement_cap: 'Over reimbursement cap',
    no_cheque: 'No cheque this month', cheque_bounced: 'Cheque bounced', pad_missing: 'PAD not seen in the bank', amount_mismatch: "Amount doesn't match",
  };
  const METHOD = { etransfer: 'E-transfer', pad: 'PAD', payroll: 'Payroll', cheque: 'Cheque', card: 'Card', other: 'Other' };
  const COLS = 8;

  // ── pure helpers (window.AP_CORE, tested in test/ap.test.js) ──
  const inTab = (r, tab) => tab === 'all' || r.type === tab;
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
  // What the drawer offers. Employee expenses are decided on Lu's Slack card.
  function actionsFor(r, canAct){
    const lu = r.type === 'employee_expense';
    const open = ['needs_review', 'flagged'].includes(r.status);
    return {
      approve: canAct && !lu && open, skip: canAct && !lu && !['paid', 'recorded', 'skipped'].includes(r.status),
      reopen: canAct && !lu && ['skipped', 'approved'].includes(r.status), markPaid: canAct && !lu && r.status === 'approved',
      setProperty: canAct && !lu, setEmail: canAct && r.type === 'cleaning' && !['paid', 'recorded'].includes(r.status),
      setAmount: canAct && !lu && open, note: canAct,
    };
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
    const rank = { none: 0, low: 1, ok: 2 };
    return terms.map(term => {
      const fut = term.method === 'cheque' ? futureCheques(cheques, term, today) : [];
      const left = fut.length;
      return { term, left, lastDated: fut.map(c => String(c.dated_for)).sort().pop() || null, warn: term.method !== 'cheque' ? null : left === 0 ? 'none' : left <= 2 ? 'low' : 'ok' };
    }).sort((a, b) => (a.warn == null) - (b.warn == null) || (rank[a.warn] ?? 9) - (rank[b.warn] ?? 9) || a.left - b.left || String(a.term.landlord_name || '').localeCompare(String(b.term.landlord_name || '')));
  }
  // Same rule as vm_ap_approver(): admins, accountants, and anyone granted the AP page.
  const canAct = (u) => !!u && (['admin', 'accountant'].includes(String(u.role || '')) || (Array.isArray(u.allowed_pages) && u.allowed_pages.includes('ap')));
  window.AP_CORE = { TYPES, TABS, VIEWS, STATUS, FLAGS, METHOD, inTab, inView, money, parseAmount, summarize, sortRows, actionsFor, etransferList, canAct, periodText, batchPreview, chequesLeft, landlordSummary };
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
      && (!q || [r.payee, r.payee_email, r.property, r.account_no, r.paid_ref, r.notes, (r.data || {}).vendor].some(v => String(v || '').toLowerCase().includes(q))));
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
    if (tabs) tabs.innerHTML = TABS.map(([k, l]) => `<button type="button" class="tab${S.tab === k ? ' active' : ''}" role="tab" aria-selected="${S.tab === k}" data-ap-tab="${k}">${l} <span class="name-sub">${rows.filter(r => inTab(r, k) && inView(r, S.view)).length}</span></button>`).join('');
    const vsel = document.getElementById('ap-view'); if (vsel && vsel.value !== S.view) vsel.value = S.view;
    const list = sortRows(filtered());
    const cnt = document.getElementById('ap-count'); if (cnt) cnt.textContent = list.length;
    const tot = document.getElementById('ap-total'); if (tot) tot.textContent = money(list.reduce((s, r) => s + Number(r.amount_cents || 0), 0));
    const empty = document.getElementById('ap-empty'); if (empty) empty.style.display = list.length ? 'none' : '';
    const body = document.getElementById('ap-body');
    if (body) body.innerHTML = list.map(r => `<tr class="clickable" data-ap-open="${e(r.id)}" tabindex="0" style="cursor:pointer">
        <td onclick="event.stopPropagation()"><input type="checkbox" data-ap-sel="${e(r.id)}" ${S.sel.has(r.id) ? 'checked' : ''} aria-label="Select ${e(r.payee)}"></td>
        <td>${e(TYPES[r.type] || r.type)}<div class="name-sub">${e(METHOD[r.payment_method] || '')}</div></td>
        <td><b>${e(r.payee)}</b>${r.payee_email ? `<div class="name-sub">${e(r.payee_email)}</div>` : r.account_no ? `<div class="name-sub">Acct ${e(r.account_no)}</div>` : (r.data || {}).vendor ? `<div class="name-sub">${e(r.data.vendor)}</div>` : ''}</td>
        <td>${e(r.property || '—')}<div class="name-sub">${e(r.city || '')}</div></td>
        <td>${e(periodText(r) || '—')}${r.due_date ? `<div class="name-sub">Due ${e(r.due_date)}</div>` : ''}</td>
        <td style="text-align:right;white-space:nowrap"><b>${e(money(r.amount_cents))}</b></td>
        <td>${pill(r.status)}</td>
        <td>${(r.flags || []).map(flag).join(' ')}</td>
      </tr>`).join('');
    bulkBar(list);
    showLL(S.tab === 'landlord_rent');
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
      <button class="btn btn-ghost" type="button" data-ap-bulk="skip">Skip</button>` : ''}
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

  function propertyOptions(current){
    const names = [...new Set(((window.properties || [])).map(p => p && p.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return `<option value="">— choose —</option>` + names.map(n => `<option ${n === current ? 'selected' : ''}>${e(n)}</option>`).join('') + (current && !names.includes(current) ? `<option selected>${e(current)}</option>` : '');
  }

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
        ${field('Vendor', e(d.vendor || ''))}
        ${field('Paid', r.paid_at ? e(when(r.paid_at)) + (r.paid_ref ? ' · ' + e(r.paid_ref) : '') : '')}
        ${field('Approved', r.approved_at ? e(when(r.approved_at)) + ' · ' + e(r.approved_by || '') : '')}
        ${field('Source', r.doc_url ? `<a href="${e(r.doc_url)}" target="_blank" rel="noopener">Open the original</a>` : e(r.source))}
        ${d.recentAverageCents ? field('Usual amount', e(money(d.recentAverageCents))) : ''}
      </div>
      ${days.length ? H('By day') + `<div style="display:grid;grid-template-columns:auto auto;gap:2px 16px;max-width:280px">${days.map(([k, v]) => `<span class="name-sub">${e(k)}</span><span style="text-align:right">${e(money(v))}</span>`).join('')}</div>` : ''}
      ${r.type === 'employee_expense' ? `<p class="name-sub" style="margin-top:16px">Employee expenses are approved on Lu's card in Slack (#bookkeping-review) and paid through payroll; this list follows along.</p>` : ''}
      ${a.approve || a.skip || a.reopen ? H('Decision') + `<div style="display:flex;gap:8px;flex-wrap:wrap">
        ${a.approve ? `<button class="btn btn-primary" type="button" data-ap-do="approve">Approve</button>` : ''}
        ${a.reopen ? `<button class="btn" type="button" data-ap-do="reopen">Back to review</button>` : ''}
        ${a.skip ? `<button class="btn btn-ghost" type="button" data-ap-do="skip">Skip</button>` : ''}</div>` : ''}
      ${a.markPaid ? H('Mark paid') + `<form data-ap-form="mark_paid" style="display:flex;gap:8px;flex-wrap:wrap"><input class="form-input" name="ref" placeholder="E-transfer reference / cheque # (optional)" style="max-width:280px"><button class="btn btn-primary" type="submit">Mark paid</button></form>` : ''}
      ${a.setEmail ? H('E-transfer email') + `<form data-ap-form="set_email" style="display:flex;gap:8px;flex-wrap:wrap"><input class="form-input" name="email" type="email" value="${e(r.payee_email || '')}" placeholder="name@example.com" style="max-width:280px" required><button class="btn" type="submit">Save</button></form><div class="name-sub">Remembered for ${e(r.payee)}'s next pay period.</div>` : ''}
      ${a.setProperty ? H('Property') + `<form data-ap-form="set_property" style="display:flex;gap:8px;flex-wrap:wrap"><select class="form-input" name="property" style="max-width:320px">${propertyOptions(r.property)}</select><button class="btn" type="submit">Save</button></form>${['utility', 'internet'].includes(r.type) && r.account_no ? `<div class="name-sub">Account ${e(r.account_no)} will use this property for future bills.</div>` : ''}` : ''}
      ${a.setAmount ? H('Amount') + `<form data-ap-form="set_amount" style="display:flex;gap:8px;flex-wrap:wrap"><input class="form-input" name="amount" inputmode="decimal" value="${e((Number(r.amount_cents) / 100).toFixed(2))}" style="max-width:160px"><button class="btn" type="submit">Save</button></form>` : ''}
      ${a.note ? H('Note') + `<form data-ap-form="note" style="display:grid;gap:8px"><textarea class="form-input" name="note" rows="2">${e(r.notes || '')}</textarea><div style="display:flex;justify-content:flex-end"><button class="btn btn-ghost" type="submit">Save note</button></div></form>` : (r.notes ? H('Note') + `<div>${e(r.notes)}</div>` : '')}
      ${H('History')}<div style="display:grid;gap:4px">${events.map(ev => `<div class="name-sub">${e(when(ev.created_at))} · ${e(ev.actor || '')} · ${e(String(ev.action).replace(/_/g, ' '))}${ev.detail && ev.detail.paid_ref ? ' · ' + e(ev.detail.paid_ref) : ''}${ev.detail && ev.detail.status ? ' → ' + e(ev.detail.status) : ''}</div>`).join('') || '<div class="name-sub">—</div>'}</div>
    </div>`;
  }

  // ───────────── AP → Landlords: monthly rent · cheques · payment set-up ─────────────
  const LL = { view: 'month', month: ym(), terms: null, cheques: null, loading: null, generated: false, q: '', status: 'with_landlord', landlord: '' };
  const CHQ = { with_landlord: ['With landlord', 'blue'], cashed: ['Cashed', ''], void: ['Void', ''], bounced: ['Bounced', 'red'] };
  const WARN = { none: ['No cheques left', 'red'], low: ['Needs cheques', 'red'], ok: ['OK', ''] };
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

  function showLL(on){
    const ll = document.getElementById('ap-ll'), list = document.getElementById('ap-list-card'), bar = document.getElementById('ap-filter-bar');
    if (ll) ll.style.display = on ? '' : 'none';
    if (list) list.style.display = on ? 'none' : '';
    if (bar) bar.style.display = on ? 'none' : '';
    if (on) { if (!LL.terms) llLoad(); else renderLL(); }
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
          <td style="text-align:right">${e(money(r.term.amount_cents))}</td><td>${r.term.method === 'cheque' ? `<b>${e(r.left)}</b>` : '—'}</td><td>${e(r.lastDated || '—')}</td>
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
      act(host.dataset.apId, b.dataset.apDo, {});
    });
    if (pb) pb.addEventListener('submit', ev => {
      const f = ev.target.closest('[data-ap-form]'); if (!f) return;
      ev.preventDefault();
      const host = f.closest('[data-ap-id]'); if (!host) return;
      const kind = f.dataset.apForm, fd = new FormData(f);
      if (kind === 'mark_paid') act(host.dataset.apId, 'mark_paid', { paid_ref: String(fd.get('ref') || '') });
      else if (kind === 'set_email') act(host.dataset.apId, 'set_email', { email: String(fd.get('email') || '') });
      else if (kind === 'set_property') act(host.dataset.apId, 'set_property', { property: String(fd.get('property') || '') });
      else if (kind === 'note') act(host.dataset.apId, 'note', { note: String(fd.get('note') || '') });
      else if (kind === 'set_amount') { const c = parseAmount(fd.get('amount')); if (c == null) toast('Type an amount like 1234.50'); else act(host.dataset.apId, 'set_amount', { amount_cents: c }); }
    });
    // Live: Lu adds items while the page is open.
    try {
      if (sb() && sb().channel) sb().channel('ap_items_live').on('postgres_changes', { event: '*', schema: 'public', table: 'ap_items' }, () => { if (rows) { clearTimeout(wire._t); wire._t = setTimeout(() => load(true), 800); } }).subscribe();
    } catch (_) {}
    wireLL();
    fromHash();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
