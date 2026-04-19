// ══════════════════════════════════════════════════════════════════════════════
// Gmail Organizer v1.6.2 - Popup Script
// Enhanced with: snooze, thread summaries, priority inbox, error boundaries, theme toggle
// ══════════════════════════════════════════════════════════════════════════════

import { TRANSLATIONS, LANG_META } from './translations.js';

// ── Language / i18n ───────────────────────────────────────────────────────

function t(key) {
  const lang = window._currentLang || 'en';
  return (TRANSLATIONS[lang] && TRANSLATIONS[lang][key]) || TRANSLATIONS['en'][key] || key;
}

function applyTranslations() {
  // Text content
  document.querySelectorAll('[data-i18n]').forEach(function(el) {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  // Placeholders
  document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
}

function getDefaultLang() {
  const browserLang = (navigator.language || navigator.userLanguage || 'en').substring(0, 2).toLowerCase();
  const supported = ['en', 'fr', 'es', 'de', 'it', 'tr', 'ar'];
  return supported.includes(browserLang) ? browserLang : 'en';
}

function initLangPicker() {
  const btn = document.getElementById('langPickerBtn');
  const dropdown = document.getElementById('langDropdown');
  if (!btn || !dropdown) return;

  // Load saved lang or detect from browser
  chrome.storage.local.get({ uiLanguage: '' }, function(data) {
    const lang = data.uiLanguage || getDefaultLang();
    setLang(lang, false);
  });

  // Move dropdown to body so it's never clipped by overflow:hidden ancestors
  document.body.appendChild(dropdown);

  // Toggle dropdown with fixed positioning
  btn.addEventListener('click', function(e) {
    e.stopPropagation();
    if (dropdown.style.display !== 'none') {
      dropdown.style.display = 'none';
      return;
    }
    const rect = btn.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.top = (rect.bottom + 4) + 'px';
    dropdown.style.right = (window.innerWidth - rect.right) + 'px';
    dropdown.style.left = 'auto';
    dropdown.style.display = 'block';
  });

  // Close on outside click
  document.addEventListener('click', function() {
    dropdown.style.display = 'none';
  });

  // Language option clicks
  dropdown.querySelectorAll('.lang-opt').forEach(function(opt) {
    opt.addEventListener('click', function(e) {
      e.stopPropagation();
      const lang = opt.getAttribute('data-lang');
      setLang(lang, true);
      dropdown.style.display = 'none';
    });
  });
}

function setLang(lang, save) {
  window._currentLang = lang;
  const meta = LANG_META[lang] || LANG_META['en'];
  const btn = document.getElementById('langPickerBtn');
  if (btn) btn.textContent = meta.flag;

  // Highlight active option
  document.querySelectorAll('.lang-opt').forEach(function(opt) {
    const isActive = opt.getAttribute('data-lang') === lang;
    opt.style.background = isActive ? 'rgba(167,139,250,.2)' : 'none';
    opt.style.borderColor = isActive ? 'rgba(167,139,250,.4)' : 'transparent';
  });

  applyTranslations();

  if (save) {
    chrome.storage.local.set({ uiLanguage: lang });
  }
}

// Helper: update text on a tool-grid button without wiping its icon span
function setToolBtnLabel(btn, text) {
  if (!btn) return;
  const labelSpan = btn.querySelector('.tool-name') || btn.querySelector('span:not(.tool-icon):not(.tool-badge):not(.tool-icon-wrap):not(.tool-text):not(.tool-sub):not(.tool-arrow)');
  if (labelSpan) labelSpan.textContent = text;
}

// Helper: show a count badge on a tool-grid button (0 hides it)
function setToolBtnBadge(badgeId, count) {
  const el = document.getElementById(badgeId);
  if (!el) return;
  if (count > 0) { el.textContent = count; el.style.display = 'inline-block'; }
  else el.style.display = 'none';
}

// Safe HTML escaping — prevents XSS when inserting user-controlled data into innerHTML
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const statusText = document.getElementById("statusText");
const summaryText = document.getElementById("summaryText");
const resultsList = document.getElementById("resultsList");
const heroCopy = document.getElementById("heroCopy") || { textContent: '' }; // removed in redesign
const setupCard = document.getElementById("setupCard");
const ruleCount = document.getElementById("ruleCount");
const threadLimit = document.getElementById("threadLimit");
const autoRunStatus = document.getElementById("autoRunStatus");
const routineSummary = document.getElementById("routineSummary");
const historyList = document.getElementById("historyList");
const latestUndoRow = document.getElementById("latestUndoRow");
const latestUndoText = document.getElementById("latestUndoText");
const configWarning = document.getElementById("configWarning");

// These elements are hidden in the new layout — proxy their .textContent to the status line
const _trashStatusEl = document.getElementById("trashStatus");
const trashStatus = {
  get textContent() { return _trashStatusEl ? _trashStatusEl.textContent : ''; },
  set textContent(v) { if (_trashStatusEl) _trashStatusEl.textContent = v; setStatus(v); }
};
const _bulkArchiveStatusEl = document.getElementById("bulkArchiveStatus");
const bulkArchiveStatus = {
  get textContent() { return _bulkArchiveStatusEl ? _bulkArchiveStatusEl.textContent : ''; },
  set textContent(v) { if (_bulkArchiveStatusEl) _bulkArchiveStatusEl.textContent = v; setStatus(v); }
};

const shortcutHintCard = document.getElementById("shortcutHintCard") || { hidden: true };

// New theme toggle elements
const themeToggle = document.getElementById("themeToggle");

// Inbox score elements (declared early to avoid TDZ when called from initialize())
const scoreGrade = document.getElementById('scoreGrade');
const scoreLabel = document.getElementById('scoreLabel');
const scoreDetail = document.getElementById('scoreDetail');
const scoreBarFill = document.getElementById('scoreBarFill');
const unsubCount = document.getElementById('unsubCount');
const dupeCount = document.getElementById('dupeCount');
const followUpCount = document.getElementById('followUpCount');

let latestUndoableRunId = null;

// Score cache: avoid re-fetching within 5 minutes of last load
const SCORE_CACHE_TTL_MS = 5 * 60 * 1000;
let _scoreCacheAt = 0;

// ── Theme Management ──────────────────────────────────────────────────────
function initTheme() {
  const savedTheme = localStorage.getItem('gmail-organizer-theme') || 'dark';
  setTheme(savedTheme);
}

function setTheme(theme) {
  const isDark = theme === 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('gmail-organizer-theme', theme);
  updateThemeIcon(isDark);
}

function updateThemeIcon(isDark) {
  if (themeToggle) {
    themeToggle.querySelector('.theme-icon').textContent = isDark ? '🌙' : '☀️';
    themeToggle.title = isDark ? 'Switch to light theme' : 'Switch to dark theme';
  }
}

function toggleTheme() {
  const currentTheme = localStorage.getItem('gmail-organizer-theme') || 'dark';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  setTheme(newTheme);
}

if (themeToggle) {
  themeToggle.addEventListener('click', toggleTheme);
}

// ── Upgrade / Checkout Flow ───────────────────────────────────────────────
// Lemon Squeezy payment links
const STRIPE_PAYMENT_LINKS = {
  basic:       "https://gmail-organizer.lemonsqueezy.com/checkout/buy/e96efc99-ed1e-444a-9878-111396b2ff77",
  pro_monthly: "https://gmail-organizer.lemonsqueezy.com/checkout/buy/0af6b55e-cdd8-4963-907d-78807219150b",
  pro_yearly:  "https://gmail-organizer.lemonsqueezy.com/checkout/buy/b1cc248c-98b6-4ef4-94a4-d09140701e5e",
};

async function openUpgradeCheckout(plan) {
  // Show loading state on all upgrade buttons
  const btns = ["upgradeBasic", "upgradeMonthly", "upgradeYearly"];
  btns.forEach(id => {
    const b = document.getElementById(id);
    if (b) { b._origText = b.textContent; b.textContent = "Opening..."; b.disabled = true; }
  });

  const restoreBtns = () => btns.forEach(id => {
    const b = document.getElementById(id);
    if (b) { b.textContent = b._origText || b.textContent; b.disabled = false; }
  });

  try {
    // Use direct Stripe link first (instant, no backend needed)
    const directUrl = STRIPE_PAYMENT_LINKS[plan];
    if (directUrl) {
      chrome.tabs.create({ url: directUrl });
      return;
    }

    // Fallback: ask backend to generate a checkout session
    const response = await sendMessage({ type: "createCheckoutSession", plan });
    const url = response && response.url;
    if (url) {
      chrome.tabs.create({ url });
      return;
    }

    showToast("Could not open payment page. Please try again or contact support.", "error");
  } catch (e) {
    console.error("[gmail-organizer] Checkout error:", e);
    showToast("Payment page unavailable: " + (e.message || "unknown error"), "error");
  } finally {
    restoreBtns();
  }
}

function showUpgradeBanner() {
  // Remove any existing banner
  const existing = document.getElementById("upgradeBanner");
  if (existing) existing.remove();

  const banner = document.createElement("div");
  banner.id = "upgradeBanner";
  banner.style.cssText = `
    background: linear-gradient(135deg, #4f46e5, #7c3aed);
    color: white;
    border-radius: 10px;
    padding: 14px 16px;
    margin: 10px 0;
    font-size: 13px;
    text-align: center;
  `;
  banner.innerHTML = `
    <p style="margin:0 0 6px;font-weight:700;font-size:14px;">🎉 You've used all 20 free credits</p>
    <p style="margin:0 0 12px;opacity:0.9;font-size:12px;">Upgrade to keep your inbox clean</p>
    <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
      <button id="upgradeBasic" style="background:white;color:#4f46e5;border:none;padding:8px 16px;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px;">Basic $5 (7 days)</button>
      <button id="upgradeMonthly" style="background:rgba(255,255,255,0.2);color:white;border:1px solid rgba(255,255,255,0.5);padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;">Pro $7/mo</button>
      <button id="upgradeYearly" style="background:rgba(255,255,255,0.15);color:white;border:1px solid rgba(255,255,255,0.5);padding:8px 16px;border-radius:6px;font-weight:600;cursor:pointer;font-size:12px;">Pro $4/mo yearly ⭐</button>
    </div>
  `;

  // Insert RIGHT BEFORE the statusText so it's always immediately visible
  if (statusText && statusText.parentNode) {
    statusText.parentNode.insertBefore(banner, statusText);
  } else {
    document.body.prepend(banner);
  }

  // Scroll banner into view immediately
  banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  document.getElementById("upgradeBasic").onclick = () => openUpgradeCheckout("basic");
  document.getElementById("upgradeMonthly").onclick = () => openUpgradeCheckout("pro_monthly");
  document.getElementById("upgradeYearly").onclick = () => openUpgradeCheckout("pro_yearly");
}

// ── Friendly Error Formatting ──────────────────────────────────────────────
function formatError(err) {
  if (!err) return "An unknown error occurred.";
  if (err.message === "UPGRADE_REQUIRED" || err.message === "PRO_REQUIRED") {
    showUpgradeBanner();
    return null;
  }
  const status = err.status || (err.response && err.response.status);
  if (status === 401) return "Session expired — click 'Reset sign-in' below to re-authorize.";
  if (status === 403) return (err.message && /quota|rate/i.test(err.message))
    ? "Gmail API quota reached. The extension will resume automatically tomorrow."
    : "Gmail denied access — open Settings and re-authorize with the required permissions.";
  if (status === 429) return "Gmail is rate-limiting requests. Wait 60 seconds then try again.";
  if (status >= 500) return "Gmail is temporarily unavailable. Try again in a few minutes.";
  if (status === 404) return "Email or label not found — it may have been moved or deleted.";
  if (status === 0) return "No internet connection. Check your network and try again.";
  if (!status) {
    const msg = err.message || "";
    if (/failed to fetch|network|internet|offline/i.test(msg)) return "No internet connection. Check your network and try again.";
    return msg || "An error occurred.";
  }
  return err.message || "An error occurred.";
}

// ── Error Boundary Wrapper ────────────────────────────────────────────────
function safeExecute(asyncFn, errorMessage = "An error occurred") {
  return async (...args) => {
    try {
      return await asyncFn(...args);
    } catch (error) {
      console.error(errorMessage, error);
      const _msg = formatError(error);
      if (_msg) setStatus(`Error: ${_msg}`);
    }
  };
}

// ── Event Listeners ───────────────────────────────────────────────────────

// Auto-organize popup button — opens options page and auto-triggers the flow
document.getElementById("autoOrganizePopupBtn").addEventListener("click", async () => {
  try {
    // Block immediately if free user has 0 credits
    const info = await sendMessage({ type: 'getAccountInfo' });
    if (info && info.plan === 'free' && info.creditsLeft !== null && info.creditsLeft <= 0) {
      showUpgradeBanner();
      return;
    }
    const btn = document.getElementById("autoOrganizePopupBtn");
    btn.textContent = '🚀 Opening…';
    btn.disabled = true;
    chrome.storage.local.set({ autoOrganizeTrigger: Date.now() }, () => {
      chrome.runtime.openOptionsPage();
      setTimeout(() => window.close(), 400);
    });
  } catch (e) {
    console.error("Failed to open auto-organize", e);
  }
});

document.getElementById("previewButton").addEventListener("click", safeExecute(() => runAction("previewOrganize")));
document.getElementById("openOptionsButton").addEventListener("click", () => {
  try {
    chrome.runtime.openOptionsPage();
  } catch (error) {
    console.error("Failed to open options", error);
  }
});
document.getElementById("setupButton") && document.getElementById("setupButton").addEventListener("click", () => {
  try {
    chrome.runtime.openOptionsPage();
  } catch (error) {
    console.error("Failed to open options", error);
  }
});
document.getElementById("configOpenSettingsButton").addEventListener("click", () => {
  try {
    chrome.runtime.openOptionsPage();
  } catch (error) {
    console.error("Failed to open options", error);
  }
});
document.getElementById("refreshButton").addEventListener("click", safeExecute(() => initialize()));
document.getElementById("previewTrashButton").addEventListener("click", safeExecute(() => runTrashAction(true)));
document.getElementById("emptyTrashButton").addEventListener("click", safeExecute(() => runTrashAction(false)));
document.getElementById("latestUndoButton").addEventListener("click", safeExecute(() => undoLatestRun()));
document.getElementById("signOutButton").addEventListener("click", safeExecute(async () => {
  setStatus("Disconnecting account...");
  await sendMessage({ type: "signOut" });
  // Reload the popup so it triggers a fresh sign-in prompt with account picker
  window.location.reload();
}));


// Run now button in automation section
const runNowBtn = document.getElementById("runNowBtn");
if (runNowBtn) {
  runNowBtn.addEventListener("click", safeExecute(async () => {
    runNowBtn.disabled = true;
    runNowBtn.textContent = "Running…";
    try {
      clearResults();
      setSummary("");
      setStatus("Applying rules now…");
      const response = await sendMessage({ type: "runOrganize" });
      renderResult(response.result);
      await initialize();
      await Promise.all([loadInboxScore(), loadStats()]);
    } finally {
      runNowBtn.disabled = false;
      runNowBtn.textContent = "Run now";
    }
  }));
}

document.addEventListener("keydown", handleKeyboardShortcuts);

// ── Expando toggles (CSP-safe event listeners) ───────────────────────────────
document.querySelectorAll('.expando-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    btn.nextElementSibling.classList.toggle('open', !expanded);
  });
});

