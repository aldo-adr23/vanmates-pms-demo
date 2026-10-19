// hr-core.js — pure logic for hr.html (Employee Hub). No DOM, no Supabase. Tested by test/hr-core.test.js.
//
// Balances are integer minutes (spec §3); rounding happens only here, at display. A working day is the
// employee's own day_minutes — never an assumed 8 hours. The same text and rules drive an employee's own hub
// (hr_my_hub, once HR switches it on for them) and HR's "See what they see" preview of it.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HR = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // One decimal, half away from zero, so −0.25 and +0.25 read the same (Math.round alone gives −0.2 / 0.3).
  function round1(x) { var r = Math.sign(x) * Math.round(Math.abs(x) * 10) / 10; return r === 0 ? 0 : r; }
  function num(x) { return String(round1(x)); }

  // "12.5" / "-2" / "7,5" hours → integer minutes, or null if it is not a number.
  function hoursToMinutes(s) {
    var t = String(s == null ? "" : s).trim().replace(",", ".");
    if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
    return Math.round(parseFloat(t) * 60);
  }

  // { hours: 70, days: 9.3 | null, text: "70 h · 9.3 days" }. days only when the working day is known.
  function fmtBalance(minutes, dayMinutes, lang) {
    var es = lang === "es";
    var h = round1((minutes || 0) / 60);
    var d = dayMinutes ? round1((minutes || 0) / dayMinutes) : null;
    var text = num(h) + " h" + (d === null ? "" : " · " + num(d) + (es ? (Math.abs(d) === 1 ? " día" : " días") : (Math.abs(d) === 1 ? " day" : " days")));
    return { hours: h, days: d, text: text };
  }

  var ENTRY = { opening: "Opening balance", accrual: "Accrual", adjustment: "Adjustment", usage: "Time taken", expiry: "Expired", reversal: "Reversal" };
  var LEAVE = { vacation: "Vacation", sick: "Sick", personal: "Personal" };

  // Documents an employee may see: assigned to them, signed, and an employment record. Uncertain/unsigned
  // copies and the review queue stay HR-only until someone confirms them (spec §9, "do not assume signed").
  var EMP_CATS = ["contract", "amendment", "renewal", "offer_letter", "job_description", "policy"];
  function employeeDocs(docs, empId) {
    return (docs || []).filter(function (d) {
      return d.employee_id === empId && d.signed_status === "signed" && EMP_CATS.indexOf(d.category) >= 0;
    }).sort(function (a, b) {
      if (a.is_current_contract !== b.is_current_contract) return a.is_current_contract ? -1 : 1;
      return String(b.effective_date || "").localeCompare(String(a.effective_date || ""));
    });
  }

  // What must be true before this person could be switched on. Manager is not required (the owner has none).
  function readiness(e, docs, balances) {
    var mine = (docs || []).filter(function (d) { return d.employee_id === e.id; });
    var cur = mine.filter(function (d) { return d.is_current_contract; })[0];
    var vac = (balances || []).filter(function (b) { return b.employee_id === e.id && b.leave_type === "vacation"; })[0];
    var items = [
      { key: "approved", label: "Elisa approved the profile", ok: e.review_status === "approved" },
      { key: "email", label: "Work email", ok: !!e.work_email },
      { key: "title", label: "Job title", ok: !!e.job_title },
      { key: "start", label: "Start date", ok: !!e.start_date },
      { key: "day", label: "Working-day length", ok: !!e.day_minutes },
      { key: "contract", label: "Current contract, signed", ok: !!(cur && cur.signed_status === "signed") },
      { key: "balance", label: "Opening vacation balance", ok: !!(vac && vac.opening_as_of) },
    ];
    var done = items.filter(function (i) { return i.ok; }).length;
    return { items: items, done: done, total: items.length, ready: done === items.length,
      missing: items.filter(function (i) { return !i.ok; }).map(function (i) { return i.label; }) };
  }

  function hasOpening(balances, empId) {
    return (balances || []).some(function (b) { return b.employee_id === empId && b.leave_type === "vacation" && b.opening_as_of; });
  }

  // allowlist emails → first name for "who opened your file". Anything else shows as "HR".
  function actorName(email) {
    var m = /^([a-z]+)@vanmates\.com$/i.exec(String(email || ""));
    return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() : "HR";
  }

  // Sensitive reads of this employee's file, newest first (from hr_audit rows already loaded for them).
  function accessLog(audit) {
    return (audit || []).filter(function (a) {
      return a.action === "view_document" || a.action === "download_document" || a.action === "export";
    }).map(function (a) { return { who: actorName(a.actor), action: a.action, at: a.at }; });
  }

  // Mon–Fri days between two YYYY-MM-DD dates, inclusive (same rule as hr_weekdays in SQL). 0 if either is bad.
  function ymdUTC(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "")); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; }
  function weekdays(d1, d2) {
    var a = ymdUTC(d1), b = ymdUTC(d2 || d1);
    if (a === null || b === null || b < a || b - a > 400 * 864e5) return 0;
    var n = 0;
    for (var t = a; t <= b; t += 864e5) { var w = new Date(t).getUTCDay(); if (w !== 0 && w !== 6) n++; }
    return n;
  }

  // What a time-off request will take, before it is sent — the server recomputes the same way.
  // { minutes, weekdays, error: null | "dates" | "order" | "hours" | "needHours" | "weekend" }
  function requestMinutes(d1, d2, dayMinutes, hours) {
    var a = ymdUTC(d1), b = ymdUTC(d2 || d1);
    if (a === null || b === null) return { minutes: 0, weekdays: 0, error: "dates" };
    if (b < a) return { minutes: 0, weekdays: 0, error: "order" };
    var wd = weekdays(d1, d2 || d1);
    if (String(hours == null ? "" : hours).trim() !== "") {
      var m = hoursToMinutes(hours);
      return m === null || m <= 0 ? { minutes: 0, weekdays: wd, error: "hours" } : { minutes: m, weekdays: wd, error: null };
    }
    if (!dayMinutes) return { minutes: 0, weekdays: wd, error: "needHours" };
    if (!wd) return { minutes: 0, weekdays: 0, error: "weekend" };
    return { minutes: wd * dayMinutes, weekdays: wd, error: null };
  }

  // Requests the employee should notice first: waiting, then upcoming approved, then the rest (newest first).
  function sortRequests(reqs, today) {
    var rank = function (r) { return r.status === "pending" ? 0 : r.status === "approved" && String(r.end_date) >= today ? 1 : 2; };
    return (reqs || []).slice().sort(function (a, b) {
      return rank(a) - rank(b) || (rank(a) === 1 ? String(a.start_date).localeCompare(String(b.start_date)) : String(b.start_date).localeCompare(String(a.start_date)));
    });
  }

  var T = {
    en: {
      banner: "Preview — this is what {name} would see. Employees can’t open the hub yet.",
      hello: "Hi {name}", profile: "My profile", docs: "My documents", time: "Time off", contact: "Contact HR", pay: "Pay stubs and tax slips",
      privacy: "Who sees your information", opened: "Who opened your file",
      job: "Job title", manager: "Manager", start: "Start date", entity: "Employer", location: "Location", emergency: "Emergency contact",
      notSet: "Not set yet", editNote: "You can update your preferred name, personal contact and emergency contact. Ask HR to change anything else.",
      noDocs: "No documents yet. If your contract is missing, tell HR and we’ll find it.", current: "Current contract", effective: "effective",
      balance: "Vacation balance", asOf: "as of {date}", noBalance: "Your balance hasn’t been set up yet.",
      payPerCheque: "Your vacation pay is included on each pay cheque, so this balance is time off only — not money owed.",
      payWhenTaken: "You’re paid for vacation days when you take them.",
      request: "Request time off", requestSoon: "(coming soon)",
      contactBody: "Questions, feedback or a concern go to Elisa (HR). Aldo can also see what you send. Nothing goes to your manager.",
      outside: "If your concern is about HR or management, contact {name}{role} directly: {email}. They are outside Vanmates.",
      payBody: "Pay stubs, T4s and direct-deposit details stay in Wagepoint.", payLink: "Open Wagepoint",
      privacyBody: [
        "You: your own profile, documents and time off.",
        "Your manager: your name, job title and the dates you’re away — not your contract, pay or anything you send HR.",
        "HR (Elisa, and Aldo): your full file. Every time they open a document, it is recorded and shown below.",
        "No one else at Vanmates, and no bank, tax or ID numbers are kept here.",
      ],
      noneOpened: "No one has opened your documents.", openedRow: "{who} opened a document",
      // employee hub (part 3)
      tHome: "Home", tTime: "Time off", tDocs: "Documents", tDetails: "My details", tAsk: "Ask HR",
      left: "Vacation left", waiting: "{n} request waiting for HR", waitingN: "{n} requests waiting for HR", nextOff: "Next time off: {dates}",
      reqBtn: "Request time off", writeBtn: "Write to HR", openBtn: "Open", editBtn: "Edit my details", allDocs: "See all documents",
      askBlurb: "Questions about time off, your contract or anything else? Write to HR here.",
      hrReplied: "HR replied: {text}", youWrote: "You wrote: {text}",
      noEmergency: "No emergency contact yet — please add one.",
      kVacation: "Vacation", kSick: "Sick", kPersonal: "Personal", kind: "Type",
      first: "First day", last: "Last day", hoursOpt: "Hours (only if different)", hoursPh: "e.g. 4 for half a day",
      noteOpt: "Note for HR (optional)", send: "Send request", estimate: "{n} working days · {h}", estimate1: "1 working day · {h}",
      estHours: "{h}", eDates: "Pick the first day.", eOrder: "The last day is before the first day.", eHours: "Check the hours.",
      eNeedHours: "Enter how many hours — HR hasn’t set your working day yet.", eWeekend: "Those days are a weekend — enter the hours if you work then.",
      sent: "Sent. Elisa will reply here.", myRequests: "My requests", noRequests: "No requests yet.",
      sPending: "Waiting", sApproved: "Approved", sDeclined: "Declined", sCancelled: "Cancelled", cancel: "Cancel request", cancelled: "Request cancelled.",
      hrNote: "HR: {text}", workEmail: "Work email", prefName: "Preferred name", persEmail: "Personal email", phone: "Phone",
      emName: "Emergency contact name", emPhone: "Their phone", emRel: "Relationship", save: "Save", saved: "Saved.",
      fromHr: "HR", fromYou: "You", msgPh: "Write your question…", msgSend: "Send", noMsgs: "No messages yet.",
      previewNote: "Preview — buttons don’t send anything.", lockTitle: "Your Employee Hub isn’t on yet",
      lockBody: "HR switches it on for each person. If you think yours should be on, ask Elisa.", backPortal: "Back to the portal",
      unitDays: "{n} days", unitDay: "1 day",
    },
    es: {
      banner: "Vista previa: esto es lo que vería {name}. Los empleados aún no pueden entrar.",
      hello: "Hola, {name}", profile: "Mi perfil", docs: "Mis documentos", time: "Vacaciones y permisos", contact: "Contactar a RR. HH.",
      pay: "Recibos de pago y formularios fiscales", privacy: "Quién ve tu información", opened: "Quién abrió tu expediente",
      job: "Puesto", manager: "Jefe directo", start: "Fecha de inicio", entity: "Empleador", location: "Ubicación", emergency: "Contacto de emergencia",
      notSet: "Sin definir", editNote: "Puedes actualizar tu nombre preferido, tus datos personales de contacto y tu contacto de emergencia. Para lo demás, pídeselo a RR. HH.",
      noDocs: "Aún no hay documentos. Si falta tu contrato, avísale a RR. HH. y lo buscaremos.", current: "Contrato vigente", effective: "vigente desde",
      balance: "Saldo de vacaciones", asOf: "al {date}", noBalance: "Tu saldo todavía no está configurado.",
      payPerCheque: "Tu pago de vacaciones se incluye en cada cheque de pago, así que este saldo es solo tiempo libre, no dinero pendiente.",
      payWhenTaken: "Se te pagan los días de vacaciones cuando los tomas.",
      request: "Solicitar días libres", requestSoon: "(próximamente)",
      contactBody: "Tus preguntas, comentarios o inquietudes llegan a Elisa (RR. HH.). Aldo también puede verlos. Nada se envía a tu jefe directo.",
      outside: "Si tu inquietud es sobre RR. HH. o la dirección, contacta directamente a {name}{role}: {email}. Es una persona externa a Vanmates.",
      payBody: "Tus recibos de pago, T4 y datos de depósito están en Wagepoint.", payLink: "Abrir Wagepoint",
      privacyBody: [
        "Tú: tu perfil, tus documentos y tus días libres.",
        "Tu jefe directo: tu nombre, puesto y las fechas en que no estás; no tu contrato, tu pago ni lo que envíes a RR. HH.",
        "RR. HH. (Elisa y Aldo): tu expediente completo. Cada vez que abren un documento queda registrado y se muestra abajo.",
        "Nadie más en Vanmates. Aquí no se guardan datos bancarios, fiscales ni de identificación.",
      ],
      noneOpened: "Nadie ha abierto tus documentos.", openedRow: "{who} abrió un documento",
      tHome: "Inicio", tTime: "Vacaciones", tDocs: "Documentos", tDetails: "Mis datos", tAsk: "Preguntar a RR. HH.",
      left: "Vacaciones disponibles", waiting: "{n} solicitud esperando a RR. HH.", waitingN: "{n} solicitudes esperando a RR. HH.", nextOff: "Próximos días libres: {dates}",
      reqBtn: "Solicitar días libres", writeBtn: "Escribir a RR. HH.", openBtn: "Abrir", editBtn: "Editar mis datos", allDocs: "Ver todos los documentos",
      askBlurb: "¿Dudas sobre vacaciones, tu contrato u otra cosa? Escríbele a RR. HH. aquí.",
      hrReplied: "RR. HH. respondió: {text}", youWrote: "Escribiste: {text}",
      noEmergency: "Aún no tienes contacto de emergencia; agrega uno, por favor.",
      kVacation: "Vacaciones", kSick: "Enfermedad", kPersonal: "Personal", kind: "Tipo",
      first: "Primer día", last: "Último día", hoursOpt: "Horas (solo si es distinto)", hoursPh: "p. ej. 4 para medio día",
      noteOpt: "Nota para RR. HH. (opcional)", send: "Enviar solicitud", estimate: "{n} días hábiles · {h}", estimate1: "1 día hábil · {h}",
      estHours: "{h}", eDates: "Elige el primer día.", eOrder: "El último día es antes del primero.", eHours: "Revisa las horas.",
      eNeedHours: "Escribe cuántas horas: RR. HH. aún no configuró tu jornada.", eWeekend: "Esos días son fin de semana; escribe las horas si trabajas esos días.",
      sent: "Enviada. Elisa te responderá aquí.", myRequests: "Mis solicitudes", noRequests: "Aún no hay solicitudes.",
      sPending: "En espera", sApproved: "Aprobada", sDeclined: "Rechazada", sCancelled: "Cancelada", cancel: "Cancelar solicitud", cancelled: "Solicitud cancelada.",
      hrNote: "RR. HH.: {text}", workEmail: "Correo de trabajo", prefName: "Nombre preferido", persEmail: "Correo personal", phone: "Teléfono",
      emName: "Nombre del contacto de emergencia", emPhone: "Su teléfono", emRel: "Parentesco", save: "Guardar", saved: "Guardado.",
      fromHr: "RR. HH.", fromYou: "Tú", msgPh: "Escribe tu pregunta…", msgSend: "Enviar", noMsgs: "Aún no hay mensajes.",
      previewNote: "Vista previa: los botones no envían nada.", lockTitle: "Tu Employee Hub aún no está activo",
      lockBody: "RR. HH. lo activa para cada persona. Si crees que el tuyo debería estar activo, pregúntale a Elisa.", backPortal: "Volver al portal",
      unitDays: "{n} días", unitDay: "1 día",
    },
  };
  function t(lang, key, vars) {
    var s = (T[lang] || T.en)[key];
    if (s === undefined) s = T.en[key];
    if (typeof s !== "string") return s;
    return s.replace(/\{(\w+)\}/g, function (_, k) { return vars && vars[k] != null ? vars[k] : ""; });
  }
  function previewLang(e) { return e && e.locale === "es" ? "es" : "en"; }

  // HR-only warnings shown above the preview: things an employee would trip over if switched on today.
  function previewWarnings(e, settings, docs, balances) {
    var w = [];
    var s = settings || {};
    if (!s.outside_contact) w.push("No outside contact is set, so an employee has nowhere to raise a concern about HR or management. Set one in Settings.");
    if (!s.vacation_pay_method || s.vacation_pay_method === "unconfirmed") w.push("How vacation is paid isn’t confirmed, so the balance has no explanation. Set it in Settings.");
    var hidden = (docs || []).filter(function (d) { return d.employee_id === e.id; }).length - employeeDocs(docs, e.id).length;
    if (hidden > 0) w.push(hidden + " document" + (hidden > 1 ? "s are" : " is") + " hidden from the employee because " + (hidden > 1 ? "they aren’t" : "it isn’t") + " marked signed (or isn’t an employment document).");
    if (!hasOpening(balances, e.id)) w.push("No opening vacation balance.");
    if (e.locale === "fr") w.push("French isn’t translated yet — this preview is in English.");
    return w;
  }

  return { hoursToMinutes: hoursToMinutes, fmtBalance: fmtBalance, employeeDocs: employeeDocs, readiness: readiness,
    hasOpening: hasOpening, actorName: actorName, accessLog: accessLog, t: t, T: T, previewLang: previewLang,
    previewWarnings: previewWarnings, ENTRY: ENTRY, LEAVE: LEAVE, EMP_CATS: EMP_CATS,
    weekdays: weekdays, requestMinutes: requestMinutes, sortRequests: sortRequests };
});
