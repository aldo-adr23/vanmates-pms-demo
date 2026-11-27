/* building-notices.js — Arrivals → Notices tab (building-notices-2026-11-27.sql).
   Building arrival notices for Vanmates bookings: list + status, email preview, history, send now / resend / edit /
   cancel / restore / review decisions, and the building contacts ("Contactos Edificios") editor.
   Reads with RLS (Arrivals members), writes only through the building_notice_* / building_contact_save RPCs.
   Loaded by arrivals.html, which calls BuildingNotices.show() on the tab and BuildingNotices.badge() at boot. */
(function () {
  'use strict';
  var RUN_URL = 'https://adr23.app.n8n.cloud/webhook/building-notices-run';
  var TZ = 'America/Toronto';
  var sb = null;
  var S = { view: 'notices', filter: 'upcoming', city: '', q: '', rows: [], contacts: [], settings: null, buildings: [], openId: null,
    log: {}, editing: false, confirm: '', cOpen: null, me: null, seq: 0, setup: true, busy: false };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function str(v) { return v === null || v === undefined ? '' : String(v).trim(); }
  function toast(t) { var el = $('toast'); if (!el) return; el.textContent = t; el.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(function () { el.classList.remove('show'); }, 3500); }
  function client() {
    if (!sb) sb = window.supabase.createClient(window.VM_SUPABASE_URL, window.VM_SUPABASE_KEY, { auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: false } });
    return sb;
  }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function ymd(v) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(v)); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; }
  function shortDate(v) { var d = ymd(v); return d ? DAY[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MON[d.getUTCMonth()] : str(v); }
  function longDate(v) { var d = ymd(v); return d ? DAY[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear() : str(v); }
  function et(iso) {
    if (!iso) return '';
    var d = new Date(iso); if (isNaN(d)) return '';
    return d.toLocaleString('en-CA', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';
  }
  function todayEt() { return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); }

  var STATUS = {
    scheduled: { cls: 'scheduled', label: 'Scheduled' }, sent: { cls: 'sent', label: 'Sent' }, failed: { cls: 'failed', label: 'Failed' },
    cancelled: { cls: 'cancelled', label: 'Cancelled' }, review: { cls: 'missing', label: 'Review required' }
  };
  function live(r) {
    if (r.status === 'scheduled' && r.claimed_at && (Date.now() - new Date(r.claimed_at)) < 10 * 60000) return { cls: 'scheduled', label: 'Sending…' };
    if (r.status === 'scheduled' && r.attempts > 0 && r.last_error) return { cls: 'failed', label: 'Retrying' };
    return STATUS[r.status] || { cls: 'held', label: r.status };
  }
  function chip(r) { var c = live(r); return '<span class="st st-' + esc(c.cls) + '">' + esc(c.label) + '</span>' + (r.changed_after_send ? '<span class="st st-changed sub">Changed after send</span>' : ''); }
  var FILTERS = [['upcoming', 'Scheduled'], ['review', 'Review required'], ['failed', 'Failed'], ['sent', 'Sent'], ['cancelled', 'Cancelled'], ['all', 'All']];
  function matches(r, f) {
    if (S.city && r.city !== S.city) return false;
    if (S.q) {
      var h = [r.client_name, r.building_name, r.building, r.unit, r.building_address].join(' ').toLowerCase();
      if (h.indexOf(S.q.toLowerCase()) === -1) return false;
    }
    if (f === 'all') return true;
    if (f === 'upcoming') return r.status === 'scheduled';
    return r.status === f;
  }

  async function rpc(name, args) {
    try {
      var r = await client().rpc(name, args);
      if (r.error) { toast(r.error.message || 'Not saved.'); return null; }
      if (!r.data || !r.data.ok) { toast((r.data && r.data.error) || 'Not saved.'); return null; }
      return r.data;
    } catch (e) { toast('Can’t reach the server — check your connection.'); return null; }
  }
  function kick() { try { fetch(RUN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"reason":"portal"}' }).catch(function () {}); } catch (e) {} }

  // ───────── load ─────────
  async function load() {
    var seq = ++S.seq, c = client();
    if (!S.rows.length) $('bnList').innerHTML = '<div class="empty card">Loading…</div>';
    var from = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
    var res;
    try {
      res = await Promise.all([
        c.from('building_notices').select('*').gte('arrival_date', from).order('arrival_date', { ascending: true }).order('client_name', { ascending: true }).limit(2000),
        c.from('building_contacts').select('*').order('name'),
        c.from('building_notice_settings').select('*').eq('id', 1),
        c.from('access_buildings').select('building,city').order('building'),
        c.auth.getUser().then(function (u) { var id = u && u.data && u.data.user && u.data.user.id; return id ? c.from('team_members').select('email,role').eq('id', id) : { data: [] }; })
      ]);
    } catch (e) { res = [{ error: e }]; }
    if (seq !== S.seq) return;
    var bad = res.filter(function (x) { return x && x.error; })[0];
    if (bad) {
      var msg = String((bad.error && bad.error.message) || bad.error || '');
      S.setup = !/building_notices|does not exist|schema cache/i.test(msg);
      $('bnList').innerHTML = S.setup ? '<div class="gate card">Could not load notices: ' + esc(msg) + '</div>'
        : '<div class="empty card"><b>Building notices are being set up</b>They appear here once the building notices update is applied.</div>';
      $('bnChips').innerHTML = ''; $('bnPanel').innerHTML = ''; $('bnBanner').innerHTML = '';
      return;
    }
    S.rows = res[0].data || []; S.contacts = res[1].data || []; S.settings = (res[2].data || [])[0] || null;
    S.buildings = (res[3].data || []).map(function (b) { return b.building; });
    S.me = (res[4].data || [])[0] || null;
    if (S.openId && !byId(S.openId)) S.openId = null;
    render();
    paintBadge();
  }
  function byId(id) { for (var i = 0; i < S.rows.length; i++) if (S.rows[i].id === id) return S.rows[i]; return null; }
  async function loadLog(id) {
    var r = await client().from('building_notice_log').select('at,actor,action,detail').eq('notice_id', id).order('at', { ascending: false }).limit(100);
    S.log[id] = r.error ? [] : (r.data || []);
    if (S.openId === id) renderPanel();
  }

  // ───────── render ─────────
  function render() {
    $('bnSeg').innerHTML = '<button type="button" data-bv="notices" class="' + (S.view === 'notices' ? 'on' : '') + '">Notices</button>' +
      '<button type="button" data-bv="contacts" class="' + (S.view === 'contacts' ? 'on' : '') + '">Building contacts <span class="tbadge"' + (S.contacts.length ? '' : ' hidden') + '>' + S.contacts.length + '</span></button>';
    var off = S.settings && !S.settings.enabled;
    $('bnBanner').innerHTML = off ? '<p class="warnbox tstat"><span><b>Automatic sending is off.</b> Notices are scheduled and checked, but nothing is emailed until it’s switched on.</span>' +
      (isAdmin() ? '<button type="button" class="btn btn-primary" data-bn="switch-on">Switch on</button>' : '') + '</p>' : '';
    $('bnNotices').hidden = S.view !== 'notices';
    $('bnContacts').hidden = S.view !== 'contacts';
    if (S.view === 'contacts') { renderContacts(); return; }
    $('bnChips').innerHTML = FILTERS.map(function (f) {
      var n = S.rows.filter(function (r) { return matches(r, f[0]); }).length;
      return '<button type="button" class="chip' + (S.filter === f[0] ? ' on' : '') + '" data-bf="' + f[0] + '">' + esc(f[1]) + ' <span class="n">' + n + '</span></button>';
    }).join('');
    var list = S.rows.filter(function (r) { return matches(r, S.filter); });
    if (S.filter === 'sent' || S.filter === 'cancelled') list = list.slice().reverse();
    if (!list.length) {
      $('bnList').innerHTML = '<div class="empty card"><b>' + (S.rows.length ? 'Nothing in this filter' : 'No building notices yet') + '</b>' +
        (S.rows.length ? 'Try another status.' : 'Vanmates bookings at the buildings in Building contacts show here, one notice per arrival.') + '</div>';
    } else {
      var groups = [], last = null;
      list.forEach(function (r) { var k = str(r.arrival_date).slice(0, 10); if (!last || last.k !== k) { last = { k: k, rows: [] }; groups.push(last); } last.rows.push(r); });
      $('bnList').innerHTML = groups.map(function (g) {
        return '<section class="grp card"><div class="ghead"><b>' + esc(longDate(g.k)) + '</b><span class="muted">' + g.rows.length + ' arrival' + (g.rows.length === 1 ? '' : 's') +
          (g.k === todayEt() ? ' · today' : '') + '</span></div>' + g.rows.map(function (r) {
          return '<button type="button" class="arow' + (r.id === S.openId ? ' on' : '') + '" data-bid="' + esc(r.id) + '">' +
            '<span class="c-who"><b>' + esc(r.client_name || '(no name)') + '</b><small>' + esc(r.booking_kind === 'unknown' && !r.staff_decision ? 'Source unclear' : (r.school || (r.source === 'contract' ? 'Vanmates contract' : r.source))) + '</small></span>' +
            '<span class="c-room">' + esc(r.building_name + (r.unit ? ' · Unit ' + r.unit : '')) + '</span>' +
            '<span class="c-date">' + esc(r.status === 'sent' ? 'Sent ' + et(r.sent_at) : r.status === 'scheduled' ? et(r.scheduled_at) : (r.review_reason || r.cancel_reason || r.last_error || '')) + '</span>' +
            '<span class="c-chip">' + chip(r) + '</span></button>';
        }).join('') + '</section>';
      }).join('');
    }
    renderPanel();
  }
  function isAdmin() { return !!(S.me && S.me.role === 'admin'); }

  function renderPanel() {
    var r = S.openId ? byId(S.openId) : null;
    if (document.body.dataset.tab === 'notices') document.body.dataset.panel = r || S.cOpen ? 'open' : '';
    if (!r) { $('bnPanel').innerHTML = '<div class="empty"><b>Pick a notice</b>See the email the building gets, its history, and send, edit or cancel it.</div>'; return; }
    var facts = [
      ['Resident', r.client_name], ['Building', r.building_name + (r.building && r.building !== r.building_name ? ' (' + r.building + ')' : '')],
      ['Address', r.building_address], ['Unit', r.unit], ['Arrival', longDate(r.arrival_date)],
      ['To', (r.status === 'sent' && r.sent_to && r.sent_to.length ? r.sent_to : r.recipients || []).join(', ')],
      ['Sends', r.status === 'scheduled' ? et(r.scheduled_at) + (r.requested_by ? ' (sent now by ' + r.requested_by + ')' : '') : ''],
      ['Sent', r.sent_at ? et(r.sent_at) + (r.sent_by ? ' by ' + r.sent_by : '') + (r.send_count > 1 ? ' · sent ' + r.send_count + '×' : '') : ''],
      ['Booking', r.booking_kind === 'unknown' ? (r.staff_decision === 'vanmates' ? 'Vanmates booking (staff confirmed)' : r.staff_decision === 'school' ? 'School student (staff)' : 'Source unclear') : 'Vanmates booking · ' + (r.school || r.source)],
      ['Error', r.last_error]
    ].filter(function (f) { return str(f[1]); });

    var warn = '';
    if (r.status === 'review') warn = '<p class="warnbox">' + esc(r.review_reason) + '</p>';
    else if (r.status === 'failed') warn = '<p class="warnbox bad">Not sent: ' + esc(r.last_error || 'unknown error') + '</p>';
    else if (r.status === 'cancelled') warn = '<p class="warnbox">Cancelled — ' + esc(r.cancel_reason) + (r.cancelled_by ? ' (by ' + esc(r.cancelled_by) + ')' : '') + '</p>';
    else if (r.changed_after_send) warn = '<p class="warnbox">The booking changed after this notice was sent. Check the details and resend if the building needs to know.</p>';

    var acts = [];
    if (r.status === 'review' && r.booking_kind === 'unknown' && !r.staff_decision) {
      acts.push('<button type="button" class="btn btn-primary" data-bn="decide-vanmates">It’s a Vanmates booking</button>');
      acts.push('<button type="button" class="btn btn-ghost" data-bn="decide-school">School student — don’t send</button>');
    }
    if (r.status === 'scheduled' || r.status === 'failed') acts.push('<button type="button" class="btn btn-primary" data-bn="send">' + (r.status === 'failed' ? 'Retry now' : 'Send now') + '</button>');
    if (r.status === 'sent') acts.push('<button type="button" class="btn btn-ghost" data-bn="resend">Resend</button>');
    if (r.status !== 'cancelled' && r.status !== 'sent' && !S.editing) acts.push('<button type="button" class="btn btn-ghost" data-bn="edit">Edit text</button>');
    if (r.custom && r.status !== 'sent') acts.push('<button type="button" class="btn btn-ghost" data-bn="reset">Use the standard text</button>');
    if (r.status !== 'cancelled' && r.status !== 'sent') acts.push(S.confirm === 'cancel' ? '<button type="button" class="btn btn-primary" data-bn="cancel-yes">Yes, cancel it</button><button type="button" class="btn btn-ghost" data-bn="cancel-no">Keep</button>'
      : '<button type="button" class="btn btn-ghost" data-bn="cancel">Cancel notice</button>');
    if (r.status === 'cancelled') acts.push('<button type="button" class="btn btn-ghost" data-bn="restore">Restore</button>');
    if (r.status === 'review' && /contact/i.test(r.review_reason)) acts.push('<button type="button" class="btn btn-ghost" data-bn="contact" data-cid="' + esc(r.contact_id || '') + '">Fix the building contact</button>');

    var pv = S.editing
      ? '<form class="fx" id="bnEdit"><div class="fh"><span>Edit this notice</span><small>Name, unit and date only — no emails or phone numbers</small></div>' +
        '<div style="display:grid;gap:6px"><input class="inp" name="subject" value="' + esc(r.subject) + '" aria-label="Subject" />' +
        '<textarea class="inp" name="body" rows="12" aria-label="Text">' + esc(r.body) + '</textarea>' +
        '<div class="frow"><button class="btn btn-primary" type="submit">Save text</button><button class="btn btn-ghost" type="button" data-bn="edit-cancel">Cancel</button></div></div>' +
        '<div class="hint">If the arrival date, building or unit changes later, the standard text comes back with the new details.</div></form>'
      : '<div class="pv-head"><b>Email preview</b><span class="muted" style="font-size:12px">' + (r.custom ? 'edited text' : 'standard text') + '</span></div>' +
        '<div class="pv-subj">Subject: ' + esc(r.subject) + '</div>' +
        '<pre class="bn-pv">' + esc(r.body) + '</pre>';

    var log = S.log[r.id];
    var hist = '<div class="sendsec"><h3>History</h3>' + (log === undefined ? '<p class="muted">Loading…</p>' : !log.length ? '<p class="muted">Nothing yet.</p>' :
      '<ul class="sends">' + log.map(function (l) {
        var d = l.detail || {}, cls = /sent/.test(l.action) && !/requested/.test(l.action) ? ' send-opened' : /fail|error/.test(l.action) ? ' send-failed' : '';
        var extra = d.error || d.reason || (d.to ? 'to ' + [].concat(d.to).join(', ') : '') || (d.kind ? d.kind : '') || (d.status ? d.status + (d.was ? ' (was ' + d.was + ')' : '') : '');
        return '<li class="send' + cls + '"><b>' + esc(LOGL[l.action] || l.action) + '</b><span>' + esc(et(l.at) + ' · ' + (l.actor || 'system') + (extra ? ' · ' + extra : '')) + '</span></li>';
      }).join('') + '</ul>') + '</div>';

    $('bnPanel').innerHTML = '<div class="pin"><div class="ph"><div class="who"><div class="pname">' + esc(r.client_name || '(no name)') + '</div>' +
      '<div class="psub">' + esc(r.building_name + (r.unit ? ' · Unit ' + r.unit : '') + ' · ' + shortDate(r.arrival_date)) + '</div><div style="margin-top:6px">' + chip(r) + '</div></div>' +
      '<button type="button" class="pclose" data-bn="close" aria-label="Close">✕</button></div>' +
      '<dl class="facts">' + facts.map(function (f) { return '<dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd>'; }).join('') + '</dl>' +
      warn + '<div class="pact">' + acts.join('') + '</div>' + pv + hist +
      '<p class="note">Building management only ever gets the resident’s name, unit and arrival date — never an email address or phone number.</p></div>';
    if (log === undefined) loadLog(r.id);
  }
  var LOGL = { created: 'Notice created', updated: 'Updated from the booking', reopened: 'Reopened', cancelled: 'Cancelled', restored: 'Restored',
    decided: 'Booking type decided', text_edited: 'Text edited', text_reset: 'Standard text restored', send_requested: 'Send now requested',
    resend_requested: 'Resend requested', sent: 'Sent', resent: 'Resent', send_error: 'Send attempt failed', failed: 'Failed',
    changed_after_send: 'Booking changed after send' };

  // ───────── contacts ─────────
  function renderContacts() {
    $('bnPanel').innerHTML = '';
    var c = S.cOpen;
    var used = {};
    S.contacts.forEach(function (x) { if (x.active) (x.buildings || []).forEach(function (b) { used[b.toLowerCase()] = x.name; }); });
    var cards = S.contacts.map(function (x) {
      return '<button type="button" class="arow bn-c' + (c && c.id === x.id ? ' on' : '') + '" data-cid="' + esc(x.id) + '">' +
        '<span class="c-who"><b>' + esc(x.name) + '</b><small>' + esc(x.city || '') + '</small></span>' +
        '<span class="c-room">' + esc((x.emails || []).join(', ') || 'No email yet') + '</span>' +
        '<span class="c-date">' + esc((x.buildings || []).join(', ')) + '</span>' +
        '<span class="c-chip"><span class="st st-' + (!x.active ? 'cancelled">Off' : (x.emails || []).length ? 'ready">Active' : 'missing">No email') + '</span></span></button>';
    }).join('');
    $('bnContactList').innerHTML = '<section class="grp card"><div class="ghead"><b>Building management contacts</b><span class="muted">' + S.contacts.length + ' buildings · from “Contactos Edificios”</span></div>' +
      (cards || '<div class="empty">No contacts yet.</div>') + '</section>';
    if (!c) {
      $('bnContactPanel').innerHTML = '<div class="empty"><b>Pick a building</b>Change who gets the notices, or add a building with <i>Add building</i>.</div>';
      if (document.body.dataset.tab === 'notices') document.body.dataset.panel = '';
      return;
    }
    if (document.body.dataset.tab === 'notices') document.body.dataset.panel = 'open';
    var opts = S.buildings.filter(function (b) { return !used[b.toLowerCase()] || (c.buildings || []).some(function (x) { return x.toLowerCase() === b.toLowerCase(); }); });
    $('bnContactPanel').innerHTML = '<div class="pin"><div class="ph"><div class="who"><div class="pname">' + esc(c.id ? c.name : 'New building contact') + '</div>' +
      '<div class="psub">Notices go to every email below at 07:00 ET on the arrival day.</div></div><button type="button" class="pclose" data-bn="cclose" aria-label="Close">✕</button></div>' +
      '<form id="bnContactForm" class="tf" style="display:grid;gap:10px;margin-top:12px">' +
      '<label class="fl"><span>Name in the email subject</span><input class="inp" name="name" value="' + esc(c.name || '') + '" required /></label>' +
      '<label class="fl"><span>City</span><select class="sel" name="city">' + ['', 'Toronto', 'Montréal', 'Vancouver'].map(function (x) { return '<option' + (x === (c.city || '') ? ' selected' : '') + ' value="' + esc(x) + '">' + esc(x || '—') + '</option>'; }).join('') + '</select></label>' +
      '<label class="fl"><span>Address (used when the Arrivals building has none)</span><input class="inp" name="address" value="' + esc(c.address || '') + '" /></label>' +
      '<label class="fl"><span>Management emails — one per line</span><textarea class="inp" name="emails" rows="3" spellcheck="false">' + esc((c.emails || []).join('\n')) + '</textarea></label>' +
      '<fieldset class="fx"><div class="fh"><span>Arrivals buildings it covers</span><small>' + esc((c.buildings || []).length) + ' picked</small></div><div class="fucov">' +
      opts.map(function (b) { var on = (c.buildings || []).some(function (x) { return x.toLowerCase() === b.toLowerCase(); }); return '<label><input type="checkbox" name="b" value="' + esc(b) + '"' + (on ? ' checked' : '') + ' /> ' + esc(b) + '</label>'; }).join('') +
      '</div></fieldset>' +
      '<label class="fl"><span>Note</span><input class="inp" name="note" value="' + esc(c.note || '') + '" /></label>' +
      '<label style="display:flex;gap:8px;align-items:center;font-weight:600"><input type="checkbox" name="active"' + (c.active === false ? '' : ' checked') + ' /> Send notices for this building</label>' +
      '<div class="frow"><button class="btn btn-primary" type="submit">Save contact</button><button class="btn btn-ghost" type="button" data-bn="cclose">Cancel</button></div>' +
      '<p class="note">Saving re-checks every upcoming arrival in these buildings: new notices are scheduled, ones without an email go to Review required.</p></form></div>';
  }
  async function saveContact(form) {
    var c = S.cOpen; if (!c) return;
    var el = form.elements;
    var emails = el.emails.value.split(/[\s,;]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    var bld = Array.prototype.filter.call(form.querySelectorAll('input[name=b]'), function (x) { return x.checked; }).map(function (x) { return x.value; });
    var btn = form.querySelector('[type=submit]'); btn.disabled = true;
    var ok = await rpc('building_contact_save', { p_id: c.id || null, p_name: el.name.value.trim(), p_city: el.city.value, p_address: el.address.value.trim(),
      p_emails: emails, p_buildings: bld, p_active: el.active.checked, p_note: el.note.value.trim() });
    btn.disabled = false;
    if (ok) { toast('Contact saved — upcoming notices updated'); S.cOpen = null; await load(); }
  }

  // ───────── actions ─────────
  async function act(a, el) {
    var r = byId(S.openId);
    if (a === 'close') { S.openId = null; S.editing = false; S.confirm = ''; render(); return; }
    if (a === 'cclose') { S.cOpen = null; renderContacts(); return; }
    if (a === 'switch-on') {
      if (!S.settings) return;
      if (await rpc('building_notice_settings_save', { p_alert_to: S.settings.alert_to, p_reply_to: S.settings.reply_to, p_enabled: true })) { toast('Automatic sending is on'); kick(); await load(); }
      return;
    }
    if (a === 'contact') { S.view = 'contacts'; S.cOpen = S.contacts.filter(function (x) { return x.id === el.getAttribute('data-cid'); })[0] || null; render(); return; }
    if (!r || S.busy) return;
    if (a === 'edit') { S.editing = true; renderPanel(); return; }
    if (a === 'edit-cancel') { S.editing = false; renderPanel(); return; }
    if (a === 'cancel') { S.confirm = 'cancel'; renderPanel(); return; }
    if (a === 'cancel-no') { S.confirm = ''; renderPanel(); return; }
    S.busy = true;
    var done = null;
    try {
      if (a === 'send' || a === 'resend') {
        done = await rpc('building_notice_send_now', { p_id: r.id, p_resend: a === 'resend' });
        if (done) { kick(); toast('Sending to ' + (r.recipients || []).join(', ') + '…'); setTimeout(function () { delete S.log[r.id]; load(); }, 6000); }
      } else if (a === 'reset') done = await rpc('building_notice_reset_text', { p_id: r.id });
      else if (a === 'cancel-yes') { done = await rpc('building_notice_cancel', { p_id: r.id, p_reason: '' }); S.confirm = ''; }
      else if (a === 'restore') { done = await rpc('building_notice_restore', { p_id: r.id }); if (done && done.status !== 'scheduled') toast('Restored, now ' + (STATUS[done.status] || {}).label + (done.reason ? ': ' + done.reason : '')); }
      else if (a === 'decide-vanmates' || a === 'decide-school') done = await rpc('building_notice_decide', { p_id: r.id, p_kind: a === 'decide-school' ? 'school' : 'vanmates' });
    } finally { S.busy = false; }
    if (done) { delete S.log[r.id]; await load(); }
  }
  async function saveText(form) {
    var r = byId(S.openId); if (!r) return;
    var btn = form.querySelector('[type=submit]'); btn.disabled = true;
    var ok = await rpc('building_notice_edit', { p_id: r.id, p_subject: form.elements.subject.value, p_body: form.elements.body.value });
    btn.disabled = false;
    if (ok) { S.editing = false; delete S.log[r.id]; toast('Text saved'); await load(); }
  }

  var wired = false;
  function wire() {
    if (wired) return; wired = true;
    var root = $('v-notices');
    root.addEventListener('click', function (e) {
      var t;
      if ((t = e.target.closest('[data-bv]'))) { S.view = t.getAttribute('data-bv'); S.openId = null; S.cOpen = null; render(); return; }
      if ((t = e.target.closest('[data-bf]'))) { S.filter = t.getAttribute('data-bf'); render(); return; }
      if ((t = e.target.closest('[data-bid]'))) { S.openId = t.getAttribute('data-bid'); S.editing = false; S.confirm = ''; render(); if (!window.matchMedia('(max-width: 899px)').matches) $('bnPanel').scrollTop = 0; return; }
      if ((t = e.target.closest('.bn-c[data-cid]'))) { S.cOpen = S.contacts.filter(function (x) { return x.id === t.getAttribute('data-cid'); })[0] || null; renderContacts(); return; }
      if ((t = e.target.closest('[data-bn]'))) { act(t.getAttribute('data-bn'), t); return; }
      if (e.target.closest('#bnAdd')) { S.cOpen = { id: null, name: '', city: '', address: '', emails: [], buildings: [], active: true, note: '' }; renderContacts(); }
    });
    root.addEventListener('submit', function (e) {
      e.preventDefault();
      if (e.target.id === 'bnEdit') saveText(e.target);
      else if (e.target.id === 'bnContactForm') saveContact(e.target);
    });
    $('bnCity').addEventListener('change', function () { S.city = this.value; render(); });
    $('bnQ').addEventListener('input', function () { S.q = this.value.trim(); render(); });
    $('bnRefresh').addEventListener('click', function () { S.log = {}; load(); });
  }

  async function paintBadge() {
    var el = $('bnBadge'); if (!el) return;
    try {
      var to = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
      var r = S.rows.length ? { data: S.rows } : await client().from('building_notices').select('id,status,arrival_date').in('status', ['review', 'failed']).lte('arrival_date', to);
      var n = (r.data || []).filter(function (x) { return (x.status === 'review' || x.status === 'failed') && str(x.arrival_date).slice(0, 10) <= to && str(x.arrival_date).slice(0, 10) >= todayEt(); }).length;
      el.textContent = n; el.hidden = !n; el.title = n + ' building notice' + (n === 1 ? '' : 's') + ' need attention (next 14 days)';
    } catch (e) { el.hidden = true; }
  }

  window.BuildingNotices = {
    show: function () { wire(); load(); },
    badge: paintBadge,
    closePanel: function () { if (S.cOpen) { S.cOpen = null; renderContacts(); return true; } if (S.openId) { S.openId = null; render(); return true; } return false; },
    // for tests
    _S: S, _matches: matches, _live: live
  };
})();
