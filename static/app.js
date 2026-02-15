// static/app.js
// SousSafe behavior (home + dashboard):
// - Home: recipe search/filter + status polling + contact save/load + dramatic overlay
// - Dashboard: hide/show alert panel when clicking the brand title

(function () {
  // ---------------- Shared: tiny utils ----------------
  function norm(s) {
    return (s || "").toString().trim().toLowerCase();
  }

  function safeNum(x) {
    const n = typeof x === "number" ? x : Number(x);
    return Number.isFinite(n) ? n : null;
  }

  function fmtTemp(t) {
    const n = safeNum(t);
    if (n === null) return "—";
    return `${Math.round(n)}°F`;
  }

  function fmtHum(h) {
    const n = safeNum(h);
    if (n === null) return "—";
    return `${Math.round(n)}%`;
  }

  function fmtAudio(a) {
    const n = safeNum(a);
    if (n === null) return "—";
    return `${Math.round(n)}`;
  }

  function fmtDist(d) {
    const n = safeNum(d);
    if (n === null) return "—";
    return `${Math.round(n)} cm`;
  }

  function fmtTime(ts) {
    // backend sends "YYYY-MM-DD HH:MM:SS"
    if (!ts || typeof ts !== "string") return "";
    const m = ts.match(/\s(\d{2}:\d{2})/);
    return m ? m[1] : ts;
  }

  // ---------------- Dashboard toggle (brand click) ----------------
  // Works on dashboard.html even though there's no recipeGrid there.
  (function initDashboardToggle() {
    const brandToggle = document.getElementById("brandToggle");
    const alertPanel = document.getElementById("alertPanel");
    if (!brandToggle || !alertPanel) return;

    const LS_DASH_PANEL = "soussafe:dashPanelOpen";

    function setOpen(open) {
      alertPanel.classList.toggle("is-hidden", !open);
      try {
        localStorage.setItem(LS_DASH_PANEL, open ? "1" : "0");
      } catch {}
    }

    function getOpen() {
      try {
        return localStorage.getItem(LS_DASH_PANEL) === "1";
      } catch {
        return false;
      }
    }

    // default: hidden
    setOpen(getOpen());

    function toggle() {
      const isHidden = alertPanel.classList.contains("is-hidden");
      setOpen(isHidden); // if hidden -> open
    }

    brandToggle.addEventListener("click", toggle);
    brandToggle.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
  })();

  // ---------------- Home behavior (requires recipeGrid) ----------------
  const grid = document.getElementById("recipeGrid");
  if (!grid) return; // stop here on non-home pages (dashboard already handled above)

  // ---------------- Recipe search/filter ----------------
  const cards = Array.from(grid.querySelectorAll(".productcard"));
  const searchInput = document.getElementById("recipeSearch");
  const filtersEl = document.getElementById("filters");
  const resultCountEl = document.getElementById("resultCount");

  // ---------------- Status elements ----------------
  const timerVal = document.getElementById("timerVal");
  const kitchenVal = document.getElementById("kitchenVal");
  const heatVal = document.getElementById("heatVal");
  const triggerVal = document.getElementById("triggerVal");
  const distanceVal = document.getElementById("distanceVal");
  const audioVal = document.getElementById("audioVal");

  // ---------------- Contact elements ----------------
  const contactForm = document.getElementById("contactForm");
  const contactName = document.getElementById("contactName");
  const contactMethod = document.getElementById("contactMethod");
  const contactValue = document.getElementById("contactValue");
  const contactStatus = document.getElementById("contactStatus");

  // ---------------- Overlay elements ----------------
  const overlay = document.getElementById("alertOverlay");
  const alertDismissBtn = document.getElementById("alertDismissBtn");
  const alertOpenLinkBtn = document.getElementById("alertOpenLinkBtn");

  const alertRiskVal = document.getElementById("alertRiskVal");
  const alertAudioVal = document.getElementById("alertAudioVal");
  const alertTempVal = document.getElementById("alertTempVal");
  const alertHumVal = document.getElementById("alertHumVal");
  const alertDistVal = document.getElementById("alertDistVal");
  const alertTokenVal = document.getElementById("alertTokenVal");
  const alertContactLine = document.getElementById("alertContactLine");

  // ---------------- State ----------------
  let lastOverlayTokenShown = null; // prevent re-showing overlay every poll
  const LS_LAST_TRIGGER = "soussafe:lastTrigger";
  const LS_LAST_OVERLAY_DISMISS = "soussafe:lastOverlayDismissToken";

  function getCardTags(card) {
    // home.html uses data-tags (plural). keep fallback to data-tag.
    const raw = norm(card.getAttribute("data-tags") || card.getAttribute("data-tag"));
    const parts = raw.split(/\s+/).filter(Boolean);
    return Array.from(new Set(parts));
  }

  function getActiveFilter() {
    const active = filtersEl?.querySelector(".chip.is-active");
    return active ? norm(active.getAttribute("data-filter")) : "all";
  }

  function setActiveFilter(next) {
    if (!filtersEl) return;
    const chips = Array.from(filtersEl.querySelectorAll(".chip[data-filter]"));
    chips.forEach((c) =>
      c.classList.toggle("is-active", norm(c.getAttribute("data-filter")) === norm(next))
    );
  }

  function matchesFilter(card, filterKey) {
    if (!filterKey || filterKey === "all") return true;
    return getCardTags(card).includes(filterKey);
  }

  function matchesSearch(card, q) {
    if (!q) return true;
    const title = norm(card.getAttribute("data-title")) || norm(card.textContent);
    const tags = getCardTags(card).join(" ");
    return title.includes(q) || tags.includes(q);
  }

  function applyFilters() {
    const q = norm(searchInput?.value);
    const filterKey = getActiveFilter();

    let shown = 0;
    cards.forEach((card) => {
      const ok = matchesFilter(card, filterKey) && matchesSearch(card, q);
      card.style.display = ok ? "" : "none";
      if (ok) shown += 1;
    });

    if (resultCountEl) {
      const total = cards.length;
      resultCountEl.textContent =
        shown === total ? `Showing ${shown} recipes` : `Showing ${shown} of ${total} recipes`;
    }
  }

  // ------------ Events: recipes ------------
  if (searchInput) {
    searchInput.addEventListener("input", applyFilters);
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        searchInput.value = "";
        applyFilters();
      }
    });
  }

  if (filtersEl) {
    filtersEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip[data-filter]");
      if (!btn) return;
      setActiveFilter(norm(btn.getAttribute("data-filter")));
      applyFilters();
    });
  }

  // ------------ Status helpers ------------
  function setHeatStageFromRisk(risk) {
    if (!heatVal) return;
    const r = safeNum(risk) ?? 0;

    let stage = "Prep";
    let dotClass = "blue";

    if (r >= 8) {
      stage = "High";
      dotClass = "red";
    } else if (r >= 5) {
      stage = "Simmer";
      dotClass = "yellow";
    } else {
      stage = "Prep";
      dotClass = "blue";
    }

    heatVal.innerHTML = `<span class="dot ${dotClass}"></span> ${stage}`;
  }

  function setOverlayOpen(isOpen) {
    if (!overlay) return;
    overlay.style.display = isOpen ? "grid" : "none";
    overlay.setAttribute("aria-hidden", isOpen ? "false" : "true");
    document.body.style.overflow = isOpen ? "hidden" : "";
  }

  function shouldShowOverlay(ctx) {
    if (!overlay) return false;
    if (!ctx || ctx.ok !== true) return false;
    if (!ctx.last_token) return false;

    const risk = safeNum(ctx.risk) ?? 0;
    const threshold = safeNum(ctx.threshold) ?? null;
    if (threshold === null) return false;

    if (risk < threshold) return false;

    if (lastOverlayTokenShown === ctx.last_token) return false;

    const dismissedToken = localStorage.getItem(LS_LAST_OVERLAY_DISMISS);
    if (dismissedToken && dismissedToken === ctx.last_token) return false;

    return true;
  }

  function fillOverlay(ctx, contact) {
    if (!overlay) return;

    const risk = safeNum(ctx.risk);
    const audio = safeNum(ctx.audio);
    const temp = safeNum(ctx.temp);
    const hum = safeNum(ctx.humidity);
    const dist = safeNum(ctx.distance);

    if (alertRiskVal) alertRiskVal.textContent = risk === null ? "—" : `${Math.round(risk)}/10`;
    if (alertAudioVal) alertAudioVal.textContent = audio === null ? "—" : `${Math.round(audio)}`;
    if (alertTempVal) alertTempVal.textContent = fmtTemp(temp);
    if (alertHumVal) alertHumVal.textContent = fmtHum(hum);
    if (alertDistVal) alertDistVal.textContent = fmtDist(dist);
    if (alertTokenVal) alertTokenVal.textContent = ctx.last_token || "—";

    if (alertOpenLinkBtn) {
      alertOpenLinkBtn.href = ctx.public_link || "#";
    }

    if (alertContactLine) {
      if (contact && contact.value) {
        const label = contact.name ? contact.name : "Trusted contact";
        alertContactLine.style.display = "block";
        const method = (contact.method || "").toString().toUpperCase();
        alertContactLine.textContent = `${label}: ${method} ${contact.value}`;
      } else {
        alertContactLine.style.display = "none";
        alertContactLine.textContent = "";
      }
    }
  }

  // ------------ Contact save/load ------------
  async function loadContact() {
    try {
      const res = await fetch("/api/contact", { cache: "no-store" });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || data.ok !== true) return null;

      if (contactName) contactName.value = data.name || "";
      if (contactMethod) contactMethod.value = data.method || "sms";
      if (contactValue) contactValue.value = data.value || "";

      if (contactStatus) {
        contactStatus.textContent = data.value
          ? `Saved: ${data.name || "Trusted contact"} (${(data.method || "").toUpperCase()} ${data.value})`
          : "Not set";
      }
      return data;
    } catch {
      return null;
    }
  }

  async function saveContact(payload) {
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.ok !== true) {
        if (contactStatus) contactStatus.textContent = "Could not save contact (server error).";
        return null;
      }
      if (contactStatus) {
        contactStatus.textContent = `Saved: ${data.name || "Trusted contact"} (${(data.method || "").toUpperCase()} ${data.value})`;
      }
      return data;
    } catch {
      if (contactStatus) contactStatus.textContent = "Could not save contact (network error).";
      return null;
    }
  }

  if (contactForm) {
    contactForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = {
        name: (contactName?.value || "").trim(),
        method: (contactMethod?.value || "sms").trim(),
        value: (contactValue?.value || "").trim(),
      };
      if (!payload.value) {
        if (contactStatus) contactStatus.textContent = "Please enter a phone or email.";
        return;
      }
      await saveContact(payload);
    });
  }

  // ------------ Overlay buttons ------------
  function dismissOverlay() {
    const token = alertTokenVal?.textContent?.trim();
    if (token && token !== "—") {
      localStorage.setItem(LS_LAST_OVERLAY_DISMISS, token);
      lastOverlayTokenShown = token;
    }
    setOverlayOpen(false);
  }

  if (alertDismissBtn) {
    alertDismissBtn.addEventListener("click", dismissOverlay);
  }

  if (overlay) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) dismissOverlay();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && overlay.style.display === "grid") dismissOverlay();
    });
  }

  // ------------ Status hydration from /api/context ------------
  async function tryHydrateContext() {
    try {
      const res = await fetch("/api/context", { cache: "no-store" });
      if (!res.ok) return;

      const ctx = await res.json();
      if (!ctx || ctx.ok !== true) return;

      // If no alerts yet
      if (!ctx.last_token) {
        if (kitchenVal) kitchenVal.textContent = "—";
        if (distanceVal) distanceVal.textContent = "—";
        if (audioVal) audioVal.textContent = "—";
        setHeatStageFromRisk(0);
        if (triggerVal) triggerVal.textContent = "—";
        return;
      }

      // Kitchen: Temp · Humidity
      if (kitchenVal) kitchenVal.textContent = `${fmtTemp(ctx.temp)} · ${fmtHum(ctx.humidity)}`;

      // Distance + audio (only if backend returns them; otherwise they'll show "—")
      if (distanceVal) distanceVal.textContent = fmtDist(ctx.distance);
      if (audioVal) audioVal.textContent = fmtAudio(ctx.audio);

      // Heat: stage from risk
      setHeatStageFromRisk(ctx.risk);

      // Last link: show token + time
      if (triggerVal) {
        const timePart = fmtTime(ctx.created_at);
        triggerVal.textContent = timePart ? `${ctx.last_token} · ${timePart}` : ctx.last_token;
      }

      // Timer placeholder (until you wire real timer API)
      if (timerVal && (!timerVal.textContent || !timerVal.textContent.trim())) timerVal.textContent = "15:00";

      // LocalStorage stamp for “last trigger”
      const stamp = new Date().toLocaleString();
      localStorage.setItem(LS_LAST_TRIGGER, `${ctx.last_token} · ${stamp}`);

      // Overlay logic
      if (shouldShowOverlay(ctx)) {
        const contact = await loadContact(); // best-effort
        fillOverlay(ctx, contact);
        lastOverlayTokenShown = ctx.last_token;
        setOverlayOpen(true);
      }
    } catch {
      // ignore
    }
  }

  function hydrateLastTriggerFromLocalStorage() {
    if (!triggerVal) return;
    const last = localStorage.getItem(LS_LAST_TRIGGER);
    if (!last) return;

    const cur = triggerVal.textContent.trim();
    if (cur === "—" || cur === "") triggerVal.textContent = last;
  }

  // If your /r/<token> pages run this JS too, capture token from URL
  function captureTokenFromUrl() {
    const m = window.location.pathname.match(/^\/r\/([A-Za-z0-9_-]+)$/);
    if (!m) return;
    const token = m[1];
    const stamp = new Date().toLocaleString();
    localStorage.setItem(LS_LAST_TRIGGER, `${token} · ${stamp}`);
  }

  // ------------ Init ------------
  captureTokenFromUrl();
  hydrateLastTriggerFromLocalStorage();
  applyFilters();
  loadContact(); // hydrate UI if endpoint exists

  tryHydrateContext();
  setInterval(tryHydrateContext, 2500);
})();