// Full analytics tile → opens options page
const openStatsBtn = document.getElementById('openStatsBtn');
if (openStatsBtn) {
  openStatsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

// Initialize on load
initTheme();
initLangPicker();
initialize();

// Live progress from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "trashProgress") {
    const pct = msg.total > 0 ? Math.round((msg.deleted / msg.total) * 100) : 0;
    const text = "Deleting… " + msg.deleted + " / " + msg.total + (msg.failed > 0 ? " (" + msg.failed + " skipped)" : "") + "  —  " + pct + "%";
    trashStatus.textContent = text; // proxy also calls setStatus()
  }
});

// ── Storage Reactivity ────────────────────────────────────────────────────
let storageUpdateTimeout;
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync') {
    clearTimeout(storageUpdateTimeout);
    storageUpdateTimeout = setTimeout(() => {
      if (changes.rules || changes.runHistory) {
        initialize();
      }
    }, 200);
  }
});

// ── Main Functions ────────────────────────────────────────────────────────

async function runTrashAction(dryRun) {
  const emptyBtn = document.getElementById("emptyTrashButton");
  try {
    document.getElementById("previewTrashButton").disabled = true;
    emptyBtn.disabled = true;
    if (!dryRun) setToolBtnLabel(emptyBtn, '…');

    if (!dryRun) {
      // First preview to get the count, then show it in the confirmation
      trashStatus.textContent = "Checking trash…";
      let previewCount = null;
      let previewAgeNote = "";
      try {
        const preview = await sendMessage({ type: "previewEmptyTrash" });
        previewCount = preview.result?.count ?? null;
        const olderThanDays = preview.result?.olderThanDays || 0;
        previewAgeNote = olderThanDays > 0 ? ` (older than ${olderThanDays} days)` : "";
      } catch (_) { /* proceed without count */ }

      const countMsg = previewCount !== null
        ? `Delete ${previewCount} thread(s) from Trash${previewAgeNote}? This cannot be undone.`
        : "This will permanently delete all emails in Trash and cannot be undone. Continue?";

      const confirmed = window.confirm(countMsg);
      if (!confirmed) {
        trashStatus.textContent = previewCount !== null
          ? `${previewCount} thread(s) in trash${previewAgeNote}. Deletion canceled.`
          : "Trash deletion canceled.";
        return;
      }
      trashStatus.textContent = "Starting — progress will appear here…";
    } else {
      trashStatus.textContent = "Counting trash emails…";
    }

    const response = await sendMessage({ type: dryRun ? "previewEmptyTrash" : "emptyTrash", confirmed: dryRun ? undefined : true });
    const { count, deleted, failed, olderThanDays } = response.result;
    const ageNote = olderThanDays > 0 ? ` older than ${olderThanDays} days` : "";

    if (dryRun) {
      trashStatus.textContent = count === 0 ? `Trash is empty${ageNote}.`
        : `${count} thread(s) in trash${ageNote}. Click "Empty trash now" to permanently delete.`;
    } else {
      trashStatus.textContent = count === 0 ? "Nothing to delete."
        : `Done — deleted ${deleted ?? count} thread(s)${ageNote}${failed > 0 ? `, ${failed} skipped` : ""}.`;
      await initialize();
      await loadInboxScore();
    }
  } catch (error) {
    console.error("Trash action error:", error);
    trashStatus.textContent = error.message || "Trash operation failed."; // proxy calls setStatus
  } finally {
    document.getElementById("previewTrashButton").disabled = false;
    setToolBtnLabel(emptyBtn, 'Empty trash');
    emptyBtn.disabled = false;
  }
}

async function loadAccountInfo() {
  const bar = document.getElementById('accountBar');
  const avatarEl = document.getElementById('accountAvatar');
  const emailEl = document.getElementById('accountEmail');
  const planEl = document.getElementById('accountPlan');
  const creditsEl = document.getElementById('creditsDisplay');
  if (!bar) return;
  try {
    const info = await sendMessage({ type: 'getAccountInfo' });
    if (!info || !info.email) { bar.style.display = 'none'; return; }

    // Avatar letter
    const letter = info.email.charAt(0).toUpperCase();
    if (avatarEl) avatarEl.textContent = letter;

    // Email
    if (emailEl) emailEl.textContent = info.email;

    // Plan label + credits progress bar (Concept B)
    const planLabel = info.planLabel || (info.plan === 'free' ? 'Free' : info.plan || 'Free');
    const planColors = { free: 'var(--text-2)', basic: 'var(--blue)', pro_monthly: 'var(--green)', pro_yearly: 'var(--green)' };
    const barRow = document.getElementById('creditsBarRow');
    const barFill = document.getElementById('creditsBarFill');
    const planFallback = document.getElementById('accountPlanFallback');

    if (info.creditsLeft !== null && info.creditsLeft !== undefined) {
      // Show bar row, hide fallback
      if (barRow) barRow.style.display = 'flex';
      if (planFallback) planFallback.style.display = 'none';

      const total = info.creditsTotal;
      const left = info.creditsLeft;
      const isPro = total >= 999999;
      const color = isPro ? 'var(--green)' : left <= 2 ? 'var(--red)' : left <= 5 ? 'var(--yellow)' : 'var(--green)';

      if (planEl) { planEl.textContent = planLabel; planEl.style.color = planColors[info.plan] || 'var(--text-2)'; }
      if (creditsEl) {
        creditsEl.textContent = isPro ? '∞' : left + '/' + total;
        creditsEl.style.color = color;
      }
      if (barFill) {
        barFill.style.width = isPro ? '100%' : Math.round((left / total) * 100) + '%';
        barFill.style.background = color;
      }
    } else {
      // No credits info — show plain plan label only
      if (barRow) barRow.style.display = 'none';
      if (planFallback) { planFallback.style.display = 'block'; planFallback.textContent = planLabel; planFallback.style.color = planColors[info.plan] || 'var(--text-2)'; }
    }

    bar.style.display = 'flex';

    applyPlanLocks(info.plan || 'free');

    // Show dev panel only for owner email
    if (info.email === 'ayoub.ouddaf@gmail.com') {
      const devPanel = document.getElementById('devPlanPanel');
      if (devPanel) devPanel.style.display = 'block';
    }
  } catch (e) {
    console.warn('loadAccountInfo error:', e);
    if (bar) bar.style.display = 'none';
  }
}

const PRO_TOOLS = ['scanDupeBtn','scanReadLaterBtn','scanSnoozedBtn','bulkArchiveRunBtn','bulkActionBtn','openStatsBtn'];
const PRO_SECTIONS = ['bulkDeleteCard'];

function applyPlanLocks(plan) {
  const paid = plan === 'pro_monthly' || plan === 'pro_yearly' || plan === 'basic';

  PRO_TOOLS.forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    const existing = btn.querySelector('.pro-lock');
    if (paid) {
      if (existing) existing.remove();
      btn.style.opacity = '';
      btn.dataset.proLocked = '';
    } else {
      if (!existing) {
        const lock = document.createElement('span');
        lock.className = 'pro-lock';
        lock.textContent = '🔒 Pro';
        lock.style.cssText = 'font-size:9px;font-weight:700;color:var(--purple);background:rgba(167,139,250,.15);border:1px solid rgba(167,139,250,.25);border-radius:20px;padding:1px 7px;margin-left:auto;flex-shrink:0;';
        const arrow = btn.querySelector('.tool-arrow');
        if (arrow) btn.insertBefore(lock, arrow);
        else btn.appendChild(lock);
      }
      btn.style.opacity = '0.65';
      btn.dataset.proLocked = 'true';
    }
  });

  PRO_SECTIONS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.opacity = paid ? '' : '0.5';
    el.style.pointerEvents = paid ? '' : 'none';
    const header = el.querySelector('.expando-toggle');
    if (header && !paid) {
      if (!header.querySelector('.pro-lock-tag')) {
        const tag = document.createElement('span');
        tag.className = 'pro-lock-tag';
        tag.textContent = ' 🔒 Pro';
        tag.style.cssText = 'font-size:9px;font-weight:700;color:var(--purple);';
        header.appendChild(tag);
      }
    } else if (header) {
      const tag = header.querySelector('.pro-lock-tag');
      if (tag) tag.remove();
    }
  });
}

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-pro-locked="true"]');
  if (btn) { e.stopImmediatePropagation(); showUpgradeBanner(); }
}, true);

// ── Dev plan switcher ─────────────────────────────────────────────────────
const DEV_PLAN_PRESETS = {
  free_full:   { plan: 'free',        planLabel: 'Free',         creditsLeft: 20, creditsTotal: 20, creditsUsed: 0,  allowed: true },
  free_low:    { plan: 'free',        planLabel: 'Free',         creditsLeft: 3,  creditsTotal: 20, creditsUsed: 17, allowed: true },
  free_empty:  { plan: 'free',        planLabel: 'Free',         creditsLeft: 0,  creditsTotal: 20, creditsUsed: 20, allowed: false },
  basic:       { plan: 'basic',       planLabel: 'Basic',        creditsLeft: 999999, creditsTotal: 999999, creditsUsed: 0, allowed: true, expiresAt: Date.now() + 7*24*60*60*1000 },
  pro_monthly: { plan: 'pro_monthly', planLabel: 'Pro',          creditsLeft: 999999, creditsTotal: 999999, creditsUsed: 0, allowed: true },
  pro_yearly:  { plan: 'pro_yearly',  planLabel: 'Pro (Yearly)', creditsLeft: 999999, creditsTotal: 999999, creditsUsed: 0, allowed: true },
};

document.querySelectorAll('.dev-plan-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const key = btn.dataset.plan;
    const statusEl = document.getElementById('devPlanStatus');
    try {
      if (key === 'clear') {
        await sendMessage({ type: 'clearPlanOverride' });
        if (statusEl) statusEl.textContent = '✓ Using real backend';
      } else {
        const preset = DEV_PLAN_PRESETS[key];
        await sendMessage({ type: 'setPlanOverride', override: preset });
        if (statusEl) statusEl.textContent = '✓ Plan set to: ' + preset.planLabel + (key.startsWith('free') ? ' (' + preset.creditsLeft + ' credits)' : ' (unlimited)');
      }
      // Refresh account info display
      await loadAccountInfo();
    } catch (e) {
      if (statusEl) statusEl.textContent = '✗ Error: ' + e.message;
    }
  });
});

async function initialize() {
  try {
    renderConfigWarning();
    // Load everything in parallel
    const [response] = await Promise.all([
      sendMessage({ type: "getDashboard" }),
      loadAccountInfo(),
      loadInboxScore(),
      loadStats(),
      checkConflicts(),
    ]);
    hydrateSettings(response.settings, response.schedule);
    renderHistory(response.history || []);
    const rules = response.settings?.rules || [];
  } catch (error) {
    console.error("Initialize error:", error);
    setStatus(error.message || "Could not load extension settings.");
  }
}

