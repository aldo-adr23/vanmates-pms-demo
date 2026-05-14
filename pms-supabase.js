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

  // Use the default storageKey so we share the auth session with signin.html
  // (which also uses the default key). The previous override pointed at the
  // Supabase dashboard's own session key, which is wrong for end-user portals.
  const sb = window.supabase.createClient(
    window.VM_SUPABASE_URL,
    window.VM_SUPABASE_KEY,
    {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true
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
        // Exclude soft-deleted rows. Admins can still read them via RLS, but
        // they belong in the Trash (listDeleted), not the main lists.
        const { data, error } = await sb.from(cfg.table).select('data, id').is('deleted_at', null);
        if (error) { summary.errors.push({ name, error: error.message }); continue; }
        const arr = targets[name];
        if (!arr || !Array.isArray(arr)) {
          summary.errors.push({ name, error:'local array not found on window' });
          continue;
        }
        // Defensive: never blank a populated local array with empty Postgres
        // results. RLS denials and auth/network failures show up as `data=[]`
        // here, and overwriting in that case would wipe the seed data the UI
        // relies on. Only replace contents when Postgres returns at least
        // ~10% of the local array's rows (or local is also empty).
        const incoming = (data || []).length;
        const local = arr.length;
        if (incoming === 0 && local > 0) {
          summary.errors.push({ name, error:`got 0 rows but local has ${local} — keeping local (likely RLS/auth)` });
          summary.counts[name] = local;
          continue;
        }
        if (local > 0 && incoming < Math.max(1, Math.floor(local * 0.1))) {
          summary.errors.push({ name, error:`got only ${incoming} of ${local} expected — keeping local` });
          summary.counts[name] = local;
          continue;
        }
        // Safe to replace — Postgres returned a plausible row count.
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

  // Soft delete: set deleted_at instead of removing the row. The RLS SELECT
  // policy filters out deleted_at IS NOT NULL by default, so the row
  // disappears from hydrate() without any data loss. Admins can restore via
  // vmDb.restore(arrayName, id) below.
  async function deleteRow(arrayName, idOrKey) {
    const cfg = TABLES[arrayName];
    if (!cfg) return false;
    const id = String(idOrKey);
    const { error } = await sb.from(cfg.table)
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);
    if (error) {
      console.error(`[vmDb] soft-delete ${cfg.table}/${id} failed:`, error.message);
      toast(`Sync failed: ${cfg.table} — ${error.message}`, 'error');
      return false;
    }
    return true;
  }

  // Admin-only: bring a soft-deleted row back. RLS only lets admins SELECT
  // soft-deleted rows in the first place, so this is naturally scoped.
  async function restoreRow(arrayName, idOrKey) {
    const cfg = TABLES[arrayName];
    if (!cfg) return false;
    const id = String(idOrKey);
    const { error } = await sb.from(cfg.table)
      .update({ deleted_at: null })
      .eq('id', id);
    if (error) {
      console.error(`[vmDb] restore ${cfg.table}/${id} failed:`, error.message);
      toast(`Restore failed: ${cfg.table} — ${error.message}`, 'error');
      return false;
    }
    return true;
  }

  // Admin-only: list all soft-deleted rows for a table. Used by the Restore
  // panel in Settings → Trash.
  async function listDeleted(arrayName) {
    const cfg = TABLES[arrayName];
    if (!cfg) return [];
    const { data, error } = await sb.from(cfg.table)
      .select('id, data, deleted_at, updated_by')
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false });
    if (error) {
      console.warn(`[vmDb] listDeleted ${cfg.table} failed:`, error.message);
      return [];
    }
    return (data || []).map(row => ({ ...row.data, _id: row.id, _deletedAt: row.deleted_at, _updatedBy: row.updated_by }));
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

  /* ------------------- Storage helpers (Phase 2.4d) ------------------- */
  // Upload a File (from <input type="file">) to the lease-docs bucket.
  // Returns { path, name, size, type } on success, null on failure.
  // The path is what you store in the JSONB data column; use fileUrl(path)
  // later to get a signed download URL.
  async function uploadFile(file, folder = 'misc') {
    if (!file) return null;
    const ts = Date.now();
    const safe = String(file.name || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const path = `${folder}/${ts}-${safe}`;
    const { data, error } = await sb.storage.from('lease-docs').upload(path, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type || 'application/octet-stream',
    });
    if (error) {
      console.error('[vmDb] upload failed:', error.message);
      toast(`Upload failed: ${error.message}`, 'error');
      return null;
    }
    return { path: data.path, name: file.name, size: file.size, type: file.type };
  }

  // Get a temporary signed URL for downloading a file. Default TTL: 1 hour.
  async function fileUrl(path, expiresIn = 3600) {
    if (!path) return null;
    const { data, error } = await sb.storage.from('lease-docs').createSignedUrl(path, expiresIn);
    if (error) {
      console.warn('[vmDb] signed URL failed:', error.message);
      return null;
    }
    return data.signedUrl;
  }

  // Delete a file from the bucket (admin-gated by RLS).
  async function deleteFile(path) {
    if (!path) return false;
    const { error } = await sb.storage.from('lease-docs').remove([path]);
    if (error) {
      console.warn('[vmDb] file delete failed:', error.message);
      return false;
    }
    return true;
  }

  /* ------------------- Realtime (Phase 2.4f) ------------------- */
  // Subscribe to Postgres changes on all 8 ops tables. When another teammate
  // (or this same user from another tab) makes a change, the handler updates
  // the local array in place and triggers a debounced re-render.

  let _rerenderTimer = null;
  function scheduleRerender(){
    if (_rerenderTimer) return;
    _rerenderTimer = setTimeout(() => {
      _rerenderTimer = null;
      const fns = ['renderTenants','renderPropertiesGrid','renderLandlords','renderVacancies',
                   'renderHomestayClients','renderHomestayFinance','renderHomestayHosts',
                   'renderDeposits','updateSidebarCounts'];
      for (const fn of fns) {
        try { if (typeof window[fn] === 'function') window[fn](); }
        catch (e) { console.warn('[vmDb] rerender ' + fn + ' failed:', e.message); }
      }
    }, 250); // debounce so a burst of events triggers one render
  }

  function applyRealtimeEvent(arrayName, payload){
    const arr = window[arrayName];
    if (!arr || !Array.isArray(arr)) return;
    const cfg = TABLES[arrayName];
    const event = payload.eventType;
    const newRow = payload.new || {};
    const oldRow = payload.old || {};
    const id = newRow.id || oldRow.id;
    if (!id) return;
    const findIdx = () => arr.findIndex(x => recordId(arrayName, x) === id);

    if (event === 'INSERT') {
      if (findIdx() < 0) arr.push(newRow.data || newRow);
    } else if (event === 'UPDATE') {
      const idx = findIdx();
      if (newRow.deleted_at) {
        // soft-delete: remove from local view
        if (idx >= 0) arr.splice(idx, 1);
      } else {
        const fresh = newRow.data || newRow;
        if (idx >= 0) arr[idx] = fresh;
        else arr.push(fresh);
      }
    } else if (event === 'DELETE') {
      const idx = findIdx();
      if (idx >= 0) arr.splice(idx, 1);
    }
    scheduleRerender();
  }

  function subscribeRealtime(){
    if (window.__VM_RT_CH) return window.__VM_RT_CH;  // already subscribed
    const ch = sb.channel('vmDb-changes');
    for (const [arrayName, cfg] of Object.entries(TABLES)) {
      ch.on('postgres_changes',
        { event: '*', schema: 'public', table: cfg.table },
        (payload) => applyRealtimeEvent(arrayName, payload)
      );
    }
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('[vmDb] realtime channel SUBSCRIBED on 8 tables');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        console.warn('[vmDb] realtime status:', status);
      }
    });
    window.__VM_RT_CH = ch;
    return ch;
  }

  // Auto-subscribe shortly after page boot (after hydrate has populated arrays)
  if (typeof window !== 'undefined') {
    setTimeout(() => { try { subscribeRealtime(); } catch (e) { console.warn('[vmDb] subscribe failed:', e.message); } }, 1500);
  }

  /* ------------------- expose ------------------- */
  window.vmDb = { hydrate, upsert, delete: deleteRow, restore: restoreRow, listDeleted,
                   uploadFile, fileUrl, deleteFile, subscribeRealtime, toast, sb };
  console.log('[vmDb] persistence layer ready (Phase 2.4f: soft delete + audit + storage + realtime)');
})();
