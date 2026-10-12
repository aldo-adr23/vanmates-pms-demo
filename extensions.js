/* Extensions (portal): contract extension requests from vanmates.com/extend-stay.
   Reads extension_requests / extension_request_events through RLS (extension-requests-2026-10-10.sql).
   Writes: extension_staff_update (decline, reopen, owner, internal note) with an optimistic version check,
   and "Accept & send contract", which calls Hugo (POST /api/portal/extension with the staff Supabase
   session). Hugo runs the extension engine (conflict checks, extension sublease, 7-day room hold) and,
   once the contract is out, records it on the request (extension_record_sent → SENT). Finalising or
   voiding the contract moves the request to COMPLETED / EXPIRED by trigger. Loaded by index.html after
   the main script (uses esc, showToast, goToView, CURRENT_USER, teamMembers, window.contracts,
   window.vmDb.sb, window.ASSISTANTS_BASE and the shared detail panel).

   Homestay tab (extension-homestay-2026-10-11.sql): requests with lease_type 'homestay' come from homestay
   students (their n8n booking in data.homestay). Accept creates the extension booking through the homestay
   console's own webhook (window.hbApi → n8n booking-create, the full staff token, exactly as Homestay →
   Bookings → Extend: no placement fee, no deposit), which emails the student the payment link, then records
   it (extension_homestay_staff 'sent' → SENT, "Awaiting payment"). n8n "VM - Homestay Extension" moves it to
   COMPLETED once paid, or EXPIRED (booking cancelled) when unpaid after 7 days. Withdraw cancels the booking
   and expires the request. */
