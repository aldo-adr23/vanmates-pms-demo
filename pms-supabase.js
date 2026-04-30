/* ============================================================================
 * Vanmates PMS · Supabase persistence layer  (Phase 2.4)
 * ----------------------------------------------------------------------------
 * Loaded after supabase-js + supabase-config.js. Exposes window.vmDb with:
 *   await vmDb.hydrate()                  → fetch all 8 tables, replace local
 *                                            arrays in place, return summary
 *   vmDb.upsert(arrayName, record)        → persist a record (background)
 *   vmDb.delete(arrayName, idOrKey)       → soft delete (sets deleted_at)
 *   vmDb.restore(arrayName, idOrKey)      → bring a soft-deleted row back
 *   vmDb.listDeleted(arrayName)           → admin: list trash
 *   vmDb.toast(msg, kind)                 → tiny inline toast for sync events
 *
 * RLS: any signed-in teammate can SELECT live rows; only admins can write or
 * see soft-deleted rows. The supabase JS client picks up the auth token
 * automatically via the same localStorage key set by signin.html.
 * ========================================================================== */
(function(){
  'use strict';
  if (typeof window.supabase === 'undefined' || !window.VM_SUPABASE_URL) {
    console.warn('[vmDb] supabase-js or config missing — running in legacy mode');
    window.vmDb = { hydrate: async () => ({ ok:false }), upsert:()=>false, delete:()=>false, restore:()=>false, listDeleted:async()=>[], toast:()=>{} };
    return;
  }
  const sb = window.supabase.createClient(window.VM_SUPABASE_URL, window.VM_SUPABASE_KEY, { auth:{ autoRefreshToken:true, persistSession:true, detectSessionInUrl:true } });
  const TABLES = {
    properties:{table:'properties',key:'name'}, tenants:{table:'tenants',key:'email'}, landlords:{table:'landlords',key:'id'},
    homestayHosts:{table:'homestay_hosts',key:'id'}, homestayClients:{table:'homestay_clients',key:'id'},
    vacancies:{table:'vacancies',key:'id'}, damageDeposits:{table:'damage_deposits',key:'id'}, homestayApplicants:{table:'homestay_applicants',key:'id'}
  };
  const SCALARS = {
    properties:[['name','name'],['city','city'],['type','type'],['rooms','rooms'],['occ','occ']],
    tenants:[['name','name'],['email','email'],['property','property'],['city','city'],['status','status'],['rent','rent']],
    landlords:[['name','name'],['email','email'],['phone','phone'],['city','city']],
    homestayHosts:[['name','name'],['email','email'],['phone','phone'],['city','city'],['capacity','capacity']],
    homestayClients:[['name','name'],['email','email'],['hostId','host_id'],['status','status']],
    vacancies:[['room','room'],['prop','prop'],['city','city'],['rent','rent'],['availDate','avail_date'],['listed','listed']],
    damageDeposits:[['status','status']], homestayApplicants:[['name','name'],['city','city']]
  };
  function recordId(an, r, idx){ const c=TABLES[an]; const v=r[c.key]; if(v) return String(v); if(r.id) return String(r.id); if(r.email) return String(r.email); if(r.name) return String(r.name); return `${an}-${idx??Date.now()}`; }
  function buildRow(an, r, idx){ const id=recordId(an,r,idx); const row={id, data:r}; for (const [j,p] of (SCALARS[an]||[])) { const v=r[j]; if(v!==undefined) row[p]=v; } return row; }
  async function hydrate(){ const summary={ok:true,counts:{},errors:[]}; const targets={properties:window.properties,tenants:window.tenants,landlords:window.landlords,homestayHosts:window.homestayHosts,homestayClients:window.homestayClients,vacancies:window.vacancies,damageDeposits:window.damageDeposits,homestayApplicants:window.homestayApplicants};
    for (const [name,cfg] of Object.entries(TABLES)) { try { const {data,error}=await sb.from(cfg.table).select('data, id'); if(error){summary.errors.push({name,error:error.message});continue;} const arr=targets[name]; if(!arr||!Array.isArray(arr)){summary.errors.push({name,error:'local array not found'});continue;}
        const incoming=(data||[]).length; const local=arr.length;
        if (incoming===0 && local>0) { summary.errors.push({name,error:`got 0 rows but local has ${local} — keeping local`}); summary.counts[name]=local; continue; }
        if (local>0 && incoming<Math.max(1, Math.floor(local*0.1))) { summary.errors.push({name,error:`got only ${incoming} of ${local} — keeping local`}); summary.counts[name]=local; continue; }
        arr.length=0; for (const row of data) arr.push(row.data || row); summary.counts[name]=arr.length;
      } catch(e) { summary.errors.push({name,error:e.message}); } }
    if (summary.errors.length) summary.ok=false; return summary;
  }
  async function upsert(an, r){ const cfg=TABLES[an]; if(!cfg) return false; const row=buildRow(an,r); const {error}=await sb.from(cfg.table).upsert(row); if(error){console.error(`[vmDb] upsert ${cfg.table}/${row.id} failed:`,error.message); toast(`Sync failed: ${cfg.table} — ${error.message}`,'error'); return false;} return true; }
  async function deleteRow(an, idOrKey){ const cfg=TABLES[an]; if(!cfg) return false; const id=String(idOrKey); const {error}=await sb.from(cfg.table).update({deleted_at:new Date().toISOString()}).eq('id',id); if(error){console.error(`[vmDb] soft-delete ${cfg.table}/${id} failed:`,error.message); toast(`Sync failed: ${cfg.table} — ${error.message}`,'error'); return false;} return true; }
  async function restoreRow(an, idOrKey){ const cfg=TABLES[an]; if(!cfg) return false; const id=String(idOrKey); const {error}=await sb.from(cfg.table).update({deleted_at:null}).eq('id',id); if(error){toast(`Restore failed: ${error.message}`,'error'); return false;} return true; }
  async function listDeleted(an){ const cfg=TABLES[an]; if(!cfg) return []; const {data,error}=await sb.from(cfg.table).select('id, data, deleted_at, updated_by').not('deleted_at','is',null).order('deleted_at',{ascending:false}); if(error){console.warn(error.message); return [];} return (data||[]).map(r=>({...r.data,_id:r.id,_deletedAt:r.deleted_at,_updatedBy:r.updated_by})); }
  function toast(msg, kind){ if (typeof window.showToast==='function'){window.showToast(msg);return;} let el=document.getElementById('vmdb-toast'); if(!el){el=document.createElement('div');el.id='vmdb-toast';el.style.cssText='position:fixed;top:16px;right:16px;z-index:99999;background:#2B211A;color:#FAF5ED;padding:10px 14px;border-radius:8px;font:500 13px/1.4 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.18);max-width:380px;transition:opacity .3s ease';document.body.appendChild(el);} el.textContent=msg; el.style.background=kind==='error'?'#A13A30':'#2B211A'; el.style.opacity='1'; clearTimeout(el._t); el._t=setTimeout(()=>{el.style.opacity='0';},4000); }
  window.vmDb = { hydrate, upsert, delete: deleteRow, restore: restoreRow, listDeleted, toast, sb };
  console.log('[vmDb] persistence layer ready (Phase 2.4: soft delete + audit)');
})();