async function runAction(type) {
  const isPreview = type === "previewOrganize";
  const btn = isPreview ? document.getElementById("previewButton") : document.getElementById("runButton");

  // Block immediately if free user has 0 credits (preview is always free)
  if (!isPreview) {
    try {
      const _info = await sendMessage({ type: 'getAccountInfo' });
      if (_info && _info.plan === 'free' && _info.creditsLeft !== null && _info.creditsLeft <= 0) {
        showUpgradeBanner();
        return;
      }
    } catch (_) {}
  }

  // Smart check: if no rules exist, open options page to run auto-organize first
  if (!isPreview) {
    try {
      const dash = await sendMessage({ type: "getDashboard" });
      const rules = (dash && dash.settings && dash.settings.rules) || [];
      // Also check local overflow
      const localData = await new Promise(res => chrome.storage.local.get({ rulesInLocal: false, rulesOverflow: [] }, res));
      const effectiveRules = localData.rulesInLocal ? localData.rulesOverflow : rules;
      if (effectiveRules.length === 0) {
        showToast('No rules yet! Click ✨ Auto-organize first to set up your inbox.', 'info');
        return;
      }
    } catch(e) { /* proceed normally if check fails */ }
  }

  const restoreBtn = setButtonLoading(btn, isPreview ? "⟳ Scanning…" : "⟳ Organizing…");
  try {
    setStatus(isPreview ? "Checking your inbox..." : "Applying labels...");
    clearResults();
    setSummary("");

    const response = await sendMessage({ type });
    renderResult(response.result);

    // Show success toast
    const res = response.result;
    if (isPreview) {
      if (res.matchedThreads > 0) {
        showToast(`Preview: ${res.matchedThreads} thread(s) would be organized`, 'info');
      } else {
        showToast('Preview: no matches found — check your rules', 'info');
      }
    } else {
      if (res.matchedThreads > 0) {
        showToast(`Done! Organized ${res.matchedThreads} thread(s)`, 'success');
      } else {
        showToast('No threads needed changes', 'info');
      }
    }

    await initialize();
    // Refresh score and stats in the background after any organize action
    if (!isPreview) {
      Promise.all([loadInboxScore(), loadStats()]).catch(() => {});
    }
  } catch (error) {
    console.error("Action error:", error);
    const msg = formatError(error);
    if (msg) {
      setStatus("Error: " + msg);
      showToast(msg, 'error');
    }
    // If msg is null, formatError already handled the UI (e.g. upgrade banner)
  } finally {
    restoreBtn();
  }
}


function renderResult(result) {
  try {
    const items = result.actions || [];
    const createdLabels = result.createdLabels || [];

    if (items.length === 0) {
      setStatus(
        result.dryRun
          ? `Preview: no new emails matched your rules.`
          : `✅ Inbox already clean — no new emails to organize.`
      );
      setSummary('');
      return;
    }

    setStatus(
      result.dryRun
        ? `Scanned ${result.scannedThreads} inbox thread(s); ${result.matchedThreads} would be organized.`
        : `Organized ${result.matchedThreads} of ${result.scannedThreads} scanned inbox thread(s).`
    );

    setSummary(
      result.dryRun
        ? "Preview mode only: no Gmail changes were made."
        : buildApplySummary(createdLabels, items)
    );

    for (const item of items) {
      const li = document.createElement("li");
      li.className = "result-item";
      li.textContent = `${item.label}: ${item.subject || "(No subject)"}${formatActionTag(item.action)}`;
      resultsList.appendChild(li);
    }
  } catch (error) {
    console.error("Render result error:", error);
  }
}

function hydrateSettings(settings, schedule) {
  try {
    const rules = Array.isArray(settings.rules) ? settings.rules : [];
    ruleCount.textContent = String(rules.length);
    threadLimit.textContent = String(settings.maxThreadsPerRun || 0);

    if (setupCard) setupCard.hidden = true; // always hidden — replaced by Auto-organize button
    if (settings.onboardingComplete && rules.length > 0) {
      heroCopy.textContent = "Your rules are ready. Preview first, then organize when the matches look correct.";
    } else {
      heroCopy.textContent = "👋 Welcome! Click ✨ Auto-organize above to set up your inbox in one click — no API key needed.";
    }

    const automationCard = document.getElementById("automationCard");
    if (!schedule?.enabled) {
      autoRunStatus.textContent = "Auto-run is off.";
      routineSummary.textContent = "";
      if (automationCard) automationCard.classList.remove("auto-active");
    } else {
      const nextRun = schedule.nextRunAt ? formatRelativeTime(schedule.nextRunAt) : "soon";
      autoRunStatus.textContent = `Auto-run every ${formatInterval(schedule.intervalMinutes)} — next in ${nextRun}.`;
      routineSummary.textContent = summarizeRoutine(settings.dailyRoutineInstructions);
      if (automationCard) automationCard.classList.add("auto-active");
    }
  } catch (error) {
    console.error("Hydrate settings error:", error);
  }
}

function renderConfigWarning() {
  const configured = isOAuthConfigured();
  configWarning.hidden = configured;
  document.getElementById("previewButton").disabled = !configured;
  document.getElementById("runButton").disabled = !configured;
}

function renderHistory(history) {
  try {
    historyList.innerHTML = "";
    const latestUndoable = Array.isArray(history) ? history.find((entry) => entry.undoable) : null;
    latestUndoableRunId = latestUndoable?.id || null;
    latestUndoRow.hidden = !latestUndoable;

    if (latestUndoable) {
      latestUndoText.textContent = `Latest reversible run: ${formatSource(latestUndoable.source)} at ${formatDateTime(latestUndoable.timestamp)}.`;
    }

    if (!Array.isArray(history) || history.length === 0) {
      const li = document.createElement("li");
      li.className = "history-item";
      li.textContent = "No organization runs yet.";
      historyList.appendChild(li);
      return;
    }

    for (const entry of history.slice(0, 5)) {
      const li = document.createElement("li");
      li.className = "history-item";

      const row = document.createElement("div");
      row.className = "history-row";

      const strong = document.createElement("strong");
      strong.textContent = formatSource(entry.source);
      row.appendChild(strong);

      const span = document.createElement("span");
      span.textContent = formatDateTime(entry.timestamp);
      row.appendChild(span);

      li.appendChild(row);

      const summary = document.createElement("p");
      summary.className = "history-summary";
      summary.textContent = entry.summary || "No summary";
      li.appendChild(summary);

      historyList.appendChild(li);
    }
  } catch (error) {
    console.error("Render history error:", error);
  }
}

async function undoLatestRun() {
  try {
    if (!latestUndoableRunId) {
      setStatus("No recent run is available to undo.");
      return;
    }

    const response = await sendMessage({ type: "undoRun", runId: latestUndoableRunId });
    setStatus(`Undid ${response.result.matchedThreads} thread(s) from the latest run.`);
    setSummary("The latest reversible organization run was rolled back.");
    clearResults();
    await initialize();
  } catch (error) {
    console.error("Undo run error:", error);
    setStatus(error.message || "Could not undo the latest run.");
  }
}

function buildApplySummary(createdLabels, items) {
  const archiveCount = items.filter((item) => item.action === "archive").length;
  const trashCount = items.filter((item) => item.action === "trash").length;
  const labelNote = createdLabels.length > 0 ? ` Created ${createdLabels.length} new label(s).` : "";
  const archiveNote = archiveCount > 0 ? ` Archived ${archiveCount} thread(s).` : "";
  const trashNote = trashCount > 0 ? ` Trashed ${trashCount} thread(s).` : "";
  return `Changes applied to Gmail.${labelNote}${archiveNote}${trashNote}`.trim();
}

function formatActionTag(action) {
  if (action === "archive") {
    return " [archive]";
  }
  if (action === "trash") {
    return " [trash]";
  }
  return "";
}

function summarizeRoutine(text) {
  const firstLine = String(text || "").split("\n").map((line) => line.trim()).find(Boolean);
  return firstLine ? `Daily routine: ${firstLine}` : "Daily routine is not configured yet.";
}

function formatDateTime(value) {
  if (!value) {
    return "Unknown";
  }
  return new Date(value).toLocaleString();
}

function formatRelativeTime(value) {
  if (!value) return "soon";
  const diffMs = new Date(value).getTime() - Date.now();
  if (diffMs <= 0) return "now";
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "< 1 min";
  if (diffMin < 60) return `${diffMin} min`;
  const diffHrs = Math.round(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h`;
  return `${Math.round(diffHrs / 24)}d`;
}

function formatInterval(minutes) {
  const value = Number(minutes);
  if (value < 60) {
    return `${value} minute${value === 1 ? "" : "s"}`;
  }
  if (value % 1440 === 0) {
    const days = value / 1440;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (value % 60 === 0) {
    const hours = value / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${value} minutes`;
}

function formatSource(source) {
  if (source === "auto") {
    return "Scheduled run";
  }
  if (source === "undo") {
    return "Undo";
  }
  if (source === "manual-preview") {
    return "Preview";
  }
  return "Manual run";
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isOAuthConfigured() {
  const manifest = chrome.runtime.getManifest();
  const clientId = manifest.oauth2?.client_id || "";
  return !clientId.includes("YOUR_GOOGLE_OAUTH_CLIENT_ID");
}

function setStatus(message) {
  statusText.textContent = message;
}

// Show/hide a transient toast message (auto-hides after 4s)
function showToast(message, type) {
  let toast = document.getElementById('_goToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = '_goToast';
    toast.style.cssText = [
      'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);',
      'max-width:320px;width:90%;padding:10px 14px;border-radius:8px;',
      'font-size:12px;font-weight:600;z-index:10000;text-align:center;',
      'box-shadow:0 4px 12px rgba(0,0,0,.3);transition:opacity 0.3s;'
    ].join('');
    document.body.appendChild(toast);
  }
  const colors = {
    success: { bg: 'rgba(66,133,244,.15)', border: 'rgba(66,133,244,.4)', color: 'var(--blue)' },
    error:   { bg: 'rgba(234,67,53,.15)',  border: 'rgba(234,67,53,.4)',  color: 'var(--red)'  },
    info:    { bg: 'rgba(251,188,5,.1)',   border: 'rgba(251,188,5,.3)',  color: 'var(--yellow)' }
  };
  const style = colors[type] || colors.info;
  toast.style.background = style.bg;
  toast.style.border = '1px solid ' + style.border;
  toast.style.color = style.color;
  toast.textContent = message;
  toast.style.opacity = '1';
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => { toast.style.opacity = '0'; }, 4000);
}

// Set a visual loading state on a button (returns a restore function)
function setButtonLoading(btn, loadingText) {
  if (!btn) return () => {};
  const original = btn.innerHTML; // preserve kbd spans
  btn.disabled = true;
  btn.textContent = loadingText || '⟳ Working…';
  return function restore() {
    btn.disabled = false;
    btn.innerHTML = original;
  };
}

function setSummary(message) {
  summaryText.textContent = message;
}

function clearResults() {
  resultsList.innerHTML = "";
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!response?.ok) {
          reject(new Error(response?.error || "Unknown extension error."));
          return;
        }

        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function handleKeyboardShortcuts(event) {
  try {
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const tagName = document.activeElement && document.activeElement.tagName;
    const isTyping = tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT" || (document.activeElement && document.activeElement.isContentEditable);
    if (isTyping) return;

    const key = event.key.toLowerCase();
    if (key === "p") {
      if (document.getElementById("previewButton").disabled) return;
      event.preventDefault();
      document.getElementById("previewButton").click();
      return;
    }
    if (key === "r") {
      if (document.getElementById("runButton").disabled) return;
      event.preventDefault();
      document.getElementById("runButton").click();
      return;
    }
    if (key === "t") {
      if (document.getElementById("emptyTrashButton").disabled) return;
      event.preventDefault();
      document.getElementById("emptyTrashButton").click();
      return;
    }
    if (key === "q") {
      event.preventDefault();
      openQuickRun();
      return;
    }
    if (key === "?") {
      event.preventDefault();
      showToast("P → Preview  ·  R → Organize  ·  Q → Pick rules  ·  T → Empty trash", "info");
    }
  } catch (error) {
    console.error("Keyboard shortcut error:", error);
  }
}

// ── v0.3.7: Inbox Score ───────────────────────────────────────────────────
document.getElementById('refreshScoreBtn').addEventListener('click', safeExecute(() => {
  _scoreCacheAt = 0; // force refresh
  return loadInboxScore();
}));

// Score arc click → show breakdown tooltip
document.getElementById('scoreCard').addEventListener('click', function(e) {
  if (e.target.closest('#refreshScoreBtn')) return;
  if (!_lastScoreBreakdown || !_lastScoreBreakdown.length) return;
  const existing = document.getElementById('scoreBreakdownTooltip');
  if (existing) { existing.remove(); return; }
  const tip = document.createElement('div');
  tip.id = 'scoreBreakdownTooltip';
  tip.style.cssText = 'position:absolute;top:100%;left:14px;right:14px;z-index:100;background:#1a1a2e;border:1px solid var(--border-md);border-radius:10px;padding:12px 14px;font-size:11px;box-shadow:0 8px 24px rgba(0,0,0,.6);margin-top:4px;';
  const thead = document.createElement('div');
  thead.style.cssText = 'font-weight:700;color:var(--text);margin-bottom:8px;font-size:12px;display:flex;justify-content:space-between;';
  thead.innerHTML = '📊 Score breakdown <span style="color:var(--text-3);font-weight:400;cursor:pointer" id="closeBreakdown">✕</span>';
  tip.appendChild(thead);
  _lastScoreBreakdown.forEach(function(item) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--border);';
    const lbl = document.createElement('span'); lbl.style.color = 'var(--text-2)'; lbl.textContent = item.label;
    const pen = document.createElement('span'); pen.style.cssText = 'color:var(--red);font-weight:700;'; pen.textContent = '−' + item.penalty + ' pts (' + item.value + ')';
    row.append(lbl, pen);
    tip.appendChild(row);
  });
  if (!_lastScoreBreakdown.length) {
    const ok = document.createElement('div'); ok.style.color = 'var(--green)'; ok.textContent = '✅ No issues — inbox is healthy!';
    tip.appendChild(ok);
  }
  const card = document.getElementById('scoreCard').closest('.g-header') || document.getElementById('scoreCard');
  card.style.position = 'relative';
  card.appendChild(tip);
  document.getElementById('closeBreakdown').onclick = function(ev) { ev.stopPropagation(); tip.remove(); };
  setTimeout(function() { document.addEventListener('click', function handler() { tip.remove(); document.removeEventListener('click', handler); }); }, 10);
});
document.getElementById('scanUnsubBtn').addEventListener('click', safeExecute(() => runUnsubScan()));
document.getElementById('scanDupeBtn').addEventListener('click', safeExecute(() => runDupeScan()));
document.getElementById('scanFollowBtn').addEventListener('click', safeExecute(() => runFollowUpScan()));
document.getElementById('scanReadLaterBtn').addEventListener('click', safeExecute(() => runReadLaterScan()));
document.getElementById('todayEmailsBtn').addEventListener('click', safeExecute(() => runTodayEmailsScan()));
document.getElementById('bulkActionBtn').addEventListener('click', safeExecute(() => showBulkActionModal()));

