/* =========================================================================
   SilverCare — application logic
   Plain JavaScript, no build step, no framework, no backend.
   Everything lives in this one file so the app can be opened directly
   (double-click index.html) or served from any static host.

   NOT a medical device: SilverCare never gives medical advice, never
   suggests changing a dose, never tells anyone to take an extra dose
   after a missed one, and the memory exercises never claim to diagnose,
   treat or prevent any condition.
   ========================================================================= */

(function () {
  "use strict";

  /* ---------------------------------------------------------------------
     Storage — one small service layer, everything else calls these.
     ------------------------------------------------------------------- */
  var LS_KEYS = {
    profile: "silvercare_profile",
    access: "silvercare_accessibility",
    settings: "silvercare_settings",
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
      /* localStorage unavailable (private mode, full quota, etc.) — the
         app still works for the current session, it just won't remember
         next time. Never let a storage failure break the UI. */
    }
  }

  /* ---------------------------------------------------------------------
     Profile (name)
     ------------------------------------------------------------------- */
  var profile = loadJSON(LS_KEYS.profile, { name: "" });
  if (!profile || typeof profile !== "object") profile = { name: "" };
  if (typeof profile.name !== "string") profile.name = "";
  function saveProfile() {
    saveJSON(LS_KEYS.profile, profile);
  }

  /* ---------------------------------------------------------------------
     Accessibility onboarding answers.
     vision:  "good" | "low" | "verylow"
     hearing: "good" | "low" | "none"
     motor:   "good" | "difficult"
     These seed the independent Settings below, but Settings can then be
     changed on their own — vision/hearing/motor are not three separate
     apps, they combine, and after onboarding the user stays in control.
     ------------------------------------------------------------------- */
  var DEFAULT_ACCESS = { vision: "good", hearing: "good", motor: "good" };
  var access = loadJSON(LS_KEYS.access, DEFAULT_ACCESS);
  if (!access || typeof access !== "object") access = DEFAULT_ACCESS;

  function saveAccess() {
    saveJSON(LS_KEYS.access, access);
  }

  /* ---------------------------------------------------------------------
     Settings — the ONE place that actually controls the interface.
     Seeded from the accessibility answers the first time onboarding
     finishes, then fully independent and user-editable from Настройки.
     ------------------------------------------------------------------- */
  var DEFAULT_SETTINGS = {
    voice: false,
    textSize: "normal", // "normal" | "large" | "xlarge"
    highContrast: false,
    exercisesEnabled: true,
    language: "ru", // only "ru" implemented; "kk" reserved for later
  };
  var settings = loadJSON(LS_KEYS.settings, null);
  if (!settings || typeof settings !== "object") settings = null;

  function seedSettingsFromAccess() {
    settings = {
      voice: access.vision !== "good",
      textSize: access.vision === "verylow" ? "xlarge" : access.vision === "low" ? "large" : "normal",
      highContrast: access.vision === "verylow",
      exercisesEnabled: true,
      language: "ru",
    };
    saveSettings();
  }
  function saveSettings() {
    saveJSON(LS_KEYS.settings, settings);
    applyAccessibilityAttrs();
  }
  if (!settings) seedSettingsFromAccess();

  var onboarded = loadJSON(LS_KEYS.onboarded, false);

  function applyAccessibilityAttrs() {
    var html = document.documentElement;
    // data-motor still comes straight from the onboarding answer — spacing
    // and touch-target size aren't something most people re-tune later.
    html.setAttribute("data-motor", access.motor);
    // Text size and contrast are independent Settings toggles, not tied
    // 1:1 to the onboarding vision answer any more.
    html.setAttribute("data-textsize", settings.textSize);
    html.setAttribute("data-contrast", settings.highContrast ? "high" : "normal");
  }

  function voiceEnabled() {
    return !!settings.voice;
  }
  function needsStrongVisualAlert() {
    return access.hearing !== "good";
  }
  function exercisesEnabled() {
    return settings.exercisesEnabled !== false;
  }

  /* ---------------------------------------------------------------------
     Voice output (SpeechSynthesis) — best-effort: if the browser doesn't
     support it, the app must not break, and the same information is
     always ALSO on screen as text.
     ------------------------------------------------------------------- */
  var cachedRuVoice = null;
  var voicesReady = false;
  function pickRuVoice() {
    if (!("speechSynthesis" in window)) return null;
    try {
      var voices = window.speechSynthesis.getVoices() || [];
      if (!voices.length) return null;
      voicesReady = true;
      var ru = voices.filter(function (v) {
        return /^ru/i.test(v.lang || "");
      });
      return ru[0] || voices[0] || null;
    } catch (e) {
      return null;
    }
  }
  if ("speechSynthesis" in window) {
    try {
      window.speechSynthesis.onvoiceschanged = function () {
        cachedRuVoice = pickRuVoice();
      };
      cachedRuVoice = pickRuVoice();
    } catch (e) {}
  }

  function speak(text) {
    if (!voiceEnabled()) return;
    if (!("speechSynthesis" in window)) return; // graceful fallback: text/visuals already carry the info
    try {
      window.speechSynthesis.cancel();
      var utter = new SpeechSynthesisUtterance(text);
      utter.lang = "ru-RU";
      utter.rate = 0.95;
      utter.pitch = 1;
      if (!cachedRuVoice) cachedRuVoice = pickRuVoice();
      if (cachedRuVoice) utter.voice = cachedRuVoice; // falls back to the device default voice otherwise
      window.speechSynthesis.speak(utter);
    } catch (e) {
      /* SpeechSynthesis threw — visual info is always present too. */
    }
  }

  /* ---------------------------------------------------------------------
     Notification chime (Web Audio API) — a short, clear two-note sound
     that plays on every reminder alongside voice and the visual alert, so
     a reminder is never silent — including on a desktop computer, or
     when voice is turned off. Browsers
     block audio until the page has had a real user gesture, so a single
     shared AudioContext is created lazily and resumed on the first
     tap/click/key anywhere on the page — by the time a real reminder
     fires the person has always already touched the app at least once.
     ------------------------------------------------------------------- */
  var sharedAudioCtx = null;
  function getAudioCtx() {
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    if (!sharedAudioCtx) {
      try {
        sharedAudioCtx = new Ctor();
      } catch (e) {
        return null;
      }
    }
    return sharedAudioCtx;
  }
  function unlockAudio() {
    var ctx = getAudioCtx();
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(function () {});
    }
  }
  ["pointerdown", "keydown"].forEach(function (evt) {
    document.addEventListener(evt, unlockAudio, { passive: true });
  });
  function playTone(ctx, freq, startTime, duration, peakGain) {
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
  }
  function playChime() {
    try {
      var ctx = getAudioCtx();
      if (!ctx) return; // no Web Audio support — voice and the visual alert still fire
      if (ctx.state === "suspended") ctx.resume().catch(function () {});
      var now = ctx.currentTime;
      // Calm two-note "ding-dong", loud enough to notice, not jarring.
      playTone(ctx, 880, now, 0.45, 0.22);
      playTone(ctx, 659.25, now + 0.26, 0.55, 0.19);
    } catch (e) {
      /* Web Audio threw/blocked — voice and the visual alert still carry
         the reminder, so nothing is lost. */
    }
  }

  /* ---------------------------------------------------------------------
     Date helpers — every date is keyed as a zero-padded "YYYY-MM-DD"
     string: a safe object key, and safe to compare/sort as plain text.
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
  function addMonthsClamped(d, n) {
    var r = new Date(d);
    var day = r.getDate();
    r.setDate(1);
    r.setMonth(r.getMonth() + n);
    var lastDay = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
    r.setDate(Math.min(day, lastDay));
    return r;
  }
  function daysBetween(a, b) {
    return Math.round((b - a) / 86400000);
  }
  // Monday-first weekday index: Mon=0 ... Sun=6
  function monIndex(d) {
    return (d.getDay() + 6) % 7;
  }
  // Monday of the week containing d.
  function mondayOf(d) {
    return addDays(d, -monIndex(d));
  }

  var WEEKDAYS = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"]; // Sun-first, for the big greeting
  var WEEKDAY_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]; // Mon-first, for calendar cells / day chips
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

  function greetingWord(hour) {
    if (hour >= 4 && hour < 12) return "Доброе утро";
    if (hour >= 12 && hour < 17) return "Добрый день";
    if (hour >= 17 && hour < 23) return "Добрый вечер";
    return "Доброй ночи";
  }

  /* ---------------------------------------------------------------------
     Medications
     Each medication has one or more times per day and a frequency rule
     that decides WHICH days it is due:
       { type: "daily" }
       { type: "days", days: [0..6] }              // Mon-first indices
       { type: "everyNDays", interval: N, anchor: "YYYY-MM-DD" }
       { type: "everyNMonths", interval: N, anchor: "YYYY-MM-DD" }
       { type: "asNeeded" }                          // "только когда нужно" — no schedule, no reminders
     `takenSlots` records every taken dose as "YYYY-MM-DD@HH:MM" (or
     "YYYY-MM-DD@PRN" for an as-needed dose), which is what powers both
     today's status and the multi-day history.
     ------------------------------------------------------------------- */
  var medications = loadJSON(LS_KEYS.meds, []);
  if (!Array.isArray(medications)) medications = [];

  // Migrate the older single-time shape (time:"HH:MM", takenDates:[...],
  // snoozeUntil, lastAlertSlot) to the new multi-time/frequency shape,
  // so nobody's already-saved medications or history disappear.
  medications.forEach(function (m) {
    if (!Array.isArray(m.times)) {
      m.times = m.time ? [m.time] : ["09:00"];
    }
    if (!m.frequency || typeof m.frequency !== "object") {
      m.frequency = { type: "daily" };
    }
    if (!Array.isArray(m.takenSlots)) {
      var slots = [];
      if (Array.isArray(m.takenDates)) {
        var firstTime = m.times[0];
        m.takenDates.forEach(function (d) {
          slots.push(d + "@" + firstTime);
        });
      }
      m.takenSlots = slots;
    }
    if (!m.snoozes || typeof m.snoozes !== "object") m.snoozes = {};
    if (m.snoozeUntil) {
      var sTime = m.times[0];
      m.snoozes[todayKey() + "@" + sTime] = m.snoozeUntil;
    }
    if (!Array.isArray(m.alertedSlots)) m.alertedSlots = m.lastAlertSlot ? [m.lastAlertSlot] : [];
    if (typeof m.enabled !== "boolean") m.enabled = true;
    if (typeof m.photo !== "string") m.photo = "";
    delete m.time;
    delete m.takenDates;
    delete m.snoozeUntil;
    delete m.lastAlertSlot;
    if (!m.id) m.id = "m" + Math.random().toString(36).slice(2, 9);
  });

  function saveMeds() {
    saveJSON(LS_KEYS.meds, medications);
  }
  function findMed(id) {
    for (var i = 0; i < medications.length; i++) {
      if (medications[i].id === id) return medications[i];
    }
    return null;
  }
  function makeMedId() {
    return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function timeToMinutes(t) {
    var parts = t.split(":");
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }
  function nowMinutes() {
    var d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }
  function slotKey(dateStr, time) {
    return dateStr + "@" + time;
  }

  function isMedDueOnDate(med, key) {
    var f = med.frequency || { type: "daily" };
    if (f.type === "asNeeded") return false;
    if (f.type === "daily" || !f.type) return true;
    var d = parseDateKey(key);
    if (f.type === "days") {
      return Array.isArray(f.days) && f.days.indexOf(monIndex(d)) !== -1;
    }
    var anchor = parseDateKey(f.anchor || key);
    if (f.type === "everyNDays") {
      var n = Math.max(1, parseInt(f.interval, 10) || 1);
      var diff = daysBetween(anchor, d);
      return diff >= 0 && diff % n === 0;
    }
    if (f.type === "everyNMonths") {
      var n2 = Math.max(1, parseInt(f.interval, 10) || 1);
      if (d < anchor) return false;
      var monthsDiff = (d.getFullYear() - anchor.getFullYear()) * 12 + (d.getMonth() - anchor.getMonth());
      if (monthsDiff < 0 || monthsDiff % n2 !== 0) return false;
      var expected = addMonthsClamped(anchor, monthsDiff);
      return dateKey(expected) === key;
    }
    return true;
  }

  function frequencyLabel(med) {
    var f = med.frequency || { type: "daily" };
    if (f.type === "daily" || !f.type) return "Каждый день";
    if (f.type === "asNeeded") return "Только когда нужно";
    if (f.type === "days") {
      if (!Array.isArray(f.days) || !f.days.length) return "Определённые дни недели";
      var sorted = f.days.slice().sort(function (a, b) {
        return a - b;
      });
      return sorted.map(function (i) {
        return WEEKDAY_SHORT[i];
      }).join(", ");
    }
    if (f.type === "everyNDays") return "Каждые " + (parseInt(f.interval, 10) || 1) + " дн.";
    if (f.type === "everyNMonths") return "Каждые " + (parseInt(f.interval, 10) || 1) + " мес.";
    return "Каждый день";
  }

  function isTakenSlot(med, key, time) {
    return med.takenSlots.indexOf(slotKey(key, time)) !== -1;
  }

  // Every (medication, time) pair due on a given day, each with its
  // status for that specific slot. One row per scheduled dose — a
  // medication with three daily times produces three rows.
  function getSlotsForDate(key) {
    var today = todayKey();
    var now = nowMinutes();
    var out = [];
    medications.forEach(function (med) {
      if (med.enabled === false) return;
      if (!isMedDueOnDate(med, key)) return;
      (med.times || []).forEach(function (time) {
        var taken = isTakenSlot(med, key, time);
        var status;
        if (taken) {
          status = { kind: "taken", label: "Принято" };
        } else if (key > today) {
          status = { kind: "scheduled", label: "Запланировано" };
        } else if (key < today) {
          status = { kind: "missed", label: "Пропущено" };
        } else {
          // key === today
          var sKey = slotKey(key, time);
          var snoozedUntil = med.snoozes && med.snoozes[sKey];
          if (timeToMinutes(time) > now) {
            status = { kind: "scheduled", label: "Запланировано" };
          } else if (snoozedUntil && Date.now() < snoozedUntil) {
            status = { kind: "snoozed", label: "Отложено" };
          } else {
            status = { kind: "missed", label: "Пропущено" };
          }
        }
        out.push({ med: med, time: time, status: status });
      });
    });
    out.sort(function (a, b) {
      return timeToMinutes(a.time) - timeToMinutes(b.time);
    });
    return out;
  }

  // The single (medication, time) the live "take it now" flow — home
  // card, full-screen alert, demo button — cares about right now.
  function getNextSlot() {
    var today = todayKey();
    var slots = getSlotsForDate(today).filter(function (s) {
      return s.status.kind !== "taken";
    });
    if (!slots.length) return null;
    var now = nowMinutes();
    var upcoming = slots.filter(function (s) {
      return timeToMinutes(s.time) >= now;
    });
    if (upcoming.length) return upcoming[0]; // already sorted ascending
    return slots[0]; // nothing left today → earliest still-pending (missed) one
  }

  function hasAnyDueMed(key) {
    return medications.some(function (m) {
      return m.enabled !== false && m.frequency.type !== "asNeeded" && isMedDueOnDate(m, key) && m.times && m.times.length;
    });
  }

  function markTaken(medId, time) {
    var med = findMed(medId);
    if (!med) return;
    var key = todayKey();
    var sKey = slotKey(key, time);
    if (med.takenSlots.indexOf(sKey) === -1) med.takenSlots.push(sKey);
    if (med.snoozes) delete med.snoozes[sKey];
    saveMeds();
  }
  function undoTaken(medId, time) {
    var med = findMed(medId);
    if (!med) return;
    var sKey = slotKey(todayKey(), time);
    var idx = med.takenSlots.indexOf(sKey);
    if (idx !== -1) med.takenSlots.splice(idx, 1);
    saveMeds();
  }
  function snoozeSlot(medId, time, minutes) {
    var med = findMed(medId);
    if (!med) return;
    if (!med.snoozes) med.snoozes = {};
    med.snoozes[slotKey(todayKey(), time)] = Date.now() + minutes * 60 * 1000;
    saveMeds();
  }
  function markPrnTaken(medId) {
    var med = findMed(medId);
    if (!med) return;
    var sKey = slotKey(todayKey(), "PRN");
    if (med.takenSlots.indexOf(sKey) === -1) med.takenSlots.push(sKey);
    saveMeds();
  }
  function isPrnTakenToday(med) {
    return med.takenSlots.indexOf(slotKey(todayKey(), "PRN")) !== -1;
  }
  function setMedEnabled(id, enabled) {
    var med = findMed(id);
    if (!med) return;
    med.enabled = enabled;
    saveMeds();
    render();
  }
  function setSlotTime(id, oldTime, newTime) {
    var med = findMed(id);
    if (!med || !newTime) return;
    var idx = med.times.indexOf(oldTime);
    if (idx === -1) return;
    med.times[idx] = newTime;
    med.times.sort(function (a, b) {
      return timeToMinutes(a) - timeToMinutes(b);
    });
    med.alertedSlots = [];
    saveMeds();
    render();
  }
  function deleteMedication(id) {
    medications = medications.filter(function (m) {
      return m.id !== id;
    });
    saveMeds();
  }

  /* ---------------------------------------------------------------------
     App state / router
     ------------------------------------------------------------------- */
  var state = {
    screen: onboarded ? "today" : "onb-name",
    params: {},
  };

  function navigate(screen, params) {
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
     Scheduler — checks every 15 seconds whether a dose is due, either by
     its scheduled time or because a "напомнить позже" snooze expired.
     ------------------------------------------------------------------- */
  function checkSchedule() {
    if (state.screen === "alert") return;
    if (state.screen.indexOf("onb-") === 0) return;
    var now = nowMinutes();
    var today = todayKey();
    for (var i = 0; i < medications.length; i++) {
      var med = medications[i];
      if (med.enabled === false) continue;
      if (med.frequency && med.frequency.type === "asNeeded") continue;
      if (!isMedDueOnDate(med, today)) continue;
      for (var j = 0; j < (med.times || []).length; j++) {
        var time = med.times[j];
        if (isTakenSlot(med, today, time)) continue;
        var sKey = slotKey(today, time);
        var snoozeUntil = med.snoozes && med.snoozes[sKey];
        var dueBySnooze = snoozeUntil && Date.now() >= snoozeUntil;
        var dueByTime = !snoozeUntil && timeToMinutes(time) === now && med.alertedSlots.indexOf(sKey) === -1;
        if (dueBySnooze || dueByTime) {
          if (med.snoozes) delete med.snoozes[sKey];
          med.alertedSlots.push(sKey);
          saveMeds();
          triggerAlert(med.id, time);
          return;
        }
      }
    }
  }
  function triggerAlert(medId, time) {
    navigate("alert", { medId: medId, time: time });
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
  function escapeAttr(s) {
    return escapeHtml(s);
  }

  /* =======================================================================
     ICONS — a small hand-drawn line-icon set (stroke=currentColor), used
     everywhere instead of emoji. Emoji render as a different, uncontrolled
     picture on every OS and can't pick up the app's colours; these do both.
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
    user: '<circle cx="12" cy="8.3" r="3.8"/><path d="M4.5 20c1.4-4 4.2-6 7.5-6s6.1 2 7.5 6"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V7"/><path d="M6.5 7 7.3 19a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/><line x1="10" y1="11" x2="10" y2="16.5"/><line x1="14" y1="11" x2="14" y2="16.5"/>',
    pencil: '<path d="M4 20l.9-3.9L15.6 5.4a1.7 1.7 0 0 1 2.4 0l1.6 1.6a1.7 1.7 0 0 1 0 2.4L8.9 20.1 4 21Z"/><line x1="14" y1="7" x2="17.5" y2="10.5"/>',
    camera: '<path d="M4 8.5a1.5 1.5 0 0 1 1.5-1.5h2.4l1.1-1.7a1.5 1.5 0 0 1 1.3-.7h3.4c.5 0 1 .3 1.3.7L16.1 7h2.4A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5Z"/><circle cx="12" cy="13" r="3.4"/>',
    volume: '<path d="M4 10v4h3.5L13 18V6L7.5 10Z"/><path d="M16 9.5a4 4 0 0 1 0 5"/><path d="M18.3 7a7.5 7.5 0 0 1 0 10"/>',
    volumeOff: '<path d="M4 10v4h3.5L13 18V6L7.5 10Z"/><line x1="16" y1="10" x2="21" y2="15"/><line x1="21" y1="10" x2="16" y2="15"/>',
    contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/>',
    textSize: '<path d="M4 19V7.5A1.5 1.5 0 0 1 5.5 6H11a1.5 1.5 0 0 1 1.5 1.5V19"/><line x1="4" y1="19" x2="12.5" y2="19"/><line x1="4" y1="12.5" x2="12.5" y2="12.5"/><path d="M14.5 19v-6a1 1 0 0 1 1-1h2.6a1 1 0 0 1 1 1v6"/><line x1="14.5" y1="19" x2="19.1" y2="19"/>',
    globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><line x1="3" y1="12" x2="21" y2="12"/>',
    calendarDot: '<rect x="4" y="5" width="16" height="15" rx="2"/><line x1="4" y1="9.5" x2="20" y2="9.5"/><line x1="8" y1="3" x2="8" y2="6.5"/><line x1="16" y1="3" x2="16" y2="6.5"/>',
    apple: '<path d="M12 8.5c-2.6-2.4-6.3-1-6.9 2.4-.6 3.6 1.7 8.4 4.4 9.6 1 .4 1.6-.4 2.5-.4s1.5.8 2.5.4c2-.9 3.6-3.6 4.2-6" /><path d="M12 8.5c0-2 .8-3.6 2.4-4.6" /><path d="M12 8.5c1.6 0 3-.5 4-1.6"/>',
    key: '<circle cx="8" cy="14.5" r="3.2"/><path d="M10.3 12.2 18 4.5"/><path d="M15.5 7 18 9.5"/><path d="M13 9.5l2 2"/>',
    book: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H12v16H5.5A1.5 1.5 0 0 1 4 18.5Z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H12v16h6.5a1.5 1.5 0 0 0 1.5-1.5Z"/>',
    externalLink: '<path d="M9 6H5.5A1.5 1.5 0 0 0 4 7.5v11A1.5 1.5 0 0 0 5.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15"/><path d="M14 4h6v6"/><line x1="10" y1="14" x2="20" y2="4"/>',
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
    return { taken: "checkCircle", next: "hourglass", scheduled: "clockDial", missed: "alertTriangle", snoozed: "clockDial" }[kind] || "clockDial";
  }

  /* =======================================================================
     BOTTOM NAVIGATION — persistent on every main tab screen.
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
  var pendingFocusId = null;

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
    var weekdayFull = WEEKDAY_FULL_MON[monIndex(d)];
    var label = weekdayFull + ", " + d.getDate() + " " + MONTHS_GEN[d.getMonth()];
    if (key === todayKey()) label += ", сегодня";
    if (hasAnyDueMed(key)) label += ", есть приём лекарств";
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
        '<span class="day-cell__label" aria-hidden="true">' + WEEKDAY_SHORT[monIndex(d)] + "</span>" +
        '<span class="day-cell__num" aria-hidden="true">' + d.getDate() + "</span>" +
        (hasAnyDueMed(key) ? '<span class="day-cell__dot" aria-hidden="true"></span>' : "") +
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
    var selectedEl = document.querySelector(".day-cell--selected");
    if (selectedEl && selectedEl.scrollIntoView) {
      selectedEl.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  /* =======================================================================
     Shared medication row (Сегодня / История) — one row per (med, time).
     ======================================================================= */
  function medRowHtml(med, time, status) {
    var srText = escapeHtml(med.name) + ". " + escapeHtml(time) + ". " + escapeHtml(med.dose) + ". " + statusSrPhrase(status.kind) + ".";
    return (
      '<div class="med-row">' +
      '<span class="med-row__icon" aria-hidden="true">' + icon("pill") + "</span>" +
      '<div class="med-row__body">' +
      '<span class="med-row__name">' + escapeHtml(med.name) + "</span>" +
      '<span class="med-row__meta">' + escapeHtml(med.dose) + "</span>" +
      "</div>" +
      '<span class="med-row__time">' + escapeHtml(time) + "</span>" +
      '<span class="med-row__status med-row__status--' + status.kind + '">' +
      icon(statusIconName(status.kind)) + "<span>" + status.label + "</span>" +
      "</span>" +
      '<span class="sr-only">' + srText + "</span>" +
      "</div>"
    );
  }
  function statusSrPhrase(kind) {
    return { taken: "Приём отмечен как принятый", missed: "Приём пропущен", scheduled: "Приём запланирован", snoozed: "Приём отложен" }[kind] || "";
  }

  /* =======================================================================
     REUSABLE: big ON/OFF switch (role=switch) — used by onboarding step 4
     and every toggle in Настройки. Text label is always shown next to it;
     state is never color-only.
     ======================================================================= */
  function switchHtml(id, checked, hugeClass) {
    return (
      '<button type="button" class="switch' + (hugeClass ? " switch--huge" : "") + (checked ? " switch--on" : "") +
      '" id="' + id + '" role="switch" aria-checked="' + (checked ? "true" : "false") + '">' +
      '<span class="switch__track"><span class="switch__thumb"></span></span>' +
      '<span class="switch__state">' + (checked ? "ВКЛЮЧЕНО" : "ВЫКЛЮЧЕНО") + "</span>" +
      "</button>"
    );
  }

  /* =======================================================================
     MEDICATION FORM — shared by onboarding Step 3 and Лекарства (add/edit).
     Kept as a set of functions operating on a plain draft object so the
     exact same markup/logic backs both places.
     ======================================================================= */
  function blankDraft() {
    return {
      id: null,
      name: "",
      dose: "",
      times: ["09:00"],
      frequency: { type: "daily", days: [], interval: 1, anchor: todayKey() },
      photo: "",
      enabled: true,
    };
  }
  function draftFromMed(med) {
    return {
      id: med.id,
      name: med.name,
      dose: med.dose,
      times: med.times.slice(),
      frequency: {
        type: med.frequency.type || "daily",
        days: (med.frequency.days || []).slice(),
        interval: med.frequency.interval || 1,
        anchor: med.frequency.anchor || todayKey(),
      },
      photo: med.photo || "",
      enabled: med.enabled !== false,
    };
  }

  var FREQ_OPTIONS = [
    { value: "daily", label: "Каждый день" },
    { value: "days", label: "Определённые дни недели" },
    { value: "everyNDays", label: "Каждые X дней" },
    { value: "everyNMonths", label: "Каждые X месяцев" },
    { value: "asNeeded", label: "Только когда нужно" },
  ];

  function medFormHtml(draft, formError) {
    var freqSelectOpts = FREQ_OPTIONS.map(function (o) {
      return '<option value="' + o.value + '"' + (draft.frequency.type === o.value ? " selected" : "") + ">" + o.label + "</option>";
    }).join("");

    var dayChips = WEEKDAY_SHORT.map(function (label, idx) {
      var picked = draft.frequency.days.indexOf(idx) !== -1;
      return '<button type="button" class="day-chip' + (picked ? " day-chip--on" : "") + '" data-day="' + idx + '" aria-pressed="' + (picked ? "true" : "false") + '">' + label + "</button>";
    }).join("");

    var timesHtml = draft.times.map(function (t, idx) {
      return (
        '<div class="time-chip">' +
        '<input type="time" class="time-chip__input" data-time-idx="' + idx + '" value="' + escapeAttr(t) + '" aria-label="Время приёма ' + (idx + 1) + '" />' +
        (draft.times.length > 1
          ? '<button type="button" class="time-chip__remove" data-remove-time="' + idx + '" aria-label="Удалить это время">' + icon("trash") + "</button>"
          : "") +
        "</div>"
      );
    }).join("");

    var photoBlock = draft.photo
      ? '<div class="photo-preview"><img src="' + draft.photo + '" alt="Фото лекарства" /><button type="button" class="btn btn--ghost" id="btn-photo-remove">Удалить фото</button></div>'
      : '<label class="photo-upload" for="input-photo">' + icon("camera") + "<span>Добавить фото лекарства (необязательно)</span></label>";

    return (
      '<form class="med-form" id="med-form" novalidate>' +
      (formError ? '<p class="form-error" role="alert">' + escapeHtml(formError) + "</p>" : "") +
      '<label class="field-label" for="input-med-name">Название лекарства</label>' +
      '<input class="text-input" id="input-med-name" name="name" type="text" autocomplete="off" value="' + escapeAttr(draft.name) + '" placeholder="Например, Амлодипин" />' +

      '<label class="field-label" for="input-med-dose">Дозировка</label>' +
      '<input class="text-input" id="input-med-dose" name="dose" type="text" autocomplete="off" value="' + escapeAttr(draft.dose) + '" placeholder="Например, 1 таблетка" />' +

      '<label class="field-label" for="input-med-freq">Как часто вы принимаете это лекарство?</label>' +
      '<select class="select-input" id="input-med-freq">' + freqSelectOpts + "</select>" +

      '<div class="freq-extra" id="freq-days" ' + (draft.frequency.type === "days" ? "" : "hidden") + '>' +
      '<div class="day-chip-row" role="group" aria-label="Дни недели">' + dayChips + "</div>" +
      "</div>" +
      '<div class="freq-extra" id="freq-days-error"></div>' +

      '<div class="freq-extra" id="freq-interval-days" ' + (draft.frequency.type === "everyNDays" ? "" : "hidden") + '>' +
      '<label class="field-label" for="input-interval-days">Через сколько дней</label>' +
      '<input class="text-input text-input--narrow" id="input-interval-days" type="number" min="1" max="90" value="' + (draft.frequency.interval || 1) + '" />' +
      "</div>" +

      '<div class="freq-extra" id="freq-interval-months" ' + (draft.frequency.type === "everyNMonths" ? "" : "hidden") + '>' +
      '<label class="field-label" for="input-interval-months">Через сколько месяцев</label>' +
      '<input class="text-input text-input--narrow" id="input-interval-months" type="number" min="1" max="24" value="' + (draft.frequency.interval || 1) + '" />' +
      "</div>" +

      '<div class="freq-extra" id="freq-times" ' + (draft.frequency.type === "asNeeded" ? "hidden" : "") + '>' +
      '<span class="field-label">Время приёма</span>' +
      '<div class="time-chip-list" id="time-chip-list">' + timesHtml + "</div>" +
      '<button type="button" class="btn btn--secondary btn--compact" id="btn-add-time">' + icon("plus") + "<span>ДОБАВИТЬ ВРЕМЯ</span></button>" +
      "</div>" +

      '<div class="photo-field">' + photoBlock + '<input type="file" id="input-photo" accept="image/*" class="sr-only" /></div>' +

      "</form>"
    );
  }

  function bindMedFormEvents(draft, onDraftChange) {
    var nameEl = document.getElementById("input-med-name");
    var doseEl = document.getElementById("input-med-dose");
    var freqEl = document.getElementById("input-med-freq");
    on(nameEl, "input", function () {
      draft.name = nameEl.value;
    });
    on(doseEl, "input", function () {
      draft.dose = doseEl.value;
    });
    on(freqEl, "change", function () {
      draft.frequency.type = freqEl.value;
      onDraftChange();
    });
    Array.prototype.forEach.call(document.querySelectorAll(".day-chip"), function (chip) {
      on(chip, "click", function () {
        var idx = parseInt(chip.getAttribute("data-day"), 10);
        var pos = draft.frequency.days.indexOf(idx);
        if (pos === -1) draft.frequency.days.push(idx);
        else draft.frequency.days.splice(pos, 1);
        chip.classList.toggle("day-chip--on");
        chip.setAttribute("aria-pressed", chip.classList.contains("day-chip--on") ? "true" : "false");
      });
    });
    var intervalDaysEl = document.getElementById("input-interval-days");
    on(intervalDaysEl, "input", function () {
      draft.frequency.interval = parseInt(intervalDaysEl.value, 10) || 1;
    });
    var intervalMonthsEl = document.getElementById("input-interval-months");
    on(intervalMonthsEl, "input", function () {
      draft.frequency.interval = parseInt(intervalMonthsEl.value, 10) || 1;
    });
    Array.prototype.forEach.call(document.querySelectorAll(".time-chip__input"), function (inp) {
      on(inp, "change", function () {
        var idx = parseInt(inp.getAttribute("data-time-idx"), 10);
        if (inp.value) draft.times[idx] = inp.value;
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-remove-time]"), function (btn) {
      on(btn, "click", function () {
        var idx = parseInt(btn.getAttribute("data-remove-time"), 10);
        draft.times.splice(idx, 1);
        onDraftChange();
      });
    });
    on(document.getElementById("btn-add-time"), "click", function () {
      draft.times.push("12:00");
      onDraftChange();
    });
    var photoInput = document.getElementById("input-photo");
    on(photoInput, "change", function () {
      var file = photoInput.files && photoInput.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) {
        announce("Фото слишком большое. Выберите файл меньше 2 МБ.");
        return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        draft.photo = reader.result;
        onDraftChange();
      };
      reader.onerror = function () {
        announce("Не удалось загрузить фото.");
      };
      reader.readAsDataURL(file);
    });
    on(document.getElementById("btn-photo-remove"), "click", function () {
      draft.photo = "";
      onDraftChange();
    });
  }

  // Validates + normalizes a draft; returns an error string or null.
  function validateDraft(draft) {
    if (!draft.name || !draft.name.trim()) return "Пожалуйста, укажите название лекарства.";
    if (!draft.dose || !draft.dose.trim()) return "Пожалуйста, укажите дозировку.";
    if (draft.frequency.type === "days" && (!draft.frequency.days || !draft.frequency.days.length)) {
      return "Выберите хотя бы один день недели.";
    }
    if (draft.frequency.type !== "asNeeded" && (!draft.times || !draft.times.length)) {
      return "Добавьте хотя бы одно время приёма.";
    }
    return null;
  }
  function commitDraft(draft) {
    draft.name = draft.name.trim();
    draft.dose = draft.dose.trim();
    if (draft.frequency.type !== "asNeeded") {
      draft.times = draft.times.slice().sort(function (a, b) {
        return timeToMinutes(a) - timeToMinutes(b);
      });
    } else {
      draft.times = [];
    }
    if (draft.id) {
      var med = findMed(draft.id);
      if (med) {
        med.name = draft.name;
        med.dose = draft.dose;
        med.times = draft.times;
        med.frequency = draft.frequency;
        med.photo = draft.photo;
      }
    } else {
      medications.push({
        id: makeMedId(),
        name: draft.name,
        dose: draft.dose,
        times: draft.times,
        frequency: draft.frequency,
        photo: draft.photo,
        enabled: true,
        takenSlots: [],
        snoozes: {},
        alertedSlots: [],
      });
    }
    saveMeds();
  }

  /* =======================================================================
     ONBOARDING — 4-step wizard: имя → доступность → лекарства → упражнение
     ======================================================================= */
  // True only when the accessibility questions were re-opened from
  // Настройки ("Повторить настройку доступности"), not during first-run
  // onboarding — in that case, finishing them returns to Настройки
  // instead of continuing into the medications/exercise onboarding steps.
  var redoAccessMode = false;

  var ONB_TOTAL_STEPS = 4;
  function stepProgressHtml(step) {
    var dots = "";
    for (var i = 1; i <= ONB_TOTAL_STEPS; i++) {
      dots += '<span class="progress-dot' + (i === step ? " progress-dot--active" : "") + '"></span>';
    }
    return (
      '<div class="onb-progress">' +
      '<p class="onb-progress__text">Шаг ' + step + " из " + ONB_TOTAL_STEPS + "</p>" +
      '<div class="progress" aria-hidden="true">' + dots + "</div>" +
      "</div>"
    );
  }

  // ---- Step 1: name --------------------------------------------------
  function renderOnbName() {
    appEl.innerHTML =
      '<div class="screen">' +
      stepProgressHtml(1) +
      '<h1 class="title" data-autofocus>Давайте познакомимся</h1>' +
      '<form id="form-onb-name" novalidate style="width:100%;display:flex;flex-direction:column;gap:0.9rem;align-items:stretch;">' +
      '<label class="field-label" for="input-onb-name">Полное имя</label>' +
      '<input class="text-input text-input--big" id="input-onb-name" type="text" autocomplete="name" value="' + escapeAttr(profile.name) + '" placeholder="Например, Айгуль Сериковна" />' +
      '<button class="btn btn--primary btn--huge" type="submit">ДАЛЕЕ</button>' +
      "</form>" +
      "</div>";
    var input = document.getElementById("input-onb-name");
    on(document.getElementById("form-onb-name"), "submit", function (ev) {
      ev.preventDefault();
      profile.name = (input.value || "").trim();
      saveProfile();
      navigate("onb-vision");
    });
    focusMain();
  }

  // ---- Step 2: accessibility (3 sub-questions, same step number) -----
  function renderOnboardingVision() {
    appEl.innerHTML =
      '<div class="screen">' +
      stepProgressHtml(2) +
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
      stepProgressHtml(2) +
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
      stepProgressHtml(2) +
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
        seedSettingsFromAccess();
        applyAccessibilityAttrs();
        if (redoAccessMode) {
          redoAccessMode = false;
          announce("Настройки доступности обновлены.");
          navigate("settings");
        } else {
          navigate("onb-medications");
        }
      });
    });
    focusMain();
  }

  // ---- Step 3: medications --------------------------------------------
  var onbDraft = blankDraft();
  var onbFormError = null;

  function onbMedListHtml() {
    if (!medications.length) return "";
    return (
      '<div class="stack-gap" style="margin-bottom:0.4rem;">' +
      medications.map(function (m) {
        return (
          '<div class="med-row">' +
          '<span class="med-row__icon" aria-hidden="true">' + icon("pill") + "</span>" +
          '<div class="med-row__body"><span class="med-row__name">' + escapeHtml(m.name) + '</span><span class="med-row__meta">' +
          escapeHtml(m.dose) + " · " + escapeHtml(frequencyLabel(m)) +
          (m.times.length ? " · " + m.times.map(escapeHtml).join(", ") : "") +
          "</span></div>" +
          '<button type="button" class="icon-btn icon-btn--danger" data-remove-med="' + m.id + '" aria-label="Удалить ' + escapeAttr(m.name) + '">' + icon("trash") + "</button>" +
          "</div>"
        );
      }).join("") +
      "</div>"
    );
  }

  function renderOnbMedications() {
    appEl.innerHTML =
      '<div class="screen screen--tab">' +
      stepProgressHtml(3) +
      '<h1 class="title" data-autofocus>Добавьте лекарство</h1>' +
      '<div id="onb-med-list">' + onbMedListHtml() + "</div>" +
      medFormHtml(onbDraft, onbFormError) +
      '<div class="btn-stack">' +
      '<button class="btn btn--secondary" id="btn-onb-add-another">' + icon("plus") + "<span>ДОБАВИТЬ ЕЩЁ ЛЕКАРСТВО</span></button>" +
      '<button class="btn btn--primary btn--huge" id="btn-onb-meds-next">ДАЛЕЕ</button>' +
      "</div>" +
      (medications.length === 0 ? '<p class="empty-note" style="text-align:center;align-self:center;">Лекарства можно добавить позже в разделе «Лекарства».</p>' : "") +
      "</div>";

    bindMedFormEvents(onbDraft, function () {
      onbFormError = null;
      renderOnbMedications();
    });

    Array.prototype.forEach.call(document.querySelectorAll("[data-remove-med]"), function (btn) {
      on(btn, "click", function () {
        deleteMedication(btn.getAttribute("data-remove-med"));
        renderOnbMedications();
      });
    });

    function tryCommitCurrentIfStarted() {
      // Only save the in-progress draft if the user actually typed
      // something — an untouched blank form should just be skipped.
      if (!onbDraft.name.trim() && !onbDraft.dose.trim()) return true;
      var err = validateDraft(onbDraft);
      if (err) {
        onbFormError = err;
        renderOnbMedications();
        return false;
      }
      commitDraft(onbDraft);
      onbDraft = blankDraft();
      onbFormError = null;
      return true;
    }

    on(document.getElementById("btn-onb-add-another"), "click", function () {
      if (tryCommitCurrentIfStarted()) renderOnbMedications();
    });
    on(document.getElementById("btn-onb-meds-next"), "click", function () {
      if (tryCommitCurrentIfStarted()) navigate("onb-exercise");
    });
    focusMain();
  }

  // ---- Step 4: daily exercise toggle -----------------------------------
  function renderOnbExercise() {
    appEl.innerHTML =
      '<div class="screen">' +
      stepProgressHtml(4) +
      '<h1 class="title" data-autofocus>Ежедневное упражнение</h1>' +
      '<p class="lead">SilverCare может каждый день предлагать короткое упражнение для памяти и внимания.</p>' +
      '<div class="switch-row switch-row--center">' +
      '<span class="switch-row__label">Ежедневное упражнение</span>' +
      switchHtml("switch-onb-exercise", settings.exercisesEnabled, true) +
      "</div>" +
      '<div class="btn-stack" style="margin-top:1rem;">' +
      '<button class="btn btn--primary btn--huge" id="btn-onb-finish">НАЧАТЬ ПОЛЬЗОВАТЬСЯ</button>' +
      "</div>" +
      "</div>";
    var sw = document.getElementById("switch-onb-exercise");
    on(sw, "click", function () {
      settings.exercisesEnabled = !settings.exercisesEnabled;
      saveSettings();
      sw.classList.toggle("switch--on", settings.exercisesEnabled);
      sw.setAttribute("aria-checked", settings.exercisesEnabled ? "true" : "false");
      sw.querySelector(".switch__state").textContent = settings.exercisesEnabled ? "ВКЛЮЧЕНО" : "ВЫКЛЮЧЕНО";
    });
    on(document.getElementById("btn-onb-finish"), "click", function () {
      onboarded = true;
      saveJSON(LS_KEYS.onboarded, true);
      navigate("today");
    });
    focusMain();
  }

  /* =======================================================================
     СЕГОДНЯ (Today) — greeting, weekly calendar, next-dose card, list.
     ======================================================================= */
  var clockTimer = null;
  function formatClock(d) {
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function nextDoseCardHtml(slot) {
    if (!slot) {
      return '<div class="next-dose-card next-dose-card--empty"><p>На сегодня приёмов больше нет.</p></div>';
    }
    var isOverdue = slot.status.kind === "missed" || slot.status.kind === "snoozed";
    var heading = isOverdue ? "Приём не подтверждён" : "Следующий приём";
    return (
      '<section class="next-dose-card' + (isOverdue ? " next-dose-card--overdue" : "") + '" aria-labelledby="next-dose-heading">' +
      '<h2 class="next-dose-card__eyebrow" id="next-dose-heading">' + heading + "</h2>" +
      '<div class="next-dose-card__row">' +
      '<span class="next-dose-card__time">' + escapeHtml(slot.time) + "</span>" +
      '<span class="next-dose-card__med">' + icon("pill") + " " + escapeHtml(slot.med.name) + "</span>" +
      "</div>" +
      '<p class="next-dose-card__dose">' + escapeHtml(slot.med.dose) + "</p>" +
      '<div class="home-actions">' +
      '<button class="btn btn--primary btn--huge" id="btn-taken">Я ПРИНЯЛ(А)</button>' +
      '<button class="btn btn--secondary" id="btn-snooze">НАПОМНИТЬ ПОЗЖЕ</button>' +
      "</div>" +
      "</section>"
    );
  }

  function exerciseCardHtml() {
    if (!exercisesEnabled()) return "";
    return (
      '<section class="exercise-card" aria-labelledby="exercise-card-heading">' +
      '<div class="exercise-card__icon" aria-hidden="true">' + icon("bulb") + "</div>" +
      '<div class="exercise-card__body">' +
      '<h2 id="exercise-card-heading">Упражнение на сегодня</h2>' +
      '<p>1 минута</p>' +
      "</div>" +
      '<button class="btn btn--secondary" id="btn-exercise">НАЧАТЬ</button>' +
      "</section>"
    );
  }

  function renderToday() {
    var now = new Date();
    var isToday = selectedDateKey === todayKey();
    var daySlots = getSlotsForDate(selectedDateKey);
    var nextSlot = isToday ? getNextSlot() : null;

    var listHtml = daySlots.length
      ? '<div class="stack-gap">' + daySlots.map(function (s) {
          return medRowHtml(s.med, s.time, s.status);
        }).join("") + "</div>"
      : medications.length
      ? '<p class="empty-note">На этот день приёмов нет.</p>'
      : '<p class="empty-note">Лекарства пока не добавлены.</p>' +
        '<button class="btn btn--secondary" id="btn-add-med-empty">' + icon("plus") + "<span>ДОБАВИТЬ ЛЕКАРСТВО</span></button>";

    var greetName = profile.name ? ", " + escapeHtml(profile.name.split(" ")[0]) : "";
    var hadPendingFocus = !!pendingFocusId;

    var inner =
      '<div class="home-header">' +
      '<p class="greeting" data-autofocus tabindex="-1">' + greetingWord(now.getHours()) + greetName + "</p>" +
      '<h1 class="clock" id="today-clock" aria-label="Текущее время ' + escapeHtml(formatClock(now)) + '">' +
      escapeHtml(formatClock(now)) + "</h1>" +
      '<p class="day-name" id="today-day">' + WEEKDAYS[now.getDay()] + "</p>" +
      "</div>" +
      renderCalendarHtml() +
      '<h2 class="date-heading">' + escapeHtml(formatDateHeading(selectedDateKey)) + "</h2>" +
      (isToday ? nextDoseCardHtml(nextSlot) : "") +
      '<h3 class="section-heading">Лекарства на ' + (isToday ? "сегодня" : "этот день") + "</h3>" +
      listHtml +
      exerciseCardHtml();

    renderTabShell("today", inner);
    bindCalendarEvents();

    if (nextSlot) {
      on(document.getElementById("btn-taken"), "click", function () {
        markTaken(nextSlot.med.id, nextSlot.time);
        navigate("confirmation", { medId: nextSlot.med.id, time: nextSlot.time, from: "today" });
      });
      on(document.getElementById("btn-snooze"), "click", function () {
        snoozeSlot(nextSlot.med.id, nextSlot.time, 10);
        announce("Напомним через 10 минут.");
        render();
      });
    }
    on(document.getElementById("btn-exercise"), "click", function () {
      navigate("exercise");
    });
    on(document.getElementById("btn-add-med-empty"), "click", function () {
      navigate("medications", { openForm: true });
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
     ЛЕКАРСТВА (Medications) — full CRUD.
     ======================================================================= */
  var medsEditingId = null; // null = list view; "new" = add form; id = edit form
  var medsDraft = null;
  var medsFormError = null;
  var medsPendingDelete = null;

  function medListRowHtml(med) {
    var isPrn = med.frequency && med.frequency.type === "asNeeded";
    var nextInfo = "";
    if (isPrn) {
      nextInfo = "Только когда нужно";
    } else {
      var due = null;
      for (var i = 0; i < 14 && !due; i++) {
        var k = dateKey(addDays(new Date(), i));
        if (isMedDueOnDate(med, k) && med.enabled !== false) due = k;
      }
      nextInfo = due ? "Следующий приём: " + formatDateHeading(due) + (med.times.length ? ", " + med.times.join(", ") : "") : "Нет ближайших приёмов";
    }
    return (
      '<div class="med-card">' +
      (med.photo ? '<img class="med-card__photo" src="' + med.photo + '" alt="Фото: ' + escapeAttr(med.name) + '" />' : '<span class="med-row__icon med-card__icon" aria-hidden="true">' + icon("pill") + "</span>") +
      '<div class="med-card__body">' +
      '<h3 class="med-card__name">' + escapeHtml(med.name) + (med.enabled === false ? ' <span class="med-card__off">(выключено)</span>' : "") + "</h3>" +
      '<p class="med-card__meta">' + escapeHtml(med.dose) + " · " + escapeHtml(frequencyLabel(med)) + "</p>" +
      '<p class="med-card__meta">' + (isPrn ? "" : (med.times.length ? med.times.join(", ") + " · " : "")) + escapeHtml(nextInfo) + "</p>" +
      (isPrn
        ? '<button type="button" class="btn btn--secondary btn--compact" data-prn-take="' + med.id + '"' + (isPrnTakenToday(med) ? " disabled" : "") + ">" +
          (isPrnTakenToday(med) ? "Принято сегодня" : "ПРИНЯТЬ СЕЙЧАС") + "</button>"
        : "") +
      "</div>" +
      '<div class="med-card__actions">' +
      '<button type="button" class="icon-btn" data-edit-med="' + med.id + '" aria-label="Изменить ' + escapeAttr(med.name) + '">' + icon("pencil") + "</button>" +
      '<button type="button" class="icon-btn icon-btn--danger" data-delete-med="' + med.id + '" aria-label="Удалить ' + escapeAttr(med.name) + '">' + icon("trash") + "</button>" +
      "</div>" +
      "</div>"
    );
  }

  function renderMedicationsTab() {
    if (medsEditingId !== null) {
      renderMedForm();
      return;
    }
    if (medsPendingDelete) {
      renderMedDeleteConfirm();
      return;
    }
    var listHtml = medications.length
      ? '<div class="stack-gap">' + medications.map(medListRowHtml).join("") + "</div>"
      : '<p class="empty-note">Лекарства пока не добавлены.</p>';

    var inner =
      '<h1 class="title" data-autofocus>Лекарства</h1>' +
      listHtml +
      '<button class="btn btn--primary btn--huge" id="btn-add-med">' + icon("plus") + "<span>ДОБАВИТЬ ЛЕКАРСТВО</span></button>";
    renderTabShell("medications", inner);

    Array.prototype.forEach.call(document.querySelectorAll("[data-edit-med]"), function (btn) {
      on(btn, "click", function () {
        medsEditingId = btn.getAttribute("data-edit-med");
        medsDraft = draftFromMed(findMed(medsEditingId));
        medsFormError = null;
        render();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-delete-med]"), function (btn) {
      on(btn, "click", function () {
        medsPendingDelete = btn.getAttribute("data-delete-med");
        render();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-prn-take]"), function (btn) {
      on(btn, "click", function () {
        var id = btn.getAttribute("data-prn-take");
        markPrnTaken(id);
        var med = findMed(id);
        announce("Приём отмечен.");
        speak("Приём лекарства отмечен.");
        render();
      });
    });
    on(document.getElementById("btn-add-med"), "click", function () {
      medsEditingId = "new";
      medsDraft = blankDraft();
      medsFormError = null;
      render();
    });

    if (state.params && state.params.openForm) {
      state.params.openForm = false;
      medsEditingId = "new";
      medsDraft = blankDraft();
      medsFormError = null;
      render();
      return;
    }
    focusMain();
  }

  function renderMedForm() {
    var isNew = medsEditingId === "new";
    var inner =
      '<h1 class="title" data-autofocus>' + (isNew ? "Добавить лекарство" : "Изменить лекарство") + "</h1>" +
      medFormHtml(medsDraft, medsFormError) +
      '<div class="btn-stack">' +
      '<button class="btn btn--primary btn--huge" id="btn-med-save">СОХРАНИТЬ</button>' +
      '<button class="btn btn--ghost" id="btn-med-cancel">ОТМЕНА</button>' +
      "</div>";
    renderTabShell("medications", inner);
    bindMedFormEvents(medsDraft, function () {
      render();
    });
    on(document.getElementById("btn-med-save"), "click", function () {
      var err = validateDraft(medsDraft);
      if (err) {
        medsFormError = err;
        render();
        return;
      }
      commitDraft(medsDraft);
      medsEditingId = null;
      medsDraft = null;
      medsFormError = null;
      announce("Лекарство сохранено.");
      render();
    });
    on(document.getElementById("btn-med-cancel"), "click", function () {
      medsEditingId = null;
      medsDraft = null;
      medsFormError = null;
      render();
    });
    focusMain();
  }

  function renderMedDeleteConfirm() {
    var med = findMed(medsPendingDelete);
    if (!med) {
      medsPendingDelete = null;
      render();
      return;
    }
    var inner =
      '<div class="screen screen--center">' +
      '<div class="alert-icon" aria-hidden="true">' + icon("alertTriangle") + "</div>" +
      '<h1 class="title" data-autofocus>Удалить «' + escapeHtml(med.name) + '»?</h1>' +
      '<p class="lead">Это действие нельзя отменить. История приёма этого лекарства также будет удалена.</p>' +
      '<div class="btn-stack" style="max-width:420px;">' +
      '<button class="btn btn--secondary" id="btn-cancel-delete">ОТМЕНА</button>' +
      '<button class="btn btn--danger btn--huge" id="btn-confirm-delete">ДА, УДАЛИТЬ</button>' +
      "</div>" +
      "</div>";
    appEl.innerHTML = '<div class="tab-content">' + inner + "</div>" + bottomNavHtml("medications");
    bindBottomNav();
    on(document.getElementById("btn-cancel-delete"), "click", function () {
      medsPendingDelete = null;
      render();
    });
    on(document.getElementById("btn-confirm-delete"), "click", function () {
      deleteMedication(medsPendingDelete);
      medsPendingDelete = null;
      announce("Лекарство удалено.");
      render();
    });
    focusMain();
  }

  /* =======================================================================
     НАПОМИНАНИЯ (Reminders) — enable/disable and adjust times.
     ======================================================================= */
  function timeSelectHtml(med, time) {
    var parts = time.split(":");
    var curH = parseInt(parts[0], 10);
    var curM = parseInt(parts[1], 10);
    var hourOpts = "";
    for (var h = 0; h < 24; h++) {
      var hh = h < 10 ? "0" + h : "" + h;
      hourOpts += '<option value="' + hh + '"' + (h === curH ? " selected" : "") + ">" + hh + "</option>";
    }
    var minuteOpts = "";
    for (var m = 0; m < 60; m += 5) {
      var mm = m < 10 ? "0" + m : "" + m;
      minuteOpts += '<option value="' + mm + '"' + (m === curM ? " selected" : "") + ">" + mm + "</option>";
    }
    return (
      '<div class="time-select-group" role="group" aria-label="Время приёма: ' + escapeHtml(med.name) + '" data-med="' + med.id + '" data-orig-time="' + escapeAttr(time) + '">' +
      '<select class="time-select" data-part="hour" aria-label="Часы">' + hourOpts + "</select>" +
      '<span class="time-select-colon" aria-hidden="true">:</span>' +
      '<select class="time-select" data-part="minute" aria-label="Минуты">' + minuteOpts + "</select>" +
      "</div>"
    );
  }

  function renderRemindersTab() {
    var rows = [];
    medications.forEach(function (med) {
      if (med.frequency && med.frequency.type === "asNeeded") return;
      var on_ = med.enabled !== false;
      med.times.forEach(function (time) {
        rows.push(
          '<div class="reminder-row">' +
          '<div class="reminder-row__top">' +
          '<span class="med-row__icon" aria-hidden="true">' + icon("pill") + "</span>" +
          '<div class="med-row__body">' +
          '<span class="med-row__name">' + escapeHtml(med.name) + "</span>" +
          '<span class="med-row__meta">' + escapeHtml(med.dose) + " · " + escapeHtml(frequencyLabel(med)) + "</span>" +
          "</div>" +
          "</div>" +
          '<div class="reminder-controls">' +
          '<span class="reminder-time-label">Время</span>' +
          timeSelectHtml(med, time) +
          '<button class="toggle-btn' + (on_ ? " toggle-btn--on" : "") + '" data-toggle="' + med.id +
          '" aria-pressed="' + (on_ ? "true" : "false") + '">' +
          '<span aria-hidden="true">' + icon(on_ ? "bell" : "bellOff") + "</span>" +
          "<span>" + (on_ ? "Включено" : "Выключено") + "</span>" +
          "</button>" +
          "</div>" +
          "</div>"
        );
      });
    });

    var inner =
      '<h1 class="title" data-autofocus>Напоминания</h1>' +
      '<p class="lead lead--tight">Включайте, выключайте и меняйте время приёма.</p>' +
      (rows.length
        ? '<div class="stack-gap">' + rows.join("") + "</div>"
        : '<p class="empty-note">Пока нет напоминаний с расписанием.</p>');

    renderTabShell("reminders", inner);

    Array.prototype.forEach.call(document.querySelectorAll(".time-select-group"), function (group) {
      var id = group.getAttribute("data-med");
      var origTime = group.getAttribute("data-orig-time");
      Array.prototype.forEach.call(group.querySelectorAll(".time-select"), function (sel) {
        on(sel, "change", function () {
          var hour = null;
          var minute = null;
          Array.prototype.forEach.call(group.querySelectorAll(".time-select"), function (s) {
            if (s.getAttribute("data-part") === "hour") hour = s.value;
            if (s.getAttribute("data-part") === "minute") minute = s.value;
          });
          setSlotTime(id, origTime, hour + ":" + minute);
        });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll(".toggle-btn"), function (btn) {
      on(btn, "click", function () {
        var id = btn.getAttribute("data-toggle");
        var med = findMed(id);
        setMedEnabled(id, !(med && med.enabled !== false));
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
      var daySlots = getSlotsForDate(key);
      var listHtml = daySlots.length
        ? '<div class="stack-gap">' + daySlots.map(function (s) {
            return medRowHtml(s.med, s.time, s.status);
          }).join("") + "</div>"
        : '<p class="empty-note">' + (i === 0 && !medications.length ? "История пока пуста." : "На этот день приёмов нет.") + "</p>";
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
    var time = state.params.time || (med && med.times && med.times[0]) || "";
    if (!med) {
      navigate("today");
      return;
    }
    var pulseClass = needsStrongVisualAlert() ? " pulse" : "";

    appEl.innerHTML =
      '<div class="alert-screen' + pulseClass + '" role="alertdialog" aria-live="assertive" aria-label="Напоминание о приёме лекарства">' +
      '<div class="alert-icon" aria-hidden="true">' + icon("alarmClock") + "</div>" +
      '<h1 class="alert-title" data-autofocus>ПОРА ПРИНЯТЬ ЛЕКАРСТВО</h1>' +
      '<p class="alert-med">' + escapeHtml(med.name) + "</p>" +
      '<p class="alert-med alert-med--dose">' + escapeHtml(med.dose) + " · " + escapeHtml(time) + "</p>" +
      '<div class="btn-stack">' +
      '<button class="btn btn--success btn--huge" id="btn-alert-taken">Я ПРИНЯЛ(А)</button>' +
      '<button class="btn btn--secondary" id="btn-alert-snooze">НАПОМНИТЬ ПОЗЖЕ</button>' +
      '<button class="btn btn--ghost" id="btn-alert-skip">ПРОПУСТИТЬ</button>' +
      "</div>" +
      "</div>";

    on(document.getElementById("btn-alert-taken"), "click", function () {
      markTaken(med.id, time);
      navigate("confirmation", { medId: med.id, time: time, from: "alert" });
    });
    on(document.getElementById("btn-alert-snooze"), "click", function () {
      snoozeSlot(med.id, time, 10);
      navigate("today");
    });
    on(document.getElementById("btn-alert-skip"), "click", function () {
      navigate("today");
    });

    focusMain();
    playChime();
    speak("Сейчас " + spokenTime(new Date()) + ". Пора принять " + med.name + ". " + spokenDose(med.dose) + ".");
  }

  /* ---------------------------------------------------------------------
     Numbers, spelled out for speech — TTS engines (especially older
     Android/MIUI ones) often read a bare digit like "14" one digit at a
     time ("один четыре") instead of as a number, so anything spoken out
     loud gets its digits converted to Russian words first. Covers 0–999,
     which is every hour, minute and realistic dose quantity in the app.
     `gender` picks the correct word for "one"/"two" (одна/два/два часа
     vs две минуты) — the noun that follows was typed by the person and
     is already in the right grammatical form for its own number, so
     only "one"/"two" ever need to agree with the noun's gender.
     ------------------------------------------------------------------- */
  var NUM_ONES = {
    m: ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"],
    f: ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"],
  };
  var NUM_TEENS = ["десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать"];
  var NUM_TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
  var NUM_HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];
  function numberWordsRu(n, gender) {
    n = Math.round(Math.abs(n));
    if (n === 0) return "ноль";
    var ones = NUM_ONES[gender] || NUM_ONES.m;
    var parts = [];
    var h = Math.floor(n / 100), rem = n % 100;
    if (h) parts.push(NUM_HUNDREDS[h]);
    if (rem >= 10 && rem <= 19) {
      parts.push(NUM_TEENS[rem - 10]);
    } else {
      var t = Math.floor(rem / 10), o = rem % 10;
      if (t) parts.push(NUM_TENS[t]);
      if (o) parts.push(ones[o]);
    }
    return parts.length ? parts.join(" ") : "ноль";
  }
  // Best-effort: spell out a leading quantity in a free-text dose (e.g.
  // "2 таблетки" → "две таблетки"); a decimal amount ("0.5 мл") is left
  // as-is rather than risk an unnatural reading.
  function spokenDose(doseText) {
    var text = String(doseText || "").trim();
    // Only a plain whole number at the start is converted — "0.5 мл" or
    // "1,5 таблетки" is left exactly as typed (rest[0] not a digit/dot/comma
    // guards against the regex silently eating a decimal's fractional part).
    var m = /^(\d+)(?![.,]\s?\d)\s*(.*)$/.exec(text);
    if (!m) return text;
    var rest = m[2] || "";
    var gender = /таблет|капсул|ложк|доз|капл|ампул|порц|инъек/i.test(rest) ? "f" : "m";
    return numberWordsRu(parseInt(m[1], 10), gender) + (rest ? " " + rest : "");
  }
  function spokenTime(d) {
    var h = d.getHours(), min = d.getMinutes();
    return numberWordsRu(h, "m") + " " + hoursWordRu(h) + (min ? " " + numberWordsRu(min, "f") + " " + minutesWordRu(min) : "");
  }
  function hoursWordRu(h) {
    var n = h % 100;
    if (n >= 11 && n <= 14) return "часов";
    switch (n % 10) {
      case 1: return "час";
      case 2: case 3: case 4: return "часа";
      default: return "часов";
    }
  }
  function minutesWordRu(m) {
    var n = m % 100;
    if (n >= 11 && n <= 14) return "минут";
    switch (n % 10) {
      case 1: return "минута";
      case 2: case 3: case 4: return "минуты";
      default: return "минут";
    }
  }

  /* =======================================================================
     CONFIRMATION
     ======================================================================= */
  var confirmTimer = null;
  function renderConfirmation() {
    var med = findMed(state.params.medId);
    var time = state.params.time;
    var medName = med ? med.name : "";
    var nextSlot = getNextSlot();
    var nextLine = nextSlot ? "Следующий приём — " + nextSlot.time : "На сегодня приёмов больше нет.";

    appEl.innerHTML =
      '<div class="confirm-screen" role="status">' +
      '<div class="confirm-check" aria-hidden="true">' + icon("checkCircle") + "</div>" +
      '<h1 class="confirm-title" data-autofocus>ПРИЁМ ОТМЕЧЕН</h1>' +
      '<p class="confirm-sub">' + (medName ? escapeHtml(medName) : "") + "</p>" +
      '<p class="confirm-sub confirm-sub--muted">' + escapeHtml(nextLine) + "</p>" +
      '<div class="btn-stack" style="max-width:420px;margin-top:1rem;">' +
      '<button class="btn btn--ghost" id="btn-undo">ОТМЕНИТЬ</button>' +
      "</div>" +
      "</div>";

    on(document.getElementById("btn-undo"), "click", function () {
      if (confirmTimer) clearTimeout(confirmTimer);
      if (med && time) undoTaken(med.id, time);
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
     MEMORY EXERCISES — three short, simple, non-diagnostic exercises.
     SilverCare does not diagnose, treat or prevent memory conditions —
     these are just a small daily habit, like a crossword.
     ======================================================================= */
  function getCurrentSeasonRu() {
    var month = new Date().getMonth() + 1;
    if (month === 12 || month === 1 || month === 2) return "ЗИМА";
    if (month >= 3 && month <= 5) return "ВЕСНА";
    if (month >= 6 && month <= 8) return "ЛЕТО";
    return "ОСЕНЬ";
  }

  var RECALL_SETS = [
    [{ icon: "apple", label: "Яблоко" }, { icon: "key", label: "Ключ" }, { icon: "book", label: "Книга" }],
    [{ icon: "bulb", label: "Лампа" }, { icon: "star", label: "Звезда" }, { icon: "pill", label: "Таблетка" }],
  ];

  function pickExerciseKind() {
    // Rotate deterministically by day so it doesn't change mid-session,
    // but still varies day to day.
    var d = new Date();
    var seed = d.getFullYear() * 400 + d.getMonth() * 31 + d.getDate();
    return seed % 3; // 0 = season, 1 = recall, 2 = matching
  }

  function renderExercise() {
    var kind = pickExerciseKind();
    if (kind === 1) renderExerciseRecall();
    else if (kind === 2) renderExerciseMatching();
    else renderExerciseSeason();
  }

  function renderExerciseSeason() {
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
        navigate("exercise-feedback", { correct: chosen === actual, actual: "Сейчас на самом деле: " + actual + "." });
      });
    });
    on(document.getElementById("btn-exercise-back"), "click", function () {
      navigate("today");
    });
    focusMain();
  }

  function renderExerciseRecall() {
    var setIdx = new Date().getDate() % RECALL_SETS.length;
    var items = RECALL_SETS[setIdx];
    appEl.innerHTML =
      '<div class="screen">' +
      '<h1 class="title" data-autofocus>Упражнение для памяти</h1>' +
      '<p class="lead">Запомните порядок этих предметов.</p>' +
      '<div class="recall-grid" role="group" aria-label="Предметы для запоминания">' +
      items.map(function (it) {
        return '<div class="recall-item">' + icon(it.icon, "recall-item__icon") + "<span>" + it.label + "</span></div>";
      }).join("") +
      "</div>" +
      '<button class="btn btn--primary btn--huge" id="btn-recall-ready" style="margin-top:1rem;">ГОТОВО, СПРОСИТЕ</button>' +
      "</div>";
    on(document.getElementById("btn-recall-ready"), "click", function () {
      navigate("exercise-recall-q", { setIdx: setIdx });
    });
    focusMain();
  }
  function renderExerciseRecallQuestion() {
    var items = RECALL_SETS[state.params.setIdx || 0];
    var correctLabel = items[1].label;
    var options = items.map(function (it) {
      return it.label;
    });
    // Simple shuffle so the correct answer isn't always in the same spot.
    options = options
      .map(function (v) {
        return { v: v, r: Math.random() };
      })
      .sort(function (a, b) {
        return a.r - b.r;
      })
      .map(function (x) {
        return x.v;
      });

    appEl.innerHTML =
      '<div class="screen">' +
      '<h1 class="title" data-autofocus>Что было вторым?</h1>' +
      '<div class="exercise-grid" role="group" aria-label="Варианты ответа">' +
      options.map(function (label) {
        return '<button class="btn btn--primary exercise-btn" data-value="' + escapeAttr(label) + '">' + escapeHtml(label) + "</button>";
      }).join("") +
      "</div>" +
      "</div>";
    Array.prototype.forEach.call(document.querySelectorAll(".exercise-btn"), function (btn) {
      on(btn, "click", function () {
        var chosen = btn.getAttribute("data-value");
        navigate("exercise-feedback", { correct: chosen === correctLabel, actual: "Правильный ответ: " + correctLabel + "." });
      });
    });
    focusMain();
  }

  var MATCH_PAIRS = [
    { icon: "apple", label: "Яблоко" },
    { icon: "key", label: "Ключ" },
    { icon: "book", label: "Книга" },
    { icon: "pill", label: "Таблетка" },
  ];
  function renderExerciseMatching() {
    var pair = MATCH_PAIRS[new Date().getDate() % MATCH_PAIRS.length];
    var distractor = MATCH_PAIRS[(new Date().getDate() + 1) % MATCH_PAIRS.length];
    var options = [pair, distractor]
      .map(function (v) {
        return { v: v, r: Math.random() };
      })
      .sort(function (a, b) {
        return a.r - b.r;
      })
      .map(function (x) {
        return x.v;
      });
    appEl.innerHTML =
      '<div class="screen">' +
      '<h1 class="title" data-autofocus>Найдите пару к слову «' + escapeHtml(pair.label) + '»</h1>' +
      '<div class="recall-grid" role="group" aria-label="Показанный предмет">' +
      '<div class="recall-item">' + icon(pair.icon, "recall-item__icon") + "<span>" + escapeHtml(pair.label) + "</span></div>" +
      "</div>" +
      '<div class="exercise-grid" role="group" aria-label="Варианты ответа">' +
      options.map(function (o) {
        return '<button class="btn btn--primary exercise-btn" data-value="' + escapeAttr(o.label) + '">' + escapeHtml(o.label) + "</button>";
      }).join("") +
      "</div>" +
      "</div>";
    Array.prototype.forEach.call(document.querySelectorAll(".exercise-btn"), function (btn) {
      on(btn, "click", function () {
        var chosen = btn.getAttribute("data-value");
        navigate("exercise-feedback", { correct: chosen === pair.label, actual: "Правильный ответ: " + pair.label + "." });
      });
    });
    focusMain();
  }

  function renderExerciseFeedback() {
    var correct = state.params.correct;
    var actual = state.params.actual || "";
    var feedbackIconName = correct ? "star" : "smile";
    var title = correct ? "ПРАВИЛЬНО!" : "ПОПРОБУЙТЕ ЕЩЁ РАЗ";
    var sub = correct ? "Отличная память." : actual;

    appEl.innerHTML =
      '<div class="screen screen--center">' +
      '<div class="feedback-icon' + (correct ? " feedback-icon--star" : "") + '" aria-hidden="true">' + icon(feedbackIconName) + "</div>" +
      '<h1 class="title" data-autofocus>' + title + "</h1>" +
      '<p class="lead">' + escapeHtml(sub) + "</p>" +
      '<div class="btn-stack" style="margin-top:1.2rem;max-width:420px;">' +
      '<button class="btn btn--primary btn--huge" id="btn-back-home">НА ГЛАВНЫЙ ЭКРАН</button>' +
      "</div>" +
      "</div>";
    on(document.getElementById("btn-back-home"), "click", function () {
      navigate("today");
    });
    focusMain();
    if (correct) speak("Правильно! Отличная память.");
    else speak("Попробуйте ещё раз. " + actual);
  }

  /* =======================================================================
     НАСТРОЙКИ (Settings) — every toggle here actually changes the app.
     ======================================================================= */
  var VISION_LABELS = { good: "Вижу хорошо", low: "Вижу плохо", verylow: "Почти не вижу" };
  var HEARING_LABELS = { good: "Слышу хорошо", low: "Слышу плохо", none: "Не слышу" };
  var TEXTSIZE_LABELS = { normal: "Обычный", large: "Крупный", xlarge: "Очень крупный" };

  function settingsToggleRow(id, iconName, label, checked) {
    return (
      '<div class="switch-row">' +
      '<span class="switch-row__icon" aria-hidden="true">' + icon(iconName) + "</span>" +
      '<span class="switch-row__label">' + label + "</span>" +
      switchHtml(id, checked, false) +
      "</div>"
    );
  }

  function renderSettings() {
    var textSizeOpts = ["normal", "large", "xlarge"].map(function (v) {
      return '<option value="' + v + '"' + (settings.textSize === v ? " selected" : "") + ">" + TEXTSIZE_LABELS[v] + "</option>";
    }).join("");

    var inner =
      '<h1 class="title" data-autofocus>Настройки</h1>' +

      '<div class="settings-block">' +
      settingsToggleRow("switch-voice", "volume", "Голосовые уведомления", settings.voice) +
      '<div class="switch-row">' +
      '<span class="switch-row__icon" aria-hidden="true">' + icon("textSize") + "</span>" +
      '<span class="switch-row__label">Размер текста</span>' +
      '<select class="select-input select-input--compact" id="select-textsize">' + textSizeOpts + "</select>" +
      "</div>" +
      settingsToggleRow("switch-contrast", "contrast", "Высокий контраст", settings.highContrast) +
      settingsToggleRow("switch-exercises", "bulb", "Ежедневные упражнения", settings.exercisesEnabled) +
      '<div class="switch-row">' +
      '<span class="switch-row__icon" aria-hidden="true">' + icon("globe") + "</span>" +
      '<span class="switch-row__label">Язык</span>' +
      '<select class="select-input select-input--compact" id="select-language">' +
      '<option value="ru" selected>Русский</option>' +
      '<option value="kk" disabled>Қазақша (скоро)</option>' +
      "</select>" +
      "</div>" +
      "</div>" +

      '<dl class="settings-summary">' +
      "<div class=\"row\"><dt>Зрение (из настройки)</dt><dd>" + (VISION_LABELS[access.vision] || access.vision) + "</dd></div>" +
      "<div class=\"row\"><dt>Слух (из настройки)</dt><dd>" + (HEARING_LABELS[access.hearing] || access.hearing) + "</dd></div>" +
      "</dl>" +

      '<div class="btn-stack">' +
      '<button class="btn btn--primary" id="btn-redo-onboarding">' + icon("refresh") + "<span>ПОВТОРИТЬ НАСТРОЙКУ ДОСТУПНОСТИ</span></button>" +
      '<button class="btn btn--secondary" id="btn-demo-alert">' + icon("wrench") + "<span>ЗАПУСТИТЬ ТЕСТОВОЕ НАПОМИНАНИЕ</span></button>" +
      '<button class="btn btn--ghost" id="btn-reset-app">' + icon("trash") + "<span>СБРОСИТЬ ПРИЛОЖЕНИЕ (ДЛЯ ДЕМО)</span></button>" +
      "</div>" +
      '<p class="empty-note" style="text-align:center;align-self:center;">Режим для близких (просмотр статуса приёма родственником) — в разработке.</p>' +

      '<div class="btn-stack" style="margin-top:0.25rem;">' +
      '<a class="btn btn--ghost" href="../" id="btn-back-to-site">' + icon("externalLink") + "<span>ВЕРНУТЬСЯ НА САЙТ</span></a>" +
      "</div>";

    renderTabShell("settings", inner);

    on(document.getElementById("switch-voice"), "click", function () {
      settings.voice = !settings.voice;
      saveSettings();
      render();
    });
    on(document.getElementById("switch-contrast"), "click", function () {
      settings.highContrast = !settings.highContrast;
      saveSettings();
      render();
    });
    on(document.getElementById("switch-exercises"), "click", function () {
      settings.exercisesEnabled = !settings.exercisesEnabled;
      saveSettings();
      render();
    });
    on(document.getElementById("select-textsize"), "change", function (ev) {
      settings.textSize = ev.target.value;
      saveSettings();
      render();
    });
    on(document.getElementById("btn-redo-onboarding"), "click", function () {
      redoAccessMode = true;
      navigate("onb-vision");
    });
    on(document.getElementById("btn-reset-app"), "click", function () {
      navigate("reset-confirm");
    });
    on(document.getElementById("btn-demo-alert"), "click", function () {
      var slot = getNextSlot();
      if (slot) {
        triggerAlert(slot.med.id, slot.time);
      } else {
        var med = medications.filter(function (m) {
          return m.enabled !== false && m.frequency.type !== "asNeeded" && m.times.length;
        })[0];
        if (med) triggerAlert(med.id, med.times[0]);
        else announce("Сначала добавьте лекарство с расписанием.");
      }
    });
    focusMain();
  }

  // Wipes every stored key and reloads the page — used only from the
  // reset-confirmation screen below, so the person deliberately chose it
  // (e.g. to show the first-run experience again before a demo).
  function resetApp() {
    try {
      Object.keys(LS_KEYS).forEach(function (k) {
        localStorage.removeItem(LS_KEYS[k]);
      });
    } catch (e) {}
    location.reload();
  }
  function renderResetConfirm() {
    var inner =
      '<div class="screen screen--center">' +
      '<div class="alert-icon" aria-hidden="true">' + icon("alertTriangle") + "</div>" +
      '<h1 class="title" data-autofocus>Сбросить приложение?</h1>' +
      '<p class="lead">Все лекарства, история и настройки будут удалены безвозвратно, и снова откроется анкета первого запуска — как у нового пользователя. Удобно перед демонстрацией.</p>' +
      '<div class="btn-stack" style="max-width:420px;">' +
      '<button class="btn btn--secondary" id="btn-cancel-reset">ОТМЕНА</button>' +
      '<button class="btn btn--danger btn--huge" id="btn-confirm-reset">ДА, СБРОСИТЬ</button>' +
      "</div>" +
      "</div>";
    appEl.innerHTML = '<div class="tab-content">' + inner + "</div>" + bottomNavHtml("settings");
    bindBottomNav();
    on(document.getElementById("btn-cancel-reset"), "click", function () {
      navigate("settings");
    });
    on(document.getElementById("btn-confirm-reset"), "click", function () {
      resetApp();
    });
    focusMain();
  }

  /* =======================================================================
     Router table
     ======================================================================= */
  var SCREENS = {
    "onb-name": renderOnbName,
    "onb-vision": renderOnboardingVision,
    "onb-hearing": renderOnboardingHearing,
    "onb-motor": renderOnboardingMotor,
    "onb-medications": renderOnbMedications,
    "onb-exercise": renderOnbExercise,
    today: renderToday,
    medications: renderMedicationsTab,
    reminders: renderRemindersTab,
    history: renderHistoryTab,
    alert: renderAlert,
    confirmation: renderConfirmation,
    exercise: renderExercise,
    "exercise-recall-q": renderExerciseRecallQuestion,
    "exercise-feedback": renderExerciseFeedback,
    settings: renderSettings,
    "reset-confirm": renderResetConfirm,
  };

  function render() {
    var fn = SCREENS[state.screen];
    if (!fn) fn = renderToday;
    try {
      fn();
    } catch (e) {
      // A render bug must never leave the person staring at a blank
      // screen — fall back to a screen that still lets them navigate.
      appEl.innerHTML =
        '<div class="screen screen--center">' +
        '<h1 class="title" data-autofocus>Что-то пошло не так</h1>' +
        '<p class="lead">Попробуйте вернуться на главный экран.</p>' +
        '<div class="btn-stack"><button class="btn btn--primary btn--huge" id="btn-error-home">НА ГЛАВНЫЙ ЭКРАН</button></div>' +
        "</div>";
      on(document.getElementById("btn-error-home"), "click", function () {
        navigate("today");
      });
    }
  }

  /* ---------------------------------------------------------------------
     Init
     ------------------------------------------------------------------- */
  applyAccessibilityAttrs();
  render();
})();
