/* School students (portal page, 2026-11-26). Students placed by schools (ILSC, Kaplan, EF…), kept apart from Tenants.
   Plan + mockup: https://claude.ai/artifact/T9oGzCd91nfKZJFuVgiN64 · SQL: school-students-2026-11-26.sql.
   Data comes from Arrivals (school rosters) through school_stays; this page only reads, except review decisions.
   Loaded by index.html after tenant-db.js (uses esc, showToast, activeRole, window.vmDb).

   1. SS_CORE (window.SS_CORE, pure, tested in test/school-students.test.js): stays → filters, views, stats, beds, CSV.
   2. The page: city switch, stats, List / By property / Timeline, filters, profile drawer (Overview, Stays,
      Messages, Changes), Needs review, Roster sync, Building info. */
(function () {
  // ── 1. SS-CORE ───────────────────────────────────────────────────────────────
  const iso = (v) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v == null ? "" : v)); return m ? m[1] : null; };
  const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const days = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);
  const VIEWS = [["current", "Current residents"], ["upcoming", "Upcoming arrivals"], ["leaving", "Leaving in 14 days"], ["past", "Previous residents"],
    ["noapp", "App not activated"], ["review", "Needs review"], ["all", "Everyone"]];
  const live = (r) => r.stage === "current" || r.stage === "not_in_roster";
  function inView(r, v, today) {
    if (v === "current") return live(r);
    if (v === "upcoming") return r.stage === "upcoming";
    if (v === "past") return r.stage === "past";
    if (v === "leaving") return !!r.check_out && r.check_out >= today && r.check_out <= addDays(today, 14) && r.stage !== "past";
    if (v === "noapp") return r.stage !== "past" && !r.app_activated_at;
    if (v === "review") return (r.open_reviews || 0) > 0 || r.stage === "not_in_roster";
    return true;
  }
  const appState = (r) => (r.app_activated_at ? "on" : r.shared_email || !r.email ? "none" : "off");
  const mailState = (r) => (r.arrival_opened_at ? "opened" : r.arrival_sent_at || r.arrival_status === "sent" ? "sent" : "due");
  function matches(r, f) {
    if (f.city && r.city !== f.city) return false;
    if (f.school && r.school !== f.school) return false;
    if (f.building && r.building !== f.building) return false;
    if (f.unit && (r.unit || "") !== f.unit) return false;
    if (f.bed && (r.bed || "") !== f.bed) return false;
    if (f.a1 && !(r.check_in && r.check_in >= f.a1)) return false;
    if (f.a2 && !(r.check_in && r.check_in <= f.a2)) return false;
    if (f.d1 && !(r.check_out && r.check_out >= f.d1)) return false;
    if (f.d2 && !(r.check_out && r.check_out <= f.d2)) return false;
    if (f.app && appState(r) !== f.app) return false;
    if (f.mail && mailState(r) !== f.mail) return false;
    if (f.q) {
      const hay = [r.name, r.email, r.phone, r.building, r.unit, r.bed, r.school].join(" ").toLowerCase();
      if (!String(f.q).toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false;
    }
    return true;
  }
  function filter(rows, view, f, today) { return rows.filter((r) => inView(r, view, today) && matches(r, f)); }
  function stats(rows, city, today) {
    const R = rows.filter((r) => !city || r.city === city);
    const L = R.filter(live);
    const by = {};
    L.forEach((r) => { const k = city ? r.school : `${r.city} · ${r.school}`; by[k] = (by[k] || 0) + 1; });
    return {
      living: L.length,
      arriving14: R.filter((r) => r.stage === "upcoming" && r.check_in && r.check_in <= addDays(today, 14)).length,
      leaving14: R.filter((r) => inView(r, "leaving", today)).length,
      app: L.filter((r) => r.app_activated_at).length,
      notInRoster: R.filter((r) => r.stage === "not_in_roster").length,
      by: Object.entries(by).sort((a, b) => b[1] - a[1]),
    };
  }
  // Beds of a building seen in any stay, with who is in each on `day` and who comes next.
  function beds(rows, building, day) {
    const map = new Map();
    rows.filter((r) => r.building === building && r.stage !== "cancelled").forEach((r) => {
      const k = `${r.unit || ""}|${r.bed || r.room_key || ""}`;
      if (!map.has(k)) map.set(k, { unit: r.unit || "", bed: r.bed || r.room_key || "", stays: [] });
      map.get(k).stays.push(r);
    });
    return [...map.values()].map((b) => {
      const now = b.stays.find((r) => (!r.check_in || r.check_in <= day) && r.check_out && r.check_out > day && r.stage !== "past");
      const next = b.stays.filter((r) => r.check_in && r.check_in > day).sort((x, y) => x.check_in.localeCompare(y.check_in))[0] || null;
      return { ...b, now: now || null, next };
    }).sort((a, b) => (a.unit + a.bed).localeCompare(b.unit + b.bed, undefined, { numeric: true }));
  }
  const csvCell = (v) => { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  function csv(rows) {
    const head = ["Name", "Email", "Phone", "School", "City", "Building", "Unit", "Bed", "Arrival", "Departure", "Status", "App"];
    return [head, ...rows.map((r) => [r.name, r.email, r.phone, r.school, r.city, r.building, r.unit, r.bed, r.check_in, r.check_out, r.stage,
      r.app_activated_at ? "active" : ""])].map((l) => l.map(csvCell).join(",")).join("\n");
  }
  window.SS_CORE = { iso, addDays, days, VIEWS, inView, matches, filter, stats, beds, csv, appState, mailState };

  if (typeof document === "undefined" || !document.createElement) return;

  // ── 2. THE PAGE ──────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const sb = () => window.vmDb && window.vmDb.sb;
  const e = (s) => (typeof esc === "function" ? esc(s) : String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  const toast = (m) => (typeof showToast === "function" ? showToast(m) : console.log(m));
  const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Vancouver" });
  const fmt = (d, y) => (d ? new Date(d + "T12:00:00Z").toLocaleDateString("en-CA", { day: "numeric", month: "short", ...(y ? { year: "numeric" } : {}), timeZone: "UTC" }) : "—");
  const ago = (ts) => { const s = (Date.now() - Date.parse(ts)) / 1000; if (!isFinite(s)) return ""; if (s < 3600) return Math.max(1, Math.round(s / 60)) + " min ago"; if (s < 86400) return Math.round(s / 3600) + " h ago"; return Math.round(s / 86400) + " d ago"; };
  const isStaff = () => { const u = (typeof activeRole === "function" && activeRole()) || {}; return u.role === "admin" || (Array.isArray(u.allowed_pages) && u.allowed_pages.includes("school-students")); };
  const STAGE = { current: ["Living there", "ok"], upcoming: ["Arriving", "info"], past: ["Moved out", ""], not_in_roster: ["Not in latest roster", "warn"], cancelled: ["Cancelled", ""] };
  const S = { rows: null, reviews: [], sync: [], bldg: [], err: "", tab: "students", mode: "list", view: "current", sort: "check_in", f: {}, sel: new Set(), open: null, detail: null, dtab: "ov", tlBuilding: "" };

  (function css() {
    const st = document.createElement("style");
    st.textContent = `
.ss-city{display:inline-flex;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--surface,#fff);margin:2px 0 12px}
.ss-city button,.ss-seg button{font:inherit;font-size:13px;font-weight:600;border:0;background:none;color:var(--muted);padding:7px 14px;cursor:pointer}
.ss-city button.on,.ss-seg button.on{background:var(--ink);color:var(--cream)}
.ss-seg{display:inline-flex;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--surface,#fff)}
.ss-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(9.5em,1fr));gap:10px;margin-bottom:10px}
.ss-stat{text-align:left;border:1px solid var(--line);border-radius:12px;padding:10px 12px;background:var(--surface,#fff);cursor:pointer;color:inherit;font:inherit}
.ss-stat b{display:block;font-size:24px;line-height:1.15}.ss-stat span{font-size:12.5px;color:var(--muted)}
.ss-stat.warn b{color:var(--amber)}.ss-stat.bad b{color:var(--red)}
.ss-split{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;font-size:12.5px;margin-bottom:12px;color:var(--muted)}
.ss-split button{font:inherit;font-size:12.5px;background:none;border:0;color:var(--ink);cursor:pointer;display:inline-flex;gap:6px;align-items:center;padding:2px 0}
.ss-split i{display:inline-block;height:8px;border-radius:4px;background:var(--red)}
.ss-bar{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.ss-views{display:flex;gap:6px;flex-wrap:wrap}
.ss-chip{font:inherit;font-size:12.5px;border:1px solid var(--line);border-radius:999px;padding:5px 11px;background:var(--surface,#fff);color:var(--ink);cursor:pointer}
.ss-chip.on{background:var(--ink);color:var(--cream);border-color:var(--ink)}.ss-chip span{opacity:.6;margin-left:3px}
.ss-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:8px;margin-bottom:8px}
.ss-filters label{display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--muted);font-weight:600}
.ss-filters .form-input{width:100%;min-width:0}
.ss-active{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.ss-ac{font:inherit;font-size:12px;border:1px solid var(--red);color:var(--red);background:var(--red-soft);border-radius:999px;padding:3px 9px;cursor:pointer}
.ss-ac.plain{background:none;border-color:var(--line);color:var(--muted)}
.ss-bulk{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:var(--ink);color:var(--cream);border-radius:10px;padding:8px 12px;margin-bottom:8px;font-size:13px}
.ss-table{width:100%;border-collapse:collapse;font-size:13.5px}
.ss-table th{text-align:left;font-weight:600;color:var(--muted);font-size:12px;padding:8px;border-bottom:1px solid var(--line);white-space:nowrap}
.ss-table th[data-ss-sort]{cursor:pointer}.ss-table th[data-ss-sort]:hover{color:var(--ink)}
.ss-table td{padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
.ss-table tbody tr[data-ss-open]{cursor:pointer}.ss-table tbody tr[data-ss-open]:hover{background:var(--cream)}
.ss-sub{font-size:12px;color:var(--muted)}.ss-nw{white-space:nowrap}
.ss-tag{display:inline-block;font-size:11.5px;font-weight:600;border-radius:999px;padding:2px 8px;white-space:nowrap;background:var(--cream);color:var(--muted);border:1px solid var(--line)}
.ss-tag.ok{background:var(--green-soft);color:var(--green);border-color:transparent}.ss-tag.warn{background:var(--amber-soft);color:#8a5f12;border-color:transparent}
.ss-tag.bad{background:var(--red-soft);color:var(--red);border-color:transparent}.ss-tag.info{background:var(--blue-soft);color:var(--blue);border-color:transparent}
.ss-pc{margin-bottom:12px}.ss-pch{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) auto;gap:14px;align-items:center;margin-bottom:6px}
.ss-ob{height:8px;border-radius:4px;background:var(--cream);border:1px solid var(--line);overflow:hidden;margin-bottom:4px}.ss-ob i{display:block;height:100%;background:var(--green)}
.ss-tl{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--surface,#fff)}
.ss-tlr{display:grid;grid-template-columns:170px minmax(0,1fr);border-bottom:1px solid var(--line);min-height:32px}
.ss-tlr.head{min-height:24px;background:var(--cream)}
.ss-tlb{padding:7px 10px;font-size:12.5px;font-weight:600;border-right:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ss-tlt{position:relative}.ss-tlt span{position:absolute;top:4px;font-size:11.5px;color:var(--muted);padding-left:4px;border-left:1px solid var(--line)}
.ss-tlt .now{position:absolute;top:0;bottom:0;width:2px;background:var(--red);z-index:1}
.ss-tlt button{position:absolute;top:4px;height:23px;border-radius:6px;font:600 11.5px/23px inherit;padding:0 6px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;border:0;cursor:pointer;text-align:left}
.ss-tlt .current,.ss-tlt .not_in_roster{background:var(--green-soft);color:var(--green)}.ss-tlt .upcoming{background:var(--blue-soft);color:var(--blue)}.ss-tlt .past{background:var(--cream);color:var(--muted);outline:1px solid var(--line)}
.ss-tlt .not_in_roster{background:var(--amber-soft);color:#8a5f12}
.ss-drawer{position:fixed;top:0;right:0;bottom:0;width:min(460px,100%);background:var(--surface,#fff);border-left:1px solid var(--line);box-shadow:-12px 0 30px -18px rgba(0,0,0,.35);padding:18px;overflow:auto;z-index:60}
.ss-drawer h2{margin:0 0 2px;font-size:21px}
.ss-edit{display:grid;gap:8px;margin:10px 0}.ss-edit label{display:grid;gap:3px;font-size:12.5px;color:var(--muted)}.ss-edit .row{display:flex;gap:8px;flex-wrap:wrap}.ss-edit .row label{flex:1 1 140px}.ss-stay-ed{border:1px solid var(--line);border-radius:10px;padding:10px;margin:8px 0}
.ss-kv{display:grid;grid-template-columns:120px minmax(0,1fr);gap:5px 10px;font-size:13.5px;margin:10px 0}.ss-kv dt{color:var(--muted)}.ss-kv dd{margin:0;overflow-wrap:anywhere}
.ss-dt{display:flex;gap:4px;border-bottom:1px solid var(--line);margin:8px 0 8px}
.ss-dt button{font:inherit;font-size:13px;font-weight:600;background:none;border:0;border-bottom:2px solid transparent;color:var(--muted);padding:6px 8px;cursor:pointer}
.ss-dt button.on{color:var(--red);border-color:var(--red)}
.ss-line{list-style:none;padding:0;margin:6px 0;border-left:2px solid var(--line)}
.ss-line li{padding:3px 0 9px 12px;position:relative;font-size:13.5px}
.ss-line li::before{content:"";position:absolute;left:-6px;top:8px;width:10px;height:10px;border-radius:50%;background:var(--surface,#fff);border:2px solid var(--red)}
.ss-line small{display:block;color:var(--muted)}
.ss-rv{display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between}
.ss-ok{color:var(--green);font-weight:700}.ss-no{color:var(--red);font-weight:700}.ss-mid{color:#8a5f12;font-weight:700}
@media(max-width:760px){.ss-pch{grid-template-columns:1fr}.ss-tlr{grid-template-columns:100px minmax(0,1fr)}
 .ss-table.stack thead{display:none}.ss-table.stack tr{display:grid;padding:8px 0;border-bottom:1px solid var(--line)}
 .ss-table.stack td{display:flex;justify-content:space-between;gap:12px;border:0;padding:3px 4px}.ss-table.stack td::before{content:attr(data-l);color:var(--muted);font-size:12px}}`;
    document.head.appendChild(st);
  })();

  async function load() {
    const c = sb();
    if (!c) { S.err = "Not connected."; return; }
    const [l, r, y, b] = await Promise.all([c.rpc("school_students_list"), c.rpc("school_reviews_open"), c.rpc("school_roster_sync"), c.rpc("school_building_info")]);
    const err = [l, r, y, b].find((x) => x.error);
    S.err = err ? (/not allowed|42501/.test(err.error.message) ? "You don't have access to School students. An admin can tick it on your Team profile." : err.error.message) : "";
    S.rows = Array.isArray(l.data) ? l.data : [];
    S.reviews = Array.isArray(r.data) ? r.data : [];
    S.sync = Array.isArray(y.data) ? y.data : [];
    S.bldg = Array.isArray(b.data) ? b.data : [];
    setBadge();
  }
  function setBadge() {
    const n = document.querySelector('.nav-item[data-view="school-students"] .nav-count');
    if (n) n.textContent = S.reviews.length ? String(S.reviews.length) : "";
  }

  const F_IDS = { q: "ss-q", city: "ss-fcity", school: "ss-fschool", building: "ss-fbld", unit: "ss-funit", bed: "ss-fbed", a1: "ss-fa1", a2: "ss-fa2", d1: "ss-fd1", d2: "ss-fd2", app: "ss-fapp", mail: "ss-fmail" };
  const F_LABEL = { q: "Search", city: "City", school: "School", building: "Property", unit: "Unit", bed: "Bed", a1: "Arrives from", a2: "Arrives to", d1: "Leaves from", d2: "Leaves to", app: "App", mail: "Arrival email" };
  const uniq = (a) => [...new Set(a.filter(Boolean))].sort((x, y) => String(x).localeCompare(String(y), undefined, { numeric: true }));
  const opt = (vals, cur, all = "All") => `<option value="">${all}</option>` + vals.map((v) => `<option${v === cur ? " selected" : ""}>${e(v)}</option>`).join("");

  function render() {
    const root = $("ss-root");
    if (!root) return;
    if (!S.rows) { root.innerHTML = `<div class="card tn-empty">Loading…</div>`; return; }
    const tab = (k, l, n, need) => `<button type="button" class="hb-tab${S.tab === k ? " on" : ""}" data-ss-tab="${k}">${l}${n != null ? `<span class="hb-n${need && n ? " hb-need-v" : ""}">${n}</span>` : ""}</button>`;
    const gaps = S.bldg.filter(gapCount).length;
    root.innerHTML = `${S.err ? `<div class="card-sub hb-note">${e(S.err)}</div>` : ""}
      <div class="hb-tabbar" role="tablist">${tab("students", "Students", S.rows.filter((r) => r.stage === "current" || r.stage === "not_in_roster").length)}${tab("review", "Needs review", S.reviews.length, true)}${tab("sync", "Roster sync", S.sync.length)}${tab("bldg", "Building info", gaps, true)}</div>
      ${S.tab === "students" ? students() : S.tab === "review" ? reviews() : S.tab === "sync" ? sync() : buildings()}
      ${S.open ? drawer() : ""}`;
  }

  function students() {
    const T = today(), f = S.f, st = SS_CORE.stats(S.rows, f.city, T);
    const cityBtn = (c, l) => `<button type="button" class="${(f.city || "") === c ? "on" : ""}" data-ss-city="${c}">${l}</button>`;
    const lastSync = S.sync.slice().sort((a, b) => String(b.last_received_at).localeCompare(String(a.last_received_at)))[0];
    const gaps = S.bldg.filter((b) => (!f.city || b.city === f.city) && gapCount(b)).length;
    const stat = (n, l, cls, act) => `<button type="button" class="ss-stat ${cls}" data-ss-act="${act}"><b>${n}</b><span>${l}</span></button>`;
    const max = Math.max(1, ...st.by.map((x) => x[1]));
    const inCity = S.rows.filter((r) => !f.city || r.city === f.city);
    const bOpts = uniq(inCity.map((r) => r.building)), pick = inCity.filter((r) => r.building === f.building);
    const viewN = (v) => SS_CORE.filter(S.rows, v, { city: f.city }, T).length;
    const on = Object.entries(f).filter(([, v]) => v);
    const list = SS_CORE.filter(S.rows, S.view, f, T).sort(sorter());
    return `<div class="ss-city">${cityBtn("", "All cities")}${cityBtn("Toronto", "Toronto")}${cityBtn("Vancouver", "Vancouver")}</div>
      ${lastSync ? `<span class="ss-sub" style="margin-left:10px">Last roster read: ${e(lastSync.school)} ${e(lastSync.city)}, ${e(ago(lastSync.last_received_at))}</span>` : ""}
      <div class="ss-stats">${stat(st.living, "Living there now", "", "v:current")}${stat(st.arriving14, "Arriving in 14 days", "", "v:upcoming")}${stat(st.leaving14, "Leaving in 14 days", "", "v:leaving")}
        ${stat(st.living ? Math.round((100 * st.app) / st.living) + "%" : "—", `App activated (${st.app} of ${st.living})`, "", "v:noapp")}
        ${stat(S.reviews.length, "Need review", S.reviews.length ? "warn" : "", "t:review")}${stat(gaps, "Buildings missing info", gaps ? "bad" : "", "t:bldg")}</div>
      <div class="ss-split">Living there now by ${f.city ? "school" : "city and school"}:${st.by.map(([k, n]) => `<button type="button" data-ss-split="${e(k)}"><i style="width:${Math.round((60 * n) / max) + 8}px"></i>${e(k)} <b>${n}</b></button>`).join("") || " none"}</div>
      <div class="ss-bar"><div class="ss-seg">${["list:List", "prop:By property", "time:Timeline"].map((x) => { const [k, l] = x.split(":"); return `<button type="button" class="${S.mode === k ? "on" : ""}" data-ss-mode="${k}">${l}</button>`; }).join("")}</div>
        <div class="ss-views">${SS_CORE.VIEWS.map(([k, l]) => `<button type="button" class="ss-chip${S.view === k ? " on" : ""}" data-ss-view="${k}">${l}<span>${viewN(k)}</span></button>`).join("")}</div></div>
      <div class="ss-filters">
        <label>Search<input class="form-input" id="ss-q" value="${e(f.q || "")}" placeholder="Name, email, phone, room"></label>
        <label>City<select class="form-input" id="ss-fcity">${opt(["Toronto", "Vancouver"], f.city)}</select></label>
        <label>School<select class="form-input" id="ss-fschool">${opt(uniq(inCity.map((r) => r.school)), f.school)}</select></label>
        <label>Property<select class="form-input" id="ss-fbld">${opt(bOpts, f.building)}</select></label>
        <label>Unit<select class="form-input" id="ss-funit" ${f.building ? "" : "disabled"}>${opt(uniq(pick.map((r) => r.unit)), f.unit)}</select></label>
        <label>Bedroom<select class="form-input" id="ss-fbed" ${f.building ? "" : "disabled"}>${opt(uniq(pick.filter((r) => !f.unit || r.unit === f.unit).map((r) => r.bed)), f.bed)}</select></label>
        <label>Arrives from<input type="date" class="form-input" id="ss-fa1" value="${e(f.a1 || "")}"></label>
        <label>Arrives to<input type="date" class="form-input" id="ss-fa2" value="${e(f.a2 || "")}"></label>
        <label>Leaves from<input type="date" class="form-input" id="ss-fd1" value="${e(f.d1 || "")}"></label>
        <label>Leaves to<input type="date" class="form-input" id="ss-fd2" value="${e(f.d2 || "")}"></label>
        <label>App<select class="form-input" id="ss-fapp"><option value="">Any</option>${[["on", "Activated"], ["off", "Not activated"], ["none", "No own email"]].map(([v, l]) => `<option value="${v}"${f.app === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>Arrival email<select class="form-input" id="ss-fmail"><option value="">Any</option>${[["opened", "Opened"], ["sent", "Sent, not opened"], ["due", "Not sent yet"]].map(([v, l]) => `<option value="${v}"${f.mail === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>
      <div class="ss-active">${on.map(([k, v]) => `<button type="button" class="ss-ac" data-ss-clear="${k}">${F_LABEL[k]}: ${e(/^[ad][12]$/.test(k) ? fmt(v) : v)} ✕</button>`).join("")}${on.length ? `<button type="button" class="ss-ac plain" data-ss-clear="*">Clear all</button>` : ""}</div>
      ${S.mode === "list" ? listView(list) : S.mode === "prop" ? propView(list) : timeView()}`;
  }
  function sorter() {
    const k = S.sort;
    return (a, b) => String(a[k] || "~").localeCompare(String(b[k] || "~"), undefined, { numeric: true }) || String(a.name).localeCompare(String(b.name));
  }
  const appTag = (r) => { const s = SS_CORE.appState(r); return s === "on" ? `<span class="ss-tag ok">Active</span>` : s === "none" ? `<span class="ss-tag" title="The roster email is a school or agency inbox, or there is none">No own email</span>` : `<span class="ss-tag">Not yet</span>`; };
  const mailTag = (r) => { if (!r.arrival_id) return `<span class="ss-sub">—</span>`; const s = SS_CORE.mailState(r); return s === "opened" ? `<span class="ss-tag ok">Opened</span>` : s === "sent" ? `<span class="ss-tag warn">Not opened</span>` : `<span class="ss-tag">Not sent yet</span>`; };
  const stageTag = (r) => { const [l, c] = STAGE[r.stage] || [r.stage, ""]; return `<span class="ss-tag ${c}">${e(l)}</span>`; };
  function listView(list) {
    const th = (k, l) => `<th data-ss-sort="${k}">${l}${S.sort === k ? " ↓" : ""}</th>`;
    const T = today();
    const shown = list.slice(0, 600);
    return `${S.sel.size ? `<div class="ss-bulk"><b>${S.sel.size}</b> selected <button type="button" class="btn btn-ghost tn-mini" data-ss-bulk="emails">Copy emails</button><button type="button" class="btn btn-ghost tn-mini" data-ss-bulk="csv">Export</button><button type="button" class="btn btn-ghost tn-mini" data-ss-bulk="clear">Clear</button></div>` : ""}
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-bottom:6px"><button type="button" class="btn btn-ghost tn-mini" data-ss-csv>Export CSV (${list.length})</button></div>
      <div style="overflow-x:auto"><table class="ss-table stack"><thead><tr><th><input type="checkbox" data-ss-all aria-label="Select all shown"></th>${th("name", "Student")}${th("school", "School")}${th("building", "Property · unit · bed")}${th("check_in", "Arrival")}${th("check_out", "Departure")}<th>Status</th><th>Arrival email</th><th>App</th></tr></thead>
      <tbody>${shown.map((r) => `<tr data-ss-open="${e(r.student_id)}">
        <td data-l="Select"><input type="checkbox" data-ss-sel="${e(r.stay_id)}" ${S.sel.has(r.stay_id) ? "checked" : ""} aria-label="Select"></td>
        <td data-l="Student"><b>${e(r.name)}</b>${r.stays > 1 ? ` <span class="ss-tag info" title="${r.stays} stays">Returning</span>` : ""}${r.open_reviews ? ` <span class="ss-tag warn">Review</span>` : ""}<br><span class="ss-sub">${e(r.email || "no email")}</span></td>
        <td data-l="School">${e(r.school)}<br><span class="ss-sub">${e(r.city)}</span></td>
        <td data-l="Room">${e(r.building)}<br><span class="ss-sub">${e([r.unit, r.bed].filter(Boolean).join(" · ") || "—")}</span></td>
        <td data-l="Arrival" class="ss-nw">${r.check_in ? fmt(r.check_in) : `<span class="ss-sub">unknown</span>`}</td>
        <td data-l="Departure" class="ss-nw">${r.check_out ? fmt(r.check_out) : `<span class="ss-tag warn">No date</span>`}${r.check_out && live(r) ? `<br><span class="ss-sub">${SS_CORE.days(T, r.check_out)} days left</span>` : ""}</td>
        <td data-l="Status">${stageTag(r)}</td><td data-l="Arrival email">${mailTag(r)}</td><td data-l="App">${appTag(r)}</td></tr>`).join("")
        || `<tr><td colspan="9" class="ss-sub">No students match. Try another view or clear a filter.</td></tr>`}</tbody></table></div>
      <div class="ss-sub" style="margin-top:6px">${list.length} stay${list.length === 1 ? "" : "s"}${list.length > shown.length ? ` · first ${shown.length} shown, narrow the filters to see the rest` : ""}</div>`;
  }
  function propView(list) {
    const T = today(), f = S.f;
    const blds = uniq(list.map((r) => r.building).concat(f.building ? [f.building] : []));
    if (!blds.length) return `<div class="card tn-empty">No properties match.</div>`;
    return blds.map((b) => {
      const bd = SS_CORE.beds(S.rows.filter((r) => !f.school || r.school === f.school), b, T);
      const occ = bd.filter((x) => x.now).length;
      const arr = S.rows.filter((r) => r.building === b && r.stage === "upcoming" && r.check_in <= SS_CORE.addDays(T, 14)).length;
      const lv = S.rows.filter((r) => r.building === b && SS_CORE.inView(r, "leaving", T)).length;
      const city = (S.rows.find((r) => r.building === b) || {}).city || "";
      return `<div class="card ss-pc"><div class="ss-pch"><div><b style="font-size:15px">${e(b)}</b><br><span class="ss-sub">${e(city)} · ${bd.length} bed${bd.length === 1 ? "" : "s"} seen in rosters</span></div>
        <div><div class="ss-ob"><i style="width:${bd.length ? Math.round((100 * occ) / bd.length) : 0}%"></i></div><span class="ss-sub"><b>${occ}</b> of ${bd.length} filled · ${arr} arriving · ${lv} leaving (14 days)</span></div>
        <button type="button" class="btn btn-ghost tn-mini" data-ss-tl="${e(b)}">Timeline</button></div>
        <div style="overflow-x:auto"><table class="ss-table stack"><thead><tr><th>Unit · bed</th><th>Now</th><th>Until</th><th>Next</th></tr></thead><tbody>
        ${bd.map((x) => `<tr><td data-l="Unit · bed"><b>${e([x.unit, x.bed].filter(Boolean).join(" · ") || "—")}</b></td>
          <td data-l="Now">${x.now ? `<a href="#" data-ss-open="${e(x.now.student_id)}">${e(x.now.name)}</a> <span class="ss-sub">${e(x.now.school)}</span>` : `<span class="ss-tag">Empty</span>`}</td>
          <td data-l="Until" class="ss-nw">${x.now ? fmt(x.now.check_out) : "—"}</td>
          <td data-l="Next">${x.next ? `<a href="#" data-ss-open="${e(x.next.student_id)}">${e(x.next.name)}</a> <span class="ss-sub ss-nw">${fmt(x.next.check_in)}</span>` : `<span class="ss-sub">—</span>`}</td></tr>`).join("")}
        </tbody></table></div></div>`;
    }).join("");
  }
  function timeView() {
    const T = today(), f = S.f;
    const choices = uniq(S.rows.filter((r) => !f.city || r.city === f.city).map((r) => r.building));
    const b = f.building || S.tlBuilding || choices[0];
    if (!b) return `<div class="card tn-empty">No properties.</div>`;
    const start = SS_CORE.addDays(T, -30), end = SS_CORE.addDays(T, 75), span = SS_CORE.days(start, end);
    const pos = (d) => Math.max(0, Math.min(100, (100 * SS_CORE.days(start, d)) / span));
    const months = []; for (let d = start.slice(0, 8) + "01"; d <= end; d = SS_CORE.addDays(d.slice(0, 8) + "28", 5).slice(0, 8) + "01") if (d >= start) months.push(d);
    const bd = SS_CORE.beds(S.rows.filter((r) => !f.school || r.school === f.school), b, T).filter((x) => (!f.unit || x.unit === f.unit) && (!f.bed || x.bed === f.bed));
    return `<div class="ss-bar"><label class="ss-sub">Property <select class="form-input" data-ss-tlpick style="width:auto;display:inline-block">${choices.map((c) => `<option${c === b ? " selected" : ""}>${e(c)}</option>`).join("")}</select></label>
      <span class="ss-sub">Bars are stays; the red line is today. Click a bar to open the student.</span></div>
      <div class="ss-tl"><div class="ss-tlr head"><div></div><div class="ss-tlt">${months.map((m) => `<span style="left:${pos(m)}%">${new Date(m + "T12:00:00Z").toLocaleDateString("en-CA", { month: "short", timeZone: "UTC" })}</span>`).join("")}</div></div>
      ${bd.map((x) => `<div class="ss-tlr"><div class="ss-tlb" title="${e([x.unit, x.bed].join(" "))}">${e([x.unit, x.bed].filter(Boolean).join(" · ") || "—")}</div><div class="ss-tlt"><i class="now" style="left:${pos(T)}%"></i>
        ${x.stays.filter((r) => r.check_out && r.check_out > start && (r.check_in || r.check_out) < end).map((r) => { const a = r.check_in || SS_CORE.addDays(r.check_out, -7);
          return `<button type="button" class="${e(r.stage)}" style="left:${pos(a)}%;width:${Math.max(2, pos(r.check_out) - pos(a))}%" data-ss-open="${e(r.student_id)}" title="${e(r.name)} ${fmt(r.check_in)}–${fmt(r.check_out)}">${e(String(r.name).split(" ")[0])}</button>`; }).join("")}</div></div>`).join("")}</div>`;
  }

  const RV_LABEL = { shared_email: "Shared or school inbox", missing_email: "No email", bad_date: "Date missing or wrong", bed_clash: "Two students in one bed",
    not_in_roster: "Not in the latest roster", unknown_building: "Unknown building", import: "Sheet import problem" };
  function reviews() {
    if (!S.reviews.length) return `<div class="card tn-empty">Nothing to check. New roster problems land here.</div>`;
    const order = ["not_in_roster", "bed_clash", "bad_date", "shared_email", "missing_email", "import", "unknown_building"];
    const list = S.reviews.slice().sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || String(a.name).localeCompare(String(b.name)));
    return `<div class="card-sub hb-note">A student missing from one roster is never marked as moved out on their own: say <b>Still here</b> or <b>Moved out</b>. Shared inboxes get no app link until you add the student's own email.</div>
      ${list.map((r) => { const d = r.detail || {};
        const what = r.kind === "bed_clash" ? `Same bed as <b>${e(d.other || "?")}</b> (${e(d.room || "")})${d.same_name ? " · same name, probably one person with two emails" : ""}`
          : r.kind === "shared_email" ? `${e(d.email || r.email)} · ${e(d.reason || (d.also ? "also used by " + d.also : ""))}`
          : r.kind === "not_in_roster" ? `Not in the latest ${e(d.building || "")} roster${d.roster ? ` (${e(d.roster)})` : ""}`
          : r.kind === "import" ? e((d.problems || []).join("; ")) + (d.row ? ` <span class="ss-sub">sheet ${e(d.row)}</span>` : "")
          : r.kind === "bad_date" ? e(d.reason || "") : "";
        const acts = r.kind === "not_in_roster" ? `<button class="btn btn-primary tn-mini" data-ss-dec="still_here|${r.id}">Still here</button><input type="date" class="form-input" data-ss-date="${r.id}" style="width:auto"><button class="btn btn-ghost tn-mini" data-ss-dec="left|${r.id}">Moved out</button>`
          : r.kind === "bed_clash" ? `${d.same_name ? `<button class="btn btn-primary tn-mini" data-ss-dec="merge|${r.id}">Merge profiles</button>` : ""}<button class="btn btn-ghost tn-mini" data-ss-dec="ok|${r.id}">Shared room, OK</button>`
          : r.kind === "bad_date" ? `<input type="date" class="form-input" data-ss-out="${r.id}" style="width:auto" aria-label="Departure"><button class="btn btn-primary tn-mini" data-ss-dec="set_dates|${r.id}">Save date</button>`
          : r.kind === "shared_email" || r.kind === "missing_email" ? `<input class="form-input" data-ss-email="${r.id}" placeholder="Student's own email" style="width:220px"><button class="btn btn-primary tn-mini" data-ss-dec="set_email|${r.id}">Save</button><button class="btn btn-ghost tn-mini" data-ss-dec="ok|${r.id}">Leave as is</button>`
          : `<button class="btn btn-ghost tn-mini" data-ss-dec="ok|${r.id}">Done</button>`;
        return `<div class="card td-item"><div class="ss-rv"><div><span class="ss-tag ${r.kind === "not_in_roster" || r.kind === "bed_clash" ? "warn" : ""}">${e(RV_LABEL[r.kind] || r.kind)}</span>
          <a href="#" data-ss-open="${e(r.student_id)}"><b>${e(r.name || "?")}</b></a> <span class="ss-sub">${e([r.school, r.building, r.unit, r.bed].filter(Boolean).join(" · "))}${r.check_out ? " · until " + fmt(r.check_out) : ""}</span>
          <div style="margin-top:4px;font-size:13px">${what}</div></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${acts}<button class="btn btn-ghost tn-mini" data-ss-dec="dismiss|${r.id}" title="Not a problem">Dismiss</button></div></div></div>`; }).join("")}`;
  }
  function sync() {
    if (!S.sync.length) return `<div class="card tn-empty">No school rosters read yet.</div>`;
    const stale = (x) => Date.now() - Date.parse(x.last_received_at) > 8 * 864e5;
    return `<div class="card-sub hb-note">Rosters are read from email by the existing intake (Limpio → Arrivals). If a file can't be read or a building isn't known, vreal@ gets an alert email. A school with no roster for over a week is marked.</div>
      <div class="card"><table class="ss-table stack"><thead><tr><th>School · city</th><th>Last roster</th><th>File</th><th>Rows in 7 days</th></tr></thead><tbody>
      ${S.sync.map((x) => `<tr><td data-l="School"><b>${e(x.school)}</b> ${e(x.city)}</td><td data-l="Last roster" class="ss-nw">${e(ago(x.last_received_at))} ${stale(x) ? `<span class="ss-tag warn">No roster for a week</span>` : ""}</td><td data-l="File"><span class="ss-sub">${e(x.last_file || "")}</span></td><td data-l="Rows">${x.rows_last_7d}</td></tr>`).join("")}</tbody></table></div>`;
  }
  function gapCount(b) {
    const t = b.template || {}, g = b.guide || {};
    return [t.reviewed && t.checkin, !b.no_door_code, !b.no_wifi, t.rules, t.checkout, g.laundry, g.garbage, g.photos, b.address].filter((x) => !x).length;
  }
  function buildings() {
    const f = S.f;
    const list = S.bldg.filter((b) => !f.city || b.city === f.city);
    if (!list.length) return `<div class="card tn-empty">No buildings with current or upcoming school students.</div>`;
    const ok = (v, partial) => (v ? `<span class="ss-ok">✓</span>` : partial ? `<span class="ss-mid">${partial}</span>` : `<span class="ss-no">missing</span>`);
    const part = (g, k) => (!g || !g.properties ? null : g[k] === g.properties ? true : g[k] ? `${g[k]} of ${g.properties}` : null);
    return `<div class="card-sub hb-note">What students see in their arrival email and the app comes from three places. Check-in, rules and check-out are in the building's <b>Arrivals template</b>; door codes and Wi-Fi are in <b>Arrivals › codes</b>; laundry, garbage and photos are in each property's <b>House guide</b> (Properties &amp; rooms). Fill a gap there and both the email and the app show it.</div>
      <div class="card" style="overflow-x:auto"><table class="ss-table stack"><thead><tr><th>Building</th><th>Students</th><th>Address</th><th>Check-in</th><th>Door codes</th><th>Wi-Fi</th><th>House rules</th><th>Check-out</th><th>Laundry</th><th>Garbage</th><th>Photos</th></tr></thead><tbody>
      ${list.map((b) => { const t = b.template || {}, g = b.guide || {};
        const gp = (k) => { const p = part(g, k); return p === true ? ok(true) : ok(false, p || (!g.properties ? "no property linked" : null)); };
        return `<tr><td data-l="Building"><b>${e(b.building)}</b><br><span class="ss-sub">${e(b.city || "")}</span></td><td data-l="Students">${b.students}${b.upcoming ? ` <span class="ss-sub">+${b.upcoming}</span>` : ""}</td>
          <td data-l="Address">${ok(b.address)}</td><td data-l="Check-in">${ok(t.reviewed && t.checkin, t.checkin && !t.reviewed ? "not reviewed" : null)}</td>
          <td data-l="Door codes">${ok(!b.no_door_code, b.no_door_code ? `${b.no_door_code} student${b.no_door_code > 1 ? "s" : ""} without` : null)}</td>
          <td data-l="Wi-Fi">${ok(!b.no_wifi, b.no_wifi ? `${b.no_wifi} without` : null)}</td><td data-l="House rules">${ok(t.rules)}</td><td data-l="Check-out">${ok(t.checkout)}</td>
          <td data-l="Laundry">${gp("laundry")}</td><td data-l="Garbage">${gp("garbage")}</td><td data-l="Photos">${gp("photos")}</td></tr>`; }).join("")}</tbody></table></div>`;
  }

  function drawer() {
    const D = S.detail;
    if (!D) return `<aside class="ss-drawer"><button class="btn btn-ghost tn-mini" data-ss-close style="float:right">Close</button><div class="ss-sub">Loading…</div></aside>`;
    const s = D.student || {}, stays = D.stays || [], cur = stays.find((y) => y.stage === "current") || stays.find((y) => y.stage === "upcoming") || stays[0] || {};
    const tabs = [["ov", "Overview"], ["st", `Stays (${stays.length})`], ["ms", "Messages"], ["ch", "Changes"]];
    const T = today();
    const codes = cur.stage === "upcoming" ? `Shown from ${fmt(cur.check_in)}` : cur.stage === "past" ? "Hidden, stay ended" : cur.check_out ? `Shown until ${fmt(cur.check_out)}` : "Shown (no departure date)";
    const editing = S.edit && S.dtab === "ov";
    const stayEd = (y) => `<div class="ss-stay-ed"><b>${e(y.building)} ${e([y.unit, y.bed].filter(Boolean).join(" · "))}</b> ${stageTag(y)}
        <div class="row"><label>Arrival<input type="date" class="form-input" data-ss-ein="${y.id}" value="${e(y.check_in || "")}"></label>
        <label>Departure<input type="date" class="form-input" data-ss-eout="${y.id}" value="${e(y.check_out || "")}"></label></div>
        <div class="row" style="margin-top:6px"><button class="btn btn-primary tn-mini" data-ss-ed="dates|${y.id}">Save dates</button>
        ${y.left_confirmed_at ? `<button class="btn btn-ghost tn-mini" data-ss-ed="still|${y.id}">Undo moved out</button>`
          : `<input type="date" class="form-input" data-ss-eleft="${y.id}" style="width:auto" aria-label="Moved out on"><button class="btn btn-ghost tn-mini" data-ss-ed="left|${y.id}">Moved out on this day</button>`}</div></div>`;
    const editForm = `<div class="ss-edit"><label>Name<input class="form-input" id="ss-e-name" value="${e(s.name || "")}"></label>
        <label>Email (the student's own: it is their app sign-in)<input class="form-input" id="ss-e-email" value="${e(s.email || "")}"></label>
        <label>Phone<input class="form-input" id="ss-e-phone" value="${e(s.phone || "")}"></label>
        <div class="row"><button class="btn btn-primary tn-mini" data-ss-ed="profile|${s.id}">Save profile</button><button class="btn btn-ghost tn-mini" data-ss-ed="cancel|">Done editing</button></div>
        <div class="ss-sub">Stays: fix the dates if the school roster is wrong. A newer roster with a different date replaces your fix. The room itself comes from the roster: change it in Arrivals.</div>
        ${stays.filter((y) => !y.cancelled).map(stayEd).join("")}</div>`;
    const body = editing ? editForm : S.dtab === "ov" ? `<button class="btn btn-ghost tn-mini" data-ss-ed="open|" style="float:right">Edit</button><dl class="ss-kv"><dt>Email</dt><dd>${e(s.email || "none")}${s.shared_email ? ` <span class="ss-tag warn">shared inbox</span>` : ""}</dd><dt>Phone</dt><dd>${e(s.phone || "—")}</dd>
        <dt>School</dt><dd>${e(cur.school || s.school)} · ${e(cur.city || s.city)}</dd><dt>Property</dt><dd>${e(cur.building || "—")}</dd><dt>Unit · bed</dt><dd>${e([cur.unit, cur.bed].filter(Boolean).join(" · ") || "—")}</dd>
        <dt>Stay</dt><dd>${fmt(cur.check_in, 1)} → ${fmt(cur.check_out, 1)}${cur.check_in && cur.check_out ? ` (${SS_CORE.days(cur.check_in, cur.check_out)} nights)` : ""}</dd>
        <dt>Codes in the app</dt><dd>${codes}</dd><dt>App</dt><dd>${s.app_activated_at ? `Active since ${fmt(SS_CORE.iso(s.app_activated_at), 1)}` : s.shared_email || !s.email ? "No own email, no app link" : "Not activated yet"}</dd>
        <dt>Open reviews</dt><dd>${(D.reviews || []).filter((r) => r.status === "open").length || "none"}</dd></dl>
        ${cur.arrival_id ? `<a class="btn btn-ghost tn-mini" href="arrivals.html" target="_blank" rel="noopener">Open Arrivals</a>` : ""}`
      : S.dtab === "st" ? `<ul class="ss-line">${stays.map((y) => `<li><b>${e(y.building)} ${e([y.unit, y.bed].filter(Boolean).join(" · "))}</b> ${stageTag(y)}<small>${fmt(y.check_in, 1)} → ${fmt(y.check_out, 1)} · ${e(y.school)} · ${y.source === "import" ? "from the master sheet" : "from rosters"}</small></li>`).join("") || "<li>No stays</li>"}</ul>
        <div class="ss-sub">Room changes and extensions from new rosters add lines here. A returning student keeps this profile.</div>`
      : S.dtab === "ms" ? `<ul class="ss-line">${(D.messages || []).map((m) => `<li>Arrival email · ${e(m.building)}<small>${m.sent_at ? "sent " + fmt(SS_CORE.iso(m.sent_at), 1) : e(m.status)}${m.opened_at ? ` · opened${m.open_count > 1 ? " " + m.open_count + "×" : ""}` : m.sent_at ? " · not opened" : ""}</small></li>`).join("") || "<li>No arrival emails</li>"}</ul>`
      : `<ul class="ss-line">${(D.changes || []).map((c) => `<li>${e(changeText(c))}<small>${e(fmt(SS_CORE.iso(c.at), 1))} · ${e(c.by === "system" ? "automatic" : c.by)}</small></li>`).join("") || "<li>No changes</li>"}</ul>`;
    return `<aside class="ss-drawer"><button class="btn btn-ghost tn-mini" data-ss-close style="float:right">Close</button><h2>${e(s.name)}</h2><div class="ss-sub">${e(s.school)} student · ${e(s.city)}</div>
      <p>${stageTag(cur)}${stays.length > 1 ? ` <span class="ss-tag info">Returning</span>` : ""}</p>
      <div class="ss-dt">${tabs.map(([k, l]) => `<button type="button" class="${S.dtab === k ? "on" : ""}" data-ss-dtab="${k}">${l}</button>`).join("")}</div>${body}</aside>`;
  }
  function changeText(c) {
    const d = c.detail || {};
    if (c.kind === "created") return "Profile created";
    if (c.kind === "new_stay") return `New stay: ${[d.building, d.unit, d.bed].filter(Boolean).join(" ")}, ${fmt(d.check_in)} → ${fmt(d.check_out)}${d.roster ? " (" + d.roster + ")" : ""}`;
    if (c.kind === "room_change") return d.to ? `Room changed: ${d.from} → ${d.to}` : `Moved to ${[d.building, d.unit, d.bed].filter(Boolean).join(" ")}${d.from ? " from " + d.from : ""}`;
    if (c.kind === "dates_changed") {
      const io = (k) => { const v = d[k] || []; return v[0] !== v[1] ? `${k === "check_in" ? "arrival" : "departure"} ${fmt(v[0])} → ${fmt(v[1])}` : ""; };
      const what = { extension: "Extended", shortened: "Shortened", room_move: "Moved rooms, this stay ended", corrected: "Dates corrected", moved_out: "Moved out" }[d.what] || "Dates moved";
      return `${what}: ${[io("check_in"), io("check_out")].filter(Boolean).join(", ") || "no change"}`;
    }
    if (c.kind === "edited") return `Profile edited: ${Object.keys(d.to || {}).map((k) => `${k} ${(d.from || {})[k] || "—"} → ${(d.to || {})[k] || "—"}`).join(", ")}`;
    if (c.kind === "imported") return `Imported from ${d.source || "the sheet"}${d.row ? " (" + d.row + ")" : ""}`;
    if (c.kind === "linked_to_roster") return `Matched to a roster${d.roster ? " (" + d.roster + ")" : ""}`;
    if (c.kind === "review") return `Review: ${RV_LABEL[d.kind] || d.kind} → ${d.decision}`;
    if (c.kind === "merged") return `Merged with ${d.from}${d.email ? " (" + d.email + ")" : ""}`;
    if (c.kind === "cancelled") return "Stay cancelled";
    if (c.kind === "restored") return "Stay restored";
    return c.kind;
  }

  async function openStudent(id) {
    S.open = id; S.detail = null; S.dtab = "ov"; S.edit = false; render();
    const { data, error } = await sb().rpc("school_student_detail", { p_student: id });
    if (error) { toast(error.message); S.open = null; } else S.detail = data;
    render();
  }
  async function decide(kind, id) {
    const p = {};
    if (kind === "left") { const v = (document.querySelector(`[data-ss-date="${id}"]`) || {}).value; if (v) p.date = v; }
    if (kind === "set_dates") { const v = (document.querySelector(`[data-ss-out="${id}"]`) || {}).value; if (!v) return toast("Pick the departure date first"); p.check_out = v; }
    if (kind === "set_email") { const v = ((document.querySelector(`[data-ss-email="${id}"]`) || {}).value || "").trim(); if (!v) return toast("Type the student's own email first"); p.email = v; }
    const { data, error } = await sb().rpc("school_review_decide", { p_review: id, p_decision: kind, p });
    if (error || !data || !data.ok) return toast(error ? error.message : errText(data && data.error));
    toast("Saved");
    await load(); render();
  }
  function errText(c) {
    return { email: "That email is a school or agency inbox, or not an email", email_taken: "Another student already has that email",
      order: "The arrival must be before the departure", date: "Pick a date first", name: "The name can't be empty" }[c] || "Couldn't save";
  }
  async function edit(kind, id) {
    if (kind === "open") { S.edit = true; return render(); }
    if (kind === "cancel") { S.edit = false; return render(); }
    const val = (sel) => ((document.querySelector(sel) || {}).value || "").trim();
    let res;
    if (kind === "profile") res = await sb().rpc("school_student_edit", { p_student: id, p: { name: val("#ss-e-name"), email: val("#ss-e-email"), phone: val("#ss-e-phone") } });
    else if (kind === "dates") {
      const p = {}, i = val(`[data-ss-ein="${id}"]`), o = val(`[data-ss-eout="${id}"]`);
      if (i) p.check_in = i;
      if (!o) return toast("Pick the departure date");
      p.check_out = o;
      res = await sb().rpc("school_stay_edit", { p_stay: id, p });
    } else if (kind === "left") {
      const v = val(`[data-ss-eleft="${id}"]`);
      if (!v) return toast("Pick the day they moved out");
      res = await sb().rpc("school_stay_edit", { p_stay: id, p: { moved_out: v } });
    } else if (kind === "still") res = await sb().rpc("school_stay_edit", { p_stay: id, p: { still_here: true } });
    else return;
    const { data, error } = res;
    if (error || !data || !data.ok) return toast(error ? error.message : errText(data && data.error));
    toast("Saved");
    const sid = S.open;
    await load();
    const r = await sb().rpc("school_student_detail", { p_student: sid });
    if (!r.error) S.detail = r.data;
    render();
  }
  function download(name, text) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" })); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function wire() {
    const root = $("ss-root");
    if (!root || root.dataset.wired) return;
    root.dataset.wired = "1";
    root.addEventListener("click", (ev) => {
      const t = ev.target.closest("[data-ss-tab],[data-ss-city],[data-ss-mode],[data-ss-view],[data-ss-act],[data-ss-split],[data-ss-clear],[data-ss-sort],[data-ss-open],[data-ss-close],[data-ss-dtab],[data-ss-dec],[data-ss-ed],[data-ss-tl],[data-ss-csv],[data-ss-bulk]");
      if (!t || ev.target.matches("input[type=checkbox]")) return;
      const d = t.dataset;
      if (d.ssTab) { S.tab = d.ssTab; }
      else if (d.ssCity != null) { S.f.city = d.ssCity; delete S.f.building; delete S.f.unit; delete S.f.bed; delete S.f.school; }
      else if (d.ssMode) S.mode = d.ssMode;
      else if (d.ssView) S.view = d.ssView;
      else if (d.ssAct) { const [k, v] = d.ssAct.split(":"); if (k === "t") S.tab = v; else { S.view = v; S.mode = "list"; } }
      else if (d.ssSplit) { const p = d.ssSplit.split(" · "); if (p.length > 1) S.f.city = p[0]; S.f.school = p[p.length - 1]; }
      else if (d.ssClear) { if (d.ssClear === "*") S.f = {}; else { delete S.f[d.ssClear]; if (d.ssClear === "building") { delete S.f.unit; delete S.f.bed; } } }
      else if (d.ssSort) S.sort = d.ssSort;
      else if (d.ssOpen) { ev.preventDefault(); return openStudent(d.ssOpen); }
      else if (d.ssClose != null) { S.open = null; S.detail = null; }
      else if (d.ssDtab) { S.dtab = d.ssDtab; S.edit = false; }
      else if (d.ssDec) { const [k, id] = d.ssDec.split("|"); return decide(k, id); }
      else if (d.ssEd) { const [k, id] = d.ssEd.split("|"); return edit(k, id); }
      else if (d.ssTl) { S.tlBuilding = d.ssTl; S.f.building = d.ssTl; S.mode = "time"; }
      else if (d.ssCsv != null) return download(`school-students-${today()}.csv`, SS_CORE.csv(SS_CORE.filter(S.rows, S.view, S.f, today())));
      else if (d.ssBulk) {
        const picked = S.rows.filter((r) => S.sel.has(r.stay_id));
        if (d.ssBulk === "clear") S.sel.clear();
        else if (d.ssBulk === "csv") return download(`school-students-selected-${today()}.csv`, SS_CORE.csv(picked));
        else if (d.ssBulk === "emails") { const list = uniq(picked.filter((r) => r.email && !r.shared_email).map((r) => r.email)).join(", ");
          navigator.clipboard && navigator.clipboard.writeText(list).then(() => toast(`${list.split(", ").filter(Boolean).length} emails copied`), () => toast(list)); return; }
      }
      render();
    });
    root.addEventListener("change", (ev) => {
      const t = ev.target;
      if (t.dataset.ssSel) { t.checked ? S.sel.add(t.dataset.ssSel) : S.sel.delete(t.dataset.ssSel); return render(); }
      if (t.dataset.ssAll != null) { const list = SS_CORE.filter(S.rows, S.view, S.f, today()).slice(0, 600); list.forEach((r) => (t.checked ? S.sel.add(r.stay_id) : S.sel.delete(r.stay_id))); return render(); }
      if (t.dataset.ssTlpick != null) { S.tlBuilding = t.value; if (S.f.building) S.f.building = t.value; return render(); }
      const key = Object.keys(F_IDS).find((k) => F_IDS[k] === t.id);
      if (!key || key === "q") return;
      if (t.value) S.f[key] = t.value; else delete S.f[key];
      if (key === "city") { delete S.f.building; delete S.f.unit; delete S.f.bed; }
      if (key === "building") { delete S.f.unit; delete S.f.bed; }
      if (key === "unit") delete S.f.bed;
      render();
    });
    let tq;
    root.addEventListener("input", (ev) => {
      if (ev.target.id !== "ss-q") return;
      clearTimeout(tq);
      tq = setTimeout(() => { const pos = ev.target.selectionStart; S.f.q = ev.target.value || undefined; if (!S.f.q) delete S.f.q; render(); const q = $("ss-q"); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (x) {} } }, 200);
    });
    document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && S.open) { S.open = null; S.detail = null; render(); } });
  }

  // Header search while on this page searches school students (not Tenants).
  window.schoolStudentsSearch = function (q) {
    S.tab = "students"; S.mode = S.mode || "list";
    if (q) { S.f.q = q; if (S.view !== "all") S.view = "all"; } else { delete S.f.q; S.view = "current"; }
    render();
  };
  window.loadSchoolStudents = async function () { wire(); render(); await load(); render(); };
  // Review badge in the sidebar, for staff, shortly after sign-in.
  setTimeout(async () => { if (isStaff() && sb()) { try { const { data } = await sb().rpc("school_reviews_open"); if (Array.isArray(data)) { S.reviews = data; setBadge(); } } catch (x) {} } }, 4000);
})();
