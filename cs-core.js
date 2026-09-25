// cs-core.js — pure logic for cs.html (Customer Service inbox). No DOM, no Supabase.
// Tested by test/cs.test.js, which extracts the CS-CORE fence.
/* CS-CORE-START */
var CS_PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
var CS_SOURCE_LABEL = { whatsapp_maya: 'WhatsApp Maya', line_maya: 'LINE Maya', japan_team: 'Japan team', cs_agent: 'Taken back by CS' };
var CS_STATUS_LABEL = { new: 'New', open: 'Open', waiting_customer: 'Waiting for customer', waiting_internal: 'Waiting for internal team', resolved: 'Resolved' };
var CS_OUTCOME_LABEL = { resolved_cs: 'Resolved by CS', returned_maya: 'Returned to Maya', returned_japan_team: 'Returned to Japan team', expired: 'Expired (unclaimed)' };
var CS_ACCOUNT_LABEL = { '559783360556273': 'WhatsApp 672', '1016410864897572': 'WhatsApp 647' };
var CS_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function csT(iso) { var t = iso ? new Date(iso).getTime() : NaN; return isNaN(t) ? null : t; }

// Which work tab a conversation sits in: 'needs_reply' | 'waiting' | 'maya' | null (not shown).
function csTab(c) {
  if (!c) return null;
  if (c.owner_kind === 'cs') {
    if (!c.assignee) return 'needs_reply';
    if (c.status === 'waiting_customer' || c.status === 'waiting_internal') return 'waiting';
    return c.last_message_author === 'staff' ? 'waiting' : 'needs_reply';
  }
  if (c.last_outcome === 'returned_maya' || c.last_outcome === 'returned_japan_team' || c.last_outcome === 'expired') return 'maya';
  return null;
}

// Unread only counts while CS owns the conversation (Maya-tab rows never show a badge).
function csUnread(c, reads) {
  if (!c || c.owner_kind !== 'cs') return 0;
  var r = (reads || {})[c.id] || {};
  return Math.max(0, (c.customer_msg_count || 0) - (r.read_count || 0));
}

function csSort(list, tab, reads) {
  var out = list.slice();
  if (tab === 'needs_reply') {
    out.sort(function (x, y) {
      var ux = csUnread(x, reads) > 0 ? 0 : 1, uy = csUnread(y, reads) > 0 ? 0 : 1;
      if (ux !== uy) return ux - uy;
      var px = CS_PRIORITY_RANK[x.priority] == null ? 2 : CS_PRIORITY_RANK[x.priority];
      var py = CS_PRIORITY_RANK[y.priority] == null ? 2 : CS_PRIORITY_RANK[y.priority];
      if (px !== py) return px - py;
      var tx = csT(x.last_customer_at), ty = csT(y.last_customer_at);
      if (tx === null && ty === null) return 0;
      if (tx === null) return 1;
      if (ty === null) return -1;
      return tx - ty;
    });
  } else {
    out.sort(function (x, y) { return (csT(y.last_message_at) || 0) - (csT(x.last_message_at) || 0); });
  }
  return out;
}

// f: { chip: all|mine|unassigned|unread, platform, agent, status, priority, source, from (YYYY-MM-DD), to, q }
function csFilter(list, f, me, reads) {
  f = f || {};
  var q = String(f.q || '').trim().toLowerCase();
  var qDigits = q.replace(/\D/g, '');
  var from = f.from ? csT(f.from + 'T00:00:00') : null;
  var to = f.to ? csT(f.to + 'T23:59:59') : null;
  var mine = String(me || '').toLowerCase();
  return list.filter(function (c) {
    if (f.chip === 'mine' && String(c.assignee || '').toLowerCase() !== mine) return false;
    if (f.chip === 'unassigned' && c.assignee) return false;
    if (f.chip === 'unread' && csUnread(c, reads) === 0) return false;
    if (f.platform && c.channel !== f.platform) return false;
    if (f.agent && String(c.assignee || '').toLowerCase() !== String(f.agent).toLowerCase()) return false;
    if (f.status && c.status !== f.status) return false;
    if (f.priority && c.priority !== f.priority) return false;
    if (f.source && c.last_source !== f.source) return false;
    var t = csT(c.last_message_at);
    if (from !== null && (t === null || t < from)) return false;
    if (to !== null && (t === null || t > to)) return false;
    if (q) {
      var hay = [c.customer_name, c.last_message_preview, c.customer_email].join(' ').toLowerCase();
      var phone = String(c.customer_phone || '').replace(/\D/g, '');
      if (hay.indexOf(q) === -1 && !(qDigits.length >= 3 && phone.indexOf(qDigits) !== -1)) return false;
    }
    return true;
  });
}