// Store last breakdown for the tooltip
let _lastScoreBreakdown = [];

function _applyScoreUI({ score, grade, label, total, unread, old: oldCount, breakdown }) {
  const color = score >= 85 ? 'var(--green)' : score >= 60 ? 'var(--yellow)' : 'var(--red)';
  _lastScoreBreakdown = breakdown || [];

  // Arc number (grade → score number)
  scoreGrade.textContent = score;
  scoreGrade.style.color = color;

  // Arc SVG stroke
  const arc = document.getElementById('arcCircle');
  if (arc) {
    const circ = 163.4;
    arc.style.strokeDashoffset = circ - (score / 100) * circ;
    // Update gradient colors based on health
    if (score >= 85) {
      arc.style.stroke = '#4ade80';
    } else if (score >= 60) {
      arc.style.stroke = '#fbbf24';
    } else {
      arc.style.stroke = '#f87171';
    }
    arc.removeAttribute('stroke');
    arc.style.stroke = color.replace('var(--green)', '#4ade80').replace('var(--yellow)', '#fbbf24').replace('var(--red)', '#f87171');
  }

  // Label
  scoreLabel.textContent = label;

  // Chips
  const chips = document.getElementById('scoreChips');
  if (chips) {
    chips.innerHTML = '';
    if (unread > 0) {
      const c = document.createElement('span');
      c.className = 'gchip ' + (unread > 20 ? 'gc-r' : 'gc-y');
      c.textContent = unread + ' unread';
      chips.appendChild(c);
    }
    if (oldCount > 0) {
      const c = document.createElement('span');
      c.className = 'gchip gc-y';
      c.textContent = oldCount + ' old';
      chips.appendChild(c);
    }
    if (total !== undefined) {
      const c = document.createElement('span');
      c.className = 'gchip gc-b';
      c.textContent = total + ' threads';
      chips.appendChild(c);
    }
  }

  // Legacy bar (kept for compat, now hidden)
  if (scoreBarFill) { scoreBarFill.style.width = score + '%'; scoreBarFill.style.background = color; }
  if (scoreDetail) scoreDetail.textContent = '';
}

async function loadInboxScore(force = false) {
  try {
    // Use cache if fresh enough (skip API call on quick re-open)
    const now = Date.now();
    if (!force && now - _scoreCacheAt < SCORE_CACHE_TTL_MS) return;

    scoreLabel.textContent = 'Calculating...';
    scoreGrade.textContent = '…';
    const arcLoading = document.getElementById('arcCircle');
    if (arcLoading) { arcLoading.style.strokeDashoffset = '163.4'; arcLoading.style.stroke = 'rgba(255,255,255,0.1)'; }
    if (scoreBarFill) scoreBarFill.style.width = '0%';

    const r = await sendMessage({ type: 'getInboxScore' });
    _scoreCacheAt = Date.now();
    _applyScoreUI(r.result);
  } catch(e) {
    console.error("Load inbox score error:", e);
    scoreLabel.textContent = 'Could not load score';
  }
}

async function runUnsubScan() {
  try {
    const btn = document.getElementById('scanUnsubBtn');
    btn.disabled = true;
    setToolBtnLabel(btn, '…');
    unsubCount.textContent = 'Scanning...';
    const r = await sendMessage({ type: 'scanUnsubscribes' });
    const { count, items } = r.result;
    unsubCount.textContent = count === 0 ? 'None found' : count + ' newsletter(s) found';
    setToolBtnBadge('unsubBadge', count);
    if (count > 0) {
      setToolBtnLabel(btn, 'View');
      btn.disabled = false;
      const fresh = btn.cloneNode(true);
      btn.replaceWith(fresh);
      fresh.addEventListener('click', () => showUnsubModal(items));
    } else { btn.disabled = false; setToolBtnLabel(btn, 'Unsub'); }
  } catch(e) {
    console.error("Unsubscribe scan error:", e);
    unsubCount.textContent = 'Error: ' + e.message;
    document.getElementById('scanUnsubBtn').disabled = false;
  }
}

async function runDupeScan() {
  try {
    const btn = document.getElementById('scanDupeBtn');
    btn.disabled = true;
    setToolBtnLabel(btn, '…');
    dupeCount.textContent = 'Scanning...';
    const r = await sendMessage({ type: 'scanDuplicates' });
    const { count, threadIds, items } = r.result;
    dupeCount.textContent = count === 0 ? 'No duplicates' : count + ' duplicate(s) found';
    setToolBtnBadge('dupeBadge', count);
    if (count > 0) {
      setToolBtnLabel(btn, 'View');
      btn.style.color = '';
      btn.style.borderColor = '';
      btn.disabled = false;
      const fresh = btn.cloneNode(true);
      btn.replaceWith(fresh);
      fresh.addEventListener('click', () => showDuplicateModal(items || [], threadIds || []));
    } else { btn.disabled = false; setToolBtnLabel(btn, 'Dupes'); }
  } catch(e) {
    console.error("Duplicate scan error:", e);
    dupeCount.textContent = 'Error: ' + e.message;
    document.getElementById('scanDupeBtn').disabled = false;
  }
}

async function runFollowUpScan() {
  try {
    const btn = document.getElementById('scanFollowBtn');
    btn.disabled = true;
    setToolBtnLabel(btn, '…');
    followUpCount.textContent = 'Scanning...';
    const r = await sendMessage({ type: 'scanFollowUps' });
    const { count, items } = r.result;
    followUpCount.textContent = count === 0 ? 'All good' : count + ' email(s) need reply';
    setToolBtnBadge('followBadge', count);
    if (count > 0) {
      setToolBtnLabel(btn, 'View');
      btn.disabled = false;
      const fresh = btn.cloneNode(true);
      btn.replaceWith(fresh);
      fresh.addEventListener('click', () => showFollowUpModal(items));
    } else { btn.disabled = false; setToolBtnLabel(btn, 'Follow-ups'); }
  } catch(e) {
    console.error("Follow-up scan error:", e);
    followUpCount.textContent = 'Error: ' + e.message;
    document.getElementById('scanFollowBtn').disabled = false;
  }
}

// ── Today's Emails ────────────────────────────────────────────────────────────
async function runTodayEmailsScan() {
  const btn = document.getElementById('todayEmailsBtn');
  const sub = document.getElementById('todayEmailsSub');
  if (btn && btn.dataset.scanning === '1') return;
  if (btn) { btn.dataset.scanning = '1'; btn.disabled = true; setToolBtnLabel(btn, '…'); }
  if (sub) sub.textContent = 'Scanning…';
  try {
    const r = await sendMessage({ type: 'getTodayEmails' });
    const { count, unread, items } = (r && r.result) || { count: 0, unread: 0, items: [] };
    setToolBtnBadge('todayEmailsBadge', unread || 0);
    if (sub) sub.textContent = count > 0 ? count + ' received' + (unread > 0 ? ', ' + unread + ' unread' : '') : 'New in inbox today';
    showTodayEmailsModal(items || [], count, unread);
  } catch(e) {
    console.error('Today emails error:', e);
    if (sub) sub.textContent = 'New in inbox today';
    setStatus('Error: ' + (e.message || 'Could not load today\'s emails'));
  } finally {
    if (btn) { btn.dataset.scanning = '0'; btn.disabled = false; setToolBtnLabel(btn, 'Today\'s emails'); }
  }
}

function showTodayEmailsModal(items, count, unread) {
  const existing = document.getElementById('toolModal');
  if (existing) existing.remove();

  const today = new Date();
  const dateStr = today.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

  const modal = document.createElement('div');
  modal.id = 'toolModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;overflow-y:auto;padding:12px;';

  const inner = document.createElement('div');
  inner.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:16px;max-width:420px;margin:0 auto;';

  // Header
  const h = document.createElement('div');
  h.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;';
  const titleEl = document.createElement('div');
  titleEl.style.cssText = 'font-weight:700;font-size:14px;';
  titleEl.textContent = '📬 Today\'s Emails';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'background:none;border:none;color:var(--text-2);cursor:pointer;font-size:16px;padding:0;';
  closeBtn.onclick = () => modal.remove();
  h.append(titleEl, closeBtn);
  inner.appendChild(h);

  // Date + summary line
  const meta = document.createElement('div');
  meta.style.cssText = 'font-size:11px;color:var(--text-2);margin-bottom:12px;';
  meta.textContent = dateStr + (count > 0 ? ' · ' + count + ' received' + (unread > 0 ? ', ' + unread + ' unread' : ', all read') : '');
  inner.appendChild(meta);

  if (count === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:20px 0;text-align:center;';
    empty.innerHTML = '<div style="font-size:28px;margin-bottom:8px;">🎉</div>' +
      '<div style="font-weight:600;font-size:13px;color:var(--text);margin-bottom:4px;">Inbox zero today!</div>' +
      '<div style="font-size:11px;color:var(--text-2);">No new emails received in your inbox today.</div>';
    inner.appendChild(empty);
  } else {
    (items || []).forEach((item, idx) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:9px 0;border-bottom:1px solid var(--border);cursor:pointer;transition:background .15s;';
      row.addEventListener('mouseenter', () => { row.style.background = 'var(--hover,rgba(255,255,255,.05))'; });
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
      if (item.threadId) {
        row.addEventListener('click', () => {
          chrome.tabs.create({ url: 'https://mail.google.com/mail/u/0/#inbox/' + item.threadId });
        });
      }

      // Unread dot
      const dot = document.createElement('div');
      dot.style.cssText = 'width:7px;height:7px;border-radius:50%;flex-shrink:0;margin-top:4px;background:' +
        (item.isUnread ? 'var(--accent,#4ade80)' : 'transparent') + ';border:1px solid ' +
        (item.isUnread ? 'var(--accent,#4ade80)' : 'var(--border)') + ';';
      row.appendChild(dot);

      const text = document.createElement('div');
      text.style.cssText = 'flex:1;min-width:0;';

      const fromEl = document.createElement('div');
      fromEl.style.cssText = 'font-size:11px;font-weight:' + (item.isUnread ? '700' : '500') + ';color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      fromEl.textContent = item.from || '(unknown sender)';

      const subEl = document.createElement('div');
      subEl.style.cssText = 'font-size:11px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;';
      subEl.textContent = item.subject || '(no subject)';

      const timeEl = document.createElement('div');
      timeEl.style.cssText = 'font-size:10px;color:var(--text-3,var(--text-2));margin-top:2px;';
      timeEl.textContent = item.time || '';

      text.append(fromEl, subEl, timeEl);
      row.appendChild(text);
      inner.appendChild(row);
    });

    if (count > (items || []).length) {
      const more = document.createElement('div');
      more.style.cssText = 'font-size:10px;color:var(--text-2);text-align:center;padding-top:10px;';
      more.textContent = '+ ' + (count - items.length) + ' more — open Gmail to see all';
      inner.appendChild(more);
    }
  }

  modal.appendChild(inner);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

async function runReadLaterScan() {
  const btn = document.getElementById('scanReadLaterBtn');
  const readLaterCount = document.getElementById('readLaterCount');
  // Guard: prevent double-click while scanning
  if (btn && btn.dataset.scanning === '1') return;
  if (btn) { btn.dataset.scanning = '1'; btn.disabled = true; setToolBtnLabel(btn, '…'); }
  if (readLaterCount) readLaterCount.textContent = 'Scanning…';

  try {
    const r = await sendMessage({ type: 'scanReadLater', opts: {} });
    const { count, unread, items, labelExists } = (r && r.result) || { count: 0, unread: 0, items: [], labelExists: false };
    setToolBtnBadge('readLaterBadge', unread || 0);
    if (readLaterCount) readLaterCount.textContent = count > 0 ? count + ' saved' + (unread > 0 ? ', ' + unread + ' unread' : '') : 'Saved articles & digests';
    setToolBtnLabel(btn, 'Read Later');
    // Always open the modal so the user sees something
    showReadLaterModal(items || [], count, unread, labelExists);
  } catch(e) {
    console.error('Read Later scan error:', e);
    if (readLaterCount) readLaterCount.textContent = 'Saved articles & digests';
    setStatus('Read Later error: ' + (e.message || 'Unknown error'));
  } finally {
    if (btn) { btn.dataset.scanning = '0'; btn.disabled = false; }
  }
}

