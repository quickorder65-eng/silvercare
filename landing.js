(function () {
  "use strict";

  // Mobile nav toggle.
  var toggle = document.getElementById("nav-toggle");
  var mobileNav = document.getElementById("mobile-nav");
  if (toggle && mobileNav) {
    toggle.addEventListener("click", function () {
      var isOpen = mobileNav.classList.toggle("is-open");
      mobileNav.hidden = !isOpen;
      toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });
    // Close the mobile menu after choosing a link.
    Array.prototype.forEach.call(mobileNav.querySelectorAll("a"), function (a) {
      a.addEventListener("click", function () {
        mobileNav.classList.remove("is-open");
        mobileNav.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
      });
    });
    // Also close it if the page scrolls while it's open, so a tall open
    // menu never lingers awkwardly inside the sticky header.
    window.addEventListener(
      "scroll",
      function () {
        if (mobileNav.classList.contains("is-open")) {
          mobileNav.classList.remove("is-open");
          mobileNav.hidden = true;
          toggle.setAttribute("aria-expanded", "false");
        }
      },
      { passive: true }
    );
  }

  // Gentle scroll-reveal for sections, skipped entirely for anyone who
  // prefers reduced motion.
  var prefersReducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var revealEls = document.querySelectorAll(".reveal");
  if (prefersReducedMotion || !("IntersectionObserver" in window)) {
    Array.prototype.forEach.call(revealEls, function (el) {
      el.classList.add("is-visible");
    });
  } else {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    Array.prototype.forEach.call(revealEls, function (el) {
      observer.observe(el);
    });
  }
})();
