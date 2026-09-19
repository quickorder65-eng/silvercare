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
     Medications (sample data for the demo)
     ------------------------------------------------------------------- */
  var DEFAULT_MEDS = [
    { id: "m1", name: "Амлодипин", dose: "1 таблетка", time: "09:00", takenDate: null },
    { id: "m2", name: "Метформин", dose: "1 таблетка", time: "14:00", takenDate: null },
    { id: "m3", name: "Аспирин", dose: "половина таблетки", time: "20:00", takenDate: null },
  ];
  var medications = loadJSON(LS_KEYS.meds, DEFAULT_MEDS);
  // Guard against a corrupted/old shape in storage.
  if (!Array.isArray(medications) || medications.length === 0) {
    medications = DEFAULT_MEDS;
  }

  function saveMeds() {
    saveJSON(LS_KEYS.meds, medications);
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }
  function isTakenToday(med) {
    return med.takenDate === todayStr();
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
  // "2026-9-19@14:00". Used so a reminder fires exactly once per slot,
  // no matter how many times the 15-second scheduler check runs while
  // the clock still reads 14:00, and even if the page reloads meanwhile.
  function slotKey(med) {
    return todayStr() + "@" + med.time;
  }

  function getNextMedication() {
    var pending = medications.filter(function (m) {
      return !isTakenToday(m);
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
    // Everything left is earlier than now (overdue) — surface the earliest.
    return pending.sort(function (a, b) {
      return timeToMinutes(a.time) - timeToMinutes(b.time);
    })[0];
  }

  function markTaken(id) {
    var med = findMed(id);
    if (!med) return;
    med.takenDate = todayStr();
    med.snoozeUntil = null;
    saveMeds();
  }
  function undoTaken(id) {
    var med = findMed(id);
    if (!med) return;
    med.takenDate = null;
    saveMeds();
  }
  function snoozeMed(id, minutes) {
    var med = findMed(id);
    if (!med) return;
    med.snoozeUntil = Date.now() + minutes * 60 * 1000;
    saveMeds();
  }

  /* ---------------------------------------------------------------------
     App state / router
     ------------------------------------------------------------------- */
  var state = {
    screen: onboarded ? "home" : "onb-welcome",
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
  function el(html) {
    var wrap = document.createElement("div");
    wrap.innerHTML = html.trim();
    return wrap.firstElementChild;
  }
  function on(node, event, handler) {
    if (node) node.addEventListener(event, handler);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
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
      '<button class="choice-btn" data-value="good"><span class="choice-icon" aria-hidden="true">👁</span><span>ВИЖУ ХОРОШО</span></button>' +
      '<button class="choice-btn" data-value="low"><span class="choice-icon" aria-hidden="true">🔍</span><span>ВИЖУ ПЛОХО</span></button>' +
      '<button class="choice-btn" data-value="verylow"><span class="choice-icon" aria-hidden="true">🦯</span><span>ПОЧТИ НЕ ВИЖУ</span></button>' +
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
      '<button class="choice-btn" data-value="good"><span class="choice-icon" aria-hidden="true">🔊</span><span>СЛЫШУ ХОРОШО</span></button>' +
      '<button class="choice-btn" data-value="low"><span class="choice-icon" aria-hidden="true">🦻</span><span>СЛЫШУ ПЛОХО</span></button>' +
      '<button class="choice-btn" data-value="none"><span class="choice-icon" aria-hidden="true">🔇</span><span>НЕ СЛЫШУ</span></button>' +
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
      '<button class="choice-btn" data-value="good"><span class="choice-icon" aria-hidden="true">👍</span><span>ДА</span></button>' +
      '<button class="choice-btn" data-value="difficult"><span class="choice-icon" aria-hidden="true">✋</span><span>МНЕ ТРУДНО</span></button>' +
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
      '<div class="alert-icon" aria-hidden="true">✅</div>' +
      '<h1 class="title" data-autofocus>SilverCare настроен для вас</h1>' +
      '<div class="btn-stack" style="margin-top:1.2rem;">' +
      '<button class="btn btn--primary btn--huge" id="btn-continue">ПРОДОЛЖИТЬ</button>' +
      "</div>" +
      "</div>";
    on(document.getElementById("btn-continue"), "click", function () {
      onboarded = true;
      saveJSON(LS_KEYS.onboarded, true);
      navigate("home");
    });
    focusMain();
    speak("SilverCare настроен для вас.");
  }

  /* =======================================================================
     HOME
     ======================================================================= */

  var WEEKDAYS = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
  var clockTimer = null;

  function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
  }
  function formatClock(d) {
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function renderHome() {
    var now = new Date();
    var next = getNextMedication();

    var medBlock;
    if (next) {
      medBlock =
        '<div class="med-card">' +
        '<span class="med-card__icon" aria-hidden="true">💊</span>' +
        '<span class="med-card__label">Следующий приём</span>' +
        '<span class="med-card__time">' + escapeHtml(next.time) + "</span>" +
        '<span class="med-card__name">' + escapeHtml(next.name) + "</span>" +
        '<span class="med-card__dose">' + escapeHtml(next.dose) + "</span>" +
        "</div>";
    } else {
      medBlock =
        '<div class="med-card">' +
        '<span class="med-card__icon" aria-hidden="true">✅</span>' +
        '<span class="med-card__label">На сегодня всё принято</span>' +
        "</div>";
    }

    appEl.innerHTML =
      '<div class="screen">' +
      '<div class="home-header">' +
      '<h1 class="clock" data-autofocus id="home-clock" aria-label="Текущее время ' + escapeHtml(formatClock(now)) + '">' + escapeHtml(formatClock(now)) + "</h1>" +
      '<p class="day-name" id="home-day">' + WEEKDAYS[now.getDay()] + "</p>" +
      "</div>" +
      medBlock +
      (next
        ? '<div class="home-actions">' +
          '<button class="btn btn--primary btn--huge" id="btn-taken">Я ПРИНЯЛ(А)</button>' +
          '<button class="btn btn--secondary" id="btn-snooze">НАПОМНИТЬ ПОЗЖЕ</button>' +
          "</div>"
        : "") +
      '<div class="secondary-row">' +
      '<button class="btn btn--secondary btn--compact" id="btn-exercise" aria-label="Открыть упражнение для памяти"><span aria-hidden="true">🧠</span> <span>Память</span></button>' +
      '<button class="btn btn--secondary btn--compact" id="btn-settings" aria-label="Открыть настройки"><span aria-hidden="true">⚙</span> <span>Настройки</span></button>' +
      "</div>" +
      "</div>";

    if (next) {
      on(document.getElementById("btn-taken"), "click", function () {
        markTaken(next.id);
        navigate("confirmation", { medId: next.id, from: "home" });
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
    on(document.getElementById("btn-settings"), "click", function () {
      navigate("settings");
    });

    focusMain();

    // Live clock: update every 15s without a full re-render (avoids
    // yanking focus away from the user while they're reading the screen).
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = setInterval(function () {
      if (state.screen !== "home") {
        clearInterval(clockTimer);
        clockTimer = null;
        return;
      }
      var d = new Date();
      var clockEl = document.getElementById("home-clock");
      var dayEl = document.getElementById("home-day");
      if (clockEl) {
        clockEl.textContent = formatClock(d);
        clockEl.setAttribute("aria-label", "Текущее время " + formatClock(d));
      }
      if (dayEl) dayEl.textContent = WEEKDAYS[d.getDay()];
    }, 15000);
  }

  /* =======================================================================
     MEDICATION ALERT (full screen)
     ======================================================================= */

  function renderAlert() {
    var med = findMed(state.params.medId) || medications[0];
    var pulseClass = needsStrongVisualAlert() ? " pulse" : "";

    appEl.innerHTML =
      '<div class="alert-screen' + pulseClass + '" role="alertdialog" aria-live="assertive" aria-label="Напоминание о приёме лекарства">' +
      '<div class="alert-icon" aria-hidden="true">⏰💊</div>' +
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
      navigate("home");
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
      '<div class="confirm-check" aria-hidden="true">✅</div>' +
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
      navigate("home");
    });

    focusMain();
    speak("Приём лекарства отмечен.");

    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = setTimeout(function () {
      if (state.screen === "confirmation") navigate("home");
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
      navigate("home");
    });
    focusMain();
  }

  function renderExerciseFeedback() {
    var correct = state.params.correct;
    var actual = state.params.actual;
    var icon = correct ? "🎉" : "🙂";
    var title = correct ? "ПРАВИЛЬНО!" : "ХОРОШО!";
    var sub = correct ? "Отличная память." : "Сейчас на самом деле: " + escapeHtml(actual) + ".";

    appEl.innerHTML =
      '<div class="screen screen--center">' +
      '<div class="feedback-icon" aria-hidden="true">' + icon + "</div>" +
      '<h1 class="title" data-autofocus>' + title + "</h1>" +
      '<p class="lead">' + sub + "</p>" +
      '<div class="btn-stack" style="margin-top:1.2rem;max-width:420px;">' +
      '<button class="btn btn--primary btn--huge" id="btn-back-home">НА ГЛАВНЫЙ ЭКРАН</button>' +
      "</div>" +
      "</div>";

    on(document.getElementById("btn-back-home"), "click", function () {
      navigate("home");
    });
    focusMain();
    if (correct) speak("Правильно! Отличная память.");
    else speak("Хорошо. Сейчас на самом деле " + actual + ".");
  }

  /* =======================================================================
     SETTINGS
     ======================================================================= */

  var VISION_LABELS = { good: "Вижу хорошо", low: "Вижу плохо", verylow: "Почти не вижу" };
  var HEARING_LABELS = { good: "Слышу хорошо", low: "Слышу плохо", none: "Не слышу" };
  var MOTOR_LABELS = { good: "Да, удобно", difficult: "Мне трудно" };

  function renderSettings() {
    appEl.innerHTML =
      '<div class="screen">' +
      '<h1 class="title" data-autofocus>Настройки</h1>' +
      '<dl class="settings-summary">' +
      '<div class="row"><dt>Зрение</dt><dd>' + (VISION_LABELS[access.vision] || access.vision) + "</dd></div>" +
      '<div class="row"><dt>Слух</dt><dd>' + (HEARING_LABELS[access.hearing] || access.hearing) + "</dd></div>" +
      '<div class="row"><dt>Кнопки</dt><dd>' + (MOTOR_LABELS[access.motor] || access.motor) + "</dd></div>" +
      "</dl>" +
      '<div class="btn-stack">' +
      '<button class="btn btn--primary" id="btn-redo-onboarding">ПОВТОРИТЬ НАСТРОЙКУ</button>' +
      '<button class="btn btn--secondary" id="btn-demo-alert">🔧 НАПОМНИТЬ СЕЙЧАС (ДЕМО)</button>' +
      '<button class="btn btn--ghost" id="btn-settings-back">НАЗАД</button>' +
      "</div>" +
      "</div>";

    on(document.getElementById("btn-redo-onboarding"), "click", function () {
      navigate("onb-vision");
    });
    on(document.getElementById("btn-demo-alert"), "click", function () {
      var med = getNextMedication() || medications[0];
      triggerAlert(med.id);
    });
    on(document.getElementById("btn-settings-back"), "click", function () {
      navigate("home");
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
    home: renderHome,
    alert: renderAlert,
    confirmation: renderConfirmation,
    exercise: renderExercise,
    "exercise-feedback": renderExerciseFeedback,
    settings: renderSettings,
  };

  function render() {
    var fn = SCREENS[state.screen];
    if (!fn) fn = renderHome;
    fn();
  }

  /* ---------------------------------------------------------------------
     Init
     ------------------------------------------------------------------- */
  applyAccessibilityAttrs();
  render();
})();
