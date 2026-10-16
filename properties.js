/* Properties & rooms (portal): one page per property with its real rooms, tenants and house facts, and an
   all-rooms list. Loaded by index.html after the main script (uses esc, showToast, goToView, properties,
   tenants, landlords, tnStage, tnKey, tnToday, tnFmt, openTenant, openAddTenantModal, ppRows, ppMoney,
   ppPct, ppCanSeeMoney, llModel, llYmd, llBuilding, vacFromInventory, vacRoomUrl, vacAsanaUrl, vacShareText,
   invSelectAll, PP_UI, TN and window.vmDb.sb).

   Why a matcher: the portal's property names ("Blood Alley · 502", "Broadway 923 E") are what Tenants and
   Landlords use, but the Asana room inventory (inventory_rooms / inventory_properties, mirrored by the
   vanmates-inventory-sync Worker) and the Arrivals access tables (access_buildings / access_units /
   access_rooms) each name the same places differently ("Blood Alley Residence", "Elliot - Unit 502 - Blood
   alley Residence", "923 E Broadway House", "ELM & THE LEDBURY"). PR-CORE resolves an inventory room or an
   access unit to one portal property row by shared name words plus the unit number, and a tenant to one
   inventory room by the room name. Nothing is written: it is a read-time join, so a wrong match never
   changes data, and every room that does not resolve is listed rather than guessed.

   Read only. Door codes, Wi-Fi passwords and house codes are never selected (Arrivals keeps those).
   Asana House Profile facts (no codes) are read from properties.data.profile when present. */
