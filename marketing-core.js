// marketing-core.js — pure logic for marketing.html (Email marketing). No DOM, no network. Tested by test/marketing-core.test.js.
// The server (homestay Worker /mk/*) enforces every permission; nothing here decides access.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MK = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // RFC 4180-ish CSV → array of objects keyed by the header row. Handles quotes, escaped quotes, CRLF, BOM.
  function parseCsv(text) {
    var s = String(text || "").replace(/^﻿/, "");
    var rows = [], row = [], cell = "", q = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (q) {
        if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && s[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    rows = rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ""; }); });
    if (!rows.length) return { headers: [], rows: [] };
    var headers = rows[0].map(function (h, i) { return String(h).trim() || "Column " + (i + 1); });
    return { headers: headers, rows: rows.slice(1).map(function (r) {
      var o = {}; headers.forEach(function (h, i) { o[h] = r[i] === undefined ? "" : r[i]; }); return o;
    }) };
  }

  var FIELD_HINTS = {
    email: /^(e-?mail|email address|correo|courriel)$/i,
    name: /^(name|full name|nombre|nom)$/i,
    first_name: /^(first ?name|given name|first|prénom|nombre de pila)$/i,
    language: /^(lang|language|idioma|langue)$/i,
    country: /^(country|país|pays)$/i,
    city: /^(city|ciudad|ville)$/i,
    tags: /^(tags?|labels?|etiquetas?)$/i,
    source: /^(source|origin|lead source|fuente)$/i,
    consent: /^(consent|consent status|opt.?in|permission)$/i,
    consent_evidence: /^(consent (evidence|proof|note)|evidence)$/i,
    consent_at: /^(consent (date|at)|opt.?in date)$/i,
  };
  // Best-guess {field: header} from the file's headers; each header used once.
  function guessMapping(headers) {
    var out = {}, used = {};
    Object.keys(FIELD_HINTS).forEach(function (f) {
      for (var i = 0; i < headers.length; i++) {
        if (!used[headers[i]] && FIELD_HINTS[f].test(String(headers[i]).trim())) { out[f] = headers[i]; used[headers[i]] = true; return; }
      }
    });
    return out;
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }
  // Month grid (weeks × 7, Monday first) for "YYYY-MM", with items placed on their local_date.
  function monthGrid(ym, items) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7);
    var first = new Date(Date.UTC(y, m - 1, 1)), days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    var lead = (first.getUTCDay() + 6) % 7, cells = [];
    for (var i = 0; i < lead; i++) cells.push(null);
    for (var d = 1; d <= days; d++) {
      var iso = y + "-" + pad(m) + "-" + pad(d);
      cells.push({ date: iso, day: d, items: (items || []).filter(function (x) { return x.local_date === iso; }) });
    }
    while (cells.length % 7) cells.push(null);
    var weeks = [];
    for (var w = 0; w < cells.length; w += 7) weeks.push(cells.slice(w, w + 7));
    return weeks;
  }
  // Months ("YYYY-MM") spanned by items' local_date, in order; the current month when none.
  function monthsOf(items, today) {
    var ms = {};
    (items || []).forEach(function (x) { if (x.local_date) ms[x.local_date.slice(0, 7)] = 1; });
    var out = Object.keys(ms).sort();
    return out.length ? out : [String(today || new Date().toISOString()).slice(0, 7)];
  }
  function addMonth(ym, n) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + "-" + pad(m + 1);
  }

  // A rate (number or null) → "12.5%" or "—" (zero denominators never show 0%).
  function pct(v) { return v === null || v === undefined ? "—" : (Math.round(v * 10) / 10) + "%"; }
  function num(v) { return v === null || v === undefined ? "—" : Number(v).toLocaleString("en-CA"); }
  function when(iso, tz) {
    if (!iso) return "—";
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: tz || undefined, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
    } catch (e) { return String(iso).slice(0, 16).replace("T", " "); }
  }

  var STATUS = {
    draft: "Draft", scheduled: "Scheduled", running: "Running", paused: "Paused", completed: "Completed", cancelled: "Cancelled",
    sending: "Sending", sent: "Sent", skipped: "Skipped", held: "Held for review",
    queued: "Queued", generating: "Writing…", partial: "Partly written", failed: "Failed", done: "Written",
  };
  var TONE = { draft: "none", scheduled: "cur", running: "ok", paused: "warn", completed: "ok", cancelled: "none", sending: "cur", sent: "ok",
    skipped: "none", held: "bad", queued: "cur", generating: "cur", partial: "warn", failed: "bad", done: "ok" };
  function statusLabel(s) { return STATUS[s] || s || "—"; }
  function statusTone(s) { return TONE[s] || "none"; }

  // Rule builder: rows [{field, op, value}] + match → the server's rule JSON (null when empty).
  var RULE_FIELDS = [
    ["host_status", "Host status"], ["city", "City"], ["country", "Country"], ["language", "Language"], ["tag", "Tag"],
    ["consent", "Consent"], ["source", "Source"], ["fact", "Engagement / activity"],
  ];
  var FACTS = [["opened_30d", "Opened in the last 30 days"], ["clicked_30d", "Clicked in the last 30 days"], ["never_opened", "Never opened"],
    ["converted", "Completed an action"], ["availability_submitted", "Sent an availability update"], ["has_application", "Submitted a host application"]];
  function ruleFromRows(match, rows) {
    var conditions = (rows || []).filter(function (r) { return r && r.field && String(r.value || "").trim(); }).map(function (r) {
      var v = String(r.value).trim();
      return { field: r.field, op: r.op === "is_not" ? "is_not" : "is", value: v.indexOf(",") >= 0 ? v.split(",").map(function (x) { return x.trim(); }).filter(Boolean) : v };
    });
    return conditions.length ? { match: match === "any" ? "any" : "all", conditions: conditions } : null;
  }
  function rowsFromRule(rule) {
    if (!rule || !rule.conditions) return [];
    return rule.conditions.filter(function (c) { return c && !c.conditions; }).map(function (c) {
      return { field: c.field, op: c.op === "is_not" || c.op === "not_has" ? "is_not" : "is", value: Array.isArray(c.value) ? c.value.join(", ") : c.value };
    });
  }
  function describeRule(rule) {
    if (!rule || !rule.conditions || !rule.conditions.length) return "No rule";
    var label = {}; RULE_FIELDS.forEach(function (f) { label[f[0]] = f[1]; });
    var fl = {}; FACTS.forEach(function (f) { fl[f[0]] = f[1]; });
    return rule.conditions.map(function (c) {
      if (c.conditions) return "(" + describeRule(c) + ")";
      var v = Array.isArray(c.value) ? c.value.join(" or ") : c.value;
      if (c.field === "fact") return (c.op === "is_not" ? "not: " : "") + (fl[v] || v);
      return (label[c.field] || c.field) + (c.op === "is_not" || c.op === "not_has" ? " is not " : " is ") + v;
    }).join(rule.match === "any" ? " OR " : " AND ");
  }

  // Blocks editor helpers: move / remove / insert, never mutating the input.
  function moveBlock(blocks, i, dir) {
    var b = blocks.slice(), j = i + dir;
    if (j < 0 || j >= b.length) return b;
    var t = b[i]; b[i] = b[j]; b[j] = t; return b;
  }
  function newBlock(type) {
    return type === "button" ? { type: "button", label: "Update my availability", url: "https://hosts.vanmates.com/m/a" }
      : type === "list" ? { type: "list", items: [""] }
      : type === "image" ? { type: "image", url: "https://", alt: "" }
      : type === "divider" ? { type: "divider" }
      : { type: type, text: "" };
  }

  // Error codes from the API → a sentence for people.
  var ERRORS = {
    forbidden: "You don't have access to do that here.", not_found: "That item doesn't exist or isn't in your area.",
    stale_revision: "Someone changed this since you opened it. Reload and try again.", stale_version: "This template changed since you opened it. Reload first.",
    not_ready: "The campaign isn't ready to activate yet.", ai_unavailable: "The AI isn't available right now.", already_generating: "The AI is already writing this campaign.",
    test_to_internal_only: "Test sends can only go to @vanmates.com addresses.", evidence_required: "Say where this consent comes from.",
    one_scope_per_campaign: "A campaign sends within one business area.", exists_in_scope: "That email is already a contact here.",
    not_draft: "Only a draft can do that.", in_the_past: "That time has already passed.", unauthorized: "Your sign-in expired. Reload the page.",
  };
  function errorText(code, detail) {
    var base = ERRORS[code] || ("Something went wrong (" + code + ").");
    if (typeof detail === "string") return detail;
    return base;
  }

  return { parseCsv: parseCsv, guessMapping: guessMapping, monthGrid: monthGrid, monthsOf: monthsOf, addMonth: addMonth, pct: pct, num: num, when: when,
    statusLabel: statusLabel, statusTone: statusTone, ruleFromRows: ruleFromRows, rowsFromRule: rowsFromRule, describeRule: describeRule,
    moveBlock: moveBlock, newBlock: newBlock, errorText: errorText, RULE_FIELDS: RULE_FIELDS, FACTS: FACTS };
});
