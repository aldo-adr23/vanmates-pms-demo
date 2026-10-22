/* Customer retention (portal → Tenants → Customer retention). Spec: docs/superpowers/specs/2026-10-21-retention-design.md.
   Reads retention_cases / _tasks / _activities / _triggers / _settings through RLS (retention-2026-10-21.sql); every write
   is a retention_* RPC (assign, transition, log_activity, update, task, create, offer_extension, link) with an optimistic
   version check. Cases open by themselves (checkout trigger + hourly lease scan); Retained is set only by the database
   when the linked extension completes or the linked room change is synced (or by hand with evidence it checks).
   Offer extension drafts an extension request that the usual Extensions → "Accept & send contract" (Hugo) sends.
   No tenant emails are sent from here. Loaded by index.html after the main script (uses esc, showToast, goToView,
   CURRENT_USER, teamMembers, tenants, window.vmDb.sb, window.openExtension / openRoomChange and the shared detail panel). */
(function(){
  const STAGES = ['new', 'needs_contact', 'contacted', 'in_discussion', 'offer_sent', 'processing', 'retained', 'lost', 'closed_other'];
  const CLOSED = ['retained', 'lost', 'closed_other'];
  const STAGE_LABEL = { new: 'New', needs_contact: 'Needs contact', contacted: 'Contacted', in_discussion: 'In discussion', offer_sent: 'Offer sent',
    processing: 'Accepted / processing', retained: 'Retained', lost: 'Lost', closed_other: 'Closed — other' };
  const TRIGGER_LABEL = { checkout: 'Checkout form', lease_end: 'Lease ending', manual: 'Staff referral' };
  const REASONS = { price: 'Price', location: 'Location', roommates: 'Roommates', maintenance: 'Maintenance', cleanliness: 'Cleanliness',
    service: 'Service', moving_city: 'Moving city / country', personal: 'Personal', other: 'Other' };
  const LOST = { declined: 'Declined the offer', no_response: 'No response', no_suitable_room: 'No suitable room', price: 'Price',
    moving_away: 'Moving away', checkout_completed: 'Checkout completed', moved_out: 'Moved out', other: 'Other' };
  const CLOSED_OTHER = { duplicate: 'Duplicate', error: 'Error', ineligible: 'Ineligible', withdrawn: 'Withdrawn', test: 'Test' };
  const RETAINED = { extended: 'Extended lease', room_change: 'Room change', notice_withdrawn: 'Withdrew checkout notice',
    extended_elsewhere: 'Lease extended elsewhere' };
  const FLAG = { check_lease_type: ['Check lease type', 'blue'], opted_out: ['Opted out', 'red'], exception: ['Sync exception', 'red'], test: ['Test', ''] };
  const SCORE_LABEL = { checkout: 'Checkout submitted', moveout_14: 'Move-out within 14 days', lease_30: 'Lease ends within 30 days',
    lease_60: 'Lease ends within 60 days', sla_missed: 'No contact after SLA', resolvable: 'Resolvable concern' };
  const TABS = [['mine', 'My cases'], ['unassigned', 'New / unassigned'], ['due', 'Due today'], ['overdue', 'Overdue'], ['checkout', 'Checkout requests'],
    ['expiring', 'Expiring leases'], ['offers', 'Offers pending'], ['completed', 'Completed'], ['all', 'All open'], ['reports', 'Reports']];
  const COLS = 10;
  const ROOM_SWAP_URL = 'https://vanmates.com/room-swap';
  const DAY = 86400000;

  // ── pure helpers (window.RET_CORE, tested in test/retention.test.js) ──
  const isClosed = (s) => CLOSED.includes(s);
  const prio = (c) => (c.priority_override != null ? Number(c.priority_override) : Number(c.priority || 0));
  const ymd = (d) => new Date(d).toISOString().slice(0, 10);
  const daysUntil = (dateStr, now) => { if (!dateStr) return null; const d = Date.parse(String(dateStr).slice(0, 10) + 'T12:00:00Z'); return isNaN(d) ? null : Math.round((d - now) / DAY); };
  function inTab(c, tab, ctx){
    const now = ctx.now, open = !isClosed(c.stage), tasks = ctx.tasksByCase[c.id] || [];
    switch (tab) {
      case 'mine': return open && !!ctx.me && c.owner === ctx.me;
      case 'unassigned': return open && (!c.owner || c.stage === 'new');
      case 'due': return open && tasks.some(t => Date.parse(t.due_at) <= endOfDay(now));
      case 'overdue': return open && tasks.some(t => Date.parse(t.due_at) < now);
      case 'checkout': return open && !!c.checkout_id;
      case 'expiring': { const d = daysUntil(c.lease_end, now); return open && c.primary_trigger === 'lease_end' && d != null && d <= 60; }
      case 'offers': return ['offer_sent', 'processing'].includes(c.stage);
      case 'completed': return !open;
      case 'all': return open;
      default: return false;
    }
  }
  function endOfDay(now){ const d = new Date(now); d.setHours(23, 59, 59, 999); return d.getTime(); }
  // Allowed manual moves (the server enforces the same; Processing / Retained-by-evidence are the database's).
  function movesFor(stage, isManager){
    if (isClosed(stage)) return isManager ? ['needs_contact', 'in_discussion'] : [];
    const base = { new: ['contacted', 'in_discussion'], needs_contact: ['contacted', 'in_discussion'], contacted: ['needs_contact', 'in_discussion', 'offer_sent'],
      in_discussion: ['contacted', 'offer_sent'], offer_sent: ['in_discussion'], processing: ['in_discussion'] }[stage] || [];
    return base.concat(['retained', 'lost', 'closed_other']);
  }
  // Month ends after `from` (exclusive), up to 12 months on (extensions are monthly, max 12 months).
  function monthEnds(from, n){
    const f = new Date(String(from).slice(0, 10) + 'T12:00:00Z'); if (isNaN(f)) return [];
    const out = [];
    for (let i = 0; out.length < (n || 12) && i < 14; i++) {
      const d = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1 + i, 0));
      if (d > f) out.push(ymd(d));
    }
    const max = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 12, f.getUTCDate()));
    return out.filter(x => Date.parse(x + 'T12:00:00Z') <= max.getTime() + DAY).slice(0, n || 12);
  }
  function addBusinessDays(ts, n){ let d = new Date(ts), k = 0; while (k < n) { d = new Date(d.getTime() + DAY); const w = d.getUTCDay(); if (w !== 0 && w !== 6) k++; } return d.getTime(); }
  const median = (xs) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  // KPIs (spec §12). One outcome per case; test cases out unless asked; money split by currency, never summed across.
  function kpis(cases, tasks, opts){
    const o = opts || {}, now = o.now || Date.now(), sla = o.slaBd == null ? 1 : o.slaBd;
    const list = cases.filter(c => o.includeTest || !(c.flags || []).includes('test'));
    const open = list.filter(c => !isClosed(c.stage));
    const ids = new Set(list.map(c => c.id));
    const openTasks = tasks.filter(t => t.status === 'open' && ids.has(t.case_id));
    const retained = list.filter(c => c.stage === 'retained'), lost = list.filter(c => c.stage === 'lost');
    const rent = {};
    retained.forEach(c => { const cur = c.currency || 'CAD'; rent[cur] = (rent[cur] || 0) + Number(c.retained_rent != null ? c.retained_rent : c.rent || 0); });
    const offered = list.filter(c => isClosed(c.stage) && c.stage !== 'closed_other' && (c.extension_id || c.room_change_id));
    const slaBase = list.filter(c => c.stage !== 'closed_other' && (c.first_contact_at || now > addBusinessDays(Date.parse(c.created_at), sla)));
    const slaMet = slaBase.filter(c => c.first_contact_at && Date.parse(c.first_contact_at) <= addBusinessDays(Date.parse(c.created_at), sla));
    const res = list.filter(c => ['retained', 'lost'].includes(c.stage) && c.closed_at).map(c => (Date.parse(c.closed_at) - Date.parse(c.created_at)) / DAY);
    const reasons = {};
    list.filter(c => c.stage !== 'closed_other').forEach(c => { const k = c.primary_reason || 'unknown'; reasons[k] = (reasons[k] || 0) + 1; });
    const exp = (n) => open.filter(c => { const d = daysUntil(c.lease_end, now); return c.lease_type !== 'month_to_month' && d != null && d >= 0 && d <= n; }).length;
    return {
      open: open.length,
      newCheckouts: list.filter(c => c.checkout_id && now - Date.parse(c.created_at) <= 7 * DAY).length,
      expiring60: exp(60), expiring30: exp(30),
      overdue: openTasks.filter(t => Date.parse(t.due_at) < now).length,
      pendingOffers: open.filter(c => ['offer_sent', 'processing'].includes(c.stage)).length,
      retained: retained.length, lost: lost.length,
      retentionRate: retained.length + lost.length ? retained.length / (retained.length + lost.length) : null,
      retainedRent: rent,
      offerAcceptance: offered.length ? offered.filter(c => c.stage === 'retained' && ['extended', 'room_change'].includes(c.outcome)).length / offered.length : null,
      responseSla: slaBase.length ? slaMet.length / slaBase.length : null,
      medianDaysToResolve: median(res),
      reasons,
    };
  }
  function sortCases(list, ctx){
    const next = (c) => { const t = (ctx.tasksByCase[c.id] || [])[0]; return t ? Date.parse(t.due_at) : Infinity; };
    return list.slice().sort((a, b) => prio(b) - prio(a) || next(a) - next(b) || String(a.created_at).localeCompare(String(b.created_at)));
  }
  function csv(rows){
    const cols = ['id', 'country', 'name', 'email', 'house', 'room', 'city', 'currency', 'rent', 'lease_type', 'lease_end', 'move_out_date', 'primary_trigger',
      'stage', 'outcome', 'priority', 'owner', 'primary_reason', 'retained_rent', 'created_at', 'first_contact_at', 'closed_at'];
    const q = (v) => { const s = Array.isArray(v) ? v.join('; ') : String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return [cols.join(',')].concat(rows.map(r => cols.map(k => q(k === 'priority' ? prio(r) : r[k])).join(','))).join('\n');
  }
  window.RET_CORE = { STAGES, CLOSED, STAGE_LABEL, isClosed, prio, inTab, movesFor, monthEnds, kpis, sortCases, csv, addBusinessDays, daysUntil };

  // ── page ──
  const S = { tab: 'all', q: '', country: '', city: '', trigger: '', stage: '', owner: '', reason: '', showTest: false };
  let cases = null, tasks = [], settings = null, isManager = false, loading = null, openSeq = 0;
  const e = (s) => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const toast = (m) => { if (typeof showToast === 'function') showToast(m); };
  const me = () => { const u = (typeof CURRENT_USER !== 'undefined' && CURRENT_USER) || {}; return { email: String(u.email || '').toLowerCase(), role: String(u.role || '') }; };
  const team = () => (typeof teamMembers !== 'undefined' ? teamMembers : []);
  const nameOf = (email) => { const x = String(email || '').toLowerCase(); if (!x) return ''; const m = team().find(t => String(t.email || '').toLowerCase() === x); return m ? (m.name || m.email) : x.split('@')[0]; };
  const money = (n, cur) => (n == null || n === '' || !isFinite(Number(n)) ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-CA') + (cur && cur !== 'CAD' ? ' ' + cur : ''));
  const day = (d) => { if (!d) return '—'; const x = new Date(String(d).slice(0, 10) + 'T12:00:00Z'); return isNaN(x) ? String(d) : x.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); };
  const when = (ts) => { if (!ts) return '—'; const d = new Date(ts); return isNaN(d) ? String(ts) : d.toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }); };
  const sb = () => window.vmDb && window.vmDb.sb;
  const pill = (txt, cls) => `<span class="tag-pill ${cls || ''}" style="font-size:11px;margin:1px">${e(txt)}</span>`;
  const stagePill = (s) => pill(STAGE_LABEL[s] || s, s === 'retained' ? 'green' : s === 'lost' ? 'red' : ['new', 'needs_contact'].includes(s) ? 'red' : isClosed(s) ? '' : 'blue');
  const flagPills = (c) => (c.flags || []).map(f => { const [l, k] = FLAG[f] || [f, 'blue']; return pill(l, k); }).join(' ');
  const prioPill = (c) => { const p = prio(c); return pill(String(p), p >= 60 ? 'red' : p >= 30 ? 'blue' : ''); };
  const ctx = () => {
    const by = {};
    tasks.filter(t => t.status === 'open').sort((a, b) => String(a.due_at).localeCompare(String(b.due_at))).forEach(t => { (by[t.case_id] = by[t.case_id] || []).push(t); });
    return { now: Date.now(), me: me().email, tasksByCase: by };
  };
  const ERR = { version_conflict: 'Someone else changed this case. It reloaded; check and try again.', manager_only: 'Only a retention manager can do that.',
    forbidden: 'You do not have Customer retention access.', not_found: 'Case not found (or not in your country).', retained_needs_evidence: 'Retained is set automatically when the extension completes or the room change is synced. By hand only with evidence: checkout withdrawn or lease already extended.',
    checkout_not_cancelled: 'The linked checkout is not cancelled yet: cancel it in Checkouts first.', lease_not_extended: 'The tenant profile does not show a later lease end yet.',
    outcome_required: 'Pick an outcome.', note_required: 'Add a note.', reason_required: 'Add a reason.', system_only: 'That stage is set by the system.',
    month_end_only: 'Extensions end on the last day of a month.', new_end_after_current: 'The new end must be after the current lease end.', max_12_months: 'At most 12 months past the current end.',
    opted_out: 'The tenant opted out of retention contact.', no_tenant: 'No tenant profile is linked to this case.', no_lease_end: 'The tenant profile has no lease end.',
    open_case_exists: 'This tenant already has another open case.', closed: 'This case is closed.', bad_transition: 'That move is not allowed from this stage.',
    tenant_not_found: 'Tenant not found (or not in your country).', tenant_has_no_email: 'That tenant has no email on file.' };
  const why = (data, error) => (error ? (error.message || String(error)) : (ERR[data && data.error] || (data && data.error) || 'unknown error'));

  async function load(force){
    if (loading) return loading;
    if (cases && !force) { render(); return; }
    const body = document.getElementById('ret-body');
    if (!sb()) { if (body) body.innerHTML = `<tr><td colspan="${COLS}" class="name-sub">Not connected to the database.</td></tr>`; return; }
    if (body && !cases) body.innerHTML = `<tr><td colspan="${COLS}" class="name-sub">Loading…</td></tr>`;
    loading = (async () => {
      try {
        const [c, t, s, m] = await Promise.all([
          sb().from('retention_cases').select('*').order('created_at', { ascending: false }).limit(5000),
          sb().from('retention_tasks').select('id,case_id,type,title,owner,due_at,status,escalated_at,completed_at').eq('status', 'open').limit(5000),
          sb().from('retention_settings').select('*').eq('id', 1).maybeSingle(),
          sb().rpc('vm_retention_manager'),
        ]);
        if (c.error) throw c.error;
        cases = c.data || [];
        tasks = t.data || [];
        settings = s.data || null;
        isManager = m.data === true;
        filters();
        render();
      } catch (err) {
        console.error('[retention] load failed', err);
        const missing = /retention_cases/.test(String(err && err.message)) && /exist|schema cache/i.test(String(err && err.message));
        if (body) body.innerHTML = `<tr><td colspan="${COLS}" class="name-sub">${missing ? 'Customer retention is not set up in the database yet (run retention-2026-10-21.sql).' : 'Could not load cases: ' + e(err.message || err)}</td></tr>`;
      } finally { loading = null; }
    })();
    return loading;
  }

  function filters(){
    const opt = (v, l, sel) => `<option value="${e(v)}" ${v === sel ? 'selected' : ''}>${e(l)}</option>`;
    const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    const owners = new Set(team().map(t => String(t.email || '').toLowerCase()).filter(Boolean)); (cases || []).forEach(c => c.owner && owners.add(c.owner));
    set('ret-f-owner', opt('', 'All owners', S.owner) + opt('none', 'Unassigned', S.owner) + opt('me', 'Mine', S.owner) +
      [...owners].sort((a, b) => nameOf(a).localeCompare(nameOf(b))).map(x => opt(x, nameOf(x), S.owner)).join(''));
    const cities = [...new Set((cases || []).map(c => c.city).filter(Boolean))].sort();
    set('ret-f-city', opt('', 'All cities', S.city) + cities.map(x => opt(x, x, S.city)).join(''));
    const countries = [...new Set((cases || []).map(c => c.country))];
    const cEl = document.getElementById('ret-f-country'); if (cEl) cEl.style.display = countries.length > 1 ? '' : 'none';
    set('ret-f-country', opt('', 'Canada + Mexico', S.country) + opt('CA', 'Canada', S.country) + opt('MX', 'Mexico', S.country));
    set('ret-f-trigger', opt('', 'All triggers', S.trigger) + Object.entries(TRIGGER_LABEL).map(([k, l]) => opt(k, l, S.trigger)).join(''));
    set('ret-f-stage', opt('', 'All stages', S.stage) + STAGES.map(k => opt(k, STAGE_LABEL[k], S.stage)).join(''));
    set('ret-f-reason', opt('', 'All reasons', S.reason) + Object.entries(REASONS).map(([k, l]) => opt(k, l, S.reason)).join('') + opt('unknown', 'Not recorded', S.reason));
    const ex = document.getElementById('ret-export'); if (ex) ex.hidden = !isManager;
  }

  function filtered(){
    const q = S.q.trim().toLowerCase(), c0 = ctx(), m = me().email;
    return (cases || []).filter(c => (S.stage ? (S.stage === c.stage) : inTab(c, S.tab, c0))
      && (S.showTest || !(c.flags || []).includes('test'))
      && (!S.country || c.country === S.country) && (!S.city || c.city === S.city) && (!S.trigger || c.primary_trigger === S.trigger)
      && (!S.reason || (S.reason === 'unknown' ? !c.primary_reason : c.primary_reason === S.reason))
      && (!S.owner || (S.owner === 'none' ? !c.owner : S.owner === 'me' ? c.owner === m : c.owner === S.owner))
      && (!q || [c.id, c.name, c.email, c.house, c.room, c.city, c.checkout_id, c.extension_id, c.room_change_id].some(v => String(v || '').toLowerCase().includes(q))));
  }

  function renderKpis(){
    const el = document.getElementById('ret-kpis'); if (!el) return;
    const k = kpis(cases || [], tasks, { slaBd: settings ? settings.contact_sla_bd : 1, includeTest: S.showTest });
    const pct = (x) => (x == null ? '—' : Math.round(100 * x) + '%');
    const rent = Object.entries(k.retainedRent).map(([c, v]) => money(v, c === 'CAD' ? '' : c) + (c === 'CAD' ? ' CAD' : '')).join(' · ') || '—';
    const tile = (label, value, sub, tab) => `<div class="kpi"${tab ? ` data-ret-tab="${tab}" style="cursor:pointer"` : ''}><div class="kpi-deco"></div><div class="kpi-label">${e(label)}</div><div class="kpi-value">${value}</div><div class="kpi-trend up">${sub}</div></div>`;
    el.innerHTML = [
      tile('Open cases', k.open, `${k.newCheckouts} new checkout form${k.newCheckouts === 1 ? '' : 's'} this week`, 'all'),
      tile('Leases expiring', k.expiring30 + '<span style="font-size:18px;color:var(--muted)"> / ' + k.expiring60 + '</span>', 'within 30 / 60 days (open cases)', 'expiring'),
      tile('Overdue actions', k.overdue, `${k.pendingOffers} offer${k.pendingOffers === 1 ? '' : 's'} pending`, 'overdue'),
      tile('Retention rate', pct(k.retentionRate), `${k.retained} retained · ${k.lost} lost · ${rent} / mo kept`, 'completed'),
    ].join('');
  }

  function render(){
    if (!cases) return;
    const c0 = ctx();
    const badge = document.querySelector('.nav-item[data-view="retention"] .nav-count');
    if (badge) badge.textContent = String(cases.filter(c => !isClosed(c.stage) && (!c.owner || c.stage === 'new') && !(c.flags || []).includes('test')).length);
    renderKpis();
    const tabs = document.getElementById('ret-tabs');
    if (tabs) tabs.innerHTML = TABS.map(([k, l]) => {
      const n = k === 'reports' ? '' : ` <span class="name-sub">${cases.filter(c => inTab(c, k, c0) && (S.showTest || !(c.flags || []).includes('test'))).length}</span>`;
      return `<button type="button" class="tab${S.tab === k && !S.stage ? ' active' : ''}" role="tab" data-ret-tab="${k}">${e(l)}${n}</button>`;
    }).join('');
    const rpt = S.tab === 'reports' && !S.stage;
    document.getElementById('ret-filter-bar').style.display = rpt ? 'none' : '';
    document.getElementById('ret-list-card').hidden = rpt;
    document.getElementById('ret-report').hidden = !rpt;
    if (rpt) { renderReport(); return; }
    const list = sortCases(filtered(), c0);
    document.getElementById('ret-count').textContent = list.length;
    document.getElementById('ret-empty').style.display = list.length ? 'none' : '';
    document.getElementById('ret-body').innerHTML = list.map(c => {
      const t = (c0.tasksByCase[c.id] || [])[0], overdue = t && Date.parse(t.due_at) < c0.now;
      const dl = daysUntil(c.lease_end, c0.now);
      return `<tr class="clickable" data-ret-open="${e(c.id)}" tabindex="0" style="cursor:pointer">
        <td><b>${e(c.name || c.email)}</b><div class="name-sub">${e(c.id)} · ${e(c.email)}</div></td>
        <td>${e([c.house, c.room].filter(Boolean).join(' · ') || '—')}<div class="name-sub">${e(c.city || '')}${c.country === 'MX' ? ' · MX' : ''}</div></td>
        <td>${e(money(c.rent, c.currency))}</td>
        <td>${e(day(c.lease_end))}${dl != null && !isClosed(c.stage) ? `<div class="name-sub">${dl < 0 ? Math.abs(dl) + ' d ago' : 'in ' + dl + ' d'} · ${e(c.lease_type === 'unset' ? 'type?' : c.lease_type === 'month_to_month' ? 'monthly' : 'fixed')}</div>` : ''}</td>
        <td>${c.move_out_date ? e(day(c.move_out_date)) : '<span class="name-sub">—</span>'}</td>
        <td>${e(TRIGGER_LABEL[c.primary_trigger] || c.primary_trigger)}${c.checkout_id && c.primary_trigger !== 'checkout' ? '<div class="name-sub">+ checkout</div>' : ''}<div class="name-sub">${e(REASONS[c.primary_reason] || '')}</div></td>
        <td>${stagePill(c.stage)}${c.outcome ? `<div class="name-sub">${e(RETAINED[c.outcome] || LOST[c.outcome] || CLOSED_OTHER[c.outcome] || c.outcome)}</div>` : ''}</td>
        <td>${e(nameOf(c.owner) || 'Unassigned')}</td>
        <td>${prioPill(c)}</td>
        <td>${t ? `<span${overdue ? ' style="color:var(--red,#B94A3F);font-weight:600"' : ''}>${e(t.title)}</span><div class="name-sub">${e(when(t.due_at))}${t.escalated_at ? ' · escalated' : ''}</div>` : '<span class="name-sub">—</span>'} ${flagPills(c)}</td>
      </tr>`;
    }).join('');
  }

  function renderReport(){
    const el = document.getElementById('ret-report-body');
    const k = kpis(cases || [], tasks, { slaBd: settings ? settings.contact_sla_bd : 1, includeTest: S.showTest });
    const pct = (x) => (x == null ? '—' : Math.round(100 * x) + '%');
    const list = (cases || []).filter(c => S.showTest || !(c.flags || []).includes('test'));
    const row = (l, v, n) => `<tr><td>${e(l)}</td><td><b>${v}</b></td><td class="name-sub">${e(n || '')}</td></tr>`;
    const byTrig = {}; list.filter(c => ['retained', 'lost'].includes(c.stage)).forEach(c => { const t = byTrig[c.primary_trigger] = byTrig[c.primary_trigger] || { r: 0, l: 0 }; t[c.stage === 'retained' ? 'r' : 'l']++; });
    const reasons = Object.entries(k.reasons).sort((a, b) => b[1] - a[1]);
    const total = reasons.reduce((s, [, n]) => s + n, 0);
    el.innerHTML = `
      <div class="card" style="margin-bottom:14px"><div class="card-head" style="padding:12px 16px"><div class="card-title">Outcomes <em>(one per case${S.showTest ? ', test cases included' : ', test cases excluded'})</em></div></div>
        <div style="overflow-x:auto"><table><thead><tr><th>Metric</th><th>Value</th><th>Definition</th></tr></thead><tbody>
        ${row('Retention rate', pct(k.retentionRate), `Retained ÷ (retained + lost): ${k.retained} ÷ ${k.retained + k.lost}. Closed — other is excluded.`)}
        ${row('Rent preserved', Object.entries(k.retainedRent).map(([c, v]) => money(v) + ' ' + c).join(' · ') || '—', 'Monthly contracted rent after retention, per currency (never added across CAD/MXN). Rent kept, not new cash.')}
        ${row('Offer acceptance', pct(k.offerAcceptance), 'Closed cases with a linked extension or room change that ended Retained by it.')}
        ${row('Response SLA', pct(k.responseSla), `First contact logged within ${settings ? settings.contact_sla_bd : 1} business day(s) of the case opening.`)}
        ${row('Median days to resolve', k.medianDaysToResolve == null ? '—' : Math.round(k.medianDaysToResolve * 10) / 10, 'Case opened → retained or lost.')}
        </tbody></table></div></div>
      <div class="card" style="margin-bottom:14px"><div class="card-head" style="padding:12px 16px"><div class="card-title">By trigger</div></div>
        <div style="overflow-x:auto"><table><thead><tr><th>Trigger</th><th>Retained</th><th>Lost</th><th>Rate</th></tr></thead><tbody>
        ${Object.entries(byTrig).map(([t, v]) => `<tr><td>${e(TRIGGER_LABEL[t] || t)}</td><td>${v.r}</td><td>${v.l}</td><td>${pct(v.r / (v.r + v.l))}</td></tr>`).join('') || '<tr><td colspan="4" class="name-sub">No resolved cases yet.</td></tr>'}
        </tbody></table></div></div>
      <div class="card"><div class="card-head" style="padding:12px 16px"><div class="card-title">Primary reason <em>(cases with a reason, plus not recorded)</em></div></div>
        <div style="overflow-x:auto"><table><thead><tr><th>Reason</th><th>Cases</th><th>Share</th></tr></thead><tbody>
        ${reasons.map(([r, n]) => `<tr><td>${e(REASONS[r] || (r === 'unknown' ? 'Not recorded' : r))}</td><td>${n}</td><td>${pct(n / total)}</td></tr>`).join('') || '<tr><td colspan="3" class="name-sub">No cases yet.</td></tr>'}
        </tbody></table></div></div>`;
  }

  function openPanel(hero, title, sub, meta){
    document.getElementById('panel-hero').textContent = String(hero || '?').slice(0, 1).toUpperCase();
    document.getElementById('panel-title').innerHTML = e(title);
    document.getElementById('panel-sub').textContent = sub;
    document.getElementById('panel-meta').innerHTML = meta || '';
    document.getElementById('detail-panel').classList.add('open');
    document.getElementById('detail-panel').setAttribute('aria-hidden', 'false');
    document.getElementById('panel-backdrop').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  const h = (t) => `<h4 style="margin:22px 0 6px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)">${e(t)}</h4>`;
  const kv = (label, value) => `<div style="display:flex;gap:12px;padding:6px 0;border-bottom:1px solid var(--line,#eee)"><div class="name-sub" style="flex:0 0 38%">${e(label)}</div><div style="flex:1;min-width:0;overflow-wrap:anywhere">${value}</div></div>`;
  const lbl = (text, inner) => `<label class="name-sub" style="display:grid;gap:4px">${e(text)}${inner}</label>`;

  async function open(id){
    const tok = ++openSeq;
    if (!cases) await load();
    const c = (cases || []).find(x => x.id === id);
    if (!c) { toast('Case not found'); return false; }
    openPanel(c.name || c.email, c.name || c.email, `${c.id} · ${[c.house, c.room].filter(Boolean).join(' · ')}`, stagePill(c.stage) + ' ' + prioPill(c) + ' ' + flagPills(c));
    document.getElementById('panel-body').innerHTML = `<div data-ret-tok="${tok}" class="name-sub" style="padding:18px 0">Loading…</div>`;
    const [acts, trig, allTasks, ex, rc, co] = await Promise.all([
      sb().from('retention_activities').select('*').eq('case_id', id).order('at', { ascending: false }).limit(500),
      sb().from('retention_triggers').select('*').eq('case_id', id).order('occurred_at'),
      sb().from('retention_tasks').select('*').eq('case_id', id).order('due_at'),
      c.extension_id ? sb().from('extension_requests').select('id,status,new_end,current_end,contract_id,new_rent').eq('id', c.extension_id).maybeSingle() : Promise.resolve({}),
      c.room_change_id ? sb().from('room_change_requests').select('id,status,target_name,target_price,move_date,data').eq('id', c.room_change_id).maybeSingle() : Promise.resolve({}),
      c.checkout_id ? sb().from('checkout_cases').select('id,status,outcome,move_out_date,notice_received_at').eq('id', c.checkout_id).maybeSingle() : Promise.resolve({}),
    ]);
    if (tok !== openSeq || !document.querySelector(`#panel-body [data-ret-tok="${tok}"]`)) return false;
    const closed = isClosed(c.stage), mine = c.owner === me().email, optedOut = (c.flags || []).includes('opted_out');
    const openT = (allTasks.data || []).filter(t => t.status === 'open');
    const moves = movesFor(c.stage, isManager);
    const teamOpts = ['<option value="">Unassigned</option>'].concat(team().filter(t => t.email).map(t => `<option value="${e(String(t.email).toLowerCase())}" ${String(t.email).toLowerCase() === c.owner ? 'selected' : ''}>${e(t.name || t.email)}</option>`));
    const ends = monthEnds(c.lease_end, 12);
    const exr = ex && ex.data, rcr = rc && rc.data, cor = co && co.data;
    const sync = rcr && rcr.data && rcr.data.sync;
    const tenantLink = c.tenant_id ? ` · <a href="#" data-ret-tenant="${e(c.tenant_id)}">Tenant profile</a>` : '';
    const body = `<div data-ret-tok="${tok}">
      ${optedOut ? `<div class="tag-pill red" style="display:block;text-transform:none;letter-spacing:0;font-size:13px;padding:10px 12px;margin:6px 0">Opted out: no retention follow-ups or offers.</div>` : ''}
      ${h('Tenant & lease')}
      ${kv('Contact', `${e(c.email)}${tenantLink}`)}
      ${kv('Property · room', e([c.house, c.room].filter(Boolean).join(' · ') || '—') + `<div class="name-sub">${e(c.city || '')} · ${c.country === 'MX' ? 'Mexico' : 'Canada'}</div>`)}
      ${kv('Rent', e(money(c.rent, c.currency)) + ` <span class="name-sub">${e(c.currency)} / month (when the case opened)</span>`)}
      ${kv('Lease', `${e(c.lease_type === 'unset' ? 'Type not set' : c.lease_type === 'month_to_month' ? 'Month-to-month' : 'Fixed term')} · ends ${e(day(c.lease_end))}`)}
      ${c.move_out_date ? kv('Requested move-out', e(day(c.move_out_date))) : ''}
      ${kv('Owner', e(nameOf(c.owner) || 'Unassigned'))}
      ${kv('Priority', `${prio(c)}${c.priority_override != null ? ` <span class="name-sub">(override: ${e(c.override_reason || '')}; computed ${c.priority})</span>` : ''}<div class="name-sub">${(c.score_reasons || []).map(r => e((SCORE_LABEL[r.k] || r.k) + ' +' + r.w)).join(' · ') || 'No score factors'}</div>`)}
      ${kv('Triggers', (trig.data || []).map(t => `${e(t.type.replace(/_/g, ' '))} <span class="name-sub">${e(when(t.occurred_at))}</span>`).join('<br>') || '—')}

      ${h('Departure insights')}
      ${c.reason_text ? `<div style="white-space:pre-wrap;background:var(--cream-2,#f6f1e7);border-radius:8px;padding:10px 12px;margin-bottom:8px">${e(c.reason_text)}</div>` : ''}
      ${closed ? kv('Primary reason', e(REASONS[c.primary_reason] || '—')) : `<form data-ret-reasons="${e(c.id)}" style="display:grid;gap:10px">
        ${lbl('Primary reason', `<select class="form-input" name="primary_reason"><option value="">Not recorded</option>${Object.entries(REASONS).map(([k, l]) => `<option value="${k}" ${k === c.primary_reason ? 'selected' : ''}>${e(l)}</option>`).join('')}</select>`)}
        <div class="name-sub">Other reasons</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px 14px">${Object.entries(REASONS).map(([k, l]) => `<label style="font-size:13px"><input type="checkbox" name="secondary" value="${k}" ${(c.secondary_reasons || []).includes(k) ? 'checked' : ''}/> ${e(l)}</label>`).join('')}</div>
        <div><button class="btn btn-ghost" type="submit">Save reasons</button></div></form>`}

      ${h('Related')}
      ${kv('Checkout', cor ? `${e(cor.id)} · ${e(cor.status)}${cor.outcome ? ' (' + e(cor.outcome) + ')' : ''} · move-out ${e(day(cor.move_out_date))} <span class="name-sub">(never changed from here)</span>` : '—')}
      ${kv('Extension', exr ? `<a href="#" data-ret-ext="${e(exr.id)}">${e(exr.id)}</a> · ${e(exr.status)} · until ${e(day(exr.new_end))}${exr.contract_id ? ' · contract ' + e(exr.contract_id) : ''}${exr.status === 'NEEDS_REVIEW' ? '<div class="name-sub">Open it and press <b>Accept &amp; send contract</b> to send the offer (needs the Extensions page).</div>' : ''}` : '—')}
      ${kv('Room change', rcr ? `<a href="#" data-ret-rc="${e(rcr.id)}">${e(rcr.id)}</a> · ${e(rcr.status)}${rcr.target_name ? ' → ' + e(rcr.target_name) : ''}${sync ? `<div class="name-sub">Sync: ${sync.done ? 'done' : 'pending' + ((sync.errors || []).length ? ' · errors: ' + e((sync.errors || []).join(', ')) : '')}</div>` : ''}` : '—')}

      ${closed ? '' : `${h('Actions')}
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">
        ${!c.owner || (isManager && !mine) ? `<button class="btn btn-ghost" type="button" data-ret-claim="${e(c.id)}">Assign to me</button>` : ''}
        <button class="btn btn-ghost" type="button" data-ret-copy-swap>Copy room-swap link</button>
        <button class="btn btn-ghost" type="button" data-ret-optout="${optedOut ? 'off' : 'on'}">${optedOut ? 'Undo opt-out' : 'Tenant opted out'}</button>
      </div>
      ${isManager ? `<form data-ret-assign="${e(c.id)}" style="display:flex;gap:8px;align-items:end;margin-bottom:12px">${lbl('Owner', `<select class="form-input" name="owner">${teamOpts.join('')}</select>`)}<button class="btn btn-ghost" type="submit">Assign</button></form>` : ''}
      <form data-ret-log="${e(c.id)}" style="display:grid;gap:8px;margin-bottom:14px">
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <select class="form-input" name="type" style="max-width:150px"><option value="call">Call</option><option value="email">Email</option><option value="message">WhatsApp / text</option><option value="note">Note</option></select>
          <label style="font-size:13px;align-self:center"><input type="checkbox" name="reached"/> Reached the tenant (they replied)</label>
        </div>
        <textarea class="form-input" name="body" rows="2" maxlength="4000" placeholder="What happened? Logged on the timeline." required></textarea>
        <div><button class="btn btn-primary" type="submit">Log</button></div>
      </form>
      ${!optedOut && c.stage !== 'processing' && !(exr && ['NEEDS_REVIEW', 'SENT'].includes(exr.status)) ? `<form data-ret-offer="${e(c.id)}" style="display:grid;gap:8px;margin-bottom:14px;padding:10px 12px;border:1px solid var(--line,#eee);border-radius:10px">
        <b style="font-size:13px">Offer an extension</b>
        ${c.tenant_id && ends.length ? `${lbl('New end (month end)', `<select class="form-input" name="new_end">${ends.map(x => `<option value="${x}">${e(day(x))}</option>`).join('')}</select>`)}
        ${lbl('Note for the Extensions reviewer (optional)', `<input class="form-input" name="note" maxlength="2000"/>`)}
        <div class="name-sub">Drafts an extension request. Rent is set when you Accept it in Extensions (Hugo sends the contract; Retained is set when it is signed, countersigned and applied).</div>
        <div><button class="btn btn-ghost" type="submit">Draft extension</button></div>` : '<span class="name-sub">Needs a linked tenant profile with a lease end.</span>'}
      </form>` : ''}
      <form data-ret-move="${e(c.id)}" style="display:grid;gap:8px;margin-bottom:6px">
        ${lbl('Move to', `<select class="form-input" name="stage">${moves.map(s => `<option value="${s}">${e(STAGE_LABEL[s])}</option>`).join('')}</select>`)}
        ${lbl('Outcome (for Retained / Lost / Closed)', `<select class="form-input" name="outcome"><option value="">—</option>
          <optgroup label="Retained (with evidence)">${['notice_withdrawn', 'extended_elsewhere'].map(k => `<option value="${k}">${e(RETAINED[k])}</option>`).join('')}</optgroup>
          <optgroup label="Lost">${Object.entries(LOST).map(([k, l]) => `<option value="${k}">${e(l)}</option>`).join('')}</optgroup>
          <optgroup label="Closed — other">${Object.entries(CLOSED_OTHER).map(([k, l]) => `<option value="${k}">${e(l)}</option>`).join('')}</optgroup></select>`)}
        ${lbl('Note', `<input class="form-input" name="note" maxlength="2000"/>`)}
        <div><button class="btn btn-ghost" type="submit">Move</button></div>
      </form>`}
      ${closed && isManager ? `${h('Reopen')}<form data-ret-move="${e(c.id)}" style="display:grid;gap:8px">
        ${lbl('Reopen to', `<select class="form-input" name="stage">${moves.map(s => `<option value="${s}">${e(STAGE_LABEL[s])}</option>`).join('')}</select>`)}
        ${lbl('Reason (required)', `<input class="form-input" name="note" maxlength="2000" required/>`)}<div><button class="btn btn-ghost" type="submit">Reopen</button></div></form>` : ''}
      ${closed ? kv('Outcome', e(RETAINED[c.outcome] || LOST[c.outcome] || CLOSED_OTHER[c.outcome] || c.outcome || '—') + (c.closure_note ? `<div class="name-sub">${e(c.closure_note)}</div>` : '')) : ''}
      ${isManager && !closed ? `<form data-ret-prio="${e(c.id)}" style="display:flex;gap:8px;align-items:end;flex-wrap:wrap;margin-top:10px">
        ${lbl('Priority override', `<input class="form-input" name="priority" type="number" min="0" max="100" value="${c.priority_override != null ? e(c.priority_override) : ''}" style="max-width:90px"/>`)}
        ${lbl('Reason', `<input class="form-input" name="reason" maxlength="500" value="${e(c.override_reason || '')}"/>`)}<button class="btn btn-ghost" type="submit">Set</button></form>` : ''}

      ${h('Tasks')}
      ${openT.map(t => `<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line,#eee)">
        <div style="flex:1"><div${Date.parse(t.due_at) < Date.now() ? ' style="color:var(--red,#B94A3F);font-weight:600"' : ''}>${e(t.title)}</div><div class="name-sub">due ${e(when(t.due_at))}${t.escalated_at ? ' · escalated' : ''}</div></div>
        <button class="btn btn-ghost" type="button" data-ret-task-done="${t.id}">Done</button></div>`).join('') || '<span class="name-sub">No open tasks.</span>'}
      ${closed ? '' : `<form data-ret-task="${e(c.id)}" style="display:flex;gap:8px;align-items:end;flex-wrap:wrap;margin-top:8px">
        ${lbl('Follow-up', `<input class="form-input" name="title" maxlength="300" placeholder="Call back about the room options" required/>`)}
        ${lbl('Due', `<input class="form-input" name="due" type="datetime-local" required/>`)}<button class="btn btn-ghost" type="submit">Add</button></form>`}

      ${h('Timeline')}
      ${(acts.data || []).map(a => `<div style="padding:6px 0;border-bottom:1px solid var(--line,#eee)"><div class="name-sub">${e(when(a.at))} · ${e(String(a.actor || '').replace(/^staff:/, ''))}${a.channel ? ' · ' + e(a.channel) : ''}</div>
        <div><b>${e(a.type.replace(/_/g, ' '))}</b>${a.after && a.after.stage ? ' → ' + e(STAGE_LABEL[a.after.stage] || a.after.stage) : ''}${a.after && a.after.owner !== undefined && a.type === 'assigned' ? ' → ' + e(nameOf(a.after.owner) || 'unassigned') : ''}${a.after && a.after.reached ? ' · reached' : ''}${a.body ? ': ' + e(a.body) : ''}</div></div>`).join('') || '<span class="name-sub">No activity.</span>'}
    </div>`;
    document.getElementById('panel-body').innerHTML = body;
    return true;
  }

  async function call(name, p, okMsg, id){
    const { data, error } = await sb().rpc(name, { p });
    if (error || !data || data.ok === false) {
      toast(why(data, error));
      if (data && data.error === 'version_conflict') { await load(true); if (id) open(id); }
      return null;
    }
    if (okMsg) toast(okMsg);
    await load(true);
    if (id) open(id);
    return data;
  }
  const caseById = (id) => (cases || []).find(x => x.id === id);

  async function onSubmit(ev){
    const f = ev.target, fd = new FormData(f), d = f.dataset;
    const id = d.retReasons || d.retAssign || d.retLog || d.retOffer || d.retMove || d.retPrio || d.retTask;
    if (!id || !d) return;
    ev.preventDefault();
    const c = caseById(id); if (!c) return;
    const btn = f.querySelector('button[type="submit"]'); if (btn) btn.disabled = true;
    try {
      if (d.retReasons) await call('retention_update', { id, version: c.version, primary_reason: fd.get('primary_reason') || '', secondary_reasons: fd.getAll('secondary') }, 'Reasons saved', id);
      else if (d.retAssign) await call('retention_assign', { id, version: c.version, owner: fd.get('owner') || '' }, 'Assigned', id);
      else if (d.retLog) await call('retention_log_activity', { id, type: fd.get('type'), channel: fd.get('type') === 'message' ? 'whatsapp' : fd.get('type'), body: fd.get('body'), reached: !!fd.get('reached') }, 'Logged', id);
      else if (d.retOffer) {
        const r = await call('retention_offer_extension', { id, version: c.version, new_end: fd.get('new_end'), note: fd.get('note') || '' }, null, null);
        if (r) {
          toast(r.existing ? `${r.extension_id} was already open: linked. Opening it…` : `Drafted ${r.extension_id}. Review the rent and press Accept & send contract.`);
          if (typeof window.openExtension === 'function') { if (typeof goToView === 'function') goToView('extensions'); openExtFresh(r.extension_id); }
          else open(id);
        }
      } else if (d.retMove) {
        const stage = fd.get('stage'), outcome = fd.get('outcome') || '', note = fd.get('note') || '';
        await call('retention_transition', { id, version: c.version, stage, outcome, note }, `Moved to ${STAGE_LABEL[stage]}`, id);
      } else if (d.retPrio) {
        const v = String(fd.get('priority') || '').trim();
        await call('retention_update', { id, version: c.version, priority_override: v === '' ? null : Number(v), override_reason: fd.get('reason') || '' }, 'Priority updated', id);
      } else if (d.retTask) {
        const due = fd.get('due'); const iso = due ? new Date(due).toISOString() : '';
        await call('retention_task', { id, op: 'create', title: fd.get('title'), due_at: iso }, 'Follow-up added', id);
      }
    } finally { if (btn) btn.disabled = false; }
  }

  async function onClick(ev){
    const pb = ev.target.closest('#panel-body'); if (!pb || !pb.querySelector('[data-ret-tok]')) return;
    const c = caseById(currentId);
    const a = ev.target.closest('[data-ret-claim],[data-ret-copy-swap],[data-ret-optout],[data-ret-task-done],[data-ret-ext],[data-ret-rc],[data-ret-tenant]');
    if (!a || !c) return;
    ev.preventDefault();
    if (a.dataset.retClaim) await call('retention_assign', { id: c.id, version: c.version, owner: me().email }, 'Assigned to you', c.id);
    else if (a.hasAttribute('data-ret-copy-swap')) { try { await navigator.clipboard.writeText(ROOM_SWAP_URL); toast('Copied ' + ROOM_SWAP_URL + ' — send it to the tenant; their request links here.'); } catch (_) { toast(ROOM_SWAP_URL); } }
    else if (a.dataset.retOptout) await call('retention_update', { id: c.id, version: c.version, opted_out: a.dataset.retOptout === 'on' }, a.dataset.retOptout === 'on' ? 'Marked opted out: follow-ups stopped' : 'Opt-out removed', c.id);
    else if (a.dataset.retTaskDone) await call('retention_task', { id: c.id, op: 'done', task_id: Number(a.dataset.retTaskDone) }, 'Task done', c.id);
    else if (a.dataset.retExt && typeof window.openExtension === 'function') { if (typeof goToView === 'function') goToView('extensions'); openExtFresh(a.dataset.retExt); }
    else if (a.dataset.retRc && typeof window.openRoomChange === 'function') { if (typeof goToView === 'function') goToView('room-changes'); setTimeout(() => window.openRoomChange(a.dataset.retRc), 300); }
    else if (a.dataset.retTenant) { if (typeof goToView === 'function') goToView('tenants'); if (typeof openTenant === 'function') setTimeout(() => openTenant(a.dataset.retTenant), 300); }
  }
  // Extensions caches its list: reload it so a request drafted a moment ago is found.
  async function openExtFresh(id){
    try { if (typeof window.loadExtensions === 'function') await window.loadExtensions(true); } catch (_) {}
    window.openExtension(id);
  }
  let currentId = null;
  const openTracked = async (id) => { currentId = id; return open(id); };

  // New case (staff referral): search active tenants in the portal list.
  function newCase(){
    openPanel('+', 'New retention case', 'A tenant said they may leave, or asked about renewing', '');
    document.getElementById('panel-body').innerHTML = `<div data-ret-tok="new"><form data-ret-new style="display:grid;gap:10px;margin-top:10px">
      ${lbl('Tenant', `<input class="form-input" name="q" placeholder="Search name, email, house…" autocomplete="off" data-ret-new-q/>`)}
      <div data-ret-new-list style="display:grid;gap:4px;max-height:240px;overflow:auto"></div>
      <input type="hidden" name="tenant_id"/>
      ${lbl('Reason', `<select class="form-input" name="reason"><option value="">Not known yet</option>${Object.entries(REASONS).map(([k, l]) => `<option value="${k}">${e(l)}</option>`).join('')}</select>`)}
      ${lbl('What did they say? (required)', `<textarea class="form-input" name="note" rows="3" maxlength="2000" required></textarea>`)}
      <div><button class="btn btn-primary" type="submit">Open case</button></div></form></div>`;
  }
  function tenantMatches(q){
    const list = (typeof tenants !== 'undefined' && Array.isArray(tenants) ? tenants : []).filter(t => t && t.status !== 'past' && t.email);
    const s = q.trim().toLowerCase(); if (s.length < 2) return [];
    return list.filter(t => [t.name, t.email, t.property, t.room].some(v => String(v || '').toLowerCase().includes(s))).slice(0, 12);
  }

  function exportCsv(){
    const blob = new Blob([csv(filtered())], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `retention-${ymd(Date.now())}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function fromHash(){
    const m = (location.hash || '').match(/^#retention(?:=(RT-\d{2}-\d{5}))?$/);
    if (!m) return false;
    if (typeof goToView === 'function') goToView('retention');
    if (m[1]) openTracked(m[1]);
    return true;
  }

  window.loadRetention = load;
  window.openRetentionCase = openTracked;
  window.retentionFromHash = fromHash;
  if (typeof window.addEventListener === 'function') window.addEventListener('hashchange', fromHash);

  function wire(){
    const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    let t = null;
    on('ret-search', 'input', ev => { S.q = ev.target.value; clearTimeout(t); t = setTimeout(render, 150); });
    [['ret-f-owner', 'owner'], ['ret-f-city', 'city'], ['ret-f-country', 'country'], ['ret-f-trigger', 'trigger'], ['ret-f-stage', 'stage'], ['ret-f-reason', 'reason']]
      .forEach(([id, k]) => on(id, 'change', ev => { S[k] = ev.target.value; render(); }));
    on('ret-f-test', 'change', ev => { S.showTest = ev.target.checked; render(); });
    on('ret-refresh', 'click', () => load(true));
    on('ret-export', 'click', exportCsv);
    on('ret-new', 'click', newCase);
    const tabClick = ev => { const b = ev.target.closest('[data-ret-tab]'); if (b) { S.tab = b.dataset.retTab; S.stage = ''; const st = document.getElementById('ret-f-stage'); if (st) st.value = ''; render(); } };
    on('ret-tabs', 'click', tabClick);
    on('ret-kpis', 'click', tabClick);
    on('ret-body', 'click', ev => { const tr = ev.target.closest('[data-ret-open]'); if (tr) openTracked(tr.dataset.retOpen); });
    on('ret-body', 'keydown', ev => { if (ev.key === 'Enter') { const tr = ev.target.closest('[data-ret-open]'); if (tr) openTracked(tr.dataset.retOpen); } });
    const pb = document.getElementById('panel-body');
    if (pb) {
      pb.addEventListener('submit', async ev => {
        if (ev.target.matches('[data-ret-new]')) {
          ev.preventDefault();
          const fd = new FormData(ev.target);
          if (!fd.get('tenant_id')) { toast('Pick a tenant from the list'); return; }
          const { data, error } = await sb().rpc('retention_create', { p: { tenant_id: fd.get('tenant_id'), reason: fd.get('reason') || '', note: fd.get('note'), key: 'portal-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) } });
          if (error || !data || !data.ok) { toast(why(data, error)); return; }
          toast(data.outcome === 'attached' ? `Added to the open case ${data.id}` : `Opened ${data.id}`);
          await load(true); openTracked(data.id);
          return;
        }
        if (pb.querySelector('[data-ret-tok]')) onSubmit(ev);
      });
      pb.addEventListener('click', ev => {
        const pick = ev.target.closest('[data-ret-pick]');
        if (pick) {
          const f = pick.closest('form'); f.elements.tenant_id.value = pick.dataset.retPick;
          f.querySelector('[data-ret-new-q]').value = pick.dataset.retLabel;
          f.querySelector('[data-ret-new-list]').innerHTML = '';
          return;
        }
        onClick(ev);
      });
      pb.addEventListener('input', ev => {
        if (!ev.target.matches('[data-ret-new-q]')) return;
        const f = ev.target.closest('form'); f.elements.tenant_id.value = '';
        f.querySelector('[data-ret-new-list]').innerHTML = tenantMatches(ev.target.value).map(t => {
          const label = `${t.name || t.email} · ${[t.property, t.room].filter(Boolean).join(' · ')}`;
          return `<button type="button" class="btn btn-ghost" style="text-align:left;justify-content:flex-start" data-ret-pick="${e(t.id)}" data-ret-label="${e(label)}">${e(label)}<span class="name-sub" style="margin-left:6px">${e(t.email)}</span></button>`;
        }).join('') || '<span class="name-sub">Type 2+ letters.</span>';
      });
    }
    setTimeout(() => { if (sb()) load().catch(() => {}); fromHash(); }, 2600);
  }
  if (typeof document !== 'undefined') { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire(); }
})();
