/* Damage deposits → EF (portal): every EF student moving out, grouped by move-out week, with their original Stripe
   damage-deposit payment and the refund (spec: Aldo 2026-11-02, ef-deposits-2026-11-02.sql).
   Reads AND writes go through the partner app (partners.vanmates.com /api/staff/ef-deposits*, staff JWT via rcvApi):
   it syncs EF stays from Arrivals (the weekly rosters already in the portal), searches Stripe, and makes refunds.
   Nothing here can refund without the two-step "Refund … / Confirm" in the detail window, and only for refund
   approvers (admin, accountant, can_approve_refunds).
   Loaded by index.html after the main script (uses esc, showToast, rcvApi, ptnToken, PARTNERS_APP). */
(function(){
  const STATUS = {
    upcoming: ['Upcoming Move-Out', 'blue'], pending_reports: ['Pending Reports', 'amber'], review: ['Ready for Review', 'green'],
    rejected: ['Rejected', 'red'], pending_auth: ['Pending Denise Approval', 'amber'],
    not_found: ['Payment Not Found', 'red'], check: ['Check Match', 'amber'], processing: ['Approved / Processing', 'amber'], refunded: ['Refunded', ''],
    refunded_stripe: ['Refunded in Stripe', ''], manual: ['Manual Review Required', 'red'],
    failed: ['Refund Failed', 'red'], closed: ['Closed (no refund)', ''], cancelled: ['Cancelled', ''],
  };
  /** The review queue (spec 2026-11-22): what each band asks of whom. */
  const APPROVE_BANDS = [
    ['pending_auth', 'Pending Denise approval — authorize to send the refund', '#9a6b12'],
    ['manual', 'Manual review required', 'var(--red-dark,#a33)'],
    ['failed', 'Refund failed at Stripe', 'var(--red-dark,#a33)'],
    ['rejected', 'Rejected by Denisse — review again', 'var(--red-dark,#a33)'],
    ['review', 'Ready for review — cleaning report attached', '#3e6049'],
    ['pending_reports', 'Pending reports — no Limpio cleaning report yet', '#9a6b12'],
  ];
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
  const needsAttention = (r, today) => ['not_found', 'check', 'failed', 'manual', 'rejected'].includes(r.status) || isOverdue(r, today)
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
      if (['pending_reports', 'review', 'rejected', 'pending_auth', 'processing', 'failed', 'manual'].includes(r.status) || (r.status === 'upcoming' && r.move_out && r.move_out <= today)) s.pending++;
      if (r.status === 'refunded') s.completed++;
      s.refundedCents += r.refunded_cents || 0;
      if (needsAttention(r, today)) s.unresolved++;
      if (isOverdue(r, today)) s.overdue++;
    }
    return s;
  }

  /** The three questions the team asks (Aldo 2026-11-05): who is moving out, whose deposit we hold, who has not paid. */
  const hasDeposit = r => !!r.stripe_payment_intent && r.paid_cents != null;
  const isOpen = r => !['refunded', 'refunded_stripe', 'closed', 'cancelled'].includes(r.status);
  /** Rows of the "To approve" view, grouped like APPROVE_BANDS. */
  function approveBands(rows){
    const byOut = (a, b) => (a.move_out || '9').localeCompare(b.move_out || '9') || (a.student_name || '').localeCompare(b.student_name || '');
    return APPROVE_BANDS.map(([st, label, col]) => ({ status: st, label, col, rows: rows.filter(r => r.status === st).sort(byOut) })).filter(b => b.rows.length);
  }
  /** Moved out, and the team sheet says the deposit went back although Stripe shows no refund. */
  const sheetSaysDone = r => !!(r.sheet_flag && r.sheet_flag.code === 'sheet_done');
  function efViews(rows, today){
    const open = rows.filter(isOpen);
    const byOut = (a, b) => (a.move_out || '9').localeCompare(b.move_out || '9') || (a.student_name || '').localeCompare(b.student_name || '');
    const gone = open.filter(r => r.move_out && r.move_out < today).sort(byOut);
    const left = gone.filter(r => !sheetSaysDone(r)), sheetDone = gone.filter(sheetSaysDone);
    const ahead = open.filter(r => !r.move_out || r.move_out >= today).sort(byOut);
    const held = open.filter(hasDeposit).sort(byOut);
    const unpaid = open.filter(r => !hasDeposit(r) && (!r.move_out || r.move_out >= addDays(today, -30))).sort(byOut);
    return { left, sheetDone, ahead, held, heldCents: held.reduce((t, r) => t + (r.available_cents != null ? r.available_cents : r.paid_cents || 0), 0),
      check: unpaid.filter(r => r.match_state === 'review'), none: unpaid.filter(r => r.match_state !== 'review') };
  }
  /** What has to happen next for one stay, in plain words ([label, colour]). */
  function nextStep(r, today){
    if (r.status === 'processing') return ['Approved — Stripe processing', 'amber'];
    if (r.status === 'manual') return [r.stage === 'refunded' ? 'Refunded — receipt not delivered' : 'Stripe did not answer — check status', 'red'];
    if (r.status === 'failed') return ['Refund failed — authorize again', 'red'];
    if (sheetSaysDone(r)) return ['Sheet says refunded — confirm how', 'amber'];
    if (!hasDeposit(r)) return r.match_state === 'review' ? ['Confirm the payment', 'amber'] : ['No deposit found', 'red'];
    if (r.status === 'pending_auth') return [`Denisse: authorize ${money(r.refund_due_cents)}`, 'amber'];
    if (r.status === 'rejected') return ['Rejected — review again', 'red'];
    if (r.status === 'review') return ['Review the refund', 'green'];
    if (r.status === 'pending_reports') return ['Waiting for the cleaning report', 'amber'];
    if (r.move_out && r.move_out <= today) return ['Mark as moved out', 'amber'];
    return [`Return ${money(r.available_cents != null ? r.available_cents : r.paid_cents)} after move-out`, ''];
  }

  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function monthLabel(ym, today){
    if (!ym) return 'No move-out date';
    const tag = ym === today.slice(0, 7) ? ' · this month' : ym === addDays(today.slice(0, 7) + '-28', 7).slice(0, 7) ? ' · next month' : '';
    return `${MONTH_NAMES[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}${tag}`;
  }
  /** Rows already sorted by move-out → [{ month: 'yyyy-mm', rows }] in order. */
  function groupByMonth(rows){
    const out = [];
    for (const r of rows) { const k = (r.move_out || '').slice(0, 7); const g = out[out.length - 1]; if (g && g.month === k) g.rows.push(r); else out.push({ month: k, rows: [r] }); }
    return out;
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

  // ── the team's deposit sheet ("EF Deposits - Canada": tabs EF The Ivy / EF The Well / EF The Parker) ──
  const SHEET_HEAD = {
    name: /^(what is your full name\??|name|full\s*name|student(\s*name)?)$/i,
    move_out: /^(departure(\s*date)?|move[\s-]*out(\s*date)?|check[\s-]*out(\s*date)?)$/i,
    unit: /^(unit\s*no\.?|unit[\s-]*room|unit|room)$/i, paid: /^deposit\s*paid$/i, deposit: /^deposit$/i,
    deductions: /^deductions?$/i, refund: /^refund$/i, status: /^status$/i, comments: /^comments?$/i, token: /^token$/i, link: /^link$/i,
  };
  /** '$1,400.00' / 400 → cents; '' → null. */
  const toCents = v => { if (v === '' || v == null) return null; const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : null; };
  /** sheets: [{name, aoa}] of the downloaded .xlsx → {rows, tabs, problems}. Only tabs named "EF …" with a Status column. */
  function parseTeamSheet(sheets, today){
    const rows = [], tabs = [], problems = [];
    const from = today ? addDays(today, -400) : '';
    for (const sh of sheets) {
      if (!/^ef\b/i.test(String(sh.name || '').trim())) continue;
      let hdr = null;
      for (let i = 0; i < Math.min(sh.aoa.length, 5) && !hdr; i++) {
        const cols = {};
        (sh.aoa[i] || []).forEach((c, j) => { const t = cellStr(c); for (const [k, re] of Object.entries(SHEET_HEAD)) if (re.test(t)) (cols[k] = cols[k] || []).push(j); });
        if (cols.name && cols.move_out && cols.status) hdr = { row: i, cols };
      }
      if (!hdr) { problems.push(`${sh.name}: no Name / Move-out / Status header — skipped`); continue; }
      const c = hdr.cols; let n = 0;
      const first = (r, k) => { for (const j of (c[k] || [])) { const v = cellStr(r[j]); if (v) return r[j]; } return ''; };
      // Ivy has "Unit No." (clean) and "Unit-room" (as typed): prefer the clean one
      const unitCols = (c.unit || []).slice().sort((a, b) => (/no/i.test(cellStr(sh.aoa[hdr.row][b])) ? 1 : 0) - (/no/i.test(cellStr(sh.aoa[hdr.row][a])) ? 1 : 0));
      sh.aoa.slice(hdr.row + 1).forEach((r, i) => {
        const name = cellStr(first(r, 'name')).replace(/\s+/g, ' ');
        if (!name) return;
        const rawOut = first(r, 'move_out');
        const move_out = readDate(rawOut, 'MDY', false);
        const line = hdr.row + i + 2;
        if (!move_out || move_out < '2024-01-01') { problems.push(`${sh.name} row ${line}: move-out "${cellStr(rawOut)}" is not a full date`); return; }
        if (from && move_out < from) return;
        let unit = ''; for (const j of unitCols) { const v = cellStr(r[j]); if (v) { unit = v; break; } }
        rows.push({ tab: String(sh.name).trim(), row: line, name, move_out, unit, status: cellStr(first(r, 'status')), paid: cellStr(first(r, 'paid')),
          deposit_cents: toCents(first(r, 'deposit')), deduction_cents: toCents(first(r, 'deductions')), refund_cents: toCents(first(r, 'refund')),
          comments: (c.comments || []).map(j => cellStr(r[j])).filter(Boolean).join(' · '), token: cellStr(first(r, 'token')), link: cellStr(first(r, 'link')) });
        n++;
      });
      tabs.push([String(sh.name).trim(), n]);
    }
    return { rows, tabs, problems: problems.slice(0, 30).concat(problems.length > 30 ? [`and ${problems.length - 30} more`] : []) };
  }

  const priceOf = x => x.cents ? money(x.cents) + (x.max_cents && x.max_cents > x.cents ? '–' + money(x.max_cents) : '') : 'market price';
  /** Step 3: the deductions the reports point to, always visible (even before the payment is linked); added in step 4. */
  function proposedHtml(r){
    const sug = r.suggested_charges || []; if (!sug.length) return '';
    const lo = sug.reduce((t, x) => t + (x.cents || 0), 0), hi = sug.reduce((t, x) => t + (x.max_cents || x.cents || 0), 0), market = sug.some(x => !x.cents);
    const total = (lo ? money(lo) + (hi > lo ? '–' + money(hi) : '') : '') + (market ? (lo ? ' + ' : '') + 'damage at market price' : '');
    return `<div style="border:1px solid #d9b766;border-radius:8px;padding:8px 10px;margin:8px 0;background:rgba(217,183,102,.10)">
      <div style="font-weight:600">Proposed deductions <span class="name-sub" style="font-weight:400">(Penalty List)</span></div>
      ${sug.map(x => `<div style="display:flex;gap:8px;padding:3px 0;border-top:1px solid var(--line)"><div style="flex:1"><b>${esc(x.label)}</b>
        <div class="name-sub">${esc(x.reason)}${x.scope === 'unit' ? ' — found on the apartment, may be a roommate\'s' : ''}</div></div>
        <div style="white-space:nowrap;font-weight:600">${priceOf(x)}</div></div>`).join('')}
      <div style="display:flex;justify-content:space-between;border-top:1px solid var(--line);padding-top:4px;margin-top:2px"><b>Proposed total</b><b>${total}</b></div>
      <div class="name-sub" style="margin-top:2px">Plus the cleaning fee. Nothing is deducted automatically: the reviewer adds each one with its amount in step 4.</div></div>`;
  }
  window.EF_CORE = { proposedHtml, priceOf, approveBands, APPROVE_BANDS, parseTeamSheet, toCents, sheetSaysDone, groupByMonth, monthLabel, efViews, nextStep, money, monday, weekLabel, filterRows, summary, groupByWeek, parseRoster, parseCsv, readDate, isOverdue, needsAttention, STATUS };
  if (typeof document === 'undefined' || !document.querySelector) return;

  // ───────────── page ─────────────
  const S = { sheet: null, tab: 'deposits', data: null, loading: false, error: '', f: { week: 'all', property: '', q: '', status: 'all' }, view: 'moving', viewChosen: false, month: (() => { try { return sessionStorage.getItem('ef-dd-month') || ''; } catch (_) { return ''; } })(), open: null, busy: false, confirm: false, upload: null, settings: null, history: null };
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
    NOT_REVIEWER: 'Only the EF refund reviewer can approve or cancel (Settings).', NOT_AUTHORIZER: 'Only Denisse (the final authorizer) can authorize or reject.',
    NOT_APPROVED: 'The refund has to be approved in the review first.', ALREADY_APPROVED: 'Already approved — waiting for Denisse.',
    NO_REPORT: 'No Limpio cleaning report: say why it can be approved anyway.', NO_EMAIL: 'No email for the student: type one.', RECEIPT_FAILED: 'The receipt email failed.',
    NOT_ADMIN: 'Only an admin can change the settings.', PDF_FAILED: 'Limpio could not make the PDF (try again in a minute).', NO_REPORT: 'No finished Limpio clean is linked yet.', NO_REFUND: 'No confirmed refund yet.',
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
      // the reviewer / Denisse land on their queue
      const me = r.data.me || {};
      if (!S.viewChosen && (me.can_review || me.can_authorize)) S.view = 'approve';
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
    const lateCount = efViews(all, today).left.length;   // moved out, deposit not returned yet
    if (tc) tc.textContent = lateCount ? String(lateCount) : '';
    const props = [...new Set(all.map(r => r.building).filter(Boolean))].sort();
    const V = efViews(filterRows(all, { week: 'all', property: S.f.property, q: S.f.q }, today), today);
    const up = d.uploads && d.uploads[0];
    box.innerHTML = `
      <div class="card" style="margin-bottom:14px"><div class="card-pad" style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap">
        <div><b>EF damage deposits</b>
          <div class="card-sub">${up ? `Last roster: <b>${esc(up.filename || 'roster')}</b>, ${esc(String(up.uploaded_at || '').slice(0, 10))}. ` : ''}${d.sheet_import ? `Team sheet imported ${esc(String(d.sheet_import.uploaded_at || '').slice(0, 10))} by ${esc(d.sheet_import.uploaded_by || '—')}. ` : ''}Click a student to see the payment, the Limpio cleaning report and the refund breakdown; Denisse authorizes every refund.${d.stripe ? '' : ' <b style="color:var(--red-dark)">Stripe is not connected.</b>'}</div></div>
        <span class="hb-links">
          <label class="btn btn-mini" style="cursor:pointer">Upload EF roster<input type="file" data-ef="file" accept=".xlsx,.xls,.csv" hidden></label>
          <label class="btn btn-mini" style="cursor:pointer" title="The team's EF Deposits - Canada sheet: File → Download → Microsoft Excel (.xlsx)">Import team sheet<input type="file" data-ef="sheetfile" accept=".xlsx" hidden></label>
          <button type="button" class="btn btn-mini" data-ef="match-all" ${S.busy ? 'disabled' : ''} title="Search Stripe for every student leaving in the next 3 weeks (or the last 2 months) who has no payment yet">Find Stripe payments</button>
          ${d.me && d.me.is_admin ? '<button type="button" class="hb-link" data-ef="settings-open">Settings</button>' : ''}
          <button type="button" class="hb-link" data-ef="reload">Refresh</button>
        </span>
      </div>${S.upload ? uploadHtml() : ''}${S.sheet ? sheetHtml() : ''}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
        ${[['approve', 'To approve', approveBands(filterRows(all, { week: 'all', property: S.f.property, q: S.f.q }, today)).reduce((t, b) => t + b.rows.length, 0)], ['moving', 'Moving out', V.left.length + V.ahead.length], ['held', 'Deposits held', V.held.length], ['unpaid', 'No deposit', V.check.length + V.none.length]]
          .map(([k, l, n]) => `<button type="button" class="btn ${S.view === k ? 'btn-primary' : ''}" data-ef-view="${k}">${l} <span style="opacity:.75">${n}</span></button>`).join('')}
        <span style="flex:1"></span>
        <div class="filter-search" style="min-width:220px"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
          <input data-ef-f="q" placeholder="Search student, email, EF id…" value="${esc(S.f.q)}"></div>
        <select data-ef-f="property" class="input" style="max-width:180px"><option value="">All buildings</option>${props.map(p => `<option ${S.f.property === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
      </div>
      ${S.settings ? settingsHtml() : ''}
      ${S.view === 'approve' ? approveHtml(filterRows(all, { week: 'all', property: S.f.property, q: S.f.q }, today), today) : S.view === 'held' ? heldHtml(V, today) : S.view === 'unpaid' ? unpaidHtml(V, today) : movingHtml(V, today)}`;
    if (S.open) renderModal();
  }

  const room = r => `${esc(r.building || '—')}${r.unit ? ' · ' + esc(r.unit) : ''}${r.bed ? ' ' + esc(r.bed) : ''}`;
  const who = r => `<b>${esc(r.student_name || '—')}</b><div class="name-sub">${esc(r.student_email || 'no email')}${r.ef_student_id ? ' · EF ' + esc(r.ef_student_id) : ''}</div>`;
  const sheetLine = r => !r.sheet ? '' : `<div class="name-sub">Sheet: ${esc(r.sheet.status || 'no status')}${r.sheet.deduction_cents ? ` · −${money(r.sheet.deduction_cents)}` : ''}</div>`
    + (r.sheet_flag && !sheetSaysDone(r) ? `<div class="name-sub" style="color:#9a6b12">⚠ ${esc(r.sheet_flag.text)}</div>` : '');
  const step = (r, today) => { const [l, c] = nextStep(r, today); const col = { red: 'var(--red-dark,#a33)', green: '#3e6049', amber: '#9a6b12' }[c] || 'var(--muted)';
    return `<span style="color:${col};font-weight:${c ? 600 : 400};white-space:nowrap">${esc(l)}</span>${sheetLine(r)}`; };
  const dep = r => hasDeposit(r) ? `${money(r.available_cents != null ? r.available_cents : r.paid_cents)}<div class="name-sub">paid ${esc(short(String(r.paid_at || '').slice(0, 10)))}</div>`
    : r.match_state === 'review' ? '<span style="color:#9a6b12">to confirm</span>' : '<span style="color:var(--red-dark,#a33)">none</span>';
  const table = (head, body, empty) => `<div class="card"><div style="overflow-x:auto"><table><thead><tr>${head.map(h => `<th${/Deposit|Held/.test(h) ? ' class="right"' : ''}>${h}</th>`).join('')}</tr></thead>
    <tbody>${body || `<tr><td colspan="${head.length}" class="name-sub" style="padding:24px;text-align:center">${empty}</td></tr>`}</tbody></table></div></div>`;
  const band = (label, n) => `<tr><td colspan="9" style="background:var(--cream,#f7f3ec);font-weight:600;font-size:12px;letter-spacing:.02em">${label} · ${n}</td></tr>`;
  const rowOpen = r => `data-ef-open="${esc(r.id)}" style="cursor:pointer"`;
  const hasCond = r => (r.cleaning || []).some(c => c && c.condition_at);
  const pdfLink = r => r.has_report ? `<button type="button" class="hb-link" data-ef-pdf="${esc(r.id)}" title="Limpio report (PDF)">📄 ${hasCond(r) ? 'Condition report' : 'Cleaning report'}</button>` : '';

  function movingHtml(V, today){
    const two = V.ahead.filter(r => r.move_out && r.move_out <= addDays(today, 13));
    const twoCents = two.filter(hasDeposit).reduce((t, r) => t + (r.available_cents || 0), 0);
    const line = r => `<tr ${rowOpen(r)}><td>${who(r)}</td><td>${room(r)}</td><td><b>${esc(short(r.move_out))}</b></td><td class="right">${dep(r)}</td><td>${step(r, today)}${pdfLink(r) ? '<div>' + pdfLink(r) + '</div>' : ''}</td></tr>`;
    // one button per group (moved out / each month) — pick one, no scrolling through every month
    const groups = [];
    if (V.left.length) groups.push({ key: 'left', label: 'Moved out', title: '<span style="color:var(--red-dark,#a33)">Already moved out — deposit not returned yet</span>', rows: V.left, col: 'var(--red-dark,#a33)' });
    if (V.sheetDone.length) groups.push({ key: 'sheet', label: 'Sheet says refunded', title: '<span style="color:#9a6b12">Moved out — the team sheet says refunded, Stripe shows no refund: confirm how it was paid back</span>', rows: V.sheetDone, col: '#9a6b12' });
    for (const g of groupByMonth(V.ahead)) groups.push({ key: g.month || 'none', label: g.month ? `${MONTHS[+g.month.slice(5, 7) - 1]}${g.month.slice(0, 4) !== today.slice(0, 4) ? ' ' + g.month.slice(2, 4) : ''}` : 'No date', title: esc(monthLabel(g.month, today)), rows: g.rows });
    const thisMonth = groups.find(g => g.key === today.slice(0, 7));
    const pick = groups.find(g => g.key === S.month) || (S.month === 'all' ? null : groups.find(g => g.key === 'left') || thisMonth || groups[0]);
    const shown = pick ? [pick] : groups;
    const chip = (key, label, n, on, col) => `<button type="button" class="btn btn-mini${on ? ' btn-primary' : ''}" data-ef-month="${esc(key)}" style="white-space:nowrap${col && !on ? ';color:' + col : ''}">${esc(label)} <span style="opacity:.7">${n}</span></button>`;
    const chips = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin:0 0 10px;position:sticky;top:0;z-index:2;background:var(--bg,#fbf8f2);padding:6px 0">
      ${groups.map(g => chip(g.key, g.label, g.rows.length, pick && pick.key === g.key, g.col)).join('')}${chip('all', 'All', groups.reduce((t, g) => t + g.rows.length, 0), !pick)}</div>`;
    let body = '';
    for (const g of shown) body += band(g.title, g.rows.length) + g.rows.map(line).join('');
    return chips + `<div class="card-sub" style="margin:0 0 10px">Next 2 weeks: <b>${two.length}</b> students moving out · <b>${money(twoCents)}</b> in deposits to return${two.filter(r => !hasDeposit(r)).length ? ` · <span style="color:var(--red-dark,#a33)">${two.filter(r => !hasDeposit(r)).length} with no deposit</span>` : ''}</div>`
      + table(['Student', 'Building · room', 'Move-out', 'Deposit', 'Next step'], body, 'Nobody moving out for these filters.');
  }
  function approveHtml(rows, today){
    const me = S.data.me || {};
    const fees = (S.data.settings || {}).cleaning_fees || {};
    const line = r => `<tr ${rowOpen(r)}><td>${who(r)}</td><td>${room(r)}</td><td>${esc(short(r.move_out))}</td>
      <td>${r.has_report ? `<span style="color:#3e6049">✓</span> ${pdfLink(r)}` : r.no_report_reason ? '<span style="color:#9a6b12">none — reason given</span>' : '<span style="color:#9a6b12">missing</span>'}</td>
      <td class="right">${money(r.available_cents)}</td><td class="right">${r.stage === 'inspected' || r.stage === 'refunded' ? '−' + money(r.deduction_cents) : r.cleaning_fee_default_cents ? '−' + money(r.cleaning_fee_default_cents) + '<div class="name-sub">cleaning</div>' : '—'}</td>
      <td class="right"><b>${money(r.stage === 'inspected' || r.stage === 'refunded' ? r.refund_due_cents : Math.max(0, (r.available_cents || 0) - (r.cleaning_fee_default_cents || 0)))}</b></td><td>${step(r, today)}</td></tr>`;
    let body = '';
    for (const b of approveBands(rows)) body += band(`<span style="color:${b.col}">${esc(b.label)}</span>`, b.rows.length) + b.rows.map(line).join('');
    const feeText = Object.entries(fees).map(([k, c]) => `The ${k.replace(/\b\w/g, x => x.toUpperCase())} ${money(c)}`).join(' · ');
    return `<div class="card-sub" style="margin:0 0 10px">Students who left: the Limpio cleaning report is linked automatically, the cleaning fee is taken off (${esc(feeText || 'no fees set')}), ${me.can_review ? 'you review' : 'the reviewer reviews'} and Denisse authorizes. Nothing is refunded before Denisse's authorization.</div>`
      + table(['Student', 'Building · room', 'Move-out', 'Report', 'Deposit', 'Deductions', 'Refund', 'Next step'], body, 'Nothing to review or authorize for these filters.');
  }
  function settingsHtml(){
    const x = S.settings;
    if (x.loading) return '<div class="card" style="margin-bottom:14px"><div class="card-pad name-sub">Loading settings…</div></div>';
    const fees = Object.entries(x.cleaning_fees || {});
    return `<div class="card" style="margin-bottom:14px"><div class="card-pad">
      <b>EF refund settings</b> <span class="name-sub">— admins only; every change is logged.</span>
      <div style="margin-top:8px"><div class="name-sub">Cleaning fee taken from the deposit, per residence</div>
        <div id="ef-set-fees">${fees.map(([k, c]) => feeRow(k, c)).join('')}</div>
        <button type="button" class="hb-link" data-ef="set-fee-add">+ Add a residence</button></div>
      <div style="margin-top:8px"><div class="name-sub">Penalty List — amounts suggested from the cleaning reports (range top optional; amount 0 = market price, the reviewer types it)</div>
        <div id="ef-set-pens">${(x.penalties || []).map(penRow).join('')}</div>
        <button type="button" class="hb-link" data-ef="set-pen-add">+ Add a penalty</button></div>
      <div style="margin-top:8px;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px">
        <label class="name-sub">Reviewers (Approve / Cancel), comma-separated<input class="input" data-ef-set="reviewers" value="${esc((x.reviewers || []).join(', '))}" style="width:100%"></label>
        <label class="name-sub">Final authorization (sends the refund)<input class="input" data-ef-set="authorizers" value="${esc((x.authorizers || []).join(', '))}" style="width:100%"></label></div>
      <div style="margin-top:8px"><button type="button" class="btn btn-primary btn-mini" data-ef="settings-save" ${S.busy ? 'disabled' : ''}>Save settings</button> <button type="button" class="hb-link" data-ef="settings-close">Close</button></div>
    </div></div>`;
  }
  const feeRow = (k, c) => `<div data-ef-fee style="display:flex;gap:6px;margin:4px 0;align-items:center"><span class="name-sub">The</span><input class="input" data-ef-fee-name value="${esc(k)}" placeholder="well" style="max-width:160px"><input class="input" data-ef-fee-amt value="${c != null ? (c / 100).toFixed(2) : ''}" placeholder="$" inputmode="decimal" style="max-width:90px"><button type="button" class="hb-link" data-ef="set-fee-del">✕</button></div>`;
  const dollars = c => c != null && c !== '' ? (c / 100).toFixed(2) : '';
  const penRow = p => `<div data-ef-pen data-code="${esc(p.code || '')}" style="display:flex;gap:6px;margin:4px 0;align-items:center;flex-wrap:wrap"><input class="input" data-ef-pen-label value="${esc(p.label || '')}" placeholder="Penalty" style="flex:1;min-width:160px"><input class="input" data-ef-pen-amt value="${dollars(p.cents)}" placeholder="$" inputmode="decimal" style="max-width:80px"><span class="name-sub">to</span><input class="input" data-ef-pen-max value="${dollars(p.max_cents)}" placeholder="max $" inputmode="decimal" style="max-width:80px"><input class="input" data-ef-pen-note value="${esc(p.note || '')}" placeholder="note" style="max-width:200px"><button type="button" class="hb-link" data-ef="set-pen-del">✕</button></div>`;
  function readSettings(){
    const fees = {};
    for (const el of document.querySelectorAll('#ef-set-fees [data-ef-fee]')) {
      const k = el.querySelector('[data-ef-fee-name]').value.trim(), a = el.querySelector('[data-ef-fee-amt]').value.replace(/[$,\s]/g, '');
      if (!k && !a) continue;
      const c = Math.round(Number(a) * 100);
      if (!k || !(c >= 0) || a === '') throw new Error('each residence needs a name and an amount');
      fees[k] = c;
    }
    const list = k => ((document.querySelector(`[data-ef-set="${k}"]`) || {}).value || '').split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
    const penalties = [];
    for (const el of document.querySelectorAll('#ef-set-pens [data-ef-pen]')) {
      const q = k => el.querySelector(`[data-ef-pen-${k}]`).value.trim();
      const label = q('label'), amt = q('amt').replace(/[$,\s]/g, ''), max = q('max').replace(/[$,\s]/g, '');
      if (!label && !amt) continue;
      const cents = Math.round(Number(amt || 0) * 100), maxC = max === '' ? null : Math.round(Number(max) * 100);
      if (label.length < 3 || !(cents >= 0) || (maxC != null && !(maxC >= cents))) throw new Error(`penalty "${label || '?'}": name, amount, and a range top not below the amount`);
      penalties.push({ code: el.dataset.code || '', label, cents, max_cents: maxC, note: q('note') });
    }
    return { cleaning_fees: fees, reviewers: list('reviewers'), authorizers: list('authorizers'), penalties };
  }
  function heldHtml(V, today){
    const body = V.held.map(r => `<tr ${rowOpen(r)}><td>${who(r)}</td><td>${room(r)}</td><td>${esc(short(r.move_in))} → <b>${esc(short(r.move_out))}</b></td>
      <td class="right">${dep(r)}</td><td>${step(r, today)}</td></tr>`).join('');
    return `<div class="card-sub" style="margin:0 0 10px">We hold <b>${V.held.length}</b> EF deposits · <b>${money(V.heldCents)}</b> in total, soonest move-out first.</div>`
      + table(['Student', 'Building · room', 'Stay', 'Held', 'Next step'], body, 'No deposits held for these filters.');
  }
  function unpaidHtml(V, today){
    const line = r => `<tr ${rowOpen(r)}><td>${who(r)}</td><td>${room(r)}</td><td>${esc(short(r.move_in))} → ${esc(short(r.move_out))}</td>
      <td style="max-width:320px"><span class="name-sub">${esc(r.match_note || 'not searched yet')}</span></td></tr>`;
    let body = '';
    if (V.check.length) body += band('<span style="color:#9a6b12">A payment may be theirs — open and confirm it</span>', V.check.length) + V.check.map(line).join('');
    if (V.none.length) body += band('<span style="color:var(--red-dark,#a33)">No deposit payment found</span>', V.none.length) + V.none.map(line).join('');
    return `<div class="card-sub" style="margin:0 0 10px">Students living with us now or arriving (or left in the last 30 days) with no deposit linked. Open a student to search Stripe or paste the payment id.</div>`
      + table(['Student', 'Building · room', 'Stay', 'What we found'], body, 'Everyone has a deposit for these filters.');
  }

  function rowHtml(r, today){
    const hl = needsAttention(r, today);
    const pay = r.match_state === 'matched'
      ? `<a href="${stripePi(r.stripe_payment_intent)}" target="_blank" rel="noopener" data-ef-stop>${esc(r.stripe_payment_intent)}</a><div class="name-sub">${esc(String(r.paid_at || '').slice(0, 10))} · ${r.matched_by && r.matched_by.startsWith('staff:') ? 'linked by hand' : r.matched_by === 'auto:name' ? 'linked by name (Typeform)' : r.matched_by === 'sheet:token' ? 'team sheet token' : 'auto (email)'}</div>`
      : r.match_state === 'unchecked' ? '<span class="name-sub">not searched yet</span>'
      : `<span style="color:var(--red-dark,#a33)">${r.match_state === 'review' ? 'Check candidates' : 'Not found'}</span><div class="name-sub">${esc(r.match_note || '')}</div>`;
    const refund = r.refunded_cents ? `${money(r.refunded_cents)}${(r.refunds || []).find(f => f.stripe_refund_id) ? `<div class="name-sub">${esc((r.refunds.find(f => f.stripe_refund_id) || {}).stripe_refund_id)}</div>` : ''}`
      : r.status === 'pending_auth' ? `<span class="name-sub">due</span> ${money(r.refund_due_cents)}`
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
  // ── team sheet import ──
  function sheetHtml(){
    const u = S.sheet;
    const pad = 'class="card-pad" style="border-top:1px solid var(--line)"';
    if (u.error) return `<div ${pad}><b>${esc(u.filename)}</b>: ${esc(u.error)} <button type="button" class="hb-link" data-ef="sheet-cancel">Close</button></div>`;
    if (u.result) {
      const x = u.result, fl = x.flags || {};
      const FL = { sheet_done: 'sheet says refunded, Stripe does not', sheet_behind: 'refunded but the sheet is behind', other_stay: 'payment on the student\'s other stay',
        sheet_no_refund: 'sheet says no refund', sheet_no_deposit: 'sheet says no deposit', sheet_paid: 'sheet says paid, no payment linked', deductions_differ: 'deductions differ' };
      return `<div ${pad}><b>Team sheet imported.</b> ${x.lines} lines read${x.older ? ` (${x.older} from before the portal's EF records)` : ''} · <b>${x.matched}</b> tied to a student
        · ${x.linked + x.relinked} Stripe payments linked by Typeform token${x.relinked ? ` (${x.relinked} replaced a name link)` : ''} · ${x.refunds_read} Stripe-dashboard refunds read back
        ${x.stripe ? '' : `<div class="name-sub" style="color:var(--red-dark,#a33)">Stripe was not read${x.stripe_error ? ': ' + esc(x.stripe_error) : ''} — tokens not linked.</div>`}
        ${Object.keys(fl).length ? `<div style="margin-top:4px">Disagreements: ${Object.entries(fl).map(([k, n]) => `<b>${n}</b> ${esc(FL[k] || k)}`).join(' · ')}</div>` : '<div class="name-sub">No disagreements between the sheet and Stripe.</div>'}
        ${(x.unmatched_lines || []).length ? `<details style="margin-top:6px"><summary class="name-sub">${x.unmatched_lines.length} sheet lines with no student here (not on an EF roster in the portal)</summary>
          <div class="name-sub">${x.unmatched_lines.map(l => `${esc(l.tab)} row ${l.row}: ${esc(l.name)} · ${esc(short(l.move_out))} · ${esc(l.status || '—')}${l.why === 'two stays fit' ? ' (two stays fit — not stored)' : ''}`).join('<br>')}</div></details>` : ''}
        <div style="margin-top:6px"><button type="button" class="hb-link" data-ef="sheet-cancel">Close</button></div></div>`;
    }
    const by = u.tabs.map(([t, n]) => `${esc(t)} ${n}`).join(' · ');
    return `<div ${pad}><b>${esc(u.filename)}</b> · ${u.rows.length} lines from the last 13 months (${by || 'no EF tabs'}).
      ${u.problems.length ? `<details style="margin:6px 0"><summary class="name-sub">${u.problems.length} lines skipped</summary><div class="name-sub">${u.problems.map(esc).join('<br>')}</div></details>` : ''}
      <div class="name-sub" style="margin:6px 0">Each line is tied to the student with the same name in the same residence (move-out within 10 days). The sheet's status, deductions and comments are shown next to the portal's, Ivy Typeform tokens link the exact Stripe payment, and refunds made in the Stripe dashboard are read back. Nothing is refunded, closed or changed in the inspection.</div>
      <button type="button" class="btn btn-primary btn-mini" data-ef="sheet-save" ${S.busy || !u.rows.length ? 'disabled' : ''}>${S.busy ? 'Importing… (about a minute)' : `Import ${u.rows.length} lines`}</button>
      <button type="button" class="hb-link" data-ef="sheet-cancel">Cancel</button></div>`;
  }
  async function readSheetFile(file){
    S.sheet = { filename: file.name, rows: [], tabs: [], problems: [] }; render();
    try {
      const X = await loadSheetJs();
      const wb = X.read(new Uint8Array(await file.arrayBuffer()), { type: 'array', cellDates: false, raw: true });
      const sheets = wb.SheetNames.map(n => ({ name: n, aoa: X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: '' }) }));
      const p = parseTeamSheet(sheets, S.data ? S.data.today : '');
      S.sheet = { filename: file.name, ...p };
      if (!p.rows.length) S.sheet.error = p.problems[0] || 'no EF tab with Name, Move-out and Status columns found';
    } catch (e) { S.sheet = { filename: file.name, error: e.message || String(e), rows: [], tabs: [], problems: [] }; }
    render();
  }
  async function saveSheet(){
    const u = S.sheet; if (!u || !u.rows.length || S.busy) return;
    S.busy = true; render();
    const r = await api('POST', '/sheet', { filename: u.filename, rows: u.rows });
    S.busy = false;
    if (!r.ok) { showToast('Could not import the sheet: ' + errText(r)); render(); return; }
    await load();
    S.sheet = { filename: u.filename, result: r.data, rows: [], tabs: [], problems: [] }; render();
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
        <div class="name-sub">Charge ${esc(r.stripe_charge || '—')} · ${r.matched_by && r.matched_by.startsWith('staff:') ? 'linked by ' + esc(r.matched_by.slice(6)) : r.matched_by === 'auto:name' ? 'linked by name (Typeform) — unlink if it is the wrong student' : r.matched_by === 'sheet:token' ? 'linked by the team sheet (Typeform token)' : 'matched by email'}${r.stripe_refunded_cents ? ` · <b>${money(r.stripe_refunded_cents)} already refunded in Stripe</b>` : ''} · available ${money(r.available_cents)}</div>
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

    // 3. Limpio cleaning reports (linked automatically every 10 minutes)
    const cl = Array.isArray(r.cleaning) ? r.cleaning : [];
    const photoLinks = ps => ps.length ? `<div class="name-sub" style="margin-top:2px">${ps.slice(0, 40).map((p, i) => `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.area || 'photo')} ${i + 1}</a>`).join(' · ')}</div>` : '<div class="name-sub">No photos.</div>';
    const CLEAN = { clean: 'Clean', average: 'Average', dirty: 'Dirty', very_dirty: 'Very dirty' };
    const et = iso => { const t = Date.parse(iso || ''); return isNaN(t) ? '' : new Date(t).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Toronto' }) + ' ET'; };
    const condText = (c, x) => { const it = c && c.items; if (!it) return ''; const bad = Object.entries(it).filter(([, v]) => v && v.status && v.status !== 'good');
      const k = c.keys || {}, p = (x && x.precheck) || {};
      return `<div style="border-left:3px solid ${x && x.condition_at ? '#3e6049' : 'var(--line)'};padding:4px 8px;margin:4px 0">
        ${x && x.condition_at ? `<div><b>Move-out condition report</b> <span class="name-sub">filed before cleaning · ${esc(et(x.condition_at))}</span></div>` : ''}
        <div class="name-sub">Condition: ${bad.length ? bad.map(([kk, v]) => `<span style="${/damage|missing/.test(v.status) ? 'color:var(--red-dark,#a33)' : ''}">${esc(kk)} ${esc(String(v.status).replace(/_/g, ' '))}${v.note ? ' (' + esc(v.note) + ')' : ''}</span>`).join(' · ') : 'all good'}</div>
        ${k.status ? `<div class="name-sub">Keys: <span style="${k.status !== 'returned' ? 'color:var(--red-dark,#a33)' : ''}">${esc(k.status)}${k.found != null && k.status !== 'missing' ? ' (' + esc(k.found) + ' found)' : ''}</span></div>` : ''}
        ${p.cleanliness ? `<div class="name-sub">General cleanliness: <b>${esc(CLEAN[p.cleanliness] || p.cleanliness)}</b></div>` : ''}
        ${p.missing_items ? `<div class="name-sub">Missing or broken: ${esc(p.missing_items)}</div>` : ''}
        ${p.observations ? `<div class="name-sub">Observations: ${esc(p.observations)}</div>` : ''}</div>`; };
    const repBody = (cl.length ? cl.map(c => `<div style="border-top:1px solid var(--line);padding:6px 0">
        <b>${esc(c.type || 'Clean')}</b> · ${esc(short(c.date))} · ${c.status === 'completed' ? '<span style="color:#3e6049">completed</span>' : esc(c.status)} · ${esc(c.property)} ${esc(c.unit)}${c.match === 'unit' ? ' <span class="name-sub">(apartment, bed not named)</span>' : ''}
        <div class="name-sub">${esc(c.task_id)}${c.cleaner ? ' · ' + esc(c.cleaner) : ''}${c.clock_out ? ' · finished ' + esc(et(c.clock_out)) : ''}</div>
        ${c.notes ? `<div class="name-sub">Notes: ${esc(c.notes)}</div>` : ''}
        ${(c.issues || []).map(i => `<div style="color:#9a6b12">⚠ ${esc(i.category)}${i.urgency ? ' · ' + esc(i.urgency) : ''}: ${esc(i.description)}${(i.photos || []).map((u, k) => ` <a href="${esc(u)}" target="_blank" rel="noopener">photo ${k + 1}</a>`).join('')}</div>`).join('')}
        ${condText(c.condition, c)}${photoLinks(c.photos || [])}</div>`).join('')
      : `<div style="color:#9a6b12">⚠ No Limpio clean found for ${esc(r.building)} ${esc(r.unit)}${r.bed ? ' bed ' + esc(r.bed) : ''} between the day before and a week after the move-out.</div>`)
      + (r.has_report ? `<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">${hasCond(r) ? `<button type="button" class="btn btn-mini btn-primary" data-ef-pdf="${esc(r.id)}" ${busy}>📄 Move-out condition report (PDF)</button>` : ''}${cl.some(c => c.status === 'completed') ? `<button type="button" class="btn btn-mini" data-ef-pdf="${esc(r.id)}" data-kind="completion" ${busy}>📄 Cleaning completion report (PDF)</button>` : ''}</div>`
          + (hasCond(r) ? '' : '<div class="name-sub" style="color:#9a6b12">No move-out condition report on this clean (filed before cleaning from 2026-11-23).</div>') : '')
      + proposedHtml(r)
      + `<div class="name-sub" style="margin-top:4px">${r.cleaning_checked_at ? 'Checked ' + esc(et(r.cleaning_checked_at)) + '. ' : ''}<button type="button" class="hb-link" data-ef="reports" ${busy}>Look in Limpio again</button></div>`;

    // 4. review (reviewer: Approve / Cancel) — the cleaning fee comes from the settings, damage deductions are typed
    const refunds = r.refunds || [];
    const open = refunds.find(f => ['creating', 'pending'].includes(f.status));
    const approved = r.stage === 'inspected' && r.review_state === 'approved';
    const settled = ['refunded', 'closed'].includes(r.stage);
    const left = r.stage === 'moved_out' || (r.stage === 'upcoming' && r.move_out && r.move_out <= today);
    const damage = ded.filter(x => x.kind !== 'cleaning');
    const fee = approved || settled ? (r.cleaning_fee_cents || 0) : (r.cleaning_fee_default_cents || 0);
    S.bk = { avail: r.available_cents || 0, fee, bld: r.building || '' };
    const bk = (dmgCents, feeCents) => `<table style="font-size:13px;margin:4px 0"><tbody>
        <tr><td>Original deposit</td><td class="right">${money(r.available_cents)}</td></tr>
        <tr><td>Cleaning fee (${esc(r.building || '')})</td><td class="right">−${money(feeCents)}</td></tr>
        <tr><td>Damage deductions</td><td class="right">−${money(dmgCents)}</td></tr>
        <tr><td><b>Refund</b></td><td class="right"><b>${money(Math.max(0, (r.available_cents || 0) - feeCents - dmgCents))}</b></td></tr></tbody></table>`;
    let revBody;
    if (settled || approved || open) {
      revBody = `${r.reviewed_by ? `<div class="name-sub">Approved by ${esc(r.reviewed_by)} ${esc(String(r.reviewed_at || '').replace('T', ' ').slice(0, 16))}</div>` : ''}
        ${bk(damage.reduce((t, x) => t + x.cents, 0), r.stage === 'closed' && r.review_state === 'cancelled' ? 0 : fee)}
        ${damage.map(x => `<div class="name-sub">−${money(x.cents)} · ${esc(x.reason)}${x.code ? ' <span class="name-sub">(Penalty List)</span>' : ''}</div>`).join('')}
        ${r.no_report_reason ? `<div class="name-sub" style="color:#9a6b12">Approved without a cleaning report: ${esc(r.no_report_reason)}</div>` : ''}
        ${r.inspection_notes ? `<div class="name-sub">Notes: ${esc(r.inspection_notes)}</div>` : ''}
        ${approved && !open && me.can_review ? `<button type="button" class="hb-link" data-ef="review-edit" ${busy}>Revise (sends it back to review)</button>` : ''}`;
    } else if (!left) revBody = '<div class="name-sub">After the move-out.</div>';
    else if (r.match_state !== 'matched') revBody = '<div class="name-sub" style="color:var(--red-dark,#a33)">Link the original Stripe payment first (step 1).</div>';
    else if (!me.can_review) revBody = `<div class="name-sub">Waiting for the reviewer (${esc(((S.data.settings || {}).reviewers || []).join(', '))}).</div>${bk(0, fee)}`;
    else {
      const startDmg = damage.length ? damage : [];
      revBody = `${r.review_state === 'rejected' ? `<div style="color:var(--red-dark,#a33);margin-bottom:4px">Rejected by ${esc(r.rejected_by || '')}: ${esc(r.reject_reason || '')}</div>` : ''}
        <div id="ef-bk">${bk(startDmg.reduce((t, x) => t + x.cents, 0), fee)}</div>
        ${fee ? `<label class="name-sub" style="display:block"><input type="checkbox" data-ef="waive"> Waive the cleaning fee</label><input class="input" data-ef="waive-reason" placeholder="Why the cleaning fee is waived" style="width:100%;display:none">` : `<div class="name-sub">No cleaning fee set for ${esc(r.building || 'this residence')} (Settings).</div>`}
        ${!damage.length && r.sheet && r.sheet.deduction_cents > 0 ? `<div class="name-sub">Team sheet: −${money(r.sheet.deduction_cents)}${r.sheet.comments ? ' · ' + esc(r.sheet.comments) : ''} <button type="button" class="hb-link" data-ef="ded-sheet">Use it</button></div>` : ''}
        ${sugHtml(r, startDmg)}
        <div id="ef-ded-list">${startDmg.map((x, i) => dedRow(x, i)).join('')}</div>
        <button type="button" class="hb-link" data-ef="ded-add">+ Add a damage deduction</button>
        ${r.has_report ? '' : `<input class="input" data-ef="no-report" placeholder="No cleaning report: why it can be approved anyway (required)" style="width:100%;margin-top:6px" value="${esc(r.no_report_reason || '')}">`}
        <textarea class="input" data-ef="insp-notes" rows="2" placeholder="Notes for Denisse (optional)" style="width:100%;margin-top:6px">${esc(r.inspection_notes || '')}</textarea>
        <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button type="button" class="btn btn-mini btn-primary" data-ef="approve" ${busy}>Approve refund</button>
          <details style="display:inline-block"><summary class="hb-link">Cancel refund…</summary><input class="input" data-ef="cancel-reason" placeholder="Why (required). Refunds nothing." style="max-width:300px"> <button type="button" class="btn btn-mini" data-ef="cancel" ${busy}>Cancel refund</button></details></div>`;
    }

    // 5. final authorization (Denisse)
    let authBody;
    if (r.stage === 'refunded' || refunds.some(f => f.status === 'succeeded')) authBody = `<div class="name-sub">Authorized by ${esc(r.authorized_by || (refunds[0] || {}).approved_by || '—')} ${esc(String(r.authorized_at || '').replace('T', ' ').slice(0, 16))}</div>`;
    else if (open) authBody = `<div class="name-sub">Authorized by ${esc(open.approved_by)} — Stripe is processing.</div>`;
    else if (!approved) authBody = `<div class="name-sub">${r.review_state === 'rejected' ? 'Rejected — waiting for a new review.' : 'After the review is approved.'}</div>`;
    else if (!me.can_authorize) authBody = `<div class="name-sub">Pending Denise approval: ${money(r.refund_due_cents)}.</div>`;
    else if (!S.confirm) authBody = `<div>Refund <b>${money(r.refund_due_cents)}</b> (deposit ${money(r.available_cents)} − deductions ${money(r.deduction_cents)}).</div>
        <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button type="button" class="btn btn-primary btn-mini" data-ef="refund-ask" ${busy} ${r.refund_due_cents > 0 ? '' : 'disabled'}>Authorize & refund ${money(r.refund_due_cents)}…</button>
          <details style="display:inline-block"><summary class="hb-link">Reject…</summary><input class="input" data-ef="reject-reason" placeholder="Why (the reviewer sees it)" style="max-width:300px"> <button type="button" class="btn btn-mini" data-ef="reject" ${busy}>Reject</button></details></div>
        ${r.refund_due_cents > 0 ? '' : '<div class="name-sub">Nothing left to refund after deductions: close it without a refund (step 6).</div>'}`;
    else authBody = `<div style="background:#fff6e5;border:1px solid #e5c07b;border-radius:8px;padding:10px">
        Refund <b>${money(r.refund_due_cents)}</b> to <b>${esc(r.student_name)}</b> on Stripe payment ${esc(r.stripe_payment_intent)}? This sends money back to their card and cannot be undone. The student gets the receipt when Stripe confirms.
        <div style="margin-top:8px"><button type="button" class="btn btn-primary btn-mini" data-ef="refund-go" ${busy}>Yes, refund ${money(r.refund_due_cents)}</button> <button type="button" class="hb-link" data-ef="refund-no">Not now</button></div></div>`;

    // 6. refund + receipt
    let refBody = refunds.map(f => `<div style="margin-bottom:4px">${money(f.amount_cents)} · <b>${esc(f.status === 'succeeded' ? 'refunded (Stripe confirmed)' : f.status === 'creating' || f.status === 'pending' ? 'processing at Stripe' : f.status)}</b>${f.stripe_refund_id ? ` · <a href="https://dashboard.stripe.com/refunds/${encodeURIComponent(f.stripe_refund_id)}" target="_blank" rel="noopener">${esc(f.stripe_refund_id)}</a>` : ''}
      <div class="name-sub">authorized by ${esc(f.approved_by)} ${esc(String(f.approved_at).replace('T', ' ').slice(0, 16))}${f.deduction_cents ? ` · deductions ${money(f.deduction_cents)}` : ''}${f.failure_reason ? ' · ' + esc(f.failure_reason) : ''}</div></div>`).join('');
    if (open) refBody += `<button type="button" class="btn btn-mini" data-ef="refresh" ${busy}>Check status</button>`;
    if (r.stage === 'refunded') {
      refBody += r.receipt_state === 'sent' ? `<div class="name-sub">Receipt emailed to ${esc(r.receipt_to || '')} ${esc(String(r.receipt_at || '').replace('T', ' ').slice(0, 16))}.</div>`
        : `<div style="color:var(--red-dark,#a33)">${r.receipt_state === 'no_email' ? 'No student email: the receipt was not sent.' : r.receipt_state === 'failed' ? `The receipt email to ${esc(r.receipt_to || '')} failed.` : 'Receipt not sent.'}</div>`;
      if ((me.can_review || me.can_authorize) && refunds.some(f => f.status === 'succeeded')) refBody += `<div style="margin-top:4px"><input class="input" data-ef="receipt-email" placeholder="${esc(r.student_email || 'student email')}" style="max-width:240px"> <button type="button" class="btn btn-mini" data-ef="receipt" ${busy}>${r.receipt_state === 'sent' ? 'Resend receipt' : 'Send receipt'}</button></div>`;
    }
    if (!refunds.length && !open) refBody += `<div class="name-sub">${approved ? 'Sent when Denisse authorizes.' : 'Nothing refunded.'}</div>`;
    if (me.can_refund && ['upcoming', 'moved_out', 'inspected'].includes(r.stage) && !open) refBody += `<details style="margin-top:8px"><summary class="name-sub">No refund due (paid elsewhere, forfeited…)</summary><input class="input" data-ef="close-reason" placeholder="Why (required)" style="max-width:300px"> <button type="button" class="btn btn-mini" data-ef="close" ${busy}>Close without refund</button></details>`;

    const hist = S.history && S.history.id === r.id ? S.history.events : null;
    const histBody = hist ? (hist.length ? hist.map(e => `<div class="name-sub">${esc(String(e.at || '').replace('T', ' ').slice(0, 16))} · <b>${esc(String(e.action).replace(/_/g, ' '))}</b> · ${esc(String(e.actor || '').replace(/^staff:/, ''))}${e.detail && (e.detail.reason || e.detail.to) ? ' · ' + esc(e.detail.reason || e.detail.to) : ''}${e.detail && e.detail.refund_cents != null ? ' · refund ' + money(e.detail.refund_cents) : ''}</div>`).join('') : '<div class="name-sub">No history.</div>')
      : `<button type="button" class="hb-link" data-ef="history" ${busy}>Show history</button>`;

    $('ef-dd-body').innerHTML = `
      ${r.roster_note ? `<div class="name-sub" style="color:#9a6b12;margin-bottom:6px">⚠ ${esc(r.roster_note)}</div>` : ''}
      <div class="name-sub">${esc(r.student_email || 'no email')}${r.ef_student_id ? ' · EF id ' + esc(r.ef_student_id) : ''} · from ${esc(r.source === 'roster' ? 'roster upload' : 'Arrivals')}</div>
      ${sheetBox(r)}
      ${step(1, 'Original Stripe damage deposit', r.match_state === 'matched', pay)}
      ${step(2, 'Move-out confirmed', moved, movedBody)}
      ${step(3, 'Cleaning & condition reports (Limpio)', r.has_report, repBody)}
      ${step(4, 'Review: approve or cancel', approved || settled || !!open, revBody)}
      ${step(5, 'Final authorization (Denisse)', r.stage === 'refunded' || !!open, authBody)}
      ${step(6, 'Refund & receipt', r.stage === 'refunded' && r.receipt_state === 'sent', refBody)}
      <div style="margin-top:6px">${histBody}</div>
      <div style="margin-top:8px"><textarea class="input" data-ef="notes" rows="2" placeholder="Notes" style="width:100%">${esc(r.notes || '')}</textarea>
      <button type="button" class="hb-link" data-ef="note" ${busy}>Save notes</button></div>`;
  }
  function sheetBox(r){
    const x = r.sheet; if (!x) return '';
    const TP = { same: 'its Typeform payment is the one linked here', linked: 'its Typeform token linked the payment', other_stay: 'its Typeform payment is linked to this student\'s other stay',
      not_in_stripe: 'its Typeform token was not found in Stripe', kept_staff_link: 'its Typeform token names another payment — the hand-linked one was kept', locked: 'its Typeform token was not applied (already refunded/closed)' };
    return `<div style="border:1px solid ${r.sheet_flag ? '#e5c07b' : 'var(--line)'};background:${r.sheet_flag ? '#fff9ec' : 'transparent'};border-radius:10px;padding:10px 12px;margin:10px 0">
      <div style="font-weight:600">Team sheet · ${esc(x.tab)} row ${esc(String(x.row))}</div>
      <div><b>${esc(x.status || 'no status')}</b> · move-out ${esc(short(x.move_out))}${x.unit ? ' · ' + esc(x.unit) : ''}${x.paid ? ' · deposit paid: ' + esc(x.paid) : ''}
        · deposit ${money(x.deposit_cents)} · deductions ${money(x.deduction_cents)} · refund ${money(x.refund_cents)}</div>
      ${x.comments ? `<div class="name-sub">${esc(x.comments)}</div>` : ''}
      ${x.token_payment && TP[x.token_payment] ? `<div class="name-sub">Sheet line ${esc(TP[x.token_payment])}.</div>` : ''}
      ${x.link ? `<a href="${esc(x.link)}" target="_blank" rel="noopener" class="name-sub">Open the file in Drive</a>` : ''}
      ${r.sheet_flag ? `<div style="color:#9a6b12;margin-top:4px">⚠ ${esc(r.sheet_flag.text)}</div>` : ''}
      <div class="name-sub">Imported ${esc(String(x.imported_at || '').slice(0, 10))} from ${esc(x.file || 'the sheet')}.</div></div>`;
  }
  // Penalty List charges the Limpio reports point to — suggestions only, the reviewer adds or ignores each
  function sugHtml(r, have){
    const sug = (r.suggested_charges || []).filter(x => !have.some(d => d.code === x.code));
    if (!sug.length) return '';
    return `<div style="border:1px dashed #d9b766;border-radius:8px;padding:8px;margin:6px 0;background:rgba(217,183,102,.08)">
      <div class="name-sub" style="margin-bottom:4px"><b>Suggested from the cleaning reports</b> (Penalty List) — check the photos, then add or ignore.</div>
      ${sug.map(x => `<div data-ef-sug="${esc(x.code)}" style="display:flex;gap:8px;align-items:flex-start;padding:4px 0;border-top:1px solid var(--line)">
        <div style="flex:1"><b>${esc(x.label)}</b> · ${priceOf(x)}${x.note ? ` <span class="name-sub">(${esc(x.note)})</span>` : ''}
          <div class="name-sub">${esc(x.reason)}${(x.photos || []).map((u, k) => ` <a href="${esc(u)}" target="_blank" rel="noopener">photo ${k + 1}</a>`).join('')}</div>
          ${x.scope === 'unit' ? '<div class="name-sub" style="color:#9a6b12">Found on the apartment, not this bed — may be a roommate\'s.</div>' : ''}</div>
        <button type="button" class="btn btn-mini" data-ef="sug-add" data-code="${esc(x.code)}">Add</button></div>`).join('')}</div>`;
  }
  const dedRow = (x, i) => `<div data-ef-ded="${i}" data-code="${esc(x.code || '')}" data-task="${esc(x.task_id || '')}" style="display:flex;gap:6px;margin:4px 0"><input class="input" data-ef-ded-amt placeholder="$" value="${x.cents ? (x.cents / 100).toFixed(2) : ''}" style="max-width:90px" inputmode="decimal"><input class="input" data-ef-ded-why placeholder="What for (required)" value="${esc(x.reason || '')}" style="flex:1"><button type="button" class="hb-link" data-ef="ded-del">✕</button></div>`;
  function readDeductions(){
    const out = [];
    for (const el of document.querySelectorAll('#ef-ded-list [data-ef-ded]')) {
      const amt = el.querySelector('[data-ef-ded-amt]').value.replace(/[$,\s]/g, ''), why = el.querySelector('[data-ef-ded-why]').value.trim();
      if (!amt && !why) continue;
      const cents = Math.round(Number(amt) * 100);
      if (!(cents > 0)) throw new Error('each deduction needs an amount');
      if (why.length < 3) throw new Error('each deduction needs an explanation');
      const code = el.dataset.code, task = el.dataset.task;
      out.push(Object.assign({ cents, reason: why }, code ? { code } : {}, task ? { task_id: task } : {}));
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
    else if (action === 'authorize') showToast(res.data.status === 'succeeded' ? 'Refunded — receipt sent to the student' : 'Authorized — Stripe is processing (' + res.data.status + ')');
    else if (action === 'approve') showToast((S.data.me || {}).can_authorize ? 'Approved — now authorize it (step 5)' : 'Approved — sent to Denisse');
    else showToast('Saved');
    if (res.data && ['AMOUNT_MISMATCH', 'STALE', 'CHANGED_IN_STRIPE', 'WRONG_STAGE', 'NOT_APPROVED', 'ALREADY_APPROVED'].includes(res.data.code)) { await load(); return; }
    render();
  }

  function onInput(e){
    const k = e.target.dataset.efF;
    if (k) { S.f[k] = e.target.value; render(); if (k === 'q') { const i = document.querySelector('[data-ef-f="q"]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } } return; }
    if (e.target.closest && e.target.closest('#ef-ded-list, [data-ef="waive"]') && $('ef-bk') && S.bk) {
      let dmg = 0; for (const el of document.querySelectorAll('#ef-ded-list [data-ef-ded-amt]')) dmg += Math.round((Number(el.value.replace(/[$,\s]/g, '')) || 0) * 100);
      const fee = (document.querySelector('#ef-dd-body [data-ef="waive"]') || {}).checked ? 0 : S.bk.fee;
      const cells = $('ef-bk').querySelectorAll('td.right');
      if (cells.length === 4) { cells[1].textContent = '−' + money(fee); cells[2].textContent = '−' + money(dmg); cells[3].innerHTML = '<b>' + money(Math.max(0, S.bk.avail - fee - dmg)) + '</b>'; }
    }
    if (e.target.dataset.ef === 'waive') { const w = document.querySelector('#ef-dd-body [data-ef="waive-reason"]'); if (w) w.style.display = e.target.checked ? '' : 'none'; }
    if (e.target.dataset.ef === 'file' && e.target.files && e.target.files[0]) { readFile(e.target.files[0]); e.target.value = ''; }
    if (e.target.dataset.ef === 'sheetfile' && e.target.files && e.target.files[0]) { readSheetFile(e.target.files[0]); e.target.value = ''; }
  }
  async function onClick(e){
    if (e.target.closest('[data-ef-stop]') || (e.target.closest('a') && e.target.closest('#ef-dd, #ef-dd-backdrop'))) return;
    const mb = e.target.closest('[data-ef-month]');
    if (mb) { S.month = mb.dataset.efMonth; try { sessionStorage.setItem('ef-dd-month', S.month); } catch (_) {} return render(); }
    const pb = e.target.closest('[data-ef-pdf]');
    if (pb) { e.stopPropagation(); return openReportPdf(pb.dataset.efPdf, pb, pb.dataset.kind); }
    const vb = e.target.closest('[data-ef-view]');
    if (vb) { S.view = vb.dataset.efView; S.viewChosen = true; return render(); }
    const openRow = e.target.closest('[data-ef-open]');
    const b = e.target.closest('[data-ef]');
    if (!b && openRow) { openModal(openRow.dataset.efOpen); return; }
    if (!b) return;
    const a = b.dataset.ef;
    if (a === 'file' || a === 'sheetfile') return;
    if (a === 'sheet-cancel') { S.sheet = null; return render(); }
    if (a === 'sheet-save') return saveSheet();
    if (a === 'reload') return load();
    if (a === 'settings-open') { S.settings = Object.assign({}, S.data.settings || {}); return render(); }
    if (a === 'settings-close') { S.settings = null; return render(); }
    if (a === 'set-fee-add') { $('ef-set-fees').insertAdjacentHTML('beforeend', feeRow('', null)); return; }
    if (a === 'set-pen-add') { $('ef-set-pens').insertAdjacentHTML('beforeend', penRow({})); return; }
    if (a === 'set-pen-del') { b.closest('[data-ef-pen]').remove(); return; }
    if (a === 'set-fee-del') { b.closest('[data-ef-fee]').remove(); return; }
    if (a === 'settings-save') {
      let body; try { body = readSettings(); } catch (err) { return showToast(err.message); }
      S.busy = true; render();
      const res = await api('POST', '/settings', body);
      S.busy = false;
      if (!res.ok) { showToast('Could not save: ' + errText(res)); return render(); }
      showToast('Settings saved'); S.settings = null; return load();
    }
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
    if (a === 'ded-sheet') { const list = $('ef-ded-list'); list.insertAdjacentHTML('beforeend', dedRow({ cents: r.sheet.deduction_cents, reason: r.sheet.comments || 'Per the team sheet' }, list.children.length)); b.parentElement.remove(); return; }
    if (a === 'sug-add') {
      const x = (r.suggested_charges || []).find(s => s.code === b.dataset.code); if (!x) return;
      const list = $('ef-ded-list');
      list.insertAdjacentHTML('beforeend', dedRow({ cents: x.cents, reason: `${x.label} — ${x.reason.replace(/^[^:]*:\s*/, '')}`.slice(0, 290), code: x.code, task_id: x.task_id }, list.children.length));
      const box = b.closest('[data-ef-sug]'); const wrap = box.parentElement; box.remove(); if (!wrap.querySelector('[data-ef-sug]')) wrap.remove();
      if (!x.cents) { const inp = list.lastElementChild.querySelector('[data-ef-ded-amt]'); if (inp) inp.focus(); showToast('Type the amount (current market price)'); }
      return;
    }
    if (a === 'ded-del') { b.closest('[data-ef-ded]').remove(); return; }
    if (a === 'approve') {
      let ded; try { ded = readDeductions(); } catch (err) { return showToast(err.message); }
      const v = sel => ((document.querySelector('#ef-dd-body ' + sel) || {}).value || '').trim();
      const waive = (document.querySelector('#ef-dd-body [data-ef="waive"]') || {}).checked;
      if (waive && v('[data-ef="waive-reason"]').length < 5) return showToast('Say why the cleaning fee is waived');
      if (!r.has_report && v('[data-ef="no-report"]').length < 5) return showToast('No cleaning report: say why it can be approved anyway');
      return act('approve', { deductions: ded, notes: v('[data-ef="insp-notes"]'), no_report_reason: r.has_report ? '' : v('[data-ef="no-report"]'), waive_cleaning_reason: waive ? v('[data-ef="waive-reason"]') : '', revise: !!r._editing });
    }
    if (a === 'cancel' || a === 'reject') { const why = (b.parentElement.querySelector(`[data-ef="${a}-reason"]`) || {}).value || ''; if (why.trim().length < 3) return showToast('Say why'); return act(a, { reason: why.trim() }); }
    if (a === 'reports') return act('reports');
    if (a === 'history') { S.busy = true; renderModal(); const res = await api('POST', `/${r.id}/history`, {}); S.busy = false; S.history = { id: r.id, events: res.ok ? res.data.events || [] : [] }; if (!res.ok) showToast(errText(res)); return renderModal(); }
    if (a === 'receipt') return act('receipt', { email: ((document.querySelector('#ef-dd-body [data-ef="receipt-email"]') || {}).value || '').trim() });
    if (a === 'review-edit') { S.data.rows = S.data.rows.map(x => x.id === r.id ? Object.assign({}, x, { review_state: '', stage: 'moved_out', _editing: true }) : x); return renderModal(); }
    if (a === 'note') return act('note', { notes: (document.querySelector('#ef-dd-body [data-ef="notes"]') || {}).value || '' });
    if (a === 'refund-ask') { S.confirm = true; return renderModal(); }
    if (a === 'refund-no') { S.confirm = false; return renderModal(); }
    if (a === 'refund-go') return act('authorize', { amount_cents: r.refund_due_cents, expected_refunded_cents: r.refunded_cents });
    if (a === 'close' && b.closest('#ef-dd-body')) { const why = (b.parentElement.querySelector('[data-ef="close-reason"]') || {}).value || ''; if (why.trim().length < 3) return showToast('Say why no refund is sent'); return act('close', { reason: why.trim() }); }
  }

  /** The Limpio cleaning report PDF (made by Limpio's own generator via the partner app). */
  async function openReportPdf(id, btn, kind){
    let win = null; try { win = window.open('', '_blank'); if (win) win.document.write('<p style="font:14px sans-serif;padding:20px">Making the report…</p>'); } catch (_) { win = null; }
    if (btn) btn.disabled = true;
    const res = await api('POST', `/${id}/report_pdf`, kind ? { kind } : {});
    if (btn) btn.disabled = false;
    if (!res.ok || !res.data.pdf_base64) { if (win) win.close(); return showToast('Could not make the report: ' + errText(res)); }
    const bin = atob(String(res.data.pdf_base64).replace(/\s/g, '')), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    if (win) win.location.href = url;
    else { const a = document.createElement('a'); a.href = url; a.download = res.data.filename || 'cleaning-report.pdf'; document.body.appendChild(a); a.click(); a.remove(); }
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }

  /** Called by goToView('deposits'). */
  window.efDdShow = function(){ if (!ensureShell()) return; setTab(S.tab); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.open) closeModal(); });
})();
