// static/app.js
// SousSafe behavior (home + dashboard):
// - Home: recipe search/filter + status polling + contacts (max 3) + alert overlay
// - Home: click SousSafe title to open/close the alert overlay (manual reveal)
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

  function escapeHtml(s) {
    return (s || "")
      .toString()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ---------------- Dashboard toggle (brand click) ----------------
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

    setOpen(getOpen());

    function toggle() {
      const isHidden = alertPanel.classList.contains("is-hidden");
      setOpen(isHidden);
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
  if (!grid) return;

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

  // Home brand click
  const brandToggleHome = document.getElementById("brandToggle");

  // ---------------- State ----------------
  let lastOverlayTokenShown = null;
  let lastCtx = null;

  const LS_LAST_TRIGGER = "soussafe:lastTrigger";
  const LS_LAST_OVERLAY_DISMISS = "soussafe:lastOverlayDismissToken";

  // Contacts cache
  let contactsCache = [];
  let contactsMax = 3;

  function getCardTags(card) {
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
    }

    heatVal.innerHTML = `<span class="dot ${dotClass}"></span> ${stage}`;
  }

  function isOverlayOpen() {
    if (!overlay) return false;
    return overlay.style.display === "grid";
  }

  function setOverlayOpen(isOpen) {
    if (!overlay) return;
    overlay.style.display = isOpen ? "grid" : "none";
    overlay.setAttribute("aria-hidden", isOpen ? "false" : "true");
    document.body.style.overflow = isOpen ? "hidden" : "";
  }

  function shouldShowOverlay(ctx) {
    // auto-open rule (optional)
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

  function pickPrimaryContact() {
    // Prefer email contacts, else first contact
    if (!contactsCache || contactsCache.length === 0) return null;
    const email = contactsCache.find((c) => norm(c.method) === "email");
    return email || contactsCache[0];
  }

  function fillOverlay(ctx) {
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
      const c = pickPrimaryContact();
      if (c && c.value) {
        const label = c.name ? c.name : "Trusted contact";
        const method = (c.method || "").toString().toUpperCase();
        alertContactLine.style.display = "block";
        alertContactLine.textContent = `${label}: ${method} ${c.value}`;
      } else {
        alertContactLine.style.display = "none";
        alertContactLine.textContent = "";
      }
    }
  }

  // ------------ Contacts: load / render / add / delete ------------
  function ensureContactsListUI() {
    // Create a small list UI under the contact status line if it doesn't exist.
    if (!contactForm) return null;

    let list = document.getElementById("contactList");
    if (!list) {
      list = document.createElement("div");
      list.id = "contactList";
      list.style.marginTop = "10px";
      // insert after contactStatus
      const anchor = contactStatus || contactForm;
      anchor.parentNode.insertBefore(list, anchor.nextSibling);
    }
    return list;
  }

  function setContactInputsDisabled(disabled) {
    if (contactName) contactName.disabled = disabled;
    if (contactMethod) contactMethod.disabled = disabled;
    if (contactValue) contactValue.disabled = disabled;
    const btn = document.getElementById("contactSaveBtn");
    if (btn) btn.disabled = disabled;
  }

  function renderContacts() {
    const listEl = ensureContactsListUI();
    if (!listEl) return;

    const n = contactsCache.length;
    const remaining = Math.max(0, contactsMax - n);

    if (contactStatus) {
      contactStatus.textContent =
        n === 0
          ? `No contacts yet • Add up to ${contactsMax}`
          : `Saved ${n}/${contactsMax} contact${n === 1 ? "" : "s"} • ${remaining} slot${remaining === 1 ? "" : "s"} left`;
    }

    // Disable add when max reached
    setContactInputsDisabled(n >= contactsMax);

    if (n === 0) {
      listEl.innerHTML = `<div class="subtle">No trusted contacts saved yet.</div>`;
      return;
    }

    const items = contactsCache
      .map((c) => {
        const id = c.id;
        const nm = escapeHtml(c.name || "Trusted contact");
        const method = escapeHtml((c.method || "").toUpperCase());
        const val = escapeHtml(c.value || "");
        return `
          <div class="contactitem" data-id="${id}" style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 10px; border:1px solid rgba(255,255,255,.10); border-radius:10px; margin-top:8px;">
            <div style="min-width:0">
              <div class="mono" style="font-size:.92rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${nm}</div>
              <div class="subtle" style="font-size:.86rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${method} ${val}</div>
            </div>
            <button class="btn ghost contactRemoveBtn" type="button" data-id="${id}" title="Remove contact">Remove</button>
          </div>
        `;
      })
      .join("");

    listEl.innerHTML = items;

    // wire remove buttons
    listEl.querySelectorAll(".contactRemoveBtn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-id");
        if (!id) return;
        await deleteContact(id);
      });
    });
  }

  async function loadContacts() {
    try {
      const res = await fetch("/api/contact", { cache: "no-store" });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || data.ok !== true) return null;

      contactsCache = Array.isArray(data.contacts) ? data.contacts : [];
      contactsMax = Number.isFinite(Number(data.max)) ? Number(data.max) : 3;

      renderContacts();
      return data;
    } catch {
      return null;
    }
  }

  async function addContact(payload) {
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok || !data || data.ok !== true) {
        const msg = (data && data.error) ? data.error : "Could not add contact (server error).";
        if (contactStatus) contactStatus.textContent = msg;
        return null;
      }

      // server returns updated contacts
      contactsCache = Array.isArray(data.contacts) ? data.contacts : contactsCache;

      // SNS note (if email)
      if (data.sns && payload.method === "email") {
        if (contactStatus) {
          contactStatus.textContent = data.sns.ok
            ? "Email added. Check inbox and confirm SNS subscription."
            : `Email added, but SNS subscribe failed: ${data.sns.error || "unknown error"}`;
        }
      }

      // clear inputs for next add
      if (contactName) contactName.value = "";
      if (contactValue) contactValue.value = "";

      renderContacts();
      return data;
    } catch {
      if (contactStatus) contactStatus.textContent = "Could not add contact (network error).";
      return null;
    }
  }

  async function deleteContact(id) {
    try {
      const res = await fetch(`/api/contact/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => null);

      if (!res.ok || !data || data.ok !== true) {
        const msg = (data && data.error) ? data.error : "Could not remove contact.";
        if (contactStatus) contactStatus.textContent = msg;
        return null;
      }

      contactsCache = Array.isArray(data.contacts) ? data.contacts : [];
      renderContacts();
      return data;
    } catch {
      if (contactStatus) contactStatus.textContent = "Could not remove contact (network error).";
      return null;
    }
  }

  if (contactForm) {
    contactForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = {
        name: (contactName?.value || "").trim(),
        method: (contactMethod?.value || "email").trim(),
        value: (contactValue?.value || "").trim(),
      };
      if (!payload.value) {
        if (contactStatus) contactStatus.textContent = "Please enter a phone or email.";
        return;
      }
      await addContact(payload);
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
      if (e.key === "Escape" && isOverlayOpen()) dismissOverlay();
    });
  }

  // Manual open/close overlay when clicking SousSafe title
  async function openOverlayFromBrandClick() {
    if (!overlay) return;

    if (isOverlayOpen()) {
      setOverlayOpen(false);
      return;
    }

    // Ensure we have contacts for the contact line
    await loadContacts().catch(() => null);

    // Prefer freshest context
    let ctx = lastCtx;
    try {
      const res = await fetch("/api/context", { cache: "no-store" });
      if (res.ok) {
        const fresh = await res.json();
        if (fresh && fresh.ok === true) ctx = fresh;
      }
    } catch {}

    if (!ctx || ctx.ok !== true || !ctx.last_token) {
      if (alertTokenVal) alertTokenVal.textContent = "—";
      if (alertRiskVal) alertRiskVal.textContent = "—";
      if (alertAudioVal) alertAudioVal.textContent = "—";
      if (alertTempVal) alertTempVal.textContent = "—";
      if (alertHumVal) alertHumVal.textContent = "—";
      if (alertDistVal) alertDistVal.textContent = "—";
      if (alertContactLine) alertContactLine.style.display = "none";
      if (alertOpenLinkBtn) alertOpenLinkBtn.href = "#";
      setOverlayOpen(true);
      return;
    }

    fillOverlay(ctx);
    lastOverlayTokenShown = ctx.last_token;
    setOverlayOpen(true);
  }

  if (brandToggleHome) {
    brandToggleHome.addEventListener("click", openOverlayFromBrandClick);
    brandToggleHome.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openOverlayFromBrandClick();
      }
    });
  }

  // ------------ Status hydration from /api/context ------------
  async function tryHydrateContext() {
    try {
      const res = await fetch("/api/context", { cache: "no-store" });
      if (!res.ok) return;

      const ctx = await res.json();
      if (!ctx || ctx.ok !== true) return;

      lastCtx = ctx;

      if (!ctx.last_token) {
        if (kitchenVal) kitchenVal.textContent = "—";
        if (distanceVal) distanceVal.textContent = "—";
        if (audioVal) audioVal.textContent = "—";
        setHeatStageFromRisk(0);
        if (triggerVal) triggerVal.textContent = "—";
        return;
      }

      if (kitchenVal) kitchenVal.textContent = `${fmtTemp(ctx.temp)} · ${fmtHum(ctx.humidity)}`;
      if (distanceVal) distanceVal.textContent = fmtDist(ctx.distance);
      if (audioVal) audioVal.textContent = fmtAudio(ctx.audio);
      setHeatStageFromRisk(ctx.risk);

      if (triggerVal) {
        const timePart = fmtTime(ctx.created_at);
        triggerVal.textContent = timePart ? `${ctx.last_token} · ${timePart}` : ctx.last_token;
      }

      if (timerVal && (!timerVal.textContent || !timerVal.textContent.trim())) {
        timerVal.textContent = "15:00";
      }

      const stamp = new Date().toLocaleString();
      localStorage.setItem(LS_LAST_TRIGGER, `${ctx.last_token} · ${stamp}`);

      // OPTIONAL: auto-open overlay when risk >= threshold
      // If you want ONLY manual open via brand click, comment out this block.
      if (shouldShowOverlay(ctx)) {
        // ensure contacts are loaded (for contact line)
        if (!contactsCache || contactsCache.length === 0) {
          await loadContacts().catch(() => null);
        }
        fillOverlay(ctx);
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

  // load contacts on page load so list renders
  loadContacts();

  tryHydrateContext();
  setInterval(tryHydrateContext, 2500);
})();
