/* Damage deposits → EF (portal): every EF student moving out, grouped by move-out week, with their original Stripe
   damage-deposit payment and the refund (spec: Aldo 2026-11-02, ef-deposits-2026-11-02.sql).
   Reads AND writes go through the partner app (partners.vanmates.com /api/staff/ef-deposits*, staff JWT via rcvApi):
   it syncs EF stays from Arrivals (the weekly rosters already in the portal), searches Stripe, and makes refunds.
   Nothing here can refund without the two-step "Refund … / Confirm" in the detail window, and only for refund
   approvers (admin, accountant, can_approve_refunds).
   Loaded by index.html after the main script (uses esc, showToast, rcvApi, ptnToken, PARTNERS_APP). */
(function(){
  const STATUS = {
    upcoming: ['Upcoming Move-Out', 'blue'], pending_inspection: ['Pending Inspection', 'amber'], ready: ['Ready for Refund', 'green'],
    not_found: ['Payment Not Found', 'red'], check: ['Check Match', 'amber'], processing: ['Refund Processing', 'amber'], refunded: ['Refunded', ''],
    failed: ['Refund Failed', 'red'], closed: ['Closed (no refund)', ''], cancelled: ['Cancelled', ''],
  };
  const OVERDUE_DAYS = 14;   // moved out this long ago and no refund yet → overdue
  const SHEETJS = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';

  // ───────────── pure helpers (window.EF_CORE, tested in test/ef-deposits.test.js) ─────────────
  const money = c => c == null ? '—' : (c < 0 ? '−' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const monday = d => { if (!d) return ''; const t = new Date(d + 'T12:00:00Z'); return addDays(d, -((t.getUTCDay() + 6) % 7)); };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const short = d => d ? `${MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}` : '—';
  function weekLabel(mon, today){
    if (!mon) return 'No move-out date';
    const tw = monday(today);
    const tag = mon === tw ? ' · this week' : mon === addDays(tw, 7) ? ' · next week' : mon === addDays(tw, -7) ? ' · last week' : '';
    return `Week of ${short(mon)} – ${short(addDays(mon, 6))}${tag}`;
  }
  const daysSince = (d, today) => d ? Math.round((Date.parse(today + 'T12:00:00Z') - Date.parse(d + 'T12:00:00Z')) / 86400000) : null;
  /** Moved out OVERDUE_DAYS+ ago and still not refunded / closed. */
  const isOverdue = (r, today) => !['refunded', 'closed', 'cancelled', 'processing'].includes(r.status)
    && r.move_out && daysSince(r.move_out, today) >= OVERDUE_DAYS;
  /** Needs a person: no payment found, refund failed, overdue, or a roster change to check. */
  const needsAttention = (r, today) => r.status === 'not_found' || r.status === 'check' || r.status === 'failed' || isOverdue(r, today)
    || (r.roster_state === 'missing' && r.status === 'upcoming');

  function filterRows(rows, f, today){
    const q = (f.q || '').trim().toLowerCase();
    return rows.filter(r => {
      if (f.week === 'attention') { if (!needsAttention(r, today)) return false; }
      else if (f.week && f.week !== 'all' && r.week !== f.week) return false;
      if (f.property && r.building !== f.property) return false;
      if (f.status && f.status !== 'all' && r.status !== f.status) return false;
      if (!f.showCancelled && r.status === 'cancelled' && f.status !== 'cancelled') return false;
      if (q && ![r.student_name, r.student_email, r.ef_student_id, r.building, r.unit, r.stripe_payment_intent].some(x => String(x || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }

  /** The weekly overview tiles (spec §6) over the rows of one week (or any set). */
  function summary(rows, today){
    const live = rows.filter(r => r.status !== 'cancelled');
    const s = { leaving: live.length, depositCents: 0, depositUnknown: 0, matched: 0, pending: 0, completed: 0, refundedCents: 0, unresolved: 0, overdue: 0 };
    for (const r of live) {
      if (r.paid_cents != null) s.depositCents += r.paid_cents; else s.depositUnknown++;
      if (r.match_state === 'matched') s.matched++;
      if (['pending_inspection', 'ready', 'processing', 'failed'].includes(r.status) || (r.status === 'upcoming' && r.move_out && r.move_out <= today)) s.pending++;
      if (r.status === 'refunded') s.completed++;
      s.refundedCents += r.refunded_cents || 0;
      if (needsAttention(r, today)) s.unresolved++;
      if (isOverdue(r, today)) s.overdue++;
    }
    return s;
  }

  function groupByWeek(rows){
    const m = new Map();
    for (const r of rows) { const k = r.week || ''; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m.entries()].sort((a, b) => (a[0] || '9').localeCompare(b[0] || '9'))
      .map(([week, list]) => ({ week, rows: list.sort((a, b) => (a.move_out || '').localeCompare(b.move_out || '') || (a.building || '').localeCompare(b.building || '') || (a.student_name || '').localeCompare(b.student_name || '')) }));
  }

  // ── roster files → rows {ef_id, name, email, building, unit, bed, move_in, move_out} ──
  // Reads any sheet with a header row naming a student (name / first+last) and a check-out column. EF Toronto
  // ("<Building>_Week 26xx.xlsx", sheets Check In / Check Out, apartment number only on the first bed row) and
  // a plain CSV (name,email,ef_id,building,unit,bed,move_in,move_out) both work.
  const HEAD = {
    name: /^(student\s*name|name|full\s*name|student)$/i, first: /^first\s*name$/i, last: /^(last\s*name|surname)$/i,
    email: /e-?mail/i, ef_id: /^(booking(\s*(id|number|#))?|ef[\s_]*id|student[\s_]*id|booking[\s_]*ref)$/i,
    building: /^(building|residence|property|house)$/i, unit: /^(apartment(\s*number)?|apt|unit|suite)$/i,
    bed: /^(bed(\s*identification)?|bed\s*id|room)$/i,
    move_in: /^(check[\s_-]*in(\s*date)?|move[\s_-]*in(\s*date)?|arrival(\s*date)?|start(\s*date)?)$/i,
    move_out: /^(check[\s_-]*out(\s*date)?|move[\s_-]*out(\s*date)?|departure(\s*date)?|end(\s*date)?)$/i,
  };
  const cellStr = v => v == null ? '' : String(v).trim();
  function findHeader(aoa){
    for (let i = 0; i < Math.min(aoa.length, 25); i++) {
      const cols = {};
      (aoa[i] || []).forEach((c, j) => { const t = cellStr(c); for (const [k, re] of Object.entries(HEAD)) if (cols[k] == null && re.test(t)) cols[k] = j; });
      if ((cols.name != null || cols.first != null) && cols.move_out != null) return { row: i, cols };
    }
    return null;
  }
  // Excel serial → {y, m, d}
  const fromSerial = n => { const t = new Date(Math.round((n - 25569) * 86400000)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
  const iso = (y, m, d) => (y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31) ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : '';
  /** One date cell. order 'DMY' (EF) for text like 7/11/2026; swapSerials: EF Toronto serials have day and month swapped. */
  function readDate(v, order, swapSerials){
    if (v == null || v === '') return '';
    if (typeof v === 'number' && v > 20000 && v < 80000) {
      const p = fromSerial(v);
      return swapSerials && p.d <= 12 ? iso(p.y, p.d, p.m) : iso(p.y, p.m, p.d);
    }
    const s = cellStr(v);
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s); if (m) return iso(+m[1], +m[2], +m[3]);
    m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(s);
    if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return order === 'MDY' ? iso(y, +m[1], +m[2]) : iso(y, +m[2], +m[1]); }
    const t = Date.parse(s); if (!isNaN(t) && /[a-z]{3}/i.test(s)) { const d = new Date(t); return iso(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
    return '';
  }
  /** sheets: [{name, aoa}] (array of rows of cells); returns {rows, building, format, problems}. */
  function parseRoster(sheets, filename){
    const problems = [];
    const fileBuilding = (/^(.+?)[\s_]+week\s*\d+/i.exec(String(filename || '').replace(/\.[a-z]+$/i, '')) || [])[1] || '';
    const efToronto = /week\s*\d{4}/i.test(filename || '');
    // EF Toronto guard (Limpio README): a file with any serial whose day is 13+ was not typed D/M into M/D — no swap.
    let anyBigDay = false;
    const parsedSheets = [];
    for (const sh of sheets) {
      const h = findHeader(sh.aoa); if (!h) continue;
      parsedSheets.push({ sh, h });
      if (efToronto) for (const r of sh.aoa.slice(h.row + 1)) for (const k of ['move_in', 'move_out']) {
        const v = r[h.cols[k]]; if (typeof v === 'number' && v > 20000 && fromSerial(v).d > 12) anyBigDay = true;
      }
    }
    if (!parsedSheets.length) return { rows: [], building: fileBuilding, problems: ['No sheet with a student name and a check-out date column was found. Use a CSV with: name, email, ef_id, building, unit, bed, move_in, move_out.'] };
    const swap = efToronto && !anyBigDay;
    const byKey = new Map();
    for (const { sh, h } of parsedSheets) {
      // EF Toronto "Check In" = after the weekend, "Check Out" = before: both full rosters; we keep each stay once.
      let lastUnit = '';
      sh.aoa.slice(h.row + 1).forEach((r, i) => {
        const g = k => h.cols[k] == null ? '' : r[h.cols[k]];
        const name = h.cols.name != null ? cellStr(g('name')) : [cellStr(g('first')), cellStr(g('last'))].filter(Boolean).join(' ');
        const unitRaw = cellStr(g('unit')); if (unitRaw) lastUnit = unitRaw;
        const email = cellStr(g('email')).toLowerCase();
        if (!name && !email) return;
        const row = { ef_id: cellStr(g('ef_id')), name: name.replace(/\s+/g, ' '), email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : '',
          building: cellStr(g('building')) || fileBuilding, unit: unitRaw || lastUnit, bed: cellStr(g('bed')),
          move_in: readDate(g('move_in'), 'DMY', swap), move_out: readDate(g('move_out'), 'DMY', swap) };
        // EF Toronto mixes real serials with day/month-swapped ones (7 Nov typed as 7/11 into an M/D Excel = 11 Jul).
        // A stay that ends before it starts: try the other reading of an ambiguous serial (day <= 12, day != month).
        if (efToronto && row.move_in && row.move_out && row.move_in > row.move_out) {
          const alt = v => typeof v === 'number' && v > 20000 ? readDate(v, 'DMY', !swap) : '';
          const o2 = alt(g('move_out')), i2 = alt(g('move_in'));
          if (o2 && o2 !== row.move_out && o2 >= row.move_in) row.move_out = o2;
          else if (i2 && i2 !== row.move_in && i2 <= row.move_out) row.move_in = i2;
        }
        if (!row.move_out) { problems.push(`${sh.name} row ${h.row + i + 2}: no readable check-out date (${cellStr(g('move_out')) ? 'not a date' : 'empty'})`); return; }
        if (row.move_in && row.move_in > row.move_out) { problems.push(`${sh.name} row ${h.row + i + 2}: check-out before check-in`); return; }
        const key = (row.ef_id || row.email || row.name.toLowerCase()) + '|' + row.move_in;
        if (!byKey.has(key)) byKey.set(key, row);
      });
    }
    const rows = [...byKey.values()];
    if (rows.some(r => !r.building)) problems.push('Some rows have no building: type it in the box before saving.');
    return { rows, building: fileBuilding, format: efToronto ? 'ef-toronto' : 'table', problems: problems.slice(0, 30).concat(problems.length > 30 ? [`and ${problems.length - 30} more`] : []) };
  }
  function parseCsv(text){
    const out = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); out.push(row); row = []; cur = ''; }
      else cur += c;
    }
    if (cur || row.length) { row.push(cur); out.push(row); }
    return out;
  }

  window.EF_CORE = { money, monday, weekLabel, filterRows, summary, groupByWeek, parseRoster, parseCsv, readDate, isOverdue, needsAttention, STATUS };
  if (typeof document === 'undefined' || !document.querySelector) return;

  // ───────────── page ─────────────
  const S = { tab: 'deposits', data: null, loading: false, error: '', f: { week: 'all', property: '', q: '', status: 'all' }, open: null, busy: false, confirm: false, upload: null };
  const $ = id => document.getElementById(id);
  const api = async (method, path, body) => {
    const res = await rcvApi(method, '/api/staff/ef-deposits' + path, body);
    let data = null; try { data = await res.json(); } catch (_) {}
    return { ok: res.ok && data && data.ok !== false, status: res.status, data: data || {} };
  };
  const ERR = {
    NOT_REFUND_APPROVER: 'Only refund approvers (admin, accountant or "can approve refunds") can send refunds.',
    AMOUNT_MISMATCH: 'The amount changed: reload this student and check the deductions.', STALE: 'Someone else just changed this refund. Reload and check.',
    REFUND_OPEN: 'A refund for this student is already being processed.', OVER_BALANCE: 'That is more than is left on the original payment.',
    NOT_READY: 'Confirm the move-out and the inspection first.', NO_PAYMENT: 'Link the original Stripe payment first.',
    CHANGED_IN_STRIPE: 'This payment was (partly) refunded in Stripe directly. The page has been updated; check before refunding.',
    STRIPE_DECLINED: 'Stripe refused the refund', STRIPE_UNKNOWN: 'Stripe did not answer in time. The refund may or may not exist: use "Check status" (it never refunds twice).',
    STRIPE_NOT_CONFIGURED: 'The EF Stripe account is not connected on the partner app (EF_STRIPE_SECRET_KEY).', LINKED_ELSEWHERE: 'That payment is already linked to another student.',
    PAYMENT_NOT_USABLE: 'That payment was not found in Stripe, or it did not succeed.', LINKED_BY_STAFF: 'This payment was linked by hand; unlink it first.',
    HAS_REFUND: 'This student already has a refund.', DISPUTED: 'The card holder disputed this payment (chargeback): the money already went back, so nothing is refunded here.', WRONG_STAGE: 'This step does not apply any more. Reload.', INVALID: 'Check the form', LOCKED: 'This deposit is already settled.',
    forbidden: 'You need the Damage deposits page (ask an admin).',
  };
  const errText = r => {
    const d = r.data || {}; const base = ERR[d.code] || ERR[d.error] || d.code || d.error || `HTTP ${r.status}`;
    const extra = d.message || (d.errors ? Object.values(d.errors).join(', ') : '');
    return extra ? `${base}: ${extra}` : base;
  };

  function ensureShell(){
    const sec = document.querySelector('section.view[data-view="deposits"]'); if (!sec) return null;
    if (!$('ef-dd')) {
      const bar = document.createElement('div');
      bar.className = 'ef-tabbar'; bar.id = 'dd-tabs'; bar.setAttribute('role', 'tablist'); bar.style.marginBottom = '14px';
      bar.innerHTML = '<button type="button" class="ef-tab" data-dd-tab="deposits" role="tab">Deposits</button><button type="button" class="ef-tab" data-dd-tab="ef" role="tab">EF <span class="name-sub" id="ef-dd-tabcount"></span></button>';
      if (!$('ef-dd-css')) { const st = document.createElement('style'); st.id = 'ef-dd-css';
        st.textContent = '.ef-tabbar{display:flex;gap:22px;border-bottom:1px solid var(--line);flex-wrap:wrap}.ef-tab{padding:0 0 11px;border:0;background:none;font:inherit;font-size:13.5px;font-weight:500;color:var(--muted);cursor:pointer}.ef-tab:hover{color:var(--ink)}.ef-tab.on{color:var(--ink);font-weight:700;box-shadow:inset 0 -2px 0 var(--red)}';
        document.head.appendChild(st); }
      sec.prepend(bar);
      const box = document.createElement('div'); box.id = 'ef-dd'; box.hidden = true; bar.after(box);
      bar.addEventListener('click', e => { const b = e.target.closest('[data-dd-tab]'); if (b) setTab(b.dataset.ddTab); });
      box.addEventListener('click', onClick); box.addEventListener('input', onInput); box.addEventListener('change', onInput);
      if (/[?&#]ef\b/.test(location.hash) || sessionStorage.getItem('ef-dd-tab') === 'ef') S.tab = 'ef';
    }
    return sec;
  }
  function setTab(t){
    S.tab = t; try { sessionStorage.setItem('ef-dd-tab', t); } catch (_) {}
    const sec = ensureShell(); if (!sec) return;
    [...sec.children].forEach(el => { if (el.id === 'dd-tabs') return; if (el.id === 'ef-dd') el.hidden = t !== 'ef'; else el.style.display = t === 'ef' ? 'none' : ''; });
    // keep the Checkouts card's own hidden attribute
    document.querySelectorAll('#dd-tabs [data-dd-tab]').forEach(b => { b.classList.toggle('on', b.dataset.ddTab === t); b.setAttribute('aria-selected', b.dataset.ddTab === t ? 'true' : 'false'); });
    if (t === 'ef') { if (!S.data && !S.loading) load(); else render(); }
  }

  async function load(){
    S.loading = true; S.error = ''; render();
    try {
      const r = await api('GET', '');
      if (!r.ok) throw new Error(errText(r));
      S.data = r.data;
    } catch (e) { S.error = e.message || String(e); }
    S.loading = false; render();
  }

  const badge = st => { const [l, c] = STATUS[st] || [st, '']; const col = { red: 'var(--red-dark,#a33)', green: '#3e6049', amber: '#9a6b12', blue: '#2f5d8a' }[c] || 'var(--muted)'; return `<span class="badge" style="background:transparent;border:1px solid ${col};color:${col};white-space:nowrap">${esc(l)}</span>`; };
  const stripePi = pi => pi ? `https://dashboard.stripe.com/payments/${encodeURIComponent(pi)}` : '';
  const tile = (label, value, sub, warn) => `<div class="kpi"><div class="kpi-deco"></div><div class="kpi-label">${esc(label)}</div><div class="kpi-value" style="font-size:24px${warn ? ';color:var(--red-dark,#a33)' : ''}">${value}</div><div class="kpi-trend">${sub || '&nbsp;'}</div></div>`;

  function render(){
    const box = $('ef-dd'); if (!box) return;
    const tc = $('ef-dd-tabcount');
    if (S.loading && !S.data) { box.innerHTML = '<div class="card"><div class="card-pad name-sub">Loading EF move-outs…</div></div>'; return; }
    if (S.error && !S.data) { box.innerHTML = `<div class="card"><div class="card-pad">Could not load EF deposits: ${esc(S.error)} <button type="button" class="hb-link" data-ef="reload">Try again</button></div></div>`; return; }
    if (!S.data) { box.innerHTML = ''; return; }
    const d = S.data, today = d.today, all = d.rows || [];
    const attention = all.filter(r => needsAttention(r, today));
    if (tc) tc.textContent = attention.length ? String(attention.length) : '';
    const weeks = [...new Set(all.map(r => r.week).filter(Boolean))].sort();
    const thisWeek = monday(today);
    if (!weeks.includes(thisWeek)) weeks.push(thisWeek), weeks.sort();
    const props = [...new Set(all.map(r => r.building).filter(Boolean))].sort();
    const rows = filterRows(all, S.f, today);
    const sumRows = S.f.week === 'attention' || S.f.week === 'all' ? rows : filterRows(all, { week: S.f.week, property: S.f.property }, today);
    const s = summary(sumRows, today);
    const scope = S.f.week === 'attention' ? 'Needs attention' : S.f.week === 'all' ? 'All weeks' : weekLabel(S.f.week, today);
    const up = d.uploads && d.uploads[0];
    box.innerHTML = `
      <div class="card" style="margin-bottom:14px"><div class="card-pad" style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap">
        <div><b>EF damage deposits</b> <span class="name-sub">· ${esc(scope)}</span>
          <div class="card-sub">EF students come from the rosters already in Arrivals${up ? `; last upload <b>${esc(up.filename || 'roster')}</b> ${esc(String(up.uploaded_at || '').slice(0, 10))} (${up.added} new, ${up.changed} changed, ${up.missing} not listed)` : ''}. Stripe deposits are linked by the student's email, or by their name on a Typeform deposit when it is the only one.${d.stripe ? '' : ' <b style="color:var(--red-dark)">Stripe is not connected.</b>'}</div></div>
        <span class="hb-links">
          <label class="btn btn-mini" style="cursor:pointer">Upload EF roster<input type="file" data-ef="file" accept=".xlsx,.xls,.csv" hidden></label>
          <button type="button" class="btn btn-mini" data-ef="match-all" ${S.busy ? 'disabled' : ''} title="Search Stripe for every student leaving in the next 3 weeks (or the last 2 months) who has no payment yet">Find Stripe payments</button>
          <button type="button" class="hb-link" data-ef="reload">Refresh</button>
        </span>
      </div>${S.upload ? uploadHtml() : ''}</div>
      <div class="kpi-grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
        ${tile('Moving out', s.leaving, esc(scope))}
        ${tile('Deposits held', money(s.depositCents), s.depositUnknown ? `${s.depositUnknown} not matched yet` : 'all matched')}
        ${tile('Stripe matched', `${s.matched}<span style="font-size:15px;color:var(--muted)"> / ${s.leaving}</span>`, '')}
        ${tile('Refunds pending', s.pending, 'moved out, not refunded yet')}
        ${tile('Refunds completed', s.completed, money(s.refundedCents) + ' refunded')}
        ${tile('Unresolved / overdue', `${s.unresolved}`, `${s.overdue} overdue (${OVERDUE_DAYS}+ days)`, s.unresolved > 0)}
      </div>
      <div class="filter-bar" style="flex-wrap:wrap;gap:8px">
        <div class="filter-search"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          <input data-ef-f="q" placeholder="Search student, email, EF id, building…" value="${esc(S.f.q)}"></div>
        <select data-ef-f="week" class="input" style="max-width:290px">
          <option value="attention" ${S.f.week === 'attention' ? 'selected' : ''}>⚠ Needs attention (${attention.length})</option>
          <option value="all" ${S.f.week === 'all' ? 'selected' : ''}>All weeks</option>
          ${weeks.map(w => `<option value="${w}" ${S.f.week === w ? 'selected' : ''}>${esc(weekLabel(w, today))}</option>`).join('')}
        </select>
        <select data-ef-f="property" class="input" style="max-width:200px"><option value="">All properties</option>${props.map(p => `<option ${S.f.property === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
        <select data-ef-f="status" class="input" style="max-width:200px"><option value="all">All statuses</option>${Object.entries(STATUS).map(([k, [l]]) => `<option value="${k}" ${S.f.status === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      </div>
      <div class="card"><div style="overflow-x:auto"><table>
        <thead><tr><th>Student</th><th>Property · room</th><th>Move-in</th><th>Move-out</th><th class="right">Deposit</th><th>Stripe payment</th><th class="right">Refund</th><th>Status</th></tr></thead>
        <tbody>${rows.length ? groupByWeek(rows).map(g => `
          <tr><td colspan="8" style="background:var(--cream,#f7f3ec);font-weight:600;font-size:12px;letter-spacing:.02em">${esc(weekLabel(g.week, today))} · ${g.rows.length} leaving</td></tr>
          ${g.rows.map(r => rowHtml(r, today)).join('')}`).join('') : `<tr><td colspan="8" class="name-sub" style="padding:24px;text-align:center">No EF students for these filters.</td></tr>`}
        </tbody></table></div></div>`;
    if (S.open) renderModal();
  }

  function rowHtml(r, today){
    const hl = needsAttention(r, today);
    const pay = r.match_state === 'matched'
      ? `<a href="${stripePi(r.stripe_payment_intent)}" target="_blank" rel="noopener" data-ef-stop>${esc(r.stripe_payment_intent)}</a><div class="name-sub">${esc(String(r.paid_at || '').slice(0, 10))} · ${r.matched_by && r.matched_by.startsWith('staff:') ? 'linked by hand' : r.matched_by === 'auto:name' ? 'linked by name (Typeform)' : 'auto (email)'}</div>`
      : r.match_state === 'unchecked' ? '<span class="name-sub">not searched yet</span>'
      : `<span style="color:var(--red-dark,#a33)">${r.match_state === 'review' ? 'Check candidates' : 'Not found'}</span><div class="name-sub">${esc(r.match_note || '')}</div>`;
    const refund = r.refunded_cents ? `${money(r.refunded_cents)}${(r.refunds || []).find(f => f.stripe_refund_id) ? `<div class="name-sub">${esc((r.refunds.find(f => f.stripe_refund_id) || {}).stripe_refund_id)}</div>` : ''}`
      : r.status === 'ready' ? `<span class="name-sub">due</span> ${money(r.refund_due_cents)}`
      : r.deduction_cents ? `<span class="name-sub">−${money(r.deduction_cents)}</span>` : '—';
    const roster = r.roster_state === 'missing' ? '<div class="name-sub" style="color:#9a6b12">⚠ not on the latest roster</div>'
      : r.roster_state === 'changed' && r.prev_move_out ? `<div class="name-sub" style="color:#9a6b12">was ${esc(short(r.prev_move_out))}</div>` : '';
    return `<tr data-ef-open="${esc(r.id)}" style="cursor:pointer${hl ? ';box-shadow:inset 3px 0 0 var(--red,#c33)' : ''}">
      <td><b>${esc(r.student_name || '—')}</b><div class="name-sub">${esc(r.student_email || 'no email')}${r.ef_student_id ? ' · EF ' + esc(r.ef_student_id) : ''}</div></td>
      <td>${esc(r.building || '—')}${r.unit ? ' · ' + esc(r.unit) : ''}${r.bed ? ' ' + esc(r.bed) : ''}</td>
      <td>${esc(short(r.move_in))}</td>
      <td>${esc(short(r.move_out))}${roster}${isOverdue(r, today) ? '<div class="name-sub" style="color:var(--red-dark,#a33)">overdue</div>' : ''}</td>
      <td class="right">${money(r.paid_cents)}</td>
      <td style="max-width:230px;overflow-wrap:anywhere">${pay}</td>
      <td class="right">${refund}</td>
      <td>${badge(r.status)}</td></tr>`;
  }

  // ── upload preview ──
  function uploadHtml(){
    const u = S.upload;
    if (u.error) return `<div class="card-pad" style="border-top:1px solid var(--line)"><b>${esc(u.filename)}</b>: ${esc(u.error)} <button type="button" class="hb-link" data-ef="upload-cancel">Close</button></div>`;
    const leaving = u.rows.filter(r => r.move_out >= (S.data ? addDays(S.data.today, -7) : '')).length;
    return `<div class="card-pad" style="border-top:1px solid var(--line)">
      <b>${esc(u.filename)}</b> · ${u.rows.length} students read${u.format === 'ef-toronto' ? ' (EF Toronto layout)' : ''}, ${leaving} leaving from last week on.
      ${u.rows.some(r => !r.building) ? `<div style="margin:8px 0">Building for rows without one: <input class="input" data-ef="upload-building" value="${esc(u.building || '')}" style="max-width:220px"></div>` : ''}
      ${u.problems.length ? `<details style="margin:6px 0"><summary class="name-sub">${u.problems.length} rows skipped</summary><div class="name-sub">${u.problems.map(esc).join('<br>')}</div></details>` : ''}
      <div class="name-sub" style="margin:6px 0">Saving adds new students, updates changed check-out dates, and flags students of these buildings who are no longer listed (never deletes). It does not refund anything.</div>
      <button type="button" class="btn btn-primary btn-mini" data-ef="upload-save" ${S.busy || !u.rows.length ? 'disabled' : ''}>Save ${u.rows.length} students</button>
      <button type="button" class="hb-link" data-ef="upload-cancel">Cancel</button></div>`;
  }
  function loadSheetJs(){
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return new Promise((ok, no) => { const s = document.createElement('script'); s.src = SHEETJS; s.onload = () => ok(window.XLSX); s.onerror = () => no(new Error('could not load the spreadsheet reader')); document.head.appendChild(s); });
  }
  async function readFile(file){
    S.upload = { filename: file.name, rows: [], problems: [], building: '' }; render();
    try {
      let sheets;
      if (/\.csv$/i.test(file.name)) sheets = [{ name: 'CSV', aoa: parseCsv(await file.text()) }];
      else {
        const X = await loadSheetJs();
        const wb = X.read(new Uint8Array(await file.arrayBuffer()), { type: 'array', cellDates: false, raw: true });
        sheets = wb.SheetNames.map(n => ({ name: n, aoa: X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }) }));
      }
      const p = parseRoster(sheets, file.name);
      S.upload = { filename: file.name, ...p };
      if (!p.rows.length) S.upload.error = p.problems[0] || 'no students found';
    } catch (e) { S.upload = { filename: file.name, error: e.message || String(e), rows: [], problems: [] }; }
    render();
  }
  async function saveUpload(){
    const u = S.upload; if (!u || !u.rows.length) return;
    const b = (document.querySelector('[data-ef="upload-building"]') || {}).value || u.building || '';
    const rows = u.rows.map(r => Object.assign({}, r, { building: r.building || b.trim() }));
    if (rows.some(r => !r.building)) { showToast('Type the building first'); return; }
    S.busy = true; render();
    const r = await api('POST', '/roster', { filename: u.filename, rows });
    S.busy = false;
    if (!r.ok) { showToast('Could not save the roster: ' + errText(r)); render(); return; }
    showToast(`Roster saved: ${r.data.added} new, ${r.data.changed} changed, ${r.data.unchanged} unchanged, ${r.data.missing} no longer listed`);
    S.upload = null; await load();
  }

  // ── detail window ──
  function modalEl(){
    let bd = $('ef-dd-backdrop');
    if (!bd) {
      bd = document.createElement('div'); bd.className = 'modal-backdrop'; bd.id = 'ef-dd-backdrop'; bd.setAttribute('aria-hidden', 'true');
      bd.innerHTML = `<div class="modal-dialog" role="dialog" aria-labelledby="ef-dd-title" style="max-width:640px;max-height:92vh;overflow:auto">
        <div class="modal-head"><div><div class="modal-title" id="ef-dd-title"></div><div class="modal-sub" id="ef-dd-sub"></div></div>
        <button class="modal-close" type="button" data-ef="dismiss" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
        <div class="modal-body" id="ef-dd-body"></div></div>`;
      document.body.appendChild(bd);
      bd.addEventListener('click', e => { if (e.target === bd) closeModal(); else onClick(e); });
      bd.addEventListener('input', onInput);
    }
    return bd;
  }
  function openModal(id){ S.open = id; S.confirm = false; renderModal(); const bd = modalEl(); bd.classList.add('open'); bd.setAttribute('aria-hidden', 'false'); }
  function closeModal(){ S.open = null; S.confirm = false; const bd = $('ef-dd-backdrop'); if (bd) { bd.classList.remove('open'); bd.setAttribute('aria-hidden', 'true'); } }
  const cur = () => S.data && (S.data.rows || []).find(r => r.id === S.open);

  function renderModal(){
    const r = cur(); if (!r) return closeModal();
    modalEl();
    const me = S.data.me || {}, today = S.data.today;
    $('ef-dd-title').textContent = r.student_name || r.student_email || 'EF student';
    $('ef-dd-sub').innerHTML = `${esc(r.building)}${r.unit ? ' · ' + esc(r.unit) : ''}${r.bed ? ' ' + esc(r.bed) : ''} · ${esc(short(r.move_in))} → ${esc(short(r.move_out))} · ${badge(r.status)}`;
    const ded = Array.isArray(r.deductions) ? r.deductions : [];
    const step = (n, title, done, body) => `<div style="border:1px solid var(--line);border-radius:10px;padding:12px;margin:10px 0${done ? ';opacity:.85' : ''}"><div style="font-weight:600;margin-bottom:6px">${done ? '✓' : n + '.'} ${esc(title)}</div>${body}</div>`;
    const busy = S.busy ? 'disabled' : '';

    // 1. payment
    let pay;
    if (r.match_state === 'matched') {
      pay = `<div><a href="${stripePi(r.stripe_payment_intent)}" target="_blank" rel="noopener">${esc(r.stripe_payment_intent)}</a> · ${money(r.paid_cents)} ${esc((r.currency || '').toUpperCase())} on ${esc(String(r.paid_at || '').slice(0, 10))}</div>
        <div class="name-sub">Charge ${esc(r.stripe_charge || '—')} · ${r.matched_by && r.matched_by.startsWith('staff:') ? 'linked by ' + esc(r.matched_by.slice(6)) : r.matched_by === 'auto:name' ? 'linked by name (Typeform) — unlink if it is the wrong student' : 'matched by email'}${r.stripe_refunded_cents ? ` · <b>${money(r.stripe_refunded_cents)} already refunded in Stripe</b>` : ''} · available ${money(r.available_cents)}</div>
        ${me.can_refund && !r.refunded_cents && !(r.refunds || []).some(f => ['creating', 'pending', 'succeeded'].includes(f.status)) ? `<button type="button" class="hb-link" data-ef="unlink" ${busy}>Unlink (wrong payment)</button>` : ''}`;
    } else {
      const cands = (r.candidates || []);
      pay = `<div style="color:${r.match_state === 'unchecked' ? 'inherit' : 'var(--red-dark,#a33)'}">${esc(r.match_note || (r.match_state === 'unchecked' ? 'Stripe not searched yet.' : 'No payment found.'))}</div>
        ${cands.length ? `<table style="margin-top:8px;font-size:13px"><thead><tr><th>Payment</th><th class="right">Amount</th><th>Date</th><th>Email / why</th><th></th></tr></thead><tbody>
          ${cands.map(c => `<tr><td><a href="${stripePi(c.payment_intent)}" target="_blank" rel="noopener">${esc(c.payment_intent)}</a><div class="name-sub">${esc((c.description || '').slice(0, 80))}</div></td>
            <td class="right">${money(c.amount_cents)}</td><td>${esc(c.created.slice(0, 10))}</td><td>${esc(c.email || '—')}<div class="name-sub">${esc(c.reason)}</div></td>
            <td>${c.linked_elsewhere ? '' : `<button type="button" class="btn btn-mini" data-ef="link" data-pi="${esc(c.payment_intent)}" ${busy}>This one</button>`}</td></tr>`).join('')}</tbody></table>` : ''}
        <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <button type="button" class="btn btn-mini" data-ef="match" ${busy}>Search Stripe again</button>
          <input class="input" data-ef="pi" placeholder="or paste a Stripe payment id (pi_…)" style="max-width:260px">
          <button type="button" class="btn btn-mini" data-ef="link-typed" ${busy}>Link</button></div>
        <div class="name-sub" style="margin-top:4px">Never link on a name alone: open the payment in Stripe and check the email / receipt first.</div>`;
    }

    // 2. moved out
    const moved = r.stage !== 'upcoming';
    const movedBody = moved ? `<div class="name-sub">Confirmed by ${esc(r.moved_out_by || '—')} ${esc(String(r.moved_out_at || '').slice(0, 10))}</div>${r.stage !== 'refunded' && r.stage !== 'closed' && !(r.refunds || []).length ? `<button type="button" class="hb-link" data-ef="undo_moved_out" ${busy}>Undo</button>` : ''}`
      : `<button type="button" class="btn btn-mini" data-ef="moved_out" ${busy} ${r.status === 'cancelled' ? 'disabled' : ''}>Student has moved out</button>${r.move_out > today ? `<span class="name-sub"> (move-out is ${esc(short(r.move_out))})</span>` : ''}`;

    // 3. inspection
    const canInspect = r.stage === 'moved_out' || r.stage === 'inspected';
    const inspected = r.stage === 'inspected' || r.stage === 'refunded' || r.stage === 'closed';
    const editingInspection = canInspect && !(r.refunds || []).some(f => ['creating', 'pending'].includes(f.status));
    const inspBody = !canInspect && !inspected ? '<div class="name-sub">After the move-out.</div>'
      : `${r.inspected_at ? `<div class="name-sub">Inspected by ${esc(r.inspected_by || '—')} ${esc(String(r.inspected_at).slice(0, 10))}</div>` : ''}
        ${editingInspection ? `<div id="ef-ded-list">${(ded.length ? ded : []).map((x, i) => dedRow(x, i)).join('')}</div>
          <button type="button" class="hb-link" data-ef="ded-add">+ Add a deduction</button>
          <textarea class="input" data-ef="insp-notes" rows="2" placeholder="Inspection notes (optional)" style="width:100%;margin-top:6px">${esc(r.inspection_notes || '')}</textarea>
          <button type="button" class="btn btn-mini btn-primary" data-ef="inspected" ${busy} style="margin-top:6px">${r.stage === 'inspected' ? 'Save inspection' : 'Inspection done'}</button>`
        : ded.length ? ded.map(x => `<div>−${money(x.cents)} · ${esc(x.reason)}</div>`).join('') : '<div class="name-sub">No deductions.</div>'}`;

    // 4. refund
    const open = (r.refunds || []).find(f => ['creating', 'pending'].includes(f.status));
    let refBody = (r.refunds || []).map(f => `<div style="margin-bottom:4px">${money(f.amount_cents)} · <b>${esc(f.status)}</b>${f.stripe_refund_id ? ` · <a href="https://dashboard.stripe.com/refunds/${encodeURIComponent(f.stripe_refund_id)}" target="_blank" rel="noopener">${esc(f.stripe_refund_id)}</a>` : ''}
      <div class="name-sub">approved by ${esc(f.approved_by)} ${esc(String(f.approved_at).replace('T', ' ').slice(0, 16))}${f.deduction_cents ? ` · deductions ${money(f.deduction_cents)}` : ''}${f.failure_reason ? ' · ' + esc(f.failure_reason) : ''}</div></div>`).join('');
    if (open) refBody += `<button type="button" class="btn btn-mini" data-ef="refresh" ${busy}>Check status</button>`;
    else if (r.stage === 'inspected' && r.match_state === 'matched') {
      if (!me.can_refund) refBody += `<div class="name-sub">Ready: ${money(r.refund_due_cents)} to refund. A refund approver (admin / finance) sends it.</div>`;
      else if (r.refund_due_cents <= 0) refBody += `<div class="name-sub">Nothing left to refund after deductions.</div><input class="input" data-ef="close-reason" placeholder="Why no refund (required)" style="max-width:300px"> <button type="button" class="btn btn-mini" data-ef="close" ${busy}>Close without refund</button>`;
      else if (!S.confirm) refBody += `<div>Deposit ${money(r.available_cents)}${r.deduction_cents ? ` − deductions ${money(r.deduction_cents)}` : ''} = <b>${money(r.refund_due_cents)}</b></div>
        <button type="button" class="btn btn-primary btn-mini" data-ef="refund-ask" ${busy} style="margin-top:6px">Refund ${money(r.refund_due_cents)}…</button>`;
      else refBody += `<div style="background:#fff6e5;border:1px solid #e5c07b;border-radius:8px;padding:10px;margin-top:6px">
        Refund <b>${money(r.refund_due_cents)}</b> to <b>${esc(r.student_name)}</b> on Stripe payment ${esc(r.stripe_payment_intent)}? This sends money back to their card and cannot be undone.
        <div style="margin-top:8px"><button type="button" class="btn btn-primary btn-mini" data-ef="refund-go" ${busy}>Yes, refund ${money(r.refund_due_cents)}</button> <button type="button" class="hb-link" data-ef="refund-no">Cancel</button></div></div>`;
    } else if (!(r.refunds || []).length) refBody += `<div class="name-sub">${r.match_state !== 'matched' ? 'Link the Stripe payment first.' : 'After the inspection.'}</div>`;
    if (me.can_refund && ['upcoming', 'moved_out'].includes(r.stage) && !open) refBody += `<details style="margin-top:8px"><summary class="name-sub">No refund due (paid elsewhere, forfeited…)</summary><input class="input" data-ef="close-reason" placeholder="Why (required)" style="max-width:300px"> <button type="button" class="btn btn-mini" data-ef="close" ${busy}>Close without refund</button></details>`;

    $('ef-dd-body').innerHTML = `
      ${r.roster_note ? `<div class="name-sub" style="color:#9a6b12;margin-bottom:6px">⚠ ${esc(r.roster_note)}</div>` : ''}
      <div class="name-sub">${esc(r.student_email || 'no email')}${r.ef_student_id ? ' · EF id ' + esc(r.ef_student_id) : ''} · from ${esc(r.source === 'roster' ? 'roster upload' : 'Arrivals')}</div>
      ${step(1, 'Original Stripe damage deposit', r.match_state === 'matched', pay)}
      ${step(2, 'Move-out confirmed', moved, movedBody)}
      ${step(3, 'Room inspection & deductions', r.stage === 'inspected' || r.stage === 'refunded', inspBody)}
      ${step(4, 'Refund', r.stage === 'refunded', refBody)}
      <div style="margin-top:8px"><textarea class="input" data-ef="notes" rows="2" placeholder="Notes" style="width:100%">${esc(r.notes || '')}</textarea>
      <button type="button" class="hb-link" data-ef="note" ${busy}>Save notes</button></div>`;
  }
  const dedRow = (x, i) => `<div data-ef-ded="${i}" style="display:flex;gap:6px;margin:4px 0"><input class="input" data-ef-ded-amt placeholder="$" value="${x.cents ? (x.cents / 100).toFixed(2) : ''}" style="max-width:90px" inputmode="decimal"><input class="input" data-ef-ded-why placeholder="What for (required)" value="${esc(x.reason || '')}" style="flex:1"><button type="button" class="hb-link" data-ef="ded-del">✕</button></div>`;
  function readDeductions(){
    const out = [];
    for (const el of document.querySelectorAll('#ef-ded-list [data-ef-ded]')) {
      const amt = el.querySelector('[data-ef-ded-amt]').value.replace(/[$,\s]/g, ''), why = el.querySelector('[data-ef-ded-why]').value.trim();
      if (!amt && !why) continue;
      const cents = Math.round(Number(amt) * 100);
      if (!(cents > 0)) throw new Error('each deduction needs an amount');
      if (why.length < 3) throw new Error('each deduction needs an explanation');
      out.push({ cents, reason: why });
    }
    return out;
  }

  async function act(action, body){
    const r = cur(); if (!r || S.busy) return;
    S.busy = true; renderModal();
    let res;
    try { res = await api('POST', `/${r.id}/${action}`, body || {}); }
    catch (e) { res = { ok: false, status: 0, data: { code: e.message } }; }
    S.busy = false; S.confirm = false;
    if (res.data && res.data.row) S.data.rows = S.data.rows.map(x => x.id === r.id ? res.data.row : x);
    if (!res.ok) showToast(errText(res));
    else if (action === 'refund') showToast(res.data.status === 'succeeded' ? 'Refund sent' : 'Refund submitted to Stripe (' + res.data.status + ')');
    else showToast('Saved');
    if (res.data && ['AMOUNT_MISMATCH', 'STALE', 'CHANGED_IN_STRIPE', 'WRONG_STAGE'].includes(res.data.code)) { await load(); return; }
    render();
  }

  function onInput(e){
    const k = e.target.dataset.efF;
    if (k) { S.f[k] = e.target.value; render(); if (k === 'q') { const i = document.querySelector('[data-ef-f="q"]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } } return; }
    if (e.target.dataset.ef === 'file' && e.target.files && e.target.files[0]) { readFile(e.target.files[0]); e.target.value = ''; }
  }
  async function onClick(e){
    if (e.target.closest('[data-ef-stop]') || (e.target.closest('a') && e.target.closest('#ef-dd, #ef-dd-backdrop'))) return;
    const openRow = e.target.closest('[data-ef-open]');
    const b = e.target.closest('[data-ef]');
    if (!b && openRow) { openModal(openRow.dataset.efOpen); return; }
    if (!b) return;
    const a = b.dataset.ef;
    if (a === 'file') return;
    if (a === 'reload') return load();
    if (a === 'dismiss') return closeModal();
    if (a === 'upload-cancel') { S.upload = null; return render(); }
    if (a === 'upload-save') return saveUpload();
    if (a === 'match-all') {
      S.busy = true; render();
      const r = await api('POST', '/match', {});
      S.busy = false;
      if (!r.ok) showToast('Could not search Stripe: ' + errText(r));
      else showToast(`Stripe: ${r.data.checked} searched · ${r.data.matched} matched · ${r.data.review} to check · ${r.data.not_found} not found`);
      return load();
    }
    const r = cur(); if (!r) return;
    if (a === 'match') return act('match');
    if (a === 'link') return act('link', { payment_intent: b.dataset.pi });
    if (a === 'link-typed') { const v = (document.querySelector('[data-ef="pi"]') || {}).value || ''; if (!/^pi_/.test(v.trim())) return showToast('Paste a payment id starting with pi_'); return act('link', { payment_intent: v.trim() }); }
    if (a === 'unlink' || a === 'moved_out' || a === 'undo_moved_out' || a === 'refresh') return act(a);
    if (a === 'ded-add') { const list = $('ef-ded-list'); list.insertAdjacentHTML('beforeend', dedRow({}, list.children.length)); return; }
    if (a === 'ded-del') { b.closest('[data-ef-ded]').remove(); return; }
    if (a === 'inspected') { let ded; try { ded = readDeductions(); } catch (err) { return showToast(err.message); } return act('inspected', { deductions: ded, notes: (document.querySelector('[data-ef="insp-notes"]') || {}).value || '' }); }
    if (a === 'note') return act('note', { notes: (document.querySelector('#ef-dd-body [data-ef="notes"]') || {}).value || '' });
    if (a === 'refund-ask') { S.confirm = true; return renderModal(); }
    if (a === 'refund-no') { S.confirm = false; return renderModal(); }
    if (a === 'refund-go') return act('refund', { amount_cents: r.refund_due_cents, expected_refunded_cents: r.refunded_cents });
    if (a === 'close' && b.closest('#ef-dd-body')) { const why = (b.parentElement.querySelector('[data-ef="close-reason"]') || {}).value || ''; if (why.trim().length < 3) return showToast('Say why no refund is sent'); return act('close', { reason: why.trim() }); }
  }

  /** Called by goToView('deposits'). */
  window.efDdShow = function(){ if (!ensureShell()) return; setTab(S.tab); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.open) closeModal(); });
})();