(function(){
  const EX_STATUSES = ['NEEDS_REVIEW', 'SENT', 'COMPLETED', 'DECLINED', 'CANCELLED', 'EXPIRED'];
  const EX_OPEN = ['NEEDS_REVIEW', 'SENT'];
  const EX_STATUS_LABEL = { NEEDS_REVIEW: 'Needs review', SENT: 'Contract sent', COMPLETED: 'Completed', DECLINED: 'Declined', CANCELLED: 'Cancelled', EXPIRED: 'Expired' };
  const EX_FLAGS = { email_failed: ['Email failed', 'red'], notify_failed: ['Alert failed', 'red'], room_conflict: ['Room booked after', 'red'] };
  const CT_STATUS = { draft: 'Draft', sent: 'Sent, waiting for the tenant', customer_signed: 'Signed by the tenant', completed: 'Completed', void: 'Void' };
  const HS_STATUS_LABEL = { SENT: 'Awaiting payment', COMPLETED: 'Paid' };
  const HS_PAY_DAYS = 7; // n8n VM - Homestay Extension cancels an unpaid extension booking after this
  const EX_COLS = 7;
  const HUGO_TIMEOUT_MS = 120000; // Hugo's extension run is ~20 s; Asana can make it slower.

  // ── pure helpers (window.EXT_CORE, tested in test/extensions.test.js) ──
  const inTab = (r, tab) => (tab === 'closed' ? !EX_OPEN.includes(r.status) : EX_OPEN.includes(r.status));
  const needsReview = (list) => (list || []).filter(r => r.status === 'NEEDS_REVIEW').length;
  // Open list: needs review first (oldest first: they have waited longest), then sent by end date.
  function sortOpen(list){
    const rank = (r) => (r.status === 'NEEDS_REVIEW' ? 0 : 1);
    return list.slice().sort((a, b) => rank(a) - rank(b) || String(a.created_at).localeCompare(String(b.created_at)));
  }
  // Rent typed by staff: whole dollars, positive. Returns a number or null.
  function parseRent(s){
    const t = String(s == null ? '' : s).replace(/[$,\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
    const n = Number(t);
    return n > 0 ? n : null;
  }
  // What the drawer offers for a status.
  function actionsFor(status){
    return { accept: status === 'NEEDS_REVIEW', decline: status === 'NEEDS_REVIEW', reopen: status === 'DECLINED' };
  }
  // The body posted to Hugo. room_gid / confirm_fixed / utilities only when set.
  function hugoBody(id, rent, roomGid, confirmFixed, utilities){
    const b = { request_id: id, rent };
    if (roomGid) b.room_gid = roomGid;
    if (confirmFixed) b.confirm_fixed = true;
    if (utilities === 'Yes' || utilities === 'No') b.utilities = utilities;
    return b;
  }
  // 'Yes' / 'No' from a contract's booking.utilities ("yes", "Yes, included", "No"), else ''.
  function yesNo(v){ const t = String(v == null ? '' : v).trim().toLowerCase(); return /^(yes|y|true|incl)\b/.test(t) ? 'Yes' : /^(no|n|false)$|^no[\s,.]/.test(t) ? 'No' : ''; }
  // Hugo's answer → what the drawer does next: done | pick_room | confirm_fixed | warn.
  function hugoNext(res){
    const s = res && res.status;
    if (s === 'sent') return { kind: 'done', message: res.message || 'Extension contract sent.' };
    if (s === 'ask_room' && Array.isArray(res.candidates) && res.candidates.length) return { kind: 'pick_room', message: res.message || 'Which room is this tenant in?', candidates: res.candidates };
    if (s === 'needs_confirmation') return { kind: 'confirm_fixed', message: res.message || 'This tenancy is month-to-month.' };
    if (s === 'draft' && Array.isArray(res.missing) && res.missing.some(m => /utilit/i.test(m))) return { kind: 'warn', message: 'Hugo has no record of whether utilities are included for this tenant. Choose Yes or No under "Utilities included" and press Accept again (the draft is reused).' };
    return { kind: 'warn', message: (res && res.message) || ('Hugo could not send the extension' + (s ? ' (' + s + ')' : '') + '.') };
  }
  // ── homestay ──
  const kindOf = (r) => (r && r.lease_type === 'homestay' ? 'homestay' : 'coliving');
  const statusLabel = (r) => (kindOf(r) === 'homestay' && HS_STATUS_LABEL[r.status]) || EX_STATUS_LABEL[r.status] || r.status;
  function hsActionsFor(status){
    return { accept: status === 'NEEDS_REVIEW', decline: status === 'NEEDS_REVIEW', reopen: status === 'DECLINED', withdraw: status === 'SENT' };
  }
  // Days between two YYYY-MM-DD dates (UTC, so no timezone can shift a day of rent).
  function hsDays(a, b){
    const x = Date.parse(String(a || '') + 'T00:00:00Z'), y = Date.parse(String(b || '') + 'T00:00:00Z');
    return isFinite(x) && isFinite(y) ? Math.round((y - x) / 86400000) : NaN;
  }
  // Dollars typed by staff → cents, or null.
  function hsCents(s){ const n = parseRent(s); return n == null ? null : Math.round(n * 100); }
  // booking-create body for an accepted request: the student's current booking carried on from its end
  // date, as Homestay → Bookings → Extend sends it (placement fee waived, no new deposit).
  function hsCreateBody(r, weeklyCents, hostCents){
    const h = (r && r.data && r.data.homestay) || {};
    const b = {
      host_id: h.host_id, student_email: r.email,
      weekly_rate_cents: weeklyCents, host_weekly_cents: hostCents,
      move_in_date: String(r.current_end || '').slice(0, 10), lease_days: hsDays(r.current_end, r.new_end),
      meal_plan: h.meal_plan || 'two_meals',
      student_name: h.student_name || (r.data && r.data.name) || '', student_dob: h.student_dob || '', student_country: h.student_country || '',
      placement_fee_status: 'waived', placement_fee_cents: 0, placement_fee_ref: 'extension of ' + (h.booking_ref || r.id),
      deposit: 'none',
    };
    if (h.room_id) b.room_id = h.room_id;
    return b;
  }
  // "Extensions: homestay only" (page extensions-homestay without extensions; never an admin): the Homestay
  // tab only. The database agrees (vm_extension_can_see): co-living requests never reach this browser.
  function homestayOnly(user){
    if (!user || user.role === 'admin') return false;
    const p = Array.isArray(user.allowed_pages) ? user.allowed_pages : [];
    return p.includes('extensions-homestay') && !p.includes('extensions');
  }
  // Homestay-only staff, and homestay staff without co-living Tenants, land on the Homestay tab.
  function defaultKind(user){
    if (homestayOnly(user)) return 'homestay';
    const p = (user && Array.isArray(user.allowed_pages)) ? user.allowed_pages : [];
    return p.some(x => /^homestay-/.test(x)) && !p.includes('tenants') ? 'homestay' : 'coliving';
  }
  window.EXT_CORE = { EX_STATUSES, EX_OPEN, EX_STATUS_LABEL, CT_STATUS, inTab, needsReview, sortOpen, parseRent, actionsFor, hugoBody, hugoNext, yesNo,
    kindOf, statusLabel, hsActionsFor, hsDays, hsCents, hsCreateBody, defaultKind, homestayOnly, HS_PAY_DAYS };
  if (typeof document === 'undefined') return;

  const KIND_KEY = 'vm-ex-kind';
  const S = { kind: '', tab: 'open', q: '', city: '', status: '', owner: '' };
  const curUser = () => (typeof CURRENT_USER !== 'undefined' ? CURRENT_USER : null);
  const kindNow = () => {
    if (homestayOnly(curUser())) return (S.kind = 'homestay');
    if (!S.kind) { let k = ''; try { k = localStorage.getItem(KIND_KEY) || ''; } catch (_) {} S.kind = k === 'homestay' || k === 'coliving' ? k : defaultKind(typeof CURRENT_USER !== 'undefined' ? CURRENT_USER : null); }
    return S.kind;
  };
  let rows = null, loading = null, openSeq = 0;
  const acc = {}; // per-request Accept state: { rent, room_gid, step: null|{kind,message,candidates}, busy }

  const e = (s) => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const toast = (m) => { if (typeof showToast === 'function') showToast(m); };
  const me = () => { const u = (typeof CURRENT_USER !== 'undefined' && CURRENT_USER) || {}; return { email: String(u.email || '').toLowerCase(), role: String(u.role || '') }; };
  const team = () => (typeof teamMembers !== 'undefined' ? teamMembers : []);
  const nameOf = (email) => { const x = String(email || '').toLowerCase(); if (!x) return ''; const m = team().find(t => String(t.email || '').toLowerCase() === x); return m ? (m.name || m.email) : x.split('@')[0]; };
  const money = (n) => (n == null || n === '' || !isFinite(Number(n)) ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-CA'));
  const day = (ymd) => { if (!ymd) return '—'; const d = new Date(String(ymd).slice(0, 10) + 'T12:00:00Z'); return isNaN(d) ? String(ymd) : d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); };
  const when = (ts) => { if (!ts) return '—'; const d = new Date(ts); return isNaN(d) ? String(ts) : d.toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }); };
  const chip = (f) => { const [l, c] = EX_FLAGS[f] || [f, 'blue']; return `<span class="tag-pill ${c}" style="font-size:11px;margin:1px">${e(l)}</span>`; };
  const statusPill = (s, r) => `<span class="tag-pill ${s === 'NEEDS_REVIEW' ? 'red' : EX_OPEN.includes(s) ? 'blue' : ''}" style="font-size:11px">${e(r ? statusLabel(r) : (EX_STATUS_LABEL[s] || s))}</span>`;
  const sb = () => window.vmDb && window.vmDb.sb;
  const contractById = (id) => (window.contracts || []).find(c => c && String(c.id) === String(id)) || null;
  const hugoBase = () => window.ASSISTANTS_BASE || 'https://vanmates-hugo.fly.dev';
  const H = (t) => `<h4 style="margin:22px 0 6px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)">${e(t)}</h4>`;
  const warnBox = (html) => `<div class="tag-pill red" style="display:block;text-transform:none;letter-spacing:0;font-size:13px;line-height:1.45;padding:10px 12px;margin:6px 0">${html}</div>`;

  const SELECT = 'id,email,status,flags,tenant_id,city,house,room,current_rent,current_end,new_end,note,lease_type,room_gid,contract_id,new_rent,owner,data,version,created_at,updated_at,closed_at';

  async function load(force){
    if (loading) return loading;
    if (rows && !force) { render(); return; }
    const body = document.getElementById('ex-body');
    if (!sb()) { if (body) body.innerHTML = `<tr><td colspan="${EX_COLS}" class="name-sub">Not connected to the database.</td></tr>`; return; }
    if (body && !rows) body.innerHTML = `<tr><td colspan="${EX_COLS}" class="name-sub">Loading…</td></tr>`;
    loading = (async () => {
      try {
        const r = await sb().from('extension_requests').select(SELECT).is('deleted_at', null).order('created_at', { ascending: false }).limit(2000);
        if (r.error) throw r.error;
        rows = r.data || [];
        ownerOptions();
        render();
      } catch (err) {
        console.error('[extensions] load failed', err);
        const msg = String(err && err.message || err);
        const missing = /extension_requests/.test(msg) && /exist|schema cache/i.test(msg);
        if (body) body.innerHTML = `<tr><td colspan="${EX_COLS}" class="name-sub">${missing ? 'Extensions are not set up in the database yet (run extension-requests-2026-10-10.sql).' : 'Could not load extensions: ' + e(msg)}</td></tr>`;
      } finally { loading = null; }
    })();
    return loading;
  }

  function ownerOptions(){
    const sel = document.getElementById('ex-filter-owner');
    if (!sel) return;
    const emails = new Set(team().map(m => String(m.email || '').toLowerCase()).filter(Boolean));
    (rows || []).forEach(r => { if (r.owner) emails.add(r.owner); });
    sel.innerHTML = '<option value="">All owners</option><option value="none">Unassigned</option><option value="me">Mine</option>' +
      [...emails].sort((a, b) => nameOf(a).localeCompare(nameOf(b))).map(x => `<option value="${e(x)}">${e(nameOf(x))}</option>`).join('');
    sel.value = S.owner;
  }

  function filtered(){
    const q = S.q.trim().toLowerCase(), m = me().email;
    return (rows || []).filter(r => kindOf(r) === kindNow() && inTab(r, S.tab)
      && (!S.city || String(r.city || '').toLowerCase().startsWith(S.city.toLowerCase().slice(0, 3)))
      && (!S.status || r.status === S.status)
      && (!S.owner || (S.owner === 'none' ? !r.owner : S.owner === 'me' ? r.owner === m : r.owner === S.owner))
      && (!q || [r.id, r.email, r.house, r.room, r.contract_id, (r.data || {}).name].some(v => String(v || '').toLowerCase().includes(q))));
  }

  function render(){
    if (!rows) return;
    const badge = document.querySelector('.nav-item[data-view="extensions"] .nav-count');
    if (badge) badge.textContent = String(needsReview(rows));
    const kind = kindNow();
    const kinds = document.getElementById('ex-kinds');
    if (kinds) kinds.innerHTML = [['coliving', 'Co-living'], ['homestay', 'Homestay']].filter(([k]) => !homestayOnly(curUser()) || k === 'homestay').map(([k, l]) => {
      const n = needsReview(rows.filter(r => kindOf(r) === k));
      return `<button type="button" class="tab${kind === k ? ' active' : ''}" role="tab" aria-selected="${kind === k}" data-ex-kind="${k}">${l}${n ? ` <span class="tag-pill red" style="font-size:11px">${n}</span>` : ''}</button>`;
    }).join('');
    const tabs = document.getElementById('ex-tabs');
    if (tabs) tabs.innerHTML = [['open', 'Open'], ['closed', 'Closed']].map(([k, l]) =>
      `<button type="button" class="tab${S.tab === k ? ' active' : ''}" role="tab" aria-selected="${S.tab === k}" data-ex-tab="${k}">${l} <span class="name-sub">${rows.filter(r => kindOf(r) === kind && inTab(r, k)).length}</span></button>`).join('');
    const head = document.getElementById('ex-head');
    if (head) head.innerHTML = kind === 'homestay'
      ? '<th>Request</th><th>Student</th><th>Host family · room</th><th>Current end → new end</th><th>Weekly rate</th><th>Status · owner</th><th>Flags</th>'
      : '<th>Request</th><th>Tenant</th><th>House · room</th><th>Current end → new end</th><th>Rent</th><th>Status · owner</th><th>Flags</th>';
    const sub = document.getElementById('ex-list-sub');
    if (sub) sub.textContent = kind === 'homestay' ? 'From vanmates.com/extend-stay · Accept emails the student a payment link; the host is secured once they pay' : 'From vanmates.com/extend-stay · Accept sends the contract through Hugo';
    const list = S.tab === 'open' ? sortOpen(filtered()) : filtered();
    const cnt = document.getElementById('ex-count'); if (cnt) cnt.textContent = list.length;
    const empty = document.getElementById('ex-empty'); if (empty) empty.style.display = list.length ? 'none' : '';
    const body = document.getElementById('ex-body');
    if (!body) return;
    body.innerHTML = list.map(r => {
      const d = r.data || {};
      const per = kindOf(r) === 'homestay' ? '<span class="name-sub">/wk</span>' : '';
      const rent = r.new_rent != null && Number(r.new_rent) !== Number(r.current_rent)
        ? `${e(money(r.new_rent))}${per}<div class="name-sub">was ${e(money(r.current_rent))}</div>` : e(money(r.new_rent != null ? r.new_rent : r.current_rent)) + per;
      return `<tr class="clickable" data-ex-open="${e(r.id)}" tabindex="0" style="cursor:pointer">
        <td><b>${e(r.id)}</b><div class="name-sub">${e(day(r.created_at))}</div></td>
        <td>${e(d.name || d.first_name || r.email)}<div class="name-sub">${e(r.email)}</div></td>
        <td>${e([r.house, r.room].filter(Boolean).join(' · ') || '—')}<div class="name-sub">${e(r.city || '')}</div></td>
        <td>${e(day(r.current_end))} → <b>${e(day(r.new_end))}</b>${r.lease_type ? `<div class="name-sub">${e(r.lease_type)}</div>` : ''}</td>
        <td>${rent}</td>
        <td>${statusPill(r.status, r)}<div class="name-sub">${e(nameOf(r.owner) || 'Unassigned')}</div></td>
        <td>${(r.flags || []).map(chip).join(' ')}</td>
      </tr>`;
    }).join('');
  }

  function contractHtml(r){
    if (!r.contract_id) return '';
    const c = contractById(r.contract_id);
    return `${H('Extension contract')}
      <div style="display:grid;gap:6px">
        <div>${e(r.contract_id)}: <b>${e(c ? (CT_STATUS[c.status] || c.status) : 'not loaded in Contracts yet')}</b> · <a href="#" data-ex-goto-contract="${e(r.contract_id)}">open in Contracts</a></div>
        <div class="name-sub">Rent ${e(money(r.new_rent))}/mo until ${e(day(r.new_end))}${r.room_gid ? ` · room held: <a href="https://app.asana.com/0/0/${e(r.room_gid)}" target="_blank" rel="noopener">Asana</a>` : ''}. Hugo voids it and releases the room if it is not signed within 7 days.</div>
      </div>`;
  }

  // Utilities on the tenant's latest signed co-living contract, for the Accept default.
  function utilitiesFromContract(email){
    const lc = (x) => String(x == null ? '' : x).trim().toLowerCase();
    const list = (window.contracts || []).filter(c => c && c.booking && ['customer_signed', 'completed'].includes(c.status)
      && (c.booking.tenants || []).some(t => lc(t.email) === lc(email)));
    list.sort((x, y) => String(y.booking.start || '').localeCompare(String(x.booking.start || '')));
    return list.length ? yesNo(list[0].booking.utilities) : '';
  }

  function acceptHtml(r){
    const a = acc[r.id] || (acc[r.id] = { rent: r.current_rent != null ? String(Math.round(Number(r.current_rent))) : '', utilities: utilitiesFromContract(r.email), room_gid: '', step: null, busy: false });
    const step = a.step;
    let extra = '';
    if (step && step.kind === 'pick_room') {
      extra = `<div style="display:grid;gap:6px;margin-top:4px"><div>${e(step.message)}</div>
        ${step.candidates.map((c, i) => `<label style="display:flex;gap:8px;align-items:center"><input type="radio" name="ex-room" value="${e(c.gid)}" ${(a.room_gid ? a.room_gid === c.gid : i === 0) ? 'checked' : ''}> ${e(c.name || c.gid)}${c.status ? ` <span class="name-sub">${e(c.status)}</span>` : ''}</label>`).join('')}
        <div style="display:flex;justify-content:flex-end"><button class="btn btn-primary" type="button" data-ex-use-room="${e(r.id)}" ${a.busy ? 'disabled' : ''}>Use this room</button></div></div>`;
    } else if (step && step.kind === 'confirm_fixed') {
      extra = `<div style="display:grid;gap:6px;margin-top:4px"><div>${e(step.message)}</div>
        <div style="display:flex;justify-content:flex-end"><button class="btn btn-primary" type="button" data-ex-confirm-fixed="${e(r.id)}" ${a.busy ? 'disabled' : ''}>Yes, make it a fixed lease until ${e(day(r.new_end))}</button></div></div>`;
    } else if (step && step.kind === 'warn') {
      extra = warnBox(e(step.message));
    }
    return `${H('Accept & send contract')}
      <form data-ex-accept="${e(r.id)}" style="display:grid;gap:10px">
        <p class="name-sub" style="margin:0">Hugo checks the room is free until ${e(day(r.new_end))}, emails ${e((r.data || {}).name || r.email)} the extension contract to sign and holds the room for 7 days. Takes about 20 seconds.</p>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <label class="name-sub" style="display:grid;gap:4px;max-width:220px">Rent / month<input class="form-input" name="rent" inputmode="decimal" value="${e(a.rent)}" required></label>
          <label class="name-sub" style="display:grid;gap:4px;max-width:260px">Utilities included<select class="form-input" name="utilities">
            <option value="" ${a.utilities ? '' : 'selected'}>From the tenant record</option>
            <option value="Yes" ${a.utilities === 'Yes' ? 'selected' : ''}>Yes</option>
            <option value="No" ${a.utilities === 'No' ? 'selected' : ''}>No</option></select></label>
        </div>
        ${a.busy ? `<div class="name-sub">Hugo is sending the extension…</div>` : ''}
        ${extra}
        <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-primary" type="submit" ${a.busy ? 'disabled' : ''}>${a.busy ? 'Sending…' : 'Accept &amp; send contract'}</button></div>
      </form>`;
  }

  function declineHtml(r, hs){
    return `${H('Decline')}
      <form data-ex-decline="${e(r.id)}" style="display:grid;gap:10px">
        <label class="name-sub" style="display:grid;gap:4px">Message to the ${hs ? 'student' : 'tenant'} (in the email they get)<textarea class="form-input" name="staff_message" rows="3" maxlength="1000" required placeholder="${hs ? 'e.g. Your host family is travelling in December. We can look for another host family: reply to this email.' : 'e.g. Your room is booked from January. We can offer you another room: reply to this email.'}"></textarea></label>
        <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-ghost" type="submit">Decline</button></div>
      </form>`;
  }

  async function open(id){
    const tok = ++openSeq;
    if (!rows) await load();
    const r = (rows || []).find(x => x.id === id);
    if (!r) { toast('Extension request not found'); return false; }
    if (kindOf(r) !== kindNow()) { S.kind = kindOf(r); render(); }
    const d = r.data || {};
    document.getElementById('panel-hero').textContent = String(d.name || d.first_name || r.email || '?').slice(0, 1).toUpperCase();
    document.getElementById('panel-title').innerHTML = e(d.name || d.first_name || r.email);
    document.getElementById('panel-sub').textContent = `${r.id} · ${[r.house, r.room].filter(Boolean).join(' · ')} · to ${day(r.new_end)}`;
    document.getElementById('panel-meta').innerHTML = statusPill(r.status, r) + ' ' + (r.flags || []).map(chip).join(' ');
    document.getElementById('panel-body').innerHTML = `<div data-ex-tok="${tok}" class="name-sub" style="padding:18px 0">Loading…</div>`;
    document.getElementById('detail-panel').classList.add('open');
    document.getElementById('detail-panel').setAttribute('aria-hidden', 'false');
    document.getElementById('panel-backdrop').classList.add('open');
    document.body.style.overflow = 'hidden';
    const ev = await sb().from('extension_request_events').select('id,at,actor,type,before,after').eq('request_id', id).order('at', { ascending: true });
    if (tok !== openSeq || !document.querySelector(`#panel-body [data-ex-tok="${tok}"]`)) return false;
    paint(r, ev.data || [], tok);
    return true;
  }

  function historyHtml(events){
    return events.map(x => `<div style="padding:6px 0;border-bottom:1px solid var(--line,#eee)"><div class="name-sub">${e(when(x.at))} · ${e(String(x.actor || '').replace(/^(staff|hugo):/, '').replace(/^tenant:.*/, 'student/tenant'))}</div><div>${e(String(x.type || '').replace(/_/g, ' '))}${x.after && x.after.status && (!x.before || x.before.status !== x.after.status) ? ' → ' + e(EX_STATUS_LABEL[x.after.status] || x.after.status) : ''}${x.after && x.after.booking_ref ? ' · ' + e(x.after.booking_ref) : ''}${x.after && x.after.note ? ': ' + e(x.after.note) : ''}</div></div>`).join('') || '<span class="name-sub">No events.</span>';
  }

  function hsAcceptHtml(r){
    const h = (r.data || {}).homestay || {};
    const a = acc[r.id] || (acc[r.id] = { weekly: h.weekly_rate_cents ? String(h.weekly_rate_cents / 100) : '', host: h.host_weekly_cents ? String(h.host_weekly_cents / 100) : '', step: null, busy: false, created: null });
    const days = hsDays(r.current_end, r.new_end);
    const canWrite = !!(window.hbApi && window.hbApi.canWrite());
    let preview = '';
    try {
      const wk = hsCents(a.weekly), hw = hsCents(a.host);
      if (typeof computeHomestaySchedule === 'function' && wk && hw != null) {
        const sc = computeHomestaySchedule({ weeklyRateCents: wk, hostWeeklyCents: hw, moveInDate: String(r.current_end).slice(0, 10), leaseDays: days });
        const first = sc.studentCharges[0], later = sc.studentCharges.length - 1;
        preview = `Student pays $${(first.totalCents / 100).toFixed(2)} to confirm${later ? `, then ${later} more charge${later === 1 ? '' : 's'}` : ''} · host is paid $${(sc.totals.hostTotalCents / 100).toFixed(2)} over the extension · ends ${e(sc.leaseEndDate)}${sc.totals.marginCents < 0 ? ' · <b style="color:#b4443a">THE HOST WOULD BE PAID MORE THAN THE STUDENT</b>' : ''}`;
      }
    } catch (err) { preview = e(err.message || err); }
    const step = a.step;
    const created = a.created;
    return `${H('Accept & send payment link')}
      <form data-ex-hs-accept="${e(r.id)}" style="display:grid;gap:10px">
        <p class="name-sub" style="margin:0">Check with the host family first. Accept creates the extension booking (${e(day(r.current_end))} → ${e(day(r.new_end))}, ${e(days)} days; no placement fee, no new deposit) and emails ${e((r.data || {}).name || r.email)} the payment link. The host is secured once the student pays; unpaid after ${HS_PAY_DAYS} days, the booking is cancelled automatically.</p>
        ${canWrite ? '' : warnBox('Accept needs the full homestay staff token in this browser: open Homestay → Bookings and enter it there, then come back.')}
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <label class="name-sub" style="display:grid;gap:4px;max-width:200px">Student pays / week<input class="form-input" name="weekly" inputmode="decimal" value="${e(a.weekly)}" required></label>
          <label class="name-sub" style="display:grid;gap:4px;max-width:200px">Host is paid / week<input class="form-input" name="host" inputmode="decimal" value="${e(a.host)}" required></label>
        </div>
        ${preview ? `<div class="name-sub">${preview}</div>` : ''}
        ${a.busy ? `<div class="name-sub">Creating the extension booking…</div>` : ''}
        ${step ? warnBox(e(step.message)) : ''}
        ${created ? `<div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-primary" type="button" data-ex-hs-record="${e(r.id)}" ${a.busy ? 'disabled' : ''}>Record ${e(created.booking_ref)} on the request</button></div>`
          : `<div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-primary" type="submit" ${a.busy || !canWrite ? 'disabled' : ''}>${a.busy ? 'Creating…' : 'Accept &amp; send payment link'}</button></div>`}
      </form>`;
  }

  function hsPaymentHtml(r){
    if (!r.contract_id) return '';
    const d = r.data || {};
    const sentAt = d.sent_at ? Date.parse(d.sent_at) : NaN;
    const lapse = isFinite(sentAt) ? new Date(sentAt + HS_PAY_DAYS * 86400000) : null;
    const state = r.status === 'SENT' ? `<b>Awaiting payment</b>${lapse ? ` · lapses ${e(when(lapse.toISOString()))} if unpaid` : ''}`
      : r.status === 'COMPLETED' ? '<b>Paid</b>: the host is secured' : `<b>${e(statusLabel(r))}</b>${d.expired_reason ? ' (' + e(d.expired_reason) + ')' : ''}`;
    return `${H('Extension booking')}
      <div style="display:grid;gap:6px">
        <div>${e(r.contract_id)}: ${state}</div>
        <div class="name-sub">${e(money(r.new_rent))}/wk until ${e(day(r.new_end))} · in Homestay → Bookings</div>
        ${r.status === 'SENT' && d.pay_link ? `<div style="display:flex;gap:8px;align-items:center"><input class="form-input" type="text" readonly value="${e(d.pay_link)}" style="flex:1;min-width:0;font-size:12.5px"><button type="button" class="btn btn-ghost" data-ex-copy="${e(d.pay_link)}">Copy link</button></div>` : ''}
        ${r.status === 'SENT' ? `<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;margin-top:6px"><span class="name-sub">Host can't after all, or the student changed their mind?</span><button class="btn btn-ghost" type="button" data-ex-hs-withdraw="${e(r.id)}">Withdraw &amp; cancel booking</button></div>` : ''}
      </div>`;
  }

  function paintHomestay(r, events, tok){
    const d = r.data || {}, h = d.homestay || {};
    const act = hsActionsFor(r.status);
    const kv = (label, value) => `<div style="display:flex;gap:12px;padding:6px 0;border-bottom:1px solid var(--line,#eee)"><div class="name-sub" style="flex:0 0 38%">${e(label)}</div><div style="flex:1;min-width:0;overflow-wrap:anywhere">${value}</div></div>`;
    const teamOpts = ['<option value="">Unassigned</option>'].concat(team().filter(t => t.email).map(t => `<option value="${e(String(t.email).toLowerCase())}" ${String(t.email).toLowerCase() === r.owner ? 'selected' : ''}>${e(t.name || t.email)}</option>`));
    if (r.owner && !team().some(t => String(t.email || '').toLowerCase() === r.owner)) teamOpts.push(`<option value="${e(r.owner)}" selected>${e(r.owner)}</option>`);
    document.getElementById('panel-body').innerHTML = `<div data-ex-tok="${tok}" data-ex-id="${e(r.id)}">
      ${act.accept ? hsAcceptHtml(r) : ''}
      ${hsPaymentHtml(r)}
      ${act.decline ? declineHtml(r, true) : ''}
      ${act.reopen ? `${H('Declined')}<div style="display:flex;gap:8px;align-items:center;justify-content:space-between"><span class="name-sub">Changed your mind? Reopen it to accept it instead.</span><button class="btn btn-ghost" type="button" data-ex-reopen="${e(r.id)}">Reopen</button></div>` : ''}
      ${H('Request')}
      ${kv('Student', `${e(d.name || '')} <span class="name-sub">${e(r.email)}</span>`)}
      ${kv('Host family', `${e([r.house, r.room].filter(Boolean).join(' · ') || '—')} · ${e(r.city || '')}`)}
      ${kv('Current booking', `${e(h.booking_ref || '—')}${h.move_in ? ` <span class="name-sub">from ${e(day(h.move_in))}</span>` : ''}`)}
      ${kv('Current end', e(day(r.current_end)))}
      ${kv('New end', `<b>${e(day(r.new_end))}</b> <span class="name-sub">(${e(hsDays(r.current_end, r.new_end))} days)</span>`)}
      ${kv('Weekly rate', `${e(money(r.current_rent))}/wk${h.host_weekly_cents ? ` <span class="name-sub">host ${e(money(h.host_weekly_cents / 100))}/wk</span>` : ''}`)}
      ${kv('Meal plan', e(String(h.meal_plan || '—').replace(/_/g, ' ')))}
      ${kv('Student note', r.note ? `<div style="white-space:pre-wrap">${e(r.note)}</div>` : '<span class="name-sub">—</span>')}
      ${d.staff_message ? kv('Message to student', `<div style="white-space:pre-wrap">${e(d.staff_message)}</div>`) : ''}
      ${kv('Language', e(d.lang || 'en'))}
      ${H('Owner and note')}
      <form data-ex-form="${e(r.id)}" style="display:grid;gap:10px">
        <label class="name-sub" style="display:grid;gap:4px">Owner<select class="form-input" name="owner">${teamOpts.join('')}</select></label>
        <label class="name-sub" style="display:grid;gap:4px">Internal note (history only)<input class="form-input" name="note" maxlength="1000" /></label>
        <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-primary" type="submit">Save</button></div>
      </form>
      ${H('History')}
      ${historyHtml(events)}
    </div>`;
  }

  function paint(r, events, tok){
    if (kindOf(r) === 'homestay') return paintHomestay(r, events, tok);
    const d = r.data || {};
    const act = actionsFor(r.status);
    const kv = (label, value) => `<div style="display:flex;gap:12px;padding:6px 0;border-bottom:1px solid var(--line,#eee)"><div class="name-sub" style="flex:0 0 38%">${e(label)}</div><div style="flex:1;min-width:0;overflow-wrap:anywhere">${value}</div></div>`;
    const teamOpts = ['<option value="">Unassigned</option>'].concat(team().filter(t => t.email).map(t => `<option value="${e(String(t.email).toLowerCase())}" ${String(t.email).toLowerCase() === r.owner ? 'selected' : ''}>${e(t.name || t.email)}</option>`));
    if (r.owner && !team().some(t => String(t.email || '').toLowerCase() === r.owner)) teamOpts.push(`<option value="${e(r.owner)}" selected>${e(r.owner)}</option>`);
    document.getElementById('panel-body').innerHTML = `<div data-ex-tok="${tok}" data-ex-id="${e(r.id)}">
      ${(r.flags || []).includes('room_conflict') ? warnBox('Another tenant is booked into this room after the current end date. Check Asana before accepting, or offer a room change (vanmates.com/room-swap).') : ''}
      ${act.accept ? acceptHtml(r) : ''}
      ${contractHtml(r)}
      ${act.decline ? declineHtml(r) : ''}
      ${act.reopen ? `${H('Declined')}<div style="display:flex;gap:8px;align-items:center;justify-content:space-between"><span class="name-sub">Changed your mind? Reopen it to accept it instead.</span><button class="btn btn-ghost" type="button" data-ex-reopen="${e(r.id)}">Reopen</button></div>` : ''}
      ${H('Request')}
      ${kv('Tenant', `${e(d.name || '')} <span class="name-sub">${e(r.email)}</span>`)}
      ${kv('Room', `${e([r.house, r.room].filter(Boolean).join(' · ') || '—')} · ${e(r.city || '')}`)}
      ${kv('Current end', e(day(r.current_end)))}
      ${kv('New end', `<b>${e(day(r.new_end))}</b>`)}
      ${kv('Current rent', e(money(r.current_rent)) + '/mo')}
      ${r.new_rent != null ? kv('Extension rent', e(money(r.new_rent)) + '/mo') : ''}
      ${kv('Lease type', e(r.lease_type || '—'))}
      ${kv('Tenant note', r.note ? `<div style="white-space:pre-wrap">${e(r.note)}</div>` : '<span class="name-sub">—</span>')}
      ${d.staff_message ? kv('Message to tenant', `<div style="white-space:pre-wrap">${e(d.staff_message)}</div>`) : ''}
      ${kv('Language', e(d.lang || 'en'))}
      ${H('Owner and note')}
      <form data-ex-form="${e(r.id)}" style="display:grid;gap:10px">
        <label class="name-sub" style="display:grid;gap:4px">Owner<select class="form-input" name="owner">${teamOpts.join('')}</select></label>
        <label class="name-sub" style="display:grid;gap:4px">Internal note (history only)<input class="form-input" name="note" maxlength="1000" /></label>
        <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn-primary" type="submit">Save</button></div>
      </form>
      ${H('History')}
      ${events.map(x => `<div style="padding:6px 0;border-bottom:1px solid var(--line,#eee)"><div class="name-sub">${e(when(x.at))} · ${e(String(x.actor || '').replace(/^(staff|hugo):/, '').replace(/^tenant:.*/, 'tenant'))}</div><div>${e(String(x.type || '').replace(/_/g, ' '))}${x.after && x.after.status && (!x.before || x.before.status !== x.after.status) ? ' → ' + e(EX_STATUS_LABEL[x.after.status] || x.after.status) : ''}${x.after && x.after.note ? ': ' + e(x.after.note) : ''}</div></div>`).join('') || '<span class="name-sub">No events.</span>'}
    </div>`;
  }

  async function reloadOpen(id){ await load(true); return open(id); }
  async function conflict(id){ toast('Someone else changed this request — reloaded'); await reloadOpen(id); }

  async function staffUpdate(id, patch, okMsg){
    const r = (rows || []).find(x => x.id === id);
    if (!r) return false;
    const { data, error } = await sb().rpc('extension_staff_update', { p: Object.assign({ id, version: r.version }, patch) });
    if (error) { toast('Could not save: ' + (error.message || error)); return false; }
    if (!data || !data.ok) {
      if (data && data.error === 'version_conflict') { await conflict(id); return false; }
      const why = { bad_status: data && data.detail === 'active_exists' ? 'The tenant already has a newer open request.' : 'Not allowed at this status.', forbidden: 'You are not on the team.', not_found: 'Request not found.' };
      toast('Could not save: ' + (why[data && data.error] || (data && data.error) || 'unknown'));
      await reloadOpen(id);
      return false;
    }
    toast(okMsg);
    await reloadOpen(id);
    return true;
  }

  async function token(forceRefresh){
    if (!sb()) return '';
    if (forceRefresh) { try { await sb().auth.refreshSession(); } catch (_) {} }
    try { const { data } = await sb().auth.getSession(); return (data && data.session && data.session.access_token) || ''; } catch (_) { return ''; }
  }

  async function callHugo(body){
    for (let attempt = 0; attempt < 2; attempt++) {
      const tok = await token(attempt > 0);
      if (!tok) return { status: 'error', message: 'Your session expired. Reload the portal and sign in again.' };
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), HUGO_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(hugoBase() + '/api/portal/extension', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
          body: JSON.stringify(body), signal: ctl.signal,
        });
      } catch (err) {
        clearTimeout(t);
        return { status: 'error', message: err && err.name === 'AbortError'
          ? 'Hugo did not answer in time. Do not accept again yet: refresh in a minute — the request may already be Contract sent.'
          : 'Could not reach Hugo: ' + ((err && err.message) || err) };
      }
      clearTimeout(t);
      if (res.status === 401 && attempt === 0) continue;
      let json = null;
      try { json = await res.json(); } catch (_) {}
      if (json && typeof json === 'object' && json.status) return json;
      return { status: 'error', message: (json && (json.message || json.error || json.detail)) || ('Hugo answered HTTP ' + res.status + '.') };
    }
    return { status: 'error', message: 'Hugo refused your session. Reload the portal and try again.' };
  }

  async function accept(id, opts){
    const r = (rows || []).find(x => x.id === id);
    if (!r || r.status !== 'NEEDS_REVIEW') return;
    const a = acc[id];
    if (!a || a.busy) return;
    const form = document.querySelector(`#panel-body [data-ex-accept="${CSS.escape(id)}"]`);
    if (form) { const fd = new FormData(form); a.rent = String(fd.get('rent') || '').trim(); a.utilities = String(fd.get('utilities') || ''); }
    const rent = parseRent(a.rent);
    if (rent == null) { a.step = { kind: 'warn', message: 'Rent must be a positive number of dollars.' }; repaint(id); return; }
    if (opts && opts.room_gid) a.room_gid = opts.room_gid;
    if (!opts && !confirm(`Send ${(r.data || {}).name || r.email} an extension contract until ${day(r.new_end)} at ${money(rent)}/mo?`)) return;
    a.busy = true; a.step = null; repaint(id);
    const res = await callHugo(hugoBody(id, rent, a.room_gid, opts && opts.confirm_fixed, a.utilities));
    a.busy = false;
    const next = hugoNext(res);
    if (next.kind === 'done') {
      delete acc[id];
      toast('Extension contract sent to ' + r.email);
      await reloadOpen(id);
      return;
    }
    a.step = next;
    repaint(id);
  }

  // Records the created booking on the request. Never creates a booking: a failed record keeps
  // acc[id].created, and the drawer offers "Record" (this, again) instead of Accept.
  async function hsRecord(id){
    const a = acc[id];
    if (!a || !a.created) return false;
    let last = null;
    for (let i = 0; i < 3; i++) {
      const { data, error } = await sb().rpc('extension_homestay_staff', { p: { id, action: 'sent', booking_ref: a.created.booking_ref, weekly_rate: a.created.weekly, pay_link: a.created.link } });
      if (!error && data && data.ok) { delete acc[id]; return true; }
      last = error ? (error.message || error) : (data && (data.error + (data.status ? ' (' + data.status + ')' : '')));
      if (data && data.error && data.error !== 'version_conflict') break;
    }
    a.step = { kind: 'warn', message: `Booking ${a.created.booking_ref} was created and the student was emailed the payment link, but it could not be recorded on the request (${last}). Press "Record" again; do not accept again.` };
    return false;
  }

  async function hsAccept(id){
    const r = (rows || []).find(x => x.id === id);
    if (!r || r.status !== 'NEEDS_REVIEW' || kindOf(r) !== 'homestay') return;
    const a = acc[id];
    if (!a || a.busy || a.created) return;
    const form = document.querySelector(`#panel-body [data-ex-hs-accept="${CSS.escape(id)}"]`);
    if (form) { const fd = new FormData(form); a.weekly = String(fd.get('weekly') || '').trim(); a.host = String(fd.get('host') || '').trim(); }
    const wk = hsCents(a.weekly), hw = hsCents(a.host);
    const say = (m) => { a.step = { kind: 'warn', message: m }; repaint(id); };
    if (wk == null) return say('Student weekly rate must be a positive number of dollars.');
    if (hw == null) return say('Host weekly rate must be a positive number of dollars.');
    if (hw > wk) return say('The host would be paid more than the student pays. Fix the rates first.');
    const h = (r.data || {}).homestay || {};
    if (!h.host_id) return say('This request has no host on it (data.homestay.host_id). Create the extension from Homestay → Bookings → Extend instead.');
    if (!window.hbApi || !window.hbApi.canWrite()) return say('Accept needs the full homestay staff token: open Homestay → Bookings and enter it there.');
    const days = hsDays(r.current_end, r.new_end);
    if (!(days >= 7)) return say('The extension must be at least 7 days.');
    // Never create a booking the request cannot record: the RPC must exist (it answers bad_input to a probe).
    const probe = await sb().rpc('extension_homestay_staff', { p: { id, action: 'probe' } });
    if (probe.error || !probe.data || probe.data.error !== 'bad_input') return say('The database is not ready for homestay extensions (run extension-homestay-2026-10-11.sql). Nothing was created.');
    if (!confirm(`Create ${(r.data || {}).name || r.email}'s extension booking ${day(r.current_end)} → ${day(r.new_end)} at ${money(wk / 100)}/wk and email them the payment link?`)) return;
    a.busy = true; a.step = null; repaint(id);
    let d;
    try {
      d = await window.hbApi.post('booking-create', hsCreateBody(r, wk, hw));
    } catch (err) {
      a.busy = false;
      return say('Could not create the booking (' + ((err && err.message) || err) + '). Nothing was sent to the student.');
    }
    if (!d || !d.link || !d.booking_ref) { a.busy = false; return say('n8n answered without a booking (bad room, dates or rates?). Nothing was created.'); }
    a.created = { booking_ref: d.booking_ref, link: d.link, weekly: wk / 100 };
    const ok = await hsRecord(id);
    a.busy = false;
    if (ok) { toast('Payment link sent to ' + r.email + ' (' + d.booking_ref + ')'); await reloadOpen(id); return; }
    repaint(id);
  }

  async function hsWithdraw(id){
    const r = (rows || []).find(x => x.id === id);
    if (!r || r.status !== 'SENT' || kindOf(r) !== 'homestay') return;
    if (!window.hbApi || !window.hbApi.canWrite()) { toast('Withdraw needs the full homestay staff token (Homestay → Bookings).'); return; }
    if (!confirm(`Cancel booking ${r.contract_id} and withdraw the extension offer? The payment link stops working and the student is emailed.`)) return;
    try {
      await window.hbApi.post('booking-cancel', { booking_ref: r.contract_id });
    } catch (err) {
      toast('Could not cancel ' + r.contract_id + ': ' + ((err && err.message) || err));
      return;
    }
    const { data, error } = await sb().rpc('extension_homestay_staff', { p: { id, action: 'expire', version: r.version } });
    if (error || !data || !data.ok) {
      if (data && data.error === 'version_conflict') { await conflict(id); return; }
      toast('Booking cancelled, but the request was not updated (' + (error ? error.message : data && data.error) + '). The sweep will close it within 15 minutes.');
      await reloadOpen(id);
      return;
    }
    toast('Withdrawn: ' + r.contract_id + ' cancelled');
    await reloadOpen(id);
  }

  // Re-render the drawer for a request without refetching (keeps the Accept state).
  async function repaint(id){
    const host = document.querySelector('#panel-body [data-ex-id]');
    if (!host || host.dataset.exId !== id) return;
    const r = (rows || []).find(x => x.id === id);
    if (!r) return;
    const ev = await sb().from('extension_request_events').select('id,at,actor,type,before,after').eq('request_id', id).order('at', { ascending: true });
    const now = document.querySelector('#panel-body [data-ex-id]');
    if (!now || now.dataset.exId !== id) return;
    paint(r, ev.data || [], now.dataset.exTok);
  }

  async function decline(form){
    const id = form.dataset.exDecline;
    const msg = String(new FormData(form).get('staff_message') || '').trim();
    if (!msg) { toast('Write the message the tenant will get.'); return; }
    if (!confirm('Decline ' + id + '? The tenant gets this message by email.')) return;
    const btn = form.querySelector('button[type="submit"]'); if (btn) btn.disabled = true;
    const ok = await staffUpdate(id, { status: 'DECLINED', staff_message: msg }, 'Declined ' + id);
    if (!ok && btn) btn.disabled = false;
  }

  async function save(form){
    const id = form.dataset.exForm;
    const fd = new FormData(form);
    const btn = form.querySelector('button[type="submit"]'); if (btn) btn.disabled = true;
    const ok = await staffUpdate(id, { owner: fd.get('owner') || '', note: String(fd.get('note') || '').trim() }, 'Saved ' + id);
    if (!ok && btn) btn.disabled = false;
  }

  function fromHash(){
    const hash = location.hash || '';
    const m = hash.match(/^#extension=(EX-\d{2}-\d{5})$/);
    if (hash === '#extensions' || m) {
      if (typeof goToView === 'function') goToView('extensions');
      if (m) open(m[1]);
      return true;
    }
    return false;
  }

  window.loadExtensions = load;
  window.openExtension = open;
  window.extensionsFromHash = fromHash;
  window.addEventListener('hashchange', fromHash);

  function wire(){
    const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    const st = document.getElementById('ex-filter-status');
    if (st) st.insertAdjacentHTML('beforeend', EX_STATUSES.map(s => `<option value="${s}">${e(EX_STATUS_LABEL[s])}</option>`).join(''));
    let t = null;
    on('ex-search', 'input', ev => { S.q = ev.target.value; clearTimeout(t); t = setTimeout(render, 150); });
    on('ex-filter-status', 'change', ev => { S.status = ev.target.value; if (S.status) S.tab = EX_OPEN.includes(S.status) ? 'open' : 'closed'; render(); });
    on('ex-filter-owner', 'change', ev => { S.owner = ev.target.value; render(); });
    on('ex-filter-city', 'change', ev => { S.city = ev.target.value; render(); });
    on('ex-refresh', 'click', () => load(true));
    on('ex-tabs', 'click', ev => { const b = ev.target.closest('[data-ex-tab]'); if (b) { S.tab = b.dataset.exTab; render(); } });
    on('ex-kinds', 'click', ev => { const b = ev.target.closest('[data-ex-kind]'); if (b) { S.kind = b.dataset.exKind; try { localStorage.setItem(KIND_KEY, S.kind); } catch (_) {} render(); } });
    on('ex-body', 'click', ev => { const tr = ev.target.closest('[data-ex-open]'); if (tr) open(tr.dataset.exOpen); });
    on('ex-body', 'keydown', ev => { if (ev.key === 'Enter') { const tr = ev.target.closest('[data-ex-open]'); if (tr) open(tr.dataset.exOpen); } });
    const pb = document.getElementById('panel-body');
    if (pb) pb.addEventListener('submit', ev => {
      if (ev.target.matches('[data-ex-hs-accept]')) { ev.preventDefault(); hsAccept(ev.target.dataset.exHsAccept); }
      else if (ev.target.matches('[data-ex-accept]')) { ev.preventDefault(); const a = acc[ev.target.dataset.exAccept]; if (a) { a.room_gid = ''; } accept(ev.target.dataset.exAccept); }
      else if (ev.target.matches('[data-ex-decline]')) { ev.preventDefault(); decline(ev.target); }
      else if (ev.target.matches('[data-ex-form]')) { ev.preventDefault(); save(ev.target); }
    });
    if (pb) pb.addEventListener('change', ev => {
      const f = ev.target.closest('[data-ex-hs-accept]');
      if (!f || !/^(weekly|host)$/.test(ev.target.name)) return;
      const a = acc[f.dataset.exHsAccept]; if (!a) return;
      a[ev.target.name] = String(ev.target.value || '').trim();
      repaint(f.dataset.exHsAccept);
    });
    if (pb) pb.addEventListener('click', ev => {
      const use = ev.target.closest('[data-ex-use-room]');
      if (use) {
        const id = use.dataset.exUseRoom;
        const pick = pb.querySelector('input[name="ex-room"]:checked');
        if (!pick) { toast('Pick a room first.'); return; }
        accept(id, { room_gid: pick.value });
        return;
      }
      const rec = ev.target.closest('[data-ex-hs-record]');
      if (rec) { const id = rec.dataset.exHsRecord, a = acc[id]; if (a && !a.busy) { a.busy = true; repaint(id); hsRecord(id).then(async (ok) => { if (acc[id]) acc[id].busy = false; if (ok) { toast('Recorded'); await reloadOpen(id); } else repaint(id); }); } return; }
      const wd = ev.target.closest('[data-ex-hs-withdraw]');
      if (wd) { hsWithdraw(wd.dataset.exHsWithdraw); return; }
      const cp = ev.target.closest('[data-ex-copy]');
      if (cp) { try { navigator.clipboard.writeText(cp.dataset.exCopy); toast('Payment link copied'); } catch (_) {} return; }
      const fixed = ev.target.closest('[data-ex-confirm-fixed]');
      if (fixed) { accept(fixed.dataset.exConfirmFixed, { confirm_fixed: true }); return; }
      const re = ev.target.closest('[data-ex-reopen]');
      if (re) { staffUpdate(re.dataset.exReopen, { status: 'NEEDS_REVIEW' }, 'Reopened ' + re.dataset.exReopen); return; }
      const a = ev.target.closest('[data-ex-goto-contract]');
      if (!a) return;
      ev.preventDefault();
      if (typeof window.ctOpenFromElsewhere === 'function') window.ctOpenFromElsewhere(a.dataset.exGotoContract);
      else if (typeof goToView === 'function') goToView('contracts');
    });
    // Badge on load, so a new request shows without opening the page.
    setTimeout(() => { if (sb()) load().catch(() => {}); fromHash(); }, 2500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
