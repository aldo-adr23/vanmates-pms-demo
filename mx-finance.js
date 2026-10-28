/* Mexico AR + AP (portal, Mexico view only: nav "AR" / "AP" → views mxar / mxap). Spanish, MXN.
   Mexico has no QuickBooks: the portal is the ledger (mx-finance-2026-10-28.sql).
   AR  = mx_rent_charges: one rent line per Guadalajara tenant per month (due the 5th), payments recorded here.
   AP  = mx_ap_items: landlord rent (mx_ap_landlords set-ups), bills typed in here, and deposit refunds mirrored from
         the MX check-out cases (those are still approved and sent in Salidas).
   Reads through RLS (admins + teammates with Mexico and the mxar / mxap page — Denisse); writes only through the mx_* RPCs.
   Loaded by index.html after the main script (uses esc, showToast, CURRENT_USER, window.tenants, window.properties,
   window.vmDb.sb, openTenant and the shared detail panel). */
(function(){
  const METHOD = { spei: 'SPEI', cash: 'Efectivo', transfer: 'Transferencia', card: 'Tarjeta', other: 'Otro' };
  const AR_KIND = { rent: 'Renta', late_fee: 'Interés moratorio', other: 'Otro cargo' };
  const AR_STATUS = { open: ['Pendiente', 'blue'], late: ['Vencido', 'red'], partial: ['Pago parcial', 'blue'], paid: ['Pagado', ''], waived: ['Condonado', ''] };
  const AR_VIEWS = [['open', 'Pendientes'], ['late', 'Vencidos'], ['paid', 'Pagados'], ['waived', 'Condonados'], ['all', 'Todos']];
  const AP_TYPE = { landlord_rent: 'Renta a propietario', utility: 'Servicios (luz, agua, gas)', internet: 'Internet', cleaning: 'Limpieza', repair: 'Reparación', refund: 'Reembolso de depósito', other: 'Otro' };
  const AP_TABS = [['all', 'Todo'], ['landlord_rent', 'Propietarios'], ['services', 'Servicios'], ['cleaning', 'Limpieza'], ['repair', 'Reparaciones'], ['refund', 'Reembolsos'], ['other', 'Otros'], ['setups', 'Contratos con propietarios']];
  const AP_STATUS = { waiting: ['En espera', ''], to_pay: ['Por pagar', 'blue'], late: ['Vencido', 'red'], paid: ['Pagado', ''], skipped: ['Omitido', ''] };
  const AP_VIEWS = [['to_pay', 'Por pagar'], ['waiting', 'En espera (reembolsos)'], ['paid', 'Pagados'], ['skipped', 'Omitidos'], ['all', 'Todos']];
  const ERR = {
    'mx:forbidden': 'No tienes acceso a las finanzas de México.', 'mx:invalid:cents': 'Escribe el monto así: 8500.00', 'mx:invalid:amount_cents': 'Escribe el monto así: 8500.00',
    'mx:invalid:method': 'Elige la forma de pago.', 'mx:invalid:waived': 'Este cargo está condonado: reábrelo primero.', 'mx:invalid:has_payments': 'Tiene pagos: deshazlos antes de eliminar.',
    'mx:duplicate:rent_line': 'Ese inquilino ya tiene su renta de ese mes.', 'mx:invalid:tenant': 'Elige un inquilino de México.', 'mx:invalid:refund_follows_checkout': 'Los reembolsos se aprueban y se pagan en Salidas.',
    'mx:invalid:already_paid': 'Ya está pagado.', 'mx:invalid:only_typed_bills': 'Solo se pueden eliminar facturas capturadas a mano.', 'mx:invalid:pay_day': 'El día de pago va del 1 al 28.',
    'mx:invalid:landlord': 'Falta el nombre del propietario.', 'mx:invalid:property': 'Falta la propiedad.', 'mx:invalid:payee': 'Falta a quién se le paga.', 'mx:invalid:period_too_far': 'Solo hasta el mes que entra.',
  };

  // ── pure helpers (window.MXF_CORE, tested in test/mx-finance.test.js) ──
  const DAY = 86400000;
  const money = (cents) => (cents == null || !isFinite(Number(cents)) ? '—' : (Number(cents) < 0 ? '−' : '') + 'MX$' + (Math.abs(Number(cents)) / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  // "8,500", "$8500.5", "MX$ 1 200" -> cents, or null.
  function parseAmount(s){
    const t = String(s == null ? '' : s).replace(/MX\$|[$,\s]/gi, '');
    if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
    return Math.round(Number(t) * 100);
  }
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const monthLabel = (ym) => { const m = /^(\d{4})-(\d{2})/.exec(String(ym || '')); return m ? `${MESES[Number(m[2]) - 1]} ${m[1]}` : '—'; };
  const shiftMonth = (ym, n) => { const [y, m] = String(ym).slice(0, 7).split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
  const daysLate = (due, today) => (due ? Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(String(due).slice(0, 10) + 'T00:00:00Z')) / DAY) : 0);
  const balance = (r) => Math.max(0, Number(r.amount_cents || 0) - Number(r.paid_cents || 0));
  // What the AR row shows: paid / waived as stored; an open line is late after its due date, partial when something came in.
  function arState(r, today){
    if (r.status === 'paid' || r.status === 'waived') return r.status;
    if (daysLate(r.due_date, today) > 0) return 'late';
    return Number(r.paid_cents || 0) > 0 ? 'partial' : 'open';
  }
  function arInView(r, view, today){
    const s = arState(r, today);
    if (view === 'all') return true;
    if (view === 'open') return ['open', 'partial', 'late'].includes(s);
    return s === view;
  }
  // Header cards for one month: billed, collected, still owed; plus everything late (any month).
  function arSummary(rows, ym, today){
    const live = rows.filter(r => !r.deleted_at);
    const inMonth = live.filter(r => String(r.period).slice(0, 7) === ym && r.status !== 'waived');
    const billed = inMonth.reduce((s, r) => s + Number(r.amount_cents || 0), 0);
    const collected = inMonth.reduce((s, r) => s + Math.min(Number(r.paid_cents || 0), Number(r.amount_cents || 0)), 0);
    const late = live.filter(r => arState(r, today) === 'late');
    return { billedCents: billed, collectedCents: collected, owedCents: billed - collected, pct: billed ? Math.round(100 * collected / billed) : null,
      lines: inMonth.length, lateCount: late.length, lateCents: late.reduce((s, r) => s + balance(r), 0), lateTenants: new Set(late.map(r => r.tenant_id)).size };
  }
  const apState = (r, today) => (r.status === 'to_pay' && r.due_date && daysLate(r.due_date, today) > 0 ? 'late' : r.status);
  const apInTab = (r, tab) => tab === 'all' || (tab === 'services' ? ['utility', 'internet'].includes(r.type) : r.type === tab);
  const apInView = (r, view) => view === 'all' || r.status === view;
  function apSummary(rows, ym, today){
    const live = rows.filter(r => !r.deleted_at);
    const toPay = live.filter(r => r.status === 'to_pay');
    const late = toPay.filter(r => apState(r, today) === 'late');
    const paid = live.filter(r => r.status === 'paid' && String(r.paid_on || '').slice(0, 7) === ym);
    const sum = (l) => l.reduce((s, r) => s + Number(r.amount_cents || 0), 0);
    return { toPay: toPay.length, toPayCents: sum(toPay), late: late.length, lateCents: sum(late), paid: paid.length, paidCents: sum(paid), waiting: live.filter(r => r.status === 'waiting').length };
  }
  const sortByDue = (list, key) => list.slice().sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')) || String(a[key] || '').localeCompare(String(b[key] || ''), 'es'));
  // Search ignores case and accents ("lopez" finds López).
  const fold = (v) => String(v == null ? '' : v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const matches = (q, ...vals) => { const t = fold(q).trim(); return !t || vals.some(v => fold(v).includes(t)); };
  function errText(err){
    const m = String((err && err.message) || err || '');
    const k = Object.keys(ERR).find(x => m.includes(x));
    return k ? ERR[k] : m;
  }
  function csv(rows){
    const q = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return rows.map(r => r.map(q).join(',')).join('\n');
  }
  window.MXF_CORE = { money, parseAmount, monthLabel, shiftMonth, daysLate, balance, arState, arInView, arSummary, apState, apInTab, apInView, apSummary, sortByDue, matches, errText, csv };
  if (typeof document === 'undefined') return;

  // ── page ──
  const e = (s) => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const toast = (m) => { if (typeof showToast === 'function') showToast(m); };
  const sb = () => window.vmDb && window.vmDb.sb;
  const $ = (id) => document.getElementById(id);
  const today = () => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date()); } catch (_) { return new Date().toISOString().slice(0, 10); } };
  const chip = ([l, c]) => `<span class="tag-pill ${c}" style="font-size:11px">${e(l)}</span>`;
  const H = (t) => `<h4 style="margin:22px 0 6px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)">${e(t)}</h4>`;
  const field = (l, v) => v ? `<div style="display:flex;gap:10px"><span class="name-sub" style="min-width:120px">${e(l)}</span><span>${v}</span></div>` : '';
  const fecha = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? `${Number(m[3])} ${MESES[Number(m[2]) - 1].slice(0, 3)} ${m[1]}` : '—'; };
  const pesos = (cents) => cents == null ? '' : (Number(cents) / 100).toFixed(2);
  const card = (label, value, sub, attrs) => `<div class="card" style="padding:14px 16px${attrs ? ';cursor:pointer' : ''}" ${attrs || ''}><div class="name-sub">${e(label)}</div><div style="font-size:22px;font-weight:600;margin-top:4px">${value}</div><div class="name-sub">${sub || ''}</div></div>`;
  const methodOptions = (sel) => Object.entries(METHOD).map(([k, l]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${e(l)}</option>`).join('');
  const propOptions = () => (window.properties || []).map(p => p && p.name).filter(Boolean).sort((a, b) => a.localeCompare(b, 'es')).map(n => `<option value="${e(n)}">`).join('');

  function openPanel(hero, title, sub, meta){
    $('panel-hero').textContent = String(hero || '?').slice(0, 1).toUpperCase();
    $('panel-title').innerHTML = e(title);
    $('panel-sub').textContent = sub;
    $('panel-meta').innerHTML = meta || '';
    $('detail-panel').classList.add('open');
    $('detail-panel').setAttribute('aria-hidden', 'false');
    $('panel-backdrop').classList.add('open');
  }
  const closePanel = () => { const b = $('panel-close'); if (b) b.click(); };

  // ═════════════ AR ═════════════
  const AR = { ym: today().slice(0, 7), view: 'open', q: '', rows: null, loading: null };
  async function arLoad(force){
    if (AR.loading && !force) return AR.loading;
    if (!sb()) return;
    AR.loading = (async () => {
      try {
        // This month's rent lines are created on first open (idempotent).
        const g = await sb().rpc('mx_ar_generate', { p_period: today().slice(0, 7) + '-01' });
        if (g.error) throw g.error;
        const r = await sb().from('mx_rent_charges').select('*').is('deleted_at', null).order('period', { ascending: false }).limit(5000);
        if (r.error) throw r.error;
        AR.rows = r.data || [];
      } catch (err) { AR.rows = AR.rows || []; toast('AR México: ' + errText(err)); }
      finally { AR.loading = null; }
      arRender();
    })();
    return AR.loading;
  }
  function arFiltered(){
    const t = today();
    return (AR.rows || []).filter(r => (AR.view === 'late' || String(r.period).slice(0, 7) === AR.ym) && arInView(r, AR.view, t)
      && matches(AR.q, r.tenant_name, r.property, r.room, r.notes));
  }
  function arRender(){
    if (!$('mxar-body')) return;
    const t = today(), s = arSummary(AR.rows || [], AR.ym, t);
    $('mxar-month').textContent = monthLabel(AR.ym);
    $('mxar-cards').innerHTML = card('Facturado en ' + monthLabel(AR.ym), money(s.billedCents), `${s.lines} cargo(s)`)
      + card('Cobrado', money(s.collectedCents), s.pct == null ? '' : `${s.pct}% del mes`)
      + card('Falta cobrar', money(s.owedCents), 'de este mes')
      + card('Vencido (todos los meses)', money(s.lateCents), `${s.lateTenants} inquilino(s) · desde el día 6 aplica 5% mensual`, 'data-mxar-view="late"');
    $('mxar-view').value = AR.view;
    const list = sortByDue(arFiltered(), 'tenant_name');
    $('mxar-count').textContent = String(list.length);
    $('mxar-total').textContent = money(list.reduce((x, r) => x + balance(r), 0)) + ' de saldo';
    const none = (AR.rows || []).every(r => String(r.period).slice(0, 7) !== AR.ym);
    const canMake = AR.ym <= shiftMonth(t.slice(0, 7), 1);
    $('mxar-make').style.display = none && canMake ? '' : 'none';
    $('mxar-make').textContent = 'Crear cargos de ' + monthLabel(AR.ym);
    $('mxar-body').innerHTML = list.map(r => {
      const st = arState(r, t), late = st === 'late' ? daysLate(r.due_date, t) : 0;
      return `<tr data-mxar-open="${e(r.id)}" tabindex="0" style="cursor:pointer">
        <td><b>${e(r.tenant_name || '—')}</b><div class="name-sub">${e([r.property, r.room && 'Hab. ' + r.room].filter(Boolean).join(' · '))}</div></td>
        <td>${e(AR_KIND[r.kind] || r.kind)}<div class="name-sub">${e(monthLabel(r.period))}</div></td>
        <td>${e(fecha(r.due_date))}${late ? `<div class="name-sub" style="color:var(--red,#b94a3f)">${late} día(s) tarde</div>` : ''}</td>
        <td style="text-align:right">${e(money(r.amount_cents))}</td>
        <td style="text-align:right">${Number(r.paid_cents) ? e(money(r.paid_cents)) : '—'}</td>
        <td style="text-align:right"><b>${e(money(r.status === 'waived' ? 0 : balance(r)))}</b></td>
        <td>${chip(AR_STATUS[st] || [st, ''])}</td></tr>`;
    }).join('');
    $('mxar-empty').style.display = list.length ? 'none' : '';
    $('mxar-empty').textContent = none ? 'Aún no hay cargos para ' + monthLabel(AR.ym) + '.' : 'Nada coincide con estos filtros.';
  }
  async function arRpc(fn, args, done){
    try { const r = await sb().rpc(fn, args); if (r.error) throw r.error; if (done) toast(done); await arLoad(true); return r.data || true; }
    catch (err) { toast(errText(err)); return null; }
  }
  function arOpen(id){
    const r = (AR.rows || []).find(x => x.id === id);
    if (!r) return;
    const t = today(), st = arState(r, t), bal = balance(r);
    openPanel(r.tenant_name, r.tenant_name || 'Cargo', `${AR_KIND[r.kind] || r.kind} · ${monthLabel(r.period)} · ${money(r.amount_cents)}`, chip(AR_STATUS[st] || [st, '']));
    const pays = Array.isArray(r.payments) ? r.payments : [];
    $('panel-body').innerHTML = `<div data-mxar-id="${e(r.id)}">
      <div style="display:grid;gap:6px">
        ${field('Inquilino', `${e(r.tenant_name)} <a href="#" data-mxar-do="tenant" style="margin-left:6px">Abrir ficha</a>`)}
        ${field('Propiedad', e([r.property, r.room && 'Hab. ' + r.room].filter(Boolean).join(' · ')))}
        ${field('Vence', e(fecha(r.due_date)) + (st === 'late' ? ` · <span style="color:var(--red,#b94a3f)">${daysLate(r.due_date, t)} día(s) tarde</span>` : ''))}
        ${field('Monto', `<b>${e(money(r.amount_cents))}</b>`)}${field('Pagado', e(money(r.paid_cents)))}${field('Saldo', `<b>${e(money(r.status === 'waived' ? 0 : bal))}</b>`)}
        ${field('Nota', e(r.notes))}
      </div>
      ${r.status !== 'waived' && bal > 0 ? H('Registrar pago') + `<form data-mxar-form="pay" style="display:grid;gap:8px;max-width:380px">
        <div style="display:flex;gap:8px"><label class="name-sub" style="flex:1">Monto <input class="form-input" name="amount" inputmode="decimal" value="${e(pesos(bal))}" required></label>
        <label class="name-sub" style="flex:1">Fecha <input class="form-input" type="date" name="on" value="${e(t)}"></label></div>
        <div style="display:flex;gap:8px"><label class="name-sub" style="flex:1">Forma de pago <select class="form-input" name="method">${methodOptions('spei')}</select></label>
        <label class="name-sub" style="flex:1">Referencia <input class="form-input" name="ref" placeholder="Clave de rastreo SPEI, recibo…"></label></div>
        <div><button class="btn btn-primary" type="submit">Registrar pago</button></div></form>` : ''}
      ${H(`Pagos (${pays.length})`)}<div style="display:grid;gap:4px">${pays.map(p => `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <span style="min-width:90px">${e(fecha(p.on))}</span><b style="min-width:110px;text-align:right">${e(money(p.cents))}</b><span class="name-sub">${e(METHOD[p.method] || p.method)}${p.ref ? ' · ' + e(p.ref) : ''} · ${e(p.by || '')}</span>
        <button class="btn btn-ghost" type="button" data-mxar-do="undo" data-pay="${e(p.id)}" style="padding:2px 8px;font-size:12px">Deshacer</button></div>`).join('') || '<div class="name-sub">Sin pagos.</div>'}</div>
      ${H('Ajustes')}
      <form data-mxar-form="amount" style="display:flex;gap:8px;align-items:end;max-width:380px"><label class="name-sub" style="flex:1">Monto del cargo <input class="form-input" name="amount" inputmode="decimal" value="${e(pesos(r.amount_cents))}"></label><button class="btn" type="submit">Guardar</button></form>
      <form data-mxar-form="note" style="display:flex;gap:8px;align-items:end;max-width:380px;margin-top:8px"><label class="name-sub" style="flex:1">Nota <input class="form-input" name="note" value="${e(r.notes || '')}"></label><button class="btn" type="submit">Guardar</button></form>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
        ${r.status === 'waived' ? '<button class="btn" type="button" data-mxar-do="reopen">Reabrir</button>' : r.status !== 'paid' ? '<button class="btn btn-ghost" type="button" data-mxar-do="waive">Condonar</button>' : ''}
        ${Number(r.paid_cents) ? '' : '<button class="btn btn-ghost" type="button" data-mxar-do="remove">Eliminar cargo</button>'}
      </div>
    </div>`;
  }
  function arNew(){
    const t = today(), mx = (window.tenants || []).filter(x => x && x.status !== 'past').sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'));
    openPanel('+', 'Nuevo cargo', 'Interés moratorio, renta prorrateada u otro cargo', '');
    $('panel-body').innerHTML = `<form data-mxar-form="add" style="display:grid;gap:8px;max-width:420px">
      <label class="name-sub">Inquilino <select class="form-input" name="tenant_id" required><option value="">Elige…</option>${mx.map(x => `<option value="${e(x.id)}">${e(x.name)} · ${e(x.property || '')}</option>`).join('')}</select></label>
      <div style="display:flex;gap:8px"><label class="name-sub" style="flex:1">Tipo <select class="form-input" name="kind"><option value="late_fee">${AR_KIND.late_fee}</option><option value="other">${AR_KIND.other}</option><option value="rent">${AR_KIND.rent}</option></select></label>
      <label class="name-sub" style="flex:1">Mes <input class="form-input" type="month" name="period" value="${e(AR.ym)}"></label></div>
      <div style="display:flex;gap:8px"><label class="name-sub" style="flex:1">Monto <input class="form-input" name="amount" inputmode="decimal" required></label>
      <label class="name-sub" style="flex:1">Vence <input class="form-input" type="date" name="due_date" value="${e(t)}"></label></div>
      <label class="name-sub">Nota <input class="form-input" name="notes"></label>
      <div><button class="btn btn-primary" type="submit">Agregar cargo</button></div></form>`;
  }
  async function arSubmit(f){
    const fd = new FormData(f), host = f.closest('[data-mxar-id]'), id = host && host.dataset.mxarId, kind = f.dataset.mxarForm;
    if (kind === 'add') {
      const c = parseAmount(fd.get('amount'));
      if (c == null) return toast(ERR['mx:invalid:cents']);
      const ok = await arRpc('mx_ar_add', { p: { tenant_id: fd.get('tenant_id'), kind: fd.get('kind'), period: fd.get('period'), due_date: fd.get('due_date'), amount_cents: String(c), notes: fd.get('notes') } }, 'Cargo agregado.');
      if (ok) { AR.ym = String(fd.get('period')).slice(0, 7); arRender(); arOpen(ok.id); }
      return;
    }
    if (!id) return;
    if (kind === 'pay') {
      const c = parseAmount(fd.get('amount'));
      if (!c) return toast(ERR['mx:invalid:cents']);
      if (await arRpc('mx_ar_action', { p_id: id, p_action: 'pay', p_patch: { cents: String(c), on: fd.get('on'), method: fd.get('method'), ref: fd.get('ref') } }, 'Pago registrado.')) arOpen(id);
    } else if (kind === 'amount') {
      const c = parseAmount(fd.get('amount'));
      if (c == null) return toast(ERR['mx:invalid:cents']);
      if (await arRpc('mx_ar_action', { p_id: id, p_action: 'set_amount', p_patch: { amount_cents: String(c) } }, 'Monto guardado.')) arOpen(id);
    } else if (kind === 'note') {
      if (await arRpc('mx_ar_action', { p_id: id, p_action: 'note', p_patch: { note: fd.get('note') } }, 'Nota guardada.')) arOpen(id);
    }
  }
  async function arDo(b){
    const host = b.closest('[data-mxar-id]'); if (!host) return;
    const id = host.dataset.mxarId, r = (AR.rows || []).find(x => x.id === id), d = b.dataset.mxarDo;
    if (d === 'tenant') { if (r && typeof openTenant === 'function') openTenant(r.tenant_id); return; }
    if (d === 'undo') { if (await arRpc('mx_ar_action', { p_id: id, p_action: 'undo_payment', p_patch: { payment_id: b.dataset.pay } }, 'Pago deshecho.')) arOpen(id); return; }
    if (d === 'waive') { if (await arRpc('mx_ar_action', { p_id: id, p_action: 'waive', p_patch: {} }, 'Cargo condonado.')) arOpen(id); return; }
    if (d === 'reopen') { if (await arRpc('mx_ar_action', { p_id: id, p_action: 'reopen', p_patch: {} }, 'Cargo reabierto.')) arOpen(id); return; }
    if (d === 'remove') { if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = '¿Seguro? Eliminar'; return; } if (await arRpc('mx_ar_action', { p_id: id, p_action: 'remove', p_patch: {} }, 'Cargo eliminado.')) closePanel(); }
  }
  function arExport(){
    const t = today(), list = sortByDue(arFiltered(), 'tenant_name');
    const out = [['Inquilino', 'Propiedad', 'Habitación', 'Tipo', 'Mes', 'Vence', 'Monto MXN', 'Pagado MXN', 'Saldo MXN', 'Estado', 'Nota']]
      .concat(list.map(r => [r.tenant_name, r.property, r.room, AR_KIND[r.kind] || r.kind, String(r.period).slice(0, 7), r.due_date, pesos(r.amount_cents), pesos(r.paid_cents), pesos(r.status === 'waived' ? 0 : balance(r)), (AR_STATUS[arState(r, t)] || [''])[0], r.notes]));
    download(`cobranza-mx-${AR.ym}.csv`, csv(out));
  }
  function download(name, text){
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
    a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // ═════════════ AP ═════════════
  const AP = { tab: 'all', view: 'to_pay', q: '', rows: null, setups: null, loading: null };
  async function apLoad(force){
    if (AP.loading && !force) return AP.loading;
    if (!sb()) return;
    AP.loading = (async () => {
      try {
        const s = await sb().rpc('mx_ap_sync', {});   // landlord lines for this month + next, refunds from Salidas
        if (s.error) throw s.error;
        const [a, l] = await Promise.all([
          sb().from('mx_ap_items').select('*').is('deleted_at', null).order('due_date', { ascending: true }).limit(5000),
          sb().from('mx_ap_landlords').select('*').order('property'),
        ]);
        if (a.error) throw a.error;
        if (l.error) throw l.error;
        AP.rows = a.data || []; AP.setups = l.data || [];
      } catch (err) { AP.rows = AP.rows || []; AP.setups = AP.setups || []; toast('AP México: ' + errText(err)); }
      finally { AP.loading = null; }
      apRender();
    })();
    return AP.loading;
  }
  function apFiltered(){
    return (AP.rows || []).filter(r => apInTab(r, AP.tab) && apInView(r, AP.view) && matches(AP.q, r.payee, r.property, r.notes, r.paid_ref, r.source_ref));
  }
  function apRender(){
    if (!$('mxap-body')) return;
    const t = today(), s = apSummary(AP.rows || [], t.slice(0, 7), t);
    $('mxap-cards').innerHTML = card('Por pagar', money(s.toPayCents), `${s.toPay} pago(s)`, 'data-mxap-view="to_pay"')
      + card('Vencido', money(s.lateCents), `${s.late} pago(s) con fecha pasada`, 'data-mxap-view="to_pay"')
      + card('Pagado este mes', money(s.paidCents), `${s.paid} pago(s)`, 'data-mxap-view="paid"')
      + card('Reembolsos en espera', String(s.waiting), 'salidas aún sin aprobar', 'data-mxap-view="waiting"');
    $('mxap-tabs').innerHTML = AP_TABS.map(([k, l]) => `<button class="tab ${AP.tab === k ? 'active' : ''}" type="button" role="tab" data-mxap-tab="${k}">${e(l)}</button>`).join('');
    const setups = AP.tab === 'setups';
    $('mxap-filter-bar').style.display = setups ? 'none' : '';
    $('mxap-list-card').style.display = setups ? 'none' : '';
    $('mxap-setups').style.display = setups ? '' : 'none';
    if (setups) return apRenderSetups();
    $('mxap-view').value = AP.view;
    const list = sortByDue(apFiltered(), 'payee');
    $('mxap-count').textContent = String(list.length);
    $('mxap-total').textContent = money(list.reduce((x, r) => x + Number(r.amount_cents || 0), 0));
    $('mxap-body').innerHTML = list.map(r => {
      const st = apState(r, t);
      return `<tr data-mxap-open="${e(r.id)}" tabindex="0" style="cursor:pointer">
        <td><b>${e(r.payee)}</b>${r.source === 'checkout' ? `<div class="name-sub">${e(r.source_ref)}</div>` : ''}</td>
        <td>${e(AP_TYPE[r.type] || r.type)}</td>
        <td>${e(r.property || '—')}</td>
        <td>${e(monthLabel(r.period))}</td>
        <td>${e(fecha(r.due_date))}</td>
        <td style="text-align:right">${r.status === 'waiting' && !Number(r.amount_cents) ? '<span class="name-sub">por definir</span>' : e(money(r.amount_cents))}</td>
        <td>${chip(AP_STATUS[st] || [st, ''])}${r.status === 'paid' && r.paid_on ? `<div class="name-sub">${e(fecha(r.paid_on))}</div>` : ''}</td></tr>`;
    }).join('');
    $('mxap-empty').style.display = list.length ? 'none' : '';
  }
  function apRenderSetups(){
    const list = AP.setups || [];
    $('mxap-setups').innerHTML = `<div class="card-head" style="justify-content:space-between;padding:14px 18px;flex-wrap:wrap;gap:8px">
        <div class="card-title">Renta que Vanmates paga a propietarios</div>
        <button class="btn btn-primary" type="button" data-mxap-do="setup-new">+ Agregar propietario</button></div>
      <div style="overflow-x:auto"><table><thead><tr><th>Propietario</th><th>Propiedad</th><th style="text-align:right">Renta mensual</th><th>Día de pago</th><th>Forma</th><th>Vigencia</th><th></th></tr></thead>
      <tbody>${list.map(l => `<tr data-mxap-setup="${e(l.id)}" tabindex="0" style="cursor:pointer"><td><b>${e(l.landlord)}</b></td><td>${e(l.property)}</td><td style="text-align:right">${e(money(l.amount_cents))}</td>
        <td>${e(l.pay_day)}</td><td>${e(METHOD[l.method] || l.method)}</td><td>${e(l.starts_on ? fecha(l.starts_on) : 'desde siempre')} → ${e(l.ends_on ? fecha(l.ends_on) : 'sin fin')}</td>
        <td>${l.active ? '' : chip(['Inactivo', ''])}</td></tr>`).join('')}</tbody></table></div>
      ${list.length ? '' : '<div class="name-sub" style="padding:28px;text-align:center">Aún no hay propietarios. Agrega uno y su renta aparecerá cada mes en Por pagar.</div>'}`;
  }
  async function apRpc(fn, args, done){
    try { const r = await sb().rpc(fn, args); if (r.error) throw r.error; if (done) toast(done); await apLoad(true); return r.data || true; }
    catch (err) { toast(errText(err)); return null; }
  }
  const billForm = (r) => {
    const editType = !r || r.source === 'manual';
    return `<form data-mxap-form="${r ? 'edit' : 'new'}" style="display:${r ? 'none' : 'grid'};gap:8px;max-width:420px">
      ${editType ? `<label class="name-sub">Tipo <select class="form-input" name="type">${Object.entries(AP_TYPE).filter(([k]) => k !== 'refund').map(([k, l]) => `<option value="${k}" ${(r ? r.type : 'utility') === k ? 'selected' : ''}>${e(l)}</option>`).join('')}</select></label>
      <label class="name-sub">A quién se le paga <input class="form-input" name="payee" value="${e(r ? r.payee : '')}" placeholder="CFE, SIAPA, Totalplay, plomero…" required></label>
      <label class="name-sub">Propiedad <input class="form-input" name="property" list="mxap-props" value="${e(r ? r.property || '' : '')}"></label>` : ''}
      <div style="display:flex;gap:8px"><label class="name-sub" style="flex:1">Monto <input class="form-input" name="amount" inputmode="decimal" value="${e(r ? pesos(r.amount_cents) : '')}" required></label>
      <label class="name-sub" style="flex:1">Vence <input class="form-input" type="date" name="due_date" value="${e(r ? r.due_date || '' : today())}"></label></div>
      ${editType ? `<label class="name-sub">Forma de pago <select class="form-input" name="payment_method">${methodOptions(r ? r.payment_method : 'spei')}</select></label>` : ''}
      <label class="name-sub">Nota <input class="form-input" name="notes" value="${e(r ? r.notes || '' : '')}"></label>
      <datalist id="mxap-props">${propOptions()}</datalist>
      <div style="display:flex;gap:8px"><button class="btn btn-primary" type="submit">${r ? 'Guardar' : 'Agregar'}</button>${r ? '<button class="btn btn-ghost" type="button" data-mxap-do="edit-cancel">Cancelar</button>' : ''}</div></form>`;
  };
  function apNew(){
    openPanel('+', 'Nueva factura', 'Servicios, internet, limpieza, reparaciones u otro pago', '');
    $('panel-body').innerHTML = `<div data-mxap-id="">${billForm(null)}</div>`;
  }
  function apOpen(id){
    const r = (AP.rows || []).find(x => x.id === id);
    if (!r) return;
    const t = today(), st = apState(r, t), refund = r.source === 'checkout';
    openPanel(r.payee, r.payee, `${AP_TYPE[r.type] || r.type} · ${money(r.amount_cents)}`, chip(AP_STATUS[st] || [st, '']));
    $('panel-body').innerHTML = `<div data-mxap-id="${e(r.id)}">
      <div style="display:grid;gap:6px">
        ${field('Tipo', e(AP_TYPE[r.type] || r.type))}${field('Propiedad', e(r.property || ''))}${field('Mes', e(monthLabel(r.period)))}
        ${field('Vence', e(fecha(r.due_date)))}${field('Monto', `<b>${e(r.status === 'waiting' && !Number(r.amount_cents) ? 'por definir' : money(r.amount_cents))}</b>`)}
        ${field('Forma de pago', e(METHOD[r.payment_method] || r.payment_method || ''))}
        ${r.status === 'paid' ? field('Pagado', e(fecha(r.paid_on)) + (r.paid_ref ? ' · ' + e(r.paid_ref) : '')) : ''}
        ${refund ? field('Salida', `<a href="#checkout=${encodeURIComponent(r.source_ref)}">${e(r.source_ref)}</a>`) : ''}
        ${field('Nota', e(r.notes))}
      </div>
      ${refund ? `<p class="name-sub" style="margin-top:12px">Los reembolsos de depósito se aprueban y se pagan en <a href="#checkout=${encodeURIComponent(r.source_ref)}">Salidas</a>. Esta línea se actualiza sola.</p>` : ''}
      ${!refund && r.status === 'to_pay' ? H('Marcar como pagado') + `<form data-mxap-form="paid" style="display:grid;gap:8px;max-width:380px">
        <div style="display:flex;gap:8px"><label class="name-sub" style="flex:1">Fecha <input class="form-input" type="date" name="paid_on" value="${e(t)}"></label>
        <label class="name-sub" style="flex:1">Forma <select class="form-input" name="method">${methodOptions(r.payment_method || 'spei')}</select></label></div>
        <label class="name-sub">Referencia <input class="form-input" name="ref" placeholder="Clave de rastreo SPEI, folio…"></label>
        <div><button class="btn btn-primary" type="submit">Marcar pagado</button></div></form>` : ''}
      ${!refund ? H('Acciones') + `<div style="display:flex;gap:8px;flex-wrap:wrap">
        ${r.status === 'to_pay' ? '<button class="btn" type="button" data-mxap-do="edit-open">Editar</button><button class="btn btn-ghost" type="button" data-mxap-do="skip">Omitir</button>' : ''}
        ${r.status === 'skipped' ? '<button class="btn" type="button" data-mxap-do="reopen">Reabrir</button>' : ''}
        ${r.status === 'paid' ? '<button class="btn btn-ghost" type="button" data-mxap-do="unpay">Deshacer pago</button>' : ''}
        ${r.source === 'manual' && r.status !== 'paid' ? '<button class="btn btn-ghost" type="button" data-mxap-do="delete">Eliminar</button>' : ''}
      </div>${r.status === 'to_pay' ? billForm(r) : ''}` : ''}
      ${H('Nota')}<form data-mxap-form="note" style="display:flex;gap:8px;align-items:end;max-width:380px"><input class="form-input" name="note" value="${e(r.notes || '')}" aria-label="Nota" style="flex:1"><button class="btn" type="submit">Guardar</button></form>
    </div>`;
  }
  function setupOpen(id){
    const l = id ? (AP.setups || []).find(x => x.id === id) : null;
    if (id && !l) return;
    openPanel(l ? l.landlord : '+', l ? l.landlord : 'Nuevo propietario', l ? `${l.property} · ${money(l.amount_cents)} al mes` : 'Su renta aparecerá cada mes en Por pagar', '');
    $('panel-body').innerHTML = `<form data-mxap-form="setup" data-setup-id="${e(l ? l.id : '')}" style="display:grid;gap:8px;max-width:420px">
      <label class="name-sub">Propietario <input class="form-input" name="landlord" value="${e(l ? l.landlord : '')}" required></label>
      <label class="name-sub">Propiedad <input class="form-input" name="property" list="mxap-props2" value="${e(l ? l.property : '')}" required></label><datalist id="mxap-props2">${propOptions()}</datalist>
      <div style="display:flex;gap:8px"><label class="name-sub" style="flex:1">Renta mensual <input class="form-input" name="amount" inputmode="decimal" value="${e(l ? pesos(l.amount_cents) : '')}" required></label>
      <label class="name-sub" style="width:110px">Día de pago <input class="form-input" type="number" name="pay_day" min="1" max="28" value="${e(l ? l.pay_day : 1)}"></label></div>
      <label class="name-sub">Forma de pago <select class="form-input" name="method">${methodOptions(l ? l.method : 'spei')}</select></label>
      <div style="display:flex;gap:8px"><label class="name-sub" style="flex:1">Desde <input class="form-input" type="date" name="starts_on" value="${e(l ? l.starts_on || '' : '')}"></label>
      <label class="name-sub" style="flex:1">Hasta <input class="form-input" type="date" name="ends_on" value="${e(l ? l.ends_on || '' : '')}"></label></div>
      <label class="name-sub">Nota (sin CLABE) <input class="form-input" name="notes" value="${e(l ? l.notes || '' : '')}"></label>
      <label class="name-sub"><input type="checkbox" name="active" ${!l || l.active ? 'checked' : ''}> Activo (crear la renta cada mes)</label>
      <div><button class="btn btn-primary" type="submit">${l ? 'Guardar' : 'Agregar'}</button></div>
      <div class="name-sub">Al guardar se actualizan las rentas sin pagar de este mes y del que entra.</div></form>`;
  }
  async function apSubmit(f){
    const fd = new FormData(f), kind = f.dataset.mxapForm, host = f.closest('[data-mxap-id]'), id = host && host.dataset.mxapId;
    if (kind === 'setup') {
      const c = parseAmount(fd.get('amount'));
      if (!c) return toast(ERR['mx:invalid:cents']);
      const ok = await apRpc('mx_ap_landlord_save', { p: { id: f.dataset.setupId || null, landlord: fd.get('landlord'), property: fd.get('property'), amount_cents: String(c),
        pay_day: String(fd.get('pay_day') || '1'), method: fd.get('method'), starts_on: fd.get('starts_on'), ends_on: fd.get('ends_on'), notes: fd.get('notes'), active: !!fd.get('active') } }, 'Guardado.');
      if (ok) { closePanel(); AP.tab = 'setups'; apRender(); }
      return;
    }
    if (kind === 'new' || kind === 'edit') {
      const c = parseAmount(fd.get('amount'));
      if (c == null) return toast(ERR['mx:invalid:cents']);
      const p = { amount_cents: String(c), due_date: fd.get('due_date'), notes: fd.get('notes') };
      if (f.elements.type) Object.assign(p, { type: fd.get('type'), payee: fd.get('payee'), property: fd.get('property'), payment_method: fd.get('payment_method') });
      if (kind === 'edit') p.id = id;
      const ok = await apRpc('mx_ap_save', { p }, kind === 'new' ? 'Factura agregada.' : 'Guardado.');
      if (ok) apOpen(ok.id || id);
      return;
    }
    if (!id) return;
    if (kind === 'paid') { if (await apRpc('mx_ap_action', { p_id: id, p_action: 'mark_paid', p_patch: { paid_on: fd.get('paid_on'), method: fd.get('method'), ref: fd.get('ref') } }, 'Marcado como pagado.')) apOpen(id); }
    else if (kind === 'note') { if (await apRpc('mx_ap_action', { p_id: id, p_action: 'note', p_patch: { note: fd.get('note') } }, 'Nota guardada.')) apOpen(id); }
  }
  async function apDo(b){
    const d = b.dataset.mxapDo;
    if (d === 'setup-new') return setupOpen(null);
    const host = b.closest('[data-mxap-id]'); if (!host) return;
    const id = host.dataset.mxapId;
    const form = host.querySelector('[data-mxap-form="edit"]');
    if (d === 'edit-open') { if (form) form.style.display = 'grid'; return; }
    if (d === 'edit-cancel') { if (form) form.style.display = 'none'; return; }
    if (d === 'delete' && b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = '¿Seguro? Eliminar'; return; }
    const msg = { skip: 'Omitido.', reopen: 'Reabierto.', unpay: 'Pago deshecho.', delete: 'Eliminado.' }[d];
    if (!msg) return;
    const ok = await apRpc('mx_ap_action', { p_id: id, p_action: d, p_patch: {} }, msg);
    if (ok) { if (d === 'delete') closePanel(); else apOpen(id); }
  }
  function apExport(){
    const list = sortByDue(apFiltered(), 'payee'), t = today();
    const out = [['Beneficiario', 'Tipo', 'Propiedad', 'Mes', 'Vence', 'Monto MXN', 'Estado', 'Pagado el', 'Referencia', 'Forma de pago', 'Nota']]
      .concat(list.map(r => [r.payee, AP_TYPE[r.type] || r.type, r.property, String(r.period || '').slice(0, 7), r.due_date, pesos(r.amount_cents), (AP_STATUS[apState(r, t)] || [''])[0], r.paid_on, r.paid_ref, METHOD[r.payment_method] || '', r.notes]));
    download(`pagos-mx-${t}.csv`, csv(out));
  }

  window.loadMxAr = arLoad;
  window.loadMxAp = apLoad;

  function wire(){
    const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    if ($('mxar-view')) $('mxar-view').innerHTML = AR_VIEWS.map(([k, l]) => `<option value="${k}">${e(l)}</option>`).join('');
    if ($('mxap-view')) $('mxap-view').innerHTML = AP_VIEWS.map(([k, l]) => `<option value="${k}">${e(l)}</option>`).join('');
    let t1 = null, t2 = null;
    on('mxar-search', 'input', ev => { AR.q = ev.target.value; clearTimeout(t1); t1 = setTimeout(arRender, 150); });
    on('mxar-view', 'change', ev => { AR.view = ev.target.value; arRender(); });
    on('mxar-prev', 'click', () => { AR.ym = shiftMonth(AR.ym, -1); arRender(); });
    on('mxar-next', 'click', () => { AR.ym = shiftMonth(AR.ym, 1); arRender(); });
    on('mxar-make', 'click', async () => { try { const r = await sb().rpc('mx_ar_generate', { p_period: AR.ym + '-01' }); if (r.error) throw r.error; toast(`${r.data} cargo(s) creados.`); arLoad(true); } catch (err) { toast(errText(err)); } });
    on('mxar-add', 'click', arNew);
    on('mxar-export', 'click', arExport);
    on('mxar-refresh', 'click', () => arLoad(true));
    on('mxar-cards', 'click', ev => { const b = ev.target.closest('[data-mxar-view]'); if (b) { AR.view = b.dataset.mxarView; arRender(); } });
    on('mxar-body', 'click', ev => { const tr = ev.target.closest('[data-mxar-open]'); if (tr) arOpen(tr.dataset.mxarOpen); });
    on('mxar-body', 'keydown', ev => { if (ev.key !== 'Enter') return; const tr = ev.target.closest('[data-mxar-open]'); if (tr) arOpen(tr.dataset.mxarOpen); });
    on('mxap-search', 'input', ev => { AP.q = ev.target.value; clearTimeout(t2); t2 = setTimeout(apRender, 150); });
    on('mxap-view', 'change', ev => { AP.view = ev.target.value; apRender(); });
    on('mxap-tabs', 'click', ev => { const b = ev.target.closest('[data-mxap-tab]'); if (b) { AP.tab = b.dataset.mxapTab; apRender(); } });
    on('mxap-cards', 'click', ev => { const b = ev.target.closest('[data-mxap-view]'); if (b) { AP.view = b.dataset.mxapView; if (AP.tab === 'setups') AP.tab = 'all'; apRender(); } });
    on('mxap-add', 'click', apNew);
    on('mxap-export', 'click', apExport);
    on('mxap-refresh', 'click', () => apLoad(true));
    on('mxap-body', 'click', ev => { const tr = ev.target.closest('[data-mxap-open]'); if (tr) apOpen(tr.dataset.mxapOpen); });
    on('mxap-body', 'keydown', ev => { if (ev.key !== 'Enter') return; const tr = ev.target.closest('[data-mxap-open]'); if (tr) apOpen(tr.dataset.mxapOpen); });
    on('mxap-setups', 'click', ev => { const b = ev.target.closest('[data-mxap-do]'); if (b) return apDo(b); const tr = ev.target.closest('[data-mxap-setup]'); if (tr) setupOpen(tr.dataset.mxapSetup); });
    const pb = $('panel-body');
    if (pb) {
      pb.addEventListener('click', ev => {
        const a = ev.target.closest('[data-mxar-do]'); if (a) { ev.preventDefault(); return arDo(a); }
        const b = ev.target.closest('[data-mxap-do]'); if (b) { ev.preventDefault(); return apDo(b); }
      });
      pb.addEventListener('submit', ev => {
        const a = ev.target.closest('[data-mxar-form]'); if (a) { ev.preventDefault(); return arSubmit(a); }
        const b = ev.target.closest('[data-mxap-form]'); if (b) { ev.preventDefault(); return apSubmit(b); }
      });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
