/* =========================================================================
   SilverCare — application logic
   Plain JavaScript, no build step, no framework, no backend.
   Everything lives in this one file so the app can be opened directly
   (double-click index.html) or served from any static host.
   ========================================================================= */

(function () {
  "use strict";

  /* ---------------------------------------------------------------------
     Storage
     ------------------------------------------------------------------- */
  var LS_KEYS = {
    access: "silvercare_accessibility",
    meds: "silvercare_medications",
    onboarded: "silvercare_onboarded",
  };

  function loadJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* localStorage unavailable (private mode, etc.) — app still works
         for the current session, it just won't remember next time. */
    }
  }

  /* ---------------------------------------------------------------------
     Accessibility preferences
     vision:  "good" | "low" | "verylow"
     hearing: "good" | "low" | "none"
     motor:   "good" | "difficult"
     ------------------------------------------------------------------- */
  var DEFAULT_ACCESS = { vision: "good", hearing: "good", motor: "good" };
  var access = loadJSON(LS_KEYS.access, DEFAULT_ACCESS);
  var onboarded = loadJSON(LS_KEYS.onboarded, false);

  function saveAccess() {
    saveJSON(LS_KEYS.access, access);
    applyAccessibilityAttrs();
  }

  function applyAccessibilityAttrs() {
    var html = document.documentElement;
    html.setAttribute("data-vision", access.vision);
    html.setAttribute("data-hearing", access.hearing);
    html.setAttribute("data-motor", access.motor);
  }

  function voiceEnabled() {
    return access.vision !== "good";
  }
  function needsStrongVisualAlert() {
    return access.hearing !== "good";
  }
  function wantsVibration() {
    return access.hearing !== "good";
  }

  /* ---------------------------------------------------------------------
     Voice output (SpeechSynthesis) and vibration
     ------------------------------------------------------------------- */
  function speak(text) {
    if (!voiceEnabled()) return;
    if (!("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      var utter = new SpeechSynthesisUtterance(text);
      utter.lang = "ru-RU";
      utter.rate = 0.95;
      utter.pitch = 1;
      window.speechSynthesis.speak(utter);
    } catch (e) {
      /* SpeechSynthesis not available — visual info is always present too. */
    }
  }

  // A single call, with a multi-pulse pattern baked in — noticeable once,
  // never a loop that keeps buzzing until the person dismisses it.
  function vibrateOnce(pattern) {
    if (!wantsVibration()) return;
    if (!("vibrate" in navigator)) return;
    try {
      navigator.vibrate(pattern);
    } catch (e) {
      /* Vibration API not supported — visual alert still applies. */
    }
  }
  function stopVibration() {
    if ("vibrate" in navigator) {
      try {
        navigator.vibrate(0);
      } catch (e) {}
    }
  }

  /* ---------------------------------------------------------------------
     Date helpers — every date is keyed as a zero-padded "YYYY-MM-DD"
     string, which is both a safe object key and safe to compare/sort as
     plain text (lexicographic order = chronological order).
     ------------------------------------------------------------------- */
  function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
  }
  function dateKey(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function todayKey() {
    return dateKey(new Date());
  }
  function parseDateKey(key) {
    var p = key.split("-").map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }
  function addDays(d, n) {
    var r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  }
  // Monday of the week containing d (Monday-first weeks, as requested).
  function mondayOf(d) {
    var isoDay = (d.getDay() + 6) % 7; // Mon=0 ... Sun=6
    return addDays(d, -isoDay);
  }

  var WEEKDAYS = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"]; // Sun-first, for the big greeting
  var WEEKDAY_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]; // Mon-first, for calendar cells
  var WEEKDAY_FULL_MON = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"]; // Mon-first, for aria-labels
  var MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

  function formatDateHeading(key) {
    var d = parseDateKey(key);
    var label = d.getDate() + " " + MONTHS_GEN[d.getMonth()];
    if (key === todayKey()) return "Сегодня, " + label;
    if (key === dateKey(addDays(new Date(), 1))) return "Завтра, " + label;
    if (key === dateKey(addDays(new Date(), -1))) return "Вчера, " + label;
    return label;
  }

  /* ---------------------------------------------------------------------
     Medications (sample data for the demo)
     Each medication recurs daily at a fixed time. `takenDates` is the
     list of day-keys it was marked taken on — this is what powers both
     "today's status" and the multi-day history view.
     ------------------------------------------------------------------- */
  var DEFAULT_MEDS = [
    { id: "m1", name: "Амлодипин", dose: "1 таблетка", time: "09:00", takenDates: [], enabled: true },
    { id: "m2", name: "Метформин", dose: "1 таблетка", time: "14:00", takenDates: [], enabled: true },
    { id: "m3", name: "Витамин D", dose: "1 капсула", time: "20:00", takenDates: [], enabled: true },
  ];
  var medications = loadJSON(LS_KEYS.meds, DEFAULT_MEDS);
  if (!Array.isArray(medications) || medications.length === 0) {
    medications = DEFAULT_MEDS;
  }
  // Migrate any older saved shape (a single `takenDate` field) to the
  // new `takenDates` list, and make sure every medication has the fields
  // the reminders/history features need.
  medications.forEach(function (m) {
    if (!Array.isArray(m.takenDates)) m.takenDates = [];
    if (typeof m.enabled !== "boolean") m.enabled = true;
    if (m.takenDate) delete m.takenDate;
  });

  function saveMeds() {
    saveJSON(LS_KEYS.meds, medications);
  }

  function isTakenOnDate(med, key) {
    return med.takenDates.indexOf(key) !== -1;
  }
  function isTakenToday(med) {
    return isTakenOnDate(med, todayKey());
  }
  function timeToMinutes(t) {
    var parts = t.split(":");
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }
  function nowMinutes() {
    var d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }
  function findMed(id) {
    for (var i = 0; i < medications.length; i++) {
      if (medications[i].id === id) return medications[i];
    }
    return null;
  }

  // A unique id for "this medication's scheduled slot, today" — e.g.
  // "2026-09-19@14:00". Used so a reminder fires exactly once per slot,
  // no matter how many times the 15-second scheduler check runs while
  // the clock still reads 14:00, and even if the page reloads meanwhile.
  function slotKey(med) {
    return todayKey() + "@" + med.time;
  }

  // The single medication the live "next dose" flow (home card, alert,
  // demo button) cares about right now — only considers enabled
  // reminders that haven't been taken today.
  function getNextMedication() {
    var pending = medications.filter(function (m) {
      return m.enabled !== false && !isTakenToday(m);
    });
    if (pending.length === 0) return null;
    var now = nowMinutes();
    var upcoming = pending
      .filter(function (m) {
        return timeToMinutes(m.time) >= now;
      })
      .sort(function (a, b) {
        return timeToMinutes(a.time) - timeToMinutes(b.time);
      });
    if (upcoming.length > 0) return upcoming[0];
    return pending.sort(function (a, b) {
      return timeToMinutes(a.time) - timeToMinutes(b.time);
    })[0];
  }

  // Status of one medication on one specific day — drives both the
  // per-day list on "Сегодня" and every day-group in "История".
  function getMedStatusForDate(med, key) {
    if (isTakenOnDate(med, key)) return { kind: "taken", label: "Принято" };
    var today = todayKey();
    if (key > today) return { kind: "scheduled", label: "Запланировано" };
    if (key < today) return { kind: "missed", label: "Пропущено" };
    // key === today
    if (timeToMinutes(med.time) <= nowMinutes()) return { kind: "missed", label: "Пропущено" };
    var next = getNextMedication();
    if (next && next.id === med.id) return { kind: "next", label: "Следующий приём" };
    return { kind: "scheduled", label: "Запланировано" };
  }
  // Every enabled medication scheduled on a given day, in time order,
  // each paired with its status for that day.
  function getMedsForDate(key) {
    return medications
      .filter(function (m) {
        return m.enabled !== false;
      })
      .map(function (m) {
        return { med: m, status: getMedStatusForDate(m, key) };
      })
      .sort(function (a, b) {
        return timeToMinutes(a.med.time) - timeToMinutes(b.med.time);
      });
  }

  function markTaken(id) {
    var med = findMed(id);
    if (!med) return;
    var key = todayKey();
    if (med.takenDates.indexOf(key) === -1) med.takenDates.push(key);
    med.snoozeUntil = null;
    saveMeds();
  }
  function undoTaken(id) {
    var med = findMed(id);
    if (!med) return;
    var idx = med.takenDates.indexOf(todayKey());
    if (idx !== -1) med.takenDates.splice(idx, 1);
    saveMeds();
  }
  function snoozeMed(id, minutes) {
    var med = findMed(id);
    if (!med) return;
    med.snoozeUntil = Date.now() + minutes * 60 * 1000;
    saveMeds();
  }
  function setReminderEnabled(id, enabled) {
    var med = findMed(id);
    if (!med) return;
    med.enabled = enabled;
    saveMeds();
    render();
  }
  function setReminderTime(id, timeStr) {
    var med = findMed(id);
    if (!med || !timeStr) return;
    med.time = timeStr;
    med.lastAlertSlot = null; // a changed time is a fresh slot
    saveMeds();
    render();
  }

  /* ---------------------------------------------------------------------
     App state / router
     ------------------------------------------------------------------- */
  var state = {
    screen: onboarded ? "today" : "onb-welcome",
    params: {},
  };

  function navigate(screen, params) {
    stopVibration();
    state.screen = screen;
    state.params = params || {};
    render();
  }

  var appEl = document.getElementById("app");
  var announcerEl = document.getElementById("sr-announcer");

  function announce(text) {
    if (announcerEl) announcerEl.textContent = text;
  }

  function focusMain() {
    var heading = appEl.querySelector("h1, [data-autofocus]");
    if (heading) {
      if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
      heading.focus();
    }
  }

  /* ---------------------------------------------------------------------
     Scheduler — checks every 15 seconds whether a medication is due.
     ------------------------------------------------------------------- */
  function checkSchedule() {
    if (state.screen === "alert") return;
    if (state.screen.indexOf("onb-") === 0) return;
    var now = nowMinutes();
    for (var i = 0; i < medications.length; i++) {
      var med = medications[i];
      if (med.enabled === false) continue;
      if (isTakenToday(med)) continue;
      var dueBySnooze = med.snoozeUntil && Date.now() >= med.snoozeUntil;
      var currentSlot = slotKey(med);
      // Only due "by time" if the clock matches AND we haven't already
      // alerted for this exact slot today — the clock reads e.g. 14:00
      // for a full 60 seconds, checked every 15s, so without this guard
      // the same reminder could fire several times in a row.
      var dueByTime = !med.snoozeUntil && timeToMinutes(med.time) === now && med.lastAlertSlot !== currentSlot;
      if (dueBySnooze || dueByTime) {
        med.snoozeUntil = null;
        med.lastAlertSlot = currentSlot;
        saveMeds();
        triggerAlert(med.id);
        return;
      }
    }
  }

  function triggerAlert(medId) {
    navigate("alert", { medId: medId });
  }

  setInterval(checkSchedule, 15000);

  /* ---------------------------------------------------------------------
     Small render helpers
     ------------------------------------------------------------------- */
  function on(node, event, handler) {
    if (node) node.addEventListener(event, handler);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* =======================================================================
     ICONS — a small hand-drawn line-icon set (stroke=currentColor), used
     everywhere instead of emoji. Emoji render as a different, uncontrolled
     picture on every OS and can't pick up the app's colours; these do both,
     which is most of what makes the UI read as one designed product.
     ======================================================================= */
  var ICONS = {
    home: '<path d="M4 10.5 12 4l8 6.5"/><path d="M6 9.5V19a1 1 0 0 0 1 1h3v-5a2 2 0 0 1 4 0v5h3a1 1 0 0 0 1-1V9.5"/>',
    pill: '<rect x="2.5" y="9" width="19" height="6" rx="3"/><line x1="12" y1="9" x2="12" y2="15"/>',
    bell: '<path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 6 2 6H4c.5 0 2-2 2-6Z"/><path d="M9.5 18a2.5 2.5 0 0 0 5 0"/>',
    bellOff: '<path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 6 2 6H4c.5 0 2-2 2-6Z"/><path d="M9.5 18a2.5 2.5 0 0 0 5 0"/><line x1="3" y1="3" x2="21" y2="21"/>',
    history: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3.5h6a1 1 0 0 1 1 1V6H8V4.5a1 1 0 0 1 1-1Z"/><line x1="8.5" y1="11" x2="15.5" y2="11"/><line x1="8.5" y1="14.5" x2="15.5" y2="14.5"/><line x1="8.5" y1="18" x2="13" y2="18"/>',
    settings: '<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="16" cy="12" r="2"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="11" cy="18" r="2"/>',
    eyeGood: '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    eyeLow: '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z"/><line x1="4.5" y1="12" x2="19.5" y2="12"/>',
    eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.6A11 11 0 0 1 12 5.5c6.5 0 10 6.5 10 6.5a15.3 15.3 0 0 1-3.2 4"/><path d="M6.2 6.2C3.6 7.9 2 12 2 12s3.5 6.5 10 6.5c1.4 0 2.7-.3 3.8-.8"/><path d="M9.5 14.5a3 3 0 0 0 4-4"/>',
    earGood: '<path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a8 8 0 0 1 0 11"/>',
    earLow: '<path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16 9a4 4 0 0 1 0 6"/>',
    earOff: '<path d="M4 9v6h4l5 4V5L8 9H4Z"/><line x1="16" y1="9" x2="21" y2="14"/><line x1="21" y1="9" x2="16" y2="14"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
    alertCircle: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="7.5" x2="12" y2="13"/><circle cx="12" cy="16.2" r="1" fill="currentColor" stroke="none"/>',
    clockDial: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    hourglass: '<path d="M6.5 3h11"/><path d="M6.5 21h11"/><path d="M7.5 3c0 4.8 3.7 5.1 4.5 6 .8-.9 4.5-1.2 4.5-6"/><path d="M7.5 21c0-4.8 3.7-5.1 4.5-6 .8.9 4.5 1.2 4.5 6"/>',
    alertTriangle: '<path d="M12 4 2 20h20L12 4Z"/><line x1="12" y1="10.2" x2="12" y2="14.2"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>',
    alarmClock: '<circle cx="12" cy="13.5" r="8"/><path d="M12 10v3.5l3 2"/><path d="M5 3 2 6"/><path d="M19 3l3 3"/><line x1="9" y1="2.5" x2="15" y2="2.5"/>',
    chevronLeft: '<path d="M15 5l-7 7 7 7"/>',
    chevronRight: '<path d="M9 5l7 7-7 7"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.8 2.8-2-2 2.8-2.8Z"/>',
    refresh: '<path d="M20 11A8 8 0 1 0 18.5 16"/><path d="M20 6v5h-5"/>',
    bulb: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z"/>',
    star: '<path d="M12 3l2.6 5.9 6.4.6-4.9 4.2 1.5 6.3L12 16.9 6.4 20l1.5-6.3-4.9-4.2 6.4-.6L12 3Z"/>',
    smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8"/><circle cx="9" cy="9.5" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="9.5" r="1" fill="currentColor" stroke="none"/>',
  };
  function icon(name, extraClass) {
    var body = ICONS[name] || "";
    return (
      '<svg class="icon' + (extraClass ? " " + extraClass : "") + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      body +
      "</svg>"
    );
  }
  function statusIconName(kind) {
    return { taken: "checkCircle", next: "hourglass", scheduled: "clockDial", missed: "alertTriangle" }[kind] || "clockDial";
  }

  /* =======================================================================
     BOTTOM NAVIGATION — persistent on every main tab screen.
     Every item pairs a large icon with a visible Russian label, and the
     active tab is marked with more than color alone: a background pill,
     a bold label, a slightly larger icon and a small top indicator bar.
     ======================================================================= */

  var NAV_ITEMS = [
    { key: "today", icon: "home", label: "Сегодня" },
    { key: "medications", icon: "pill", label: "Лекарства" },
    { key: "reminders", icon: "bell", label: "Напоминания" },
    { key: "history", icon: "history", label: "История" },
    { key: "settings", icon: "settings", label: "Настройки" },
  ];

  function bottomNavHtml(active) {
    var items = NAV_ITEMS.map(function (item) {
      var isActive = item.key === active;
      return (
        '<button class="nav-item" data-nav="' + item.key + '"' +
        (isActive ? ' aria-current="page"' : "") +
        ' aria-label="' + item.label + '">' +
        '<span class="nav-item__icon" aria-hidden="true">' + icon(item.icon) + "</span>" +
        '<span class="nav-item__label">' + item.label + "</span>" +
        "</button>"
      );
    }).join("");
    return '<nav class="bottom-nav" aria-label="Основная навигация">' + items + "</nav>";
  }

  function bindBottomNav() {
    Array.prototype.forEach.call(document.querySelectorAll(".nav-item"), function (btn) {
      on(btn, "click", function () {
        var key = btn.getAttribute("data-nav");
        if (key !== state.screen) navigate(key);
      });
    });
  }

  // Wraps a tab screen's inner content with the scrollable content area
  // and the persistent bottom nav. Tab screens can scroll if their
  // content is tall (a long list, big accessibility text); the nav
  // itself never moves.
  function renderTabShell(active, innerHtml) {
    appEl.innerHTML =
      '<div class="tab-content"><div class="screen screen--tab">' + innerHtml + "</div></div>" +
      bottomNavHtml(active);
    bindBottomNav();
  }

  /* =======================================================================
     WEEKLY CALENDAR — shared by the "Сегодня" tab.
     ======================================================================= */

  var calendarWeekStart = mondayOf(new Date());
  var selectedDateKey = todayKey();
  var pendingFocusId = null; // element id to refocus after a calendar-driven re-render

  function goToWeek(offsetWeeks) {
    pendingFocusId = offsetWeeks < 0 ? "btn-week-prev" : "btn-week-next";
    calendarWeekStart = addDays(calendarWeekStart, offsetWeeks * 7);
    render();
  }

  function selectDate(key) {
    pendingFocusId = "daycell-" + key;
    selectedDateKey = key;
    var mon = mondayOf(parseDateKey(key));
    if (dateKey(mon) !== dateKey(calendarWeekStart)) calendarWeekStart = mon;
    render();
  }

  function dayCellAriaLabel(d, key) {
    var weekdayFull = WEEKDAY_FULL_MON[(d.getDay() + 6) % 7];
    var label = weekdayFull + ", " + d.getDate() + " " + MONTHS_GEN[d.getMonth()];
    if (key === todayKey()) label += ", сегодня";
    return label;
  }

  function renderCalendarHtml() {
    var cells = [];
    for (var i = 0; i < 7; i++) {
      var d = addDays(calendarWeekStart, i);
      var key = dateKey(d);
      var isToday = key === todayKey();
      var isSelected = key === selectedDateKey;
      var cls = "day-cell" + (isToday ? " day-cell--today" : "") + (isSelected ? " day-cell--selected" : "");
      cells.push(
        '<button class="' + cls + '" id="daycell-' + key + '" data-date="' + key + '" aria-pressed="' +
        (isSelected ? "true" : "false") + '" aria-label="' + dayCellAriaLabel(d, key) + '">' +
        '<span class="day-cell__label" aria-hidden="true">' + WEEKDAY_SHORT[(d.getDay() + 6) % 7] + "</span>" +
        '<span class="day-cell__num" aria-hidden="true">' + d.getDate() + "</span>" +
        "</button>"
      );
    }
    return (
      '<div class="week-calendar" role="group" aria-label="Выбор дня недели">' +
      '<button class="week-nav-btn" id="btn-week-prev" aria-label="Предыдущая неделя">' + icon("chevronLeft") + "</button>" +
      '<div class="week-row" id="week-row">' + cells.join("") + "</div>" +
      '<button class="week-nav-btn" id="btn-week-next" aria-label="Следующая неделя">' + icon("chevronRight") + "</button>" +
      "</div>"
    );
  }

  function bindCalendarEvents() {
    on(document.getElementById("btn-week-prev"), "click", function () {
      goToWeek(-1);
    });
    on(document.getElementById("btn-week-next"), "click", function () {
      goToWeek(1);
    });
    Array.prototype.forEach.call(document.querySelectorAll(".day-cell"), function (btn) {
      var key = btn.getAttribute("data-date");
      on(btn, "click", function () {
        selectDate(key);
      });
      on(btn, "keydown", function (ev) {
        var delta = 0;
        if (ev.key === "ArrowLeft") delta = -1;
        else if (ev.key === "ArrowRight") delta = 1;
        else if (ev.key === "ArrowUp") delta = -7;
        else if (ev.key === "ArrowDown") delta = 7;
        if (delta !== 0) {
          ev.preventDefault();
          selectDate(dateKey(addDays(parseDateKey(key), delta)));
        }
      });
    });
    if (pendingFocusId) {
      var toFocus = document.getElementById(pendingFocusId);
      if (toFocus) toFocus.focus();
      pendingFocusId = null;
    }
    // When larger text makes the week wider than the screen, make sure the
    // selected day is scrolled into view rather than hidden off to the side.
    var selectedEl = document.querySelector(".day-cell--selected");
    if (selectedEl && selectedEl.scrollIntoView) {
      selectedEl.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  /* =======================================================================
     Shared medication row (used by "Сегодня" and "История")
     ======================================================================= */

  function medRowHtml(med, status) {
    return (
      '<div class="med-row">' +
      '<span class="med-row__icon" aria-hidden="true">' + icon("pill") + "</span>" +
      '<div class="med-row__body">' +
      '<span class="med-row__name">' + escapeHtml(med.name) + "</span>" +
      '<span class="med-row__meta">' + escapeHtml(med.dose) + "</span>" +
      "</div>" +
      '<span class="med-row__time">' + escapeHtml(med.time) + "</span>" +
      '<span class="med-row__status med-row__status--' + status.kind + '">' +
      icon(statusIconName(status.kind)) + "<span>" + status.label + "</span>" +
      "</span>" +
      "</div>"
    );
  }

  /* =======================================================================
     ONBOARDING
     ======================================================================= */

  function renderOnboardingWelcome() {
    appEl.innerHTML =
      '<div class="screen screen--center">' +
      '<h1 class="title" data-autofocus>Добро пожаловать в SilverCare</h1>' +
      '<p class="lead">Давайте настроим приложение так, чтобы вам было удобно им пользоваться.</p>' +
      '<div class="btn-stack" style="margin-top:1.2rem;">' +
      '<button class="btn btn--primary btn--huge" id="btn-start">НАЧАТЬ</button>' +
      "</div>" +
      "</div>";
    on(document.getElementById("btn-start"), "click", function () {
      navigate("onb-vision");
    });
    focusMain();
  }

  function renderProgress(step, total) {
    var dots = "";
    for (var i = 0; i < total; i++) {
      dots += '<span class="progress-dot' + (i === step ? " progress-dot--active" : "") + '"></span>';
    }
    return '<div class="progress" aria-hidden="true">' + dots + "</div>";
  }

  function renderOnboardingVision() {
    appEl.innerHTML =
      '<div class="screen">' +
      renderProgress(0, 3) +
      '<h1 class="title" data-autofocus>Хорошо ли вы видите текст на экране?</h1>' +
      '<div class="choice-list" role="group" aria-label="Выберите вариант">' +
      '<button class="choice-btn" data-value="good"><span class="choice-icon" aria-hidden="true">' + icon("eyeGood") + '</span><span>ВИЖУ ХОРОШО</span></button>' +
      '<button class="choice-btn" data-value="low"><span class="choice-icon" aria-hidden="true">' + icon("eyeLow") + '</span><span>ВИЖУ ПЛОХО</span></button>' +
      '<button class="choice-btn" data-value="verylow"><span class="choice-icon" aria-hidden="true">' + icon("eyeOff") + '</span><span>ПОЧТИ НЕ ВИЖУ</span></button>' +
      "</div>" +
      "</div>";
    Array.prototype.forEach.call(document.querySelectorAll(".choice-btn"), function (btn) {
      on(btn, "click", function () {
        access.vision = btn.getAttribute("data-value");
        saveAccess();
        navigate("onb-hearing");
      });
    });
    focusMain();
  }

  function renderOnboardingHearing() {
    appEl.innerHTML =
      '<div class="screen">' +
      renderProgress(1, 3) +
      '<h1 class="title" data-autofocus>Хорошо ли вы слышите звуки телефона?</h1>' +
      '<div class="choice-list" role="group" aria-label="Выберите вариант">' +
      '<button class="choice-btn" data-value="good"><span class="choice-icon" aria-hidden="true">' + icon("earGood") + '</span><span>СЛЫШУ ХОРОШО</span></button>' +
      '<button class="choice-btn" data-value="low"><span class="choice-icon" aria-hidden="true">' + icon("earLow") + '</span><span>СЛЫШУ ПЛОХО</span></button>' +
      '<button class="choice-btn" data-value="none"><span class="choice-icon" aria-hidden="true">' + icon("earOff") + '</span><span>НЕ СЛЫШУ</span></button>' +
      "</div>" +
      "</div>";
    Array.prototype.forEach.call(document.querySelectorAll(".choice-btn"), function (btn) {
      on(btn, "click", function () {
        access.hearing = btn.getAttribute("data-value");
        saveAccess();
        navigate("onb-motor");
      });
    });
    focusMain();
  }

  function renderOnboardingMotor() {
    appEl.innerHTML =
      '<div class="screen">' +
      renderProgress(2, 3) +
      '<h1 class="title" data-autofocus>Удобно ли вам нажимать кнопки на экране?</h1>' +
      '<div class="choice-list" role="group" aria-label="Выберите вариант">' +
      '<button class="choice-btn" data-value="good"><span class="choice-icon" aria-hidden="true">' + icon("checkCircle") + '</span><span>ДА</span></button>' +
      '<button class="choice-btn" data-value="difficult"><span class="choice-icon" aria-hidden="true">' + icon("alertCircle") + '</span><span>МНЕ ТРУДНО</span></button>' +
      "</div>" +
      "</div>";
    Array.prototype.forEach.call(document.querySelectorAll(".choice-btn"), function (btn) {
      on(btn, "click", function () {
        access.motor = btn.getAttribute("data-value");
        saveAccess();
        navigate("onb-finish");
      });
    });
    focusMain();
  }

  function renderOnboardingFinish() {
    appEl.innerHTML =
      '<div class="screen screen--center">' +
      '<div class="alert-icon" aria-hidden="true">' + icon("checkCircle") + "</div>" +
      '<h1 class="title" data-autofocus>SilverCare настроен для вас</h1>' +
      '<div class="btn-stack" style="margin-top:1.2rem;">' +
      '<button class="btn btn--primary btn--huge" id="btn-continue">ПРОДОЛЖИТЬ</button>' +
      "</div>" +
      "</div>";
    on(document.getElementById("btn-continue"), "click", function () {
      onboarded = true;
      saveJSON(LS_KEYS.onboarded, true);
      navigate("today");
    });
    focusMain();
    speak("SilverCare настроен для вас.");
  }

  /* =======================================================================
     СЕГОДНЯ (Today) — clock, weekly calendar, the selected day's
     medications, and the live "take it now" actions when viewing today.
     ======================================================================= */

  var clockTimer = null;

  function formatClock(d) {
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function renderToday() {
    var now = new Date();
    var isToday = selectedDateKey === todayKey();
    var dayMeds = getMedsForDate(selectedDateKey);
    var next = isToday ? getNextMedication() : null;

    var listHtml = dayMeds.length
      ? '<div class="stack-gap">' + dayMeds.map(function (x) {
          return medRowHtml(x.med, x.status);
        }).join("") + "</div>"
      : '<p class="empty-note">На этот день приёмов нет.</p>';

    var actionsHtml = next
      ? '<div class="home-actions">' +
        '<button class="btn btn--primary btn--huge" id="btn-taken">Я ПРИНЯЛ(А)</button>' +
        '<button class="btn btn--secondary" id="btn-snooze">НАПОМНИТЬ ПОЗЖЕ</button>' +
        "</div>"
      : "";

    var hadPendingFocus = !!pendingFocusId;

    var inner =
      '<div class="home-header">' +
      '<h1 class="clock" data-autofocus id="today-clock" aria-label="Текущее время ' + escapeHtml(formatClock(now)) + '">' +
      escapeHtml(formatClock(now)) + "</h1>" +
      '<p class="day-name" id="today-day">' + WEEKDAYS[now.getDay()] + "</p>" +
      "</div>" +
      renderCalendarHtml() +
      '<h2 class="date-heading">' + escapeHtml(formatDateHeading(selectedDateKey)) + "</h2>" +
      listHtml +
      actionsHtml +
      '<button class="btn btn--secondary btn--compact" id="btn-exercise" aria-label="Открыть упражнение для памяти">' +
      '<span aria-hidden="true">' + icon("bulb") + '</span> <span>Упражнение для памяти</span></button>';

    renderTabShell("today", inner);
    bindCalendarEvents();

    if (next) {
      on(document.getElementById("btn-taken"), "click", function () {
        markTaken(next.id);
        navigate("confirmation", { medId: next.id, from: "today" });
      });
      on(document.getElementById("btn-snooze"), "click", function () {
        snoozeMed(next.id, 10);
        announce("Напомним через 10 минут.");
        render();
      });
    }
    on(document.getElementById("btn-exercise"), "click", function () {
      navigate("exercise");
    });

    if (!hadPendingFocus) focusMain();

    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(function () {
      if (state.screen !== "today") {
        clearInterval(clockTimer);
        clockTimer = null;
        return;
      }
      var d = new Date();
      var clockEl = document.getElementById("today-clock");
      var dayEl = document.getElementById("today-day");
      if (clockEl) {
        clockEl.textContent = formatClock(d);
        clockEl.setAttribute("aria-label", "Текущее время " + formatClock(d));
      }
      if (dayEl) dayEl.textContent = WEEKDAYS[d.getDay()];
    }, 15000);
  }

  /* =======================================================================
     ЛЕКАРСТВА (Medications) — the full roster, read-only.
     ======================================================================= */

  function renderMedicationsTab() {
    var sorted = medications.slice().sort(function (a, b) {
      return timeToMinutes(a.time) - timeToMinutes(b.time);
    });
    var listHtml = sorted.length
      ? '<div class="stack-gap">' + sorted.map(function (med) {
          var medOn = med.enabled !== false;
          return (
            '<div class="med-row">' +
            '<span class="med-row__icon" aria-hidden="true">' + icon("pill") + "</span>" +
            '<div class="med-row__body">' +
            '<span class="med-row__name">' + escapeHtml(med.name) + "</span>" +
            '<span class="med-row__meta">' + escapeHtml(med.dose) + "</span>" +
            "</div>" +
            '<span class="med-row__time">' + escapeHtml(med.time) + "</span>" +
            '<span class="med-row__status med-row__status--' + (medOn ? "taken" : "missed") + '">' +
            icon(medOn ? "checkCircle" : "bellOff") + "<span>" + (medOn ? "Включено" : "Выключено") + "</span>" +
            "</span>" +
            "</div>"
          );
        }).join("") + "</div>"
      : '<p class="empty-note">Список лекарств пуст.</p>';

    var inner = '<h1 class="title" data-autofocus>Лекарства</h1>' + listHtml;
    renderTabShell("medications", inner);
    focusMain();
  }

  /* =======================================================================
     НАПОМИНАНИЯ (Reminders) — enable/disable and adjust the time of each
     recurring reminder.
     ======================================================================= */

  function renderRemindersTab() {
    var sorted = medications.slice().sort(function (a, b) {
      return timeToMinutes(a.time) - timeToMinutes(b.time);
    });

    var rowsHtml = sorted.map(function (med) {
      var on_ = med.enabled !== false;
      return (
        '<div class="reminder-row">' +
        '<div class="reminder-row__top">' +
        '<span class="med-row__icon" aria-hidden="true">' + icon("pill") + "</span>" +
        '<div class="med-row__body">' +
        '<span class="med-row__name">' + escapeHtml(med.name) + "</span>" +
        '<span class="med-row__meta">' + escapeHtml(med.dose) + "</span>" +
        "</div>" +
        "</div>" +
        '<div class="reminder-controls">' +
        '<label class="reminder-time-label" for="time-' + med.id + '">Время</label>' +
        '<input type="time" id="time-' + med.id + '" class="time-input" value="' + escapeHtml(med.time) +
        '" aria-label="Время приёма: ' + escapeHtml(med.name) + '" data-med="' + med.id + '">' +
        '<button class="toggle-btn' + (on_ ? " toggle-btn--on" : "") + '" data-toggle="' + med.id +
        '" aria-pressed="' + (on_ ? "true" : "false") + '">' +
        '<span aria-hidden="true">' + icon(on_ ? "bell" : "bellOff") + "</span>" +
        "<span>" + (on_ ? "Включено" : "Выключено") + "</span>" +
        "</button>" +
        "</div>" +
        "</div>"
      );
    }).join("");

    var inner =
      '<h1 class="title" data-autofocus>Напоминания</h1>' +
      '<p class="lead lead--tight">Включайте, выключайте и меняйте время приёма.</p>' +
      '<div class="stack-gap">' + rowsHtml + "</div>";

    renderTabShell("reminders", inner);

    Array.prototype.forEach.call(document.querySelectorAll(".time-input"), function (input) {
      on(input, "change", function () {
        setReminderTime(input.getAttribute("data-med"), input.value);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll(".toggle-btn"), function (btn) {
      on(btn, "click", function () {
        var id = btn.getAttribute("data-toggle");
        var med = findMed(id);
        setReminderEnabled(id, !(med && med.enabled !== false));
      });
    });

    focusMain();
  }

  /* =======================================================================
     ИСТОРИЯ (History) — the last 7 days, most recent first.
     ======================================================================= */

  function renderHistoryTab() {
    var groups = [];
    for (var i = 0; i < 7; i++) {
      var key = dateKey(addDays(new Date(), -i));
      var dayMeds = getMedsForDate(key);
      var listHtml = dayMeds.length
        ? '<div class="stack-gap">' + dayMeds.map(function (x) {
            return medRowHtml(x.med, x.status);
          }).join("") + "</div>"
        : '<p class="empty-note">На этот день приёмов нет.</p>';
      groups.push(
        '<div class="history-group">' +
        '<h2 class="history-group__heading">' + escapeHtml(formatDateHeading(key)) + "</h2>" +
        listHtml +
        "</div>"
      );
    }

    var inner = '<h1 class="title" data-autofocus>История приёма</h1>' + groups.join("");
    renderTabShell("history", inner);
    focusMain();
  }

  /* =======================================================================
     MEDICATION ALERT (full screen, no bottom nav — this must interrupt)
     ======================================================================= */

  function renderAlert() {
    var med = findMed(state.params.medId) || medications[0];
    var pulseClass = needsStrongVisualAlert() ? " pulse" : "";

    appEl.innerHTML =
      '<div class="alert-screen' + pulseClass + '" role="alertdialog" aria-live="assertive" aria-label="Напоминание о приёме лекарства">' +
      '<div class="alert-icon" aria-hidden="true">' + icon("alarmClock") + "</div>" +
      '<h1 class="alert-title" data-autofocus>ПОРА ПРИНЯТЬ ЛЕКАРСТВО</h1>' +
      '<p class="alert-med">' + escapeHtml(med.name) + " — " + escapeHtml(med.dose) + "</p>" +
      '<div class="btn-stack">' +
      '<button class="btn btn--success btn--huge" id="btn-alert-taken">Я ПРИНЯЛ(А)</button>' +
      '<button class="btn btn--secondary" id="btn-alert-snooze">НАПОМНИТЬ ПОЗЖЕ</button>' +
      "</div>" +
      "</div>";

    on(document.getElementById("btn-alert-taken"), "click", function () {
      markTaken(med.id);
      navigate("confirmation", { medId: med.id, from: "alert" });
    });
    on(document.getElementById("btn-alert-snooze"), "click", function () {
      snoozeMed(med.id, 10);
      navigate("today");
    });

    focusMain();
    speak("Пора принять лекарство. " + med.name + ". " + med.dose + ".");
    // One noticeable multi-pulse buzz, not a loop — the reminder should
    // announce itself once and then just wait on screen, not keep buzzing.
    vibrateOnce([500, 200, 500, 200, 500, 200, 500]);
  }

  /* =======================================================================
     CONFIRMATION
     ======================================================================= */

  var confirmTimer = null;

  function renderConfirmation() {
    var med = findMed(state.params.medId);
    var medName = med ? med.name : "";

    appEl.innerHTML =
      '<div class="confirm-screen" role="status">' +
      '<div class="confirm-check" aria-hidden="true">' + icon("checkCircle") + "</div>" +
      '<h1 class="confirm-title" data-autofocus>СПАСИБО!</h1>' +
      '<p class="confirm-sub">ПРИЁМ ЛЕКАРСТВА ОТМЕЧЕН' + (medName ? ": " + escapeHtml(medName) : "") + "</p>" +
      '<div class="btn-stack" style="max-width:420px;margin-top:1rem;">' +
      '<button class="btn btn--ghost" id="btn-undo">ОТМЕНИТЬ</button>' +
      "</div>" +
      "</div>";

    on(document.getElementById("btn-undo"), "click", function () {
      if (confirmTimer) clearTimeout(confirmTimer);
      if (med) undoTaken(med.id);
      announce("Отменено.");
      navigate("today");
    });

    focusMain();
    speak("Приём лекарства отмечен.");

    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = setTimeout(function () {
      if (state.screen === "confirmation") navigate("today");
    }, 4000);
  }

  /* =======================================================================
     MEMORY EXERCISE
     ======================================================================= */

  function getCurrentSeasonRu() {
    var month = new Date().getMonth() + 1; // 1-12
    if (month === 12 || month === 1 || month === 2) return "ЗИМА";
    if (month >= 3 && month <= 5) return "ВЕСНА";
    if (month >= 6 && month <= 8) return "ЛЕТО";
    return "ОСЕНЬ";
  }

  function renderExercise() {
    appEl.innerHTML =
      '<div class="screen">' +
      '<h1 class="title" data-autofocus>Упражнение для памяти</h1>' +
      '<p class="lead">Какое сейчас время года?</p>' +
      '<div class="exercise-grid" role="group" aria-label="Варианты ответа">' +
      '<button class="btn btn--primary exercise-btn" data-value="ЗИМА">ЗИМА</button>' +
      '<button class="btn btn--primary exercise-btn" data-value="ВЕСНА">ВЕСНА</button>' +
      '<button class="btn btn--primary exercise-btn" data-value="ЛЕТО">ЛЕТО</button>' +
      '<button class="btn btn--primary exercise-btn" data-value="ОСЕНЬ">ОСЕНЬ</button>' +
      "</div>" +
      '<button class="btn btn--ghost" id="btn-exercise-back" style="margin-top:1rem;">Назад</button>' +
      "</div>";

    Array.prototype.forEach.call(document.querySelectorAll(".exercise-btn"), function (btn) {
      on(btn, "click", function () {
        var chosen = btn.getAttribute("data-value");
        var actual = getCurrentSeasonRu();
        navigate("exercise-feedback", { correct: chosen === actual, actual: actual });
      });
    });
    on(document.getElementById("btn-exercise-back"), "click", function () {
      navigate("today");
    });
    focusMain();
  }

  function renderExerciseFeedback() {
    var correct = state.params.correct;
    var actual = state.params.actual;
    var feedbackIconName = correct ? "star" : "smile";
    var title = correct ? "ПРАВИЛЬНО!" : "ХОРОШО!";
    var sub = correct ? "Отличная память." : "Сейчас на самом деле: " + escapeHtml(actual) + ".";

    appEl.innerHTML =
      '<div class="screen screen--center">' +
      '<div class="feedback-icon' + (correct ? " feedback-icon--star" : "") + '" aria-hidden="true">' + icon(feedbackIconName) + "</div>" +
      '<h1 class="title" data-autofocus>' + title + "</h1>" +
      '<p class="lead">' + sub + "</p>" +
      '<div class="btn-stack" style="margin-top:1.2rem;max-width:420px;">' +
      '<button class="btn btn--primary btn--huge" id="btn-back-home">НА ГЛАВНЫЙ ЭКРАН</button>' +
      "</div>" +
      "</div>";

    on(document.getElementById("btn-back-home"), "click", function () {
      navigate("today");
    });
    focusMain();
    if (correct) speak("Правильно! Отличная память.");
    else speak("Хорошо. Сейчас на самом деле " + actual + ".");
  }

  /* =======================================================================
     НАСТРОЙКИ (Settings)
     ======================================================================= */

  var VISION_LABELS = { good: "Вижу хорошо", low: "Вижу плохо", verylow: "Почти не вижу" };
  var HEARING_LABELS = { good: "Слышу хорошо", low: "Слышу плохо", none: "Не слышу" };
  var MOTOR_LABELS = { good: "Да, удобно", difficult: "Мне трудно" };

  function renderSettings() {
    var inner =
      '<h1 class="title" data-autofocus>Настройки</h1>' +
      '<dl class="settings-summary">' +
      "<div class=\"row\"><dt>Зрение</dt><dd>" + (VISION_LABELS[access.vision] || access.vision) + "</dd></div>" +
      "<div class=\"row\"><dt>Слух</dt><dd>" + (HEARING_LABELS[access.hearing] || access.hearing) + "</dd></div>" +
      "<div class=\"row\"><dt>Кнопки</dt><dd>" + (MOTOR_LABELS[access.motor] || access.motor) + "</dd></div>" +
      "</dl>" +
      '<div class="btn-stack">' +
      '<button class="btn btn--primary" id="btn-redo-onboarding">' + icon("refresh") + "<span>ПОВТОРИТЬ НАСТРОЙКУ</span></button>" +
      '<button class="btn btn--secondary" id="btn-demo-alert">' + icon("wrench") + "<span>НАПОМНИТЬ СЕЙЧАС (ДЕМО)</span></button>" +
      "</div>";

    renderTabShell("settings", inner);

    on(document.getElementById("btn-redo-onboarding"), "click", function () {
      navigate("onb-vision");
    });
    on(document.getElementById("btn-demo-alert"), "click", function () {
      var med = getNextMedication() || medications.filter(function (m) { return m.enabled !== false; })[0] || medications[0];
      if (med) triggerAlert(med.id);
    });
    focusMain();
  }

  /* =======================================================================
     Router table
     ======================================================================= */

  var SCREENS = {
    "onb-welcome": renderOnboardingWelcome,
    "onb-vision": renderOnboardingVision,
    "onb-hearing": renderOnboardingHearing,
    "onb-motor": renderOnboardingMotor,
    "onb-finish": renderOnboardingFinish,
    today: renderToday,
    medications: renderMedicationsTab,
    reminders: renderRemindersTab,
    history: renderHistoryTab,
    alert: renderAlert,
    confirmation: renderConfirmation,
    exercise: renderExercise,
    "exercise-feedback": renderExerciseFeedback,
    settings: renderSettings,
  };

  function render() {
    var fn = SCREENS[state.screen];
    if (!fn) fn = renderToday;
    fn();
  }

  /* ---------------------------------------------------------------------
     Init
     ------------------------------------------------------------------- */
  applyAccessibilityAttrs();
  render();
})();
