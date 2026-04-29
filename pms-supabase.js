/* ============================================================================
 * Vanmates PMS · Supabase persistence layer  (Phase 2.2)
 * ----------------------------------------------------------------------------
 * Loaded after supabase-js + supabase-config.js. Exposes window.vmDb with:
 *   await vmDb.hydrate()                  → fetch all 8 tables, replace local
 *                                            arrays in place, return summary
 *   vmDb.upsert(arrayName, record)        → persist a record (background)
 *   vmDb.delete(arrayName, idOrKey)       → delete by primary key (background)
 *   vmDb.toast(msg, kind)                 → tiny inline toast for sync events
 *
 * The PMS calls hydrate() once at boot and then re-runs all render fns. After
 * that, mutation sites (tenants.push, splice, etc.) are followed by a
 * vmDb.upsert/delete call so changes propagate to Postgres in the background.
 *
 * RLS: any signed-in teammate can SELECT; only admins (role='admin' in
 * team_members) can INSERT/UPDATE/DELETE. The supabase JS client picks up the
 * auth token automatically via the same localStorage key set by signin.html.
 * ========================================================================== */
(function(){
  'use strict';

  if (typeof window.supabase === 'undefined' || !window.VM_SUPABASE_URL) {
    console.warn('[vmDb] supabase-js or config missing — running in legacy mode (no persistence)');
    window.vmDb = {
      hydrate: async () => ({ ok:false, reason:'no-supabase' }),
      upsert:  () => false,
      delete:  () => false,
      toast:   () => {}
    };
    return;
  }

  const sb = window.supabase.createClient(
    window.VM_SUPABASE_URL,
    window.VM_SUPABASE_KEY,
    {
      auth: {
        storageKey: 'supabase.dashboard.auth.token',
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false
      }
    }
  );

  /* ------------------- table mapping ------------------- */
  // arrayName (in vanmates-pms.html) → { table: postgres table, key: pk source field }
  const TABLES = {
    properties:        { table: 'properties',         key: 'name' },
    tenants:           { table: 'tenants',            key: 'email' },   // fallback to a t-N id
    landlords:         { table: 'landlords',          key: 'id' },
    homestayHosts:     { table: 'homestay_hosts',     key: 'id' },
    homestayClients:   { table: 'homestay_clients',   key: 'id' },
    vacancies:         { table: 'vacancies',          key: 'id' },
    damageDeposits:    { table: 'damage_deposits',    key: 'id' },
    homestayApplicants:{ table: 'homestay_applicants',key: 'id' }
  };

  // Scalar columns mirrored on each table. Camel-case JS field → snake-case Postgres column.
  const SCALARS = {
    properties:        [['name','name'],['city','city'],['type','type'],['rooms','rooms'],['occ','occ']],
    tenants:           [['name','name'],['email','email'],['property','property'],['city','city'],['status','status'],['rent','rent']],
    landlords:         [['name','name'],['email','email'],['phone','phone'],['city','city']],
    homestayHosts:     [['name','name'],['email','email'],['phone','phone'],['city','city'],['capacity','capacity']],
    homestayClients:   [['name','name'],['email','email'],['hostId','host_id'],['status','status']],
    vacancies:         [['room','room'],['prop','prop'],['city','city'],['rent','rent'],['availDate','avail_date'],['listed','listed']],
    damageDeposits:    [['status','status']],
    homestayApplicants:[['name','name'],['city','city']]
  };

  /* ------------------- helpers ------------------- */
  function recordId(arrayName, record, fallbackIdx) {
    const cfg = TABLES[arrayName];
    const v = record[cfg.key];
    if (v) return String(v);
    if (record.id) return String(record.id);
    if (record.email) return String(record.email);
    if (record.name) return String(record.name);
    return `${arrayName}-${fallbackIdx ?? Date.now()}`;
  }

  function buildRow(arrayName, record, idx) {
    const id = recordId(arrayName, record, idx);
    const row = { id, data: record };
    for (const [jsKey, pgCol] of (SCALARS[arrayName] || [])) {
      const val = record[jsKey];
      if (val !== undefined) row[pgCol] = val;
    }
    return row;
  }

  /* ------------------- hydrate ------------------- */
  async function hydrate() {
    const summary = { ok: true, counts: {}, errors: [] };
    const targets = {
      properties:         window.properties,
      tenants:            window.tenants,
      landlords:          window.landlords,
      homestayHosts:      window.homestayHosts,
      homestayClients:    window.homestayClients,
      vacancies:          window.vacancies,
      damageDeposits:     window.damageDeposits,
      homestayApplicants: window.homestayApplicants
    };

    for (const [name, cfg] of Object.entries(TABLES)) {
      try {
        const { data, error } = await sb.from(cfg.table).select('data, id');
        if (error) { summary.errors.push({ name, error: error.message }); continue; }
        const arr = targets[name];
        if (!arr || !Array.isArray(arr)) {
          summary.errors.push({ name, error:'local array not found on window' });
          continue;
        }
        // Replace contents in place — keeps the const reference intact.
        arr.length = 0;
        for (const row of data) arr.push(row.data || row);
        summary.counts[name] = arr.length;
      } catch (e) {
        summary.errors.push({ name, error: e.message });
      }
    }
    if (summary.errors.length) summary.ok = false;
    return summary;
  }

  /* ------------------- upsert / delete (background, fire-and-forget) ------------------- */
  async function upsert(arrayName, record) {
    const cfg = TABLES[arrayName];
    if (!cfg) { console.warn('[vmDb] unknown array:', arrayName); return false; }
    const row = buildRow(arrayName, record);
    const { error } = await sb.from(cfg.table).upsert(row);
    if (error) {
      console.error(`[vmDb] upsert ${cfg.table}/${row.id} failed:`, error.message);
      toast(`Sync failed: ${cfg.table} — ${error.message}`, 'error');
      return false;
    }
    return true;
  }

  async function deleteRow(arrayName, idOrKey) {
    const cfg = TABLES[arrayName];
    if (!cfg) return false;
    const id = String(idOrKey);
    const { error } = await sb.from(cfg.table).delete().eq('id', id);
    if (error) {
      console.error(`[vmDb] delete ${cfg.table}/${id} failed:`, error.message);
      toast(`Sync failed: ${cfg.table} — ${error.message}`, 'error');
      return false;
    }
    return true;
  }

  /* ------------------- minimal toast (uses existing showToast if available) ------------------- */
  function toast(msg, kind) {
    if (typeof window.showToast === 'function') {
      window.showToast(msg);
      return;
    }
    // Lightweight fallback — appears top-right, auto-dismisses
    let el = document.getElementById('vmdb-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'vmdb-toast';
      el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:99999;'
        + 'background:#2B211A;color:#FAF5ED;padding:10px 14px;border-radius:8px;'
        + 'font:500 13px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.18);'
        + 'max-width:380px;transition:opacity .3s ease';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.background = kind === 'error' ? '#A13A30' : '#2B211A';
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 4000);
  }

  /* ------------------- expose ------------------- */
  window.vmDb = { hydrate, upsert, delete: deleteRow, toast, sb };
  console.log('[vmDb] persistence layer ready');
})();
