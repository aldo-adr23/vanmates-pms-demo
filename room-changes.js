/* Room changes (portal): requests from vanmates.com/room-swap.
   Reads room_change_requests / _feedback / _events through RLS (room-changes-2026-10-08.sql);
   the only write is the room_change_staff_update RPC (status, owner, tenant message, note) with
   an optimistic version check. Raw tenant comments live in room_change_comments, which RLS
   returns only to admins and the request's owner; everyone else sees "restricted".
   "Confirm & send" (room-change-handoff-2026-10-09.sql) sends the new room's contract through the
   letters Worker (ctCall, booking.transfer: the deposit is carried over) and then opens the
   transfer move-out case for the old room (room_change_handoff), which emails the tenant the
   hand-back form. Nothing here moves the room in Asana or changes billing. Loaded by index.html after the main script (uses esc, showToast,
   goToView, CURRENT_USER, teamMembers, window.vmDb.sb and the shared detail panel). */
(function(){
  const RC_STATUSES = ['NEEDS_REVIEW', 'IN_PROGRESS', 'CONFIRMED', 'COMPLETED', 'DECLINED', 'CANCELLED'];
  const RC_OPEN = ['NEEDS_REVIEW', 'IN_PROGRESS', 'CONFIRMED'];
  const RC_STATUS_LABEL = { NEEDS_REVIEW: 'Needs review', IN_PROGRESS: 'In progress', CONFIRMED: 'Confirmed', COMPLETED: 'Completed', DECLINED: 'Declined', CANCELLED: 'Cancelled' };
  const RC_REASONS = { lower_cost: 'Lower cost', larger_room: 'Larger room', private_bathroom: 'Private bathroom', different_location: 'Different location', closer_to_school_work: 'Closer to school or work', noise: 'Noise', cleanliness: 'Cleanliness', maintenance: 'Maintenance', roommate_compatibility: 'Roommate compatibility', privacy: 'Privacy', safety_concern: 'Safety concern', accessibility_needs: 'Accessibility needs', service_experience: 'Service experience', personal_change: 'Personal change', other: 'Other', prefer_not_to_say: 'Prefer not to say' };
  const RC_FLAGS = { safety: ['Safety', 'red'], issue: ['Maintenance/cleanliness', 'red'], contact_requested: ['Wants contact', 'blue'], no_match: ['No room picked', 'blue'], email_failed: ['Email failed', 'red'], notify_failed: ['Alert failed', 'red'] };
  const RC_COLS = 9;
  const S = { tab: 'open', q: '', city: '', status: '', owner: '' };
  let rows = null, feedback = {}, loading = null, openSeq = 0;

  const e = (s) => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s));
  const toast = (m) => { if (typeof showToast === 'function') showToast(m); };
  const me = () => { const u = (typeof CURRENT_USER !== 'undefined' && CURRENT_USER) || {}; return { email: String(u.email || '').toLowerCase(), role: String(u.role || '') }; };
  const team = () => (typeof teamMembers !== 'undefined' ? teamMembers : []);
  const nameOf = (email) => { const x = String(email || '').toLowerCase(); if (!x) return ''; const m = team().find(t => String(t.email || '').toLowerCase() === x); return m ? (m.name || m.email) : x.split('@')[0]; };
  const money = (n) => (n == null || n === '' || !isFinite(Number(n)) ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-CA'));
  const day = (ymd) => { if (!ymd) return '—'; const d = new Date(String(ymd).slice(0, 10) + 'T12:00:00Z'); return isNaN(d) ? String(ymd) : d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); };
  const when = (ts) => { if (!ts) return '—'; const d = new Date(ts); return isNaN(d) ? String(ts) : d.toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }); };
  const chip = (f) => { const [l, c] = RC_FLAGS[f] || [f, 'blue']; return `<span class="tag-pill ${c}" style="font-size:11px;margin:1px">${e(l)}</span>`; };
  const statusPill = (s) => `<span class="tag-pill ${s === 'NEEDS_REVIEW' ? 'red' : RC_OPEN.includes(s) ? 'blue' : ''}" style="font-size:11px">${e(RC_STATUS_LABEL[s] || s)}</span>`;
  const sb = () => window.vmDb && window.vmDb.sb;
  const lc = (s) => String(s == null ? '' : s).trim().toLowerCase();

  // Asana names rooms "<room> - <house>" ("Phoenix - Willow House"); the contract wants both.
  function roomParts(name){
    const parts = String(name || '').split(/\s+[-–]\s+/).map(x => x.trim()).filter(Boolean);
    if (parts.length < 2) return { house: parts[0] || '', room: '' };
    return { house: parts[parts.length - 1], room: parts.slice(0, -1).join(' - ') };
  }
  const provinceOf = (city) => { const c = lc(city).normalize('NFD').replace(/[\u0300-\u036f]/g, ''); return c.startsWith('tor') ? 'on' : c.startsWith('mon') ? 'qc' : 'bc'; };
  // The tenant's signed contract (deposit, utilities) and portal record (Asana gid), when the portal has them.
  function currentContract(email){
    const list = (window.contracts || []).filter(c => c && c.booking && ['customer_signed', 'completed'].includes(c.status) && !c.booking.transfer
      && (c.booking.tenants || []).some(t => lc(t.email) === lc(email)));
    return list.sort((a, b) => String(b.booking.start || '').localeCompare(String(a.booking.start || '')))[0] || null;
  }
  const tenantRecord = (email) => (typeof tenants !== 'undefined' && Array.isArray(tenants) ? tenants : []).find(t => lc(t.email) === lc(email) && t.status !== 'past') || null;
  const contractById = (id) => (window.contracts || []).find(c => c && String(c.id) === String(id)) || null;
  const CT_STATUS = { draft: 'Draft', sent: 'Sent, waiting for the tenant', customer_signed: 'Signed by the tenant', completed: 'Completed', void: 'Void' };

  const SELECT = 'id,email,status,flags,city,current_house,current_room,current_rent,lease_end,move_date,budget,currency,primary_reason,target_name,target_price,owner,data,version,created_at,updated_at,closed_at';

  async function load(force){
    if (loading) return loading;
    if (rows && !force) { render(); return; }
    const body = document.getElementById('rc-body');
    if (!sb()) { if (body) body.innerHTML = `<tr><td colspan="${RC_COLS}" class="name-sub">Not connected to the database.</td></tr>`; return; }
    if (body && !rows) body.innerHTML = `<tr><td colspan="${RC_COLS}" class="name-sub">Loading…</td></tr>`;
    loading = (async () => {
      try {
        const [r, f] = await Promise.all([
          sb().from('room_change_requests').select(SELECT).is('deleted_at', null).order('created_at', { ascending: false }).limit(2000),
          sb().from('room_change_feedback').select('request_id,primary_reason,secondary_reasons,satisfaction,previously_reported,support_ticket,contact_requested,contact_channel,would_stay,submitted_at,post_move_rating').limit(2000),
        ]);
        if (r.error) throw r.error;
        rows = r.data || [];
        feedback = {};
        (f.data || []).forEach(x => { feedback[x.request_id] = x; });
        ownerOptions();
        render();
      } catch (err) {
        console.error('[room-changes] load failed', err);
        const missing = /room_change_requests/.test(String(err && err.message)) && /exist|schema cache/i.test(String(err && err.message));
        if (body) body.innerHTML = `<tr><td colspan="${RC_COLS}" class="name-sub">${missing ? 'Room changes are not set up in the database yet (run room-changes-2026-10-08.sql).' : 'Could not load room changes: ' + e(err.message || err)}</td></tr>`;
      } finally { loading = null; }
    })();
    return loading;
  }

  function ownerOptions(){
    const sel = document.getElementById('rc-filter-owner');
    if (!sel) return;
    const emails = new Set(team().map(m => String(m.email || '').toLowerCase()).filter(Boolean));
    (rows || []).forEach(r => { if (r.owner) emails.add(r.owner); });
    sel.innerHTML = '<option value="">All owners</option><option value="none">Unassigned</option><option value="me">Mine</option>' +
      [...emails].sort((a, b) => nameOf(a).localeCompare(nameOf(b))).map(x => `<option value="${e(x)}">${e(nameOf(x))}</option>`).join('');
    sel.value = S.owner;
  }

  function inTab(r, tab){ return tab === 'closed' ? !RC_OPEN.includes(r.status) : RC_OPEN.includes(r.status); }
  function filtered(){
    const q = S.q.trim().toLowerCase(), m = me().email;
    return (rows || []).filter(r => inTab(r, S.tab)
      && (!S.city || String(r.city || '').toLowerCase().startsWith(S.city.toLowerCase().slice(0, 3)))
      && (!S.status || r.status === S.status)
      && (!S.owner || (S.owner === 'none' ? !r.owner : S.owner === 'me' ? r.owner === m : r.owner === S.owner))
      && (!q || [r.id, r.email, r.current_house, r.current_room, r.target_name, (r.data || {}).name].some(v => String(v || '').toLowerCase().includes(q))));
  }
  // Open list: safety first, then needs review, then soonest move date.
  function sortOpen(list){
    const rank = (r) => ((r.flags || []).includes('safety') ? 0 : 2) + (r.status === 'NEEDS_REVIEW' ? 0 : 1);
    return list.slice().sort((a, b) => rank(a) - rank(b) || String(a.move_date).localeCompare(String(b.move_date)));
  }

  function render(){
    if (!rows) return;
    const badge = document.querySelector('.nav-item[data-view="room-changes"] .nav-count');
    if (badge) badge.textContent = String(rows.filter(r => r.status === 'NEEDS_REVIEW').length);
    const tabs = document.getElementById('rc-tabs');
    const isAdmin = me().role === 'admin';
    if (S.tab === 'reports' && !isAdmin) S.tab = 'open';
    if (tabs) tabs.innerHTML = [['open', 'Open'], ['closed', 'Closed']].concat(isAdmin ? [['reports', 'Reports']] : []).map(([k, l]) => {
      const n = k === 'reports' ? '' : ` <span class="name-sub">${rows.filter(r => inTab(r, k)).length}</span>`;
      return `<button type="button" class="tab${S.tab === k ? ' active' : ''}" role="tab" aria-selected="${S.tab === k}" data-rc-tab="${k}">${l}${n}</button>`;
    }).join('');
    const rpt = S.tab === 'reports';
    document.getElementById('rc-filter-bar').style.display = rpt ? 'none' : '';
    document.getElementById('rc-list-card').hidden = rpt;
    document.getElementById('rc-report').hidden = !rpt;
    if (rpt) { renderReport(); return; }
    const list = S.tab === 'open' ? sortOpen(filtered()) : filtered();
    document.getElementById('rc-count').textContent = list.length;
    document.getElementById('rc-empty').style.display = list.length ? 'none' : '';
    document.getElementById('rc-body').innerHTML = list.map(r => {
      const d = r.data || {}, delta = r.target_price != null && r.current_rent != null ? Number(r.target_price) - Number(r.current_rent) : null;
      return `<tr class="clickable" data-rc-open="${e(r.id)}" tabindex="0" style="cursor:pointer">
        <td><b>${e(r.id)}</b><div class="name-sub">${e(day(r.created_at))}</div></td>
        <td>${e(d.name || d.first_name || r.email)}<div class="name-sub">${e(r.email)}</div></td>
        <td>${e([r.current_house, r.current_room].filter(Boolean).join(' · '))}<div class="name-sub">${e(r.city || '')}</div></td>
        <td>${r.target_name ? e(r.target_name) : '<span class="name-sub">None picked</span>'}</td>
        <td>${e(day(r.move_date))}</td>
        <td>${r.target_price != null ? e(money(r.target_price)) + (delta != null ? `<div class="name-sub">${delta >= 0 ? '+' : '−'}${e(money(Math.abs(delta)))}</div>` : '') : '<span class="name-sub">≤ ' + e(money(r.budget)) + '</span>'}</td>
        <td>${e(RC_REASONS[r.primary_reason] || r.primary_reason || '—')}</td>
        <td>${statusPill(r.status)}<div class="name-sub">${e(nameOf(r.owner) || 'Unassigned')}</div></td>
        <td>${(r.flags || []).map(chip).join(' ')}</td>
      </tr>`;
    }).join('');
  }

  // Spec §2 "Reporting": primary and secondary reasons apart, requests vs completed transfers,
  // with denominators; by original house. Raw comments are never part of a report.
  function renderReport(){
    const el = document.getElementById('rc-report-body');
    const all = rows || [];
    const done = all.filter(r => r.status === 'COMPLETED');
    const pct = (a, b) => (b ? Math.round(100 * a / b) + '%' : '—');
    const count = (list, key) => { const m = {}; list.forEach(r => { const k = key(r); (Array.isArray(k) ? k : [k]).forEach(x => { if (x) m[x] = (m[x] || 0) + 1; }); }); return Object.entries(m).sort((a, b) => b[1] - a[1]); };
    const prim = count(all, r => r.primary_reason);
    const primDone = Object.fromEntries(count(done, r => r.primary_reason));
    const sec = count(all, r => (feedback[r.id] || {}).secondary_reasons || []);
    const houses = count(all, r => r.current_house || '(unknown)');
    const housesDone = Object.fromEntries(count(done, r => r.current_house || '(unknown)'));
    const table = (head, body) => `<div style="overflow-x:auto"><table><thead><tr>${head.map(h => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${body || `<tr><td colspan="${head.length}" class="name-sub">No data yet.</td></tr>`}</tbody></table></div>`;
    el.innerHTML = `
      <p class="name-sub" style="margin:0 0 12px">${all.length} requests · ${done.length} completed transfers (${pct(done.length, all.length)}) · ${all.filter(r => r.status === 'CANCELLED').length} cancelled by tenant · ${all.filter(r => r.status === 'DECLINED').length} declined</p>
      <div class="card" style="margin-bottom:14px"><div class="card-head" style="padding:12px 16px"><div class="card-title">Primary reason <em>(one per request)</em></div></div>
        ${table(['Reason', 'Requests', 'Share of requests', 'Completed', 'Completed rate'], prim.map(([k, n]) => `<tr><td>${e(RC_REASONS[k] || k)}</td><td>${n} / ${all.length}</td><td>${pct(n, all.length)}</td><td>${primDone[k] || 0} / ${n}</td><td>${pct(primDone[k] || 0, n)}</td></tr>`).join(''))}</div>
      <div class="card" style="margin-bottom:14px"><div class="card-head" style="padding:12px 16px"><div class="card-title">Other reasons <em>(any number per request)</em></div></div>
        ${table(['Reason', 'Mentioned in', 'Share of requests'], sec.map(([k, n]) => `<tr><td>${e(RC_REASONS[k] || k)}</td><td>${n} / ${all.length}</td><td>${pct(n, all.length)}</td></tr>`).join(''))}</div>
      <div class="card"><div class="card-head" style="padding:12px 16px"><div class="card-title">By original house</div></div>
        ${table(['House', 'Requests', 'Completed'], houses.map(([k, n]) => `<tr><td>${e(k)}</td><td>${n}</td><td>${housesDone[k] || 0} / ${n}</td></tr>`).join(''))}</div>`;
  }

  async function open(id){
    const tok = ++openSeq;
    if (!rows) await load();
    const r = (rows || []).find(x => x.id === id);
    if (!r) { toast('Room change not found'); return false; }
    const d = r.data || {};
    document.getElementById('panel-hero').textContent = String(d.name || d.first_name || r.email || '?').slice(0, 1).toUpperCase();
    document.getElementById('panel-title').innerHTML = e(d.name || d.first_name || r.email);
    document.getElementById('panel-sub').textContent = `${r.id} · ${r.current_house || ''} → ${r.target_name || 'no room picked'}`;
    document.getElementById('panel-meta').innerHTML = statusPill(r.status) + ' ' + (r.flags || []).map(chip).join(' ');
    document.getElementById('panel-body').innerHTML = `<div data-rc-tok="${tok}" class="name-sub" style="padding:18px 0">Loading…</div>`;
    document.getElementById('detail-panel').classList.add('open');
    document.getElementById('detail-panel').setAttribute('aria-hidden', 'false');
    document.getElementById('panel-backdrop').classList.add('open');
    document.body.style.overflow = 'hidden';
    const [ev, cm] = await Promise.all([
      sb().from('room_change_events').select('id,at,actor,type,before,after').eq('request_id', id).order('at', { ascending: true }),
      sb().from('room_change_comments').select('comments,at').eq('request_id', id).maybeSingle(),
    ]);
    if (tok !== openSeq || !document.querySelector(`#panel-body [data-rc-tok="${tok}"]`)) return false;
    const f = feedback[id] || {}, p = d.preferences || {}, sel = d.selected || null;
    const kv = (label, value) => `<div style="display:flex;gap:12px;padding:6px 0;border-bottom:1px solid var(--line,#eee)"><div class="name-sub" style="flex:0 0 38%">${e(label)}</div><div style="flex:1;min-width:0;overflow-wrap:anywhere">${value}</div></div>`;
    const h = (t) => `<h4 style="margin:22px 0 6px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)">${e(t)}</h4>`;
    const delta = r.target_price != null && r.current_rent != null ? Number(r.target_price) - Number(r.current_rent) : null;
    const canSeeComments = !cm.error && cm.data;
    const comments = canSeeComments ? `<div style="white-space:pre-wrap;background:var(--cream-2,#f6f1e7);border-radius:8px;padding:10px 12px">${e(cm.data.comments)}</div>`
      : `<span class="name-sub">${(f.primary_reason || r.primary_reason) ? 'None shared, or restricted: comments are visible to admins and the assigned owner only.' : '—'}</span>`;
    const teamOpts = ['<option value="">Unassigned</option>'].concat(team().filter(t => t.email).map(t => `<option value="${e(String(t.email).toLowerCase())}" ${String(t.email).toLowerCase() === r.owner ? 'selected' : ''}>${e(t.name || t.email)}</option>`));
    if (r.owner && !team().some(t => String(t.email || '').toLowerCase() === r.owner)) teamOpts.push(`<option value="${e(r.owner)}" selected>${e(r.owner)}</option>`);
    document.getElementById('panel-body').innerHTML = `<div data-rc-tok="${tok}">
      ${(r.flags || []).includes('safety') ? `<div class="tag-pill red" style="display:block;text-transform:none;letter-spacing:0;font-size:13px;padding:10px 12px;margin:6px 0 4px">Safety concern: contact the tenant today. Do not share details with the landlord or roommates.</div>` : ''}
      ${h('Work it')}
      <form data-rc-form="${e(r.id)}" style="display:grid;gap:10px">
        <label class="name-sub" style="display:grid;gap:4px">Status<select class="form-input" name="status">${RC_STATUSES.map(s => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${e(RC_STATUS_LABEL[s])}</option>`).join('')}</select></label>
        <label class="name-sub" style="display:grid;gap:4px">Owner<select class="form-input" name="owner">${teamOpts.join('')}</select></label>
        <label class="name-sub" style="display:grid;gap:4px">Message the tenant sees on vanmates.com/room-swap<textarea class="form-input" name="staff_message" rows="3" maxlength="1000">${e(d.staff_message || '')}</textarea></label>
        <label class="name-sub" style="display:grid;gap:4px">Internal note (audit history only)<input class="form-input" name="note" maxlength="1000" /></label>
        <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-primary" type="submit">Save</button></div>
        <p class="name-sub" style="margin:0">Before confirming: check the room is free from the move date to ${e(day(r.lease_end))} in Asana and agree any transfer fee or rent difference with the tenant. Then use <b>Confirm &amp; send</b> below. At <b>Completed</b>: the move happened, keys and cleaning done, Asana and the register updated (Hugo can do the room moves).</p>
      </form>
      ${handoffHtml(r, d, sel)}
      ${h('Request')}
      ${kv('Tenant', `${e(d.name || '')} <span class="name-sub">${e(r.email)}</span>`)}
      ${kv('From', `${e([r.current_house, r.current_room].filter(Boolean).join(' · '))} · ${e(money(r.current_rent))}/mo · ${e(r.city || '')}`)}
      ${kv('To', sel ? `${e(sel.name)} · ${e(money(sel.price))}/mo${delta != null ? ` (${delta >= 0 ? '+' : '−'}${e(money(Math.abs(delta)))})` : ''}<div class="name-sub">${e(sel.address || '')} · ${e(sel.available || '')}${sel.gid ? ` · <a href="https://app.asana.com/0/0/${e(sel.gid)}" target="_blank" rel="noopener">Asana</a>` : ''}</div>` : `<span class="name-sub">None picked: suggest options within ${e(money(r.budget))}</span>`)}
      ${kv('Move date', `${e(day(r.move_date))}${p.flexible_until ? ' · flexible to ' + e(day(p.flexible_until)) : ''}`)}
      ${kv('Contract end', `${e(day(r.lease_end))} (keep)`)}
      ${kv('Budget', e(money(r.budget)))}
      ${kv('Preferences', e([p.requirements && 'Wants: ' + p.requirements, p.room_type && 'Room type: ' + p.room_type, p.private_bathroom && 'Private bathroom: ' + p.private_bathroom, p.neighbourhood && 'Area: ' + p.neighbourhood, p.near && 'Near: ' + p.near, p.notes && 'Notes: ' + p.notes].filter(Boolean).join(' · ') || '—'))}
      ${kv('Other rooms shown', e((d.options_shown || []).map(o => `${o.name} (${money(o.price)})`).join(' · ') || '—'))}
      ${kv('Policy version', e(d.policy_version || 'none approved yet: staff quote'))}
      ${h('Feedback')}
      ${kv('Main reason', e(RC_REASONS[f.primary_reason || r.primary_reason] || '—'))}
      ${kv('Other reasons', e((f.secondary_reasons || []).map(x => RC_REASONS[x] || x).join(', ') || '—'))}
      ${kv('Satisfaction', e(f.satisfaction ? f.satisfaction + ' / 5' : '—'))}
      ${kv('Reported before', e(f.previously_reported || '—') + (f.support_ticket ? ' · ticket ' + e(f.support_ticket) : ''))}
      ${kv('Wants contact', e(f.contact_requested === true ? 'Yes (email)' : f.contact_requested === false ? 'No: no retention outreach' : '—'))}
      ${kv('Would stay if fixed', e(f.would_stay || '—'))}
      ${kv('Comments', comments)}
      ${h('History')}
      ${(ev.data || []).map(x => `<div style="padding:6px 0;border-bottom:1px solid var(--line,#eee)"><div class="name-sub">${e(when(x.at))} · ${e(String(x.actor || '').replace(/^staff:/, '').replace(/^tenant:.*/, 'tenant'))}</div><div>${e(x.type.replace(/_/g, ' '))}${x.after && x.after.status && (!x.before || x.before.status !== x.after.status) ? ' → ' + e(RC_STATUS_LABEL[x.after.status] || x.after.status) : ''}${x.after && x.after.note ? ': ' + e(x.after.note) : ''}</div></div>`).join('') || '<span class="name-sub">No events.</span>'}
    </div>`;
    return true;
  }

  // "Confirm & send": the new contract (deposit carried over) + the transfer move-out case.
  function handoffHtml(r, d, sel){
    const h = (t) => `<h4 style="margin:22px 0 6px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)">${e(t)}</h4>`;
    const ho = d.handoff || null;
    if (ho) {
      const c = contractById(ho.contract_id);
      return `${h('Contract and move-out')}
        <div style="display:grid;gap:6px">
          <div>New contract: <b>${e(c ? (CT_STATUS[c.status] || c.status) : 'sent')}</b>${ho.contract_id ? ` · <a href="#" data-rc-goto-contract="${e(ho.contract_id)}">open in Contracts</a>` : ''}</div>
          <div>Move-out of ${e([r.current_house, r.current_room].filter(Boolean).join(' · '))}: <a href="#checkout=${e(ho.checkout_case_id)}">${e(ho.checkout_case_id)}</a> (transfer: deposit carried over, no refund)</div>
          <div class="name-sub">Confirmed by ${e(nameOf(ho.by))} · ${e(when(ho.at))}</div>
        </div>`;
    }
    if (!RC_OPEN.includes(r.status)) return '';
    if (!sel) return `${h('Confirm & send')}<p class="name-sub">The tenant didn't pick a room. Agree one with them, then confirm it from the Contracts page.</p>`;
    const parts = roomParts(sel.name);
    const cc = currentContract(r.email);
    const tr = tenantRecord(r.email);
    const held = cc && cc.booking.deposit != null && Number(cc.booking.deposit) > 0 ? Number(cc.booking.deposit) : (r.current_rent ? Math.round(Number(r.current_rent) / 2) : '');
    const util = cc && (cc.booking.utilities === 'Yes' || cc.booking.utilities === 'No') ? cc.booking.utilities : 'Yes';
    const f = (label, input) => `<label class="name-sub" style="display:grid;gap:4px">${label}${input}</label>`;
    return `${h('Confirm & send')}
      <form data-rc-handoff="${e(r.id)}" style="display:grid;gap:10px">
        <p class="name-sub" style="margin:0">Sends ${e(d.name || r.email)} a contract for the new room (the deposit is carried over, no new deposit due), then emails them a short move-out form for ${e([r.current_house, r.current_room].filter(Boolean).join(' · '))}. The request becomes <b>Confirmed</b>.</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          ${f('New house', `<input class="form-input" name="house" value="${e(parts.house)}" required maxlength="200">`)}
          ${f('New room', `<input class="form-input" name="room" value="${e(parts.room)}" required maxlength="200">`)}
        </div>
        ${f('Address', `<input class="form-input" name="address" value="${e(sel.address || '')}" required maxlength="300">`)}
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
          ${f('Rent / month', `<input class="form-input" name="rent" inputmode="numeric" value="${e(sel.price != null ? Math.round(Number(sel.price)) : '')}" required>`)}
          ${f('Move date (start)', `<input class="form-input" type="date" name="start" value="${e(String(r.move_date || '').slice(0, 10))}" required>`)}
          ${f('Contract end (keep)', `<input class="form-input" type="date" name="end" value="${e(String(r.lease_end || '').slice(0, 10))}" required>`)}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
          ${f('Deposit carried over', `<input class="form-input" name="deposit_held" inputmode="numeric" value="${e(held)}">`)}
          ${f('Utilities included', `<select class="form-input" name="utilities"><option ${util === 'Yes' ? 'selected' : ''}>Yes</option><option ${util === 'No' ? 'selected' : ''}>No</option></select>`)}
          ${f('Province', `<select class="form-input" name="province">${['bc', 'on', 'qc'].map(x => `<option value="${x}" ${x === provinceOf(r.city) ? 'selected' : ''}>${x.toUpperCase()}</option>`).join('')}</select>`)}
        </div>
        <input type="hidden" name="room_gid" value="${e(sel.gid || '')}">
        <input type="hidden" name="asana_tenant_gid" value="${e((tr && tr.asanaGid) || '')}">
        ${f('Message the tenant sees on vanmates.com/room-swap', `<textarea class="form-input" name="staff_message" rows="2" maxlength="1000">${e(d.staff_message || `Your room change is confirmed. Please sign your new contract for ${parts.house}${parts.room ? ' · ' + parts.room : ''} and fill in the move-out form for your current room; both are in your email.`)}</textarea>`)}
        <p class="form-error" data-rc-handoff-err style="margin:0"></p>
        <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-primary" type="submit">Confirm &amp; send</button></div>
        <p class="name-sub" style="margin:0">${cc ? `Deposit and utilities come from their signed contract ${e(cc.id)}.` : 'No signed contract found for this email in Contracts: check the deposit amount.'}${tr && tr.asanaGid ? '' : ' No Asana tenant link on their portal record.'}</p>
      </form>`;
  }

  async function handoff(form){
    const id = form.dataset.rcHandoff, r = (rows || []).find(x => x.id === id);
    if (!r) return;
    const d = r.data || {};
    const fd = new FormData(form);
    const v = (k) => String(fd.get(k) || '').trim();
    const err = form.querySelector('[data-rc-handoff-err]');
    const fail = (m) => { if (err) { err.textContent = m; err.classList.add('show'); } };
    if (err) { err.textContent = ''; err.classList.remove('show'); }
    const rent = Number(v('rent').replace(/[$,\s]/g, '')), held = v('deposit_held') === '' ? null : Number(v('deposit_held').replace(/[$,\s]/g, ''));
    if (!v('house') || !v('address')) return fail('House and address are needed for the contract.');
    if (!isFinite(rent) || rent <= 0 || rent % 1) return fail('Rent must be whole dollars.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v('start')) || !/^\d{4}-\d{2}-\d{2}$/.test(v('end')) || v('end') <= v('start')) return fail('Check the move date and the contract end.');
    if (held !== null && (!isFinite(held) || held < 0)) return fail('The deposit carried over must be a number of dollars.');
    if (typeof ctCall !== 'function') return fail('The contracts service is not loaded on this page. Reload and try again.');
    if (!confirm(`Send ${d.name || r.email} the contract for ${v('house')}${v('room') ? ' · ' + v('room') : ''} and the move-out form for their current room?`)) return;
    const booking = {
      province: v('province') || 'bc', lease_type: 'fixed',
      tenants: [{ name: d.name || '', email: r.email }],
      address: v('address'), house: v('house'), room: v('room'), rent,
      start: v('start'), end: v('end'), deposit: 0, deposit_due: v('start'), utilities: v('utilities') === 'No' ? 'No' : 'Yes',
      transfer: { from_house: r.current_house || '', from_room: r.current_room || '', deposit_held: held },
    };
    if (v('room_gid')) booking.room_gid = v('room_gid');
    if (v('asana_tenant_gid')) booking.asana_tenant_gid = v('asana_tenant_gid');
    const btn = form.querySelector('button[type="submit"]'); if (btn) { btn.disabled = true; btn.textContent = 'Sending the contract…'; }
    let ct = null;
    try { ct = await ctCall('/coliving', { booking, send: true }); }
    catch (e2) { if (btn) { btn.disabled = false; btn.textContent = 'Confirm & send'; } return fail('Contract not sent: ' + ((e2 && e2.message) || e2)); }
    if (!ct || !ct.contract_id || ct.status !== 'sent') {
      if (btn) { btn.disabled = false; btn.textContent = 'Confirm & send'; }
      const missing = ct && Array.isArray(ct.missing) && ct.missing.length ? ' Missing: ' + ct.missing.join(', ') + '.' : '';
      return fail('The contract was saved but not sent (' + ((ct && ct.status) || 'unknown') + ').' + missing + ' Finish it in Contracts.');
    }
    if (btn) btn.textContent = 'Opening the move-out…';
    const { data, error } = await sb().rpc('room_change_handoff', { p: {
      id, version: r.version, contract_id: ct.contract_id, move_out_date: v('start'), deposit_held: held,
      to_house: v('house'), to_room: v('room'), staff_message: v('staff_message'),
    } });
    if (btn) { btn.disabled = false; btn.textContent = 'Confirm & send'; }
    const why = { open_checkout: 'The tenant already has an open move-out (' + ((data && data.case_id) || '') + '). Close or update it in Move-outs, then press Confirm & send again (the contract is not sent twice).',
      version_conflict: 'Someone else changed this request. It reloaded; press Confirm & send again.', bad_date: 'The move date must be today or later.',
      bad_status: 'This request is closed.', forbidden: 'You are not on the team.' };
    if (error || !data || !data.ok) {
      await load(true); open(id);
      toast('Contract sent, but the move-out was not opened: ' + (error ? (error.message || error) : (why[data && data.error] || (data && data.error) || 'unknown')));
      return;
    }
    toast(ct.email_sent === false ? 'Confirmed. The contract email did not go out: resend it from Contracts.' : 'Confirmed: contract and move-out form sent to ' + r.email);
    await load(true);
    open(id);
  }

  async function save(form){
    const id = form.dataset.rcForm, r = (rows || []).find(x => x.id === id);
    if (!r) return;
    const fd = new FormData(form);
    const p = { id, version: r.version, owner: fd.get('owner') || '', staff_message: fd.get('staff_message') || '', note: fd.get('note') || '' };
    if (fd.get('status') !== r.status) p.status = fd.get('status');
    if (p.status && ['CONFIRMED', 'COMPLETED', 'DECLINED'].includes(p.status) && !p.note && !confirm('Mark ' + id + ' as ' + RC_STATUS_LABEL[p.status] + ' without a note?')) return;
    const btn = form.querySelector('button[type="submit"]'); if (btn) btn.disabled = true;
    const { data, error } = await sb().rpc('room_change_staff_update', { p });
    if (btn) btn.disabled = false;
    if (error) { toast('Could not save: ' + (error.message || error)); return; }
    if (!data || !data.ok) { toast(data && data.error === 'version_conflict' ? 'Someone else changed this request. Reloaded; please check and save again.' : 'Could not save: ' + ((data && data.error) || 'unknown')); await load(true); open(id); return; }
    toast('Saved ' + id);
    await load(true);
    open(id);
  }

  function fromHash(){
    const hash = location.hash || '';
    const m = hash.match(/^#room-change=(RC-\d{2}-\d{5})$/);
    if (hash === '#room-changes' || m) {
      if (typeof goToView === 'function') goToView('room-changes');
      if (m) open(m[1]);
      return true;
    }
    return false;
  }

  window.loadRoomChanges = load;
  window.openRoomChange = open;
  window.roomChangesFromHash = fromHash;
  window.addEventListener('hashchange', fromHash);

  function wire(){
    const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    const st = document.getElementById('rc-filter-status');
    if (st) st.insertAdjacentHTML('beforeend', RC_STATUSES.map(s => `<option value="${s}">${e(RC_STATUS_LABEL[s])}</option>`).join(''));
    let t = null;
    on('rc-search', 'input', ev => { S.q = ev.target.value; clearTimeout(t); t = setTimeout(render, 150); });
    on('rc-filter-status', 'change', ev => { S.status = ev.target.value; if (S.status) S.tab = RC_OPEN.includes(S.status) ? 'open' : 'closed'; render(); });
    on('rc-filter-owner', 'change', ev => { S.owner = ev.target.value; render(); });
    on('rc-filter-city', 'change', ev => { S.city = ev.target.value; render(); });
    on('rc-refresh', 'click', () => load(true));
    on('rc-tabs', 'click', ev => { const b = ev.target.closest('[data-rc-tab]'); if (b) { S.tab = b.dataset.rcTab; render(); } });
    on('rc-body', 'click', ev => { const tr = ev.target.closest('[data-rc-open]'); if (tr) open(tr.dataset.rcOpen); });
    on('rc-body', 'keydown', ev => { if (ev.key === 'Enter') { const tr = ev.target.closest('[data-rc-open]'); if (tr) open(tr.dataset.rcOpen); } });
    const pb = document.getElementById('panel-body');
    if (pb) pb.addEventListener('submit', ev => {
      if (ev.target.matches('[data-rc-form]')) { ev.preventDefault(); save(ev.target); }
      else if (ev.target.matches('[data-rc-handoff]')) { ev.preventDefault(); handoff(ev.target); }
    });
    if (pb) pb.addEventListener('click', ev => {
      const a = ev.target.closest('[data-rc-goto-contract]');
      if (!a) return;
      ev.preventDefault();
      if (typeof window.ctOpenFromElsewhere === 'function') window.ctOpenFromElsewhere(a.dataset.rcGotoContract);
      else if (typeof goToView === 'function') goToView('contracts');
    });
    // Badge on load, so a new request shows without opening the page.
    setTimeout(() => { if (sb()) load().catch(() => {}); fromHash(); }, 2500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