// WhatsApp customer-service window: 24 h after the customer's last message.
function csWindow(lastCustomerAt, now) {
  var t = csT(lastCustomerAt);
  if (t === null) return { open: false, hoursLeft: 0 };
  var left = 24 * 3600000 - (now.getTime() - t);
  if (left <= 0) return { open: false, hoursLeft: 0 };
  return { open: true, hoursLeft: Math.floor(left / 3600000) };
}

function csDuration(ms) {
  if (!(ms >= 60000)) return '<1m';
  var m = Math.floor(ms / 60000);
  if (m < 60) return m + 'm';
  var h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return mm ? h + 'h ' + mm + 'm' : h + 'h';
  var d = Math.floor(h / 24), hh = h % 24;
  return hh ? d + 'd ' + hh + 'h' : d + 'd';
}

function csTook(k, now) {
  var o = csT(k.opened_at), c = csT(k.closed_at);
  if (o === null) return '';
  return c !== null ? csDuration(c - o) : csDuration(now.getTime() - o) + ' so far';
}

function csMedian(arr) {
  if (!arr.length) return null;
  var s = arr.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function csHistoryStats(cases, now) {
  var bySource = {}, resolvedCs = 0, returned = 0, expired = 0, open = 0, firsts = [], resolves = [];
  cases.forEach(function (k) {
    bySource[k.source] = (bySource[k.source] || 0) + 1;
    if (!k.closed_at) open++;
    if (k.outcome === 'resolved_cs') resolvedCs++;
    if (k.outcome === 'returned_maya' || k.outcome === 'returned_japan_team') returned++;
    if (k.outcome === 'expired') expired++;
    var o = csT(k.opened_at), f = csT(k.first_reply_at), c = csT(k.closed_at);
    if (o !== null && f !== null) firsts.push(Math.round((f - o) / 60000));
    if (k.outcome === 'resolved_cs' && o !== null && c !== null) resolves.push(Math.round((c - o) / 60000));
  });
  return { opened: cases.length, bySource: bySource, resolvedCs: resolvedCs,
    pctResolved: cases.length ? Math.round(resolvedCs * 100 / cases.length) : 0,
    returned: returned, expired: expired, open: open,
    medianFirstReplyMin: csMedian(firsts), medianResolveMin: csMedian(resolves) };
}

// Rolling windows (no time-zone day boundaries): today = 24 h, week = 7 d, month = 30 d.
function csPeriodFrom(key, now) {
  var days = { today: 1, week: 7, month: 30 }[key];
  if (!days) return null;
  return new Date(now.getTime() - days * 86400000).toISOString();
}

function csSide(m) {
  if (m.author_kind === 'staff') return 'right';
  if (m.author_kind === 'note' || m.author_kind === 'system') return 'center';
  return 'left';
}

// Collapse the pre-case Maya chat behind "Earlier: N messages" when there are more than 4 of them.
function csSplitEarlier(messages, caseOpenedAt) {
  var t = csT(caseOpenedAt);
  if (t === null) return { earlier: [], shown: messages };
  var earlier = [], shown = [];
  messages.forEach(function (m) {
    if ((csT(m.created_at) || 0) < t && (m.author_kind === 'customer' || m.author_kind === 'maya')) earlier.push(m); else shown.push(m);
  });
  if (earlier.length <= 4) return { earlier: [], shown: messages };
  return { earlier: earlier, shown: shown };
}

function csAgo(iso, now) {
  var t = csT(iso);
  if (t === null) return '';
  var m = Math.floor((now.getTime() - t) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  var h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  if (h < 48) return 'Yesterday';
  var d = Math.floor(h / 24);
  if (d < 7) return d + 'd';
  var dt = new Date(t);
  return CS_MONTHS[dt.getMonth()] + ' ' + dt.getDate();
}

function csFirstName(s) {
  var v = String(s || '').trim();
  if (!v) return '';
  if (v.indexOf('@') !== -1) v = v.split('@')[0];
  v = v.split(/[\s._-]+/)[0];
  return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
}

function csPreview(c) {
  var p = c.last_message_preview || '';
  if (c.last_message_author === 'staff') return 'Team: ' + p;
  if (c.last_message_author === 'maya') return 'Maya: ' + p;
  return p;
}

function csMaskPhone(p) {
  var d = String(p || '').replace(/\D/g, '');
  if (d.length < 7) return String(p || '');
  if (d.length <= 10) return '••• ' + d.slice(-4);
  return '+' + d.slice(0, d.length - 10 > 0 ? d.length - 10 : 1) + ' ••• ' + d.slice(-4);
}

// What the bottom of the chat shows: 'reply' | 'template' (WhatsApp window closed) | 'take_back' (not with CS).
function csComposerMode(c, now) {
  if (!c || c.owner_kind !== 'cs') return 'take_back';
  if (c.channel === 'whatsapp' && !csWindow(c.last_customer_at, now).open) return 'template';
  return 'reply';
}

function csIsMember(m) {
  if (!m) return false;
  if (m.role === 'admin') return true;
  var p = m.allowed_pages;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = []; } }
  return Array.isArray(p) && p.indexOf('cs') !== -1;
}

