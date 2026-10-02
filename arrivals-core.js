// arrivals-core.js — pure logic for arrivals.html (roster arrival emails). No DOM, no Supabase.
// Tested by test/arrivals-core.test.js and test/arrivals-email.test.js.
//
// The email shell below (brand tokens, blocks, renderEmail) is a VERBATIM copy of the Vanmates
// email template, scripts/n8n/email-template.js ("Brand tokens" through renderEmail). The n8n
// "Portal - Arrivals Send" workflow pastes this same builder, so the portal preview is the email
// that gets sent. test/arrivals-email.test.js fails if the paste drifts by a single byte.
// Never edit the paste here: change email-template.js and re-paste.
//
// Wrapped in an IIFE so the paste's top-level names (T, row, chip, ...) never leak into the page.
(function () {
/* ARR-CORE-START */
/* ---- Brand tokens ------------------------------------------------------ */

/* Mirrors the :root palette in index.html, with two deliberate departures,
   both forced by email rather than taste:

   • muted is #7A6E5E here, not the portal's #8A7B6C. Footer and label text is
     12-13px, where WCAG AA wants 4.5:1. On the #FFFDF8 card the portal value
     lands near 3.9:1 and this one clears 5:1. The lighter token is fine at the
     portal's larger sizes and not fine here.
   • card is #FFFDF8, not the portal's #FFFFFF. Pure white against the cream
     page reads as a seam in every client that honours the background.

   Both values are already in the two emails that were branded by hand, so this
   codifies what is being sent today rather than changing it. */
const T = {
  cream:  "#FAF5ED",
  card:   "#FFFDF8",
  line:   "#E4DBC9",
  ink:    "#2B211A",
  muted:  "#7A6E5E",
  red:    "#B94A3F",
  green:  "#5C8A6B",
  amber:  "#C8923A",
  amberSoft: "#F4E5C7",
  greenSoft: "#E2EDDF",

  /* Neither webfont loads in Gmail, Outlook or Apple Mail — they are declared
     so the handful of clients that do honour them match the site, and the
     fallbacks are chosen to degrade to the right shape rather than the right
     name: a transitional serif for headings, a neutral grotesque for body. */
  serif: "'Playfair Display', Georgia, 'Times New Roman', serif",
  sans:  "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
};

/* Status chips. The tone carries the colour; the heading's italic emphasis
   stays brand red in every email, so a host scanning an inbox sees one
   consistent sender rather than eight differently-coloured ones. */
const TONES = {
  good:  { fg: "#3F6B4E", bg: T.greenSoft, bd: "#CBDFC7" },
  warn:  { fg: "#8A6420", bg: T.amberSoft, bd: "#E8D3A4" },
  brand: { fg: T.red,     bg: "#F3DDD8",   bd: "#E7C6BE" }
};

const PAD = "0 36px";

/* ---- Blocks ------------------------------------------------------------ */

/* Every block returns a full <tr>. Composing at row level rather than nesting
   divs is what keeps Outlook's Word renderer honest: it drops most of what a
   div can do and almost none of what a table row can. */
const row = (inner, pad) => `<tr><td style="padding:${pad}">${inner}</td></tr>`;

/* Hidden first line. Without it the client previews whatever text comes first,
   which for a table-based email is usually nothing at all. */
function preheader(text) {
  return `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${T.cream};font-size:1px;line-height:1px">${text}</div>`;
}

function logo() {
  return row(
    `<a href="https://vanmates.com/" style="text-decoration:none;color:${T.red};font-family:${T.serif};font-size:22px;font-weight:700;letter-spacing:-0.01em">vanmates</a>`,
    "32px 36px 0"
  );
}

function chip(tone, label) {
  const c = TONES[tone] || TONES.brand;
  return row(
    `<span style="display:inline-block;padding:5px 12px;border-radius:999px;background:${c.bg};border:1px solid ${c.bd};color:${c.fg};font-family:${T.sans};font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase">${label}</span>`,
    "18px 36px 0"
  );
}

/* The heading accepts one *emphasised* span, marked with asterisks, rendered
   as the italic red clause the two hand-built emails already use. */
function heading(text) {
  const html = text.replace(
    /\*(.+?)\*/g,
    `<span style="color:${T.red};font-style:italic;font-weight:500">$1</span>`
  );
  return row(
    `<h1 style="margin:0;font-family:${T.serif};font-size:28px;line-height:1.18;font-weight:600;color:${T.ink}">${html}</h1>`,
    "12px 36px 0"
  );
}

function paragraphs(list) {
  const html = list
    .map(p => `<p style="margin:0 0 12px;font-size:16px;line-height:1.55;color:${T.ink}">${p}</p>`)
    .join("");
  return row(html, "16px 36px 0");
}

/* Label/value pairs. Right-aligned values give the amounts a common edge, so
   a host comparing two payout emails can see at a glance which is larger. */
function details(pairs) {
  const body = pairs.map(([label, value], i) => {
    const bt = i === 0 ? "" : `border-top:1px solid ${T.line};`;
    return `<tr>
      <td style="${bt}padding:9px 0;color:${T.muted};font-size:14px;line-height:1.5">${label}</td>
      <td align="right" style="${bt}padding:9px 0;color:${T.ink};font-size:14px;line-height:1.5;font-weight:600">${value}</td>
    </tr>`;
  }).join("");
  return row(
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-family:${T.sans};border-top:1px solid ${T.line};border-bottom:1px solid ${T.line}">${body}</table>`,
    "20px 36px 0"
  );
}

/* The one line the reader must not miss — "nothing for you to do", "your place
   is not affected". A left rule rather than a filled panel: it survives dark
   mode inversion legibly, where a tinted block often does not. */
function notice(tone, text) {
  const c = TONES[tone] || TONES.warn;
  return row(
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr><td style="border-left:3px solid ${c.fg};padding:2px 0 2px 14px">
        <p style="margin:0;font-size:15px;line-height:1.55;color:${T.ink}">${text}</p>
      </td></tr>
    </table>`,
    "20px 36px 0"
  );
}

/* Pill button. Outlook squares the corners off — border-radius is unsupported
   there — which is why the colour and padding sit on the <td>, not the <a>:
   the shape degrades, the target does not shrink. */
function cta(label, url) {
  return row(
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr><td bgcolor="${T.red}" style="background:${T.red};border-radius:999px">
        <a href="${url}" style="display:inline-block;padding:13px 26px;font-family:${T.sans};font-size:15px;font-weight:600;color:#FFFDF8;text-decoration:none">${label}</a>
      </td></tr>
    </table>`,
    "24px 36px 0"
  );
}

function footnote(text) {
  return row(
    `<p style="margin:0;font-size:13px;line-height:1.5;color:${T.muted}">${text}</p>`,
    "18px 36px 0"
  );
}

/* The lead sentence is per-email, not fixed. Several of these emails already
   end with their own "just reply and we will help" line, and a template that
   always prepends a second one produces two reply-to-us sentences back to back
   — which is how a designed system starts reading as a mail merge. Pass
   `signoff: { lead: null }` where the copy above already covers it. */
function signoff(spec) {
  const lead = (spec && typeof spec === "object")
    ? spec.lead
    : "If anything looks wrong, just reply to this email.";
  const leadHtml = lead ? `${lead}<br>` : "";
  return row(
    `<p style="margin:0;font-size:15px;line-height:1.55;color:${T.ink}">${leadHtml}<span style="font-family:${T.serif};font-size:17px;color:${T.red};font-weight:600;font-style:italic">— The Vanmates team</span></p>`,
    "24px 36px 0"
  );
}

function footer() {
  return row(
    `<p style="margin:0;font-size:12px;line-height:1.6;color:${T.muted}">Vanmates Accommodation Inc. &middot; Vancouver, BC &middot; <a href="mailto:hello@vanmates.com" style="color:${T.muted}">hello@vanmates.com</a></p>`,
    "24px 36px 28px"
  );
}

/* ---- Shell ------------------------------------------------------------- */

/* bgcolor is set alongside every background style because Outlook reads the
   attribute and ignores the property; without it the card floats on white. */
function renderEmail(spec) {
  const blocks = [logo()];
  if (spec.chip) blocks.push(chip(spec.chip.tone, spec.chip.label));
  blocks.push(heading(spec.heading));
  if (spec.intro && spec.intro.length) blocks.push(paragraphs(spec.intro));
  if (spec.rows && spec.rows.length) blocks.push(details(spec.rows));
  /* The button normally follows the explanation. It moves ahead of it when the
     copy refers to the button — "please use the button above" printed above the
     button is the kind of error that survives review because each half reads
     correctly on its own. */
  if (spec.ctaBeforeBody && spec.cta) blocks.push(cta(spec.cta.label, spec.cta.url));
  if (spec.body && spec.body.length) blocks.push(paragraphs(spec.body));
  if (spec.notice) blocks.push(notice(spec.notice.tone, spec.notice.text));
  if (!spec.ctaBeforeBody && spec.cta) blocks.push(cta(spec.cta.label, spec.cta.url));
  if (spec.footnote) blocks.push(footnote(spec.footnote));
  if (spec.signoff !== false) blocks.push(signoff(spec.signoff));
  blocks.push(row(`<div style="border-top:1px solid ${T.line};font-size:0;line-height:0">&nbsp;</div>`, "28px 36px 0"));
  blocks.push(footer());

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${spec.subject}</title></head>
<body style="margin:0;padding:0;background:${T.cream};font-family:${T.sans};color:${T.ink};-webkit-font-smoothing:antialiased">
${preheader(spec.preheader)}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${T.cream}" style="background:${T.cream}">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" bgcolor="${T.card}" style="max-width:600px;width:100%;background:${T.card};border:1px solid ${T.line};border-radius:14px">
${blocks.join("\n")}
</table>
</td></tr>
</table>
</body></html>`;
}

/* ---- END email-template paste ---------------------------------------- */

/* ---- Helpers ------------------------------------------------------------ */

function escapeHtml(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function str(v) { return v === null || v === undefined ? "" : String(v).trim(); }

function titleCase(w) { return w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : ""; }

// "Zz Testperson" -> "Zz"; roster style "TESTPERSON, ZZANN MARIE" -> "Zzann"; ALL CAPS is title-cased.
function firstName(name) {
  var s = str(name);
  if (!s) return "";
  if (s.indexOf(",") !== -1) s = str(s.slice(s.indexOf(",") + 1)) || str(s.split(",")[0]);
  var w = s.split(/\s+/)[0] || "";
  return (w === w.toUpperCase() && w !== w.toLowerCase()) ? titleCase(w) : w;
}

// access may be flat {address, house_code, wifi_name, wifi_password, door_code, room_label}
// or nested {building:{address,house_code}, unit:{wifi_name,wifi_password}, room:{door_code,room_label}}.
var ACCESS_FIELDS = ["address", "house_code", "wifi_name", "wifi_password", "door_code", "room_label"];
function flattenAccess(access) {
  var a = access || {}, out = {};
  var parts = [a, a.building, a.unit, a.room];
  ACCESS_FIELDS.forEach(function (f) {
    out[f] = "";
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p && typeof p === "object" && str(p[f])) { out[f] = str(p[f]); break; }
    }
  });
  return out;
}

function safeUrl(u) { var s = str(u); return /^https?:\/\//i.test(s) ? s : ""; }

var ARR_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
var ARR_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// 'YYYY-MM-DD' (or ISO) -> Date at UTC midnight, or null.
function ymdDate(v) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(v));
  if (!m) return null;
  var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return isNaN(d.getTime()) ? null : d;
}
function ymd(d) {
  return d.getUTCFullYear() + "-" + ("0" + (d.getUTCMonth() + 1)).slice(-2) + "-" + ("0" + d.getUTCDate()).slice(-2);
}
// "Saturday 3 October 2026"; unparseable input is shown as given.
function longDate(v) {
  var d = ymdDate(v);
  if (!d) return str(v);
  return ARR_DAYS[d.getUTCDay()] + " " + d.getUTCDate() + " " + ARR_MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear();
}

/* ---- Readiness (mirrors SQL view arrivals_v) ----------------------------- */

// missing, in this order: email, door_code (waived when template.keys_only), wifi (network name; waived when
// template.wifi_in_unit: the Wi-Fi is posted in the apartment),
// template (absent or not reviewed), address.
var MISSING_ORDER = ["email", "door_code", "wifi", "template", "address"];
var MISSING_LABEL = { email: "email", door_code: "door code", wifi: "Wi-Fi", template: "template not reviewed", address: "address" };
function missingLabel(k) { return MISSING_LABEL[k] || String(k); }

function readiness(arrival, template, access) {
  var a = arrival || {}, t = template || null, acc = flattenAccess(access);
  var missing = [];
  if (!str(a.student_email)) missing.push("email");
  if (!(t && t.keys_only) && !acc.door_code) missing.push("door_code");
  if (!(t && t.wifi_in_unit) && !acc.wifi_name) missing.push("wifi");
  if (!(t && t.reviewed)) missing.push("template");
  if (!acc.address) missing.push("address");
  return { ready: missing.length === 0, missing: missing };
}

/* ---- Email --------------------------------------------------------------- */

var ARR_NOTICE = "Please don't share your access codes with anyone. If you have trouble getting in, message our team.";
var ARR_KEYS_ONLY = "Use your key/FOB";
var ARR_CTA = "Read & accept the house rules";

function fill(text, vars) {
  return String(text || "").replace(/\{(first_name|building)\}/g, function (_, k) { return vars[k]; });
}
function paras(text) {
  return String(text || "").replace(/\r\n/g, "\n").split(/\n\s*\n/).map(str).filter(Boolean);
}
function nl2br(escaped) { return escaped.replace(/\n/g, "<br>"); }

// The plain (unescaped) content of one arrival email. Both the HTML spec and the text part come from it.
function arrivalEmailParts(arrival, template, access) {
  var a = arrival || {}, t = template || {}, acc = flattenAccess(access);
  var building = str(a.building) || str(t.building);
  var first = firstName(a.student_name);
  var vars = { first_name: first || "there", building: building };
  var intro = paras(fill(str(t.intro) ? t.intro : "Hi {first_name}, welcome to Vanmates! Here is everything you need for your arrival at {building}.", vars));

  var checkin = a.arrival_date ? longDate(a.arrival_date) + (str(t.checkin_time) ? ", from " + str(t.checkin_time) : "") : "";
  var checkout = a.checkout_date ? longDate(a.checkout_date) + (str(t.checkout_time) ? ", by " + str(t.checkout_time) : "") : "";
  var rows = [
    ["Address", acc.address],
    ["Check-in", checkin],
    ["Check-out", checkout],
    ["Apartment", str(a.unit)],
    ["Wi-Fi network", acc.wifi_name],
    ["Wi-Fi password", acc.wifi_password],
    ["Room", acc.room_label || str(a.bed)],
    ["Bedroom door code", t.keys_only ? ARR_KEYS_ONLY : acc.door_code],
    ["House code", acc.house_code]
  ].filter(function (r) { return r[1]; });

  var sections = [];
  if (str(t.checkin_text)) sections.push({ title: "Checking in", text: String(t.checkin_text).trim() });
  (Array.isArray(t.sections) ? t.sections : []).forEach(function (s) {
    if (s && (str(s.title) || str(s.text))) sections.push({ title: str(s.title), text: String(s.text || "").trim() });
  });

  var subject = fill(str(t.subject) || "Welcome to {building}: your check-in details", vars);
  return {
    subject: subject, building: building, intro: intro, rows: rows, sections: sections,
    rulesUrl: safeUrl(t.rules_url), docsUrl: safeUrl(t.docs_url)
  };
}

// The renderEmail spec (every value HTML-escaped).
function arrivalEmailSpec(arrival, template, access) {
  var p = arrivalEmailParts(arrival, template, access);
  var spec = {
    subject: escapeHtml(p.subject),
    preheader: escapeHtml("Your check-in details for " + p.building + "."),
    chip: { tone: "brand", label: "Arrival details" },
    heading: "Welcome to *" + escapeHtml(p.building).replace(/\*/g, "&#42;") + "*",
    intro: p.intro.map(function (x) { return nl2br(escapeHtml(x)); }),
    rows: p.rows.map(function (r) { return [escapeHtml(r[0]), escapeHtml(r[1])]; }),
    body: p.sections.map(function (s) {
      var title = s.title ? "<strong>" + escapeHtml(s.title) + "</strong>" : "";
      var text = nl2br(escapeHtml(s.text));
      return title && text ? title + "<br>" + text : title + text;
    }),
    notice: { tone: "warn", text: escapeHtml(ARR_NOTICE) }
  };
  if (p.docsUrl) {
    var u = escapeHtml(p.docsUrl);
    spec.body.push('Building documents: <a href="' + u + '" style="color:' + T.red + '">' + u + "</a>");
  }
  if (p.rulesUrl) spec.cta = { label: escapeHtml(ARR_CTA), url: escapeHtml(p.rulesUrl) };
  return spec;
}

function arrivalEmailText(p) {
  var out = ["Welcome to " + p.building, ""];
  p.intro.forEach(function (x) { out.push(x, ""); });
  p.rows.forEach(function (r) { out.push(r[0] + ": " + r[1]); });
  out.push("");
  p.sections.forEach(function (s) { out.push((s.title ? s.title + "\n" : "") + s.text, ""); });
  if (p.docsUrl) out.push("Building documents: " + p.docsUrl, "");
  out.push(ARR_NOTICE, "");
  if (p.rulesUrl) out.push(ARR_CTA + ": " + p.rulesUrl, "");
  out.push("If anything looks wrong, just reply to this email.", "— The Vanmates team");
  return out.join("\n");
}

// -> { subject, html, text }. opts.pixelBase (e.g. https://…/webhook/arrivals-open) adds the open pixel.
function buildArrivalEmail(arrival, template, access, opts) {
  var a = arrival || {}, o = opts || {};
  var p = arrivalEmailParts(a, template, access);
  var html = renderEmail(arrivalEmailSpec(a, template, access));
  var base = str(o.pixelBase).replace(/\/+$/, "");
  var token = str(a.open_token);
  if (base && token) {
    var src = escapeHtml(base + "/" + encodeURIComponent(token) + ".gif");
    var k = html.lastIndexOf("</body>");
    html = html.slice(0, k) + '<img src="' + src + '" width="1" height="1" alt="" style="display:block;border:0">\n' + html.slice(k);
  }
  return { subject: p.subject, html: html, text: arrivalEmailText(p) };
}

/* ---- Week picker (Tue-Mon window around the weekend, labelled by its Saturday) --- */

var ARR_MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var ARR_DAY3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function addDays(d, n) { return new Date(d.getTime() + n * 86400000); }
function dayMon(d) { return ARR_DAY3[d.getUTCDay()] + " " + d.getUTCDate() + " " + ARR_MON3[d.getUTCMonth()]; }
// The window is Saturday - 4 (Tue) .. Saturday + 2 (Mon), so every day belongs to exactly one weekend
// (the same one weekendOf picks, and the same Saturday the SQL series_key uses).
function weekendFromSaturday(sat) {
  var start = addDays(sat, -4), end = addDays(sat, 2);
  var title = "Weekend of " + dayMon(sat), range = dayMon(start) + " \u2013 " + dayMon(end);
  return { saturday: ymd(sat), start: ymd(start), end: ymd(end), title: title, range: range, label: title + " (" + range + ")" };
}
// date: 'YYYY-MM-DD' or Date (local calendar date). Fri-Mon belong to their own weekend; Tue-Thu roll
// forward to the coming one. Default view = weekendOf(new Date()).
function weekendOf(date) {
  var d = date instanceof Date ? new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) : ymdDate(date);
  if (!d) return null;
  var dow = d.getUTCDay(); // 0 Sun .. 6 Sat
  var back = { 5: -1, 6: 0, 0: 1, 1: 2 }[dow];
  var sat = back !== undefined ? addDays(d, -back) : addDays(d, 6 - dow);
  return weekendFromSaturday(sat);
}
function shiftWeekend(wk, n) { return weekendFromSaturday(addDays(ymdDate(wk.saturday), 7 * (n || 0))); }
function inWeekend(arrival, wk) {
  var d = str(arrival && arrival.arrival_date).slice(0, 10);
  return !!d && !!wk && d >= wk.start && d <= wk.end;
}

/* ---- Grouping, counts, chips -------------------------------------------- */

function cmpNat(x, y) { return String(x || "").localeCompare(String(y || ""), "en", { numeric: true, sensitivity: "base" }); }

// -> [{ building, city, arrivals:[...] }], buildings A-Z, arrivals by date, unit, bed, name.
function groupByBuilding(arrivals) {
  var map = {}, order = [];
  (arrivals || []).forEach(function (a) {
    var b = str(a.building) || "(no building)";
    if (!map[b]) { map[b] = { building: b, city: str(a.city), arrivals: [] }; order.push(b); }
    map[b].arrivals.push(a);
  });
  order.sort(function (x, y) {
    if (x === "(no building)") return 1;
    if (y === "(no building)") return -1;
    return cmpNat(x, y);
  });
  return order.map(function (b) {
    var g = map[b];
    g.arrivals.sort(function (x, y) {
      return cmpNat(x.arrival_date, y.arrival_date) || cmpNat(x.unit, y.unit) || cmpNat(x.bed, y.bed) || cmpNat(x.student_name, y.student_name);
    });
    return g;
  });
}

// arriving excludes cancelled; sent counts everything sent (opened included); opened is a subset of sent.
function counts(arrivals) {
  var c = { arriving: 0, ready: 0, missing: 0, sent: 0, opened: 0, failed: 0 };
  (arrivals || []).forEach(function (a) {
    if (a.status === "cancelled") return;
    c.arriving++;
    if (a.status === "ready") c.ready++;
    else if (a.status === "missing") c.missing++;
    else if (a.status === "failed") c.failed++;
    else if (a.status === "sent") { c.sent++; if (a.opened_at) c.opened++; }
  });
  return c;
}

// "Send all ready": ready rows still on the latest roster (a dropped one is sent one at a time, on purpose).
function batchReady(arrivals) {
  return (arrivals || []).filter(function (a) { return a && a.status === "ready" && !a.not_in_latest_roster; });
}

function statusChip(a) {
  a = a || {};
  var s = a.status;
  if (s === "cancelled") return { cls: "cancelled", label: "Cancelled" };
  if (a.not_in_latest_roster && s !== "handled") return { cls: "dropped", label: "Not in latest roster" };
  if (a.changed_after_send) return { cls: "changed", label: "Changed after send" };
  if (s === "sent") return a.opened_at ? { cls: "opened", label: "Opened" } : { cls: "sent", label: "Sent" };
  if (s === "ready") return { cls: "ready", label: "Ready" };
  if (s === "failed") return { cls: "failed", label: "Failed" };
  if (s === "handled") return { cls: "handled", label: "Handled" };
  if (s === "missing") {
    var m = Array.isArray(a.missing) ? a.missing : [];
    return { cls: "missing", label: m.length ? "Missing: " + m.map(missingLabel).join(", ") : "Missing info" };
  }
  return { cls: "missing", label: String(s || "Unknown") };
}
/* ARR-CORE-END */
/* ---- Upload roster: linked-workbook caches --------------------------------
   Outside the ARR-CORE fence on purpose: that fence is pasted verbatim into the
   n8n "Portal - Arrivals Send" workflow (n8n/arrivals/gen.js), which has no use
   for this; keeping it out leaves that live workflow unchanged.
   Kaplan rosters keep a full cached copy of a LINKED workbook in
   xl/externalLinks/externalLink1.xml (~100 MB inflated, so the .xlsx is ~9 MB
   while the roster itself is < 0.5 MB). stripExternalLinks drops
   xl/externalLinks/** without inflating them (fflate unzip filter) plus their
   references, so the upload fits the webhook's 3,000,000-char cap. Same logic
   as Limpio functions/_lib/rosters/strip.mjs (stripExternalLinksWith). ff =
   fflate (arrivals.html loads it lazily); anything else -> the same bytes. */
function stripExternalLinks(ff, bytes) {
  try {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!(u.length > 4 && u[0] === 0x50 && u[1] === 0x4b && u[2] === 0x03 && u[3] === 0x04)) return bytes;
    let dropped = 0;
    const files = ff.unzipSync(u, { filter: f => (String(f.name).indexOf('xl/externalLinks/') === 0 ? (dropped++, false) : true) });
    if (!dropped) return bytes;
    const dec = s => ff.strFromU8(s);
    const enc = s => ff.strToU8(s);
    const edit = (name, fn) => { if (files[name]) files[name] = enc(fn(dec(files[name]))); };
    edit('xl/_rels/workbook.xml.rels', x => x.replace(/<(\w+:)?Relationship\b[^>]*?(externalLinks\/|\/externalLink")[^>]*?\/>/g, ''));
    edit('[Content_Types].xml', x => x.replace(/<(\w+:)?Override\b[^>]*?PartName="\/xl\/externalLinks\/[^>]*?\/>/g, ''));
    edit('xl/workbook.xml', x => x.replace(/<(\w+:)?externalReferences\b[^>]*?\/>/g, '')
      .replace(/<(\w+:)?externalReferences\b[\s\S]*?<\/(\w+:)?externalReferences>/g, ''));
    return ff.zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) });   // fixed time: same file -> same bytes (sha256)
  } catch (e) { return bytes; }
}

function bytesToBase64(bytes) {
  var bin = "";
  for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}


var ArrCore = {
  buildArrivalEmail: buildArrivalEmail, arrivalEmailSpec: arrivalEmailSpec, renderEmail: renderEmail,
  readiness: readiness, flattenAccess: flattenAccess, missingLabel: missingLabel,
  groupByBuilding: groupByBuilding, weekendOf: weekendOf, shiftWeekend: shiftWeekend, inWeekend: inWeekend,
  counts: counts, statusChip: statusChip, batchReady: batchReady, firstName: firstName, escapeHtml: escapeHtml, longDate: longDate,
  MISSING_ORDER: MISSING_ORDER, ARR_NOTICE: ARR_NOTICE,
  stripExternalLinks: stripExternalLinks, bytesToBase64: bytesToBase64
};
if (typeof window !== "undefined") window.ArrCore = ArrCore;
if (typeof module !== "undefined" && module.exports) module.exports = ArrCore;
})();