function showReadLaterModal(items, count, unread, labelExists) {
  const existing = document.getElementById('toolModal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'toolModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;overflow-y:auto;padding:12px;';
  const inner = document.createElement('div');
  inner.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:16px;max-width:400px;margin:0 auto;';
  // Header
  const h = document.createElement('div');
  h.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;';
  const titleEl = document.createElement('div');
  titleEl.style.cssText = 'font-weight:700;font-size:14px;';
  titleEl.textContent = '📖 Read Later' + (count > 0 ? ' — ' + count + ' saved' + (unread > 0 ? ' (' + unread + ' unread)' : '') : '');
  const close = document.createElement('button');
  close.textContent = '✕';
  close.style.cssText = 'background:none;border:none;color:var(--text-2);cursor:pointer;font-size:16px;padding:0;';
  close.onclick = () => modal.remove();
  h.append(titleEl, close);
  inner.appendChild(h);

  if (!labelExists || count === 0) {
    // Empty state with helpful explanation
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:16px 0;text-align:center;';
    empty.innerHTML = '<div style="font-size:28px;margin-bottom:8px;">📭</div>' +
      '<div style="font-weight:600;font-size:13px;color:var(--text);margin-bottom:6px;">Your Read Later queue is empty</div>' +
      '<div style="font-size:11px;color:var(--text-2);line-height:1.6;">' +
      (labelExists
        ? 'No emails are saved in your <strong>Reading/Saved</strong> label yet.'
        : 'The <strong>Reading/Saved</strong> label hasn\'t been created yet.') +
      '<br>Run the Organizer with the <strong>Reading/Saved</strong> category enabled, ' +
      'or use Bulk Action to label emails <code style="font-size:10px;background:var(--border);padding:1px 4px;border-radius:3px;">Reading/Saved</code>.' +
      '</div>';
    inner.appendChild(empty);
  } else {
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:10px;color:var(--text-2);margin-bottom:10px;';
    hint.textContent = 'Emails saved in your Reading/Saved Gmail label.';
    inner.appendChild(hint);
    (items || []).slice(0, 30).forEach(item => {
      const row = document.createElement('div');
      row.style.cssText = 'padding:8px 0;border-bottom:1px solid var(--border);font-size:11px;' + (item.isUnread ? 'opacity:1;' : 'opacity:0.7;');
      const from = document.createElement('div');
      from.style.cssText = 'font-weight:600;color:var(--text);margin-bottom:2px;';
      from.textContent = (item.isUnread ? '● ' : '') + (item.from || '').slice(0, 50);
      const sub = document.createElement('div');
      sub.style.cssText = 'color:var(--text-2);';
      sub.textContent = (item.subject || '(no subject)').slice(0, 60);
      row.append(from, sub);
      inner.appendChild(row);
    });
  }
  modal.appendChild(inner);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

function showBulkActionModal() {
  const existing = document.getElementById('toolModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'toolModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;overflow-y:auto;padding:12px;';

  const inner = document.createElement('div');
  inner.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:16px;';

  // Header
  const h = document.createElement('div');
  h.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;';
  const title = document.createElement('div');
  title.style.cssText = 'font-weight:700;font-size:14px;';
  title.textContent = '⚡ Bulk Action';
  const close = document.createElement('button');
  close.textContent = '✕';
  close.style.cssText = 'background:none;border:none;color:var(--text-2);cursor:pointer;font-size:16px;';
  close.onclick = () => modal.remove();
  h.append(title, close);
  inner.appendChild(h);

  // Description
  const desc = document.createElement('div');
  desc.style.cssText = 'font-size:11px;color:var(--text-2);margin-bottom:12px;line-height:1.5;';
  desc.textContent = 'Search your inbox with any Gmail query, preview matching emails, then apply an action to all of them at once.';
  inner.appendChild(desc);

  // Query input
  const queryLabel = document.createElement('div');
  queryLabel.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:4px;';
  queryLabel.textContent = 'Gmail search query';
  const queryInput = document.createElement('input');
  queryInput.type = 'text';
  queryInput.placeholder = 'e.g. from:newsletter@company.com  or  subject:invoice  or  older_than:30d';
  queryInput.style.cssText = 'width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:11px;margin-bottom:10px;';
  inner.append(queryLabel, queryInput);

  // Action picker
  const actionLabel = document.createElement('div');
  actionLabel.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:4px;';
  actionLabel.textContent = 'Action';
  const actionSelect = document.createElement('select');
  actionSelect.style.cssText = 'width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:11px;margin-bottom:10px;';
  [
    { value: 'label',         label: '🏷  Label only' },
    { value: 'archive',       label: '📦  Archive (remove from inbox)' },
    { value: 'archive-label', label: '📦🏷  Archive + label' },
    { value: 'trash',         label: '🗑  Trash' }
  ].forEach(function(opt) {
    const o = document.createElement('option');
    o.value = opt.value; o.textContent = opt.label;
    actionSelect.appendChild(o);
  });
  inner.append(actionLabel, actionSelect);

  // Label input (shown for label/archive-label)
  const labelWrap = document.createElement('div');
  const labelFieldLabel = document.createElement('div');
  labelFieldLabel.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:4px;';
  labelFieldLabel.textContent = 'Gmail label name';
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.placeholder = 'e.g. Finance/Invoices';
  labelInput.style.cssText = 'width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:11px;margin-bottom:10px;';
  labelWrap.append(labelFieldLabel, labelInput);
  inner.appendChild(labelWrap);

  function toggleLabelField() {
    const needsLabel = actionSelect.value === 'label' || actionSelect.value === 'archive-label';
    labelWrap.style.display = needsLabel ? 'block' : 'none';
  }
  actionSelect.addEventListener('change', toggleLabelField);
  toggleLabelField();

  // Max threads note
  const maxNote = document.createElement('div');
  maxNote.style.cssText = 'font-size:10px;color:var(--text-2);margin-bottom:12px;';
  maxNote.textContent = 'Maximum 500 threads per bulk action.';
  inner.appendChild(maxNote);

  // Preview area
  const previewArea = document.createElement('div');
  previewArea.style.cssText = 'margin-bottom:10px;';
  inner.appendChild(previewArea);

  // Buttons row
  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:8px;';

  const previewBtn = document.createElement('button');
  previewBtn.className = 'button ghost';
  previewBtn.textContent = '🔍 Preview';
  previewBtn.style.cssText = 'font-size:11px;flex:1;';

  const applyBtn = document.createElement('button');
  applyBtn.className = 'button primary';
  applyBtn.textContent = '⚡ Apply';
  applyBtn.style.cssText = 'font-size:11px;flex:1;';
  applyBtn.disabled = true;

  btns.append(previewBtn, applyBtn);
  inner.appendChild(btns);

  modal.appendChild(inner);
  document.body.appendChild(modal);

  let lastPreviewCount = 0;

  previewBtn.addEventListener('click', async function() {
    const query = queryInput.value.trim();
    if (!query) { previewArea.innerHTML = '<div style="color:var(--red);font-size:11px;">Enter a search query first.</div>'; return; }
    previewBtn.disabled = true;
    previewBtn.textContent = '…';
    previewArea.innerHTML = '<div style="font-size:11px;color:var(--text-2);">Scanning…</div>';
    try {
      const r = await sendMessage({ type: 'bulkAction', opts: {
        query,
        action: actionSelect.value,
        label: labelInput.value.trim(),
        dryRun: true,
        maxThreads: 500
      }});
      const { matched, preview } = r.result;
      lastPreviewCount = matched;
      applyBtn.disabled = matched === 0;
      let html = '<div style="font-size:12px;font-weight:700;margin-bottom:8px;">' + matched + ' thread' + (matched !== 1 ? 's' : '') + ' match</div>';
      if (preview && preview.length > 0) {
        preview.slice(0, 10).forEach(function(p) {
          html += '<div style="padding:5px 0;border-bottom:1px solid var(--border);font-size:10px;">'
            + '<div style="font-weight:600;color:var(--text);">' + escHtml((p.from || '').slice(0, 50)) + '</div>'
            + '<div style="color:var(--text-2);">' + escHtml((p.subject || '(no subject)').slice(0, 60)) + '</div>'
            + '</div>';
        });
        if (matched > 10) html += '<div style="font-size:10px;color:var(--text-2);margin-top:4px;">…and ' + (matched - 10) + ' more</div>';
      }
      previewArea.innerHTML = html;
    } catch(e) {
      previewArea.innerHTML = '<div style="color:var(--red);font-size:11px;">Error: ' + escHtml(e.message || 'Unknown error') + '</div>';
    } finally {
      previewBtn.disabled = false;
      previewBtn.textContent = '🔍 Preview';
    }
  });

  applyBtn.addEventListener('click', async function() {
    const query = queryInput.value.trim();
    const action = actionSelect.value;
    const label = labelInput.value.trim();
    if (!query) return;
    if ((action === 'label' || action === 'archive-label') && !label) {
      previewArea.innerHTML = '<div style="color:var(--red);font-size:11px;">Enter a label name.</div>';
      return;
    }
    const actionName = { label: 'label', archive: 'archive', 'archive-label': 'archive + label', trash: 'trash' }[action] || action;
    const confirmed = confirm('Apply "' + actionName + '" to ' + lastPreviewCount + ' matching thread(s)? This cannot be undone.');
    if (!confirmed) return;

    applyBtn.disabled = true;
    applyBtn.textContent = '…';
    previewArea.innerHTML = '<div style="font-size:11px;color:var(--text-2);">Applying…</div>';
    try {
      const r = await sendMessage({ type: 'bulkAction', opts: {
        query, action, label, dryRun: false, maxThreads: 500
      }});
      const { applied, matched } = r.result;
      previewArea.innerHTML = '<div style="font-size:12px;font-weight:700;color:var(--green);">✅ Done — ' + applied + ' of ' + matched + ' threads updated.</div>';
      applyBtn.textContent = '✅ Done';
    } catch(e) {
      previewArea.innerHTML = '<div style="color:var(--red);font-size:11px;">Error: ' + escHtml(e.message || 'Unknown error') + '</div>';
      applyBtn.disabled = false;
      applyBtn.textContent = '⚡ Apply';
    }
  });

  // Focus query input
  setTimeout(function() { queryInput.focus(); }, 50);
}

function showUnsubModal(items) {
  try {
    const existing = document.getElementById('toolModal'); if(existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'toolModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;overflow-y:auto;padding:12px;';
    const inner = document.createElement('div');
    inner.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:16px;';
    const h = document.createElement('div');
    h.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';
    const title = document.createElement('div'); title.textContent='Newsletters found'; title.style.cssText='font-weight:700;font-size:14px;';
    const close = document.createElement('button'); close.textContent='✕'; close.style.cssText='background:none;border:none;color:var(--text-2);cursor:pointer;font-size:16px;';
    close.onclick = ()=>modal.remove();
    h.append(title,close); inner.appendChild(h);
    // Extract sender email address for bulk archive
    function extractEmail(fromStr) {
      const m = fromStr.match(/<([^>]+)>/);
      return m ? m[1].trim() : fromStr.trim();
    }

    items.forEach(item=>{
      const senderEmail = extractEmail(item.from);
      const row = document.createElement('div');
      row.dataset.sender = senderEmail;
      row.style.cssText='padding:8px 0;border-bottom:1px solid var(--border);font-size:11px;transition:opacity 0.3s;';
      const from = document.createElement('div'); from.style.cssText='font-weight:600;color:var(--text);margin-bottom:2px;'; from.textContent=item.from.slice(0,50);
      const sub = document.createElement('div'); sub.style.cssText='color:var(--text-2);'; sub.textContent=item.subject.slice(0,60);
      const actions = document.createElement('div'); actions.style.cssText='margin-top:4px;display:flex;gap:6px;';

      function markSenderDone() {
        // Fade and remove ALL rows from this sender in the list
        inner.querySelectorAll('[data-sender="' + senderEmail + '"]').forEach(r => {
          r.style.opacity = '0.3';
          setTimeout(() => r.remove(), 400);
        });
        // Update count
        const remaining = inner.querySelectorAll('[data-sender]').length;
        unsubCount.textContent = remaining > 0 ? remaining + ' newsletter(s) found' : 'All done ✓';
      }

      // Add unsubscribe button
      if(item.messageId) {
        const unsubBtn = document.createElement('button');
        unsubBtn.className = 'button ghost';
        unsubBtn.style.cssText = 'font-size:10px;padding:3px 6px;';
        unsubBtn.textContent = 'Unsubscribe';
        unsubBtn.addEventListener('click', safeExecute(async () => {
          try {
            unsubBtn.disabled = true;
            unsubBtn.textContent = '...';
            const resp = await sendMessage({ type: 'unsubscribeFromSender', messageId: item.messageId });
            const action = resp.result?.action;

            if (action === 'not-found') {
              unsubBtn.textContent = 'No link found';
              unsubBtn.disabled = false;
              return;
            }

            // Archive ALL threads from this sender before opening any tab
            sendMessage({ type: 'archiveAllFromSender', senderEmail }).catch(() => {});

            if (action === 'auto-post' || action === 'auto-mailto') {
              // Fully automated — confirmed
              unsubBtn.textContent = '✅ Done';
              unsubBtn.style.color = 'var(--green)';
            } else if (action === 'mailto') {
              const url = resp.result?.url;
              if (url) chrome.tabs.create({ url: url });
            } else if (action === 'manual') {
              const url = resp.result?.url;
              if (url) chrome.tabs.create({ url: url });
            }

            markSenderDone();
          } catch (error) {
            console.error("Unsubscribe error:", error);
            unsubBtn.textContent = 'Error';
            unsubBtn.disabled = false;
          }
        }));
        actions.appendChild(unsubBtn);
      }

      // Block sender — nuclear option
      const blockBtn = document.createElement('button');
      blockBtn.className = 'button danger';
      blockBtn.style.cssText = 'font-size:10px;padding:3px 6px;';
      blockBtn.textContent = '☠️ Block';
      blockBtn.title = 'Create auto-trash rule + delete all existing emails from this sender';
      blockBtn.addEventListener('click', safeExecute(async () => {
        if (!confirm('Block ' + senderEmail + '?\n\nThis will:\n• Create an auto-trash rule\n• Trash all existing emails from this sender\n• Attempt to unsubscribe\n\nThis cannot be undone.')) return;
        blockBtn.disabled = true;
        blockBtn.textContent = '…';
        try {
          const resp = await sendMessage({ type: 'blockSender', from: item.from, messageId: item.messageId || null });
          const r = resp.result;
          blockBtn.textContent = '🚫 Blocked (' + (r.trashed || 0) + ' trashed)';
          blockBtn.style.color = 'var(--red)';
          markSenderDone();
        } catch (err) {
          blockBtn.textContent = 'Error';
          blockBtn.disabled = false;
          showToast('Block failed: ' + err.message, 'error');
        }
      }));
      actions.appendChild(blockBtn);

      if(item.unsubUrl){
        const a=document.createElement('a'); a.href=item.unsubUrl; a.target='_blank';
        a.style.cssText='font-size:10px;color:var(--red);text-decoration:none;'; a.textContent='Open link →';
        actions.appendChild(a);
      }
      row.append(from,sub,actions); inner.appendChild(row);
    });
    modal.appendChild(inner);
    document.body.appendChild(modal);
  } catch (error) {
    console.error("Show unsub modal error:", error);
  }
}

function showFollowUpModal(items) {
  try {
    const existing = document.getElementById('toolModal'); if(existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'toolModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;overflow-y:auto;padding:12px;';
    const inner = document.createElement('div');
    inner.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:16px;';
    const h = document.createElement('div');
    h.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';
    const title = document.createElement('div'); title.textContent='Needs follow-up'; title.style.cssText='font-weight:700;font-size:14px;color:var(--yellow);';
    const close = document.createElement('button'); close.textContent='✕'; close.style.cssText='background:none;border:none;color:var(--text-2);cursor:pointer;font-size:16px;';
    close.onclick = ()=>modal.remove();
    h.append(title,close); inner.appendChild(h);

    // Auto-label button
    const autoLabelRow = document.createElement('div');
    autoLabelRow.style.cssText = 'margin-bottom:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
    const autoLabelBtn = document.createElement('button');
    autoLabelBtn.className = 'button primary';
    autoLabelBtn.style.cssText = 'font-size:11px;padding:5px 12px;';
    autoLabelBtn.textContent = '🏷️ Label all as Action/Follow Up';
    autoLabelBtn.addEventListener('click', safeExecute(async () => {
      autoLabelBtn.disabled = true;
      autoLabelBtn.textContent = 'Labeling…';
      try {
        const resp = await sendMessage({ type: 'autoLabelFollowUps', daysThreshold: 3 });
        const labeled = resp.result && resp.result.labeled || 0;
        autoLabelBtn.textContent = '✅ Labeled ' + labeled + ' threads';
        autoLabelBtn.style.background = 'var(--green-dim)';
        autoLabelBtn.style.color = 'var(--green)';
        showToast('Labeled ' + labeled + ' follow-up threads.', 'success');
      } catch (err) {
        autoLabelBtn.textContent = 'Error';
        autoLabelBtn.disabled = false;
      }
    }));
    const noteEl = document.createElement('span');
    noteEl.style.cssText = 'font-size:10px;color:var(--text-3);';
    noteEl.textContent = 'Sent 3+ days ago with no reply';
    autoLabelRow.append(autoLabelBtn, noteEl);
    inner.appendChild(autoLabelRow);

    items.forEach(item=>{
      const row = document.createElement('div');
      row.style.cssText='padding:8px 0;border-bottom:1px solid var(--border);font-size:11px;cursor:pointer;transition:background .15s;';
      row.addEventListener('mouseenter', () => { row.style.background = 'var(--hover,rgba(255,255,255,.05))'; });
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
      if (item.threadId) {
        row.addEventListener('click', () => {
          chrome.tabs.create({ url: 'https://mail.google.com/mail/u/0/#sent/' + item.threadId });
        });
      }
      const sub = document.createElement('div'); sub.style.cssText='font-weight:600;color:var(--text);margin-bottom:2px;'; sub.textContent=item.subject.slice(0,55);
      const to = document.createElement('div'); to.style.cssText='color:var(--text-2);'; to.textContent='To: '+item.to.slice(0,45);
      const age = document.createElement('div'); age.style.cssText='color:var(--yellow);margin-top:2px;'; age.textContent=item.daysAgo+' days ago — no reply';
      row.append(sub,to,age); inner.appendChild(row);
    });
    modal.appendChild(inner);
    document.body.appendChild(modal);
  } catch (error) {
    console.error("Show follow-up modal error:", error);
  }
}

// ── "Why was this labeled?" modal ────────────────────────────────────────
async function showLabelDecisionsModal(ruleId, ruleName) {
  try {
    const existing = document.getElementById('labelDecisionModal');
    if (existing) { existing.remove(); return; }
    const modal = document.createElement('div');
    modal.id = 'labelDecisionModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;overflow-y:auto;padding:12px;';
    const inner = document.createElement('div');
    inner.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:16px;max-width:360px;margin:0 auto;';

    const h = document.createElement('div');
    h.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:700;font-size:13px;color:var(--blue);';
    title.textContent = '🏷️ Why: ' + (ruleName || ruleId);
    const close = document.createElement('button');
    close.textContent = '✕'; close.style.cssText = 'background:none;border:none;color:var(--text-2);cursor:pointer;font-size:16px;';
    close.onclick = () => modal.remove();
    h.append(title, close);
    inner.appendChild(h);

    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:10px;color:var(--text-3);margin-bottom:12px;';
    sub.textContent = 'Last emails labeled by this rule:';
    inner.appendChild(sub);

    const loading = document.createElement('div');
    loading.style.cssText = 'text-align:center;padding:16px;color:var(--text-2);font-size:12px;';
    loading.textContent = 'Loading…';
    inner.appendChild(loading);
    modal.appendChild(inner);
    document.body.appendChild(modal);

    try {
      const resp = await sendMessage({ type: 'getLabelDecisions', opts: { ruleId } });
      const decisions = (resp && resp.decisions) || [];
      loading.remove();
      if (!decisions.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:var(--text-3);font-size:12px;text-align:center;padding:12px;';
        empty.textContent = 'No decisions recorded yet — run Auto-organize to start logging.';
        inner.appendChild(empty);
      } else {
        decisions.forEach(function(d) {
          const row = document.createElement('div');
          row.style.cssText = 'padding:8px 0;border-bottom:1px solid var(--border);font-size:11px;';
          const subj = document.createElement('div');
          subj.style.cssText = 'font-weight:600;color:var(--text);margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
          subj.textContent = escHtml(d.subject || '(no subject)');
          const from = document.createElement('div');
          from.style.cssText = 'color:var(--text-2);';
          from.textContent = (d.from || '').slice(0, 50);
          const reason = document.createElement('div');
          reason.style.cssText = 'color:var(--blue);margin-top:2px;font-size:10px;';
          reason.textContent = '↳ ' + (d.reason || 'matched rule');
          const ts = document.createElement('div');
          ts.style.cssText = 'color:var(--text-3);font-size:10px;';
          ts.textContent = d.timestamp ? new Date(d.timestamp).toLocaleString() : '';
          row.append(subj, from, reason, ts);
          inner.appendChild(row);
        });
      }
    } catch (err) {
      loading.textContent = 'Error: ' + err.message;
    }
  } catch (error) {
    console.error('showLabelDecisionsModal error:', error);
  }
}

function showDuplicateModal(items, threadIds) {
  try {
    const existing = document.getElementById('toolModal'); if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'toolModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;overflow-y:auto;padding:12px;';

    const inner = document.createElement('div');
    inner.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:16px;';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';
    const title = document.createElement('div');
    title.textContent = 'Duplicate emails found';
    title.style.cssText = 'font-weight:700;font-size:14px;color:var(--red);';
    const close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText = 'background:none;border:none;color:var(--text-2);cursor:pointer;font-size:16px;';
    close.onclick = () => modal.remove();
    header.append(title, close);
    inner.appendChild(header);

    const intro = document.createElement('p');
    intro.textContent = 'Review the duplicates below before deleting them.';
    intro.style.cssText = 'font-size:11px;color:var(--text-2);margin-bottom:10px;';
    inner.appendChild(intro);

    items.forEach(item => {
      const row = document.createElement('div');
      row.style.cssText = 'padding:8px 0;border-bottom:1px solid var(--border);font-size:11px;';
      const badge = document.createElement('div');
      badge.textContent = item.isDuplicate ? 'Duplicate copy' : 'Original kept';
      badge.style.cssText = 'display:inline-block;margin-bottom:4px;padding:2px 6px;border-radius:999px;font-size:10px;font-weight:700;' +
        (item.isDuplicate ? 'background:rgba(234,67,53,.14);color:var(--red);' : 'background:rgba(66,133,244,.14);color:var(--blue);');
      const from = document.createElement('div');
      from.style.cssText = 'font-weight:600;color:var(--text);margin-bottom:2px;';
      from.textContent = (item.from || '').slice(0, 60);
      const sub = document.createElement('div');
      sub.style.cssText = 'color:var(--text-2);';
      sub.textContent = (item.subject || '(No subject)').slice(0, 70);
      row.append(badge, from, sub);
      inner.appendChild(row);
    });

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px;';

    const cancel = document.createElement('button');
    cancel.className = 'button ghost';
    cancel.type = 'button';
    cancel.textContent = 'Close';
    cancel.onclick = () => modal.remove();

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'button danger';
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Delete duplicates';
    deleteBtn.onclick = safeExecute(async () => {
      const confirmed = window.confirm('This will move the duplicate emails to Trash. You can recover them from Trash within 30 days. Continue?');
      if (!confirmed) {
        return;
      }

      deleteBtn.disabled = true;
      deleteBtn.textContent = 'Deleting...';
      try {
        const d = await sendMessage({ type: 'deleteDuplicates', threadIds, confirmed: true });
        dupeCount.textContent = 'Deleted ' + d.result.deleted + ' duplicate(s)';
        setToolBtnBadge('dupeBadge', 0);
        showToast('Deleted ' + d.result.deleted + ' duplicate(s)', 'success');
        const btn = document.getElementById('scanDupeBtn');
        setToolBtnLabel(btn, 'Dupes');
        btn.style.color = '';
        btn.style.borderColor = '';
        btn.disabled = false;
        btn.onclick = runDupeScan;
        modal.remove();
      } catch (e) {
        dupeCount.textContent = 'Error: ' + e.message;
        deleteBtn.disabled = false;
        deleteBtn.textContent = 'Delete duplicates';
      }
    });

    footer.append(cancel, deleteBtn);
    inner.appendChild(footer);
    modal.appendChild(inner);
    document.body.appendChild(modal);
  } catch (error) {
    console.error("Show duplicate modal error:", error);
  }
}

// (loadInboxScore is now called inside initialize())

// ── v0.3.8: Stats ─────────────────────────────────────────────────────────
async function loadStats() {
  try {
    const r = await sendMessage({ type: 'getStats' });
    const { totalOrganized, weekOrganized, totalDeleted, topLabels } = r.result;

    // Update metric card numbers
    const elTotal   = document.getElementById('statTotal');
    const elWeek    = document.getElementById('statWeek');
    const elDeleted = document.getElementById('statDeleted');
    if (elTotal)   elTotal.textContent   = totalOrganized ?? '—';
    if (elWeek)    elWeek.textContent    = weekOrganized  ?? '—';
    if (elDeleted) elDeleted.textContent = totalDeleted   ?? '—';

    // Animate fill bars relative to the largest value
    const maxVal = Math.max(totalOrganized || 0, weekOrganized || 0, totalDeleted || 0, 1);
    const totalBar   = document.getElementById('statTotalBar');
    const weekBar    = document.getElementById('statWeekBar');
    const deletedBar = document.getElementById('statDeletedBar');
    // Small delay so the CSS transition is visible
    requestAnimationFrame(() => {
      if (totalBar)   totalBar.style.width   = Math.round(((totalOrganized||0)/maxVal)*100) + '%';
      if (weekBar)    weekBar.style.width    = Math.round(((weekOrganized||0)/maxVal)*100) + '%';
      if (deletedBar) deletedBar.style.width = Math.round(((totalDeleted||0)/maxVal)*100) + '%';
    });
  } catch(e) {
    console.error("Load stats error:", e);
  }
}

// ── v0.3.8: Rule conflicts ────────────────────────────────────────────────
async function checkConflicts() {
  try {
    const r = await sendMessage({ type: 'detectConflicts' });
    const conflicts = r.result;
    const banner = document.getElementById('conflictBanner');
    const text = document.getElementById('conflictText');
    if (conflicts.length > 0) {
      const names = conflicts.map(c => '"'+c.ruleA.name+'" & "'+c.ruleB.name+'"').slice(0,2).join(', ');
      text.textContent = conflicts.length + ' rule conflict(s): ' + names + '. Check settings.';
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  } catch(e) {
    console.error("Check conflicts error:", e);
  }
}

// ── v0.3.8: Quick run selector ────────────────────────────────────────────
let selectedRuleIds = [];

async function openQuickRun() {
  try {
    const response = await sendMessage({ type: 'getDashboard' });
    const rules = response.settings?.rules || [];
    const card = document.getElementById('quickRunCard');
    const list = document.getElementById('quickRulesList');
    list.innerHTML = '';
    selectedRuleIds = rules.map(r => r.id);

    rules.forEach(rule => {
      const row = document.createElement('label');
      row.style.cssText='display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--bg-raised);border-radius:6px;cursor:pointer;font-size:12px;';
      const cb = document.createElement('input'); cb.type='checkbox'; cb.checked=true;
      cb.style.cssText='accent-color:var(--blue);width:14px;height:14px;cursor:pointer;';
      cb.addEventListener('change', () => {
        if (cb.checked) { selectedRuleIds.push(rule.id); }
        else { selectedRuleIds = selectedRuleIds.filter(id => id !== rule.id); }
      });
      const dot = document.createElement('div');
      dot.style.cssText='width:8px;height:8px;border-radius:50%;flex-shrink:0;background:'+(rule.color||'var(--text-3)')+';';
      const name = document.createElement('div'); name.textContent=rule.name; name.style.flex='1';
      const lbl = document.createElement('div'); lbl.textContent=rule.label; lbl.style.cssText='color:var(--text-3);font-size:10px;';
      // "Why?" button — shows last 5 emails labeled by this rule
      const whyBtn = document.createElement('button');
      whyBtn.textContent = '?';
      whyBtn.title = 'See why emails were labeled by this rule';
      whyBtn.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:50%;width:16px;height:16px;font-size:9px;color:var(--text-3);cursor:pointer;padding:0;line-height:1;flex-shrink:0;';
      whyBtn.addEventListener('click', function(e) {
        e.preventDefault(); e.stopPropagation();
        showLabelDecisionsModal(rule.id, rule.name);
      });
      row.append(cb,dot,name,lbl,whyBtn);
      list.appendChild(row);
    });

    card.style.display = 'block';
    card.scrollIntoView({ behavior:'smooth' });
  } catch (error) {
    console.error("Open quick run error:", error);
    setStatus("Could not load rules.");
  }
}

document.getElementById('closeQuickRun').addEventListener('click', () => {
  document.getElementById('quickRunCard').style.display='none';
});

document.getElementById('quickPreviewBtn').addEventListener('click', safeExecute(async () => {
  document.getElementById('quickRunCard').style.display='none';
  clearResults();
  setSummary("");
  setStatus('Previewing selected rules...');
  const r = await sendMessage({ type:'runSelectedRules', dryRun:true, ruleIds:selectedRuleIds });
  renderResult(r.result);
  await initialize();
}));

document.getElementById('quickRunBtn').addEventListener('click', safeExecute(async () => {
  document.getElementById('quickRunCard').style.display='none';
  clearResults();
  setSummary("");
  setStatus('Running selected rules...');
  const r = await sendMessage({ type:'runSelectedRules', dryRun:false, ruleIds:selectedRuleIds });
  renderResult(r.result);
  await initialize();
}));

document.getElementById('runButton').addEventListener('click', openQuickRun, { once: false });

// ── Diagnostics ───────────────────────────────────────────────────────────
document.getElementById('diagBtn').addEventListener('click', safeExecute(async () => {
  const bar = document.getElementById('diagBar');
  bar.style.display = 'block';
  bar.textContent = '🔍 Checking connection…';
  try {
    const r = await sendMessage({ type: 'diagnose' });
    const lines = [
      '✅ Connected as: ' + r.email,
      '📬 Inbox threads visible: ' + r.inboxThreadsScanned + ' (first 5)',
      '📋 Rules saved: ' + r.rulesCount,
    ];
    r.rules.forEach(rule => {
      lines.push('  • ' + rule.name + ' → label: ' + rule.label + ' / action: ' + rule.action);
    });
    if (r.rulesCount === 0) lines.push('⚠️ No rules saved — add rules in Settings and click Save.');
    if (r.inboxThreadsScanned === 0) lines.push('⚠️ Inbox appears empty or Gmail access is restricted.');
    bar.innerHTML = lines.map(l => '<div>' + l + '</div>').join('');
  } catch (err) {
    bar.textContent = '❌ ' + (err.message || 'Connection failed. Check sign-in.');
  }
}));

// ── Bulk archive old read emails ──────────────────────────────────────────
// bulkArchiveStatus proxy already defined at top of file

document.getElementById('bulkArchivePreviewBtn').addEventListener('click', safeExecute(async () => {
  setStatus('Scanning old read emails…');
  const r = await sendMessage({ type: 'bulkArchiveOld', dryRun: true, olderThanDays: 14 });
  const { message, total, previews } = r.result;
  setStatus(message);
  if (previews && previews.length > 0) {
    const sample = previews.slice(0, 3).map(p => p.subject || p.from || '(unknown)').join(', ');
    setSummary('Sample: ' + sample + (total > 3 ? ` + ${total - 3} more` : ''));
  }
}));

document.getElementById('bulkArchiveRunBtn').addEventListener('click', safeExecute(async () => {
  const btn = document.getElementById('bulkArchiveRunBtn');
  setStatus('Archiving old read emails…');
  setToolBtnLabel(btn, '…');
  btn.disabled = true;
  try {
    const r = await sendMessage({ type: 'bulkArchiveOld', dryRun: false, olderThanDays: 14 });
    setStatus(r.result.message);
    showToast(r.result.message, 'success');
    await loadInboxScore();
  } finally {
    setToolBtnLabel(btn, 'Archive old');
    btn.disabled = false;
  }
}));

// ── Bulk Delete ───────────────────────────────────────────────────────────────
(function() {
  const queryInput = document.getElementById('bulkDeleteQuery');
  const searchBtn  = document.getElementById('bulkDeleteSearchBtn');
  const resultEl   = document.getElementById('bulkDeleteResult');
  const deleteBtn  = document.getElementById('bulkDeleteRunBtn');
  const progressEl = document.getElementById('bulkDeleteProgress');
  if (!queryInput || !searchBtn) return;

  let lastQuery = '';
  let lastCount = 0;

  function showInlineError(msg) {
    resultEl.style.color = 'var(--red)';
    resultEl.textContent = '⚠ ' + msg;
    deleteBtn.style.display = 'none';
  }
  function clearInlineError() {
    resultEl.style.color = '';
  }

  async function doSearch() {
    const q = queryInput.value.trim();
    if (!q) { resultEl.textContent = 'Enter a sender email, domain, or keyword.'; return; }
    clearInlineError();
    resultEl.textContent = 'Searching…';
    deleteBtn.style.display = 'none';
    progressEl.style.display = 'none';
    searchBtn.disabled = true;
    try {
      const r = await sendMessage({ type: 'bulkDeleteSearch', query: q });
      lastQuery = q;
      lastCount = r.count || 0;
      if (lastCount === 0) {
        resultEl.textContent = `No emails found for "${escHtml(q)}".`;
      } else {
        resultEl.innerHTML = `Found <strong>${escHtml(String(lastCount.toLocaleString()))}</strong> email(s) matching <em>${escHtml(q)}</em>.`;
        deleteBtn.style.display = 'block';
      }
    } catch (e) {
      console.error('bulkDeleteSearch error:', e);
      showInlineError(e.message || 'Search failed. Try again.');
    } finally {
      searchBtn.disabled = false;
    }
  }

  searchBtn.addEventListener('click', doSearch);
  queryInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  deleteBtn.addEventListener('click', async () => {
    if (!lastQuery || lastCount === 0) return;
    const confirmed = window.confirm(
      `Permanently delete ${lastCount.toLocaleString()} email(s) matching "${lastQuery}"?\n\nThis cannot be undone.`
    );
    if (!confirmed) return;

    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Deleting…';
    progressEl.style.display = 'block';
    progressEl.textContent = 'Starting…';
    clearInlineError();
    resultEl.textContent = '';

    const onProgress = (msg) => {
      if (msg.type === 'bulkDeleteProgress') {
        progressEl.textContent = `Deleted ${msg.deleted.toLocaleString()}` +
          (msg.failed > 0 ? `, ${msg.failed} failed` : '') + '…';
      }
    };
    chrome.runtime.onMessage.addListener(onProgress);

    try {
      const r = await sendMessage({ type: 'bulkDeleteRun', query: lastQuery });
      const { deleted, failed } = r.result;
      progressEl.style.display = 'none';
      resultEl.innerHTML = `✅ Deleted <strong>${escHtml(String(deleted.toLocaleString()))}</strong> email(s)` +
        (failed > 0 ? `, <span style="color:var(--yellow)">${escHtml(String(failed))} could not be deleted</span>` : '') + '.';
      deleteBtn.style.display = 'none';
      queryInput.value = '';
      lastQuery = '';
      lastCount = 0;
      showToast(`Deleted ${deleted.toLocaleString()} email(s)`, 'success');
      await loadInboxScore();
    } catch (e) {
      console.error('bulkDeleteRun error:', e);
      showInlineError(e.message || 'Delete failed. Try again.');
      progressEl.style.display = 'none';
    } finally {
      chrome.runtime.onMessage.removeListener(onProgress);
      deleteBtn.disabled = false;
      deleteBtn.textContent = '🗑 Delete all matched emails';
    }
  });
})();

// (loadStats and checkConflicts are now called inside initialize())

// ── Snooze Feature (v0.9.0) ──────────────────────────────────────────────────
function computeWakeAt(preset) {
  const now = new Date();
  const next = new Date(now);

  if (preset === '1h') {
    next.setHours(next.getHours() + 1);
  } else if (preset === 'tomorrow-9am') {
    next.setDate(next.getDate() + 1);
    next.setHours(9, 0, 0, 0);
  } else if (preset === '1w') {
    next.setDate(next.getDate() + 7);
    next.setHours(9, 0, 0, 0);
  }

  return next.getTime();
}

function humanizeTimeRemaining(ms) {
  const now = Date.now();
  if (ms <= now) return 'now';
  const diff = ms - now;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return days + 'd ' + (hours % 24) + 'h';
  if (hours > 0) return hours + 'h ' + (minutes % 60) + 'm';
  if (minutes > 0) return minutes + 'm';
  return 'in 1m';
}

const snoozedOverlay = document.getElementById('snoozedOverlay');
const snoozedList = document.getElementById('snoozedList');
const closeSnoozedBtn = document.getElementById('closeSnoozedBtn');
const snoozePopover = document.getElementById('snoozePopover');
const snoozeCustomInput = document.getElementById('snoozeCustomInput');
const snoozeConfirmBtn = document.getElementById('snoozeConfirmBtn');
const snoozeCancelBtn = document.getElementById('snoozeCancelBtn');
let pendingSnoozeThreadId = null;

if (closeSnoozedBtn) {
  closeSnoozedBtn.addEventListener('click', () => {
    snoozedOverlay.style.display = 'none';
  });
}

document.getElementById('scanSnoozedBtn').addEventListener('click', safeExecute(async () => {
  snoozedOverlay.style.display = 'flex';
  snoozedList.innerHTML = '<div style="text-align:center;color:var(--text-2);padding:20px;">Loading...</div>';
  try {
    const response = await sendMessage({ type: 'listSnoozedThreads' });
    const { snoozed } = response;
    renderSnoozedThreads(snoozed || []);
  } catch (error) {
    console.error("List snoozed threads error:", error);
    snoozedList.innerHTML = '<div style="color:var(--red);padding:20px;">Error loading snoozed threads</div>';
  }
}));

function renderSnoozedThreads(threads) {
  snoozedList.innerHTML = '';
  if (threads.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'text-align:center;color:var(--text-2);padding:20px;';
    empty.textContent = 'No snoozed threads.';
    snoozedList.appendChild(empty);
    return;
  }

  for (const thread of threads) {
    const item = document.createElement('div');
    item.className = 'snooze-item';

    const info = document.createElement('div');
    info.className = 'snooze-item-info';

    const subject = document.createElement('div');
    subject.className = 'snooze-item-subject';
    subject.textContent = (thread.subject || '(No subject)').substring(0, 50);

    const from = document.createElement('div');
    from.className = 'snooze-item-from';
    from.textContent = thread.from || '';

    const time = document.createElement('div');
    time.className = 'snooze-item-time';
    time.textContent = 'Wakes in ' + humanizeTimeRemaining(thread.wakeAt);

    info.appendChild(subject);
    info.appendChild(from);
    info.appendChild(time);

    const buttons = document.createElement('div');
    buttons.className = 'snooze-item-buttons';

    const wakeBtn = document.createElement('button');
    wakeBtn.className = 'button ghost';
    wakeBtn.textContent = '⏰ Wake';
    wakeBtn.addEventListener('click', safeExecute(async () => {
      await sendMessage({ type: 'wakeSnoozedThreadNow', threadId: thread.threadId });
      item.remove();
      document.getElementById('snoozedCount').textContent = 'Tap to view';
    }));

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'button ghost';
    cancelBtn.textContent = '✕ Cancel';
    cancelBtn.addEventListener('click', safeExecute(async () => {
      await sendMessage({ type: 'cancelSnooze', threadId: thread.threadId });
      item.remove();
      document.getElementById('snoozedCount').textContent = 'Tap to view';
    }));

    buttons.appendChild(wakeBtn);
    buttons.appendChild(cancelBtn);
    item.appendChild(info);
    item.appendChild(buttons);
    snoozedList.appendChild(item);
  }
}

function openSnoozePopover(threadId, rect) {
  pendingSnoozeThreadId = threadId;
  snoozeCustomInput.style.display = 'none';
  snoozePopover.style.display = 'block';
  snoozePopover.style.left = rect.left + 'px';
  snoozePopover.style.top = (rect.bottom + 5) + 'px';
}

document.querySelectorAll('.snooze-preset-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const preset = btn.dataset.preset;
    if (preset === 'custom') {
      snoozeCustomInput.style.display = 'block';
      snoozeCustomInput.focus();
    } else {
      snoozePopover.style.display = 'none';
      await doSnooze(preset);
    }
  });
});

snoozeConfirmBtn.addEventListener('click', safeExecute(async () => {
  const customValue = snoozeCustomInput.value;
  if (!customValue) {
    alert('Please select a date and time.');
    return;
  }
  const wakeAt = new Date(customValue).getTime();
  snoozePopover.style.display = 'none';
  await performSnooze(wakeAt);
}));

snoozeCancelBtn.addEventListener('click', () => {
  snoozePopover.style.display = 'none';
  pendingSnoozeThreadId = null;
});

async function doSnooze(preset) {
  const wakeAt = computeWakeAt(preset);
  await performSnooze(wakeAt);
}

async function performSnooze(wakeAt) {
  try {
    if (!pendingSnoozeThreadId) return;
    setStatus('Snoozing thread...');
    await sendMessage({ type: 'snoozeThread', threadId: pendingSnoozeThreadId, wakeAt });
    setStatus('Thread snoozed until ' + new Date(wakeAt).toLocaleString());
    document.getElementById('snoozedCount').textContent = 'Tap to view';
    pendingSnoozeThreadId = null;
  } catch (error) {
    console.error("Snooze error:", error);
    setStatus('Error snoozing thread: ' + formatError(error));
  }
}

// ── Thread Summary Feature (v0.9.0) ──────────────────────────────────────────
const summaryOverlay = document.getElementById('summaryOverlay');
const summaryContent = document.getElementById('summaryContent');
const summaryLoading = document.getElementById('summaryLoading');
const closeSummaryBtn = document.getElementById('closeSummaryBtn');

if (closeSummaryBtn) {
  closeSummaryBtn.addEventListener('click', () => {
    summaryOverlay.style.display = 'none';
  });
}

async function openSummaryModal(threadId) {
  summaryOverlay.style.display = 'flex';
  summaryContent.style.display = 'none';
  summaryLoading.style.display = 'block';
  try {
    const response = await sendMessage({ type: 'summarizeThread', threadId });
    const { summary, keyPoints, actionItems, participants, sentiment, messageCount, generatedAt } = response.result;
    renderThreadSummary(summary, keyPoints, actionItems, participants, sentiment, messageCount, generatedAt);
  } catch (error) {
    console.error("Summary error:", error);
    summaryLoading.textContent = 'Error loading summary: ' + formatError(error);
  }
}

function renderThreadSummary(summary, keyPoints, actionItems, participants, sentiment, messageCount, generatedAt) {
  summaryContent.innerHTML = '';

  if (summary) {
    const summarySection = document.createElement('div');
    summarySection.className = 'summary-section';
    const h4 = document.createElement('h4');
    h4.textContent = 'Summary';
    const p = document.createElement('p');
    p.textContent = summary;
    summarySection.appendChild(h4);
    summarySection.appendChild(p);
    summaryContent.appendChild(summarySection);
  }

  if (keyPoints && keyPoints.length > 0) {
    const section = document.createElement('div');
    section.className = 'summary-section';
    const h4 = document.createElement('h4');
    h4.textContent = 'Key Points';
    const ul = document.createElement('ul');
    keyPoints.forEach(point => {
      const li = document.createElement('li');
      li.textContent = point;
      ul.appendChild(li);
    });
    section.appendChild(h4);
    section.appendChild(ul);
    summaryContent.appendChild(section);
  }

  if (actionItems && actionItems.length > 0) {
    const section = document.createElement('div');
    section.className = 'summary-section';
    const h4 = document.createElement('h4');
    h4.textContent = 'Action Items';
    const ul = document.createElement('ul');
    actionItems.forEach(item => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'summary-action-item';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      const text = document.createElement('span');
      text.textContent = item;
      label.appendChild(checkbox);
      label.appendChild(text);
      li.appendChild(label);
      ul.appendChild(li);
    });
    section.appendChild(h4);
    section.appendChild(ul);
    summaryContent.appendChild(section);
  }

  if (participants && participants.length > 0) {
    const section = document.createElement('div');
    section.className = 'summary-section';
    const h4 = document.createElement('h4');
    h4.textContent = 'Participants';
    const chips = document.createElement('div');
    chips.className = 'summary-participants';
    participants.forEach(p => {
      const chip = document.createElement('div');
      chip.className = 'summary-participant-chip';
      chip.textContent = p;
      chips.appendChild(chip);
    });
    section.appendChild(h4);
    section.appendChild(chips);
    summaryContent.appendChild(section);
  }

  if (sentiment) {
    const section = document.createElement('div');
    section.className = 'summary-section';
    const h4 = document.createElement('h4');
    h4.textContent = 'Tone';
    const badge = document.createElement('span');
    badge.className = 'sentiment-badge ' + (sentiment.toLowerCase());
    badge.textContent = sentiment;
    section.appendChild(h4);
    section.appendChild(badge);
    summaryContent.appendChild(section);
  }

  const metaSection = document.createElement('div');
  metaSection.className = 'summary-section';
  metaSection.style.cssText = 'border-top:1px solid var(--border);padding-top:10px;margin-top:10px;';
  const meta = document.createElement('p');
  meta.style.cssText = 'font-size:10px;color:var(--text-3);margin:0;';
  meta.textContent = messageCount + ' message(s) • Generated ' + new Date(generatedAt).toLocaleTimeString();
  metaSection.appendChild(meta);
  summaryContent.appendChild(metaSection);

  summaryLoading.style.display = 'none';
  summaryContent.style.display = 'block';
}

// ── Clean-up Labels Feature ───────────────────────────────────────────────────
(function initCleanupLabels() {
  const btn      = document.getElementById('cleanupLabelsBtn');
  const overlay  = document.getElementById('cleanupOverlay');
  const closeBtn = document.getElementById('cleanupCloseBtn');
  const scanning = document.getElementById('cleanupScanning');
  const chipsEl  = document.getElementById('cleanupChips');
  const footer   = document.getElementById('cleanupFooter');
  const selCount = document.getElementById('cleanupSelCount');
  const selAll   = document.getElementById('cleanupSelectAll');
  const delBtn        = document.getElementById('cleanupDeleteBtn');
  const subText       = document.getElementById('cleanupModalSub');
  const badge         = document.getElementById('cleanupBadge');
  const confirmBox    = document.getElementById('cleanupConfirm');
  const confirmMsg    = document.getElementById('cleanupConfirmMsg');
  const cancelConfirm = document.getElementById('cleanupCancelConfirm');
  const confirmDel    = document.getElementById('cleanupConfirmDelete');

  if (!btn || !overlay) return;

  let _labels = [];       // [{ id, name }]
  let _selected = new Set();

  function updateSelCount() {
    selCount.textContent = _selected.size + ' of ' + _labels.length + ' selected';
    delBtn.disabled = _selected.size === 0;
    delBtn.style.opacity = _selected.size === 0 ? '0.5' : '1';
  }

  function renderChips() {
    chipsEl.innerHTML = '';
    _labels.forEach(function(lbl) {
      var chip = document.createElement('label');
      chip.style.cssText = 'display:flex;align-items:center;gap:4px;background:' +
        (_selected.has(lbl.id) ? 'rgba(248,113,113,.12)' : 'rgba(255,255,255,.05)') +
        ';border:1px solid ' +
        (_selected.has(lbl.id) ? 'rgba(248,113,113,.3)' : 'rgba(255,255,255,.1)') +
        ';border-radius:20px;padding:4px 10px 4px 7px;font-size:11px;color:' +
        (_selected.has(lbl.id) ? '#f87171' : '#aaa') +
        ';cursor:pointer;user-select:none;transition:all .12s;';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = _selected.has(lbl.id);
      cb.style.cssText = 'accent-color:#f87171;width:11px;height:11px;';
      cb.addEventListener('change', function() {
        if (cb.checked) _selected.add(lbl.id); else _selected.delete(lbl.id);
        renderChips();
        updateSelCount();
      });
      chip.appendChild(cb);
      chip.appendChild(document.createTextNode(escHtml(lbl.name)));
      chipsEl.appendChild(chip);
    });
  }

  async function openModal() {
    // reset state
    _labels = [];
    _selected = new Set();
    overlay.style.display    = 'flex';
    scanning.style.display   = 'block';
    chipsEl.style.display    = 'none';
    footer.style.display     = 'none';
    confirmBox.style.display = 'none';
    confirmDel.disabled      = false;
    confirmDel.textContent   = 'Yes, delete them';
    subText.textContent      = 'Scanning…';

    try {
      var resp = await sendMessage({ type: 'scanFlatLabels' });
      _labels = (resp && resp.result && resp.result.labels) || [];
    } catch (e) {
      _labels = [];
    }

    scanning.style.display = 'none';

    if (_labels.length === 0) {
      subText.textContent = 'No flat labels found — all clean! ✓';
      return;
    }

    // pre-select all by default
    _labels.forEach(function(l) { _selected.add(l.id); });
    subText.textContent = _labels.length + ' flat label' + (_labels.length === 1 ? '' : 's') + ' found';

    renderChips();
    updateSelCount();
    chipsEl.style.display  = 'flex';
    footer.style.display   = 'flex';
  }

  btn.addEventListener('click', safeExecute(openModal));
  closeBtn.addEventListener('click', function() { overlay.style.display = 'none'; });
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) overlay.style.display = 'none';
  });

  selAll.addEventListener('click', function() {
    var allSelected = _selected.size === _labels.length;
    _selected = allSelected ? new Set() : new Set(_labels.map(function(l) { return l.id; }));
    renderChips();
    updateSelCount();
  });

  // Step 1: show confirmation panel
  delBtn.addEventListener('click', function() {
    if (_selected.size === 0) return;
    var names = _labels
      .filter(function(l) { return _selected.has(l.id); })
      .map(function(l) { return '"' + l.name + '"'; });
    var preview = names.slice(0, 5).join(', ');
    if (names.length > 5) preview += ' and ' + (names.length - 5) + ' more';
    confirmMsg.textContent = 'You are about to permanently delete ' + _selected.size +
      ' label' + (_selected.size === 1 ? '' : 's') + ': ' + preview +
      '. Emails will not be deleted — only the labels will be removed from Gmail.';
    chipsEl.style.display   = 'none';
    footer.style.display    = 'none';
    confirmBox.style.display = 'block';
  });

  // Step 1b: cancel — go back to chip view
  cancelConfirm.addEventListener('click', function() {
    confirmBox.style.display = 'none';
    chipsEl.style.display    = 'flex';
    footer.style.display     = 'flex';
  });

  // Step 2: confirmed — delete then retroactively reassign emails
  confirmDel.addEventListener('click', safeExecute(async function() {
    confirmDel.disabled = true;
    confirmDel.textContent = '⏳ Deleting…';
    var ids = Array.from(_selected);
    try {
      var resp = await sendMessage({ type: 'deleteLabels', labelIds: ids });
      var deleted = (resp && resp.result && resp.result.deleted) || 0;

      // Show progress — now reassign emails to consolidated labels
      confirmDel.textContent = '🔄 Reassigning emails…';
      setStatus('✓ Deleted ' + deleted + ' label' + (deleted === 1 ? '' : 's') + '. Reassigning past emails to new labels…');

      try {
        // Run both retroactive passes so emails land in the right consolidated labels
        await sendMessage({ type: 'retroactiveLabel', options: { maxPerRule: 500, dryRun: false } });
        await sendMessage({ type: 'retroactiveCatLabels', options: { maxPerCat: 300 } });
        setStatus('✅ Done — old labels removed and emails reassigned to your new label structure.');
      } catch (_) {
        setStatus('✓ Labels deleted. Run Organize from the dashboard to reassign past emails.');
      }

      overlay.style.display = 'none';
      if (badge) badge.style.display = 'none';
    } catch (e) {
      setStatus('Error deleting labels: ' + formatError(e));
      overlay.style.display = 'none';
    }
  }));

  // Run a background scan on load to show badge count (non-blocking)
  (async function() {
    try {
      var resp = await sendMessage({ type: 'scanFlatLabels' });
      var count = ((resp && resp.result && resp.result.labels) || []).length;
      if (count > 0 && badge) {
        badge.textContent = count;
        badge.style.display = 'inline-block';
      }
    } catch (_) {}
  })();
}());
