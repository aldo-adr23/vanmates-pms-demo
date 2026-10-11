/* AP (portal): accounts payable — one list of everything Vanmates pays.
   Reads ap_items / ap_events through RLS (ap-2026-10-11.sql). Writes only through ap_staff_update / ap_staff_bulk
   (admins and accountants). Lu (the Slack bookkeeper) fills the list: cleaners' pay workbook, BC Hydro / FortisBC /
   internet bills from rent@ (PAD), and employee expenses (mirrored; those are approved on Lu's Slack card).
   Loaded by index.html after the main script (uses esc, showToast, CURRENT_USER, window.properties, window.vmDb.sb
   and the shared detail panel). */
(function(){
  const TYPES = { cleaning: 'Cleaning', utility: 'Utilities', internet: 'Internet', employee_expense: 'Employee expense', landlord_rent: 'Landlord rent', other: 'Other' };
  const TABS = [['all', 'All'], ['cleaning', 'Cleaning'], ['utility', 'Utilities'], ['internet', 'Internet'], ['employee_expense', 'Employee expenses']];
  const VIEWS = [['open', 'Open'], ['review', 'To review'], ['approved', 'Approved · to pay'], ['paid', 'Paid'], ['skipped', 'Skipped'], ['everything', 'Everything']];
  const STATUS = { needs_review: ['Needs review', 'red'], flagged: ['Flagged', 'red'], approved: ['Approved', 'blue'], paid: ['Paid', ''], recorded: ['In QuickBooks', ''], skipped: ['Skipped', ''] };
  const FLAGS = {
    no_etransfer_email: 'No e-transfer email', days_dont_add_up: "Days don't add up", sheet_total_mismatch: "Sheet total doesn't match",
    unmapped_account: 'Account has no property', amount_jump: 'Bigger than usual', unreadable: "Couldn't read amount", no_account_number: 'No account number',
    over_reimbursement_cap: 'Over reimbursement cap',
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
    const toPay = rows.filter(r => r.status === 'approved' && !['pad', 'payroll'].includes(r.payment_method));
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
  const canAct = (u) => !!u && ['admin', 'accountant'].includes(String(u.role || ''));
  window.AP_CORE = { TYPES, TABS, VIEWS, STATUS, FLAGS, inTab, inView, money, parseAmount, summarize, sortRows, actionsFor, etransferList, canAct, periodText };
  if (typeof document === 'undefined') return;

  const S = { tab: 'all', view: 'open', q: '', city: '', sel: new Set() };
  let rows = null, loading = null, openSeq = 0;
  const e = (s) => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const toast = (m) => { if (typeof showToast === 'function') showToast(m); };
  const me = () => { const u = (typeof CURRENT_USER !== 'undefined' && CURRENT_USER) || {}; return { email: String(u.email || '').toLowerCase(), role: String(u.role || '') }; };
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
    fromHash();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
