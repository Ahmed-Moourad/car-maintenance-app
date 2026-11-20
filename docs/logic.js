/* Status logic shared by the web app. Mirrors compute_status() in scripts/send_reminders.py -
   if you change one, change the other. */
(function (root) {
  "use strict";
  var DAY = 86400000;
  function pad(n) { return String(n).padStart(2, "0"); }
  function iso(d) { return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); }
  function parseDate(s) {
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  }
  function addMonths(d, n) {
    var t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
    var last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d.getUTCDate(), last)));
  }
  function num(v) {
    if (v === "" || v === null || v === undefined) return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  function normDate(v) {
    if (v === "" || v === null || v === undefined) return "";
    if (typeof v === "number") return iso(new Date(Math.round((v - 25569) * DAY)));
    var d = parseDate(v);
    return d ? iso(d) : "";
  }
  function computeStatus(item, settings, todayIso) {
    var odo = num(settings.current_odometer);
    var warnKm = num(settings.warn_km); if (warnKm === null) warnKm = 1000;
    var warnDays = num(settings.warn_days); if (warnDays === null) warnDays = 30;
    var everyKm = num(item.every_km), everyMo = num(item.every_months);
    var lastKm = num(item.last_km), lastDate = parseDate(item.last_date);
    var today = parseDate(todayIso);
    var dueKm = null, dueDate = null, kmLeft = null, daysLeft = null;
    if (everyKm && lastKm !== null) {
      dueKm = lastKm + everyKm;
      if (odo !== null) kmLeft = dueKm - odo;
    }
    if (everyMo && lastDate) {
      dueDate = addMonths(lastDate, Math.trunc(everyMo));
      daysLeft = Math.round((dueDate - today) / DAY);
    }
    var status = "unset";
    if (dueKm !== null || dueDate !== null) {
      var over = (kmLeft !== null && kmLeft < 0) || (daysLeft !== null && daysLeft < 0);
      var soon = (kmLeft !== null && kmLeft <= warnKm) || (daysLeft !== null && daysLeft <= warnDays);
      status = over ? "overdue" : soon ? "soon" : "ok";
    }
    return { status: status, dueKm: dueKm, dueDate: dueDate ? iso(dueDate) : null, kmLeft: kmLeft, daysLeft: daysLeft };
  }
  var api = { computeStatus: computeStatus, normDate: normDate, num: num, iso: iso, parseDate: parseDate, addMonths: addMonths };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Logic = api;
})(typeof window !== "undefined" ? window : this);