// The pinned card above the chat: the open case if any, else the newest case.
function csSummaryCard(cases, currentCaseId) {
  if (!cases || !cases.length) return null;
  var k = null;
  for (var i = 0; i < cases.length; i++) if (cases[i].id === currentCaseId) k = cases[i];
  if (!k) k = cases.slice().sort(function (a, b) { return (csT(b.opened_at) || 0) - (csT(a.opened_at) || 0); })[0];
  if (k.source === 'japan_team') return { title: 'Transfer note (Japan team)', body: k.transfer_note || k.topic || '', topic: k.topic || '' };
  if (k.source === 'cs_agent') return { title: 'Taken back by CS', body: k.topic || '', topic: k.topic || '' };
  return { title: "Maya's handoff summary", body: k.ai_summary || k.topic || '', topic: k.topic || '' };
}
function csEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
/* CS-CORE-END */

if (typeof window !== 'undefined') {
  window.CSCore = { csTab: csTab, csUnread: csUnread, csSort: csSort, csFilter: csFilter, csWindow: csWindow, csDuration: csDuration,
    csTook: csTook, csHistoryStats: csHistoryStats, csPeriodFrom: csPeriodFrom, csSide: csSide, csSplitEarlier: csSplitEarlier,
    csAgo: csAgo, csFirstName: csFirstName, csPreview: csPreview, csMaskPhone: csMaskPhone, csComposerMode: csComposerMode,
    csIsMember: csIsMember, csSummaryCard: csSummaryCard, csEsc: csEsc,
    CS_PRIORITY_RANK: CS_PRIORITY_RANK, CS_SOURCE_LABEL: CS_SOURCE_LABEL, CS_STATUS_LABEL: CS_STATUS_LABEL,
    CS_OUTCOME_LABEL: CS_OUTCOME_LABEL, CS_ACCOUNT_LABEL: CS_ACCOUNT_LABEL };
}
