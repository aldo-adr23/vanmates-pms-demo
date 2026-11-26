/* Tenant database (portal): who lives where on any date, and the review of what changed.
   Spec: docs/superpowers/specs/2026-11-22-tenant-database-design.md · SQL: tenant-db-2026-11-22.sql.
   Loaded by index.html after properties.js (uses esc, showToast, goToView, properties, tenants, tnKey,
   tnFind, tnToday, tnIso, tnFmt, tnDate, tnSave, openTenant, renderTenants, TN, activeRole,
   invSelectAll, vacFromInventory, PR_CORE and window.vmDb).

   Three parts:
   1. TDB_CORE (window.TDB_CORE, pure, tested in test/tenant-db.test.js): a tenant's stay, whether it
      covers a date, which inventory room a tenant is in, and the occupancy of every property on a
      date (rooms with their occupant, arrivals and departures in a window, vacant rooms, conflicts).
   2. Tenants › Occupancy: a date picker over that model, by property, address and room.
   3. Tenant review (its own page): automated changes waiting for a reviewer, the reconciliation's
      data checks, failed writes; plus a History section on every tenant profile.

   Occupancy is read-time: nothing here writes a tenant except a reviewer's explicit "Apply fix",
   which saves through tnSave like any staff edit (and is logged as theirs). */