(function () {
  // ── PR-CORE: pure helpers (window.PR_CORE, tested in test/properties-rooms.test.js) ──
  const STOP = new Set(["the", "house", "houses", "residence", "residences", "apartment", "apartments", "apartament", "apartamento",
    "app", "apt", "unit", "units", "building", "tower", "rue", "home", "street", "st", "ave", "avenue", "tenants", "and", "de", "of", "la", "le"]);
  // Spellings that mean the same building. Ledbury's Asana units 1409/1609 are the portal's "Elm · 1409/1609 (West)"
  // (Hugo tenant_sections, 2026-10-15); "bood" is a typo in a few Blood Alley task names.
  const SAME = { ledbury: "elm", bood: "blood" };
  const norm = (s) => String(s == null ? "" : s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  function words(s) {
    const out = new Set();
    for (const w of norm(s).replace(/&/g, " ").split(/[^a-z0-9]+/)) {
      if (!w || /^\d+$/.test(w) || STOP.has(w)) continue;
      if (w.length < 2 && w !== "e" && w !== "w") continue;
      if (w === "e" || w === "w") continue; // "923 E Broadway": compass letters are noise for matching
      out.add(SAME[w] || w);
    }
    return out;
  }
  // Unit / street numbers: "Main St Units 102-202-204-205" → 102,202,204,205; "Unit 0905" → 905.
  function nums(s) {
    const out = new Set();
    for (const m of norm(s).match(/\d{3,4}(?!\d)/g) || []) out.add(String(Number(m)));
    return out;
  }
  // "Units 101-105" (exactly one pair, same hundred) also covers 102–104; a list like "102-202-204-205" is not a range.
  function range(s) {
    const out = new Set();
    const all = norm(s).match(/\d{3,4}/g) || [];
    const m = norm(s).match(/(\d{3,4})\s*-\s*(\d{3,4})(?![-\d])/);
    if (!m || all.length !== 2) return out;
    const a = Number(m[1]), b = Number(m[2]);
    if (b > a && b - a <= 20 && Math.floor(a / 100) === Math.floor(b / 100)) for (let i = a; i <= b; i++) out.add(String(i));
    return out;
  }
  const inter = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };
  function cityKey(c) { const s = norm(c); return /montr/.test(s) ? "montreal" : s.trim(); }

  function index(props) {
    return (props || []).filter((p) => p && p.name).map((p) => ({
      name: p.name, city: cityKey(p.city), w: words(p.name), n: nums(p.name), range: range(p.name),
      building: typeof llBuilding === "function" ? llBuilding(p.name) : p.name,
    }));
  }
  // Resolve { building, room, city } to one portal property. Candidates share at least one name word with the
  // building; a unit number found in the room/building name that only one candidate carries wins; otherwise the
  // candidate sharing the most words (room words count too, so "Basement - Beatrice House" picks the basement)
  // and carrying the fewest extra words wins, when that is a single row.
  function resolve(idx, src) {
    const bw = words(src.building), rw = words(src.room), all = new Set([...bw, ...rw]);
    const c = src.city ? cityKey(src.city) : "";
    if (!bw.size) return { name: null, how: "none" };
    let cands = idx.filter((r) => (!c || !r.city || r.city === c) && inter(bw, r.w) > 0);
    if (!cands.length) return { name: null, how: "none" };
    const top = Math.max(...cands.map((r) => inter(bw, r.w)));
    // Never let a one-word overlap beat a full one ("Granville House" vs "Granville-Davie Apartment").
    cands = cands.filter((r) => inter(bw, r.w) === top || r.w.size && [...r.w].every((x) => bw.has(x)));
    const n = new Set([...nums(src.room), ...nums(src.building)]);
    if (n.size) {
      const hit = cands.filter((r) => inter(n, r.n) > 0);
      if (hit.length === 1) return { name: hit[0].name, how: "unit" };
      if (hit.length > 1) {
        const best = Math.max(...hit.map((r) => inter(n, r.n)));
        const h2 = hit.filter((r) => inter(n, r.n) === best);
        if (h2.length === 1) return { name: h2[0].name, how: "unit" };
      }
      if (!hit.length) {
        const hr = cands.filter((r) => inter(n, r.range) > 0);
        if (hr.length === 1) return { name: hr[0].name, how: "unit" };
      }
    }
    const score = (r) => inter(all, r.w) * 10 - [...r.w].filter((x) => !all.has(x)).length;
    const best = Math.max(...cands.map(score));
    const win = cands.filter((r) => score(r) === best);
    // A unit number that names no candidate means the room is in a unit the portal does not list: don't guess.
    const multiUnit = cands.some((r) => r.n.size);
    if (win.length === 1 && !(n.size && multiUnit && win[0].n.size)) return { name: win[0].name, how: "name" };
    const blds = [...new Set(cands.map((r) => r.building))];
    return { name: null, building: blds.length === 1 ? blds[0] : null, how: "ambiguous" };
  }
  // "Elliot - Unit 502 - Blood alley Residence" → { label: "Elliot", unit: "502" };
  // "Unit 3002 - Flex room / The Parker" → { label: "Flex room", unit: "3002" }; "Portland - Willow House" → "Portland".
  function roomLabel(task, building) {
    const s = String(task || "").replace(/\s+/g, " ").trim();
    const bw = words(building);
    const unitM = s.match(/\b(?:unit|app|apt)\.?\s*#?\s*(\d{1,4})/i) || s.match(/\b(\d{3,4})\b/);
    const segs = s.split(/\s+[-–\/]\s+|\s*\/\s*|\s+-(?=\S)|(?<=\d)-(?=[A-Za-z])/).map((x) => x.trim()).filter(Boolean);
    const keep = segs.filter((g) => {
      if (/^(?:unit|app|apt)\.?\s*#?\s*\d+/i.test(g) && words(g).size === 0) return false;
      const w = words(g);
      if (!w.size) return false;
      if (bw.size && [...w].every((x) => bw.has(x))) return false;
      return true;
    });
    let label = keep.length ? keep[0] : s;
    label = label.replace(/\b(?:unit|app|apt)\.?\s*#?\s*\d+\b/i, "").replace(/\s{2,}/g, " ").replace(/^[-–\s]+|[-–\s]+$/g, "").trim() || s;
    return { label, unit: unitM ? String(Number(unitM[1])) : "" };
  }
  const GENERIC = new Set(["room", "master", "standard", "std", "flex", "private", "bedroom", "bed", "suite", "shared", "small", "big", "large", "balcony", "without", "with", "ensuite", "bath", "bathroom", "whole", "basement", "rm"]);
  // Which of `rooms` (each { label, unit, task }) a tenant's free-text room ("Hitchcock (Master)", "Standard A",
  // "Room 14", "—") is. Returns the index, or -1 when nothing or more than one room fits.
  function tenantRoom(t, rooms) {
    const raw = String((t && t.room) || "").trim();
    if (!raw || raw === "—" || !rooms.length) return -1;
    const toks = (x) => norm(x).split(/[^a-z0-9]+/).filter(Boolean);
    const tw = toks(raw).filter((x) => !/^\d{3,4}$/.test(x));
    const tn = nums(raw);
    const distinct = tw.filter((x) => !GENERIC.has(x) && !/^\d+$/.test(x) && x.length > 1);
    const pool = rooms.map((r, i) => ({ i, r, w: new Set(toks(r.label)), all: new Set(toks(r.task)) }))
      .filter((x) => !tn.size || !x.r.unit || tn.has(x.r.unit));
    let hit = [];
    if (distinct.length) hit = pool.filter((x) => distinct.every((d) => x.w.has(d) || x.all.has(d)));
    if (!hit.length && tw.length) hit = pool.filter((x) => tw.every((d) => x.w.has(d)));
    // Generic kinds: "Flex" = "Flex room" = "Flexroom", "Master Bedroom" = "Master", "Standard" = "Std bedroom";
    // a letter ("Standard B") must agree when both sides have one.
    if (!hit.length) {
      const tk = kind(raw);
      if (tk.kind) {
        const same = pool.filter((x) => { const rk = kind(x.r.label); return rk.kind === tk.kind && (!tk.letter || !rk.letter || rk.letter === tk.letter); });
        const strict = tk.letter ? same.filter((x) => kind(x.r.label).letter === tk.letter) : same;
        hit = strict.length === 1 ? strict : same;
      }
    }
    if (hit.length > 1) { const exact = hit.filter((x) => norm(x.r.label).replace(/[^a-z0-9]/g, "") === norm(raw).replace(/[^a-z0-9]/g, "")); if (exact.length === 1) hit = exact; }
    return hit.length === 1 ? hit[0].i : -1;
  }
  function kind(label) {
    const s = norm(label).replace(/[()]/g, " ");
    const k = /\bflex|flexroom/.test(s) ? "flex" : /\bmaster/.test(s) ? "master" : /\b(standard|std)\b/.test(s) ? "standard" : "";
    const m = s.match(/\b(?:flex|flexroom|master|standard|std)(?:\s+(?:room|bedroom))?\s+([a-e]{1,2})\b/);
    return { kind: k, letter: m ? m[1] : "" };
  }
  // Room state, by the room's own city date (v.today): occupied | free | soon | later | hold.
  function roomState(v, tenant, mover) {
    if (v.status === "not_bookable" && !tenant) return { key: "hold", label: "Not bookable" };
    if (v.emptyNow && !tenant) return { key: "free", label: "Free now" };
    if (v.listable && v.from && v.from > v.today) {
      const d = Math.round((Date.parse(v.from) - Date.parse(v.today)) / 86400000);
      return { key: d <= 30 ? "soon" : "later", label: "Free from " + v.from, from: v.from, days: d };
    }
    if (tenant || v.status === "occupied" || v.status === "available_later" || v.status === "hidden") return { key: "occupied", label: "Occupied" };
    if (mover) return { key: "occupied", label: "Moving in" };
    return { key: v.emptyNow ? "free" : "hold", label: v.emptyNow ? "Free now" : "Not listed" };
  }
  // The model: every portal property with its inventory rooms, the tenant in each, the next arrival, the tenants
  // no room could be matched to, and the inventory rooms that match no property.
  // inv = vacFromInventory rows (+ bedrooms, bathrooms, layout); stageOf(t) = tnStage.
  // Contracts carry the exact Asana room (room_gid) and the signer emails: email → room gid, newest contract wins.
  function contractRooms(contracts) {
    const out = new Map();
    const rows = (contracts || []).filter((c) => c && String(c.status || "") !== "void")
      .map((c) => ({ c, b: c.booking || {}, at: String(c.signed_at || c.created_at || c.updated_at || "") }))
      .sort((x, y) => x.at.localeCompare(y.at));
    for (const { c, b } of rows) {
      const gid = String(c.room_gid || b.room_gid || "").trim();
      if (!/^\d{6,30}$/.test(gid)) continue;
      for (const e of [c.client_email, b.t1_email, b.t2_email, b.email]) { const k = String(e || "").trim().toLowerCase(); if (k) out.set(k, gid); }
    }
    return out;
  }
  function model(props, tns, inv, stageOf, byEmail) {
    const idx = index(props);
    const by = new Map(idx.map((r) => [r.name, { name: r.name, building: r.building, rooms: [], tenants: [], loose: [] }]));
    const unmatched = [];
    for (const v of inv || []) {
      if (!v) continue;
      let r = resolve(idx, { building: v.prop || v.room.split(/\s+[-\/]\s+/).pop(), room: v.room, city: v.city });
      // "Bidwell - Unit 1169 Granville-Davie": the inventory building is the room's name; the task names the building.
      if (!r.name && v.prop) { const r2 = resolve(idx, { building: v.room, room: v.room, city: v.city }); if (r2.name) r = r2; }
      const lab = roomLabel(v.room, v.prop || (r.name ? llB(r.name) : ""));
      const room = Object.assign({}, v, { label: lab.label, unit: lab.unit, task: v.room, tenant: null, also: [], mover: null, how: r.how });
      if (r.name && by.has(r.name)) by.get(r.name).rooms.push(room);
      else if (v.status !== "hidden") unmatched.push(Object.assign(room, { building: r.building || "" }));
    }
    for (const t of tns || []) {
      if (!t || !t.property || !by.has(t.property)) continue;
      const s = stageOf(t);
      const e = by.get(t.property);
      e.tenants.push(t);
      if (s === "past") continue;
      const g = byEmail && byEmail.get(String(t.email || "").trim().toLowerCase());
      let i = g ? e.rooms.findIndex((r) => r.gid === g) : -1;
      if (i < 0) i = tenantRoom(t, e.rooms);
      if (i < 0) { e.loose.push(t); continue; }
      const room = e.rooms[i];
      if (s === "moving") { if (!room.mover || String(t.moveIn) < String(room.mover.moveIn)) room.mover = t; }
      else if (!room.tenant) room.tenant = t;
      else room.also.push(t); // two people on one room: a couple, or a renewal entered as a second row
    }
    // A whole unit with one room on file and one current tenant: that is the tenant's room.
    for (const e of by.values()) {
      if (e.rooms.length === 1 && !e.rooms[0].tenant) {
        const cur = e.loose.filter((t) => ["living", "ended"].includes(stageOf(t)));
        if (cur.length === 1) { e.rooms[0].tenant = cur[0]; e.loose = e.loose.filter((t) => t !== cur[0]); }
      }
      // Rooms Asana keeps in a hidden section (on hold, archived) only show while someone lives in them.
      e.rooms = e.rooms.filter((r) => r.status !== "hidden" || r.tenant || r.mover);
      const nat = (a, b) => String(a.unit).localeCompare(String(b.unit), undefined, { numeric: true }) || a.label.localeCompare(b.label, undefined, { numeric: true });
      e.rooms.sort(nat);
      e.rooms.forEach((r) => { r.state = roomState(r, r.tenant, r.mover); });
    }
    return { props: by, unmatched };
  }
  function llB(name) { return typeof llBuilding === "function" ? llBuilding(name) : name; }
  // Access (Arrivals) buildings/units → property rows, same matcher; a building with no unit resolves by name.
  function accessFor(props, buildings, units) {
    const idx = index(props);
    const out = new Map();
    const add = (name, k, v) => { if (!name) return; const e = out.get(name) || { building: null, units: [] }; if (k === "b") e.building = e.building || v; else e.units.push(v); out.set(name, e); };
    for (const u of units || []) {
      const r = resolve(idx, { building: u.building, room: u.unit ? "Unit " + u.unit : "", city: (buildings || []).find((b) => b.building === u.building)?.city });
      add(r.name, "u", u);
    }
    for (const b of buildings || []) {
      const hit = idx.filter((r) => (!b.city || cityKey(b.city) === r.city) && inter(words(b.building), r.w) > 0 && inter(words(b.building), r.w) === words(b.building).size);
      for (const r of hit) add(r.name, "b", b);
    }
    return out;
  }
  // Asana room-task facts copied onto the property row (data.asanaRooms = { <room gid>: { note, tour, website,
  // leaseStart, links } }, codes and Wi-Fi stripped). One gid → its facts, whichever row carries them.
  function roomNotes(props) {
    const out = new Map();
    for (const p of props || []) {
      const m = p && p.asanaRooms;
      if (!m || typeof m !== "object") continue;
      for (const [g, v] of Object.entries(m)) if (v && typeof v === "object") out.set(String(g), v);
    }
    return out;
  }
  const PR_CORE = { words, nums, index, resolve, roomLabel, tenantRoom, roomState, model, accessFor, contractRooms, roomNotes };
  window.PR_CORE = PR_CORE;
  if (typeof document === "undefined" || !document.querySelector) return;

  // ── page state ──
  const PR = { open: null, tab: "rooms", mode: "props", rq: "", rf: "all", inv: null, invAt: 0, access: null, loading: null, err: "", focus: "" };
  try { const s = JSON.parse(localStorage.getItem("vm_pr_ui") || "{}"); if (s.mode) PR.mode = s.mode; if (s.tab) PR.tab = s.tab; } catch (e) {}
  const save = () => { try { localStorage.setItem("vm_pr_ui", JSON.stringify({ mode: PR.mode, tab: PR.tab })); } catch (e) {} };
  const today = () => tnToday();
  const stage = (t) => tnStage(t, today());
  const money = () => typeof ppCanSeeMoney === "function" && ppCanSeeMoney();
  const cur = (city) => (/guadalajara/i.test(city || "") ? "MXN" : "CAD");
  const $ = (id) => document.getElementById(id);
  const dt = (iso) => (iso ? tnFmt(String(iso).slice(0, 10)) : "");
  const isCA = () => !window.vmCountry || window.vmCountry.current() !== "MX";

  async function load(force) {
    if (PR.loading) return PR.loading;
    if (PR.inv && !force && Date.now() - PR.invAt < 5 * 60000) return;
    const sb = window.vmDb && window.vmDb.sb;
    if (!sb || !isCA()) { PR.inv = []; PR.access = { buildings: [], units: [], rooms: [] }; return; }
    PR.loading = (async () => {
      try {
        const [rooms, props, ab, au, ar] = await Promise.all([
          invSelectAll(sb, "inventory_rooms", "id,asana_gid,asana_project_gid,city,property_id,task_name,room_type,room_type_override,lease_type,price_cents,status,available_from,available_from_approx,available_until,photo_urls,pictures_url,address,synced_at,bedrooms,bathrooms,layout_url", (q) => q.order("task_name").order("id")),
          invSelectAll(sb, "inventory_properties", "id,name,city,address", (q) => q.order("name").order("id")),
          sb.from("access_buildings").select("building,city,address,building_type,contact_url,checkin_video_url"),
          sb.from("access_units").select("building,unit,floor,whole_unit,whatsapp_url"),
          sb.from("access_rooms").select("building,unit,room_label,bed_type,room_note"),
        ]);
        const base = vacFromInventory(rooms, props, Date.now());
        const extra = new Map((rooms || []).map((r) => [String(r.asana_gid), r]));
        PR.inv = base.map((v) => { const r = extra.get(v.gid) || {}; return Object.assign(v, { bedrooms: r.bedrooms, bathrooms: r.bathrooms, layout: /^https?:\/\//.test(r.layout_url || "") ? r.layout_url : "" }); });
        PR.access = { buildings: (ab && ab.data) || [], units: (au && au.data) || [], rooms: (ar && ar.data) || [] };
        PR.invAt = Date.now(); PR.err = "";
      } catch (e) {
        console.error("[properties] inventory load failed", e);
        PR.err = "Could not load the room inventory: " + (e.message || e);
        PR.inv = PR.inv || [];
        PR.access = PR.access || { buildings: [], units: [], rooms: [] };
      } finally { PR.loading = null; }
    })();
    return PR.loading;
  }
  let M = null, Mkey = "";
  function getModel() {
    const k = [properties.length, tenants.length, (window.contracts || []).length, PR.invAt, (PR.inv || []).length, PR.accessAt || 0].join("|");
    if (M && Mkey === k) return M;
    M = PR_CORE.model(properties, tenants, PR.inv || [], stage, PR_CORE.contractRooms(window.contracts));
    M.access = PR_CORE.accessFor(properties, (PR.access || {}).buildings, (PR.access || {}).units);
    Mkey = k;
    return M;
  }
  // Rooms of a building (all its unit rows) or a single unit/house.
  function unitsOf(name) {
    const isRow = properties.some((p) => p.name === name);
    if (isRow) return [name];
    return properties.filter((p) => llBuilding(p.name) === name).map((p) => p.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  function ppRowOf(name) { return (typeof ppRows === "function" ? ppRows() : []).find((r) => r.name === name); }

  // ── shell: mode switch (Properties | Rooms) + detail container, added once ──
  function ensureShell() {
    const view = document.querySelector('.view[data-view="properties"]');
    if (!view || $("pr-detail")) return view;
    const seg = document.createElement("div");
    seg.className = "tn-seg pr-mode";
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Show");
    seg.innerHTML = `<button type="button" data-pr-mode="props">Properties</button><button type="button" data-pr-mode="rooms">All rooms</button>`;
    const tools = view.querySelector(".tn-tools");
    tools.insertBefore(seg, tools.firstChild);
    const rooms = document.createElement("div");
    rooms.id = "pr-rooms"; rooms.className = "card tn-card"; rooms.hidden = true;
    $("props-grid").after(rooms);
    const det = document.createElement("div");
    det.id = "pr-detail"; det.hidden = true;
    view.appendChild(det);
    view.addEventListener("click", onClick);
    view.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const t = e.target.closest("[data-pr-open],[data-pr-room]");
      if (t && t.tagName !== "BUTTON" && t.tagName !== "A") { e.preventDefault(); t.click(); }
    });
    view.addEventListener("input", (e) => {
      if (e.target.id === "pr-rq") { clearTimeout(PR.qt); PR.qt = setTimeout(() => { PR.rq = e.target.value; renderRooms(); }, 120); }
    });
    return view;
  }
  function setListVisible(on) {
    const view = document.querySelector('.view[data-view="properties"]');
    if (!view) return;
    ["pp-kpis", "pp-note", "props-city-tabs"].forEach((id) => { const el = $(id); if (el) el.classList.toggle("pr-off", !on); });
    view.querySelector(".tn-tools").classList.toggle("pr-off", !on);
    $("props-grid").classList.toggle("pr-off", !on || PR.mode === "rooms");
    $("pr-rooms").hidden = !on || PR.mode !== "rooms";
    ["pp-filters", "pp-sort", "pp-q", "pp-note"].forEach((id) => { const el = $(id); if (el) el.classList.toggle("pr-off", !on || PR.mode === "rooms"); });
    $("pr-detail").hidden = on;
  }

  // ── list decorations: free-room counts on the P&L table, after it renders ──
  function decorateList() {
    if (!PR.inv || !PR.inv.length) return;
    const m = getModel();
    document.querySelectorAll("#pp-body [data-pp-prop], #pp-body [data-pp-grp]").forEach((tr) => {
      const names = tr.dataset.ppProp ? [tr.dataset.ppProp] : unitsOf(tr.dataset.ppGrp);
      let free = 0, soon = 0;
      names.forEach((n) => { const e = m.props.get(n); if (e) e.rooms.forEach((r) => { if (r.state.key === "free") free++; else if (r.state.key === "soon") soon++; }); });
      const cell = tr.children[1];
      if (!cell || cell.querySelector(".pr-free")) return;
      if (free || soon) cell.insertAdjacentHTML("beforeend", `<div class="pr-free">${free ? `<span class="pr-pill pr-free-now">${free} free now</span>` : ""}${soon ? `<span class="pr-pill pr-soon">${soon} free ≤30 d</span>` : ""}</div>`);
    });
  }

  // ── All rooms ──
  const RF = [["all", "All"], ["free", "Free now"], ["soon", "Free in 30 days"], ["occupied", "Rented"], ["nomatch", "Tenant not linked"], ["noprop", "Not linked to a property"]];
  function roomRows() {
    const m = getModel();
    const rows = [];
    for (const [name, e] of m.props) {
      const p = properties.find((x) => x.name === name) || {};
      if (PP_UI.city && p.city !== PP_UI.city) continue;
      e.rooms.forEach((r) => rows.push({ r, prop: name, city: p.city || r.city }));
    }
    m.unmatched.forEach((r) => { if (!PP_UI.city || r.city === PP_UI.city) rows.push({ r, prop: "", city: r.city }); });
    return rows;
  }
  function inRf(x, f) {
    if (f === "free") return x.r.state && x.r.state.key === "free";
    if (f === "soon") return x.r.state && x.r.state.key === "soon";
    if (f === "occupied") return x.r.state && (x.r.state.key === "occupied" || x.r.state.key === "later");
    if (f === "nomatch") return x.prop && x.r.state && x.r.state.key === "occupied" && !x.r.tenant;
    if (f === "noprop") return !x.prop;
    return true;
  }
  function pill(s) { return `<span class="pr-pill pr-${esc(s.key)}">${esc(s.key === "soon" || s.key === "later" ? "Free " + dt(s.from) : s.label)}</span>`; }
  function renderRooms() {
    const box = $("pr-rooms");
    if (!box || box.hidden) return;
    if (!PR.inv) { box.innerHTML = `<div class="tn-empty">Loading the room inventory…</div>`; load().then(renderRooms); return; }
    if (!isCA()) { box.innerHTML = `<div class="tn-empty">Mexico has no Asana room inventory: open a property to see its rooms from the leases.</div>`; return; }
    const all = roomRows().map((x) => (x.r.state ? x : Object.assign(x, { r: Object.assign(x.r, { state: PR_CORE.roomState(x.r, null, null) }) })));
    const q = norm(PR.rq).trim();
    const list = all.filter((x) => inRf(x, PR.rf) && (!q || norm([x.r.task, x.prop, x.r.addr, x.r.tenant && x.r.tenant.name, x.r.typeLabel].join(" ")).includes(q)));
    const order = { free: 0, soon: 1, later: 2, occupied: 3, hold: 4 };
    list.sort((a, b) => (order[a.r.state.key] - order[b.r.state.key]) || String(a.r.state.from || "").localeCompare(String(b.r.state.from || "")) || (a.prop || "~").localeCompare(b.prop || "~", undefined, { numeric: true }) || a.r.label.localeCompare(b.r.label));
    const shown = list.slice(0, 400);
    box.innerHTML = `
      <div class="pr-rtools">
        <input class="form-input tn-search" id="pr-rq" type="search" placeholder="Search room, property, street or tenant" value="${esc(PR.rq)}" autocomplete="off" spellcheck="false">
        <div class="tn-pills">${RF.map(([k, l]) => `<button type="button" class="tn-pill${PR.rf === k ? " on" : ""}" data-pr-rf="${k}">${esc(l)}<span class="hb-n">${all.filter((x) => inRf(x, k)).length}</span></button>`).join("")}</div>
      </div>
      ${PR.err ? `<div class="card-sub hb-note tn-banner">${esc(PR.err)}</div>` : ""}
      ${PR.rf === "noprop" ? `<div class="card-sub hb-note tn-banner">These Asana inventory rooms don't match any property in the portal (a building the portal doesn't list yet, a pre-booking task, or a name too different to match). They still show on Vacancies.</div>` : ""}
      ${PR.rf === "nomatch" ? `<div class="card-sub hb-note tn-banner">Asana says these rooms are rented, but no tenant in the portal has a room name that matches. Usually the tenant's room says "Master" or "Flex" instead of the room's name. Open the tenant and set the room to the name shown here.</div>` : ""}
      <div class="tn-table-wrap"><table class="hb-table tn-table pr-rtable">
        <thead><tr><th>Room</th><th>Property</th><th>Status</th><th>Tenant</th><th class="pp-num">Price</th></tr></thead>
        <tbody>${shown.map((x) => `<tr class="hb-row" tabindex="0" ${x.prop ? `data-pr-open="${esc(x.prop)}" data-pr-focus="${esc(x.r.gid)}"` : `data-pr-asana="${esc(vacAsanaUrl(x.r))}"`}>
          <td><div class="tn-name">${esc(x.r.label)}${x.r.unit ? ` <span class="hb-sub">· Unit ${esc(x.r.unit)}</span>` : ""}</div><div class="hb-sub">${esc(x.r.typeLabel)}${x.r.lease ? " · " + esc(leaseLabel(x.r.lease)) : ""}</div></td>
          <td><div>${x.prop ? esc(x.prop) : `<span class="hb-need">not linked</span>`}</div><div class="hb-sub">${esc(x.prop ? x.city || "" : x.r.prop || x.r.task)}</div></td>
          <td>${pill(x.r.state)}</td>
          <td>${x.r.tenant ? `<div>${esc(x.r.tenant.name)}${x.r.also && x.r.also.length ? ` <span class="hb-sub">+${x.r.also.length}</span>` : ""}</div><div class="hb-sub">${x.r.tenant.leaseEnd ? "until " + esc(dt(x.r.tenant.leaseEnd)) : "no end date"}</div>` : x.r.state.key === "occupied" ? `<span class="hb-sub">not linked</span>` : `<span class="hb-sub">—</span>`}${x.r.mover ? `<div class="hb-sub">next: ${esc(x.r.mover.name)} · ${esc(dt(x.r.mover.moveIn))}</div>` : ""}</td>
          <td class="pp-num">${x.r.rent != null ? `<span class="num">${esc(ppMoney(x.r.rent, cur(x.city)))}</span>` : `<span class="hb-sub">—</span>`}</td>
        </tr>`).join("")}</tbody>
      </table></div>
      ${!list.length ? `<div class="tn-empty">No rooms match.</div>` : ""}
      <div class="tn-foot"><span class="card-sub">${list.length} room${list.length === 1 ? "" : "s"}${list.length > shown.length ? ` · showing the first ${shown.length}, search to narrow` : ""} · live from Asana</span><span class="tn-head-actions"><button type="button" class="btn btn-ghost tn-mini" data-pr-goto="vacancies">Vacancies</button></span></div>`;
    const inp = $("pr-rq"); if (inp && PR.focusSearch) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    PR.focusSearch = false;
  }
  function leaseLabel(l) { return { flex_lease: "Flex", fixed_lease: "Fixed", month_to_month: "Month to month", fixed: "Fixed" }[l] || l.replace(/_/g, " "); }

  // ── property page ──
  function open(name, focus) {
    ensureShell();
    if (typeof closeProperty === "function") { try { closeProperty(); } catch (e) {} }
    const isRow = properties.some((p) => p.name === name);
    if (!isRow && !properties.some((p) => llBuilding(p.name) === name)) return;
    PR.open = name; PR.focus = focus || "";
    if (!document.querySelector('.view[data-view="properties"].active')) goToView("properties");
    setListVisible(false);
    renderDetail();
    window.scrollTo({ top: 0 });
    if (!PR.inv) load().then(() => { if (PR.open === name) renderDetail(); });
  }
  function close() { PR.open = null; setListVisible(true); if (typeof renderPropertiesGrid === "function") renderPropertiesGrid(); renderRooms(); }

  function renderDetail() {
    const box = $("pr-detail");
    if (!box || !PR.open) return;
    const name = PR.open;
    const names = unitsOf(name);
    const isBuilding = names.length > 1 || !properties.some((p) => p.name === name);
    const p0 = properties.find((p) => p.name === names[0]) || {};
    const m = getModel();
    const entries = names.map((n) => m.props.get(n)).filter(Boolean);
    const rooms = entries.flatMap((e) => e.rooms.map((r) => Object.assign(r, { _prop: e.name })));
    const loose = entries.flatMap((e) => e.loose.map((t) => Object.assign({}, t, { _prop: e.name })));
    const tns = entries.flatMap((e) => e.tenants);
    const T = today();
    const live = tns.filter((t) => ["living", "ended"].includes(stage(t)));
    const moving = tns.filter((t) => stage(t) === "moving");
    const pps = names.map(ppRowOf).filter(Boolean);
    const configured = pps.reduce((s, r) => s + r.rooms, 0) || names.reduce((s, n) => s + (Number((properties.find((p) => p.name === n) || {}).rooms) || 0), 0);
    const nRooms = Math.max(configured, rooms.length, live.length);
    const free = rooms.filter((r) => r.state.key === "free"), soon = rooms.filter((r) => r.state.key === "soon");
    const showMoney = money();
    const c = cur(p0.city);
    const rev = pps.reduce((s, r) => s + r.revenue, 0), costed = pps.filter((r) => r.cost != null);
    const cost = costed.reduce((s, r) => s + r.cost, 0), profit = costed.reduce((s, r) => s + r.profit, 0);
    const ll = landlordOf(names);
    const building = llBuilding(names[0]);
    const addr = p0.addr || (rooms[0] && rooms[0].addr) || "";
    const crumbs = [`<a href="#" data-pr-back>Properties</a>`, p0.city ? `<span>${esc(p0.city)}</span>` : "",
      !isBuilding && building !== name ? `<a href="#" data-pr-open="${esc(building)}">${esc(building)}</a>` : ""].filter(Boolean).join(`<span class="pr-sep">›</span>`);
    const kpi = (l, v, s, cls) => `<div class="kpi${cls ? " " + cls : ""}"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div>${s ? `<div class="kpi-trend">${s}</div>` : ""}</div>`;
    const tabs = [["rooms", "Rooms", rooms.length || nRooms], ["tenants", "Tenants", live.length + moving.length], ["info", "House info", ""]].concat(showMoney ? [["money", "Money", ""]] : []);
    if (!tabs.some(([k]) => k === PR.tab)) PR.tab = "rooms";
    const prof = profileOf(names);
    box.innerHTML = `
      <div class="pr-crumbs">${crumbs}</div>
      <div class="pr-head">
        <div class="pr-hero" style="background:linear-gradient(135deg, ${esc(p0.color || "#B94A3F")}, ${esc(typeof shade === "function" ? shade(p0.color || "#B94A3F", -25) : "#8a3a30")})">${esc((name[0] || "?").toUpperCase())}</div>
        <div class="pr-title">
          <h2>${esc(name)}</h2>
          <div class="hb-sub">${[addr ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}" target="_blank" rel="noopener">${esc(addr)}</a>` : "", esc(p0.city || ""), isBuilding ? `${names.length} units` : esc(p0.type || ""), ll ? `Landlord: <a href="#" data-pr-ll="${esc(ll.id)}">${esc(ll.name)}</a>` : ""].filter(Boolean).join(" · ")}</div>
        </div>
        <div class="pr-actions">
          ${prof && prof.url ? `<a class="btn btn-ghost tn-mini" href="${esc(prof.url)}" target="_blank" rel="noopener">House profile ↗</a>` : ""}
          <button type="button" class="btn btn-ghost tn-mini" data-pr-tenants="${esc(isBuilding ? "" : name)}" data-pr-tbld="${esc(isBuilding ? name : "")}">In Tenants</button>
          ${!isBuilding ? `<button type="button" class="btn btn-primary tn-mini" data-pr-add="${esc(name)}">+ Add tenant</button>` : ""}
        </div>
      </div>
      <div class="kpi-grid pp-kpis">
        ${kpi("Rooms occupied", `${live.length}<span class="pp-of">/${nRooms}</span>`, `${nRooms ? Math.round(live.length / nRooms * 100) : 0}% · ${moving.length} moving in`)}
        ${kpi("Free now", free.length, free.length ? esc(free.slice(0, 3).map((r) => r.label).join(", ")) + (free.length > 3 ? "…" : "") : rooms.length ? "every listed room is taken" : "no Asana rooms linked", free.length ? "pr-kfree" : "")}
        ${kpi("Free in 30 days", soon.length, soon.length ? "first on " + esc(dt(soon.map((r) => r.state.from).sort()[0])) : "")}
        ${showMoney ? kpi("Monthly profit", ppMoney(costed.length ? profit : null, c), `${ppMoney(rev, c)} rent · ${costed.length ? ppMoney(cost, c) + " landlord" : "no landlord rent on file"}`, costed.length && profit < 0 ? "pp-neg" : "") : ""}
      </div>
      ${isBuilding ? `<div class="pr-units">${names.map((n) => { const e = m.props.get(n) || { rooms: [], tenants: [] }; const r = ppRowOf(n); const f = e.rooms.filter((x) => x.state.key === "free").length; return `<button type="button" class="pr-unit" data-pr-open="${esc(n)}"><b>${esc(typeof ppUnitLabel === "function" && r ? ppUnitLabel(r) : n)}</b><span class="hb-sub">${r ? r.occupied + "/" + r.rooms + " occupied" : ""}${f ? ` · <span class="pr-free-txt">${f} free</span>` : ""}</span></button>`; }).join("")}</div>` : ""}
      <div class="hb-tabbar" role="tablist">${tabs.map(([k, l, n]) => `<button type="button" class="hb-tab${PR.tab === k ? " on" : ""}" role="tab" data-pr-tab="${k}">${l}${n !== "" ? `<span class="hb-n">${n}</span>` : ""}</button>`).join("")}</div>
      <div class="pr-body">${PR.tab === "tenants" ? tenantsTab(tns, T) : PR.tab === "info" ? infoTab(names, rooms, prof, ll) : PR.tab === "money" ? moneyTab(pps, c) : roomsTab(rooms, loose, live, names, isBuilding)}</div>`;
    if (PR.focus) { const el = box.querySelector(`[data-pr-room="${CSS.escape(PR.focus)}"]`); if (el) { el.classList.add("pr-hl"); el.scrollIntoView({ block: "center" }); } PR.focus = ""; }
    const sub = $("page-sub"); if (sub) sub.textContent = `${name} · ${live.length}/${nRooms} occupied`;
  }
  function roomsTab(rooms, loose, live, names, isBuilding) {
    const pr = profilesOf(names).flatMap((p) => p.rooms || []);
    const key = (x) => norm(x).replace(/\(.*?\)/g, "").replace(/[^a-z0-9]/g, "");
    const notes = PR_CORE.roomNotes(properties);
    const url = (u) => /^https?:\/\//.test(u || "") ? u : "";
    const bedOf = (r) => { const k = key(r.label); const m = k && pr.filter((x) => key(x.label) === k); return m && m.length === 1 ? m[0] : null; };
    const card = (r) => {
      const t = r.tenant, s = r.state;
      return `<div class="pr-room pr-r-${esc(s.key)}" data-pr-room="${esc(r.gid)}">
        ${r.cover ? `<img class="pr-ph" src="${esc(r.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<div class="pr-ph pr-ph0">${esc((r.label[0] || "?").toUpperCase())}</div>`}
        <div class="pr-rm">
          <div class="pr-rt"><b>${esc(r.label)}</b>${pill(s)}</div>
          <div class="hb-sub">${[isBuilding && r.unit ? "Unit " + esc(r.unit) : "", esc(r.typeLabel), (bedOf(r) || {}).bed ? esc(bedOf(r).bed) + " bed" : "", (bedOf(r) || {}).bath ? esc(bedOf(r).bath) + " bath" : "", r.lease ? esc(leaseLabel(r.lease)) : "", r.rent != null ? `<span class="num">${esc(ppMoney(r.rent, cur(r.city)))}</span>/mo` : ""].filter(Boolean).join(" · ")}</div>
          ${(bedOf(r) || {}).note ? `<div class="hb-sub pr-note">${esc(bedOf(r).note)}</div>` : ""}
          ${(notes.get(r.gid) || {}).note ? `<div class="hb-sub pr-anote" title="From the room's Asana task">${esc(notes.get(r.gid).note)}</div>` : ""}
          ${(notes.get(r.gid) || {}).leaseStart ? `<div class="hb-sub">Lease start in Asana: ${esc(dt(notes.get(r.gid).leaseStart))}</div>` : ""}
          <div class="pr-who">${t ? `<a href="#" data-pr-tenant="${esc(tnKey(t))}">${esc(t.name)}</a> <span class="hb-sub">${t.leaseEnd ? "until " + esc(dt(t.leaseEnd)) : "no end date"}${stage(t) === "ended" ? " · lease date passed" : ""}</span>`
            + (r.also || []).map((o) => `<div><a href="#" data-pr-tenant="${esc(tnKey(o))}">${esc(o.name)}</a> <span class="hb-sub">${norm(o.name).trim() === norm(t.name).trim() ? "second record for the same person" : "shares this room"}</span></div>`).join("")
            : s.key === "occupied" || s.key === "soon" || s.key === "later" ? `<span class="hb-sub">Rented in Asana · no tenant linked</span>` : s.key === "free" ? `<span class="pr-free-txt">Empty${r.daysEmpty ? " for " + r.daysEmpty + " days" : ""}</span>` : ""}
            ${r.mover ? `<div class="hb-sub">Next: <a href="#" data-pr-tenant="${esc(tnKey(r.mover))}">${esc(r.mover.name)}</a> moves in ${esc(dt(r.mover.moveIn))}</div>` : ""}</div>
          <div class="pr-links">
            <a href="${esc(vacRoomUrl(r))}" target="_blank" rel="noopener">Listing</a>
            ${r.pictures ? `<a href="${esc(r.pictures)}" target="_blank" rel="noopener">Photos</a>` : ""}
            ${r.layout ? `<a href="${esc(r.layout)}" target="_blank" rel="noopener">Layout</a>` : ""}
            ${url((notes.get(r.gid) || {}).tour) ? `<a href="${esc(notes.get(r.gid).tour)}" target="_blank" rel="noopener">360° tour</a>` : ""}
            ${url((notes.get(r.gid) || {}).website) ? `<a href="${esc(notes.get(r.gid).website)}" target="_blank" rel="noopener">Website</a>` : ""}
            ${((notes.get(r.gid) || {}).links || []).filter(url).map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">More${i ? " " + (i + 1) : ""}</a>`).join("")}
            <a href="${esc(vacAsanaUrl(r))}" target="_blank" rel="noopener">Asana</a>
            ${s.key !== "occupied" ? `<a href="#" data-pr-copy="${esc(r.gid)}">Copy offer</a>` : ""}
            ${s.key !== "occupied" && !t ? `<a href="#" data-pr-addroom="${esc(r._prop)}|${esc(r.label)}">+ Tenant</a>` : ""}
          </div>
        </div>
      </div>`;
    };
    if (!PR.inv) return `<div class="tn-empty">Loading rooms from the Asana inventory…</div>`;
    let html = "";
    if (rooms.length) {
      const byUnit = isBuilding ? names.map((n) => [n, rooms.filter((r) => r._prop === n)]).filter(([, rs]) => rs.length) : [["", rooms]];
      html += byUnit.map(([n, rs]) => `${n ? `<h4 class="pr-uh"><a href="#" data-pr-open="${esc(n)}">${esc(n)}</a></h4>` : ""}<div class="pr-grid">${rs.map(card).join("")}</div>`).join("");
    } else {
      // No inventory linked (Mexico, or a property Asana doesn't list): rooms from the leases, like before.
      html += `<div class="card-sub hb-note tn-banner">${isCA() ? "No Asana inventory rooms are linked to this property, so rooms are shown from the tenants' leases." : "Rooms from the tenants' leases (Mexico has no Asana inventory)."}</div>`;
      html += `<div class="pr-grid">${live.map((t) => `<div class="pr-room pr-r-occupied"><div class="pr-ph pr-ph0">${esc(String(t.room || "?")[0])}</div><div class="pr-rm"><div class="pr-rt"><b>${esc(t.room && t.room !== "—" ? t.room : "Room not set")}</b><span class="pr-pill pr-occupied">Occupied</span></div><div class="pr-who"><a href="#" data-pr-tenant="${esc(tnKey(t))}">${esc(t.name)}</a> <span class="hb-sub">${t.leaseEnd ? "until " + esc(dt(t.leaseEnd)) : ""}</span></div></div></div>`).join("")}</div>`;
    }
    if (rooms.length && loose.length) {
      html += `<div class="pr-loose"><h4>Tenants not matched to a room <span class="hb-n">${loose.length}</span></h4><p class="hb-sub">Their room in the portal ("${esc(loose.slice(0, 2).map((t) => t.room || "—").join('", "'))}"…) doesn't name one of the rooms above. Setting the tenant's room to the Asana room name links them.</p>
        ${loose.map((t) => `<div class="pr-lrow" data-pr-tenant="${esc(tnKey(t))}" tabindex="0"><b>${esc(t.name)}</b><span class="hb-sub">${esc(t.room || "—")}${isBuilding ? " · " + esc(t._prop) : ""}</span><span class="hb-sub">${stage(t) === "moving" ? "moves in " + esc(dt(t.moveIn)) : t.leaseEnd ? "until " + esc(dt(t.leaseEnd)) : ""}</span></div>`).join("")}</div>`;
    }
    return html;
  }
  function tenantsTab(tns, T) {
    const groups = [["moving", "Moving in"], ["living", "Living here"], ["ended", "Lease date passed (still active)"], ["past", "Moved out"]];
    const row = (t) => `<tr class="hb-row" data-pr-tenant="${esc(tnKey(t))}" tabindex="0">
      <td><div class="tn-name">${esc(t.name || "Unnamed")}</div><div class="hb-sub">${esc(t.email || "")}</div></td>
      <td>${esc(t.room && t.room !== "—" ? t.room : "—")}${t.property !== PR.open ? `<div class="hb-sub">${esc(t.property)}</div>` : ""}</td>
      <td>${stage(t) === "moving" ? "Moves in " + esc(dt(t.moveIn)) : t.leaseEnd ? (stage(t) === "past" ? "Left " : "Until ") + esc(dt(t.leaseEnd)) : `<span class="hb-sub">No end date</span>`}</td>
      <td class="pp-num">${Number(t.rent) ? `<span class="num">${esc(ppMoney(Number(t.rent), cur(t.city)))}</span>` : `<span class="hb-sub">—</span>`}</td>
      <td><span class="hb-sub">${esc((typeof TN_TYPE_LABEL !== "undefined" && TN_TYPE_LABEL[tnLeaseType(t)]) || "Type not set")}</span></td></tr>`;
    const out = groups.map(([k, l]) => {
      const rs = tns.filter((t) => stage(t) === k).sort((a, b) => String(k === "moving" ? a.moveIn : a.leaseEnd || "9").localeCompare(String(k === "moving" ? b.moveIn : b.leaseEnd || "9")));
      if (!rs.length) return "";
      const body = `<div class="tn-table-wrap"><table class="hb-table tn-table"><thead><tr><th>Tenant</th><th>Room</th><th>Dates</th><th class="pp-num">Rent</th><th>Lease</th></tr></thead><tbody>${rs.map(row).join("")}</tbody></table></div>`;
      return k === "past" ? `<details class="card tn-card pr-tg"><summary><b>${l}</b> <span class="hb-n">${rs.length}</span></summary>${body}</details>` : `<div class="card tn-card pr-tg"><div class="pr-tgh"><b>${l}</b> <span class="hb-n">${rs.length}</span></div>${body}</div>`;
    }).join("");
    return out || `<div class="tn-empty">No tenants on file for this property.</div>`;
  }
  function infoTab(names, rooms, prof, ll) {
    const m = getModel();
    const acc = names.map((n) => m.access.get(n)).filter(Boolean);
    const b = acc.map((a) => a.building).find(Boolean);
    const units = acc.flatMap((a) => a.units);
    const p0 = properties.find((p) => p.name === names[0]) || {};
    const bedrooms = rooms.map((r) => r.bedrooms).find((x) => x != null), baths = rooms.map((r) => r.bathrooms).find((x) => x != null);
    const unitNums = new Set(names.flatMap((n) => [...PR_CORE.nums(n)]));
    const accRooms = ((PR.access || {}).rooms || []).filter((r) => b && r.building === b.building && (!unitNums.size || !r.unit || unitNums.has(String(Number(r.unit)))));
    const item = (l, v) => (v ? `<div class="pr-kv"><span>${l}</span><div>${v}</div></div>` : "");
    const link = (u, l) => (u && /^https?:\/\//.test(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(l)} ↗</a>` : "");
    const lease = ll && ll.contract;
    const showMoney = money();
    const sec = (title, body, sub, wide) => (body.trim() ? `<div class="card card-pad pr-sec${wide ? " pr-wide" : ""}"><div class="pr-sech"><b>${title}</b>${sub ? `<span class="hb-sub">${sub}</span>` : ""}</div>${body}</div>` : "");
    return `<div class="pr-info">
      ${sec("The house", [
        item("Address", esc(p0.addr || (b && b.address) || (rooms[0] && rooms[0].addr) || (prof && prof.address) || "")),
        item("City", esc(p0.city || "")),
        item("Type", esc([p0.type, b && b.building_type].filter(Boolean).join(" · "))),
        item("Rooms", esc(String(p0.rooms || "")) + (prof && prof.roomsFromTitle && prof.roomsFromTitle !== p0.rooms ? ` <span class="hb-sub">(Asana house profile says ${esc(prof.roomsFromTitle)})</span>` : "")),
        item("Bedrooms / baths", bedrooms != null ? esc(bedrooms + " bedrooms" + (baths != null ? " · " + baths + " bathrooms" : "")) : ""),
        item("Rent range", esc(p0.rent || "")),
        item("House manager", esc((prof && prof.houseManager) || "")),
      ].join(""))}
      ${sec("Arrivals & access", [
        item("Check-in video", link((b && b.checkin_video_url) || (prof && prof.links && prof.links.checkinVideo), "Watch")),
        item("Contact link", link(b && b.contact_url, "Open")),
        item("WhatsApp group", link((units.find((u) => u.whatsapp_url) || {}).whatsapp_url || (prof && prof.links && prof.links.whatsappGroup), "Open")),
        item("Units on file", units.length ? esc(units.map((u) => [u.unit ? "Unit " + u.unit : "Main", u.floor ? "floor " + u.floor : "", u.whole_unit ? "whole unit" : ""].filter(Boolean).join(" ")).join(" · ")) : ""),
        item("Rooms on file", accRooms.length ? esc(accRooms.length + " rooms") + (accRooms.some((r) => r.bed_type) ? ` <span class="hb-sub">· beds: ${esc([...new Set(accRooms.map((r) => r.bed_type).filter(Boolean))].slice(0, 4).join(", "))}</span>` : "") : ""),
      ].join(""), b ? `Arrivals building “${esc(b.building)}” · door codes and Wi-Fi stay in <a href="arrivals.html">Arrivals</a>` : "")}
      ${sec("Landlord & lease", ll ? [
        item("Landlord", `<a href="#" data-pr-ll="${esc(ll.id)}">${esc(ll.name)}</a>${ll.company ? ` <span class="hb-sub">${esc(ll.company)}</span>` : ""}`),
        item("Lease", lease ? esc([lease.start ? "from " + dt(lease.start) : "", lease.end ? "to " + dt(lease.end) : lease.monthToMonth ? "month to month" : ""].filter(Boolean).join(" ")) : `<span class="hb-need">no lease on file</span>`),
        showMoney && lease && lease.rent ? item("Landlord rent", esc(ppMoney(Number(lease.rent), lease.currency || cur(p0.city))) + "/month") : "",
        item("Status", esc(ll.statusLabel || "")),
      ].join("") : item("Landlord", `<span class="hb-need">none linked</span> · link one under <a href="#" data-pr-goto="landlords">Landlords</a>`))}
      ${profilesOf(names).slice(0, names.length > 1 ? 30 : 4).map((prof) => sec(esc(prof.house || "Asana house profile"), [
        item("Links", [link(prof.links && prof.links.photos, "Photos"), link(prof.links && prof.links.layout, "Layout"), link(prof.links && prof.links.tour, "3D tour")].filter(Boolean).join(" · ")),
        (prof.rooms || []).length ? item("Rooms", `<div class="pr-prooms">` + prof.rooms.map((r) => `<div>${esc(r.label)}${r.bed ? ` <span class="hb-sub">· ${esc(r.bed)}</span>` : ""}${r.bath ? ` <span class="hb-sub">· ${esc(r.bath)} bath</span>` : ""}${r.note ? ` <span class="hb-sub">· ${esc(r.note)}</span>` : ""}</div>`).join("") + `</div>`) : "",
        (prof.facts || []).length ? item("Notes", `<ul class="pr-facts">${prof.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`) : "",
      ].join("") || item("Profile", `<span class="hb-sub">Empty template in Asana</span>`), `${link(prof.url, "Open in Asana")}${prof.modified ? " · updated " + esc(dt(prof.modified)) : ""}`, true)).join("")}
    </div>`;
  }
  function moneyTab(pps, c) {
    if (!pps.length) return `<div class="tn-empty">No figures for this property.</div>`;
    return `<div class="card tn-card"><div class="tn-table-wrap"><table class="hb-table tn-table pp-table"><thead><tr><th>Unit</th><th>Rooms</th><th class="pp-num">Revenue</th><th class="pp-num">Landlord rent</th><th class="pp-num">Profit</th><th class="pp-num">Margin</th></tr></thead><tbody>
      ${pps.map((r) => `<tr class="hb-row" data-pr-open="${esc(r.name)}" tabindex="0"><td><div class="tn-name">${esc(r.name)}</div><div class="hb-sub">${esc(r.landlord || "")}</div></td><td>${r.occupied}/${r.rooms}</td><td class="pp-num">${ppMoney(r.revenue, r.cur)}${r.noRent ? `<div class="hb-sub">${r.noRent} without rent</div>` : ""}</td><td class="pp-num">${r.cost == null ? `<span class="hb-need">not on file</span>` : ppMoney(r.cost, r.cur)}</td><td class="pp-num${r.profit < 0 ? " pp-loss" : ""}">${ppMoney(r.profit, r.cur)}</td><td class="pp-num">${r.profit == null || !r.revenue ? "—" : ppPct(r.profit / r.revenue)}</td></tr>`).join("")}
    </tbody></table></div><div class="tn-foot"><span class="card-sub">Revenue = rent of current tenants; landlord rent from the lease under Landlords.</span></div></div>`;
  }
  function landlordOf(names) {
    try {
      const L = llModel(landlords, properties, llYmd(new Date()));
      const r = L.props.find((x) => names.includes(x.name) && x.landlord);
      if (!r) return null;
      return { id: r.landlord.id, name: r.landlord.name, company: r.landlord.company || "", contract: r.contract || null, statusLabel: (typeof LL_STATUS !== "undefined" && LL_STATUS[r.status] && LL_STATUS[r.status].label) || "" };
    } catch (e) { return null; }
  }
  // Asana "House Profile" tasks copied onto the property (data.asanaProfiles, no codes): one per profile task, so a
  // house with a separate basement profile carries two. A building page shows its units' profiles together.
  function profilesOf(names) {
    const out = [];
    for (const n of names) { const p = properties.find((x) => x.name === n); if (p && Array.isArray(p.asanaProfiles)) out.push(...p.asanaProfiles.filter((x) => x && typeof x === "object")); }
    return out;
  }
  function profileOf(names) { return profilesOf(names)[0] || null; }

  // ── events ──
  function onClick(e) {
    const an = e.target.closest(".pr-anote");
    if (an) { an.classList.toggle("pr-open"); return; }
    const a = e.target.closest("[data-pr-mode],[data-pr-rf],[data-pr-back],[data-pr-open],[data-pr-tab],[data-pr-tenant],[data-pr-add],[data-pr-addroom],[data-pr-copy],[data-pr-ll],[data-pr-goto],[data-pr-tenants],[data-pr-asana]");
    if (!a) return;
    const d = a.dataset;
    if (d.prMode) { PR.mode = d.prMode; save(); syncMode(); return; }
    if (d.prRf) { PR.rf = d.prRf; renderRooms(); return; }
    if (a.hasAttribute("data-pr-back")) { e.preventDefault(); close(); return; }
    if (d.prTab) { PR.tab = d.prTab; save(); renderDetail(); return; }
    if (d.prTenant) { e.preventDefault(); if (typeof openTenant === "function") openTenant(d.prTenant); return; }
    if (d.prAdd) { if (typeof openAddTenantModal === "function") openAddTenantModal(d.prAdd); return; }
    if (d.prAddroom) { e.preventDefault(); const [p, r] = d.prAddroom.split("|"); if (typeof openAddTenantModal === "function") openAddTenantModal(p, r); return; }
    if (d.prCopy) {
      e.preventDefault();
      const v = (PR.inv || []).find((x) => x.gid === d.prCopy);
      if (v && navigator.clipboard) navigator.clipboard.writeText(vacShareText(v)).then(() => showToast("Offer text copied"), () => showToast("Couldn't copy"));
      return;
    }
    if (d.prLl) { e.preventDefault(); if (typeof openLandlord === "function") openLandlord(d.prLl); else goToView("landlords"); return; }
    if (d.prGoto) { e.preventDefault(); goToView(d.prGoto); return; }
    if (d.prAsana) { window.open(d.prAsana, "_blank", "noopener"); return; }
    if (a.hasAttribute("data-pr-tenants")) {
      TN.house = d.prTenants || ""; TN.q = d.prTbld || ""; TN.city = ""; TN.page = 1;
      const s = $("ft-search"); if (s) s.value = TN.q;
      goToView("tenants"); if (typeof renderTenants === "function") renderTenants();
      return;
    }
    if (d.prOpen) { e.preventDefault(); open(d.prOpen, d.prFocus); return; }
  }
  function syncMode() {
    document.querySelectorAll("[data-pr-mode]").forEach((b) => b.classList.toggle("on", b.dataset.prMode === PR.mode));
    if (PR.open) return;
    setListVisible(true);
    if (PR.mode === "rooms") renderRooms();
  }

  // Tenants page and anywhere else: data-pr-open links (stopPropagation so the tenant row doesn't open too).
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-pr-open]");
    if (!a || a.closest('.view[data-view="properties"]')) return;
    e.preventDefault(); e.stopPropagation();
    if (typeof closePanelIfOpen === "function") closePanelIfOpen();
    const ov = document.querySelector(".panel.open, .detail-panel.open"); if (ov && typeof closeProperty === "function") { try { closeProperty(); } catch (x) {} }
    open(a.dataset.prOpen);
  }, true);

  // Every caller of openProperty (Landlords, Portfolio, map, global search) now lands on the page.
  window.openProperty = openProperty = function (name) { open(name); };

  // Hook the list render: hide the list while a property is open, add free-room counts.
  const _render = window.renderPropertiesGrid || renderPropertiesGrid;
  window.renderPropertiesGrid = renderPropertiesGrid = function () {
    ensureShell();
    _render.apply(this, arguments);
    document.querySelectorAll("[data-pr-mode]").forEach((b) => b.classList.toggle("on", b.dataset.prMode === PR.mode));
    if (PR.open) { setListVisible(false); renderDetail(); return; }
    setListVisible(true);
    if (PR.mode === "rooms") renderRooms();
    if (!PR.inv) { load().then(() => { decorateList(); if (PR.mode === "rooms") renderRooms(); }); } else decorateList();
  };
  // Leaving and coming back to Properties via the sidebar shows the list again.
  document.addEventListener("click", (e) => {
    const n = e.target.closest('.nav-item[data-view="properties"]');
    if (n && PR.open) { PR.open = null; }
  }, true);
  window.PR_PAGE = { open, close, load, model: getModel, state: PR };
})();
