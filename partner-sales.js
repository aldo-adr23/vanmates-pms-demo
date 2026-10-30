/* partner-sales.js — PTS_CORE: partner placement fees on the Sales page (2026-10-30).

   Aldo: "the partners have account managers within Vanmates. For instance CES and CEL belong to Juliana. So all
   the placement fees should be counted in her sales ... moving forward all the sales are counted automatically."

   The rows come from public.vm_partner_sales() (partner repo sql/2026-10-30-partner-account-managers.sql): one per
   placement fee, computed live from the partner bookings, invoices and allocations, each carrying the account
   manager the booking was sold under. Money arrives in cents and leaves here in dollars, like the rest of Sales.

   Booked     = the fee of every confirmed booking (a cancelled one keeps only what was collected)
   Collected  = what was paid toward the fee, net of refunds (placement fee first on each invoice)
   Outstanding= booked - collected, never below 0, never on a cancelled booking

   Pure functions only: no DOM, no Supabase. Loaded with a <script> tag, tested with node (test/partner-sales.test.js). */
(function (root) {
  'use strict';

  const KIND_LABELS = { room: 'Room booking', category: 'School booking', homestay: 'Homestay', link: 'Room link' };
  const FEE_STATUS_LABELS = {
    not_invoiced: 'Not invoiced', invoiced: 'Invoiced', partially_paid: 'Part paid', paid: 'Paid',
    refunded: 'Refunded', partially_refunded: 'Part refunded', waived: 'Waived', cancelled: 'Cancelled'
  };
  const NO_MANAGER = '(none)';

  const dollars = c => Math.round(Number(c) || 0) / 100;
  const lower = v => String(v == null ? '' : v).trim().toLowerCase();
  const day = v => (/^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : '');
  const quarterOf = d => { const m = Number(String(d).slice(5, 7)); return m ? String(d).slice(0, 4) + '-Q' + (Math.floor((m - 1) / 3) + 1) : ''; };
  // Accents and punctuation out, so "Röllin" in the portal and "Roellin - CES" in Zoho can still meet.
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  /* One vm_partner_sales() row, in dollars, with the fields the page filters and groups on. */
  function fromRow(r) {
    const x = r || {};
    const fee = dollars(x.fee_cents), collected = dollars(x.collected_cents);
    return {
      id: String(x.id || ''),
      kind: String(x.kind || ''),
      kindLabel: KIND_LABELS[x.kind] || String(x.kind || ''),
      ref: String(x.ref || ''),
      agencyId: String(x.agency_id || ''),
      agency: String(x.agency || ''),
      manager: lower(x.manager),
      student: String(x.student || ''),
      studentEmail: lower(x.student_email),
      city: String(x.city || ''),
      bookedOn: day(x.booked_on),
      checkIn: day(x.check_in),
      cancelled: x.booking_status === 'cancelled',
      fee,
      listFee: dollars(x.fee_list_cents),
      invoiced: dollars(x.invoiced_cents),
      collected,
      refunded: dollars(x.refunded_cents),
      outstanding: dollars(x.outstanding_cents),
      feeStatus: String(x.fee_status || ''),
      feeStatusLabel: FEE_STATUS_LABELS[x.fee_status] || String(x.fee_status || ''),
      invoices: Array.isArray(x.invoices) ? x.invoices.map(String) : []
    };
  }

  function rows(payload) {
    return ((payload && payload.rows) || []).map(fromRow).filter(r => r.bookedOn);
  }

  /* Every filter optional; '' = don't filter. manager '(none)' = partners nobody manages. */
  function filter(list, f) {
    const q = f || {};
    return (list || []).filter(r => {
      if (q.managers && !q.managers.has(r.manager)) return false;
      if (q.manager === NO_MANAGER ? r.manager : (q.manager && r.manager !== lower(q.manager))) return false;
      if (q.agency && r.agencyId !== q.agency) return false;
      if (q.city && lower(r.city) !== lower(q.city)) return false;
      if (q.status && r.feeStatus !== q.status) return false;
      if (q.from && r.bookedOn < q.from) return false;
      if (q.to && r.bookedOn > q.to) return false;
      return true;
    });
  }

  function totals(list) {
    const live = (list || []).filter(r => !r.cancelled && r.fee > 0);
    const sum = (arr, k) => Math.round(arr.reduce((s, r) => s + r[k], 0) * 100) / 100;
    const booked = sum(list || [], 'fee'), collected = sum(list || [], 'collected');
    return {
      bookings: live.length,
      cancelled: (list || []).filter(r => r.cancelled).length,
      booked,
      collected,
      outstanding: sum(list || [], 'outstanding'),
      refunded: sum(list || [], 'refunded'),
      rate: booked > 0 ? Math.round(collected / booked * 100) : null
    };
  }

  const GROUPS = [['manager', 'Account manager'], ['agency', 'Partner'], ['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year'], ['city', 'City']];
  function groupKey(r, by) {
    if (by === 'manager') return r.manager || NO_MANAGER;
    if (by === 'agency') return r.agency || '(unknown)';
    if (by === 'month') return r.bookedOn.slice(0, 7);
    if (by === 'quarter') return quarterOf(r.bookedOn);
    if (by === 'year') return r.bookedOn.slice(0, 4);
    if (by === 'city') return r.city || '(no city)';
    return '(all)';
  }
  function group(list, by, nameOf) {
    const g = {};
    for (const r of list || []) { const k = groupKey(r, by); (g[k] = g[k] || []).push(r); }
    const out = Object.keys(g).map(k => ({ key: k, label: by === 'manager' && nameOf ? (nameOf(k) || k) : k, totals: totals(g[k]) }));
    return out.sort(by === 'month' || by === 'quarter' || by === 'year'
      ? (a, b) => (a.key < b.key ? 1 : -1)
      : (a, b) => b.totals.booked - a.totals.booked || (a.label < b.label ? -1 : 1));
  }

  /* The partner row as a Sales-ledger deal (CLOSED-DEALS-CORE shape), so it counts in the account manager's
     targets, KPIs, closed-deal table and by-rep rollup like any deal they closed. Fee = booked placement fee;
     payment follows collection. A cancelled booking that kept nothing is a cancelled deal (out of net totals). */
  function toDeal(r) {
    const status = r.cancelled ? (r.collected > 0 ? 'closed' : 'cancelled') : 'closed';
    const paymentStatus = r.feeStatus === 'paid' ? 'paid'
      : r.feeStatus === 'refunded' ? 'refunded'
      : r.cancelled ? 'cancelled'
      : r.feeStatus === 'partially_paid' || r.feeStatus === 'partially_refunded' ? 'partial' : 'pending';
    return {
      id: r.id, customer: r.student || r.ref, email: r.studentEmail, phone: '',
      rep: r.manager, repName: '', team: '', segment: 'partner', city: r.city,
      property: r.agency, room: r.ref, closedAt: r.bookedOn, closedAtFrom: 'partner booking',
      moveIn: r.checkIn, contractStart: '', contractEnd: '', checkedOutAt: '',
      months: 0, rent: 0, fee: r.cancelled ? r.collected : r.fee, feeNet: r.collected,
      feePending: !r.cancelled && r.fee <= 0, feeSource: 'partner', deposit: 0, dealValue: 0,
      stage: r.kindLabel + ' · ' + r.feeStatusLabel, status, statusLabel: status === 'closed' ? 'Closed' : 'Cancelled',
      paymentStatus, leadSource: 'Partner · ' + (r.agency || '?'), serviceType: r.kindLabel,
      sourceSystem: 'partner', sourceUrl: '',
      partner: { agency: r.agency, agencyId: r.agencyId, kind: r.kind, ref: r.ref, booked: r.fee, collected: r.collected,
                 outstanding: r.outstanding, refunded: r.refunded, invoices: r.invoices, feeStatus: r.feeStatus }
    };
  }

  /* A Zoho deal that is the same sale as a partner booking: the reps still log CES students in Zoho as
     "<Student name> - CES". Same student name (Zoho's name contains the portal's full name) within 60 days.
     Name only, never email: CES puts its coordinator's address on every student's deal (found live 2026-10-30,
     "Jana Lieblang" matched "Jana Röllin"). Only a standing partner booking replaces anything: a cancelled one
     must never drop a deal that was really closed. */
  const SAME_DAYS = 60;
  function daysApart(a, b) {
    const t = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
    return Math.abs(Math.round((t(a) - t(b)) / 864e5));
  }
  function sameSale(zoho, p) {
    if (!zoho || !p || zoho.sourceSystem === 'partner' || !zoho.closedAt || !p.closedAt || p.status !== 'closed') return false;
    // German umlauts are written both ways ("Röllin" / "Roellin" / "Rollin"): try each spelling.
    const spell = s => [norm(s), norm(String(s || '').replace(/ä/gi, 'ae').replace(/ö/gi, 'oe').replace(/ü/gi, 'ue'))];
    const pns = spell(p.customer), zns = spell(zoho.customer);
    if (!pns[0] || pns[0].split(' ').length < 2 || !zns[0]) return false;
    const hit = pns.some(pn => zns.some(zn => (' ' + zn + ' ').indexOf(' ' + pn + ' ') >= 0));
    return hit && daysApart(zoho.closedAt, p.closedAt) <= SAME_DAYS;
  }

  /* The Sales ledger with partner deals added. A Zoho/portal deal that duplicates a partner booking is dropped
     (the partner booking is the record with the fee and the payments) and named on the partner deal. */
  function mergeLedger(deals, partnerRows) {
    const pdeals = (partnerRows || []).map(toDeal);
    if (!pdeals.length) return deals || [];
    const out = [];
    for (const d of deals || []) {
      const hit = pdeals.find(p => sameSale(d, p));
      if (hit) { hit.mergedFrom = (hit.mergedFrom ? hit.mergedFrom + ', ' : '') + (d.sourceSystem || 'deal') + ':' + d.id; continue; }
      out.push(d);
    }
    return out.concat(pdeals).sort((a, b) => (a.closedAt < b.closedAt ? 1 : a.closedAt > b.closedAt ? -1 : 0));
  }

  /* Direct vs partner for the same people and dates: what the reps sold themselves vs what their partners sold. */
  function directVsPartner(ledger, f) {
    const q = f || {};
    const pick = (d) => (!q.managers || q.managers.has(lower(d.rep))) && (!q.from || d.closedAt >= q.from) && (!q.to || d.closedAt <= q.to) && d.status === 'closed';
    const all = (ledger || []).filter(pick);
    const part = all.filter(d => d.sourceSystem === 'partner'), direct = all.filter(d => d.sourceSystem !== 'partner');
    const fees = arr => Math.round(arr.reduce((s, d) => s + (Number(d.fee) || 0), 0) * 100) / 100;
    return { direct: { deals: direct.length, fees: fees(direct) }, partner: { deals: part.length, fees: fees(part) } };
  }

  /* Partners with no account manager (active ones first): flagged on the Partners page and here. */
  function unmanaged(agencies) {
    return (agencies || []).filter(a => a && !a.manager).sort((a, b) =>
      (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || String(a.name).localeCompare(String(b.name)));
  }

  /* Historical Zoho deals that name a partner school (e.g. "Ayana Tanner - CES") but sit with another rep or
     nobody: the reconciliation list an admin reviews before changing anything in Zoho. Read only. */
  function historicalReview(deals, tags, manager) {
    const re = new RegExp('\\b(' + (tags || []).map(t => String(t).replace(/[^A-Za-z0-9]/g, '')).filter(Boolean).join('|') + ')\\b', 'i');
    if (!(tags || []).length) return { matched: [], elsewhere: [] };
    const matched = (deals || []).filter(d => d.sourceSystem !== 'partner' && re.test(String(d.customer || '')));
    return { matched, elsewhere: matched.filter(d => lower(d.rep) !== lower(manager)) };
  }

  root.PTS_CORE = { KIND_LABELS, FEE_STATUS_LABELS, NO_MANAGER, GROUPS, fromRow, rows, filter, totals, group,
                    toDeal, sameSale, mergeLedger, directVsPartner, unmanaged, historicalReview, norm };
})(typeof window !== 'undefined' ? window : this);