(function () {
  // ── 1. TDB-CORE ──────────────────────────────────────────────────────────────
  const FAR = "9999-12-31";
  const iso = (v) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v == null ? "" : v)); return m ? m[1] : null; };
  const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const isPast = (t) => /^(past|moved_out)$/i.test(String((t && t.status) || ""));

  // A tenant's stay. end is the last night (the portal's convention: the room is free the day after,
  // and the next tenant may arrive on the end day itself — a handover). A moved-out tenant's end is
  // the confirmed move-out (movedOutAt), else the lease end. `unconfirmed`: still marked living
  // although the lease end has passed (a renewal nobody typed, or a move-out nobody marked).
  function stay(t, today) {
    const start = iso(t && t.moveIn);
    const past = isPast(t);
    // A cancelled booking (cancelledAt, set from the profile's Edit stay) never occupied the room.
    let end = past ? (t.cancelledAt ? null : iso(t.movedOutAt) || iso(t.leaseEnd)) : iso(t && t.leaseEnd);
    const unconfirmed = !past && !!end && !!today && end < today;
    // No move-in and no lease end: an old row nobody dated. True today (it says active), unknown later.
    const undated = !past && !start && !end;
    return { start, end, past, unconfirmed, undated };
  }
  // Does the stay cover date d? An unconfirmed stay covers up to today only: the portal says they
  // live there now, but nothing says they will be there next month.
  function covers(t, d, today) {
    const s = stay(t, today);
    if (s.past && !s.end) return false;
    if (s.start && d < s.start) return false;
    const last = s.unconfirmed || s.undated ? today : s.end || FAR;
    return d <= last;
  }
  function flagsOn(t, d, today) {
    const s = stay(t, today), f = [];
    if (s.start === d) f.push("arrives");
    if (s.end === d && !s.unconfirmed) f.push("leaves");
    if (s.unconfirmed) f.push("unconfirmed");
    if (s.undated) f.push("undated"); else if (!s.start) f.push("no_move_in");
    return f;
  }
  // Two people sharing one room on purpose: one contract, a couple row, or the same person twice.
  function together(a, b) {
    if (a.contractId && a.contractId === b.contractId) return true;
    if (a.alsoOnContract || b.alsoOnContract) return true;
    const ea = String(a.email || "").toLowerCase(), eb = String(b.email || "").toLowerCase();
    return !!ea && ea === eb && !/ces-schools|englishcollege|uhomes|ilsc|ef\.com|kaplan|4stay|coliving|vanmates/.test(ea);
  }

  // Every inventory room on its portal property (the Properties page's matcher), hidden ones included:
  // a future tenant may be filed in a room Asana keeps hidden today.
  function buildRooms(props, inv) {
    const idx = PR_CORE.index(props);
    const out = new Map();
    (props || []).forEach((p) => { if (p && p.name) out.set(p.name, { name: p.name, city: p.city || "", addr: (p.guide && p.guide.address) || p.addr || "", rooms: [] }); });
    const byGid = new Map();
    for (const v of inv || []) {
      if (!v || !v.gid) continue;
      let r = PR_CORE.resolve(idx, { building: v.prop || v.room.split(/\s+[-\/]\s+/).pop(), room: v.room, city: v.city });
      if (!r.name && v.prop) { const r2 = PR_CORE.resolve(idx, { building: v.room, room: v.room, city: v.city }); if (r2.name) r = r2; }
      if (!r.name || !out.has(r.name)) continue;
      const lab = PR_CORE.roomLabel(v.room, v.prop || "");
      const room = { gid: v.gid, label: lab.label, unit: lab.unit, task: v.room, status: v.status, addr: v.addr || "", prop: r.name };
      out.get(r.name).rooms.push(room);
      byGid.set(v.gid, room);
      if (!out.get(r.name).addr && v.addr) out.get(r.name).addr = v.addr;
    }
    for (const e of out.values()) e.rooms.sort((a, b) => String(a.unit).localeCompare(String(b.unit), undefined, { numeric: true }) || a.label.localeCompare(b.label, undefined, { numeric: true }));
    return { props: out, byGid };
  }
  // Where each tenant is: the room stored on the row (inventoryRoomGid), else the room on their signed
  // contract, else the room name matched within their property. { key -> { prop, gid|null, how } }.
  function place(list, model, byEmail) {
    const out = new Map();
    for (const t of list || []) {
      const k = tnKeyOf(t);
      const g = /^\d+$/.test(String(t.inventoryRoomGid || "")) ? String(t.inventoryRoomGid) : "";
      if (g && model.byGid.has(g)) { const r = model.byGid.get(g); out.set(k, { prop: r.prop, gid: g, how: "linked" }); continue; }
      const e = model.props.get(t.property);
      const cg = byEmail && byEmail.get(String(t.email || "").trim().toLowerCase());
      if (e && cg && e.rooms.some((r) => r.gid === cg)) { out.set(k, { prop: t.property, gid: cg, how: "contract" }); continue; }
      if (e) {
        const i = PR_CORE.tenantRoom(t, e.rooms);
        out.set(k, { prop: t.property, gid: i >= 0 ? e.rooms[i].gid : null, how: i >= 0 ? "name" : "none" });
      } else out.set(k, { prop: t.property || "", gid: null, how: "none" });
    }
    return out;
  }
  function tnKeyOf(t) { return String((t && (t.id || t.email || t.name)) || ""); }

  // The occupancy of every property on date d. win = days after d for "arriving / leaving soon".
  // Returns [{ name, city, addr, rooms:[{ ...room, on:[{t,flags}], next, conflict }], unplaced:[{t,flags}],
  //            arrivals:[t], departures:[t], counts:{ rooms, occupied, vacant, conflicts, people } }].
  function occupancy(model, list, placement, d, today, win) {
    const end = addDays(d, Math.max(0, win || 0));
    const views = new Map();
    const view = (name) => {
      if (!views.has(name)) {
        const p = model.props.get(name) || { name: name || "Not on a property", city: "", addr: "", rooms: [] };
        views.set(name, { name: p.name, city: p.city, addr: p.addr, rooms: p.rooms.map((r) => ({ ...r, on: [], next: null, conflict: false, history: [] })), unplaced: [], arrivals: [], departures: [] });
      }
      return views.get(name);
    };
    for (const p of model.props.keys()) view(p);
    for (const t of list || []) {
      const pl = placement.get(tnKeyOf(t)) || { prop: t.property || "", gid: null };
      const v = view(pl.prop || "");
      const s = stay(t, today);
      const room = pl.gid ? v.rooms.find((r) => r.gid === pl.gid) : null;
      if (room) room.history.push(t);
      if (covers(t, d, today)) {
        const entry = { t, flags: flagsOn(t, d, today), firm: !!room && (pl.how === "linked" || pl.how === "contract") };
        if (room) room.on.push(entry); else v.unplaced.push(entry);
      // A past row that starts later is a cancelled booking (Edit stay) or a stale one: nobody is coming.
      } else if (room && !s.past && s.start && s.start > d && (!room.next || s.start < stay(room.next, today).start)) room.next = t;
      if (!s.past && s.start && s.start > d && s.start <= end) v.arrivals.push(t);
      if (!s.unconfirmed && s.end && s.end >= d && s.end <= end && (!s.start || s.start <= s.end)) v.departures.push(t);
    }
    const out = [];
    for (const v of views.values()) {
      // Rooms Asana keeps hidden (archived, on hold) only show while someone is or was in them.
      v.rooms = v.rooms.filter((r) => r.status !== "hidden" || r.on.length || r.next || r.history.length);
      for (const r of v.rooms) {
        r.history.sort((a, b) => String(stay(b, today).start || "").localeCompare(String(stay(a, today).start || "")));
        // A conflict: two people covering d who are not together and are not a handover (one leaves, one arrives).
        // Undated / unconfirmed rows are shown but never make a conflict: nothing says they are still there.
        const ppl = r.on.filter((x) => !x.flags.includes("undated") && !x.flags.includes("unconfirmed"));
        const clash = (a, b) => !together(a.t, b.t)
          && !(a.flags.includes("leaves") && b.flags.includes("arrives")) && !(b.flags.includes("leaves") && a.flags.includes("arrives"));
        const pairs = ppl.flatMap((a, i) => ppl.slice(i + 1).filter((b) => clash(a, b)).map((b) => [a, b]));
        // Firm: both people are filed in this room (room link or contract). Otherwise a room-name guess: "possible".
        r.conflict = pairs.some(([a, b]) => a.firm && b.firm);
        r.possible = !r.conflict && pairs.length > 0;
      }
      const occupied = v.rooms.filter((r) => r.on.some((x) => !x.flags.includes("leaves") || r.on.length > 1)).length;
      const people = v.rooms.reduce((n, r) => n + r.on.length, 0) + v.unplaced.length;
      if (!v.rooms.length && !people && !v.arrivals.length && !v.departures.length) continue;
      const byStart = (a, b) => String(stay(a, today).start).localeCompare(String(stay(b, today).start));
      v.arrivals.sort(byStart);
      v.departures.sort((a, b) => String(stay(a, today).end).localeCompare(String(stay(b, today).end)));
      v.counts = { rooms: v.rooms.length, occupied, vacant: v.rooms.filter((r) => !r.on.length && (r.status === "available" || r.status === "available_later")).length,
        conflicts: v.rooms.filter((r) => r.conflict).length, possible: v.rooms.filter((r) => r.possible).length,
        untracked: v.rooms.filter((r) => !r.on.length && r.status === "occupied").length, people };
      out.push(v);
    }
    // City first (properties with no city on file last), then name in natural order.
    return out.sort((a, b) => String(a.city || "~").localeCompare(String(b.city || "~")) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }
  // Filters: { city, prop, q (name/email/address/room), only: "conflicts"|"vacant"|"moves"|"" }.
  function filterViews(views, f) {
    const q = norm(f && f.q);
    return (views || []).filter((v) => {
      if (f.city && v.city !== f.city) return false;
      if (f.prop && v.name !== f.prop) return false;
      if (f.only === "conflicts" && !v.counts.conflicts && !v.counts.possible) return false;
      if (f.only === "vacant" && !v.counts.vacant) return false;
      if (f.only === "moves" && !v.arrivals.length && !v.departures.length) return false;
      if (!q) return true;
      const hay = norm([v.name, v.addr, ...v.rooms.map((r) => r.task + " " + r.addr), ...v.rooms.flatMap((r) => r.on.map((x) => x.t.name + " " + (x.t.email || ""))), ...v.unplaced.map((x) => x.t.name + " " + (x.t.email || "")), ...v.arrivals.map((t) => t.name)].join(" "));
      return hay.includes(q);
    });
  }
  function totals(views) {
    return (views || []).reduce((a, v) => ({ rooms: a.rooms + v.counts.rooms, occupied: a.occupied + v.counts.occupied, vacant: a.vacant + v.counts.vacant,
      conflicts: a.conflicts + v.counts.conflicts, possible: a.possible + (v.counts.possible || 0), untracked: a.untracked + (v.counts.untracked || 0), people: a.people + v.counts.people, arrivals: a.arrivals + v.arrivals.length, departures: a.departures + v.departures.length }),
    { rooms: 0, occupied: 0, vacant: 0, conflicts: 0, possible: 0, untracked: 0, people: 0, arrivals: 0, departures: 0 });
  }
  function norm(s) { return String(s == null ? "" : s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim(); }

  // Review queue: a change row → the words a reviewer reads.
  const FIELD = { name: "Name", email: "Email", phone: "WhatsApp", city: "City", property: "House", room: "Room", inventoryRoomGid: "Room link",
    moveIn: "Move-in", leaseEnd: "Lease end", status: "Status", movedOutAt: "Moved out", rent: "Rent", leaseType: "Lease type", school: "School",
    deposit: "Deposit", contractId: "Contract", asanaGid: "Asana record" };
  function changeLines(c) {
    if (c.op === "insert") return [{ label: "New tenant", from: null, to: [c.after.property, c.after.room && c.after.room !== "—" ? c.after.room : "", c.after.moveIn ? "from " + c.after.moveIn : "", c.after.leaseEnd ? "to " + c.after.leaseEnd : ""].filter(Boolean).join(" · ") }];
    if (c.op === "delete") return [{ label: "Deleted", from: null, to: null }];
    if (c.op === "restore") return [{ label: "Restored", from: null, to: null }];
    return (c.changed || []).map((k) => ({ label: FIELD[k] || k, from: fmtVal(c.before && c.before[k]), to: fmtVal(c.after && c.after[k]) }));
  }
  function fmtVal(v) { if (v == null || v === "") return "—"; if (typeof v === "object") return JSON.stringify(v); return String(v); }
  function who(c) {
    if (c.actor_kind === "staff") return c.actor_name || "Staff";
    if (c.actor_kind === "hugo") return "Hugo";
    return (c.actor_name || (c.actor_kind === "system" ? "Portal automation" : "Automation"));
  }
  // The patch a data-check suggestion makes on the stored record (null when there is none to apply).
  function suggestionPatch(item, rec) {
    const s = item && item.suggestion;
    if (!s || !s.patch || !rec) return null;
    const patch = { ...s.patch };
    if (patch.status === "past" && !patch.movedOutAt) return null;
    if (patch.status === "past" && rec.leaseEnd && patch.movedOutAt < rec.leaseEnd) patch.leaseEnd = patch.movedOutAt;
    return patch;
  }

  // Who is with us during a month [from, to]: one group per person (current and future rows, not moved out).
  // notices: Map email -> check-out move-out date (a check-out form = the tenant gave notice).
  //   staying     there the whole month, no notice inside it
  //   arriving    moves in during the month (new sales)
  //   notice      leaves during the month and gave notice
  //   leaseEnds   leaves during the month because the lease ends, no notice on file
  //   unconfirmed lease ended before today but still marked living (renewed? left?)
  //   undated     no move-in and no lease end on the row
  const AGENCY = /ces-schools|englishcollege|uhomes|ilsc|ef\.com|kaplan|globalyouth|4stay|coliving|vanmates/;
  function monthRoster(list, notices, from, to, today) {
    const g = { staying: [], arriving: [], notice: [], leaseEnds: [], unconfirmed: [], undated: [] };
    for (const t of list || []) {
      if (!t || isPast(t)) continue;
      const mi = iso(t.moveIn), le = iso(t.leaseEnd);
      const em = String(t.email || "").trim().toLowerCase();
      let nd = em && !AGENCY.test(em) && notices ? iso(notices.get(em)) : null;
      if (nd && mi && nd < mi) nd = null;            // a notice from an earlier stay
      if (mi && mi > to) continue;                   // arrives after the month
      if (!mi && !le) { g.undated.push({ t }); continue; }
      if (le && le < today && !nd) { g.unconfirmed.push({ t, end: le }); continue; }
      const end = [le, nd].filter(Boolean).sort()[0] || null;
      if (end && end < from) continue;               // gone before the month starts
      if (mi && mi >= from) g.arriving.push({ t, start: mi, end });
      else if (end && end <= to) (nd && nd <= to ? g.notice : g.leaseEnds).push({ t, end });
      else g.staying.push({ t, end });
    }
    const by = (k) => (a, b) => String(a[k] || "").localeCompare(String(b[k] || "")) || String(a.t.name || "").localeCompare(String(b.t.name || ""));
    g.arriving.sort(by("start")); g.notice.sort(by("end")); g.leaseEnds.sort(by("end")); g.unconfirmed.sort(by("end"));
    g.staying.sort((a, b) => String(a.t.property || "").localeCompare(String(b.t.property || ""), undefined, { numeric: true }) || String(a.t.name || "").localeCompare(String(b.t.name || "")));
    return g;
  }
  function monthBounds(ym) {
    const [y, m] = ym.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, "0")}` };
  }

  const TDB_CORE = { FAR, iso, addDays, stay, covers, flagsOn, together, buildRooms, place, occupancy, filterViews, totals, changeLines, who, suggestionPatch, monthRoster, monthBounds };
  window.TDB_CORE = TDB_CORE;
  if (typeof document === "undefined" || !document.querySelector) return;

  // ── shared ───────────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const sb = () => window.vmDb && window.vmDb.sb;
  const todayIso = () => tnIso(tnToday());
  const fmt = (d) => (d ? tnFmt(d) : "");
  const isReviewer = () => { const u = (typeof activeRole === "function" && activeRole()) || {}; return u.role === "admin" || (Array.isArray(u.allowed_pages) && u.allowed_pages.includes("tenant-review")); };
  const ago = (ts) => { const s = (Date.now() - Date.parse(ts)) / 1000; if (!isFinite(s)) return ""; if (s < 3600) return Math.max(1, Math.round(s / 60)) + " min ago"; if (s < 86400) return Math.round(s / 3600) + " h ago"; return Math.round(s / 86400) + " d ago"; };

  (function css() {
    const st = document.createElement("style");
    st.textContent = `
.td-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0}
.td-bar .form-input{width:auto}
.td-chip{border:1px solid var(--line,#e5ded6);background:var(--card,#fff);border-radius:999px;padding:5px 10px;font-size:12px;cursor:pointer;color:inherit}
.td-chip.on{background:var(--ink,#2b2420);color:#fff;border-color:transparent}
.td-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin:8px 0 14px}
.td-tile{background:var(--card,#fff);border:1px solid var(--line,#e5ded6);border-radius:12px;padding:10px 12px;cursor:pointer;text-align:left;color:inherit;font:inherit}
.td-tile b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
.td-tile.on{outline:2px solid var(--ink,#2b2420)}
.td-tile.bad b{color:var(--red-dark,#a3302a)}
.td-prop{margin-bottom:10px}
.td-prop>summary{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline;cursor:pointer;padding:12px 14px;list-style:none}
.td-prop>summary::-webkit-details-marker{display:none}
.td-prop-name{font-weight:600}
.td-rooms{width:100%;border-collapse:collapse;font-size:13px}
.td-rooms th{text-align:left;font-weight:500;color:var(--muted,#8a7b6c);font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:6px 14px}
.td-rooms td{padding:8px 14px;border-top:1px solid var(--line,#efe8e0);vertical-align:top}
.td-rooms tr.td-conf td{background:rgba(196,60,50,.07)}
.td-who{display:block}
.td-who a,.td-link{color:inherit;text-decoration:underline;text-decoration-color:rgba(0,0,0,.25);cursor:pointer}
.td-tag{display:inline-block;font-size:11px;border-radius:999px;padding:1px 7px;margin-left:4px;background:rgba(0,0,0,.06)}
.td-tag.warn{background:rgba(214,150,40,.18)}
.td-tag.bad{background:rgba(196,60,50,.16);color:var(--red-dark,#a3302a)}
.td-tag.ok{background:rgba(60,140,90,.15)}
.td-vac{color:var(--muted,#8a7b6c)}
.td-moves{display:grid;grid-template-columns:1fr 1fr;gap:6px 18px;padding:8px 14px 12px;font-size:13px}
.td-hist{font-size:12px;color:var(--muted,#8a7b6c);margin-top:4px}
.td-q{display:grid;gap:10px}
.td-item{padding:12px 14px}
.td-item-h{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline}
.td-diff{font-size:13px;margin:6px 0}
.td-diff s{color:var(--muted,#8a7b6c)}
.td-acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:center}
.td-acts input{flex:1;min-width:180px}
.td-ev{width:100%;font-size:12px;border-collapse:collapse;margin-top:6px}
.td-ev td,.td-ev th{border-top:1px solid var(--line,#efe8e0);padding:4px 6px;text-align:left}
.td-hrow{font-size:12px;padding:6px 0;border-top:1px solid var(--line,#efe8e0)}
.tb-sum{margin:0 0 10px}
.tb-house{padding:0;margin-bottom:12px;overflow:hidden}
.tb-head{display:grid;grid-template-columns:minmax(0,1fr) 220px auto;gap:10px 18px;align-items:center;padding:14px 16px;border-bottom:1px solid var(--cream-2,#efe8e0)}
.tb-name{font-weight:700;font-size:15px;color:inherit;text-decoration:none}
.tb-name:hover{color:var(--red)}
.tb-occ{display:flex;align-items:center;gap:8px;font-size:13px}
.tb-occ .occ-bar{display:block;flex:1;margin:0;min-width:60px}
.tb-occ .occ-fill{display:block;height:100%}
.tb-acts{display:flex;gap:6px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
.tb-cols,.tb-row{display:grid;grid-template-columns:minmax(110px,1.1fr) minmax(0,2fr) minmax(150px,1fr) 80px;gap:4px 14px;padding:9px 16px;align-items:start}
.tb-cols{padding-top:8px;padding-bottom:4px;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.tb-cols span:last-child,.tb-rent{text-align:right}
.tb-row{border-top:1px solid var(--cream-2,#efe8e0);font-size:13.5px}
.tb-span{grid-column:2 / -1}
.tb-next{grid-column:2 / -1}
.tb-empty{background:var(--cream,#faf6f1)}
.tb-who .td-link{font-weight:600}
@media (max-width:760px){.tb-head{grid-template-columns:1fr}.tb-acts{justify-content:flex-start}.tb-cols{display:none}.tb-row{grid-template-columns:minmax(90px,1fr) minmax(0,2fr)}.tb-dates,.tb-rent{grid-column:2;text-align:left}}
@media (max-width:640px){.td-moves{grid-template-columns:1fr}.td-rooms th:nth-child(3),.td-rooms td:nth-child(3){display:none}}`;
    document.head.appendChild(st);
  })();

  // ── 2. Tenants › Occupancy ────────────────────────────────────────────────────
  const OC = { date: null, win: 14, only: "", inv: null, invAt: 0, loading: null, err: "", open: new Set(), month: "", group: "", notices: null };
  try { const s = JSON.parse(localStorage.getItem("vm_td_oc") || "{}"); if (s.win) OC.win = s.win; } catch (e) {}

  async function loadInv(force) {
    if (OC.loading) return OC.loading;
    if (OC.inv && !force && Date.now() - OC.invAt < 5 * 60000) return;
    const c = sb();
    if (!c) { OC.inv = []; return; }
    OC.loading = (async () => {
      try {
        const [rooms, props] = await Promise.all([
          invSelectAll(c, "inventory_rooms", "id,asana_gid,asana_project_gid,city,property_id,task_name,room_type,room_type_override,lease_type,price_cents,status,available_from,available_from_approx,available_until,photo_urls,pictures_url,address,synced_at", (q) => q.order("task_name").order("id")),
          invSelectAll(c, "inventory_properties", "id,name,city,address", (q) => q.order("name").order("id")),
        ]);
        OC.inv = vacFromInventory(rooms, props, Date.now()); OC.invAt = Date.now(); OC.err = "";
      } catch (e) { console.error("[tenant-db] inventory", e); OC.err = "Could not load the room inventory: " + (e.message || e); OC.inv = OC.inv || []; }
      finally { OC.loading = null; }
    })();
    return OC.loading;
  }
  let MODEL = null, MKEY = "";
  function model() {
    const k = [properties.length, (OC.inv || []).length, OC.invAt].join("|");
    if (MODEL && MKEY === k) return MODEL;
    MODEL = buildRooms(properties, OC.inv || []); MKEY = k;
    return MODEL;
  }
  function liveTenants() {
    let list = (typeof tnScoped === "function" ? tnScoped() : tenants) || [];
    return list.filter((t) => t && !t._deletedAt);
  }

  function ensureShell() {
    if ($("tn-occ")) return;
    const seg = document.querySelector('.tn-seg[aria-label="View"]');
    if (seg && !seg.querySelector('[data-tn-view="occ"]')) seg.insertAdjacentHTML("beforeend", `<button type="button" data-tn-view="occ">Occupancy</button>`);
    const houses = $("tn-houses");
    if (houses) houses.insertAdjacentHTML("afterend", `<div id="tn-occ" hidden></div>`);
  }

  // Check-out forms = notice given. Read once per page load (staff without Checkouts access see none).
  async function loadNotices() {
    const c = sb();
    if (!c) { OC.notices = new Map(); return; }
    try {
      const { data, error } = await c.from("checkout_cases").select("email,move_out_date,created_at,deleted_at").not("move_out_date", "is", null).order("created_at").limit(5000);
      if (error) throw error;
      const m = new Map();
      (data || []).forEach((r) => { if (!r.deleted_at && r.email) m.set(String(r.email).trim().toLowerCase(), r.move_out_date); });
      OC.notices = m;
    } catch (e) { console.warn("[tenant-db] notices", e); OC.notices = new Map(); OC.noticeErr = true; }
  }
  const MONTH_GROUPS = [
    ["staying", "Staying all month", "No notice; the lease runs past the month."],
    ["arriving", "New: moving in", "Move-in date inside the month (new sales)."],
    ["notice", "Leaving: gave notice", "A check-out form gives a date inside the month."],
    ["leaseEnds", "Leaving: lease ends", "Lease ends inside the month, no check-out form yet: renewing or leaving?"],
    ["unconfirmed", "Unclear: lease already ended", "Still marked living though the lease ended. Confirm renewed or moved out."],
    ["undated", "Unclear: no dates", "No move-in or lease end on the row."],
  ];
  function monthOptions(today) {
    const out = [];
    const [y, m] = today.split("-").map(Number);
    for (let i = 0; i < 7; i++) { const d = new Date(Date.UTC(y, m - 1 + i, 1)); out.push(d.toISOString().slice(0, 7)); }
    return out;
  }
  const monthLabel = (ym) => { const [y, m] = ym.split("-").map(Number); return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1] + " " + y; };
  function renderMonth(el, today) {
    if (!OC.notices) { el.innerHTML = `<div class="card tn-empty">Loading…</div>`; loadNotices().then(renderOcc); return; }
    const { from, to } = monthBounds(OC.month);
    const scoped = liveTenants().filter((t) => (!TN.city || t.city === TN.city) && (!TN.house || t.property === TN.house) && (!TN.q || norm([t.name, t.email, t.property, t.room].join(" ")).includes(norm(TN.q))));
    const g = monthRoster(scoped, OC.notices, from, to, today);
    const sure = g.staying.length + g.arriving.length;
    const part = g.notice.length + g.leaseEnds.length;
    const tile = (k, label, n, cls) => `<button type="button" class="td-tile${OC.group === k ? " on" : ""}${cls && n ? " " + cls : ""}" data-td-group="${k}"><b>${n}</b>${label}</button>`;
    const shown = OC.group ? MONTH_GROUPS.filter(([k]) => k === OC.group) : MONTH_GROUPS;
    const row = (k, x) => { const t = x.t; return `<tr><td>${tenantLink(t)}<div class="hb-sub">${esc(t.email || "")}</div></td><td>${esc(t.property || "—")}${t.room && t.room !== "—" ? `<div class="hb-sub">${esc(t.room)}</div>` : ""}</td><td>${esc(t.city || "")}</td><td>${esc(fmt(iso(t.moveIn)) || "—")}</td><td>${esc(fmt(x.end) || (k === "staying" ? "no end date" : "—"))}${k === "notice" ? `<div class="hb-sub">check-out form</div>` : ""}</td></tr>`; };
    el.innerHTML = `
      ${monthBar(today)}
      <div class="td-tiles">
        ${tile("", `with us all of ${monthLabel(OC.month)} or arriving: <b style="display:inline;font-size:inherit">${g.staying.length}</b> staying + <b style="display:inline;font-size:inherit">${g.arriving.length}</b> new`, sure)}
        ${tile("leaving", "leaving during the month (" + g.notice.length + " gave notice · " + g.leaseEnds.length + " lease ends)", part)}
        ${tile("unclear", "unclear: confirm renewed or left", g.unconfirmed.length + g.undated.length, "bad")}
      </div>
      ${OC.noticeErr ? `<div class="card-sub hb-note">Check-out forms couldn't be read with your access, so "gave notice" is based on lease ends only.</div>` : ""}
      ${shown.filter(([k]) => OC.group !== "leaving" || k === "notice" || k === "leaseEnds").filter(([k]) => OC.group !== "unclear" || k === "unconfirmed" || k === "undated").map(([k, label, help]) => g[k].length ? `
        <details class="card td-prop" open><summary><span class="td-prop-name">${esc(label)}</span><span class="hb-sub">${g[k].length} · ${esc(help)}</span></summary>
        <div class="tn-table-wrap"><table class="td-rooms"><thead><tr><th>Tenant</th><th>House · room</th><th>City</th><th>Move-in</th><th>${k === "arriving" ? "Until" : k === "unconfirmed" ? "Lease ended" : "Until"}</th></tr></thead>
        <tbody>${g[k].map((x) => row(k, x)).join("")}</tbody></table></div></details>` : "").join("")}`;
    OC.lastRoster = g;
  }
  function monthBar(today) {
    return `<div class="td-bar">
        <span class="td-seg" role="group"><button type="button" class="td-chip${OC.month ? "" : " on"}" data-td-month="">One day</button>
        ${monthOptions(today).map((ym) => `<button type="button" class="td-chip${OC.month === ym ? " on" : ""}" data-td-month="${ym}">${esc(monthLabel(ym).replace(/ \d{4}$/, ""))}</button>`).join("")}</span>
        ${OC.month ? `<button type="button" class="btn btn-ghost tn-mini" data-td-csv style="margin-left:auto">Download CSV</button>` : ""}
      </div>`;
  }
  function rosterCsv() {
    const g = OC.lastRoster; if (!g) return;
    const cell = (v) => { let x = String(v == null ? "" : v); if (/^[=+\-@]/.test(x) && !/^[+-]?\d/.test(x)) x = "'" + x; return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
    const lines = [["Group", "Name", "Email", "WhatsApp", "City", "House", "Room", "Move-in", "Until"].join(",")];
    MONTH_GROUPS.forEach(([k, label]) => g[k].forEach((x) => lines.push([label, x.t.name, x.t.email, x.t.phone, x.t.city, x.t.property, x.t.room, iso(x.t.moveIn), x.end].map(cell).join(","))));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" }));
    a.download = `vanmates-tenants-${OC.month}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  function renderOcc() {
    const el = $("tn-occ");
    if (!el) return;
    const today = todayIso();
    if (OC.month) { renderMonth(el, today); return; }
    const d = OC.date || today;
    if (!OC.inv) { el.innerHTML = `<div class="card tn-empty">Loading rooms…</div>`; loadInv().then(renderOcc); return; }
    const list = liveTenants();
    const m = model();
    const byEmail = PR_CORE.contractRooms(window.contracts);
    const placement = place(list, m, byEmail);
    const all = occupancy(m, list, placement, d, today, OC.win);
    const views = filterViews(all, { city: TN.city, prop: TN.house, q: TN.q, only: OC.only });
    const tot = totals(filterViews(all, { city: TN.city, prop: TN.house, q: TN.q, only: "" }));
    const nextFirst = (() => { const x = new Date(today + "T12:00:00Z"); x.setUTCMonth(x.getUTCMonth() + 1, 1); return x.toISOString().slice(0, 10); })();
    const chip = (label, val) => `<button type="button" class="td-chip${d === val ? " on" : ""}" data-td-date="${val}">${label}</button>`;
    const tile = (key, n, label, bad) => `<button type="button" class="td-tile${OC.only === key ? " on" : ""}${bad && n ? " bad" : ""}" data-td-only="${key}"><b>${n}</b>${label}</button>`;
    const cards = views.slice(0, 200).map((v) => propCard(v, d, today)).join("");
    el.innerHTML = `
      ${monthBar(today)}
      <div class="td-bar">
        <label class="hb-sub" for="td-date">Who lives here on</label>
        <input type="date" class="form-input" id="td-date" value="${d}">
        ${chip("Today", today)}${chip("In 1 week", addDays(today, 7))}${chip("In 30 days", addDays(today, 30))}${chip(fmt(nextFirst).replace(/, \d{4}$/, ""), nextFirst)}
        <span class="hb-sub" style="margin-left:auto">Moves in the next</span>
        <select class="form-input" id="td-win" aria-label="Moves window">${[7, 14, 30, 60, 90].map((n) => `<option value="${n}"${n === OC.win ? " selected" : ""}>${n} days</option>`).join("")}</select>
      </div>
      ${OC.err ? `<div class="card-sub hb-note">${esc(OC.err)}</div>` : ""}
      <div class="td-tiles">
        ${tile("", tot.people, d === today ? "living here today" : "living here on " + fmt(d))}
        ${tile("vacant", tot.vacant, "rooms empty that day")}
        ${tile("moves", tot.arrivals + tot.departures, `moves in ${OC.win} days (${tot.arrivals} in · ${tot.departures} out)`)}
        ${tile("conflicts", tot.conflicts, `double-booked rooms${tot.possible ? ` (+${tot.possible} to check)` : ""}`, true)}
      </div>
      ${views.length ? cards : `<div class="card tn-empty">No property matches these filters.</div>`}
      ${views.length > 200 ? `<div class="hb-sub">Showing 200 of ${views.length} properties: pick a city or house to narrow it.</div>` : ""}`;
  }

  function tenantLink(t) { return `<a class="td-link" data-td-open="${esc(tnKeyOf(t))}">${esc(t.name || "Unnamed")}</a>`; }
  function tagsHtml(flags, t) {
    const s = stay(t, todayIso());
    return flags.map((f) => f === "arrives" ? `<span class="td-tag ok">arrives</span>` : f === "leaves" ? `<span class="td-tag">leaves</span>`
      : f === "unconfirmed" ? `<span class="td-tag warn" title="Still marked living; lease ended ${esc(s.end)}">lease ended ${esc(fmt(s.end))}, not confirmed</span>`
      : f === "no_move_in" ? `<span class="td-tag warn">no move-in date</span>`
      : f === "undated" ? `<span class="td-tag warn" title="No move-in or lease end on the row">no dates</span>` : "").join("");
  }
  function untilText(t) { const s = stay(t, todayIso()); return s.unconfirmed ? "" : s.end ? "until " + fmt(s.end) : "no end date"; }

  function propCard(v, d, today) {
    const c = v.counts;
    const open = OC.open.has(v.name) || !!TN.house || (TN.q && TN.q.length > 2) || OC.only === "conflicts";
    const rows = v.rooms.map((r) => {
      const on = r.on.length ? r.on.map((x) => `<span class="td-who">${tenantLink(x.t)} <span class="hb-sub">${esc(untilText(x.t))}</span>${tagsHtml(x.flags, x.t)}</span>`).join("")
        : r.status === "occupied" ? `<span class="td-tag warn" title="Asana has this room as rented, but no portal tenant is linked to it">Rented in Asana · tenant not linked</span>`
        : `<span class="td-vac">Empty${r.status === "not_bookable" ? " · not bookable" : r.status === "hidden" ? " · hidden in Asana" : ""}</span>`;
      const next = r.next ? `${tenantLink(r.next)} <span class="hb-sub">from ${esc(fmt(stay(r.next, today).start))}</span>` : `<span class="hb-sub">—</span>`;
      const hist = r.history.filter((t) => !r.on.some((x) => x.t === t) && t !== r.next).slice(0, 3);
      return `<tr class="${r.conflict ? "td-conf" : ""}"><td><b>${esc(r.unit ? r.unit + " · " : "")}${esc(r.label)}</b>${r.conflict ? `<span class="td-tag bad">double-booked</span>` : r.possible ? `<span class="td-tag warn" title="At least one person is matched to this room by its name only">check: 2 people</span>` : ""}</td>
        <td>${on}${hist.length ? `<div class="td-hist">Before: ${hist.map((t) => `${tenantLink(t)} (${esc(fmt(stay(t, today).start) || "?")} – ${esc(fmt(stay(t, today).end) || "?")})`).join(", ")}</div>` : ""}</td><td>${next}</td></tr>`;
    }).join("");
    const loose = v.unplaced.length ? `<tr><td><b>Room not linked</b></td><td colspan="2">${v.unplaced.map((x) => `<span class="td-who">${tenantLink(x.t)} <span class="hb-sub">${esc(x.t.room && x.t.room !== "—" ? "“" + x.t.room + "” · " : "")}${esc(untilText(x.t))}</span>${tagsHtml(x.flags, x.t)}</span>`).join("")}</td></tr>` : "";
    const moves = v.arrivals.length || v.departures.length ? `<div class="td-moves"><div><div class="hb-sub">Moving in (${OC.win} days)</div>${v.arrivals.map((t) => `<div>${esc(fmt(stay(t, today).start))} · ${tenantLink(t)}</div>`).join("") || `<div class="hb-sub">—</div>`}</div>
      <div><div class="hb-sub">Moving out (${OC.win} days)</div>${v.departures.map((t) => `<div>${esc(fmt(stay(t, today).end))} · ${tenantLink(t)}</div>`).join("") || `<div class="hb-sub">—</div>`}</div></div>` : "";
    return `<details class="card td-prop" data-td-prop="${esc(v.name)}"${open ? " open" : ""}>
      <summary><span class="td-prop-name">${esc(v.name)}</span><span class="hb-sub">${esc([v.addr, v.city].filter(Boolean).join(" · "))}</span>
        <span class="hb-sub">${c.rooms ? `${c.occupied}/${c.rooms} rooms occupied · ${c.vacant} empty${c.untracked ? ` · ${c.untracked} rented, tenant not linked` : ""}` : `${c.people} tenant${c.people === 1 ? "" : "s"}`}</span>
        ${c.conflicts ? `<span class="td-tag bad">${c.conflicts} double-booked</span>` : ""}${c.possible ? `<span class="td-tag warn">${c.possible} to check</span>` : ""}
        ${v.arrivals.length ? `<span class="td-tag ok">${v.arrivals.length} in</span>` : ""}${v.departures.length ? `<span class="td-tag">${v.departures.length} out</span>` : ""}
        <button type="button" class="btn btn-ghost tn-mini" data-pr-open="${esc(v.name)}" style="margin-left:auto">Open property</button></summary>
      ${rows || loose ? `<div class="tn-table-wrap"><table class="td-rooms"><thead><tr><th>Room</th><th>On ${esc(fmt(d))}</th><th>Next</th></tr></thead><tbody>${rows}${loose}</tbody></table></div>` : ""}
      ${moves}
    </details>`;
  }

  // ── Tenants › By house: one block per house, every room with who is in it today (like Properties & rooms).
  function rentText(t) { const r = Number(t && t.rent); return r ? (t.city === "Guadalajara" ? "MX$" : "$") + r.toLocaleString() : "—"; }
  function contactText(t) { return [t.email ? tnEmail(t.email) : "", t.phone || ""].filter(Boolean).join(" · "); }
  function houseWho(x, today) {
    const t = x.t, s = stay(t, today);
    return `<div class="tb-who">${tenantLink(t)}${tagsHtml(x.flags, t)}<div class="hb-sub">${esc(contactText(t) || "No contact")}</div></div>
      <div class="tb-dates">${esc(s.start ? fmt(s.start) : "?")} – ${esc(s.end ? fmt(s.end) : "open")}</div>
      <div class="tb-rent num">${rentText(t)}</div>`;
  }
  function houseBlock(v, today) {
    const c = v.counts;
    const pct = c.rooms ? Math.round((c.occupied / c.rooms) * 100) : 0;
    const rows = v.rooms.map((r) => {
      const label = `<div class="tb-room"><b>${esc(r.label)}</b>${r.unit && !new RegExp("\\b" + String(r.unit).replace(/[^\w]/g, "") + "\\b").test(v.name) ? `<div class="hb-sub">Unit ${esc(r.unit)}</div>` : ""}${r.conflict ? `<span class="td-tag bad">double-booked</span>` : r.possible ? `<span class="td-tag warn">check: 2 people</span>` : ""}</div>`;
      const next = r.next ? `<div class="tb-next hb-sub">Next: ${tenantLink(r.next)} from ${esc(fmt(stay(r.next, today).start))}</div>` : "";
      if (!r.on.length) {
        const empty = r.status === "occupied" ? `<span class="td-tag warn" title="Asana has this room as rented, but no portal tenant is linked to it">Rented in Asana · tenant not linked</span>`
          : `<span class="td-vac">Empty${r.status === "not_bookable" ? " · not bookable" : ""}</span>`;
        return `<div class="tb-row tb-empty">${label}<div class="tb-span">${empty}${next}</div></div>`;
      }
      return r.on.map((x, i) => `<div class="tb-row${r.conflict ? " td-conf" : ""}">${i ? "<div></div>" : label}${houseWho(x, today)}${i === r.on.length - 1 ? next : ""}</div>`).join("");
    }).join("");
    const loose = v.unplaced.map((x, i) => `<div class="tb-row">${i ? "<div></div>" : `<div class="tb-room"><b>Room not linked</b></div>`}${houseWho(x, today)}${x.t.room && x.t.room !== "—" ? `<div class="tb-next hb-sub">Room on file: “${esc(x.t.room)}”</div>` : ""}</div>`).join("");
    return `<section class="card tb-house" data-tb-house="${esc(v.name)}">
      <header class="tb-head">
        <div class="tb-title"><a href="#" class="tb-name" data-pr-open="${esc(v.name)}" title="Open ${esc(v.name)}">${esc(v.name)}</a><div class="hb-sub">${esc([v.addr, v.city].filter(Boolean).join(" · "))}</div></div>
        <div class="tb-occ">${c.rooms ? `<span class="num">${c.occupied}/${c.rooms}</span><span class="occ-bar"><span class="occ-fill" style="width:${pct}%"></span></span><span class="hb-sub">${c.vacant ? `${c.vacant} empty` : "full"}</span>` : `<span class="hb-sub">${c.people} tenant${c.people === 1 ? "" : "s"}</span>`}</div>
        <div class="tb-acts">${c.conflicts ? `<span class="td-tag bad">${c.conflicts} double-booked</span>` : ""}${v.departures.length ? `<span class="td-tag">${v.departures.length} leaving soon</span>` : ""}${v.arrivals.length ? `<span class="td-tag ok">${v.arrivals.length} arriving</span>` : ""}
          ${c.people ? `<button type="button" class="btn btn-ghost tn-mini" data-tn-email-house="${esc(v.name)}">Email this house</button>` : ""}</div>
      </header>
      ${rows || loose ? `<div class="tb-cols hb-sub"><span>Room</span><span>Tenant</span><span>Stay</span><span>Rent</span></div><div class="tb-rows">${rows}${loose}</div>` : `<div class="tn-empty">No rooms on file.</div>`}
    </section>`;
  }
  function renderHouses() {
    const el = $("tn-houses");
    if (!el) return;
    const today = todayIso();
    if (!OC.inv) { el.innerHTML = `<div class="card tn-empty">Loading rooms…</div>`; loadInv().then(() => { if (TN.view === "house") renderHouses(); }); return; }
    const list = liveTenants();
    const m = model();
    const placement = place(list, m, PR_CORE.contractRooms(window.contracts));
    const all = occupancy(m, list, placement, today, today, 30).filter((v) => v.name && (v.rooms.length || v.counts.people));
    // A house not set up in Properties takes its tenants' city.
    all.forEach((v) => { if (!v.city) { const p = v.rooms.flatMap((r) => r.on).concat(v.unplaced)[0]; v.city = (p && p.t.city) || ""; } });
    const cityKey = (v) => (v.city ? "0" + v.city : "1");
    const views = filterViews(all, { city: TN.city, prop: TN.house, q: TN.q, only: "" })
      .sort((a, b) => cityKey(a).localeCompare(cityKey(b)) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!views.length) { el.innerHTML = `<div class="card tn-empty">${TN.q || TN.city || TN.house ? "No house matches these filters." : "No houses yet."}</div>`; return; }
    const tot = totals(views);
    const cities = [...new Set(views.map((v) => v.city || "Other"))];
    el.innerHTML = `${OC.err ? `<div class="card-sub hb-note">${esc(OC.err)}</div>` : ""}
      <div class="hb-sub tb-sum">${views.length} house${views.length === 1 ? "" : "s"} · ${tot.people} living here today · ${tot.occupied}/${tot.rooms} rooms occupied · ${tot.vacant} empty</div>
      ${cities.map((city) => `<section class="tn-city"><h3 class="tn-city-h">${esc(city)}</h3>${views.filter((v) => (v.city || "Other") === city).slice(0, 150).map((v) => houseBlock(v, today)).join("")}</section>`).join("")}`;
  }

  // Hook into the Tenants page: the Occupancy segment hides the list/house views and shows ours.
  const baseRender = window.renderTenants;
  if (typeof baseRender === "function") {
    window.renderTenants = function () {
      ensureShell();
      const occ = TN.view === "occ", house = TN.view === "house";
      if (occ || house) { const v = TN.view; TN.view = "list"; baseRender.apply(this, arguments); TN.view = v; }
      else baseRender.apply(this, arguments);
      document.querySelectorAll("[data-tn-view]").forEach((b) => b.classList.toggle("on", b.dataset.tnView === TN.view));
      const o = $("tn-occ");
      if (o) o.hidden = !occ;
      const tabs = $("tn-tabs");
      if (occ || house) {
        ["tn-list-card", "tn-houses", "tn-banner", "bulk-bar"].forEach((id) => { const x = $(id); if (x) x.hidden = true; });
        if (tabs) tabs.style.display = "none";
        if (occ) renderOcc();
        else { $("tn-houses").hidden = false; renderHouses(); }
      } else if (tabs) tabs.style.display = "";
    };
    try { if (localStorage.getItem("vm_tn_view") === "occ") TN.view = "occ"; } catch (e) {}
  }
  document.addEventListener("click", (e) => {
    const view = e.target.closest('.view[data-view="tenants"]');
    if (!view) return;
    const dt = e.target.closest("[data-td-date]");
    if (dt) { OC.date = dt.dataset.tdDate; renderOcc(); return; }
    const mo = e.target.closest("[data-td-month]");
    if (mo) { OC.month = mo.dataset.tdMonth; OC.group = ""; renderOcc(); return; }
    const gr = e.target.closest("[data-td-group]");
    if (gr) { OC.group = OC.group === gr.dataset.tdGroup ? "" : gr.dataset.tdGroup; renderOcc(); return; }
    if (e.target.closest("[data-td-csv]")) { rosterCsv(); return; }
    const only = e.target.closest("[data-td-only]");
    if (only) { OC.only = OC.only === only.dataset.tdOnly ? "" : only.dataset.tdOnly; renderOcc(); return; }
    const op = e.target.closest("[data-td-open]");
    if (op) { e.preventDefault(); openTenant(op.dataset.tdOpen); return; }
  }, true);
  document.addEventListener("change", (e) => {
    if (e.target.id === "td-date") { OC.date = e.target.value || null; renderOcc(); }
    if (e.target.id === "td-win") { OC.win = +e.target.value || 14; try { localStorage.setItem("vm_td_oc", JSON.stringify({ win: OC.win })); } catch (x) {} renderOcc(); }
  });
  document.addEventListener("toggle", (e) => {
    const p = e.target.closest && e.target.closest("[data-td-prop]");
    if (p) { if (p.open) OC.open.add(p.dataset.tdProp); else OC.open.delete(p.dataset.tdProp); }
  }, true);

  // ── 3. Tenant review ──────────────────────────────────────────────────────────
  const RV = { tab: "changes", status: "pending", changes: null, recon: null, fails: null, health: null, err: "", sel: new Set(), busy: false, notes: {} };

  async function rvLoad() {
    const c = sb();
    if (!c) return;
    RV.err = "";
    try {
      const st = RV.status === "pending" ? ["pending", "correction", "flagged"] : [RV.status];
      const [ch, rc, fl, h] = await Promise.all([
        c.from("tenant_changes").select("*").in("review_status", st).order("created_at", { ascending: false }).limit(400),
        c.from("tenant_recon_items").select("*").eq("status", "open").order("severity").order("kind").limit(1000),
        c.from("tenant_write_failures").select("*").is("resolved_at", null).order("last_at", { ascending: false }).limit(200),
        c.rpc("tenant_health"),
      ]);
      for (const r of [ch, rc, fl, h]) if (r.error) throw r.error;
      RV.changes = ch.data || []; RV.recon = rc.data || []; RV.fails = fl.data || []; RV.health = h.data || {};
      setBadge(RV.health);
    } catch (e) {
      RV.err = /does not exist|schema cache/i.test(String(e.message || e)) ? "The tenant database SQL (tenant-db-2026-11-22.sql) is not applied yet." : "Couldn't load: " + (e.message || e);
      RV.changes = RV.changes || []; RV.recon = RV.recon || []; RV.fails = RV.fails || [];
    }
  }
  function setBadge(h) {
    const n = (h.pending || 0) + (h.correction || 0) + (h.recon_high || 0) + (h.failures || 0);
    const b = document.querySelector('.nav-item[data-view="tenant-review"] .nav-count');
    if (b) b.textContent = n ? String(n) : "—";
  }
  async function badgeTick() {
    if (!isReviewer() || !sb()) return;
    try { const { data, error } = await sb().rpc("tenant_health"); if (!error && data) setBadge(data); } catch (e) {}
  }

  function rvRender() {
    const el = $("tr-root");
    if (!el) return;
    if (!RV.changes) { el.innerHTML = `<div class="card tn-empty">Loading…</div>`; return; }
    const h = RV.health || {};
    const recHigh = RV.recon.filter((x) => x.severity === "high").length;
    const tab = (k, label, n, need) => `<button type="button" class="hb-tab${RV.tab === k ? " on" : ""}" data-rv-tab="${k}">${label}<span class="hb-n${need && n ? " hb-need-v" : ""}">${n}</span></button>`;
    el.innerHTML = `
      ${RV.err ? `<div class="card-sub hb-note">${esc(RV.err)}</div>` : ""}
      <div class="hb-tabbar" role="tablist">
        ${tab("changes", "Changes to check", RV.status === "pending" ? RV.changes.length : (h.pending || 0) + (h.correction || 0) + (h.flagged || 0), true)}
        ${tab("recon", "Data checks", RV.recon.length, recHigh > 0)}
        ${tab("fails", "Failed writes", RV.fails.length + ((h.asana_failed || []).length), true)}
      </div>
      <div class="card-sub" style="margin:6px 0 10px">${esc(h.changes_24h != null ? `${h.changes_24h} tenant changes in the last 24 h` : "")}${h.last_recon ? ` · last data check ${esc(ago(h.last_recon))}` : ""}${h.asana_queued ? ` · ${h.asana_queued} Asana backup copies waiting over 15 min` : ""}</div>
      ${RV.tab === "changes" ? rvChanges() : RV.tab === "recon" ? rvRecon() : rvFails()}`;
  }

  function rvChanges() {
    const st = (k, l) => `<button type="button" class="td-chip${RV.status === k ? " on" : ""}" data-rv-status="${k}">${l}</button>`;
    const list = RV.changes;
    const head = `<div class="td-bar">${st("pending", "Open")}${st("verified", "Verified")}
      <span class="hb-sub" style="margin-left:auto">${RV.sel.size ? `${RV.sel.size} selected` : ""}</span>
      ${RV.status === "pending" ? `<button type="button" class="btn btn-ghost tn-mini" data-rv-selall>Select all</button><button type="button" class="btn btn-primary tn-mini" data-rv-bulk="verified" ${RV.sel.size ? "" : "disabled"}>Verify selected</button>` : ""}</div>
      ${RV.status === "pending" ? `<div class="card-sub hb-note">Hugo and the automations change move-ins, lease ends, move-outs and rooms on their own. Each change waits here until you check it against the contract, extension or check-out. <b>Verify</b> if it's right; <b>Request correction</b> sends your note to #admin (and Hugo); <b>Flag</b> keeps it here to look into.</div>` : ""}`;
    if (!list.length) return head + `<div class="card tn-empty">${RV.status === "pending" ? "Nothing waiting. Every automated change has been checked." : "No changes here."}</div>`;
    return head + `<div class="td-q">${list.map((c) => {
      const lines = changeLines(c).map((l) => l.from === null ? `<div><b>${esc(l.label)}</b>${l.to ? ": " + esc(l.to) : ""}</div>` : `<div><b>${esc(l.label)}</b>: <s>${esc(l.from)}</s> → ${esc(l.to)}</div>`).join("");
      const status = { pending: "", correction: `<span class="td-tag warn">correction requested</span>`, flagged: `<span class="td-tag bad">flagged</span>`, verified: `<span class="td-tag ok">verified</span>` }[c.review_status] || "";
      const t = tnFind(c.tenant_id);
      const open = c.review_status !== "verified";
      return `<div class="card td-item" data-rv-change="${c.id}">
        <div class="td-item-h">${open ? `<input type="checkbox" data-rv-sel="${c.id}" ${RV.sel.has(c.id) ? "checked" : ""} aria-label="Select">` : ""}
          ${t ? `<a class="td-link" data-td-open="${esc(c.tenant_id)}"><b>${esc(c.tenant_name || c.tenant_id)}</b></a>` : `<b>${esc(c.tenant_name || c.tenant_id)}</b>`}
          <span class="hb-sub">${esc([c.property, c.room && c.room !== "—" ? c.room : "", c.city].filter(Boolean).join(" · "))}</span>
          ${status}${(c.flags || []).includes("overrides_verified") ? `<span class="td-tag bad" title="A reviewer had verified this value before">changes a verified value</span>` : ""}
          <span class="hb-sub" style="margin-left:auto">${esc(who(c))}${c.via ? " · " + esc(c.via) : ""} · ${esc(ago(c.created_at))}</span></div>
        <div class="td-diff">${lines}${c.reason ? `<div class="hb-sub">Why: ${esc(c.reason)}</div>` : ""}${c.review_note ? `<div class="hb-sub">${esc(c.reviewed_by_name || "")}: ${esc(c.review_note)}</div>` : ""}</div>
        ${open ? `<div class="td-acts"><button type="button" class="btn btn-primary tn-mini" data-rv-do="verified|${c.id}">Verify</button>
          <input class="form-input" data-rv-note="${c.id}" placeholder="What's wrong? (needed to request a correction)" value="${esc(RV.notes[c.id] || "")}">
          <button type="button" class="btn btn-ghost tn-mini" data-rv-do="correction|${c.id}">Request correction</button>
          <button type="button" class="btn btn-ghost tn-mini" data-rv-do="flagged|${c.id}">Flag</button></div>`
        : `<div class="td-acts"><button type="button" class="btn btn-ghost tn-mini" data-rv-do="pending|${c.id}">Re-open</button></div>`}
      </div>`;
    }).join("")}</div>`;
  }

  const KIND = { missing_in_portal: "Missing from the portal", unlinked: "Not linked to Asana", ambiguous_match: "Several possible rows", status_mismatch: "Status differs",
    date_mismatch: "Dates differ", property_mismatch: "House differs", ended_active: "Lease ended, still active", duplicate: "Duplicate", room_overlap: "Double-booked room",
    room_empty_but_occupied: "Listed free, someone lives there", checkout_date: "Check-out date differs" };
  function rvRecon() {
    const list = RV.recon;
    if (!list.length) return `<div class="card tn-empty">No open data checks. The daily check (6:30 am) adds anything new.</div>`;
    const order = { high: 0, medium: 1, low: 2 };
    const sorted = list.slice().sort((a, b) => order[a.severity] - order[b.severity] || a.kind.localeCompare(b.kind) || String(a.tenant_name).localeCompare(String(b.tenant_name)));
    return `<div class="card-sub hb-note">The daily check compares the Asana registers with the portal and both with the contracts, extensions, check-outs and the room inventory. <b>Apply fix</b> appears only where the paperwork decides it. <b>Portal is right</b> and <b>Not a problem</b> close the item; nothing changes on the tenant.</div>
      <div class="td-q">${sorted.map((it) => {
        const t = it.tenant_id ? tnFind(it.tenant_id) : null;
        const sug = it.suggestion || {};
        const patch = t ? suggestionPatch(it, t) : null;
        const fix = sug.create ? `<button type="button" class="btn btn-primary tn-mini" data-rc-do="create|${esc(it.id)}">Add to the portal</button>`
          : patch ? `<button type="button" class="btn btn-primary tn-mini" data-rc-do="apply|${esc(it.id)}">Apply fix: ${esc(Object.entries(patch).map(([k, v]) => (FIELD[k] || k) + " " + v).join(", "))}</button>` : "";
        return `<div class="card td-item">
          <div class="td-item-h"><span class="td-tag ${it.severity === "high" ? "bad" : it.severity === "medium" ? "warn" : ""}">${esc(KIND[it.kind] || it.kind)}</span>
            ${t ? `<a class="td-link" data-td-open="${esc(it.tenant_id)}"><b>${esc(it.title)}</b></a>` : `<b>${esc(it.title)}</b>`}
            <span class="hb-sub" style="margin-left:auto">${esc([it.property, it.city].filter(Boolean).join(" · "))}</span></div>
          ${it.detail ? `<div class="td-diff">${esc(it.detail)}</div>` : ""}
          ${evidenceTable(it.evidence)}
          <div class="td-acts">${fix}
            <button type="button" class="btn btn-ghost tn-mini" data-rc-do="kept|${esc(it.id)}">Portal is right</button>
            <button type="button" class="btn btn-ghost tn-mini" data-rc-do="dismissed|${esc(it.id)}">Not a problem</button>
            ${it.asana_gid ? `<a class="hb-sub" href="https://app.asana.com/0/0/${esc(it.asana_gid)}/f" target="_blank" rel="noopener">Asana ↗</a>` : ""}</div>
        </div>`;
      }).join("")}</div>`;
  }
  function evidenceTable(ev) {
    if (!ev) return "";
    const a = ev.asana, p = ev.portal, w = ev.paperwork;
    if (a && p) {
      const row = (l, x, y) => `<tr><th>${l}</th><td>${esc(fmtVal(x))}</td><td>${esc(fmtVal(y))}</td></tr>`;
      return `<table class="td-ev"><tr><th></th><th>Portal</th><th>Asana</th></tr>${row("Move-in", p.moveIn, a.moveIn)}${row("Lease end", p.leaseEnd, a.leaseEnd)}${row("Status", p.status, a.completed ? "closed" : "open")}${row("House", p.property, a.section)}${w && w.value ? `<tr><th>Paperwork</th><td colspan="2">${esc(w.source)}: ${esc(w.value)}</td></tr>` : ""}</table>`;
    }
    if (ev.rows) return `<table class="td-ev"><tr><th>Row</th><th>House · room</th><th>Dates</th></tr>${ev.rows.map((r) => `<tr><td>${tnFind(r.id) ? `<a class="td-link" data-td-open="${esc(r.id)}">${esc(r.name)}</a>` : esc(r.name)}</td><td>${esc([r.property, r.room].filter((x) => x && x !== "—").join(" · "))}</td><td>${esc((r.moveIn || "?") + " → " + (r.leaseEnd || "no end"))}</td></tr>`).join("")}</table>`;
    if (ev.candidates) return `<table class="td-ev">${ev.candidates.map((r) => `<tr><td>${tnFind(r.id) ? `<a class="td-link" data-td-open="${esc(r.id)}">${esc(r.name)}</a>` : esc(r.name)}</td><td>${esc(r.property || "")}</td><td>${esc((r.moveIn || "?") + " → " + (r.leaseEnd || "?"))}</td></tr>`).join("")}</table>`;
    return "";
  }
  function rvFails() {
    const af = (RV.health && RV.health.asana_failed) || [];
    if (!RV.fails.length && !af.length) return `<div class="card tn-empty">No failed tenant writes. Hugo records every write the database did not confirm; it clears once a retry works.</div>`;
    return `<div class="td-q">${RV.fails.map((f) => `<div class="card td-item"><div class="td-item-h"><b>${esc(f.summary || f.ref)}</b><span class="td-tag bad">${esc(f.writer)} · ${esc(f.op)}</span>
        <span class="hb-sub" style="margin-left:auto">${f.attempts} attempt${f.attempts === 1 ? "" : "s"} · last ${esc(ago(f.last_at))}</span></div>
        <div class="td-diff hb-sub">${esc(f.error || "")}</div>
        <div class="td-acts">${f.tenant_id && tnFind(f.tenant_id) ? `<a class="td-link" data-td-open="${esc(f.tenant_id)}">Open tenant</a>` : ""}<button type="button" class="btn btn-ghost tn-mini" data-rf-dismiss="${f.id}">Done by hand</button></div></div>`).join("")}
      ${af.map((o) => `<div class="card td-item"><div class="td-item-h"><b>${esc((tnFind(o.tenant_id) || {}).name || o.tenant_id)}</b><span class="td-tag warn">Asana backup copy failed</span><span class="hb-sub" style="margin-left:auto">${esc(o.at ? ago(o.at) : "")}</span></div><div class="td-diff hb-sub">${esc(o.error || "")} · ${esc((o.changed || []).join(", "))}</div></div>`).join("")}</div>`;
  }

  async function rvDecide(ids, decision, note) {
    if (RV.busy) return;
    RV.busy = true;
    try {
      const { data, error } = await sb().rpc("tenant_review_decide", { p_ids: ids, p_decision: decision, p_note: note || null });
      if (error) throw error;
      showToast(decision === "verified" ? `Verified ${data} change${data === 1 ? "" : "s"}.` : decision === "correction" ? "Correction requested: posted to #admin." : decision === "flagged" ? "Flagged." : "Re-opened.");
      ids.forEach((id) => { RV.sel.delete(id); delete RV.notes[id]; });
      await rvLoad();
    } catch (e) { showToast(String(e.message || e)); }
    finally { RV.busy = false; rvRender(); }
  }
  async function rcDecide(it, decision) {
    const { error } = await sb().rpc("tenant_recon_decide", { p_id: it.id, p_decision: decision, p_note: null });
    if (error) throw error;
    RV.recon = RV.recon.filter((x) => x.id !== it.id);
  }
  async function rcDo(action, id) {
    const it = (RV.recon || []).find((x) => x.id === id);
    if (!it || RV.busy) return;
    RV.busy = true;
    try {
      if (action === "apply") {
        const t = tnFind(it.tenant_id);
        const patch = suggestionPatch(it, t);
        if (!t || !patch) throw new Error("That tenant isn't loaded. Reload the page.");
        if (!(await tnSave(t, patch, `${t.name}: fixed.`))) throw new Error("The save failed; nothing changed.");
        await rcDecide(it, "applied");
      } else if (action === "create") {
        const rec = { ...it.suggestion.create };
        if (tnFind(rec.id)) throw new Error("A tenant with that id already exists.");
        rec.addedFrom = "tenant-review"; delete rec.lastChange;
        const ok = window.vmDb && window.vmDb.upsert ? await window.vmDb.upsert("tenants", rec) : false;
        if (ok === false) throw new Error("The save failed; nothing changed.");
        tenants.push(rec);
        await rcDecide(it, "applied");
        showToast(`${rec.name} added to Tenants.`);
        if (typeof renderTenants === "function") renderTenants();
      } else {
        await rcDecide(it, action);
        showToast(action === "kept" ? "Kept as it is." : "Dismissed.");
      }
    } catch (e) { showToast(String(e.message || e)); }
    finally { RV.busy = false; rvRender(); }
  }

  let wired = false;
  function ensureReviewView() {
    const root = $("tr-root");
    if (wired || !root) return;
    wired = true;
    root.addEventListener("click", (e) => {
      const tb = e.target.closest("[data-rv-tab]"); if (tb) { RV.tab = tb.dataset.rvTab; rvRender(); return; }
      const st = e.target.closest("[data-rv-status]"); if (st) { RV.status = st.dataset.rvStatus; RV.sel.clear(); RV.changes = null; rvRender(); rvLoad().then(rvRender); return; }
      const op = e.target.closest("[data-td-open]"); if (op) { e.preventDefault(); openTenant(op.dataset.tdOpen); return; }
      if (e.target.closest("[data-rv-selall]")) { RV.changes.filter((c) => c.review_status !== "verified").forEach((c) => RV.sel.add(c.id)); rvRender(); return; }
      const bulk = e.target.closest("[data-rv-bulk]"); if (bulk) { rvDecide([...RV.sel], bulk.dataset.rvBulk, null); return; }
      const d = e.target.closest("[data-rv-do]");
      if (d) { const [dec, id] = d.dataset.rvDo.split("|"); rvDecide([+id], dec, RV.notes[id] || ""); return; }
      const rc = e.target.closest("[data-rc-do]"); if (rc) { const i = rc.dataset.rcDo.indexOf("|"); rcDo(rc.dataset.rcDo.slice(0, i), rc.dataset.rcDo.slice(i + 1)); return; }
      const rf = e.target.closest("[data-rf-dismiss]");
      if (rf) { sb().rpc("tenant_write_dismiss", { p_id: +rf.dataset.rfDismiss, p_note: "done by hand" }).then(({ error }) => { if (error) showToast(error.message); return rvLoad(); }).then(rvRender); }
    });
    root.addEventListener("change", (e) => {
      const cb = e.target.closest("[data-rv-sel]");
      if (cb) { const id = +cb.dataset.rvSel; cb.checked ? RV.sel.add(id) : RV.sel.delete(id); rvRender(); }
    });
    root.addEventListener("input", (e) => { const n = e.target.closest("[data-rv-note]"); if (n) RV.notes[n.dataset.rvNote] = n.value; });
  }
  window.loadTenantReview = async function () { ensureReviewView(); rvRender(); await rvLoad(); rvRender(); };

  // ── tenant profile: History ───────────────────────────────────────────────────
  const baseOpen = window.openTenant;
  if (typeof baseOpen === "function") {
    window.openTenant = function (key) {
      const r = baseOpen.apply(this, arguments);
      try { historyFor(key); } catch (e) { console.warn("[tenant-db] history", e); }
      return r;
    };
  }
  async function historyFor(key) {
    const t = typeof key === "object" && key ? key : tnFind(key);
    const panel = document.querySelector(".tn-panel");
    const c = sb();
    if (!t || !panel || !c || !t.id) return;
    const sec = document.createElement("div");
    sec.className = "panel-section";
    sec.innerHTML = `<div class="panel-section-title"><span><em>History</em></span><span class="ct">loading…</span></div><div class="td-hist-body"></div>`;
    panel.appendChild(sec);
    const { data, error } = await c.from("tenant_changes").select("id,op,changed,before,after,actor_kind,actor_name,via,reason,review_status,reviewed_by_name,created_at").eq("tenant_id", t.id).order("created_at", { ascending: false }).limit(40);
    const ct = sec.querySelector(".ct");
    if (error) { ct.textContent = /does not exist|schema cache/i.test(error.message) ? "not set up yet" : "couldn't load"; return; }
    ct.textContent = data.length ? String(data.length) : "";
    sec.querySelector(".td-hist-body").innerHTML = data.length ? data.map((h) => `<div class="td-hrow"><b>${esc(who(h))}</b> <span class="hb-sub">${esc(tnFmt(String(h.created_at).slice(0, 10)))}${h.via ? " · " + esc(h.via) : ""}</span>
        ${h.review_status === "pending" ? `<span class="td-tag warn">to check</span>` : h.review_status === "verified" ? `<span class="td-tag ok">verified${h.reviewed_by_name ? " by " + esc(h.reviewed_by_name) : ""}</span>` : h.review_status === "correction" ? `<span class="td-tag warn">correction requested</span>` : h.review_status === "flagged" ? `<span class="td-tag bad">flagged</span>` : ""}
        <div>${changeLines(h).map((l) => l.from === null ? esc(l.label + (l.to ? ": " + l.to : "")) : `${esc(l.label)}: <s>${esc(l.from)}</s> → ${esc(l.to)}`).join("<br>")}</div></div>`).join("")
      : `<div class="hb-sub">No changes recorded since the history started (Nov 2026).</div>`;
  }

  // Boot: badge now, then every 5 minutes; refresh the open review page on realtime changes.
  setTimeout(badgeTick, 4000);
  setInterval(badgeTick, 5 * 60000);
  ensureShell();
})();
