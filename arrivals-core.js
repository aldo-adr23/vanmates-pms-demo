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

// access may be flat {address, house_code, wifi_name, wifi_password, unit_note, door_code, room_label, room_note,
// unit_door_code, buzzer, floor, whatsapp_url, checkin_video_url, contact_url, bed_type}
// or nested {building:{address,house_code,checkin_video_url,contact_url}, unit:{wifi_name,wifi_password,unit_note,
// door_code,buzzer,floor,whatsapp_url}, room:{door_code,room_label,room_note,bed_type}}.
// Two door codes: the room's door_code is the bedroom code (door_code); the unit's door_code (access_units.door_code,
// the apartment / house main door) is unit_door_code. A nested unit's door_code never becomes the bedroom code.
var ACCESS_FIELDS = ["address", "house_code", "wifi_name", "wifi_password", "door_code", "room_label", "unit_note", "room_note",
  "unit_door_code", "buzzer", "floor", "whatsapp_url", "checkin_video_url", "contact_url", "bed_type"];
function accessValue(p, f, isUnit) {
  if (!p || typeof p !== "object") return "";
  if (isUnit && f === "door_code") return "";
  if (isUnit && f === "unit_door_code") return str(p.unit_door_code) || str(p.door_code);
  return str(p[f]);
}
function flattenAccess(access) {
  var a = access || {}, out = {};
  var parts = [a, a.building, a.unit, a.room];
  ACCESS_FIELDS.forEach(function (f) {
    out[f] = "";
    for (var i = 0; i < parts.length; i++) {
      var v = accessValue(parts[i], f, i === 2);
      if (v) { out[f] = v; break; }
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
var ARR_VIDEO = "Watch the check-in video";

// Placeholders in template text: {first_name} {building} {unit} {room} {address} {move_in} {move_out} {lease_type}
// {booking_ref} {whatsapp_url} {contact_url}. A placeholder the vars don't carry (any other {word}) is left as written.
// fill() works on plain text; HTML is escaped afterwards. fillMarked() also wraps a value that is a whole http(s) URL
// in two private-use characters, so the HTML part (htmlOf) can make exactly that value a link while the plain part
// (plainOf) prints it as is. Those characters are stripped from every input first, so only fillMarked can place them.
var MK_A = "\uE000", MK_B = "\uE001", MK_RE = /[\uE000\uE001]/g;
function fillWith(text, vars, mark) {
  return String(text || "").replace(MK_RE, "").replace(/\{([a-z_]+)\}/g, function (m, k) {
    if (!vars || !Object.prototype.hasOwnProperty.call(vars, k) || vars[k] === null || vars[k] === undefined) return m;
    var v = String(vars[k]).replace(MK_RE, "");
    return mark && /^https?:\/\/\S+$/i.test(v) ? MK_A + v + MK_B : v;
  });
}
function fill(text, vars) { return fillWith(text, vars, false); }
function fillMarked(text, vars) { return fillWith(text, vars, true); }
function plainOf(s) { return String(s || "").replace(MK_RE, ""); }
function mkLink(u) { return '<a href="' + u + '" style="color:' + T.red + '">' + u + "</a>"; }
function htmlOf(s) {
  return nl2br(escapeHtml(s)).replace(/\uE000([^\uE000\uE001]*)\uE001/g, function (_, u) {
    return /^https?:\/\/\S+$/i.test(u) ? mkLink(u) : u;
  }).replace(MK_RE, "");
}
// The placeholder values for one arrival-like row (any of the message views); acc = flattenAccess(...).
// No code or Wi-Fi value is ever a placeholder.
function fillVars(a, building, acc) {
  return {
    first_name: firstName(a.student_name) || "there", building: building, unit: str(a.unit),
    room: acc.room_label || str(a.bed), address: acc.address,
    move_in: str(a.arrival_date) ? longDate(a.arrival_date) : "", move_out: str(a.checkout_date) ? longDate(a.checkout_date) : "",
    lease_type: str(a.lease_type), booking_ref: str(a.booking_ref),
    whatsapp_url: acc.whatsapp_url, contact_url: acc.contact_url
  };
}
// marked = fillMarked output (or plain text): -> { title, text (plain), html (escaped, line breaks, links) }.
function mkSection(title, marked) { return { title: title, text: plainOf(marked), html: htmlOf(marked) }; }
function paras(text) {
  return String(text || "").replace(/\r\n/g, "\n").split(/\n\s*\n/).map(str).filter(Boolean);
}
function nl2br(escaped) { return escaped.replace(/\n/g, "<br>"); }
function sectionHtml(s) {
  var title = s.title ? "<strong>" + escapeHtml(s.title) + "</strong>" : "";
  return title && s.html ? title + "<br>" + s.html : title + s.html;
}

// The plain (unescaped) content of one arrival email (plus the HTML of the template text: introHtml, sections[].html).
// Both the HTML spec and the text part come from it.
function arrivalEmailParts(arrival, template, access) {
  var a = arrival || {}, t = template || {}, acc = flattenAccess(access);
  var building = str(a.building) || str(t.building);
  var vars = fillVars(a, building, acc);
  var intro = paras(fillMarked(str(t.intro) ? t.intro : "Hi {first_name}, welcome to Vanmates! Here is everything you need for your arrival at {building}.", vars));

  var checkin = a.arrival_date ? longDate(a.arrival_date) + (str(t.checkin_time) ? ", from " + str(t.checkin_time) : "") : "";
  var checkout = a.checkout_date ? longDate(a.checkout_date) + (str(t.checkout_time) ? ", by " + str(t.checkout_time) : "") : "";
  // Zoho's self check-in step order: the street, the buzzer, the floor, the apartment and its door, the building
  // code, the room and its door, then the Wi-Fi.
  var rows = [
    ["Address", acc.address],
    ["Check-in", checkin],
    ["Check-out", checkout],
    ["Buzzer", acc.buzzer],
    ["Floor", acc.floor],
    ["Apartment", str(a.unit)],
    ["Apartment door code", acc.unit_door_code],
    ["House code", acc.house_code],
    ["Room", acc.room_label || str(a.bed)],
    ["Bedroom door code", t.keys_only ? ARR_KEYS_ONLY : acc.door_code],
    ["Wi-Fi network", acc.wifi_name],
    ["Wi-Fi password", acc.wifi_password]
  ].filter(function (r) { return r[1]; });

  // Per-apartment / per-room notes (access_units.unit_note, access_rooms.room_note) open the body, before the
  // building template's shared content. Notes are data, not template text: no placeholders.
  var sections = [];
  if (acc.unit_note) sections.push(mkSection("Apartment note", plainOf(acc.unit_note)));
  if (acc.room_note) sections.push(mkSection("Room note", plainOf(acc.room_note)));
  if (str(t.checkin_text)) sections.push(mkSection("Checking in", fillMarked(String(t.checkin_text).trim(), vars)));
  (Array.isArray(t.sections) ? t.sections : []).forEach(function (s) {
    if (s && (str(s.title) || str(s.text))) sections.push(mkSection(str(s.title), fillMarked(String(s.text || "").trim(), vars)));
  });

  var subject = fill(str(t.subject) || "Welcome to {building}: your check-in details", vars);
  return {
    subject: subject, building: building, intro: intro.map(plainOf), introHtml: intro.map(htmlOf), rows: rows, sections: sections,
    videoUrl: safeUrl(acc.checkin_video_url), rulesUrl: safeUrl(t.rules_url), docsUrl: safeUrl(t.docs_url)
  };
}

// The renderEmail spec (every value HTML-escaped).
function arrivalEmailSpec(arrival, template, access) {
  var p = arrivalEmailParts(arrival, template, access);
  var body = p.sections.map(sectionHtml);
  // The check-in video goes after the notes, right before the template's "Checking in" text.
  if (p.videoUrl) {
    var notes = p.sections.filter(function (s) { return s.title === "Apartment note" || s.title === "Room note"; }).length;
    body.splice(notes, 0, escapeHtml(ARR_VIDEO) + ": " + mkLink(escapeHtml(p.videoUrl)));
  }
  var spec = {
    subject: escapeHtml(p.subject),
    preheader: escapeHtml("Your check-in details for " + p.building + "."),
    chip: { tone: "brand", label: "Arrival details" },
    heading: "Welcome to *" + escapeHtml(p.building).replace(/\*/g, "&#42;") + "*",
    intro: p.introHtml,
    rows: p.rows.map(function (r) { return [escapeHtml(r[0]), escapeHtml(r[1])]; }),
    body: body,
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
  var notes = p.sections.filter(function (s) { return s.title === "Apartment note" || s.title === "Room note"; }).length;
  p.sections.forEach(function (s, i) {
    if (i === notes && p.videoUrl) out.push(ARR_VIDEO + ": " + p.videoUrl, "");
    out.push((s.title ? s.title + "\n" : "") + s.text, "");
  });
  if (p.videoUrl && notes >= p.sections.length) out.push(ARR_VIDEO + ": " + p.videoUrl, "");
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
/* CO-CORE-START */
/* ---- Check-out email (automatic move-out message) -------------------------
   Pasted by the n8n check-out workflow right AFTER the ARR-CORE paste: it reuses
   renderEmail, T, escapeHtml, str, firstName, ymdDate, fill, paras, nl2br and the
   day/month names from there. Input is one checkout_messages_v row (SQL
   moveout-messages-2026-10-02.sql). Tested by test/moveout-email.test.js. */

var CO_MISSING_ORDER = ["email", "checkout_date", "template"];
var CO_MISSING_LABEL = { email: "email", checkout_date: "move-out date", template: "check-out template not reviewed" };
function checkoutMissingLabel(k) { return CO_MISSING_LABEL[k] || String(k); }

// Mirrors SQL _checkout_missing: email, checkout_date, template (absent or not reviewed).
function checkoutReadiness(row) {
  var r = row || {}, missing = [];
  if (!str(r.student_email)) missing.push("email");
  if (!str(r.checkout_date)) missing.push("checkout_date");
  if (!(r.template_reviewed === true || r.template_reviewed === "true")) missing.push("template");
  return { ready: missing.length === 0, missing: missing };
}

var CO_SUBJECT = "Check-Out Info | {building}";
var CO_TIME = "10:00 am";
var CO_SIGNOFF = "Best regards, Customer Care Team";

// "Saturday, 19 September 2026 — before 10:00 am"
function checkoutWhen(date, time) {
  var d = ymdDate(date);
  if (!d) return "";
  return ARR_DAYS[d.getUTCDay()] + ", " + d.getUTCDate() + " " + ARR_MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear() +
    " — before " + (str(time) || CO_TIME);
}

// The plain (unescaped) content of one check-out email.
function checkoutEmailParts(row) {
  var r = row || {};
  var building = str(r.building);
  var vars = fillVars(r, building, flattenAccess(r));
  var intro = ["Hi " + vars.first_name + ","].concat(paras(fill(r.intro, vars)));
  var room = str(r.room_label) || str(r.bed);
  var rows = [
    ["Move-out date and time", checkoutWhen(r.checkout_date, r.checkout_time)],
    ["Building", building],
    ["Unit / room", [str(r.unit), room].filter(Boolean).join(" / ")]
  ].filter(function (x) { return x[1]; });
  var sections = [];
  (Array.isArray(r.sections) ? r.sections : []).forEach(function (s) {
    if (s && (str(s.title) || str(s.text))) sections.push({ title: str(s.title), text: fill(String(s.text || "").trim(), vars) });
  });
  if (str(r.keys_text)) sections.splice(Math.min(1, sections.length), 0, { title: "Returning keys", text: fill(String(r.keys_text).trim(), vars) });
  var subject = fill(str(r.override_subject) || str(r.subject) || CO_SUBJECT, vars);
  return {
    subject: subject, building: building, intro: intro, rows: rows, sections: sections,
    note: fill(str(r.override_note), vars), closing: paras(fill(r.closing, vars))
  };
}

// The renderEmail spec (every value HTML-escaped).
function checkoutEmailSpec(row) {
  var p = checkoutEmailParts(row);
  var body = p.sections.map(function (s) {
    var title = s.title ? "<strong>" + escapeHtml(s.title) + "</strong>" : "";
    var text = nl2br(escapeHtml(s.text));
    return title && text ? title + "<br>" + text : title + text;
  });
  if (p.note) body.push('<span style="display:block;border-left:3px solid ' + T.red + ';padding:2px 0 2px 14px">' + nl2br(escapeHtml(p.note)) + "</span>");
  p.closing.forEach(function (c) { body.push(nl2br(escapeHtml(c))); });
  return {
    subject: escapeHtml(p.subject),
    preheader: escapeHtml("Your check-out details for " + p.building + "."),
    chip: { tone: "brand", label: "Departure details" },
    heading: "Your *departure* instructions",
    intro: p.intro.map(function (x) { return nl2br(escapeHtml(x)); }),
    rows: p.rows.map(function (x) { return [escapeHtml(x[0]), escapeHtml(x[1])]; }),
    body: body,
    signoff: { lead: escapeHtml(CO_SIGNOFF) }
  };
}

function checkoutEmailText(p) {
  var out = ["Your departure instructions", ""];
  p.intro.forEach(function (x) { out.push(x, ""); });
  p.rows.forEach(function (x) { out.push(x[0] + ": " + x[1]); });
  out.push("");
  p.sections.forEach(function (s) { out.push((s.title ? s.title + "\n" : "") + s.text, ""); });
  if (p.note) out.push(p.note, "");
  p.closing.forEach(function (c) { out.push(c, ""); });
  out.push(CO_SIGNOFF, "— The Vanmates team");
  return out.join("\n");
}

// row = one checkout_messages_v row -> { subject, html, text }. opts.pixelBase (e.g. https://…/webhook/checkout-open)
// adds the open pixel <pixelBase>/<open_token>.gif, exactly like the check-in email.
function buildCheckoutEmail(row, opts) {
  var r = row || {}, o = opts || {};
  var p = checkoutEmailParts(r);
  var html = renderEmail(checkoutEmailSpec(r));
  var base = str(o.pixelBase).replace(/\/+$/, "");
  var token = str(r.open_token);
  if (base && token) {
    var src = escapeHtml(base + "/" + encodeURIComponent(token) + ".gif");
    var k = html.lastIndexOf("</body>");
    html = html.slice(0, k) + '<img src="' + src + '" width="1" height="1" alt="" style="display:block;border:0">\n' + html.slice(k);
  }
  return { subject: p.subject, html: html, text: checkoutEmailText(p) };
}
/* CO-CORE-END */
/* FU-CORE-START */
/* ---- Follow-up email (scheduled after-hours check-in update) --------------
   Pasted by the n8n follow-up workflow right AFTER the ARR-CORE paste: it reuses
   renderEmail, T, escapeHtml, str, firstName, safeUrl, fill, paras, nl2br,
   ARR_NOTICE, ARR_KEYS_ONLY and ARR_CTA from there. Input is one
   followup_messages_v row (SQL checkin-followups-2026-10-04.sql). The secret
   (e.g. the lockbox code) is never printed: only a time-limited link to it.
   Tested by test/followup-email.test.js. */

var FU_MISSING_ORDER = ["email", "template", "disabled", "secret"];
var FU_MISSING_LABEL = { email: "email", template: "follow-up not reviewed", disabled: "follow-up is off", secret: "code not set" };
function followupMissingLabel(k, row) {
  if (k === "secret" && row && str(row.secret_label)) return str(row.secret_label).toLowerCase() + " not set";
  return FU_MISSING_LABEL[k] || String(k);
}

function fuTrue(v) { return v === true || v === "true"; }

// Mirrors SQL _followup_missing: email, template (not reviewed), disabled (rule off), secret (label without a value;
// the view carries secret_set, never the value).
function followupReadiness(row) {
  var r = row || {}, missing = [];
  if (!str(r.student_email)) missing.push("email");
  if (!fuTrue(r.template_reviewed)) missing.push("template");
  if (!fuTrue(r.followup_enabled)) missing.push("disabled");
  if (str(r.secret_label) && !fuTrue(r.secret_set)) missing.push("secret");
  return { ready: missing.length === 0, missing: missing };
}

var FU_CHIP = "Check-in update";

// "After-hours check-in" -> "After-hours *check-in*" (the last word is the italic red clause). Escaped; an asterisk
// in the name can't open an emphasis.
function followupHeading(name) {
  var s = escapeHtml(str(name)).replace(/\*/g, "&#42;");
  if (!s) return "Check-in *update*";
  var k = s.lastIndexOf(" ");
  return k < 0 ? "*" + s + "*" : s.slice(0, k) + " *" + s.slice(k + 1) + "*";
}

// The plain (unescaped) content of one follow-up email. opts.secretBase: the n8n page that shows the secret.
function followupEmailParts(row, opts) {
  var r = row || {}, o = opts || {};
  var building = str(r.building);
  var name = str(r.followup_name);
  var vars = fillVars(r, building, flattenAccess(r));
  var intro = ["Hi " + vars.first_name + ","].concat(paras(fillMarked(r.intro, vars)));
  var rows = [];
  if (fuTrue(r.show_codes)) {
    rows = [
      ["Address", str(r.address)],
      ["Apartment", str(r.unit)],
      ["Room", str(r.room_label) || str(r.bed)],
      ["Bedroom door code", fuTrue(r.keys_only) ? ARR_KEYS_ONLY : str(r.door_code)],
      ["House code", str(r.house_code)],
      ["Wi-Fi network", str(r.wifi_name)],
      ["Wi-Fi password", str(r.wifi_password)]
    ].filter(function (x) { return x[1]; });
  }
  var sections = [];
  (Array.isArray(r.sections) ? r.sections : []).forEach(function (s) {
    if (s && (str(s.title) || str(s.text))) sections.push(mkSection(str(s.title), fillMarked(String(s.text || "").trim(), vars)));
  });
  var label = str(r.secret_label);
  var base = str(o.secretBase).replace(/\/+$/, "");
  var token = str(r.secret_token);
  var secretUrl = label && base && token ? base + "/" + encodeURIComponent(token) : "";
  var hours = parseInt(r.secret_valid_hours, 10);
  if (!(hours > 0)) hours = 24;
  var subject = fill(str(r.subject), vars) || ((name || "Check-in update") + " | " + building);
  return {
    subject: subject, name: name || "Check-in update", building: building, intro: intro.map(plainOf), introHtml: intro.map(htmlOf),
    rows: rows, sections: sections,
    rulesUrl: safeUrl(r.rules_url), docsUrl: safeUrl(r.docs_url),
    secretLabel: label, secretUrl: secretUrl,
    secretCta: secretUrl ? "Show my " + label.toLowerCase() : "",
    secretNote: secretUrl ? "This link works for " + hours + (hours === 1 ? " hour" : " hours") + " from this email." : ""
  };
}

function fuLink(label, url) {
  var u = escapeHtml(url);
  return escapeHtml(label) + ': <a href="' + u + '" style="color:' + T.red + '">' + u + "</a>";
}

// The renderEmail spec (every value HTML-escaped).
function followupEmailSpec(row, opts) {
  var p = followupEmailParts(row, opts);
  var body = p.sections.map(sectionHtml);
  if (p.docsUrl) body.push(fuLink("Building documents", p.docsUrl));
  var spec = {
    subject: escapeHtml(p.subject),
    preheader: escapeHtml(p.name + " for " + p.building + "."),
    chip: { tone: "brand", label: FU_CHIP },
    heading: followupHeading(p.name),
    intro: p.introHtml,
    rows: p.rows.map(function (x) { return [escapeHtml(x[0]), escapeHtml(x[1])]; }),
    body: body
  };
  if (p.rows.length || p.secretUrl) spec.notice = { tone: "warn", text: escapeHtml(ARR_NOTICE) };
  if (p.secretUrl) {
    spec.cta = { label: escapeHtml(p.secretCta), url: escapeHtml(p.secretUrl) };
    spec.footnote = escapeHtml(p.secretNote);
    if (p.rulesUrl) body.push(fuLink("House rules", p.rulesUrl));
  } else if (p.rulesUrl) {
    spec.cta = { label: escapeHtml(ARR_CTA), url: escapeHtml(p.rulesUrl) };
  }
  return spec;
}

function followupEmailText(p) {
  var out = [p.name, ""];
  p.intro.forEach(function (x) { out.push(x, ""); });
  if (p.rows.length) {
    p.rows.forEach(function (x) { out.push(x[0] + ": " + x[1]); });
    out.push("");
  }
  p.sections.forEach(function (s) { out.push((s.title ? s.title + "\n" : "") + s.text, ""); });
  if (p.docsUrl) out.push("Building documents: " + p.docsUrl, "");
  if (p.rows.length || p.secretUrl) out.push(ARR_NOTICE, "");
  if (p.secretUrl) {
    out.push(p.secretCta + ": " + p.secretUrl + "\n" + p.secretNote, "");
    if (p.rulesUrl) out.push("House rules: " + p.rulesUrl, "");
  } else if (p.rulesUrl) {
    out.push(ARR_CTA + ": " + p.rulesUrl, "");
  }
  out.push("If anything looks wrong, just reply to this email.", "— The Vanmates team");
  return out.join("\n");
}

// row = one followup_messages_v row -> { subject, html, text, secretUrl }. opts.pixelBase (…/webhook/followup-open) adds
// the open pixel <pixelBase>/<open_token>.gif; opts.secretBase (…/webhook/followup-code) builds the secret link
// <secretBase>/<secret_token>. secretUrl is '' when the rule has a secret label but no link could be built — the
// sender must not send such an email.
function buildFollowupEmail(row, opts) {
  var r = row || {}, o = opts || {};
  var p = followupEmailParts(r, o);
  var html = renderEmail(followupEmailSpec(r, o));
  var base = str(o.pixelBase).replace(/\/+$/, "");
  var token = str(r.open_token);
  if (base && token) {
    var src = escapeHtml(base + "/" + encodeURIComponent(token) + ".gif");
    var k = html.lastIndexOf("</body>");
    html = html.slice(0, k) + '<img src="' + src + '" width="1" height="1" alt="" style="display:block;border:0">\n' + html.slice(k);
  }
  return { subject: p.subject, html: html, text: followupEmailText(p), secretUrl: p.secretUrl };
}
/* FU-CORE-END */
/* BK-CORE-START */
/* ---- Booking / room-change confirmation email -----------------------------
   Built on top of the ARR-CORE paste alone (renderEmail, T, escapeHtml, str, safeUrl, flattenAccess, longDate,
   fill, fillMarked, fillVars, mkSection, sectionHtml, paras, plainOf, htmlOf), so a future n8n sender can paste
   ARR-CORE + BK-CORE like the follow-up and check-out senders do. template = one booking_templates row
   {building, kind: 'booking' | 'room_change', subject, intro, sections:[{title,text}], closing, reviewed}.
   Never a door code, house code or Wi-Fi value: those rows do not exist here and no placeholder carries them.
   Tested by test/arrivals-email.test.js. */

var BK_MISSING_ORDER = ["email", "room", "move_in", "template"];
var BK_MISSING_LABEL = { email: "email", room: "room", move_in: "move-in date", template: "template not reviewed" };
function bookingMissingLabel(k) { return BK_MISSING_LABEL[k] || String(k); }

// missing, in this order: email, room (room label or roster bed), move_in (arrival_date), template (absent or not reviewed).
function bookingReadiness(arrival, template, access) {
  var a = arrival || {}, t = template || null, acc = flattenAccess(access), missing = [];
  if (!str(a.student_email)) missing.push("email");
  if (!(acc.room_label || str(a.bed))) missing.push("room");
  if (!str(a.arrival_date)) missing.push("move_in");
  if (!(t && t.reviewed)) missing.push("template");
  return { ready: missing.length === 0, missing: missing };
}

var BK_KIND = {
  booking: {
    subject: "Welcome to your new home!", chip: "Booking confirmed", heading: "Welcome to",
    intro: "Hi {first_name}, thank you for booking. Your accommodation at {building} is now confirmed.",
    preheader: "Your booking at {building} is confirmed."
  },
  room_change: {
    subject: "Your booking is confirmed!", chip: "Room change confirmed", heading: "Your new room at",
    intro: "Hi {first_name}, your room change is now confirmed.",
    preheader: "Your room change at {building} is confirmed."
  }
};
function bookingKind(template) { return template && template.kind === "room_change" ? "room_change" : "booking"; }

// The plain (unescaped) content of one booking / room-change email (plus the HTML of the template text).
function bookingEmailParts(arrival, template, access) {
  var a = arrival || {}, t = template || {}, acc = flattenAccess(access);
  var kind = bookingKind(t), K = BK_KIND[kind];
  var building = str(a.building) || str(t.building);
  var vars = fillVars(a, building, acc);
  var intro = paras(fillMarked(str(t.intro) ? t.intro : K.intro, vars));
  var rows = [
    ["Building", building],
    ["Address", acc.address],
    ["Room", acc.room_label || str(a.bed)],
    ["Bed", acc.bed_type],
    ["Move-in", str(a.arrival_date) ? longDate(a.arrival_date) : ""],
    ["Move-out", str(a.checkout_date) ? longDate(a.checkout_date) : ""],
    ["Lease type", str(a.lease_type)],
    ["Booking reference", str(a.booking_ref)]
  ].filter(function (r) { return r[1]; });
  var sections = [];
  (Array.isArray(t.sections) ? t.sections : []).forEach(function (s) {
    if (s && (str(s.title) || str(s.text))) sections.push(mkSection(str(s.title), fillMarked(String(s.text || "").trim(), vars)));
  });
  var closing = paras(fillMarked(t.closing, vars));
  return {
    kind: kind, subject: fill(str(t.subject) || K.subject, vars), building: building,
    title: K.heading + " " + (building || "your new home"),
    preheader: fill(K.preheader, { building: building || "Vanmates" }),
    intro: intro.map(plainOf), introHtml: intro.map(htmlOf), rows: rows, sections: sections,
    closing: closing.map(plainOf), closingHtml: closing.map(htmlOf)
  };
}

// The renderEmail spec (every value HTML-escaped).
function bookingEmailSpec(arrival, template, access) {
  var p = bookingEmailParts(arrival, template, access), K = BK_KIND[p.kind];
  return {
    subject: escapeHtml(p.subject),
    preheader: escapeHtml(p.preheader),
    chip: { tone: "brand", label: K.chip },
    heading: K.heading + " *" + (escapeHtml(p.building).replace(/\*/g, "&#42;") || "your new home") + "*",
    intro: p.introHtml,
    rows: p.rows.map(function (r) { return [escapeHtml(r[0]), escapeHtml(r[1])]; }),
    body: p.sections.map(sectionHtml).concat(p.closingHtml)
  };
}

function bookingEmailText(p) {
  var out = [p.title, ""];
  p.intro.forEach(function (x) { out.push(x, ""); });
  p.rows.forEach(function (r) { out.push(r[0] + ": " + r[1]); });
  out.push("");
  p.sections.forEach(function (s) { out.push((s.title ? s.title + "\n" : "") + s.text, ""); });
  p.closing.forEach(function (c) { out.push(c, ""); });
  out.push("If anything looks wrong, just reply to this email.", "— The Vanmates team");
  return out.join("\n");
}

// The template one message is sent with: CS's per-message overrides (stay_messages.override_subject / override_note,
// booking_message_override) on top of the building's booking template. The n8n sender and the portal preview both
// call this, so the preview is the email that goes out. A non-blank override_subject replaces the subject (its
// placeholders are filled like the template's); a non-blank override_note is one extra untitled section after the
// template sections, before the closing. Blank overrides change nothing. Never mutates its inputs.
function bookingTemplateWithOverrides(template, row) {
  var t = template && typeof template === "object" ? template : {}, r = row || {};
  var sections = (Array.isArray(t.sections) ? t.sections : []).slice();
  var note = str(r.override_note);
  if (note) sections.push({ title: "", text: note });
  return { building: t.building, kind: t.kind, subject: str(r.override_subject) || t.subject, intro: t.intro, sections: sections,
    closing: t.closing, reviewed: t.reviewed };
}

// -> { subject, html, text }. opts.pixelBase adds the open pixel <pixelBase>/<open_token>.gif, like the check-in email.
function buildBookingEmail(arrival, template, access, opts) {
  var a = arrival || {}, o = opts || {};
  var p = bookingEmailParts(a, template, access);
  var html = renderEmail(bookingEmailSpec(a, template, access));
  var base = str(o.pixelBase).replace(/\/+$/, "");
  var token = str(a.open_token);
  if (base && token) {
    var src = escapeHtml(base + "/" + encodeURIComponent(token) + ".gif");
    var k = html.lastIndexOf("</body>");
    html = html.slice(0, k) + '<img src="' + src + '" width="1" height="1" alt="" style="display:block;border:0">\n' + html.slice(k);
  }
  return { subject: p.subject, html: html, text: bookingEmailText(p) };
}
/* BK-CORE-END */
/* ROOMS-CORE-START */
/* ---- Rooms browser + room picker (arrivals.html only) ----------------------
   Outside ARR-CORE / CO-CORE / FU-CORE on purpose: those fences are pasted
   verbatim into n8n workflows, and nothing here belongs in an email. Rows are
   access_rooms_v rows (rooms-2026-10-04.sql): one per room, flat, with
   missing[] and upcoming_arrivals. */
var RM_COMBINING = new RegExp("[" + String.fromCharCode(0x0300) + "-" + String.fromCharCode(0x036F) + "]", "g");
function rmNorm(v) { return str(v).normalize("NFD").replace(RM_COMBINING, "").toLowerCase(); }
function rmWords(v) { return rmNorm(v).split(/[^a-z0-9]+/).filter(Boolean); }
function rmCompact(v) { return rmNorm(v).replace(/[^a-z0-9]+/g, ""); }
function rmCmp(x, y) { return String(x || "").localeCompare(String(y || ""), "en", { numeric: true, sensitivity: "base" }); }

// "1104 C" -> every token must hit the room: a 1-2 character token equals a whole word (so "C" is room C, not
// every "Cherry"); a longer one starts a word or sits inside the glued unit+label / room key ("1104c").
function roomMatches(row, q) {
  var r = row || {};
  var tokens = rmWords(q);
  if (!tokens.length) return true;
  var words = [].concat(rmWords(r.building), rmWords(r.unit), rmWords(r.room_label), rmWords(r.room_key));
  var glued = [rmCompact(r.room_key), rmCompact(str(r.unit) + str(r.room_label)), rmCompact(r.building)].join(" ");
  return tokens.every(function (t) {
    if (t.length <= 2) return words.indexOf(t) !== -1;
    return words.some(function (w) { return w.indexOf(t) === 0; }) || glued.indexOf(t) !== -1;
  });
}
function roomsFilter(rows, q, city) {
  return (rows || []).filter(function (r) { return (!city || r.city === city) && roomMatches(r, q); });
}
function roomTitle(r) { return str(r && r.room_label) || str(r && r.room_key); }
function roomOptionLabel(r) { var u = str(r && r.unit); return (u ? "Unit " + u + " · " : "") + roomTitle(r); }
// A view row with no access_rooms row (only an arrival names it) has updated_at null.
function roomSaved(r) { return !!(r && r.updated_at); }
function roomMissingLabel(k) { return missingLabel(k); }
function rmMissing(r) { return Array.isArray(r && r.missing) ? r.missing : []; }
function rmSortRooms(a, b) { return rmCmp(a.building, b.building) || rmCmp(a.unit, b.unit) || rmCmp(roomTitle(a), roomTitle(b)) || rmCmp(a.room_key, b.room_key); }

// rows -> [{building, city, rooms, ready, missing, upcoming, units:[{unit, wifi_name, wifi_password, unit_note,
// rooms:[row], ready, missing, upcoming}]}], buildings / units / rooms in natural order.
function roomsTree(rows) {
  var by = {};
  (rows || []).slice().sort(rmSortRooms).forEach(function (r) {
    var b = str(r.building); if (!b) return;
    var g = by[b] || (by[b] = { building: b, city: "", rooms: 0, ready: 0, missing: 0, upcoming: 0, units: [], _u: {} });
    if (!g.city && str(r.city)) g.city = str(r.city);
    var uk = str(r.unit);
    var u = g._u[uk];
    if (!u) { u = g._u[uk] = { unit: uk, wifi_name: "", wifi_password: "", unit_note: "", rooms: [], ready: 0, missing: 0, upcoming: 0 }; g.units.push(u); }
    if (!u.wifi_name && str(r.wifi_name)) u.wifi_name = str(r.wifi_name);
    if (!u.wifi_password && str(r.wifi_password)) u.wifi_password = str(r.wifi_password);
    if (!u.unit_note && str(r.unit_note)) u.unit_note = str(r.unit_note);
    u.rooms.push(r);
    var miss = rmMissing(r).length ? 1 : 0, up = +r.upcoming_arrivals || 0;
    g.rooms++; u.ready += 1 - miss; g.ready += 1 - miss; u.missing += miss; g.missing += miss; u.upcoming += up; g.upcoming += up;
  });
  return Object.keys(by).sort(rmCmp).map(function (k) { var g = by[k]; delete g._u; return g; });
}
// Rooms that can't be sent yet and have someone coming.
function roomsToCheck(rows) {
  return (rows || []).filter(function (r) { return rmMissing(r).length && (+r.upcoming_arrivals || 0) > 0; }).sort(rmSortRooms);
}

// access_import_issues row -> "Row 34 in tab ‘Cherry S’: unit unreadable" (reason codes read as words).
function importIssueText(i) {
  var x = i || {};
  return "Row " + str(x.row_number) + (str(x.tab) ? " in tab ‘" + str(x.tab) + "’" : "") + ": " + (str(x.reason).replace(/_/g, " ") || "unreadable");
}
// -> [{building ('' = not known), tabs:[{tab, issues:[...]}]}]; known buildings first, rows in sheet order.
function groupImportIssues(issues) {
  var by = {};
  (issues || []).forEach(function (i) {
    var b = str(i && i.building), t = str(i && i.tab);
    var g = by[b] || (by[b] = { building: b, tabs: {}, order: [] });
    if (!g.tabs[t]) { g.tabs[t] = { tab: t, issues: [] }; g.order.push(t); }
    g.tabs[t].issues.push(i);
  });
  return Object.keys(by).sort(function (x, y) { return (x === "") - (y === "") || rmCmp(x, y); }).map(function (k) {
    var g = by[k];
    return { building: g.building, tabs: g.order.sort(rmCmp).map(function (t) {
      var e = g.tabs[t]; e.issues.sort(function (p, q) { return (+p.row_number || 0) - (+q.row_number || 0); }); return e;
    }) };
  });
}

// arrivals [{building, room_key, arrival_date, status}] -> {key: earliest open arrival date on/after today}.
function rmKey(building, roomKey) { return str(building) + "\u0001" + str(roomKey); }
function nextArrivalByRoom(arrivals, today) {
  var out = {};
  (arrivals || []).forEach(function (a) {
    if (!a || !str(a.room_key) || a.status === "cancelled" || a.status === "handled") return;
    var d = str(a.arrival_date).slice(0, 10);
    if (!d || d < str(today)) return;
    var k = rmKey(a.building, a.room_key);
    if (!out[k] || d < out[k]) out[k] = d;
  });
  return out;
}
function roomNext(map, room) { return (map && room && map[rmKey(room.building, room.room_key)]) || ""; }

// The ready-to-send email for a room, with a sample student: buildArrivalEmail(p.arrival, p.template, p.access).
function roomPreviewInput(room, template, nextDate) {
  var r = room || {};
  return {
    arrival: { student_name: "Student name", building: str(r.building), unit: str(r.unit), bed: "", room_key: str(r.room_key),
      arrival_date: str(nextDate), checkout_date: "" },
    template: template || { building: str(r.building) },
    access: r
  };
}

// Room picker for one arrival: its matched (saved) room, the building's saved rooms, and the roster's own room
// when staff chose another. roster = {roster_unit, roster_bed, roster_room_key} from the arrivals row (optional).
function roomPick(arrival, rows, roster) {
  var a = arrival || {}, b = str(a.building);
  var options = (rows || []).filter(function (r) { return str(r.building) === b && roomSaved(r); }).sort(rmSortRooms);
  var matched = null;
  if (str(a.room_key)) options.forEach(function (r) { if (str(r.room_key) === str(a.room_key)) matched = r; });
  var rosterRoom = "", x = roster || {};
  if (a.room_overridden && str(x.roster_room_key) && str(x.roster_room_key) !== str(a.room_key)) {
    var known = null;
    (rows || []).forEach(function (r) { if (str(r.building) === b && str(r.room_key) === str(x.roster_room_key)) known = r; });
    rosterRoom = roomOptionLabel({ unit: str(x.roster_unit) || (known && known.unit), room_label: known && known.room_label, room_key: x.roster_room_key });
  }
  return { matched: matched, overridden: !!a.room_overridden, rosterRoom: rosterRoom, options: options };
}
/* ROOMS-CORE-END */
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
  stripExternalLinks: stripExternalLinks, bytesToBase64: bytesToBase64,
  buildCheckoutEmail: buildCheckoutEmail, checkoutEmailSpec: checkoutEmailSpec, checkoutReadiness: checkoutReadiness,
  checkoutMissingLabel: checkoutMissingLabel, CO_MISSING_ORDER: CO_MISSING_ORDER,
  buildFollowupEmail: buildFollowupEmail, followupEmailSpec: followupEmailSpec, followupReadiness: followupReadiness,
  followupMissingLabel: followupMissingLabel, FU_MISSING_ORDER: FU_MISSING_ORDER,
  roomMatches: roomMatches, roomsFilter: roomsFilter, roomsTree: roomsTree, roomsToCheck: roomsToCheck, roomTitle: roomTitle,
  roomOptionLabel: roomOptionLabel, roomSaved: roomSaved, roomMissingLabel: roomMissingLabel, importIssueText: importIssueText,
  groupImportIssues: groupImportIssues, nextArrivalByRoom: nextArrivalByRoom, roomNext: roomNext, roomPreviewInput: roomPreviewInput,
  roomPick: roomPick,
  buildBookingEmail: buildBookingEmail, bookingEmailSpec: bookingEmailSpec, bookingEmailParts: bookingEmailParts,
  bookingReadiness: bookingReadiness, bookingMissingLabel: bookingMissingLabel, BK_MISSING_ORDER: BK_MISSING_ORDER,
  bookingTemplateWithOverrides: bookingTemplateWithOverrides,
  fill: fill, ACCESS_FIELDS: ACCESS_FIELDS
};
if (typeof window !== "undefined") window.ArrCore = ArrCore;
if (typeof module !== "undefined" && module.exports) module.exports = ArrCore;
})();
