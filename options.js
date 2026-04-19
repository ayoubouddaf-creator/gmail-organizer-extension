// ══════════════════════════════════════════════════════════════════════════════
// Gmail Organizer v0.9.0 - Options Script
// Enhanced with: priority inbox, feature flags for snooze/summary, analytics, AI rules
// ══════════════════════════════════════════════════════════════════════════════

// ── Dark / Light theme toggle (must run early, before other DOM queries) ──────
(function initTheme() {
  const THEME_KEY = 'go_theme';
  const saved = (() => { try { return localStorage.getItem(THEME_KEY); } catch(e) { return null; } })();
  const theme = saved || 'dark';
  document.documentElement.setAttribute('data-theme', theme);

  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_KEY, t); } catch(e) {}
    const btn = document.getElementById('themeToggleBtn');
    if (btn) btn.textContent = t === 'dark' ? '☀️' : '🌙';
  }

  // Wire the button once DOM is ready (module scripts run after parsing)
  const btn = document.getElementById('themeToggleBtn');
  if (btn) {
    btn.textContent = theme === 'dark' ? '☀️' : '🌙';
    btn.addEventListener('click', function() {
      const cur = document.documentElement.getAttribute('data-theme') || 'dark';
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    });
  }
})();

const maxThreadsInput = document.getElementById("maxThreadsPerRun");
const archiveMatchesInput = document.getElementById("archiveMatches");
const autoRunEnabledInput = document.getElementById("autoRunEnabled");
const autoRunIntervalInput = document.getElementById("autoRunIntervalMinutes");
const aiProviderInput = document.getElementById("aiProvider");
const geminiModelInput = document.getElementById("geminiModel");
const geminiApiKeyInput = document.getElementById("geminiApiKey");
const aiInstructionsInput = document.getElementById("aiInstructions");
const aiSuggestionStatus = document.getElementById("aiSuggestionStatus");
const aiInstructionsHint = document.getElementById("aiInstructionsHint");
const dailyRoutineInstructionsInput = document.getElementById("dailyRoutineInstructions");
const scheduleStatus = document.getElementById("scheduleStatus");
const saveStatus = document.getElementById("saveStatus");
const rulesList = document.getElementById("rulesList");
const presetsList = document.getElementById("presetsList");
const generatedRulesNotice = document.getElementById("generatedRulesNotice");
const historyList = document.getElementById("historyList");
const ruleTemplate = document.getElementById("ruleTemplate");
const importFileInput = document.getElementById("importFileInput");
const autoEmptyTrashEnabledInput = document.getElementById("autoEmptyTrashEnabled");
const dailyDigestEnabledInput = document.getElementById("dailyDigestEnabled");
const autoEmptyTrashIntervalInput = document.getElementById("autoEmptyTrashIntervalMinutes");
const autoEmptyTrashOlderThanDaysInput = document.getElementById("autoEmptyTrashOlderThanDays");
const trashScheduleStatus = document.getElementById("trashScheduleStatus");
const configWarning = document.getElementById("configWarning");

// Feature flags
const ffBatchModifyInput = document.getElementById("ffBatchModify");
const ffQuotaTrackingInput = document.getElementById("ffQuotaTracking");
const ffCacheLabelsInput = document.getElementById("ffCacheLabels");
const ffDebouncedAutoRunInput = document.getElementById("ffDebouncedAutoRun");
const ffAutoResumeInput = document.getElementById("ffAutoResume");
const ffStrictMinIntervalInput = document.getElementById("ffStrictMinInterval");
const ffIncrementalSyncInput = document.getElementById("ffIncrementalSync");
const ffSnoozeInput = document.getElementById("ffSnooze");
const ffThreadSummaryInput = document.getElementById("ffThreadSummary");
const ffPriorityInboxInput = document.getElementById("ffPriorityInbox");

// Telemetry
const errorTelemetryEnabledInput = document.getElementById("errorTelemetryEnabled");
const viewTelemetryBtn = document.getElementById("viewTelemetryBtn");
const clearTelemetryBtn = document.getElementById("clearTelemetryBtn");
const telemetryDisplay = document.getElementById("telemetryDisplay");

let availablePresets = [];

// ── Friendly Error Formatting ──────────────────────────────────────────────
function formatError(err) {
  if (!err) return "An unknown error occurred.";
  if (err.message === 'PRO_REQUIRED') return '🔒 This feature requires a Pro plan.';
  if (err.message === 'UPGRADE_REQUIRED') return '🔒 Upgrade required to continue.';
  const status = err.status || (err.response && err.response.status);
  if (status === 401) return "Your Gmail session has expired. Please re-authorize in settings.";
  if (status === 403) return (err.message && /quota|rate/i.test(err.message)) ? "Gmail API quota reached. The extension will resume automatically tomorrow." : "Gmail denied access. Please re-authorize with required permissions.";
  if (status === 429) return "Gmail is rate limiting requests. Waiting and retrying...";
  if (status >= 500) return "Gmail is temporarily unavailable. We will retry in a few minutes.";
  if (status === 404) return "The email or label was not found. It may have been moved or deleted.";
  if (status === 0 || !status) return "No internet connection. Please check your network.";
  return err.message || "An error occurred.";
}

// ── Error Boundary Wrapper ────────────────────────────────────────────────
function safeExecute(asyncFn, errorMessage = "An error occurred") {
  return async (...args) => {
    try {
      return await asyncFn(...args);
    } catch (error) {
      console.error(errorMessage, error);
      setStatus(`Error: ${formatError(error)}`);
    }
  };
}

// ── Bell / Notifications button ───────────────────────────────────────────
(function initBell() {
  const bellBtn    = document.getElementById('brandBellBtn');
  const bellPopup  = document.getElementById('bellPopup');
  const bellUnread = document.getElementById('bellUnread');
  const bellScore  = document.getElementById('bellScore');
  const bellOrg    = document.getElementById('bellOrganized');
  if (!bellBtn || !bellPopup) return;

  let popupOpen = false;

  function positionPopup() {
    const rect = bellBtn.getBoundingClientRect();
    bellPopup.style.top  = (rect.bottom + 8) + 'px';
    bellPopup.style.left = rect.left + 'px';
  }

  function openPopup() {
    popupOpen = true;
    positionPopup();
    bellPopup.classList.add('visible');
    // Show loading state
    if (bellUnread)    bellUnread.textContent    = '…';
    if (bellScore)     bellScore.textContent     = '…';
    if (bellOrg)       bellOrg.textContent       = '…';

    // Fetch unread count
    chrome.runtime.sendMessage({ action: 'getUnreadCount' }, (res) => {
      if (bellUnread) bellUnread.textContent = (res && res.count != null) ? res.count : '—';
    });
    // Fetch inbox score
    chrome.runtime.sendMessage({ action: 'getInboxScore' }, (res) => {
      if (bellScore) bellScore.textContent = (res && res.result && res.result.score != null) ? res.result.score : '—';
    });
    // Fetch analytics for today's organized count
    chrome.runtime.sendMessage({ action: 'getAnalytics' }, (res) => {
      if (bellOrg) {
        const today = new Date().toISOString().slice(0, 10);
        const daily = res && res.result && (res.result.dailyVolume || res.result.dailyTrend);
        const todayEntry = Array.isArray(daily) ? daily.find(d => d.date === today) : null;
        bellOrg.textContent = todayEntry ? (todayEntry.organized || 0) : '0';
      }
    });
  }

  function closePopup() {
    popupOpen = false;
    bellPopup.classList.remove('visible');
  }

  bellBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    popupOpen ? closePopup() : openPopup();
  });
  bellBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bellBtn.click(); }
    if (e.key === 'Escape') closePopup();
  });
  // Close when clicking outside
  document.addEventListener('click', (e) => {
    if (popupOpen && !bellBtn.contains(e.target)) closePopup();
  });
})();

// ── Event Listeners ───────────────────────────────────────────────────────
document.getElementById("saveButton").addEventListener("click", safeExecute(() => saveSettings()));
document.getElementById("addRuleButton").addEventListener("click", () => {
  try {
    appendRuleCard(createEmptyRule());
    setStatus("New rule added. Fill in the details and save when ready.");
  } catch (error) {
    console.error("Add rule error:", error);
    setStatus("Could not add rule.");
  }
});
document.getElementById("clearRulesButton").addEventListener("click", async () => {
  try {
    await renderRules([createEmptyRule()]);
    setStatus("Rules cleared. Add a new rule or choose a preset.");
  } catch (error) {
    console.error("Clear rules error:", error);
  }
});
document.getElementById("loadRecommendedButton").addEventListener("click", safeExecute(() => loadRecommendedPresets()));
document.getElementById("generateAiRulesButton").addEventListener("click", safeExecute(() => generateRulesFromInstructions(false)));
document.getElementById("appendAiRulesButton").addEventListener("click", safeExecute(() => generateRulesFromInstructions(true)));
document.getElementById("markOnboardingButton").addEventListener("click", safeExecute(() => completeOnboarding()));
document.getElementById("clearHistoryButton").addEventListener("click", safeExecute(() => clearHistory()));
document.getElementById("exportSettingsButton").addEventListener("click", safeExecute(() => exportSettings()));
document.getElementById("importSettingsButton").addEventListener("click", () => {
  try {
    importFileInput.click();
  } catch (error) {
    console.error("Import click error:", error);
  }
});
autoRunEnabledInput.addEventListener("change", updateScheduleInputs);
autoEmptyTrashEnabledInput.addEventListener("change", updateTrashScheduleInputs);
aiProviderInput.addEventListener("change", updateAiProviderInputs);
importFileInput.addEventListener("change", safeExecute((e) => importSettingsFromFile(e)));

// Feature flags
if (ffBatchModifyInput) ffBatchModifyInput.addEventListener("change", saveFeatureFlags);
if (ffQuotaTrackingInput) ffQuotaTrackingInput.addEventListener("change", saveFeatureFlags);
if (ffCacheLabelsInput) ffCacheLabelsInput.addEventListener("change", saveFeatureFlags);
if (ffDebouncedAutoRunInput) ffDebouncedAutoRunInput.addEventListener("change", handleDebouncedAutoRunChange);
if (ffAutoResumeInput) ffAutoResumeInput.addEventListener("change", saveFeatureFlags);
if (ffStrictMinIntervalInput) ffStrictMinIntervalInput.addEventListener("change", saveFeatureFlags);
if (ffIncrementalSyncInput) ffIncrementalSyncInput.addEventListener("change", saveFeatureFlags);
if (ffSnoozeInput) ffSnoozeInput.addEventListener("change", saveFeatureFlags);
if (ffThreadSummaryInput) ffThreadSummaryInput.addEventListener("change", saveFeatureFlags);
if (ffPriorityInboxInput) ffPriorityInboxInput.addEventListener("change", saveFeatureFlags);

// Telemetry
if (errorTelemetryEnabledInput) errorTelemetryEnabledInput.addEventListener("change", saveTelemetrySetting);
if (viewTelemetryBtn) viewTelemetryBtn.addEventListener("click", safeExecute(() => displayTelemetryBuffer()));
if (clearTelemetryBtn) clearTelemetryBtn.addEventListener("click", safeExecute(() => clearTelemetryBuffer()));

// Email support button — mailto: links are blocked in extension pages, use chrome.tabs
const emailSupportBtn = document.getElementById("emailSupportBtn");
if (emailSupportBtn) {
  emailSupportBtn.addEventListener("click", function() {
    chrome.tabs.create({ url: "https://mail.google.com/mail/?view=cm&to=ayoub.ouddaf%40gmail.com&su=Gmail%20Organizer%20Support" });
  });
}

// Initialize
initialize();

// ── Main Functions ────────────────────────────────────────────────────────

async function initialize() {
  try {
    renderConfigWarning();
    await Promise.all([loadDashboard(), loadPresets()]);
  } catch (error) {
    console.error("Initialize error:", error);
    setStatus(error.message || "Failed to initialize.");
  }
}

// ── Storage Reactivity ────────────────────────────────────────────────────
let storageUpdateTimeout;
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync') {
    clearTimeout(storageUpdateTimeout);
    storageUpdateTimeout = setTimeout(() => {
      if (changes.rules || changes.runHistory || changes.settings) {
        initialize();
      }
    }, 200);
  }
});

async function loadDashboard() {
  try {
    const response = await sendMessage({ type: "getDashboard" });
    hydrateSettings(response.settings);
    renderHistory(response.history || []);
    updateScheduleStatus(response.schedule);
    checkStorageQuota();
    displayTimezone();
    setStatus("Settings loaded.");
  } catch (error) {
    console.error("Load dashboard error:", error);
    setStatus(error.message || "Failed to load settings.");
  }
}

async function loadPresets() {
  try {
    const response = await sendMessage({ type: "getPresets" });
    availablePresets = Array.isArray(response.presets) ? response.presets : [];
    renderPresets(availablePresets);
  } catch (error) {
    console.error("Load presets error:", error);
    setStatus(error.message || "Failed to load presets.");
  }
}

async function saveSettings() {
  try {
    setStatus("Saving settings...");

    // Validate maxThreadsPerRun before sending
    const maxThreadsVal = Number(maxThreadsInput.value);
    if (isNaN(maxThreadsVal) || maxThreadsVal < 1 || maxThreadsVal > 500) {
      setStatus("Max threads must be a number between 1 and 500.");
      maxThreadsInput.focus();
      return;
    }

    // Check for rule conflicts BEFORE saving
    await checkAndShowConflicts();

    const rules = collectRules();
    const response = await sendMessage({
      type: "saveSettings",
      settings: {
        maxThreadsPerRun: maxThreadsVal,
        archiveMatches: archiveMatchesInput.checked,
        onboardingComplete: true,
        autoRunEnabled: autoRunEnabledInput.checked,
        autoRunIntervalMinutes: Number(autoRunIntervalInput.value),
        aiProvider: aiProviderInput.value,
        geminiModel: geminiModelInput.value.trim(),
        geminiApiKey: geminiApiKeyInput.value.trim(),
        aiInstructions: aiInstructionsInput.value.trim(),
        dailyRoutineInstructions: dailyRoutineInstructionsInput.value.trim(),
        autoEmptyTrashEnabled: autoEmptyTrashEnabledInput.checked,
        autoEmptyTrashIntervalMinutes: Number(autoEmptyTrashIntervalInput.value),
        autoEmptyTrashOlderThanDays: Number(autoEmptyTrashOlderThanDaysInput.value),
        dailyDigestEnabled: dailyDigestEnabledInput ? dailyDigestEnabledInput.checked : true,
        rules
      }
    });

    updateScheduleStatus(response.schedule);
    setStatus("Settings saved.");
  } catch (error) {
    console.error("Save settings error:", error);
    if (typeof error?.ruleIndex === "number") {
      focusInvalidRule(error.ruleIndex, error.fieldSelector);
    }
    setStatus(error.message || "Could not save settings.");
  }
}

async function loadRecommendedPresets() {
  try {
    if (availablePresets.length === 0) {
      setStatus("No presets are available yet.");
      return;
    }

    await renderRules(availablePresets.map(cloneRule));
    const check = document.getElementById("step1Check");
    if (check) check.textContent = "✓";
    setStatus("Recommended presets loaded. Review the labels and save when ready.");
  } catch (error) {
    console.error("Load presets error:", error);
    setStatus(error.message || "Could not load presets.");
  }
}

async function completeOnboarding() {
  try {
    await sendMessage({ type: "completeOnboarding" });
    setStatus("Setup marked complete. You can always come back and edit rules.");
  } catch (error) {
    console.error("Complete onboarding error:", error);
    setStatus(error.message || "Could not update setup status.");
  }
}

async function clearHistory() {
  try {
    const response = await sendMessage({ type: "clearHistory" });
    renderHistory(response.history || []);
    setStatus("History cleared.");
  } catch (error) {
    console.error("Clear history error:", error);
    setStatus(error.message || "Could not clear history.");
  }
}

async function undoRun(runId) {
  try {
    const response = await sendMessage({ type: "undoRun", runId });
    await loadDashboard();
    setStatus(`Undid ${response.result.matchedThreads} thread(s) from that run.`);
  } catch (error) {
    console.error("Undo run error:", error);
    setStatus(error.message || "Could not undo that run.");
  }
}

async function exportSettings() {
  try {
    const response = await sendMessage({ type: "exportSettings" });
    const content = JSON.stringify(response.data, null, 2);
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    anchor.href = url;
    anchor.download = `gmail-organizer-backup-${stamp}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus("Setup exported.");
  } catch (error) {
    console.error("Export settings error:", error);
    setStatus(error.message || "Could not export settings.");
  }
}

async function importSettingsFromFile(event) {
  try {
    const [file] = event.target.files || [];
    if (!file) {
      return;
    }

    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || !data.settings || !Array.isArray(data.settings.rules)) {
      throw new Error("Invalid format: file must contain settings with rules.");
    }
    await sendMessage({ type: "importSettings", data });
    await loadDashboard();
    setStatus("Setup imported.");
  } catch (error) {
    console.error("Import settings error:", error);
    setStatus(error.message || "Could not import settings.");
  } finally {
    importFileInput.value = "";
  }
}

async function hydrateSettings(settings) {
  try {
    if (maxThreadsInput)              maxThreadsInput.value              = settings.maxThreadsPerRun;
    if (archiveMatchesInput)          archiveMatchesInput.checked        = settings.archiveMatches;
    if (autoRunEnabledInput)          autoRunEnabledInput.checked        = Boolean(settings.autoRunEnabled);
    if (autoRunIntervalInput)         autoRunIntervalInput.value         = String(settings.autoRunIntervalMinutes || 60);
    if (aiProviderInput)              aiProviderInput.value              = settings.aiProvider || "gemini";
    if (geminiModelInput)             geminiModelInput.value             = settings.geminiModel || "gemini-2.0-flash-lite";
    if (geminiApiKeyInput)            geminiApiKeyInput.value            = settings.geminiApiKey || "";
    if (aiInstructionsInput)          aiInstructionsInput.value          = settings.aiInstructions || "";
    if (dailyRoutineInstructionsInput) dailyRoutineInstructionsInput.value = settings.dailyRoutineInstructions || "";
    if (autoEmptyTrashEnabledInput)   autoEmptyTrashEnabledInput.checked = Boolean(settings.autoEmptyTrashEnabled);
    if (autoEmptyTrashIntervalInput)  autoEmptyTrashIntervalInput.value  = String(settings.autoEmptyTrashIntervalMinutes || 10080);
    if (autoEmptyTrashOlderThanDaysInput) autoEmptyTrashOlderThanDaysInput.value = String(settings.autoEmptyTrashOlderThanDays ?? 30);
    if (errorTelemetryEnabledInput)   errorTelemetryEnabledInput.checked = Boolean(settings.errorTelemetryEnabled);
    if (dailyDigestEnabledInput)      dailyDigestEnabledInput.checked    = settings.dailyDigestEnabled !== false;
    await renderRules(settings.rules);
    updateScheduleInputs();
    updateTrashScheduleInputs();
    updateAiProviderInputs();
    hydrateFeatureFlags(settings.featureFlags || {});
  } catch (error) {
    console.error("Hydrate settings error:", error);
  } finally {
    // Always fire — chat panel needs this to show/hide setup screen regardless of errors
    document.dispatchEvent(new CustomEvent('settingsLoaded'));
  }
}

// Load feature flags from storage
function hydrateFeatureFlags(flags) {
  if (ffBatchModifyInput) ffBatchModifyInput.checked = Boolean(flags.ff_batchModify);
  if (ffQuotaTrackingInput) ffQuotaTrackingInput.checked = Boolean(flags.ff_quotaTracking);
  if (ffCacheLabelsInput) ffCacheLabelsInput.checked = Boolean(flags.ff_cacheLabels);
  if (ffDebouncedAutoRunInput) ffDebouncedAutoRunInput.checked = Boolean(flags.ff_debouncedAutoRun);
  if (ffAutoResumeInput) ffAutoResumeInput.checked = Boolean(flags.ff_autoResume);
  if (ffStrictMinIntervalInput) ffStrictMinIntervalInput.checked = Boolean(flags.ff_strictMinInterval);
  if (ffIncrementalSyncInput) ffIncrementalSyncInput.checked = Boolean(flags.ff_incrementalSync);
  if (ffSnoozeInput) ffSnoozeInput.checked = Boolean(flags.ff_snooze);
  if (ffThreadSummaryInput) ffThreadSummaryInput.checked = Boolean(flags.ff_threadSummary);
  if (ffPriorityInboxInput) ffPriorityInboxInput.checked = Boolean(flags.ff_priorityInbox);
}

function renderConfigWarning() {
  if (configWarning) configWarning.hidden = isOAuthConfigured();
}

function updateScheduleInputs() {
  autoRunIntervalInput.disabled = false;
}

function updateTrashScheduleInputs() {
  try {
    const enabled = autoEmptyTrashEnabledInput.checked;
    autoEmptyTrashIntervalInput.disabled = !enabled;
    autoEmptyTrashOlderThanDaysInput.disabled = !enabled;
    const fields = document.getElementById('trashIntervalFields');
    if (fields) fields.style.opacity = enabled ? '1' : '0.4';
    trashScheduleStatus.textContent = enabled ? "Auto-empty trash is enabled. Save settings to apply." : "Auto-empty trash is off.";
  } catch (error) {
    console.error("Update trash schedule error:", error);
  }
}

function updateAiProviderInputs() {
  try {
    const usingGemini = aiProviderInput.value === "gemini";
    geminiModelInput.disabled = !usingGemini;
    // API key is always enabled — it's used by the Chat feature regardless of provider
    geminiApiKeyInput.disabled = false;
    aiInstructionsHint.textContent = usingGemini
      ? "Gemini Flash will turn your instructions into Gmail rules using the Google Gemini API."
      : "The built-in generator creates local suggestions without calling an external AI API. Your Gemini API key is still used by the Chat tab.";
  } catch (error) {
    console.error("Update AI provider error:", error);
  }
}

function updateScheduleStatus(schedule) {
  try {
    if (!schedule?.enabled) {
      scheduleStatus.textContent = "Auto-run is off.";
      return;
    }

    const nextRun = schedule.nextRunAt ? formatDateTime(schedule.nextRunAt) : "soon";
    scheduleStatus.textContent = `Auto-run is on every ${formatInterval(schedule.intervalMinutes)}. Next run: ${nextRun}.`;
  } catch (error) {
    console.error("Update schedule status error:", error);
  }
}

function setStatus(message) {
  saveStatus.textContent = message;
}

function renderHistory(history) {
  try {
    historyList.innerHTML = "";

    if (!Array.isArray(history) || history.length === 0) {
      const li = document.createElement("li");
      li.className = "history-item";
      li.textContent = "No organization runs yet.";
      historyList.appendChild(li);
      return;
    }

    for (const entry of history) {
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

      const meta = document.createElement("p");
      meta.className = "history-meta";
      meta.textContent = "Scanned " + Number(entry.scannedThreads || 0) + " • Matched " + Number(entry.matchedThreads || 0) + " • Status " + (entry.status || "unknown");
      li.appendChild(meta);

      if (entry.undoable) {
        const button = document.createElement("button");
        button.className = "button secondary history-action";
        button.type = "button";
        button.textContent = "Undo this run";
        button.addEventListener("click", safeExecute(() => undoRun(entry.id)));
        li.appendChild(button);
      }

      historyList.appendChild(li);
    }
  } catch (error) {
    console.error("Render history error:", error);
  }
}

async function renderRules(rules) {
  try {
    rulesList.innerHTML = "";

    if (!Array.isArray(rules) || rules.length === 0) {
      setGeneratedRulesNotice("");
      appendRuleCard(createEmptyRule(), []);
      return;
    }

    setGeneratedRulesNotice("");

    // Fetch conflicts to display badges
    let conflicts = [];
    try {
      const r = await sendMessage({ type: 'detectConflicts' });
      conflicts = r.result || [];
    } catch (e) {
      console.error("Could not fetch conflicts:", e);
    }

    // Build rules into a DocumentFragment before appending
    const fragment = document.createDocumentFragment();
    for (const rule of rules) {
      buildRuleCard(rule, conflicts, fragment);
    }
    rulesList.appendChild(fragment);
  } catch (error) {
    console.error("Render rules error:", error);
  }
}

function renderPresets(presets) {
  try {
    presetsList.innerHTML = "";

    for (const preset of presets) {
      const card = document.createElement("article");
      card.className = "preset-card";

      const section = document.createElement("p");
      section.className = "section-label";
      section.textContent = "Preset";

      const title = document.createElement("h3");
      title.textContent = preset.name;

      const label = document.createElement("p");
      label.className = "preset-label";
      label.textContent = preset.label;

      const copy = document.createElement("p");
      copy.className = "preset-copy";
      copy.textContent = preset.description || "";

      const button = document.createElement("button");
      button.className = "button secondary";
      button.type = "button";
      button.textContent = "Add preset";
      button.addEventListener("click", () => {
        try {
          appendRuleCard(cloneRule(preset), []);
          setStatus(`✅ "${preset.name}" added — scroll down to see it, then click Save settings.`);
          // Highlight the save button so user knows to save
          const saveBtn = document.getElementById("saveButton");
          if (saveBtn) {
            saveBtn.style.transition = "box-shadow 0.3s";
            saveBtn.style.boxShadow = "0 0 0 3px var(--accent, #4f8ef7)";
            setTimeout(() => { saveBtn.style.boxShadow = ""; }, 2000);
          }
          button.textContent = "✓ Added";
          button.disabled = true;
          setTimeout(() => { button.textContent = "Add preset"; button.disabled = false; }, 2000);
        } catch (error) {
          console.error("Add preset error:", error);
        }
      });

      card.append(section, title, label, copy, button);
      presetsList.appendChild(card);
    }
  } catch (error) {
    console.error("Render presets error:", error);
  }
}

// Build rule card into a DocumentFragment (for batch rendering)
function buildRuleCard(rule, conflicts, parentFragment) {
  try {
    conflicts = conflicts || [];
    const fragment = ruleTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".rule-card");
    const heading = fragment.querySelector(".rule-heading");
    const ruleTop = fragment.querySelector(".rule-top");
    const nameInput = fragment.querySelector(".rule-name");
    const labelInput = fragment.querySelector(".rule-label");
    const fromDomainsInput = fragment.querySelector(".rule-from-domains");
    const fromIncludesInput = fragment.querySelector(".rule-from-includes");
    const subjectIncludesInput = fragment.querySelector(".rule-subject-includes");
    const actionInput = fragment.querySelector(".rule-action");
    const removeButton = fragment.querySelector(".remove-rule-button");

    const hasAttachmentInput = fragment.querySelector(".rule-has-attachment");

    nameInput.value = rule.name || "";
    labelInput.value = rule.label || "";
    fromDomainsInput.value = listToInput(rule.match?.fromDomains);
    fromIncludesInput.value = listToInput(rule.match?.fromIncludes);
    subjectIncludesInput.value = listToInput(rule.match?.subjectIncludes);
    actionInput.value = rule.action || (rule.archive ? "archive" : "label");
    if (hasAttachmentInput) hasAttachmentInput.checked = !!(rule.match?.hasAttachment);

    // Wire up color swatches
    const colorInput = fragment.querySelector(".rule-color");
    const swatches = fragment.querySelectorAll(".swatch");
    const ruleColor = rule.color || "";
    if (colorInput) colorInput.value = ruleColor;
    swatches.forEach(sw => {
      if (sw.dataset.color === ruleColor) sw.classList.add("selected");
      sw.addEventListener("click", () => {
        swatches.forEach(s => s.classList.remove("selected"));
        sw.classList.add("selected");
        if (colorInput) colorInput.value = sw.dataset.color;
      });
    });
    heading.textContent = rule.name || rule.label || "New rule";

    // Add conflict badge if this rule conflicts with others
    const ruleConflicts = conflicts.filter(c => (c.ruleA?.id === rule.id || c.ruleB?.id === rule.id));
    if (ruleConflicts.length > 0 && ruleTop) {
      const badge = document.createElement('span');
      badge.className = 'conflict-badge';
      badge.textContent = '⚠';
      const conflictNames = ruleConflicts.map(c => c.ruleA?.id === rule.id ? c.ruleB?.name : c.ruleA?.name).join(', ');
      badge.title = 'Conflicts with: ' + conflictNames;
      badge.style.cssText = 'display:inline-block;width:20px;height:20px;border-radius:50%;background:var(--red);color:#fff;font-size:12px;display:flex;align-items:center;justify-content:center;font-weight:700;cursor:help;flex-shrink:0;';
      ruleTop.insertBefore(badge, removeButton);
    }

    const syncHeading = () => {
      heading.textContent = nameInput.value.trim() || labelInput.value.trim() || "New rule";
    };
    const clearValidation = () => card.classList.remove("rule-card-invalid");

    nameInput.addEventListener("input", syncHeading);
    labelInput.addEventListener("input", syncHeading);
    nameInput.addEventListener("input", clearValidation);
    labelInput.addEventListener("input", clearValidation);
    fromDomainsInput.addEventListener("input", clearValidation);
    fromIncludesInput.addEventListener("input", clearValidation);
    subjectIncludesInput.addEventListener("input", clearValidation);
    actionInput.addEventListener("change", clearValidation);
    removeButton.addEventListener("click", () => {
      try {
        card.remove();
        ensureAtLeastOneRule();
        setStatus("Rule removed.");
      } catch (error) {
        console.error("Remove rule error:", error);
      }
    });

    parentFragment.appendChild(fragment);
  } catch (error) {
    console.error("Build rule card error:", error);
  }
}

function appendRuleCard(rule, conflicts) {
  try {
    const fragment = document.createDocumentFragment();
    buildRuleCard(rule, conflicts, fragment);
    rulesList.appendChild(fragment);
    // Scroll the newly added card into view
    const newCard = rulesList.lastElementChild;
    if (newCard) {
      newCard.scrollIntoView({ behavior: "smooth", block: "center" });
      newCard.style.transition = "box-shadow 0.4s";
      newCard.style.boxShadow = "0 0 0 2px var(--accent, #4f8ef7)";
      setTimeout(() => { newCard.style.boxShadow = ""; }, 1500);
    }
  } catch (error) {
    console.error("Append rule card error:", error);
  }
}

function ensureAtLeastOneRule() {
  if (rulesList.children.length === 0) {
    appendRuleCard(createEmptyRule());
  }
}

// ── Input Validation for Rule Creation ────────────────────────────────────
function collectRules() {
  try {
    const cards = Array.from(rulesList.querySelectorAll(".rule-card"));
    clearRuleValidationState();
    const rules = [];
    const seenRuleNames = new Set();

    for (let index = 0; index < cards.length; index++) {
      const card = cards[index];
      const name = card.querySelector(".rule-name").value.trim();
      const label = card.querySelector(".rule-label").value.trim();
      const fromDomains = parseList(card.querySelector(".rule-from-domains").value);
      const fromIncludes = parseList(card.querySelector(".rule-from-includes").value);
      const subjectIncludes = parseList(card.querySelector(".rule-subject-includes").value);
      const hasAttachment = !!(card.querySelector(".rule-has-attachment")?.checked);
      const action = card.querySelector(".rule-action").value;
      const color = card.querySelector(".rule-color")?.value || null;

      // Validation: Label cannot be empty
      if (!label) {
        throw createRuleValidationError(`Rule ${index + 1} needs a Gmail label.`, index, ".rule-label");
      }

      // Validation: Duplicate rule names (within same save)
      if (name && seenRuleNames.has(name.toLowerCase())) {
        throw createRuleValidationError(`Rule ${index + 1}: "${name}" is a duplicate rule name. Each rule must have a unique name.`, index, ".rule-name");
      }
      if (name) {
        seenRuleNames.add(name.toLowerCase());
      }

      // Note: multiple rules sharing the same label is valid — no duplicate label check

      if (usesReservedGmailLabelRoot(label)) {
        throw createRuleValidationError(
          `Rule ${index + 1} uses a reserved Gmail system label root. Rename "${label}" to something like "Promotions/Trash" instead of "Trash/...".`,
          index,
          ".rule-label"
        );
      }

      if (fromDomains.length === 0 && fromIncludes.length === 0 && subjectIncludes.length === 0) {
        throw createRuleValidationError(`Rule ${index + 1} needs at least one matching condition.`, index, ".rule-from-domains");
      }

      const matchObj = { fromDomains, fromIncludes, subjectIncludes };
      if (hasAttachment) matchObj.hasAttachment = true;
      rules.push({
        id: slugify(name || label || `rule-${index + 1}`),
        name: name || label,
        label,
        archive: action === "archive",
        action,
        color,
        match: matchObj
      });
    }

    if (rules.length === 0) {
      throw new Error("Add at least one rule before saving.");
    }

    return rules;
  } catch (error) {
    throw error;
  }
}

function parseList(value) {
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function usesReservedGmailLabelRoot(label) {
  const reservedRoots = ["inbox", "trash", "spam", "sent", "drafts", "important", "starred", "chats", "all mail", "scheduled", "snoozed", "bin"];
  const root = String(label || "").split("/")[0].trim().toLowerCase();
  return reservedRoots.includes(root);
}

function createRuleValidationError(message, ruleIndex, fieldSelector) {
  const error = new Error(message);
  error.ruleIndex = ruleIndex;
  error.fieldSelector = fieldSelector;
  return error;
}

function clearRuleValidationState() {
  Array.from(rulesList.querySelectorAll(".rule-card")).forEach((card) => {
    card.classList.remove("rule-card-invalid");
  });
}

function focusInvalidRule(ruleIndex, fieldSelector) {
  try {
    const cards = Array.from(rulesList.querySelectorAll(".rule-card"));
    const card = cards[ruleIndex];
    if (!card) return;

    clearRuleValidationState();
    card.classList.add("rule-card-invalid");
    card.scrollIntoView({ behavior: "smooth", block: "center" });

    const field = fieldSelector ? card.querySelector(fieldSelector) : null;
    if (field && typeof field.focus === "function") {
      field.focus({ preventScroll: true });
      if (typeof field.select === "function" && !field.value) {
        field.select();
      }
    }
  } catch (error) {
    console.error("Focus invalid rule error:", error);
  }
}

function listToInput(items) {
  return Array.isArray(items) ? items.join(", ") : "";
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "rule";
}

function createEmptyRule() {
  return {
    id: "",
    name: "",
    label: "",
    archive: false,
    action: "label",
    color: "",
    match: {
      fromDomains: [],
      fromIncludes: [],
      subjectIncludes: []
    }
  };
}

function setAiSuggestionStatus(message) {
  aiSuggestionStatus.textContent = message;
}

async function generateRulesFromInstructions(mergeWithExisting) {
  try {
    const instructions = aiInstructionsInput.value.trim();
    if (!instructions) {
      setAiSuggestionStatus("Add a few plain-language instructions first.");
      return;
    }

    setAiSuggestionStatus(aiProviderInput.value === "gemini" ? "Generating rules with Gemini Flash..." : "Generating local suggestions...");

    const response = await sendMessage({
      type: "generateAiRules",
      instructions,
      provider: aiProviderInput.value,
      model: geminiModelInput.value.trim()
    });

    const generatedRules = Array.isArray(response.rules) ? response.rules : [];
    if (generatedRules.length === 0) {
      setAiSuggestionStatus("No clear rule suggestions were found. Try using words like work, newsletters, banking, promotions, archive, or trash.");
      return;
    }

    const existingRules = mergeWithExisting ? collectRulesFromDom() : [];
    const nextRules = mergeSuggestedRules(existingRules, generatedRules);
    await renderRules(nextRules);
    setGeneratedRulesNotice(`${generatedRules.length} AI-suggested rule(s) are now loaded below in the Rules section.`);
    revealGeneratedRules();
    const sourceNote = response.providerUsed === "gemini" ? "Gemini Flash" : "the built-in generator";
    setAiSuggestionStatus(`${generatedRules.length} suggestion(s) generated with ${sourceNote}. Review the rules below, then click Save settings.`);
    setStatus(mergeWithExisting ? "AI suggestions merged into your current rules." : "AI suggestions loaded into the rule builder.");
  } catch (error) {
    console.error("Generate AI rules error:", error);
    setAiSuggestionStatus(error.message || "Could not generate AI suggestions.");
  }
}

function collectRulesFromDom() {
  try {
    const cards = Array.from(rulesList.querySelectorAll(".rule-card"));
    return cards.map((card, index) => {
      const name = card.querySelector(".rule-name").value.trim();
      const label = card.querySelector(".rule-label").value.trim();
      const action = card.querySelector(".rule-action").value;
      return {
        id: slugify(name || label || `rule-${index + 1}`),
        name: name || label,
        label,
        archive: action === "archive",
        action,
        color: card.querySelector(".rule-color")?.value || "",
        match: {
          fromDomains: parseList(card.querySelector(".rule-from-domains").value),
          fromIncludes: parseList(card.querySelector(".rule-from-includes").value),
          subjectIncludes: parseList(card.querySelector(".rule-subject-includes").value)
        }
      };
    }).filter((rule) => rule.label);
  } catch (error) {
    console.error("Collect rules from DOM error:", error);
    return [];
  }
}

function mergeSuggestedRules(existingRules, generatedRules) {
  const merged = new Map();
  for (const rule of existingRules) {
    merged.set(rule.label.toLowerCase(), cloneRule(rule));
  }
  for (const rule of generatedRules) {
    merged.set(rule.label.toLowerCase(), cloneRule(rule));
  }
  return Array.from(merged.values());
}

function revealGeneratedRules() {
  try {
    const builderSection = rulesList.closest(".builder");
    if (!builderSection) return;

    builderSection.classList.add("generated-rules-focus");
    builderSection.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => {
      builderSection.classList.remove("generated-rules-focus");
    }, 2200);
  } catch (error) {
    console.error("Reveal generated rules error:", error);
  }
}

function setGeneratedRulesNotice(message) {
  if (!generatedRulesNotice) return;
  generatedRulesNotice.hidden = !message;
  generatedRulesNotice.textContent = message || "";
}

function cloneRule(rule) {
  return {
    ...rule,
    color: rule.color || "",
    match: {
      fromDomains: [...(rule.match?.fromDomains || [])],
      fromIncludes: [...(rule.match?.fromIncludes || [])],
      subjectIncludes: [...(rule.match?.subjectIncludes || [])]
    }
  };
}

function formatDateTime(value) {
  if (!value) {
    return "Unknown";
  }
  return new Date(value).toLocaleString();
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
  if (source === "empty-trash") {
    return "Trash cleanup";
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

// ── Timezone Display ──────────────────────────────────────────────────────
async function displayTimezone() {
  try {
    const response = await sendMessage({ type: 'getCurrentTimeZone' });
    const tz = response.timeZone;
    const hint = document.getElementById('timezoneHint');
    if (hint && tz) {
      hint.textContent = `Times are in: ${tz}`;
    }
  } catch (error) {
    console.error("Get timezone error:", error);
  }
}

// ── Storage Quota Warning ─────────────────────────────────────────────────
async function checkStorageQuota() {
  try {
    const response = await sendMessage({ type: 'getStorageQuota' });
    const quotaInfo = response.rules;
    if (quotaInfo && quotaInfo.exceedsTotal) {
      const usagePercent = Math.round((quotaInfo.bytes / quotaInfo.totalLimit) * 100);
      const quotaWarning = document.getElementById('storageQuotaWarning');
      const quotaText = document.getElementById('quotaText');
      if (quotaWarning && quotaText) {
        quotaText.textContent = `You're using ${usagePercent}% of sync storage. Large rule sets may need to be moved to local storage.`;
        quotaWarning.style.display = 'block';
      }
    } else {
      const quotaWarning = document.getElementById('storageQuotaWarning');
      if (quotaWarning) quotaWarning.style.display = 'none';
    }
  } catch (error) {
    console.error("Check storage quota error:", error);
  }
}

// ── Feature Flags Management ───────────────────────────────────────────────
async function saveFeatureFlags() {
  try {
    const flags = {
      ff_batchModify: ffBatchModifyInput?.checked || false,
      ff_quotaTracking: ffQuotaTrackingInput?.checked || false,
      ff_cacheLabels: ffCacheLabelsInput?.checked || false,
      ff_debouncedAutoRun: ffDebouncedAutoRunInput?.checked || false,
      ff_autoResume: ffAutoResumeInput?.checked || false,
      ff_strictMinInterval: ffStrictMinIntervalInput?.checked || false,
      ff_incrementalSync: ffIncrementalSyncInput?.checked || false,
      ff_snooze: ffSnoozeInput?.checked || false,
      ff_threadSummary: ffThreadSummaryInput?.checked || false,
      ff_priorityInbox: ffPriorityInboxInput?.checked || false,
      ff_telemetryOptIn: false
    };
    const settings = await sendMessage({ type: 'getSettings' });
    await sendMessage({
      type: 'saveSettings',
      settings: { ...settings.settings, featureFlags: flags }
    });
    setStatus('Feature flags updated.');
  } catch (error) {
    console.error("Save feature flags error:", error);
    setStatus(`Error: ${formatError(error)}`);
  }
}

async function handleDebouncedAutoRunChange() {
  if (ffDebouncedAutoRunInput?.checked) {
    // Check for tabs permission
    try {
      const response = await sendMessage({ type: 'hasTabsPermission' });
      if (!response.granted) {
        // Request permission
        const permResponse = await sendMessage({ type: 'requestTabsPermission' });
        if (!permResponse.granted) {
          ffDebouncedAutoRunInput.checked = false;
          setStatus('Tabs permission required for debounced auto-run.');
          return;
        }
      }
      await saveFeatureFlags();
    } catch (error) {
      console.error("Tabs permission error:", error);
      ffDebouncedAutoRunInput.checked = false;
      setStatus(`Error: ${formatError(error)}`);
    }
  } else {
    // Offer to remove tabs permission
    try {
      await sendMessage({ type: 'removeTabsPermission' });
      await saveFeatureFlags();
    } catch (error) {
      console.error("Remove tabs permission error:", error);
      await saveFeatureFlags();
    }
  }
}

// ── Telemetry Management ──────────────────────────────────────────────────
async function saveTelemetrySetting() {
  try {
    const settings = await sendMessage({ type: 'getSettings' });
    await sendMessage({
      type: 'saveSettings',
      settings: { ...settings.settings, errorTelemetryEnabled: errorTelemetryEnabledInput?.checked || false }
    });
    setStatus(errorTelemetryEnabledInput?.checked ? 'Error reporting enabled.' : 'Error reporting disabled.');
  } catch (error) {
    console.error("Save telemetry setting error:", error);
    setStatus(`Error: ${formatError(error)}`);
  }
}

async function displayTelemetryBuffer() {
  try {
    const response = await sendMessage({ type: 'getTelemetryBuffer' });
    const buffer = response.buffer || [];
    if (buffer.length === 0) {
      telemetryDisplay.textContent = 'No errors recorded yet.';
    } else {
      telemetryDisplay.textContent = JSON.stringify(buffer, null, 2);
    }
    telemetryDisplay.style.display = 'block';
  } catch (error) {
    console.error("Display telemetry error:", error);
    telemetryDisplay.textContent = `Error: ${formatError(error)}`;
    telemetryDisplay.style.display = 'block';
  }
}

async function clearTelemetryBuffer() {
  try {
    await sendMessage({ type: 'clearTelemetry' });
    telemetryDisplay.style.display = 'none';
    setStatus('Telemetry buffer cleared.');
  } catch (error) {
    console.error("Clear telemetry error:", error);
    setStatus(`Error: ${formatError(error)}`);
  }
}

// ── v0.3.8: Conflict detection in settings ────────────────────────────────
async function checkAndShowConflicts() {
  try {
    const r = await sendMessage({ type: 'detectConflicts' });
    const conflicts = r.result || [];
    let banner = document.getElementById('conflictsBanner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'conflictsBanner';
      banner.style.cssText = 'background:rgba(251,188,5,.1);border:1px solid rgba(251,188,5,.3);border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:12px;color:#FBBC05;display:none;';
      document.querySelector('.page').insertBefore(banner, document.querySelector('.page').firstChild);
    }
    if (conflicts.length > 0) {
      banner.replaceChildren();
      const title = document.createElement('div');
      title.innerHTML = '⚠ <strong>' + conflicts.length + ' rule conflict(s) detected:</strong>';
      banner.appendChild(title);

      conflicts.forEach(c => {
        const item = document.createElement('div');
        if (c.type === 'duplicate') {
          item.textContent = '• Duplicate rule: "' + c.ruleA.name + '" appears more than once.';
        } else {
          const shared = (c.sharedDomains || []).concat(c.sharedSenders || []).concat(c.sharedSubjects || []).slice(0, 3).join(', ');
          item.textContent = '• "' + c.ruleA.name + '" and "' + c.ruleB.name + '" share: ' + shared;
        }
        banner.appendChild(item);
      });
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  } catch(e) {
    console.error("Check conflicts error:", e);
  }
}

// Run conflict check on load
setTimeout(checkAndShowConflicts, 1500);

// Export CSV of run history
async function exportHistoryCSV() {
  try {
    const r = await sendMessage({ type: 'getHistory' });
    const history = r.history || [];
    const rows = [['Timestamp','Source','Status','Scanned','Matched','Summary']];
    history.forEach(e => rows.push([
      e.timestamp, e.source, e.status,
      e.scannedThreads, e.matchedThreads,
      '"' + (e.summary||'').replace(/"/g,'""') + '"'
    ]));
    const csv = rows.map(r=>r.join(',')).join('\n');
    const blob = new Blob([csv], { type:'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href=url;
    a.download='gmail-organizer-history-'+new Date().toISOString().slice(0,10)+'.csv';
    a.click();
    URL.revokeObjectURL(url);
    setStatus('History exported as CSV.');
  } catch(e) {
    console.error("Export CSV error:", e);
    setStatus('Export failed: '+e.message);
  }
}

// Add export CSV button
const exportHistoryBtn = document.createElement('button');
exportHistoryBtn.textContent = 'Export CSV';
exportHistoryBtn.className = 'button ghost';
exportHistoryBtn.type = 'button';
exportHistoryBtn.style.fontSize = '12px';
exportHistoryBtn.addEventListener('click', safeExecute(() => exportHistoryCSV()));
const histHeader = document.querySelector('#historyList')?.closest('section')?.querySelector('.builder-header');
if (histHeader) histHeader.appendChild(exportHistoryBtn);

// ══════════════════════════════════════════════════════════════════════════════
// v0.8.0 NEW FEATURES
// ══════════════════════════════════════════════════════════════════════════════

// ── 1. Dry-Run Preview Modal ───────────────────────────────────────────────────
let pendingRuleForDryRun = null;

const dryRunOverlay = document.getElementById('dryRunOverlay');
const dryRunSaveBtn = document.getElementById('dryRunSaveBtn');
const dryRunCancelBtn = document.getElementById('dryRunCancelBtn');

if (dryRunSaveBtn) dryRunSaveBtn.addEventListener('click', async () => {
  try {
    if (!pendingRuleForDryRun) return;
    dryRunOverlay.style.display = 'none';
    pendingRuleForDryRun = null;
    await saveSettings();
  } catch (error) {
    console.error("Save after dry-run error:", error);
    setStatus(`Error: ${formatError(error)}`);
  }
});

if (dryRunCancelBtn) dryRunCancelBtn.addEventListener('click', () => {
  dryRunOverlay.style.display = 'none';
  pendingRuleForDryRun = null;
  setStatus('Canceled.');
});

async function showDryRunPreview(rule) {
  try {
    const ffEnabled = true;
    if (!ffEnabled) {
      await saveSettings();
      return;
    }

    setStatus('Testing rule preview...');
    const response = await sendMessage({ type: 'testRule', rule, limit: 50 });
    const { checkedCount, matchCount, matches } = response.result;

    const dryRunStats = document.getElementById('dryRunStats');
    const dryRunWarning = document.getElementById('dryRunWarning');
    const dryRunList = document.getElementById('dryRunList');

    dryRunStats.innerHTML = '';
    const statsText = document.createElement('div');
    statsText.textContent = matchCount + ' matches of ' + checkedCount + ' recent messages';
    dryRunStats.appendChild(statsText);

    dryRunWarning.style.display = 'none';
    if (matchCount === 0) {
      dryRunWarning.style.display = 'block';
      dryRunWarning.textContent = '⚠ No matches in recent inbox. Save anyway?';
    } else if (matchCount > 25) {
      dryRunWarning.style.display = 'block';
      dryRunWarning.textContent = '⚠ This rule is quite broad (' + matchCount + ' matches). Review to avoid over-applying.';
    }

    dryRunList.innerHTML = '';
    const first5 = matches.slice(0, 5);
    for (const match of first5) {
      const item = document.createElement('div');
      item.className = 'dry-run-item';

      const from = document.createElement('div');
      from.className = 'dry-run-item-from';
      from.textContent = match.from || '(Unknown sender)';

      const subject = document.createElement('div');
      subject.className = 'dry-run-item-subject';
      subject.textContent = match.subject ? match.subject.slice(0, 60) : '(No subject)';
      if (match.subject && match.subject.length > 60) subject.textContent += '…';

      const time = document.createElement('div');
      time.className = 'dry-run-item-time';
      time.textContent = formatTimeAgo(match.receivedAt);

      item.appendChild(from);
      item.appendChild(subject);
      item.appendChild(time);
      dryRunList.appendChild(item);
    }

    pendingRuleForDryRun = rule;
    dryRunOverlay.style.display = 'flex';
    setStatus('Preview ready.');
  } catch (error) {
    console.error("Dry-run preview error:", error);
    setStatus(`Error: ${formatError(error)}`);
  }
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return 'Recently';
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diff = now - then;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return days + 'd ago';
  if (hours > 0) return hours + 'h ago';
  if (minutes > 0) return minutes + 'm ago';
  return 'Now';
}

// Intercept save button to show dry-run
const origSaveButton = document.getElementById('saveButton');
if (origSaveButton) {
  const newSaveButton = origSaveButton.cloneNode(true);
  origSaveButton.replaceWith(newSaveButton);
  newSaveButton.addEventListener('click', async () => {
    try {
      const rules = collectRules();
      if (rules.length > 0) {
        const firstRule = rules[0];
        await showDryRunPreview(firstRule);
        return; // dry-run shown; actual save happens from the dry-run confirm button
      }
    } catch (error) {
      console.error("Collect rules for dry-run error:", error);
      setStatus(`Error: ${formatError(error)}`);
    }
    // No rules or dry-run skipped — fall through to a real save
    await saveSettings();
  });
}

// ── 2. Analytics Dashboard ─────────────────────────────────────────────────────
const analyticsRefreshBtn = document.getElementById('analyticsRefreshBtn');
if (analyticsRefreshBtn) {
  analyticsRefreshBtn.addEventListener('click', safeExecute(() => loadAnalytics()));
}

async function loadAnalytics() {
  const btn = document.getElementById('analyticsRefreshBtn');
  if (btn) btn.classList.add('spinning');
  try {
    const response = await sendMessage({ type: 'getAnalytics' });
    const result = response.result;
    const { totals, timeSavedSeconds, topSenders, topLabels, quotaUsed, lastRuns } = result;
    // dailyVolume uses the canonical 'count' field; dailyTrend is kept for backwards compat
    const dailyData = result.dailyVolume || result.dailyTrend || [];

    renderAnalyticsStatCards(totals, timeSavedSeconds);
    renderAnalyticsTopSenders(topSenders);
    renderAnalyticsTopLabels(topLabels);
    renderAnalyticsDailyTrend(dailyData);
    renderAnalyticsLastRuns(lastRuns);
    renderAnalyticsQuota(quotaUsed);

    const updated = document.getElementById('analyticsLastUpdated');
    if (updated) updated.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (error) {
    if (error && error.message === 'PRO_REQUIRED') {
      // Show a friendly upgrade prompt instead of an error
      const container = document.getElementById('analyticsStatCards');
      if (container) {
        container.innerHTML = `
          <div style="grid-column:1/-1;text-align:center;padding:32px 16px;background:rgba(167,139,250,.07);border:1px solid rgba(167,139,250,.18);border-radius:12px;">
            <div style="font-size:28px;margin-bottom:8px;">📊</div>
            <div style="font-size:14px;font-weight:700;color:#a78bfa;margin-bottom:6px;">Analytics is a Pro feature</div>
            <div style="font-size:12px;color:#6b6b80;margin-bottom:14px;">Upgrade to unlock full analytics — top senders, daily trends, quota usage, and more.</div>
            <button id="analyticsUpgradeBtn" style="background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;border:none;border-radius:8px;padding:9px 20px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">Upgrade to Pro →</button>
          </div>`;
        var upgradeBtn = container.querySelector('#analyticsUpgradeBtn');
        if (upgradeBtn) {
          upgradeBtn.addEventListener('click', function() {
            showProUpgradeOverlay('Analytics is a Pro feature', 'Upgrade to unlock full analytics — top senders, daily trends, quota usage, and more.');
          });
        }
      }
      const updated = document.getElementById('analyticsLastUpdated');
      if (updated) updated.textContent = '';
    } else {
      console.error("Load analytics error:", error);
      const updated = document.getElementById('analyticsLastUpdated');
      if (updated) updated.textContent = 'Error: ' + (error && error.message || 'Unknown error');
    }
  } finally {
    if (btn) btn.classList.remove('spinning');
  }
}

function renderAnalyticsStatCards(totals, timeSavedSeconds) {
  const container = document.getElementById('analyticsStatCards');
  if (!container) return;
  container.innerHTML = '';

  const cards = [
    {
      cls: 'kpi-orange', label: 'TOTAL ORGANIZED',
      value: (totals?.organized || 0).toLocaleString(),
      badge: 'All time', badgeCls: 'neutral',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2H4.18A2 2 0 0 1 2 19.92v-3"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
    },
    {
      cls: 'kpi-green', label: 'TIME SAVED',
      value: humanizeDuration(timeSavedSeconds || 0),
      badge: '↑ Est.', badgeCls: 'good',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'
    },
    {
      cls: 'kpi-blue', label: 'THIS WEEK',
      value: (totals?.thisWeek || 0).toLocaleString(),
      badge: '7 days', badgeCls: 'neutral',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>'
    },
    {
      cls: 'kpi-purple', label: 'THIS MONTH',
      value: (totals?.thisMonth || 0).toLocaleString(),
      badge: '30 days', badgeCls: 'neutral',
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>'
    }
  ];

  for (const c of cards) {
    const el = document.createElement('div');
    el.className = 'an-kpi ' + c.cls;
    el.innerHTML =
      '<div class="an-kpi-icon">' + c.icon + '</div>' +
      '<div class="an-kpi-label">' + c.label + '</div>' +
      '<div class="an-kpi-value">' + c.value + '</div>' +
      '<span class="an-kpi-badge ' + c.badgeCls + '">' + c.badge + '</span>';
    container.appendChild(el);
  }
}

function humanizeDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return hours + 'h ' + minutes + 'm';
  return minutes + 'm';
}

function renderAnalyticsTopSenders(topSenders) {
  const container = document.getElementById('analyticsSenders');
  container.innerHTML = '';

  if (!topSenders || topSenders.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:var(--text-2);font-size:11px;';
    empty.textContent = 'No sender data yet.';
    container.appendChild(empty);
    return;
  }

  const max = Math.max(...topSenders.map(s => s.count || 0), 1);
  for (const sender of topSenders.slice(0, 8)) {
    const rawFrom = sender.from || sender.domain || sender.email || '';
    const nameMatch = rawFrom.match(/^(.+?)\s*</);
    const domainMatch = rawFrom.match(/@([\w.-]+)/);
    const displayName = (nameMatch && nameMatch[1].trim()) || (domainMatch && domainMatch[1]) || rawFrom || '?';
    const initials = displayName.slice(0, 2).toUpperCase();
    const pct = Math.round((sender.count || 0) / max * 100);

    const row = document.createElement('div');
    row.className = 'an-sender-row';
    row.innerHTML =
      '<div class="an-sender-avatar">' + initials + '</div>' +
      '<div class="an-sender-info"><div class="an-sender-name">' + displayName.slice(0, 30) + '</div></div>' +
      '<div class="an-sender-bar-wrap"><div class="an-sender-bar-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="an-sender-count">' + (sender.count || 0) + '</div>';
    container.appendChild(row);
  }
}

function renderAnalyticsTopLabels(topLabels) {
  const container = document.getElementById('analyticsLabels');
  container.innerHTML = '';

  if (!topLabels || topLabels.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:var(--text-2);font-size:11px;';
    empty.textContent = 'No label data yet.';
    container.appendChild(empty);
    return;
  }

  const labelColors = ['#e8441a','#3b82f6','#22c55e','#f59e0b','#8b5cf6','#ec4899','#14b8a6','#f97316','#6366f1','#84cc16'];
  for (const [i, label] of topLabels.slice(0, 10).entries()) {
    const labelName = label.label || label.name || 'Unknown';
    const color = label.color || labelColors[i % labelColors.length];

    const row = document.createElement('div');
    row.className = 'an-label-row';
    row.innerHTML =
      '<div class="an-label-dot" style="background:' + color + '"></div>' +
      '<div class="an-label-name">' + labelName + '</div>' +
      '<div class="an-label-count">' + (label.count || 0) + '</div>';
    container.appendChild(row);
  }
}

function renderAnalyticsDailyTrend(dailyTrend) {
  const svg = document.getElementById('analyticsTrendChart');
  if (!svg) return;
  svg.innerHTML = '';

  const W = 560, H = 90, PAD = { top: 8, right: 8, bottom: 20, left: 28 };
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('preserveAspectRatio', 'none');

  if (!dailyTrend || dailyTrend.length === 0) {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', W / 2); t.setAttribute('y', H / 2);
    t.setAttribute('text-anchor', 'middle'); t.setAttribute('fill', '#a8a89e'); t.setAttribute('font-size', '11');
    t.textContent = 'No activity yet — run the organizer to see data here';
    svg.appendChild(t); return;
  }

  const data = dailyTrend.slice(-30);
  const counts = data.map(d => d.count || 0);
  const max = Math.max(...counts, 1);
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;
  const step = cW / Math.max(data.length - 1, 1);

  const pts = counts.map((v, i) => [PAD.left + i * step, PAD.top + cH - (v / max) * cH]);

  // Gradient fill
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
  grad.id = 'trendGrad'; grad.setAttribute('x1','0'); grad.setAttribute('y1','0'); grad.setAttribute('x2','0'); grad.setAttribute('y2','1');
  const s1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  s1.setAttribute('offset','0%'); s1.setAttribute('stop-color','#e8441a'); s1.setAttribute('stop-opacity','0.2');
  const s2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
  s2.setAttribute('offset','100%'); s2.setAttribute('stop-color','#e8441a'); s2.setAttribute('stop-opacity','0');
  grad.appendChild(s1); grad.appendChild(s2); defs.appendChild(grad); svg.appendChild(defs);

  // Build smooth path using cardinal spline
  function smooth(points) {
    if (points.length < 2) return points.map(p => p[0]+','+p[1]).join(' L ');
    let d = 'M ' + points[0][0] + ',' + points[0][1];
    for (let i = 0; i < points.length - 1; i++) {
      const x0 = i > 0 ? points[i-1][0] : points[0][0];
      const y0 = i > 0 ? points[i-1][1] : points[0][1];
      const x1 = points[i][0], y1 = points[i][1];
      const x2 = points[i+1][0], y2 = points[i+1][1];
      const x3 = i < points.length - 2 ? points[i+2][0] : x2;
      const y3 = i < points.length - 2 ? points[i+2][1] : y2;
      const cp1x = x1 + (x2 - x0) / 6, cp1y = y1 + (y2 - y0) / 6;
      const cp2x = x2 - (x3 - x1) / 6, cp2y = y2 - (y3 - y1) / 6;
      d += ' C ' + cp1x + ',' + cp1y + ' ' + cp2x + ',' + cp2y + ' ' + x2 + ',' + y2;
    }
    return d;
  }

  const linePath = smooth(pts);
  const bottom = PAD.top + cH;
  const areaPath = linePath + ' L ' + pts[pts.length-1][0] + ',' + bottom + ' L ' + pts[0][0] + ',' + bottom + ' Z';

  const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  area.setAttribute('d', areaPath); area.setAttribute('fill', 'url(#trendGrad)');
  svg.appendChild(area);

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('d', linePath); line.setAttribute('fill', 'none');
  line.setAttribute('stroke', '#e8441a'); line.setAttribute('stroke-width', '2'); line.setAttribute('stroke-linecap', 'round');
  svg.appendChild(line);

  // Dots on non-zero days
  pts.forEach((p, i) => {
    if (!counts[i]) return;
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', p[0]); c.setAttribute('cy', p[1]); c.setAttribute('r', '3');
    c.setAttribute('fill', '#fff'); c.setAttribute('stroke', '#e8441a'); c.setAttribute('stroke-width', '1.5');
    svg.appendChild(c);
  });

  // X-axis labels (first, middle, last)
  [[0, data[0]?.date], [Math.floor((data.length-1)/2), data[Math.floor((data.length-1)/2)]?.date], [data.length-1, data[data.length-1]?.date]]
    .filter(([,d]) => d)
    .forEach(([i, d]) => {
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', PAD.left + i * step); t.setAttribute('y', H - 4);
      t.setAttribute('text-anchor', 'middle'); t.setAttribute('fill', '#a8a89e'); t.setAttribute('font-size', '9');
      t.textContent = d.slice(5); // MM-DD
      svg.appendChild(t);
    });
}

function renderAnalyticsLastRuns(lastRuns) {
  const container = document.getElementById('analyticsLastRuns');
  if (!container) return;
  container.innerHTML = '';

  if (!lastRuns || lastRuns.length === 0) {
    container.innerHTML = '<div style="padding:14px 20px;color:var(--text-2);font-size:12px;">No runs yet.</div>';
    return;
  }

  for (const run of lastRuns.slice(0, 6)) {
    const ok = run.status !== 'error';
    const row = document.createElement('div');
    row.className = 'an-run-row';
    row.innerHTML =
      '<div class="an-run-dot ' + (ok ? 'ok' : 'err') + '"></div>' +
      '<div class="an-run-time">' + formatDateTime(run.timestamp) + '</div>' +
      '<div class="an-run-matched">' + (run.matchedThreads || run.matched || 0) + ' matched</div>' +
      '<div class="an-run-source">' + (run.source || 'manual') + '</div>';
    container.appendChild(row);
  }
}

function renderAnalyticsQuota(quotaUsed) {
  // quotaUsed is now a pre-computed percentage (0-100)
  const pct = Math.min(Math.round(quotaUsed || 0), 100);
  const bar = document.getElementById('an-quota-bar');
  const label = document.getElementById('an-quota-pct');
  if (bar) {
    bar.style.width = pct + '%';
    bar.className = 'an-quota-fill' + (pct >= 90 ? ' danger' : pct >= 70 ? ' warn' : '');
  }
  if (label) label.textContent = pct + '% of daily quota';
}

// Call loadAnalytics on init
setTimeout(() => loadAnalytics(), 500);

// ── 3. Natural Language Rule Editor ────────────────────────────────────────────
const nlParseBtn = document.getElementById('nlParseBtn');
if (nlParseBtn) {
  nlParseBtn.addEventListener('click', safeExecute(() => parseNaturalLanguage()));
}

async function parseNaturalLanguage() {
  try {
    const nlRuleText = document.getElementById('nlRuleText');
    const nlStatus = document.getElementById('nlStatus');
    const text = nlRuleText.value.trim();

    if (!text) {
      nlStatus.textContent = 'Please describe a rule.';
      return;
    }

    nlStatus.textContent = 'Parsing...';
    const response = await sendMessage({ type: 'parseNaturalLanguageRule', text });
    const { rule, confidence, usedAI } = response.result;

    if (!rule) {
      nlStatus.textContent = 'Could not parse rule. Try being more specific.';
      return;
    }

    const cards = Array.from(rulesList.querySelectorAll('.rule-card'));
    if (cards.length > 0) {
      const lastCard = cards[cards.length - 1];
      const nameInput = lastCard.querySelector('.rule-name');
      const labelInput = lastCard.querySelector('.rule-label');
      const fromDomainsInput = lastCard.querySelector('.rule-from-domains');
      const fromIncludesInput = lastCard.querySelector('.rule-from-includes');
      const subjectIncludesInput = lastCard.querySelector('.rule-subject-includes');
      const actionInput = lastCard.querySelector('.rule-action');

      if (nameInput) nameInput.value = rule.name || '';
      if (labelInput) labelInput.value = rule.label || '';
      if (fromDomainsInput) fromDomainsInput.value = rule.match?.fromDomains?.join(', ') || '';
      if (fromIncludesInput) fromIncludesInput.value = rule.match?.fromIncludes?.join(', ') || '';
      if (subjectIncludesInput) subjectIncludesInput.value = rule.match?.subjectIncludes?.join(', ') || '';
      if (actionInput) actionInput.value = rule.action || 'label';

      nlStatus.textContent = 'Parsed with ' + (usedAI ? 'AI' : 'regex') + ' (confidence: ' + Math.round((confidence || 0) * 100) + '%)';
      nlRuleText.value = '';
      setStatus('Rule populated from description. Review and save.');
    }
  } catch (error) {
    console.error("Parse natural language error:", error);
    document.getElementById('nlStatus').textContent = 'Error: ' + formatError(error);
  }
}

// ── 4. Smart Suggestions ───────────────────────────────────────────────────────
const suggestionsScanbtn = document.getElementById('suggestionsScanbtn');
if (suggestionsScanbtn) {
  suggestionsScanbtn.addEventListener('click', safeExecute(() => scanForSuggestions()));
}

async function scanForSuggestions() {
  try {
    const suggestionsScanbtn = document.getElementById('suggestionsScanbtn');
    const suggestionsContainer = document.getElementById('suggestionsContainer');
    const suggestionsLoading = document.getElementById('suggestionsLoading');

    suggestionsScanbtn.disabled = true;
    suggestionsLoading.style.display = 'block';
    suggestionsLoading.textContent = '🔍 Scanning your inbox… this may take 10–20 seconds';
    suggestionsContainer.style.display = 'none';

    const response = await sendMessage({ type: 'suggestRulesFromInbox', options: { maxDomains: 25, minFrequency: 1 } });
    const { suggestions } = response.result;

    suggestionsLoading.style.display = 'none';

    if (!suggestions || suggestions.length === 0) {
      suggestionsLoading.textContent = '⚠️ No suggestions found — your inbox may be empty, or all senders are personal email accounts (gmail.com, yahoo.com etc.). Try adding rules manually or using the AI Chat to describe what you want to organize.';
      suggestionsLoading.style.display = 'block';
      suggestionsScanbtn.disabled = false;
      return;
    }

    const suggestionsList = document.getElementById('suggestionsList');
    suggestionsList.innerHTML = '';

    for (const sugg of suggestions) {
      const card = document.createElement('div');
      card.style.cssText = 'background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:12px;';

      const top = document.createElement('div');
      top.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;';

      const name = document.createElement('div');
      name.style.cssText = 'font-weight:600;color:var(--text);font-size:12px;';
      name.textContent = sugg.name || 'Suggested rule';

      const reason = document.createElement('div');
      reason.style.cssText = 'font-size:10px;color:var(--text-3);';
      reason.textContent = sugg.reason || '';

      top.appendChild(name);
      if (sugg.reason) top.appendChild(reason);

      const details = document.createElement('div');
      details.style.cssText = 'font-size:11px;color:var(--text-2);margin-bottom:10px;';
      details.innerHTML = '';

      const detailParts = [];
      if (sugg.match && sugg.match.fromDomains && sugg.match.fromDomains.length)
        detailParts.push('Domain: ' + sugg.match.fromDomains.join(', '));
      if (sugg.label) detailParts.push('Label: ' + sugg.label);
      if (sugg.action) detailParts.push('Action: ' + sugg.action);
      details.textContent = detailParts.join(' • ');

      const buttons = document.createElement('div');
      buttons.style.cssText = 'display:flex;gap:6px;';

      const addBtn = document.createElement('button');
      addBtn.className = 'button primary';
      addBtn.style.cssText = 'flex:1;padding:6px 8px;font-size:11px;';
      addBtn.textContent = 'Add rule';
      addBtn.addEventListener('click', async () => {
        try {
          const rule = {
            id: '',
            name: sugg.name || '',
            label: sugg.label || '',
            archive: sugg.action === 'archive',
            action: sugg.action || 'label',
            color: '',
            match: {
              fromDomains: (sugg.match && sugg.match.fromDomains) ? sugg.match.fromDomains : [],
              fromIncludes: (sugg.match && sugg.match.fromIncludes) ? sugg.match.fromIncludes : [],
              subjectIncludes: (sugg.match && sugg.match.subjectIncludes) ? sugg.match.subjectIncludes : []
            }
          };
          appendRuleCard(rule, []);
          card.remove();
          setStatus('Rule added. Review and save.');
        } catch (error) {
          console.error("Add suggested rule error:", error);
        }
      });

      const dismissBtn = document.createElement('button');
      dismissBtn.className = 'button ghost';
      dismissBtn.style.cssText = 'flex:1;padding:6px 8px;font-size:11px;';
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.addEventListener('click', () => card.remove());

      buttons.appendChild(addBtn);
      buttons.appendChild(dismissBtn);

      card.appendChild(top);
      card.appendChild(details);
      card.appendChild(buttons);
      suggestionsList.appendChild(card);
    }

    suggestionsContainer.style.display = 'block';
    suggestionsScanbtn.disabled = false;
  } catch (error) {
    console.error("Scan suggestions error:", error);
    const suggestionsLoading = document.getElementById('suggestionsLoading');
    suggestionsLoading.textContent = 'Error: ' + formatError(error);
    suggestionsLoading.style.display = 'block';
    suggestionsScanbtn.disabled = false;
  }
}

// ── 5. Rule Templates Picker ───────────────────────────────────────────────────
const browseTemplatesBtn = document.getElementById('browseTemplatesBtn');
const templatesOverlay = document.getElementById('templatesOverlay');
const templatesCloseBtn = document.getElementById('templatesCloseBtn');

if (browseTemplatesBtn) {
  browseTemplatesBtn.addEventListener('click', safeExecute(() => showTemplatesModal()));
}

if (templatesCloseBtn) {
  templatesCloseBtn.addEventListener('click', () => {
    templatesOverlay.style.display = 'none';
  });
}

templatesOverlay.addEventListener('click', (e) => {
  if (e.target === templatesOverlay) {
    templatesOverlay.style.display = 'none';
  }
});

async function showTemplatesModal() {
  try {
    templatesOverlay.style.display = 'flex';
    setStatus('Loading templates...');

    const response = await sendMessage({ type: 'getRuleTemplates' });
    const templates = response.templates || [];

    renderTemplatesList(templates);
    setStatus('Templates loaded.');
  } catch (error) {
    console.error("Load templates error:", error);
    setStatus('Error: ' + formatError(error));
  }
}

function renderTemplatesList(templates) {
  const templatesList = document.getElementById('templatesList');
  const templatesSearch = document.getElementById('templatesSearch');
  templatesList.innerHTML = '';

  function filterAndRender(searchText) {
    templatesList.innerHTML = '';
    const filtered = templates.filter(t => {
      const query = searchText.toLowerCase();
      return (t.name || '').toLowerCase().includes(query) ||
             (t.description || '').toLowerCase().includes(query);
    });

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'grid-column:1/-1;text-align:center;color:var(--text-2);padding:20px;';
      empty.textContent = 'No templates found.';
      templatesList.appendChild(empty);
      return;
    }

    for (const template of filtered) {
      const card = document.createElement('div');
      card.className = 'template-card';

      const category = document.createElement('div');
      category.className = 'template-card-category';
      category.textContent = template.category || 'Other';

      const name = document.createElement('div');
      name.className = 'template-card-name';
      name.textContent = template.name || 'Template';

      const desc = document.createElement('div');
      desc.className = 'template-card-description';
      desc.textContent = template.description || '';

      const btn = document.createElement('button');
      btn.className = 'button primary';
      btn.type = 'button';
      btn.textContent = 'Add';
      btn.addEventListener('click', () => {
        try {
          // Add directly to the rules list (same as preset flow) — no background round-trip needed
          const ruleToAdd = Object.assign({}, template.rule, { id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString() });
          appendRuleCard(ruleToAdd, []);
          // Close modal and give feedback
          templatesOverlay.style.display = 'none';
          setStatus(`✅ "${template.name}" added — click Save settings to apply.`);
          // Navigate to rules panel so user sees the new card
          const rulesNav = document.querySelector('[data-panel="rules"]');
          if (rulesNav) rulesNav.click();
          // Highlight Save button
          const saveBtn = document.getElementById("saveButton");
          if (saveBtn) {
            saveBtn.style.transition = "box-shadow 0.3s";
            saveBtn.style.boxShadow = "0 0 0 3px var(--accent, #4f8ef7)";
            setTimeout(() => { saveBtn.style.boxShadow = ""; }, 2000);
          }
        } catch (error) {
          console.error("Add template error:", error);
          setStatus('Error adding template: ' + (error.message || error));
        }
      });

      card.appendChild(category);
      card.appendChild(name);
      card.appendChild(desc);
      card.appendChild(btn);
      templatesList.appendChild(card);
    }
  }

  templatesSearch.addEventListener('input', (e) => {
    filterAndRender(e.target.value);
  });

  filterAndRender('');
}

// ── 7. Per-Rule Performance Badge ──────────────────────────────────────────────
async function loadRulePerformance() {
  try {
    const cards = Array.from(rulesList.querySelectorAll('.rule-card'));
    if (cards.length === 0) return;

    for (let i = 0; i < Math.min(cards.length, 3); i++) {
      const card = cards[i];
      const ruleNameInput = card.querySelector('.rule-name');
      const ruleName = ruleNameInput?.value?.trim();
      if (!ruleName) continue;

      const ruleId = slugify(ruleName);
      try {
        const response = await sendMessage({ type: 'getRulePerformance', ruleId });
        const { totalMatches, last30Days } = response.result;
        if (last30Days > 0) {
          const badge = document.createElement('span');
          badge.style.cssText = 'display:inline-block;font-size:9px;background:var(--blue-dim);color:var(--blue);padding:2px 6px;border-radius:3px;margin-left:8px;';
          badge.textContent = last30Days + ' in 30d';
          const heading = card.querySelector('.rule-heading');
          if (heading) heading.appendChild(badge);
        }
      } catch (e) {
        // Silently skip performance fetch errors
      }
    }
  } catch (error) {
    console.error("Load rule performance error:", error);
  }
}

setTimeout(() => loadRulePerformance(), 1000);

// ── 8. Priority Inbox Feature (v0.9.0) ────────────────────────────────────────
function getScoreColor(score) {
  if (score >= 70) return 'priority-score-high';
  if (score >= 40) return 'priority-score-medium';
  return 'priority-score-low';
}

const priorityScanBtn = document.getElementById('priorityScanBtn');
const priorityContent = document.getElementById('priorityContent');
const priorityLoading = document.getElementById('priorityLoading');
const priorityList = document.getElementById('priorityList');
const priorityResetLearningBtn = document.getElementById('priorityResetLearningBtn');

if (priorityScanBtn) {
  priorityScanBtn.addEventListener('click', safeExecute(async () => {
    priorityContent.style.display = 'none';
    priorityLoading.style.display = 'block';
    try {
      const response = await sendMessage({ type: 'getImportanceScores', options: { limit: 50 } });
      const { items } = response.result;
      renderPriorityInbox(items || []);
    } catch (error) {
      console.error("Get importance scores error:", error);
      priorityLoading.textContent = 'Error: ' + formatError(error);
    }
  }));
}

if (priorityResetLearningBtn) {
  priorityResetLearningBtn.addEventListener('click', safeExecute(async () => {
    const confirmed = window.confirm('Reset all importance learning? This will clear all feedback you have given.');
    if (!confirmed) return;
    await sendMessage({ type: 'resetImportanceLearning' });
    setStatus('Importance learning reset.');
  }));
}

function renderPriorityInbox(items) {
  priorityList.innerHTML = '';
  const emptyEl = document.getElementById('priorityEmpty');

  if (items.length === 0) {
    priorityLoading.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'block';
    priorityContent.style.display = 'none';
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';

  for (const item of items) {
    const score = Math.round(item.score || 0);
    const tier = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';

    const row = document.createElement('div');
    row.className = 'an-priority-item';

    const badge = document.createElement('div');
    badge.className = 'an-priority-score ' + tier;
    badge.textContent = score;

    const info = document.createElement('div');
    info.className = 'an-priority-info';

    const subject = document.createElement('div');
    subject.className = 'an-priority-subject';
    subject.textContent = item.subject || '(No subject)';

    const from = document.createElement('div');
    from.className = 'an-priority-from';
    from.textContent = item.from || '';

    info.appendChild(subject);
    info.appendChild(from);

    if (item.reasons && item.reasons.length) {
      const chips = document.createElement('div');
      chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;';
      item.reasons.slice(0, 3).forEach(r => {
        const c = document.createElement('span');
        c.style.cssText = 'font-size:9px;background:#f4f4f0;color:var(--text-2);padding:2px 6px;border-radius:4px;';
        c.textContent = r;
        chips.appendChild(c);
      });
      info.appendChild(chips);
    }

    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';

    const importantBtn = document.createElement('button');
    importantBtn.className = 'button ghost';
    importantBtn.style.cssText = 'padding:4px 8px;font-size:10px;';
    importantBtn.textContent = '👍';
    importantBtn.title = 'Important';
    importantBtn.addEventListener('click', safeExecute(async () => {
      await sendMessage({ type: 'recordImportanceFeedback', messageId: item.messageId, feedback: 'important' });
      row.style.opacity = '0.4';
      importantBtn.disabled = true; notImportantBtn.disabled = true;
    }));

    const notImportantBtn = document.createElement('button');
    notImportantBtn.className = 'button ghost';
    notImportantBtn.style.cssText = 'padding:4px 8px;font-size:10px;';
    notImportantBtn.textContent = '👎';
    notImportantBtn.title = 'Not important';
    notImportantBtn.addEventListener('click', safeExecute(async () => {
      await sendMessage({ type: 'recordImportanceFeedback', messageId: item.messageId, feedback: 'not-important' });
      row.style.opacity = '0.4';
      importantBtn.disabled = true; notImportantBtn.disabled = true;
    }));

    btns.appendChild(importantBtn);
    btns.appendChild(notImportantBtn);

    row.appendChild(badge);
    row.appendChild(info);
    row.appendChild(btns);
    priorityList.appendChild(row);
  }

  priorityLoading.style.display = 'none';
  priorityContent.style.display = 'block';
}

// ══════════════════════════════════════════════════════════════════════════════
// ── CATEGORIZATION PANEL  (exact Fyxer layout)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * group: 'move-out' → archive (leave inbox)
 *        'keep-in'  → label only (stay in inbox)
 *        'off'      → no rule
 */
const CAT_DEFINITIONS = [
  {
    id: 'to-respond',
    name: 'To respond',
    desc: 'Need your response',
    color: '#ef4444',
    label: 'To Respond',
    match: {
      fromDomains: [],
      fromIncludes: [],
      subjectIncludes: ['action required', 'response needed', 'please respond', 'reply needed', 'your input needed', 'kindly respond']
    }
  },
  {
    id: 'fyi',
    name: 'FYI',
    desc: 'Important, no reply needed',
    color: '#f97316',
    label: 'Info/FYI',
    match: {
      fromDomains: [],
      fromIncludes: [],
      subjectIncludes: ['fyi', 'for your information', 'heads up', 'just so you know', 'no action needed', 'no reply needed']
    }
  },
  {
    id: 'comment',
    name: 'Comment',
    desc: 'Document comments & chats',
    color: '#eab308',
    label: 'Collaboration/Comments',
    match: {
      fromDomains: ['docs.google.com', 'figma.com', 'notion.so', 'coda.io'],
      fromIncludes: ['comments-noreply@docs.google.com', 'noreply@figma.com', 'noreply@notion.so'],
      subjectIncludes: ['commented on', 'left a comment', 'mentioned you in', 'new comment on']
    }
  },
  {
    id: 'notification',
    name: 'Notification',
    desc: 'Automated tool notifications',
    color: '#22c55e',
    label: 'Notifications/Tools',
    match: {
      fromDomains: ['github.com', 'gitlab.com', 'trello.com', 'asana.com', 'linear.app', 'clickup.com', 'monday.com'],
      fromIncludes: ['noreply@github.com', 'notifications@gitlab.com', 'no-reply@trello.com'],
      subjectIncludes: ['pull request', 'build failed', 'build passed', 'pipeline', 'deployment', 'task assigned']
    }
  },
  {
    id: 'meeting-update',
    name: 'Meeting update',
    desc: 'Calendar & meeting invites',
    color: '#3b82f6',
    label: 'Calendar/Meetings',
    match: {
      fromDomains: ['zoom.us', 'calendly.com', 'doodle.com'],
      fromIncludes: ['calendar-notification@google.com', 'noreply@zoom.us', 'noreply@calendly.com'],
      subjectIncludes: ['invitation', 'meeting invite', 'join zoom', 'calendar invite', 'event update', 'event cancelled']
    }
  },
  {
    id: 'to-follow-up',
    name: 'To follow up',
    desc: 'Waiting for their reply',
    color: '#8b5cf6',
    label: 'Follow Up',
    match: {
      fromDomains: [],
      fromIncludes: [],
      subjectIncludes: ['follow up', 'following up', 'checking in', 'gentle reminder', 'any update']
    }
  },
  {
    id: 'marketing',
    name: 'Marketing',
    desc: 'Sales & marketing emails',
    color: '#ec4899',
    label: 'Marketing',
    match: {
      fromDomains: [],
      fromIncludes: ['marketing@', 'sales@', 'newsletter@', 'promo@', 'noreply@', 'no-reply@', 'hello@', 'info@'],
      subjectIncludes: ['% off', 'discount', 'sale', 'limited time', 'exclusive offer', 'flash sale', 'last chance', 'promo code']
    }
  },
  {
    id: 'reading-later',
    name: 'Read Later',
    desc: 'Newsletters, digests & articles to read when you have time',
    color: '#0ea5e9',
    label: 'Read Later',
    match: {
      fromDomains: ['substack.com', 'beehiiv.com', 'ghost.io', 'medium.com', 'mailchimp.com', 'convertkit.com', 'buttondown.email', 'revue.co', 'tinyletter.com'],
      fromIncludes: ['digest@', 'weekly@', 'daily@', 'newsletter@', 'letter@', 'roundup@', 'edition@'],
      subjectIncludes: ['weekly digest', 'daily digest', 'weekly roundup', 'newsletter', 'this week in', 'new post', 'new article', 'new issue', 'issue #', 'reading list', 'top stories', 'in case you missed', 'worth reading', 'curated for you']
    }
  }
];

// State: catId → 'move-out' | 'keep-in' | 'off'
let catState = {};
let catDirty = false;  // tracks unsaved changes

function catSetDirty(val) {
  catDirty = val;
  const btn = document.getElementById('catSaveBtn');
  if (btn) btn.disabled = !val;
}

async function catLoad() {
  const stored = await chrome.storage.sync.get({
    categorizationPrefs: null,
    catRespectExisting: true,
    catAdvanced: null
  });
  catState = stored.categorizationPrefs || {};
  CAT_DEFINITIONS.forEach(c => { if (!(c.id in catState)) catState[c.id] = 'move-out'; });
  const re = document.getElementById('catRespectExisting');
  if (re) re.checked = stored.catRespectExisting !== false;
  if (stored.catAdvanced) Object.assign(catAdvState, stored.catAdvanced);
}

async function catSave() {
  const re = document.getElementById('catRespectExisting');
  await chrome.storage.sync.set({
    categorizationPrefs: catState,
    catRespectExisting: re ? re.checked : true,
    catAdvanced: { ...catAdvState }
  });
}

function catBuildRule(def, group) {
  return {
    id: 'cat-' + def.id,
    name: def.name,
    label: def.label,
    color: def.color,
    action: group === 'move-out' ? 'archive' : 'label',
    _catGenerated: true,
    match: {
      fromDomains: def.match.fromDomains.slice(),
      fromIncludes: def.match.fromIncludes.slice(),
      subjectIncludes: def.match.subjectIncludes.slice()
    }
  };
}

async function catApplyRules() {
  const response = await sendMessage({ type: 'getDashboard' });
  const manual = (response.settings?.rules || []).filter(r => !r._catGenerated);
  const generated = CAT_DEFINITIONS
    .filter(def => catState[def.id] && catState[def.id] !== 'off')
    .map(def => catBuildRule(def, catState[def.id]));
  const rules = [...generated, ...manual];
  await sendMessage({ type: 'saveSettings', settings: { ...response.settings, rules } });
  return generated.length;
}

/** Build a single category row element.
 *  Toggle always represents "move this out of inbox":
 *    checked  → state = 'move-out'  (appears in LEFT column)
 *    unchecked → state = 'off'
 */
function catMakeRow(def, group) {
  const isOn = true;

  const row = document.createElement('div');
  row.className = 'cat-row';

  const left = document.createElement('div');
  left.className = 'cat-row-left';

  const dot = document.createElement('div');
  dot.className = 'cat-dot';
  dot.style.background = def.color;

  const text = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'cat-row-name';
  name.textContent = def.name;
  const desc = document.createElement('div');
  desc.className = 'cat-row-desc';
  desc.textContent = def.desc;
  text.append(name, desc);
  left.append(dot, text);

  const toggle = document.createElement('label');
  toggle.className = 'cat-toggle';
  const inp = document.createElement('input');
  inp.type = 'checkbox';
  inp.checked = isOn;
  const track = document.createElement('div');
  track.className = 'cat-track';
  toggle.append(inp, track);

  inp.addEventListener('change', () => {
    catState[def.id] = inp.checked ? 'move-out' : 'off';
    catSetDirty(true);
    catRender();
  });

  row.append(toggle, left);
  return row;
}

/** Full render of the two-column categorization UI */
function catRender() {
  const moveOutEl = document.getElementById('catMoveOutItems');
  const keepInEl  = document.getElementById('catKeepInItems');
  const emptyEl   = document.getElementById('catMoveOutEmpty');
  if (!moveOutEl || !keepInEl) return;

  // Clear dynamic rows (keep the empty placeholder)
  moveOutEl.querySelectorAll('.cat-row').forEach(r => r.remove());
  keepInEl.innerHTML = '';

  const movedOut = [];

  CAT_DEFINITIONS.forEach(def => {
    const group = catState[def.id] || 'off';

    if (group === 'move-out') {
      // LEFT column only — remove from right when selected
      movedOut.push(catMakeRow(def, group));
    } else {
      // RIGHT column — only show categories not yet selected
      keepInEl.appendChild(catMakeRow(def, group));
    }
  });

  // Toggle empty state on left column
  if (movedOut.length === 0) {
    if (emptyEl) emptyEl.style.display = '';
  } else {
    if (emptyEl) emptyEl.style.display = 'none';
    movedOut.forEach(r => moveOutEl.appendChild(r));
  }

}

// catAdvState holds advanced settings (loaded/saved alongside catState)
let catAdvState = {
  enabled: true,
  archiveAfterSend: false,
  marketingLevel: 'cold',
  altEmails: [],
  customRules: []
};

function catRenderAdvanced() {
  const enabledEl = document.getElementById('catEnabled');
  if (enabledEl) enabledEl.checked = catAdvState.enabled;

  const archiveEl = document.getElementById('catArchiveAfterSend');
  if (archiveEl) archiveEl.checked = catAdvState.archiveAfterSend;

  document.querySelectorAll('input[name="catMarketingLevel"]').forEach(r => {
    r.checked = r.value === catAdvState.marketingLevel;
  });

  const altList = document.getElementById('catAltEmailsList');
  if (altList) {
    altList.innerHTML = '';
    catAdvState.altEmails.forEach((email, i) => {
      altList.appendChild(catAdvInputRow(email, val => {
        catAdvState.altEmails[i] = val; catSetDirty(true);
      }, () => {
        catAdvState.altEmails.splice(i, 1); catSetDirty(true); catRenderAdvanced();
      }));
    });
  }

  const rulesList = document.getElementById('catCustomRulesList');
  if (rulesList) {
    rulesList.innerHTML = '';
    catAdvState.customRules.forEach((rule, i) => {
      rulesList.appendChild(catAdvInputRow(rule, val => {
        catAdvState.customRules[i] = val; catSetDirty(true);
      }, () => {
        catAdvState.customRules.splice(i, 1); catSetDirty(true); catRenderAdvanced();
      }));
    });
  }
}

function catAdvInputRow(value, onChange, onRemove) {
  const row = document.createElement('div');
  row.className = 'cat-adv-input-row';
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = value;
  inp.placeholder = 'e.g. newsletter@example.com or example.com';
  inp.addEventListener('input', () => onChange(inp.value.trim()));
  inp.addEventListener('click', e => e.stopPropagation());
  const del = document.createElement('button');
  del.textContent = '✕';
  del.title = 'Remove';
  del.addEventListener('click', (e) => { e.stopPropagation(); onRemove(); });
  row.append(inp, del);
  return row;
}

// Wire up advanced controls once DOM is ready
function catAdvWireUp() {
  const enabledEl = document.getElementById('catEnabled');
  if (enabledEl) enabledEl.addEventListener('change', () => {
    catAdvState.enabled = enabledEl.checked; catSetDirty(true);
  });

  const archiveEl = document.getElementById('catArchiveAfterSend');
  if (archiveEl) archiveEl.addEventListener('change', () => {
    catAdvState.archiveAfterSend = archiveEl.checked; catSetDirty(true);
  });

  document.querySelectorAll('input[name="catMarketingLevel"]').forEach(r => {
    r.addEventListener('change', () => {
      if (r.checked) { catAdvState.marketingLevel = r.value; catSetDirty(true); }
    });
  });

  const addAlt = document.getElementById('catAddAltEmailBtn');
  if (addAlt) addAlt.addEventListener('click', (e) => {
    if (e.target.closest('.cat-adv-input-row')) return; // ignore clicks inside input rows
    catAdvState.altEmails.push('');
    catSetDirty(true);
    catRenderAdvanced();
  });

  const addRule = document.getElementById('catAddCustomRuleBtn');
  if (addRule) addRule.addEventListener('click', (e) => {
    if (e.target.closest('.cat-adv-input-row')) return;
    catAdvState.customRules.push('');
    catSetDirty(true);
    catRenderAdvanced();
  });
}

function catShowToast(msg, type) {
  const el = document.getElementById('catToast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'cat-toast ' + type;
  setTimeout(() => { el.className = 'cat-toast'; }, 4000);
}


// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('[data-cattab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-cattab]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const isAdv = btn.dataset.cattab === 'advanced';
    const gen = document.getElementById('catGenPanel');
    const adv = document.getElementById('catAdvPanel');
    if (gen) gen.style.display = isAdv ? 'none' : '';
    if (adv) adv.style.display = isAdv ? '' : 'none';
    if (isAdv) catRenderAdvanced();
  });
});

// ── "Respect existing" toggle marks dirty ─────────────────────────────────────
const catRespectEl = document.getElementById('catRespectExisting');
if (catRespectEl) catRespectEl.addEventListener('change', () => catSetDirty(true));

// ── Save button ───────────────────────────────────────────────────────────────
const catSaveBtn = document.getElementById('catSaveBtn');
if (catSaveBtn) {
  catSaveBtn.addEventListener('click', safeExecute(async () => {
    catSaveBtn.disabled = true;
    catSaveBtn.textContent = 'Applying…';
    try {
      await catSave();
      const n = await catApplyRules();
      catSetDirty(false);
      catShowToast(`✓ Preferences saved — ${n} categor${n === 1 ? 'y' : 'ies'} active.`, 'ok');
      setStatus('Categorization preferences applied.');
    } catch (err) {
      catShowToast('Error: ' + formatError(err), 'err');
      catSaveBtn.disabled = false;
    } finally {
      catSaveBtn.textContent = 'Update preferences';
    }
  }));
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await catLoad();
    catRender();
    catAdvWireUp();
    catRenderAdvanced();
  } catch (e) {
    console.error('[cat] init error:', e);
  }
})();

// ══════════════════════════════════════════════════════════════════════════════
// Panel switching — moved from inline script (blocked by MV3 CSP)
// ══════════════════════════════════════════════════════════════════════════════
function showProUpgradeOverlay(title, description) {
  var existing = document.getElementById('proUpgradeOverlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'proUpgradeOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;';

  var card = document.createElement('div');
  card.style.cssText = 'background:#1a1a2e;border:1px solid rgba(167,139,250,.3);border-radius:16px;padding:28px 24px;max-width:380px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.6);';
  card.innerHTML =
    '<div style="font-size:32px;margin-bottom:12px;">🔒</div>' +
    '<div style="font-size:16px;font-weight:700;color:#e8e8f0;margin-bottom:8px;">' + (title || 'Pro Feature') + '</div>' +
    '<div style="font-size:13px;color:#6b6b80;margin-bottom:20px;line-height:1.6;">' + (description || 'Upgrade to Pro to unlock this feature.') + '</div>' +
    '<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">' +
      '<button id="proOverlayMaybeLater" style="background:rgba(255,255,255,.08);color:#aaa;border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:9px 18px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">Maybe later</button>' +
      '<button id="proOverlayUpgrade" style="background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;border:none;border-radius:8px;padding:9px 20px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">Upgrade to Pro →</button>' +
    '</div>';

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  // Close on backdrop click
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) overlay.remove();
  });
  // "Maybe later" — dismiss
  card.querySelector('#proOverlayMaybeLater').addEventListener('click', function() {
    overlay.remove();
  });
  // "Upgrade to Pro" — open Stripe payment page then dismiss
  card.querySelector('#proOverlayUpgrade').addEventListener('click', function() {
    chrome.tabs.create({ url: 'https://buy.stripe.com/test_cNi00k4yz80p5qD1a19fW01' });
    overlay.remove();
  });
}

function showPanel(id, title) {
  document.querySelectorAll('.panel').forEach(function(p) {
    p.classList.add('hidden');
  });
  var panel = document.getElementById('panel-' + id);
  if (panel) panel.classList.remove('hidden');

  var hasOwnHeader = (id === 'categorization' || id === 'account');

  // Panels with their own header bar hide the main topbar
  var topbar = document.querySelector('.topbar');
  if (topbar) topbar.style.display = hasOwnHeader ? 'none' : '';

  var mainBody = document.querySelector('.main-body');
  if (mainBody) {
    mainBody.style.display = hasOwnHeader ? 'none' : '';
    mainBody.scrollTop = 0;
  }

  if (id === 'account') setTimeout(loadAccountPanel, 50);

  var titleEl = document.getElementById('mainTitle');
  if (titleEl) titleEl.textContent = title || id;

  document.querySelectorAll('[data-panel]').forEach(function(i) { i.classList.remove('active'); });
  document.querySelectorAll('[data-panel="' + id + '"]').forEach(function(i) { i.classList.add('active'); });

  if (id === 'categorization') setTimeout(function() { catRender(); catRenderAdvanced(); }, 50);
}

// Delegated nav click handler
document.addEventListener('click', function(e) {
  // Nav panel switching
  var navBtn = e.target.closest('[data-panel]');
  if (navBtn) {
    showPanel(navBtn.dataset.panel, navBtn.dataset.title);
    if (navBtn.dataset.panel === 'analytics') {
      setTimeout(function() {
        var btn = document.getElementById('analyticsRefreshBtn');
        if (btn) btn.click();
      }, 100);
    }
    return;
  }
  // "Manage →" link that goes to categorization panel
  var gotoBtn = e.target.closest('[data-goto-panel]');
  if (gotoBtn) {
    e.preventDefault();
    showPanel(gotoBtn.dataset.gotoPanel, gotoBtn.dataset.gotoTitle);
    return;
  }
  // "Save settings" shortcut buttons (data-action="save")
  var saveShortcut = e.target.closest('[data-action="save"]');
  if (saveShortcut) {
    var sb = document.getElementById('saveButton');
    if (sb) {
      var origText = saveShortcut.textContent;
      saveShortcut.textContent = 'Saving…';
      saveShortcut.disabled = true;
      saveSettings().then(function() {
        saveShortcut.textContent = '✓ Saved!';
        saveShortcut.style.background = '#16a34a';
        saveShortcut.style.borderColor = '#16a34a';
        setTimeout(function() {
          saveShortcut.textContent = origText;
          saveShortcut.style.background = '';
          saveShortcut.style.borderColor = '';
          saveShortcut.disabled = false;
        }, 2000);
      }).catch(function(err) {
        saveShortcut.textContent = '✗ ' + (err.message || 'Error');
        saveShortcut.style.background = '#dc2626';
        saveShortcut.style.borderColor = '#dc2626';
        saveShortcut.style.color = '#fff';
        setTimeout(function() {
          saveShortcut.textContent = origText;
          saveShortcut.style.background = '';
          saveShortcut.style.borderColor = '';
          saveShortcut.style.color = '';
          saveShortcut.disabled = false;
        }, 3000);
      });
    }
  }
});

// Show Dashboard panel by default
showPanel('general', 'Dashboard');

// ── "AI Chat" direct sidebar shortcut ─────────────────────────────────────
(function() {
  var navChatBtn = document.getElementById('navAiChat');
  if (!navChatBtn) return;
  navChatBtn.addEventListener('click', function() {
    // Block free users with 0 credits
    chrome.runtime.sendMessage({ type: 'getAccountInfo' }, function(info) {
      const plan = info && info.plan;
      const paid = plan === 'pro_monthly' || plan === 'pro_yearly' || plan === 'basic';
      const creditsLeft = info && info.creditsLeft;
      if (!paid && creditsLeft !== null && creditsLeft !== undefined && creditsLeft <= 0) {
        showProUpgradeOverlay('AI Chat is a Pro feature', 'Upgrade to unlock AI Chat — generate smart rules, get inbox insights, and more.');
        return;
      }
      document.querySelectorAll('.nav-item, .nav-sub-item').forEach(function(b) {
        b.classList.remove('active');
      });
      navChatBtn.classList.add('active');
      showPanel('ai-chat', 'AI Chat');
      if (window._refreshAiChatPanel) window._refreshAiChatPanel();
    });
  });
})();

// Sidebar email/avatar — use background getAccountInfo (reliable via Gmail API)
(function loadSidebarAccount() {
  try {
    chrome.runtime.sendMessage({ type: 'getAccountInfo' }, function(info) {
      if (chrome.runtime.lastError || !info || !info.email) return;
      var avatarEl = document.getElementById('sidebarAvatar');
      var emailEl  = document.getElementById('sidebarEmail');
      var planEl   = document.getElementById('sidebarPlan');
      if (avatarEl) avatarEl.textContent = info.email[0].toUpperCase();
      if (emailEl)  emailEl.textContent  = info.email;
      if (planEl) {
        var planLabel = info.planLabel || (info.plan === 'pro_yearly' || info.plan === 'pro_monthly' ? 'Pro' : 'Free');
        planEl.textContent = planLabel;
        if (info.plan === 'pro_yearly' || info.plan === 'pro_monthly') {
          planEl.style.color = 'var(--green, #22c55e)';
        }
      }
    });
  } catch(e) {}
})();

// Footer row click handlers
function loadAccountPanel() {
  chrome.runtime.sendMessage({ type: 'getAccountInfo' }, function(info) {
    if (chrome.runtime.lastError || !info) return;

    var isPro = info.plan === 'pro_yearly' || info.plan === 'pro_monthly';
    var planLabel = info.planLabel || (isPro ? (info.plan === 'pro_yearly' ? 'Pro Yearly' : 'Pro Monthly') : 'Free');

    // Avatar
    var avatarEl = document.getElementById('accAvatar');
    if (avatarEl && info.email) {
      avatarEl.textContent = info.email[0].toUpperCase();
    }

    // Email
    var emailEl = document.getElementById('accEmail');
    if (emailEl) emailEl.textContent = info.email || '—';

    var emailSubEl = document.getElementById('accEmailSub');
    if (emailSubEl) emailSubEl.textContent = info.email || '—';

    // Plan badge
    var badgeEl = document.getElementById('accPlanBadge');
    if (badgeEl) {
      badgeEl.innerHTML = '<span class="acc-badge ' + (isPro ? 'pro' : 'free') + '">' + planLabel + '</span>';
    }

    // Credits
    var creditsEl  = document.getElementById('accCredits');
    var fillEl     = document.getElementById('accCreditsFill');
    var credSubEl  = document.getElementById('accCreditsSub');

    if (info.creditsTotal >= 999999) {
      if (creditsEl) { creditsEl.textContent = '∞'; creditsEl.className = 'acc-credits-value unlimited'; }
      if (fillEl)    { fillEl.style.width = '100%'; fillEl.className = 'acc-credits-fill green'; }
      if (credSubEl) credSubEl.textContent = 'Unlimited — Pro Yearly plan';
    } else if (info.creditsLeft != null && info.creditsTotal) {
      var pct = Math.round((info.creditsLeft / info.creditsTotal) * 100);
      if (creditsEl) { creditsEl.textContent = info.creditsLeft + ' / ' + info.creditsTotal; creditsEl.className = 'acc-credits-value' + (info.creditsLeft <= 2 ? ' danger' : ''); }
      if (fillEl)    { fillEl.style.width = pct + '%'; fillEl.className = 'acc-credits-fill' + (pct > 40 ? ' green' : ''); }
      if (credSubEl) credSubEl.textContent = 'Resets on the 1st of each month';
    } else {
      if (creditsEl) creditsEl.textContent = '—';
    }

    // Reset button
    var resetBtn = document.getElementById('accResetBtn');
    if (resetBtn) {
      resetBtn.onclick = function() {
        if (!confirm('Reset sign-in? You will need to re-authorize the extension.')) return;
        chrome.identity.clearAllCachedAuthTokens(function() {
          chrome.runtime.sendMessage({ type: 'signOut' }, function() {
            alert('Sign-in reset. Please reload the extension.');
          });
        });
      };
    }
  });
}

(function wireFooterRows() {
  var planRow    = document.getElementById('footerPlanRow');
  var accountRow = document.getElementById('footerAccountRow');
  var panel      = document.getElementById('accountPanel');
  var chevron    = document.getElementById('accountChevron');

  // Plan row → navigate to Account/Profile panel
  if (planRow) {
    planRow.addEventListener('click', function() {
      showPanel('account', 'Your profile');
    });
  }

  function closeAccountPanel() {
    if (panel) panel.style.display = 'none';
    if (chevron) chevron.style.transform = '';
  }

  function openAccountPanel() {
    panel.style.display = 'block';
    if (chevron) chevron.style.transform = 'rotate(180deg)';
    chrome.runtime.sendMessage({ type: 'getAccountInfo' }, function(info) {
      if (chrome.runtime.lastError || !info) return;
      var isPro = info.plan === 'pro_yearly' || info.plan === 'pro_monthly';
      var planLabel = info.planLabel || (isPro ? (info.plan === 'pro_yearly' ? 'Pro Yearly' : 'Pro Monthly') : 'Free');
      var avEl      = document.getElementById('panelAvatar');
      var emailEl   = document.getElementById('panelEmail');
      var badgeEl   = document.getElementById('panelBadge');
      var creditsEl = document.getElementById('panelCredits');
      if (avEl && info.email)  avEl.textContent = info.email[0].toUpperCase();
      if (emailEl)             emailEl.textContent = info.email || '—';
      if (badgeEl)             badgeEl.innerHTML = '<span class="sfp-badge ' + (isPro ? 'pro' : 'free') + '">' + planLabel + '</span>';
      if (creditsEl) {
        if (info.creditsTotal >= 999999) {
          creditsEl.textContent = '∞ Unlimited'; creditsEl.className = 'sfp-credits-val green';
        } else if (info.creditsLeft != null) {
          creditsEl.textContent = info.creditsLeft + ' / ' + info.creditsTotal;
          creditsEl.className = 'sfp-credits-val' + (info.creditsLeft <= 2 ? ' danger' : '');
        }
      }
    });
  }

  // Account row → toggle
  if (accountRow && panel) {
    accountRow.addEventListener('click', function(e) {
      e.stopPropagation();
      if (panel.style.display !== 'none') {
        closeAccountPanel();
      } else {
        openAccountPanel();
      }
    });
  }

  // Click anywhere outside → close
  document.addEventListener('click', function(e) {
    if (panel && panel.style.display !== 'none') {
      if (!panel.contains(e.target) && e.target !== accountRow && !accountRow.contains(e.target)) {
        closeAccountPanel();
      }
    }
  });

  // View full profile button
  var viewBtn = document.getElementById('panelViewProfileBtn');
  if (viewBtn) {
    viewBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      closeAccountPanel();
      showPanel('account', 'Your profile');
    });
  }

  // Reset sign-in button
  var resetBtn = document.getElementById('panelResetBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (!confirm('Reset sign-in? You will need to re-authorize the extension.')) return;
      chrome.identity.clearAllCachedAuthTokens(function() {
        chrome.runtime.sendMessage({ type: 'signOut' }, function() {
          closeAccountPanel();
          alert('Sign-in reset. Please reload the extension.');
        });
      });
    });
  }
})();

// Reload extension button
var reloadExtBtn = document.getElementById('reloadExtBtn');
if (reloadExtBtn) {
  reloadExtBtn.addEventListener('click', function() {
    this.textContent = 'Reloading…';
    chrome.runtime.reload();
  });
}

// ── Dashboard panel wiring ────────────────────────────────────────────────────
(function initDashboard() {
  var DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  var CHART_H = 82; // px — matches .db-chart height
  var today = new Date().getDay();
  var todayIdx = today === 0 ? 6 : today - 1;

  // Build chart from real run history (chrome.storage.local['runHistory'])
  chrome.storage.local.get({ runHistory: [] }, function(localData) {
    var history = localData.runHistory || [];
    var now = new Date();
    var dayCounts = [0, 0, 0, 0, 0, 0, 0]; // Mon=0 … Sun=6

    history.forEach(function(run) {
      if (!run.timestamp) return;
      var d = new Date(run.timestamp);
      var diffDays = (now - d) / (1000 * 60 * 60 * 24);
      if (diffDays < 7) {
        var dow = d.getDay(); // 0=Sun … 6=Sat
        var idx = dow === 0 ? 6 : dow - 1; // normalise to Mon=0 … Sun=6
        dayCounts[idx] += (run.matchedThreads || 0);
      }
    });

    var max = Math.max.apply(null, dayCounts) || 1;
    var chart = document.getElementById('dbActivityChart');
    if (chart) {
      chart.innerHTML = DAYS.map(function(d, i) {
        // Use pixel heights — percentage heights don't work without a defined parent height
        var h = Math.max(Math.round((dayCounts[i] / max) * CHART_H), 4);
        var isToday = (i === todayIdx);
        return '<div class="db-bar-col">' +
          '<div class="db-bar' + (isToday ? ' active' : '') +
            '" style="height:' + h + 'px;' + (isToday ? 'background:#4f9cf9;opacity:1;' : '') + '"></div>' +
          '<div class="db-bar-lbl">' + d + (isToday ? ' ●' : '') + '</div>' +
          '</div>';
      }).join('');
    }
  });

  // Top labels
  var labelDotColors = ['#e8441a','#3b82f6','#22c55e','#f59e0b','#8b5cf6','#ec4899','#14b8a6','#f97316'];
  function _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function renderTopLabels(topLabels) {
    var el = document.getElementById('dbCatOverview');
    if (!el) return;
    if (!topLabels || topLabels.length === 0) {
      el.innerHTML = '<div class="db-cat-row" style="justify-content:center;color:var(--text-3);font-size:12px;">No label data yet — run the organizer first.</div>';
      return;
    }
    var maxCount = topLabels[0].count || 1;
    el.innerHTML = topLabels.slice(0, 8).map(function(item, i) {
      var pct = Math.round((item.count / maxCount) * 100);
      var color = labelDotColors[i % labelDotColors.length];
      return '<div class="db-cat-row">' +
        '<div class="db-cat-dot" style="background:' + color + '"></div>' +
        '<div class="db-cat-name">' + _esc(item.label) + '</div>' +
        '<div class="db-cat-bar-wrap"><div class="db-cat-bar-fill" style="width:' + pct + '%;background:' + color + ';"></div></div>' +
        '<div class="db-cat-count">' + item.count + '</div>' +
        '</div>';
    }).join('');
  }

  // Load dashboard stats
  chrome.storage.local.get({ runHistory: [] }, function(localData) {
    chrome.storage.sync.get({ rules: [] }, function(syncData) {
      var history = localData.runHistory || [];
      var rules   = syncData.rules || [];
      var totalProcessed = history.reduce(function(a,b){ return a + (b.scannedThreads||0); }, 0);
      var totalSorted    = history.reduce(function(a,b){ return a + (b.matchedThreads||0); }, 0);
      var el;
      el = document.getElementById('dbStatProcessed');
      if (el) el.textContent = totalProcessed > 0 ? totalProcessed.toLocaleString() : '0';
      el = document.getElementById('dbStatSorted');
      if (el) el.textContent = totalSorted > 0 ? totalSorted.toLocaleString() : '0';
      el = document.getElementById('dbStatRules');
      if (el) el.textContent = rules.length || '0';
      el = document.getElementById('dbStatTime');
      if (el) el.textContent = totalSorted > 0 ? Math.round(totalSorted * 0.3 / 60 * 10) / 10 + 'h' : '0h';
    });
  });

  // Load top labels directly from Gmail API (real thread counts)
  chrome.runtime.sendMessage({ type: 'getLabelStats' }, function(resp) {
    if (chrome.runtime.lastError || !resp || !resp.result) {
      renderTopLabels([]);
      return;
    }
    renderTopLabels(resp.result.labels || []);
  });

  // "Auto-empty trash" row → navigate to Schedule panel (replaces inline onclick, CSP fix)
  var goToScheduleRow = document.getElementById('dbGoToScheduleRow');
  if (goToScheduleRow) {
    goToScheduleRow.addEventListener('click', function() {
      var scheduleBtn = document.querySelector('[data-panel="automation"]');
      if (scheduleBtn) scheduleBtn.click();
    });
  }

  // Run organizer button
  var syncBtn = document.getElementById('dbSyncBtn');
  if (syncBtn) {
    syncBtn.addEventListener('click', function() {
      var btn = this;
      btn.textContent = 'Running…';
      chrome.runtime.sendMessage({action:'runOrganizer'}, function() {
        btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6"/><path d="M2.5 22v-6h6"/><path d="M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"/></svg> Run organizer';
      });
    });
  }
})();

// ══════════════════════════════════════════════════════════════════════════════
// ── AI CHAT PANEL
// ══════════════════════════════════════════════════════════════════════════════
(function initAiChat() {
  var aiChatPanel = document.getElementById('panel-ai-chat');
  if (!aiChatPanel) return;

  // ── Elements ───────────────────────────────────────────────────────────────
  var setupScreen   = document.getElementById('aiChatSetup');
  var chatScreen    = document.getElementById('aiChatScreen');
  var messagesEl    = document.getElementById('aiChatMessages');
  var inputEl       = document.getElementById('aiChatInput');
  var sendBtn       = document.getElementById('aiChatSendBtn');
  var emptyEl       = document.getElementById('aiChatEmpty');
  var setupKeyInput = document.getElementById('aiSetupKeyInput');
  var setupSaveBtn  = document.getElementById('aiSetupSaveBtn');

  // Guard: exit early if core chat elements are missing
  if (!messagesEl || !inputEl || !sendBtn) return;

  var chatHistory = []; // [{role:'user'|'model', parts:[{text}]}]
  var isBusy = false;

  function escHtmlChat(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function getKey() {
    // Always prefer the form field (populated after settings load) then storage fallback
    return (geminiApiKeyInput && geminiApiKeyInput.value.trim()) || '';
  }

  // Read key directly from chrome.storage.local — authoritative, no timing issues
  // Also exposed globally so navAiChat can re-trigger it when opening the panel
  window._refreshAiChatPanel = function() { checkChatKey(); };
  function checkChatKey() {
    chrome.storage.local.get({ aiSecrets: {} }, function(data) {
      var storedKey = (data.aiSecrets && data.aiSecrets.geminiApiKey) || '';
      // Also sync the form field so getKey() works for sending messages
      if (storedKey && geminiApiKeyInput && !geminiApiKeyInput.value.trim()) {
        geminiApiKeyInput.value = storedKey;
      }
      var hasKey = storedKey.length > 0 || getKey().length > 0;
      // Setup screen shows only when no key (as an optional invite, not a blocker)
      if (setupScreen) setupScreen.classList.toggle('hidden', hasKey);
      // Chat screen (with Auto-organize buttons) is ALWAYS visible
      if (chatScreen) {
        chatScreen.classList.remove('hidden');
        chatScreen.style.display = 'flex';
      }
      // Chat send button still requires a key (AI chat needs it)
      if (sendBtn) sendBtn.disabled = !hasKey;
    });
  }

  // ── Inline key save from setup screen ─────────────────────────────────────
  if (setupSaveBtn && setupKeyInput) {
    setupSaveBtn.addEventListener('click', function() {
      var key = setupKeyInput.value.trim();
      if (!key || !key.startsWith('AIza')) {
        setupKeyInput.style.borderColor = '#f87171';
        setupKeyInput.placeholder = 'Key must start with AIza…';
        setTimeout(function() {
          setupKeyInput.style.borderColor = '';
          setupKeyInput.placeholder = 'Paste your key here (AIza…)';
        }, 2500);
        return;
      }
      if (geminiApiKeyInput) geminiApiKeyInput.value = key;
      if (aiProviderInput && aiProviderInput.value !== 'gemini') aiProviderInput.value = 'gemini';
      setupSaveBtn.textContent = 'Saving…';
      setupSaveBtn.disabled = true;
      saveSettings().then(function() {
        setupSaveBtn.textContent = '✓ Saved!';
        setTimeout(function() {
          checkChatKey();
          if (inputEl) inputEl.focus();
        }, 600);
      }).catch(function() {
        setupSaveBtn.textContent = 'Save & Chat';
        setupSaveBtn.disabled = false;
        setupKeyInput.style.borderColor = '#f87171';
      });
    });
    setupKeyInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); setupSaveBtn.click(); }
    });
  }

  // ── Auto-resize textarea ───────────────────────────────────────────────────
  inputEl.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 100) + 'px';
  });
  inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  sendBtn.addEventListener('click', sendMessage);

  // ── Quick-starter chips ────────────────────────────────────────────────────
  aiChatPanel.addEventListener('click', function(e) {
    var starter = e.target.closest('.ai-chat-starter');
    if (!starter) return;
    inputEl.value = starter.textContent.trim();
    inputEl.dispatchEvent(new Event('input'));
    sendMessage();
  });

  // ── Append a message bubble ────────────────────────────────────────────────
  function appendMessage(role, html, ruleData) {
    if (emptyEl) emptyEl.remove();

    var wrap = document.createElement('div');
    wrap.className = 'ai-msg ' + role;

    if (role === 'bot') {
      var lbl = document.createElement('div');
      lbl.className = 'ai-msg-label';
      lbl.textContent = 'Gemini';
      wrap.appendChild(lbl);
    }

    var bubble = document.createElement('div');
    bubble.className = 'ai-bubble';
    bubble.innerHTML = html;
    wrap.appendChild(bubble);

    // Attach rule card if provided
    if (ruleData && ruleData.length) {
      ruleData.forEach(function(rule) {
        var card = document.createElement('div');
        card.className = 'ai-rule-card';
        card.innerHTML =
          '<div class="ai-rule-card-title">' +
            '<span>' + escHtmlChat(rule.name || rule.label || 'Rule') + '</span>' +
            '<button class="ai-rule-add-btn">+ Add Rule</button>' +
          '</div>' +
          '<div class="ai-rule-card-detail">' +
            'Label: <strong>' + escHtmlChat(rule.label || '—') + '</strong> · ' +
            'Action: <strong>' + escHtmlChat(rule.action || 'label') + '</strong>' +
            (rule.description ? '<br>' + escHtmlChat(rule.description) : '') +
          '</div>';
        card.querySelector('.ai-rule-add-btn').addEventListener('click', function() {
          addChatRule(rule);
          this.textContent = '✓ Added';
          this.disabled = true;
          this.style.background = '#16a34a';
        });
        wrap.appendChild(card);
      });
    }

    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return wrap;
  }

  // ── Thinking indicator ─────────────────────────────────────────────────────
  function showThinking() {
    var div = document.createElement('div');
    div.className = 'ai-msg bot';
    div.id = 'aiChatThinking';
    div.innerHTML =
      '<div class="ai-msg-label">Gemini</div>' +
      '<div class="ai-chat-thinking">' +
        '<div class="ai-chat-thinking-dots"><span>●</span><span>●</span><span>●</span></div>' +
        '<span>thinking…</span>' +
      '</div>';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function hideThinking() {
    var el = document.getElementById('aiChatThinking');
    if (el) el.remove();
  }

  // ── Add a rule to the rules list ───────────────────────────────────────────
  function addChatRule(rule) {
    try {
      var existing = collectRulesFromDom();
      var merged = mergeSuggestedRules(existing, [rule]);
      renderRules(merged);
      // Switch to Rules tab so user sees it
      var rulesNav = document.querySelector('[data-panel="rules"]');
      if (rulesNav) rulesNav.click();
    } catch(e) {
      console.error('AI Chat: addChatRule error', e);
    }
  }

  // ── Send message to Gemini ─────────────────────────────────────────────────
  async function sendMessage() {
    if (isBusy) return;
    var text = inputEl.value.trim();
    if (!text) return;

    var key   = (geminiApiKeyInput && geminiApiKeyInput.value.trim()) || '';
    var model = (geminiModelInput  && geminiModelInput.value.trim())  || 'gemini-2.0-flash-lite';
    if (!key) { checkChatKey(); return; }

    // Show user bubble
    appendMessage('user', escHtmlChat(text));
    inputEl.value = '';
    inputEl.style.height = 'auto';

    // Add to history
    chatHistory.push({ role: 'user', parts: [{ text: text }] });

    isBusy = true;
    sendBtn.disabled = true;
    showThinking();

    var systemInstruction = {
      parts: [{ text:
        'You are an AI assistant embedded inside a Gmail Organizer Chrome extension. ' +
        'Help the user create Gmail organization rules. ' +
        'When the user asks to create, add, or suggest a rule, respond conversationally ' +
        'AND include a JSON block at the end of your response in this exact format:\n' +
        '```rules\n[{"name":"...","label":"...","action":"label|archive|trash|star","description":"..."}]\n```\n' +
        'The "action" field must be one of: label, archive, trash, star. ' +
        'Keep your text response brief and friendly. ' +
        'If the user asks something unrelated to email/Gmail rules, politely redirect them.'
      }]
    };

    try {
      var endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);

      var resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: systemInstruction,
          contents: chatHistory
        })
      });

      if (!resp.ok) {
        var errData = await resp.json().catch(function(){ return {}; });
        throw new Error((errData.error && errData.error.message) || ('HTTP ' + resp.status));
      }

      var data = await resp.json();
      var rawText = (data.candidates &&
                     data.candidates[0] &&
                     data.candidates[0].content &&
                     data.candidates[0].content.parts &&
                     data.candidates[0].content.parts[0] &&
                     data.candidates[0].content.parts[0].text) || '';

      // Extract rules JSON block if present
      var rules = [];
      var rulesMatch = rawText.match(/```rules\s*([\s\S]*?)```/);
      var displayText = rawText;
      if (rulesMatch) {
        displayText = rawText.replace(/```rules[\s\S]*?```/g, '').trim();
        try { rules = JSON.parse(rulesMatch[1].trim()); } catch(e) {}
      }

      // Add to history (without the rules block — cleaner conversation)
      chatHistory.push({ role: 'model', parts: [{ text: rawText }] });

      // Convert newlines to <br> and linkify (safe)
      var safeHtml = escHtmlChat(displayText).replace(/\n/g, '<br>');

      hideThinking();
      appendMessage('bot', safeHtml, rules.length ? rules : null);

    } catch(err) {
      hideThinking();
      appendMessage('bot', '⚠️ ' + escHtmlChat(err.message || 'Something went wrong. Check your API key.'));
    }

    isBusy = false;
    sendBtn.disabled = false;
    checkChatKey();
  }

  // Re-check on settings load event (belt)
  document.addEventListener('settingsLoaded', checkChatKey);

  // Re-check when switching to the AI panel or clicking the sidebar shortcut
  var aiNavBtn = document.querySelector('[data-panel="ai"]');
  if (aiNavBtn) aiNavBtn.addEventListener('click', function() { setTimeout(checkChatKey, 30); });
  var navChatBtn2 = document.getElementById('navAiChat');
  if (navChatBtn2) navChatBtn2.addEventListener('click', function() { setTimeout(checkChatKey, 60); });

  // ── Auto-organize: scan inbox → AI labels → save rules → run ──────────────
  // ── Built-in domain categorizer (no API key needed) ──────────────────────
  var LOCAL_DOMAIN_MAP = {
    // ── Google services ──────────────────────────────────────────────────
    'google.com':        {'label':'Google Updates','action':'archive','name':'Google'},
    'accounts.google.com':{'label':'Google Updates','action':'archive','name':'Google Account'},
    'youtube.com':       {'label':'Google Updates','action':'archive','name':'YouTube'},
    'googlemail.com':    {'label':'Google Updates','action':'archive','name':'Google Mail'},
    'google.fr':         {'label':'Google Updates','action':'archive','name':'Google'},

    // ── Work — Dev & Code ─────────────────────────────────────────────────
    'github.com':        {'label':'Work/Dev','action':'archive','name':'GitHub'},
    'gitlab.com':        {'label':'Work/Dev','action':'archive','name':'GitLab'},
    'bitbucket.org':     {'label':'Work/Dev','action':'archive','name':'Bitbucket'},
    'vercel.com':        {'label':'Work/Dev','action':'archive','name':'Vercel'},
    'netlify.com':       {'label':'Work/Dev','action':'archive','name':'Netlify'},
    'heroku.com':        {'label':'Work/Dev','action':'archive','name':'Heroku'},
    'digitalocean.com':  {'label':'Work/Dev','action':'archive','name':'DigitalOcean'},
    'sentry.io':         {'label':'Work/Dev','action':'archive','name':'Sentry'},
    'supabase.com':      {'label':'Work/Dev','action':'archive','name':'Supabase'},
    'railway.app':       {'label':'Work/Dev','action':'archive','name':'Railway'},
    'render.com':        {'label':'Work/Dev','action':'archive','name':'Render'},
    'mailgun.com':       {'label':'Work/Dev','action':'archive','name':'Mailgun'},
    'sendgrid.com':      {'label':'Work/Dev','action':'archive','name':'SendGrid'},
    'openai.com':        {'label':'Work/Dev','action':'archive','name':'OpenAI'},
    'anthropic.com':     {'label':'Work/Dev','action':'archive','name':'Anthropic'},
    'openrouter.ai':     {'label':'Work/Dev','action':'archive','name':'OpenRouter'},

    // ── Work — Projects & Tools ───────────────────────────────────────────
    'atlassian.net':     {'label':'Work Projects','action':'archive','name':'Atlassian'},
    'jira.com':          {'label':'Work Projects','action':'archive','name':'Jira'},
    'confluence.com':    {'label':'Work Projects','action':'archive','name':'Confluence'},
    'clickup.com':       {'label':'Work Projects','action':'archive','name':'ClickUp'},
    'linear.app':        {'label':'Work Projects','action':'archive','name':'Linear'},
    'asana.com':         {'label':'Work Projects','action':'archive','name':'Asana'},
    'trello.com':        {'label':'Work Projects','action':'archive','name':'Trello'},
    'monday.com':        {'label':'Work Projects','action':'archive','name':'Monday.com'},
    'notion.so':         {'label':'Work Projects','action':'archive','name':'Notion'},
    'notion.io':         {'label':'Work Projects','action':'archive','name':'Notion'},
    'slack.com':         {'label':'Work Projects','action':'archive','name':'Slack'},
    'figma.com':         {'label':'Work Projects','action':'archive','name':'Figma'},
    'zapier.com':        {'label':'Work Projects','action':'archive','name':'Zapier'},
    'make.com':          {'label':'Work Projects','action':'archive','name':'Make'},
    'hubspot.com':       {'label':'Work Projects','action':'archive','name':'HubSpot'},
    'datadog.com':       {'label':'Work Projects','action':'archive','name':'Datadog'},
    'twilio.com':        {'label':'Work Projects','action':'archive','name':'Twilio'},

    // ── Work — Freelance ─────────────────────────────────────────────────
    'fiverr.com':        {'label':'Work/Freelance','action':'label','name':'Fiverr'},
    'upwork.com':        {'label':'Work/Freelance','action':'label','name':'Upwork'},
    'freelancer.com':    {'label':'Work/Freelance','action':'label','name':'Freelancer'},
    'toptal.com':        {'label':'Work/Freelance','action':'label','name':'Toptal'},
    'malt.fr':           {'label':'Work/Freelance','action':'label','name':'Malt'},

    // ── Finance ───────────────────────────────────────────────────────────
    'paypal.com':        {'label':'Finance/Payments','action':'label','name':'PayPal'},
    'stripe.com':        {'label':'Finance/Payments','action':'label','name':'Stripe'},
    'wise.com':          {'label':'Finance/Payments','action':'label','name':'Wise'},
    'transferwise.com':  {'label':'Finance/Payments','action':'label','name':'Wise'},
    'revolut.com':       {'label':'Finance/Payments','action':'label','name':'Revolut'},
    'paddle.com':        {'label':'Finance/Payments','action':'label','name':'Paddle'},
    'gumroad.com':       {'label':'Finance/Payments','action':'label','name':'Gumroad'},
    'lemonsqueezy.com':  {'label':'Finance/Payments','action':'label','name':'Lemon Squeezy'},

    // ── Shopping ──────────────────────────────────────────────────────────
    'amazon.com':        {'label':'Shopping/Orders','action':'archive','name':'Amazon'},
    'amazon.fr':         {'label':'Shopping/Orders','action':'archive','name':'Amazon'},
    'amazon.co.uk':      {'label':'Shopping/Orders','action':'archive','name':'Amazon'},
    'amazon.de':         {'label':'Shopping/Orders','action':'archive','name':'Amazon'},
    'ebay.com':          {'label':'Shopping/Orders','action':'archive','name':'eBay'},
    'aliexpress.com':    {'label':'Shopping/Orders','action':'archive','name':'AliExpress'},
    'etsy.com':          {'label':'Shopping/Orders','action':'archive','name':'Etsy'},
    'shopify.com':       {'label':'Shopping/Orders','action':'archive','name':'Shopify'},
    'zalando.com':       {'label':'Shopping/Orders','action':'archive','name':'Zalando'},
    'cdiscount.com':     {'label':'Shopping/Orders','action':'archive','name':'CDiscount'},
    'fnac.com':          {'label':'Shopping/Orders','action':'archive','name':'Fnac'},
    'fedex.com':         {'label':'Shopping/Shipping','action':'archive','name':'FedEx'},
    'ups.com':           {'label':'Shopping/Shipping','action':'archive','name':'UPS'},
    'dhl.com':           {'label':'Shopping/Shipping','action':'archive','name':'DHL'},
    'laposte.fr':        {'label':'Shopping/Shipping','action':'archive','name':'La Poste'},

    // ── Updates — Subscriptions ───────────────────────────────────────────
    'netflix.com':       {'label':'Updates/Subscriptions','action':'archive','name':'Netflix'},
    'spotify.com':       {'label':'Updates/Subscriptions','action':'archive','name':'Spotify'},
    'apple.com':         {'label':'Updates/Subscriptions','action':'archive','name':'Apple'},
    'twitch.tv':         {'label':'Updates/Subscriptions','action':'archive','name':'Twitch'},
    'disneyplus.com':    {'label':'Updates/Subscriptions','action':'archive','name':'Disney+'},
    'hbo.com':           {'label':'Updates/Subscriptions','action':'archive','name':'HBO'},

    // ── Updates — Marketing/Promotions ────────────────────────────────────
    'mailchimp.com':     {'label':'Marketing','action':'archive','name':'Newsletter'},
    'convertkit.com':    {'label':'Marketing','action':'archive','name':'Newsletter'},
    'klaviyo.com':       {'label':'Marketing','action':'archive','name':'Marketing'},
    'sendinblue.com':    {'label':'Marketing','action':'archive','name':'Marketing'},

    // ── Social ────────────────────────────────────────────────────────────
    'facebook.com':      {'label':'Social/Facebook','action':'archive','name':'Facebook'},
    'twitter.com':       {'label':'Social/Twitter','action':'archive','name':'Twitter'},
    'x.com':             {'label':'Social/Twitter','action':'archive','name':'Twitter'},
    'linkedin.com':      {'label':'Social/LinkedIn','action':'archive','name':'LinkedIn'},
    'instagram.com':     {'label':'Social/Instagram','action':'archive','name':'Instagram'},
    'tiktok.com':        {'label':'Social/TikTok','action':'archive','name':'TikTok'},
    'pinterest.com':     {'label':'Social/Pinterest','action':'archive','name':'Pinterest'},
    'reddit.com':        {'label':'Social/Reddit','action':'archive','name':'Reddit'},

    // ── Reading ───────────────────────────────────────────────────────────
    'substack.com':      {'label':'Reading/Newsletter','action':'archive','name':'Substack'},
    'beehiiv.com':       {'label':'Reading/Newsletter','action':'archive','name':'Newsletter'},
    'medium.com':        {'label':'Reading/Articles','action':'archive','name':'Medium'},
    'udemy.com':         {'label':'Reading/Education','action':'archive','name':'Udemy'},
    'coursera.org':      {'label':'Reading/Education','action':'archive','name':'Coursera'},

    // ── Travel ────────────────────────────────────────────────────────────
    'airbnb.com':        {'label':'Travel/Bookings','action':'label','name':'Airbnb'},
    'booking.com':       {'label':'Travel/Bookings','action':'label','name':'Booking.com'},
    'expedia.com':       {'label':'Travel/Bookings','action':'label','name':'Expedia'},
    'tripadvisor.com':   {'label':'Travel/Bookings','action':'label','name':'TripAdvisor'},
  };

  // ── Label style enforcer — always Category/Subcategory ───────────────────
  // Canonical label map — ALL variants collapse to one clean label
  var FLAT_LABEL_MAP = {
    // Old category system labels → main hierarchy
    'info/fyi':                  'Notifications',
    'collaboration/comments':    'Work Projects',
    'notifications/tools':       'Notifications',
    'calendar/meetings':         'Follow Up',
    'career/applications':       'Work Projects',
    // Finance consolidation
    'finance/banking':           'Finance/Payments',
    'finance/receipts':          'Finance/Payments',
    'finance/invoices':          'Finance/Payments',
    'finance/bills':             'Finance/Payments',
    'finance/general':           'Finance/Payments',
    // Travel consolidation
    'travel/stays':              'Travel/Bookings',
    'travel/flights':            'Travel/Bookings',
    'travel/general':            'Travel/Bookings',
    // Social consolidation
    'social/general':            'Social Emails',
    'social/updates':            'Social Emails',
    // Updates consolidation
    'updates/promotions':        'Marketing',
    'updates/general':           'Notifications',
    // Flat labels
    'marketing':                 'Marketing',
    'promotions':                'Marketing',
    'newsletters':'Reading/Newsletter','newsletter':'Reading/Newsletter',
    'social':'Social Emails','notifications':'Notifications',
    'updates':'Notifications','work':'Work Projects',
    'finance':'Finance/Payments','shopping':'Shopping/Orders',
    'travel':'Travel/Bookings','reading':'Reading/Newsletter',
    'spam':'Notifications','receipts':'Finance/Payments',
    'orders':'Shopping/Orders','invoices':'Finance/Payments',
    'bills':'Finance/Payments','jobs':'Work Projects',
    'news':'Reading/Newsletter','blog':'Reading/Newsletter',
    'education':'Reading/Education','dev':'Work/Dev',
    'github':'Work/Dev','slack':'Work Projects',
  };
  function normalizeLabelStyle(label) {
    if (!label) return 'Notifications';
    var key = label.toLowerCase().trim();
    // Check full label (handles already-hierarchical variants like Finance/Banking)
    if (FLAT_LABEL_MAP[key]) return FLAT_LABEL_MAP[key];
    // Already a valid clean label — leave it alone
    if (label.indexOf('/') !== -1) return label;
    // Keyword heuristics for unknown flat labels
    if (/shop|order|buy|store|ecommerce/i.test(key))   return 'Shopping/Orders';
    if (/pay|bank|financ|invoice|receipt|bill|wallet/i.test(key)) return 'Finance/Payments';
    if (/news|letter|digest|blog|article|read/i.test(key))  return 'Reading/Newsletter';
    if (/social|network|connect|community/i.test(key)) return 'Social Emails';
    if (/travel|flight|hotel|trip|booking/i.test(key)) return 'Travel/Bookings';
    if (/work|job|career|freelan|dev|code|git/i.test(key)) return 'Work Projects';
    if (/market|promo|offer|deal|sale/i.test(key))     return 'Marketing';
    if (/subscri|premium|plan|renew/i.test(key))       return 'Updates/Subscriptions';
    // Default
    return 'Notifications';
  }

  // Subject-based scoring rules — each entry: [regex, label, action, score]
  var SUBJECT_RULES = [
    // Finance — highest priority (keep in inbox)
    [/invoice|receipt|payment\s|paid|billing|charged|charge|refund|transaction|statement|amount due|your bill|tax\s|wire transfer/i, 'Finance/Payments', 'label', 4],
    // Shopping — orders
    [/your order|order confirm|order placed|order #|purchase confirm|order shipped|order deliver|has been shipped|out for delivery|delivered|tracking number|your cart|checkout complete/i, 'Shopping/Orders', 'archive', 4],
    // Shopping — shipping only
    [/shipment|shipped|tracking|package|parcel|delivery update|estimated delivery|courier/i, 'Shopping/Shipping', 'archive', 3],
    // Travel
    [/flight|boarding pass|check-in|itinerary|departure|arrival|booking confirm|hotel|reservation confirm|check-out|your stay|your trip/i, 'Travel/Bookings', 'label', 4],
    // Work — Dev & code
    [/pull request|merge request|ci |build failed|build passed|deploy|pipeline|release|commit|new issue|repo|branch|alert:|down:|error:|incident/i, 'Work/Dev', 'archive', 4],
    // Work — Projects & tools
    [/assigned to you|task due|mentioned you|commented on|new task|new ticket|sprint|board update|project update|due today|overdue/i, 'Work Projects', 'archive', 4],
    // Work — Freelance
    [/proposal|contract|milestone|offer|new order received|new message from buyer|job invite|hired|bid accepted|freelance/i, 'Work/Freelance', 'label', 4],
    // Reading — Newsletter
    [/newsletter|weekly digest|monthly digest|this week|this month|edition|issue #|vol\.|roundup|curated|top stories|unsubscribe/i, 'Reading/Newsletter', 'archive', 3],
    // Reading — Education
    [/course|lesson|quiz|certificate|enroll|class available|new lecture|learning path|webinar|tutorial|your progress/i, 'Reading/Education', 'archive', 3],
    // Social
    [/mentioned you|tagged you|sent you a message|friend request|followed you|liked your|commented on your|new connection|invite to connect/i, 'Social Emails', 'archive', 3],
    // Subscriptions
    [/subscription|plan renewal|your plan|trial end|upgrade your|premium|expires on|auto-renew|next billing/i, 'Updates/Subscriptions', 'archive', 3],
    // Marketing & promos
    [/% off|\bsale\b|discount|promo|deal|limited time|exclusive offer|flash sale|new arrivals|shop now|don't miss/i, 'Marketing', 'archive', 2],
    // Security & account
    [/security alert|unusual sign|verify your|confirm your email|password reset|two-factor|login attempt|account activity|suspicious/i, 'Notifications', 'label', 3],
    // General notifications (lowest priority)
    [/new feature|product update|changelog|release notes|status update|we.ve updated|terms of service|privacy policy/i, 'Notifications', 'archive', 1],
  ];

  function scoreSubjects(subjects) {
    // Returns { label, action, score } for the best-matching category, or null
    if (!subjects || !subjects.length) return null;
    var text = subjects.join(' ');
    var best = null;
    for (var i = 0; i < SUBJECT_RULES.length; i++) {
      var rule = SUBJECT_RULES[i];
      var matches = (text.match(rule[0]) || []).length;
      if (matches > 0) {
        var score = matches * rule[3];
        if (!best || score > best.score) {
          best = { label: rule[1], action: rule[2], score: score };
        }
      }
    }
    return best;
  }

  function categorizeLocally(domain, sampleSubjects) {
    if (!domain) return null;
    var d = domain.toLowerCase().replace(/^www\./, '');
    var parts = d.split('.');
    var name = parts[0];
    var cap = name.charAt(0).toUpperCase() + name.slice(1);

    // 1. Exact domain map match (highest confidence — hand-curated)
    if (LOCAL_DOMAIN_MAP[d]) return LOCAL_DOMAIN_MAP[d];
    // Subdomain suffix match (e.g. mail.fiverr.com → fiverr.com)
    for (var i = 1; i < parts.length - 1; i++) {
      var suffix = parts.slice(i).join('.');
      if (LOCAL_DOMAIN_MAP[suffix]) return LOCAL_DOMAIN_MAP[suffix];
    }

    // 2. Subject-line signal — PRIMARY for unknown domains
    var subjectScore = scoreSubjects(sampleSubjects);
    if (subjectScore && subjectScore.score >= 3) {
      return { label: subjectScore.label, action: subjectScore.action, name: cap };
    }

    // 3. Domain keyword heuristics — secondary fallback
    if (/shop|store|boutique|commerce|cart|ecommerce/.test(d))              return { label: 'Shopping/Orders',        action: 'archive', name: cap };
    if (/ship|deliver|parcel|courier|logistics/.test(d))                    return { label: 'Shopping/Shipping',      action: 'archive', name: cap };
    if (/news|daily|weekly|digest|substack|beehiiv|letter\./.test(d))       return { label: 'Reading/Newsletter',     action: 'archive', name: cap };
    if (/learn|course|edu|school|academy|udemy|coursera|khan/.test(d))      return { label: 'Reading/Education',      action: 'archive', name: cap };
    if (/bank|financ|pay|wallet|credit|invest|insurance|tax|revolut/.test(d)) return { label: 'Finance/Payments',    action: 'label',   name: cap };
    if (/travel|flight|hotel|booking|airbnb|expedia|airfrance|ryanair/.test(d)) return { label: 'Travel/Bookings',      action: 'label',   name: cap };
    if (/freelan|upwork|fiverr|malt|toptal|99designs/.test(d))              return { label: 'Work/Freelance',         action: 'label',   name: cap };
    if (/github|gitlab|sentry|vercel|netlify|heroku|render|railway/.test(d)) return { label: 'Work/Dev',             action: 'archive', name: cap };
    if (/jira|asana|trello|notion|clickup|linear|monday/.test(d))           return { label: 'Work Projects',          action: 'archive', name: cap };
    if (/subscri|premium|billing|renew/.test(d))                            return { label: 'Updates/Subscriptions',  action: 'archive', name: cap };
    if (/market|promo|offer|deal|campaign/.test(d))                         return { label: 'Marketing',      action: 'archive', name: cap };

    // 4. Weak subject signal (score 1-2) — still better than pure fallback
    if (subjectScore && subjectScore.score >= 1) {
      return { label: subjectScore.label, action: subjectScore.action, name: cap };
    }

    // 5. Last resort
    return { label: 'Notifications', action: 'archive', name: cap };
  }

  // ── Inline results helpers ────────────────────────────────────────────────
  var resultsEl = document.getElementById('autoOrganizeResults');
  function resultsLog(html) {
    if (!resultsEl) return;
    resultsEl.style.display = 'block';
    var line = document.createElement('div');
    line.innerHTML = html;
    resultsEl.appendChild(line);
    resultsEl.scrollTop = resultsEl.scrollHeight;
  }
  function resultsClear() {
    if (!resultsEl) return;
    resultsEl.innerHTML = '';
    resultsEl.style.display = 'none';
  }

  async function autoOrganizeWithAI(mode) {
    mode = mode || 'local'; // 'local' or 'ai'
    var key = getKey();

    // AI mode requires a key — show friendly prompt if missing
    if (mode === 'ai' && !key) {
      resultsClear();
      resultsLog('🔑 <strong>Gemini API key required for AI mode.</strong><br>Paste your key in the field below and click <strong>Save &amp; Chat</strong>, then try again.<br><small style="color:var(--text-3)">Don\'t have one? It\'s free — <a href="https://aistudio.google.com/app/apikey" target="_blank" style="color:#4f8ef7">get it here</a>.</small>');
      return;
    }

    var useAI = (mode === 'ai') && !!key;

    // Show results inline — no screen switching needed
    resultsClear();

    // Clear any stale run/retro mutexes from crashed previous runs
    try {
      var now = Date.now();
      var storeData = await new Promise(function(res) {
        chrome.storage.local.get({ runMutex: null, retroMutex: null }, res);
      });
      var toRemove = [];
      ['runMutex', 'retroMutex'].forEach(function(key) {
        var m = storeData[key];
        if (m && m.startedAt && (now - new Date(m.startedAt).getTime() > 2 * 60 * 1000)) {
          toRemove.push(key);
        }
      });
      if (toRemove.length) {
        await new Promise(function(res) { chrome.storage.local.remove(toRemove, res); });
      }
    } catch(e) { /* ignore */ }

    resultsLog('🔍 <strong>Step 1/5</strong> — Scanning your inbox for frequent senders…');

    var suggestions;
    try {
      var scanResp = await new Promise(function(res, rej) {
        chrome.runtime.sendMessage({ type: 'suggestRulesFromInbox', options: { maxDomains: 25, minFrequency: 1 } }, function(r) {
          if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
          if (!r || !r.ok) return rej(new Error(r && r.error || 'Scan failed'));
          res(r);
        });
      });
      suggestions = scanResp.result && scanResp.result.suggestions;
    } catch(e) {
      resultsLog('❌ Could not scan inbox: ' + e.message);
      return;
    }

    if (!suggestions || suggestions.length === 0) {
      resultsLog('⚠️ No senders found in the last 6 months of email.');
      return;
    }

    var rules;

    if (useAI) {
      resultsLog('🤖 <strong>Step 2/5</strong> — Found <strong>' + suggestions.length + ' senders</strong>. Asking AI to label them smartly…');

      var senderLines = suggestions.map(function(s) {
        return '- ' + (s.match && s.match.fromDomains && s.match.fromDomains[0] || s.name) + ' (' + s.reason + ')';
      }).join('\n');

      var prompt = 'I need to organize a Gmail inbox. Here are the most frequent email senders:\n\n' + senderLines + '\n\n' +
        'For each sender, create a Gmail organization rule. Assign a smart nested label using these categories:\n' +
        'Work/ — for work tools, productivity, professional services\n' +
        'Shopping/ — for orders, shipping, e-commerce\n' +
        'Finance/ — for banks, payments, invoices, receipts\n' +
        'Reading/ — for newsletters, blogs, media, digests\n' +
        'Social/ — for social networks, notifications\n' +
        'Travel/ — for flights, hotels, bookings\n' +
        'Updates/ — for app notifications, system alerts\n\n' +
        'Action rules: use "archive" to remove from inbox (for newsletters, notifications, promotions) or "label" to keep in inbox (for finance, work).\n\n' +
        'Reply ONLY with a valid JSON array, no explanation:\n' +
        '[{"domain":"example.com","name":"Rule Name","label":"Category/Subcategory","action":"archive"}]';

      var model = (geminiModelInput && geminiModelInput.value.trim()) || 'gemini-2.0-flash-lite';
      var aiRules = null;
      try {
        var resp = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.2 }
            })
          }
        );
        var data = await resp.json();
        var text = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text) || '';
        var jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) aiRules = JSON.parse(jsonMatch[0]);
      } catch(e) {
        useAI = false;
        resultsLog('⚠️ AI categorization failed, switching to built-in smart labels…');
      }

      if (useAI && aiRules) {
        rules = aiRules.map(function(r, i) {
          var domain = r.domain || '';
          return {
            id: 'ai-auto-' + i + '-' + Date.now(),
            name: r.name || domain,
            label: normalizeLabelStyle(r.label || ('Updates/' + domain.split('.')[0])),
            action: r.action || 'label',
            archive: r.action === 'archive',
            color: '',
            match: { fromDomains: [domain], fromIncludes: [], subjectIncludes: [] }
          };
        }).filter(function(r) { return r.match.fromDomains[0]; });
      }
    }

    if (!useAI || !rules || !rules.length) {
      resultsLog('🧠 <strong>Step 2/5</strong> — Found <strong>' + suggestions.length + ' senders</strong>. Categorizing with built-in smart labels…');

      rules = suggestions.map(function(s, i) {
        var domain = (s.match && s.match.fromDomains && s.match.fromDomains[0]) || s.name || '';
        var subjects = s.sampleSubjects || [];
        var cat = categorizeLocally(domain, subjects);
        return {
          id: 'local-auto-' + i + '-' + Date.now(),
          name: cat.name || domain,
          label: normalizeLabelStyle(cat.label),
          action: cat.action || 'label',
          archive: cat.action === 'archive',
          color: '',
          match: { fromDomains: [domain], fromIncludes: [], subjectIncludes: [] }
        };
      }).filter(function(r) { return r.match.fromDomains[0]; });
    }

    resultsLog('💾 <strong>Step 3/5</strong> — Saving <strong>' + rules.length + ' rules</strong>…');

    try {
      var dashResp = await new Promise(function(res, rej) {
        chrome.runtime.sendMessage({ type: 'getDashboard' }, function(r) {
          if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
          res(r);
        });
      });
      var existing = (dashResp && dashResp.settings && dashResp.settings.rules) || [];
      // Deduplicate within new rules by domain
      var seenDomains = new Set();
      rules = rules.filter(function(r) {
        var d = (r.match.fromDomains[0] || '').toLowerCase();
        if (!d || seenDomains.has(d)) return false;
        seenDomains.add(d);
        return true;
      });
      var existingDomains = new Set();
      existing.forEach(function(r) { (r.match && r.match.fromDomains || []).forEach(function(d) { existingDomains.add(d.toLowerCase()); }); });
      var newRules = rules.filter(function(r) { return !existingDomains.has((r.match.fromDomains[0] || '').toLowerCase()); });
      var mergedRules = existing.concat(newRules);

      var saveSettings = Object.assign({}, dashResp.settings, { rules: mergedRules });
      await new Promise(function(res, rej) {
        chrome.runtime.sendMessage({ type: 'saveSettings', settings: saveSettings }, function(r) {
          if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
          if (!r || !r.ok) return rej(new Error(r && r.error || 'Save failed'));
          res(r);
        });
      });
    } catch(e) {
      resultsLog('❌ Could not save rules: ' + e.message);
      return;
    }

    resultsLog('⚡ <strong>Step 4/5</strong> — Running organizer on your inbox…');
    var ruleMode = useAI ? 'AI-generated' : 'smart built-in';

    var organized = 0;
    try {
      var runResp = await new Promise(function(res, rej) {
        chrome.runtime.sendMessage({ type: 'runSelectedRules', dryRun: false, ruleIds: rules.map(function(r){return r.id;}) }, function(r) {
          if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
          if (!r || !r.ok) return rej(new Error(r && r.error || 'Run failed'));
          res(r);
        });
      });
      organized = (runResp.result && runResp.result.matchedThreads) || 0;
    } catch(e) {
      resultsLog('⚠️ Rules saved but organizer hit an error: ' + e.message);
    }

    resultsLog('📬 <strong>Step 5/5</strong> — Labeling all your past emails… <em>(this may take a minute)</em>');

    var retroTotal = 0;
    var retroSummary = [];

    // 5a — Apply domain-based rules retroactively
    try {
      var retroResp = await new Promise(function(res, rej) {
        chrome.runtime.sendMessage({ type: 'retroactiveLabel', options: { maxPerRule: 500, dryRun: false } }, function(r) {
          if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
          if (!r || !r.ok) return rej(new Error(r && r.error || 'Retroactive label failed'));
          res(r);
        });
      });
      retroTotal += (retroResp.result && retroResp.result.totalLabeled) || 0;
      retroSummary = retroSummary.concat((retroResp.result && retroResp.result.labelSummary) || []);
    } catch(e) {
      resultsLog('⚠️ Could not label past emails: ' + e.message);
    }

    // 5b — Apply category labels retroactively (Action/To Respond, Updates/Marketing, etc.)
    try {
      var catRetroResp = await new Promise(function(res, rej) {
        chrome.runtime.sendMessage({ type: 'retroactiveCatLabels', options: { maxPerCat: 300 } }, function(r) {
          if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
          if (!r || !r.ok) return rej(new Error(r && r.error || 'Category retro failed'));
          res(r);
        });
      });
      retroTotal += (catRetroResp.result && catRetroResp.result.totalLabeled) || 0;
      retroSummary = retroSummary.concat((catRetroResp.result && catRetroResp.result.summary) || []);
    } catch(e) { /* non-fatal */ }

    var ruleSummary = rules.slice(0, 8).map(function(r) {
      return '• <strong>' + escHtmlChat(r.name) + '</strong> → ' + escHtmlChat(r.label) + ' (' + r.action + ')';
    }).join('<br>') + (rules.length > 8 ? '<br>… and ' + (rules.length - 8) + ' more' : '');

    var retroLine = retroTotal > 0
      ? '<br>📬 <strong>' + retroTotal + ' past email' + (retroTotal !== 1 ? 's' : '') + ' labeled</strong> across ' + retroSummary.length + ' label' + (retroSummary.length !== 1 ? 's' : '') + '.'
      : '<br>📬 Past emails: no new matches found (emails may already have these labels).';

    var organizedLine = organized === 0
      ? '✅ <strong>Inbox already clean</strong>'
      : '📥 <strong>Organized ' + organized + ' inbox email' + (organized !== 1 ? 's' : '') + '</strong>';

    resultsLog(
      organizedLine + ' · ' + retroLine +
      '<br><br>' + ruleSummary +
      '<br><br><em style="color:var(--text-3)">New emails from these senders will be organized automatically on every run.</em>'
    );

    // Add Open Gmail button
    var gmailBtn = document.createElement('a');
    gmailBtn.href = 'https://mail.google.com';
    gmailBtn.target = '_blank';
    gmailBtn.style.cssText = 'display:inline-block;margin-top:10px;padding:8px 16px;background:#4f8ef7;color:#fff;border-radius:8px;font-size:12px;font-weight:700;text-decoration:none;';
    gmailBtn.textContent = '📬 Open Gmail to see your labels';
    if (resultsEl) resultsEl.appendChild(gmailBtn);
  }

  // Helper: wire an auto-organize button with a given mode
  function wireAutoOrganizeBtn(id, mode) {
    var btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', function() {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.style.opacity = '0.6';
      btn.style.cursor = 'not-allowed';
      var origText = btn.textContent;
      btn.textContent = '⏳ Running…';
      autoOrganizeWithAI(mode)
        .catch(function(e) {
          resultsLog('❌ Auto-organize failed: ' + (e.message || e));
        })
        .finally(function() {
          btn.disabled = false;
          btn.style.opacity = '';
          btn.style.cursor = '';
          btn.textContent = origText;
        });
    });
  }

  wireAutoOrganizeBtn('btnAutoOrganize', 'local');
  wireAutoOrganizeBtn('btnAiOrganize', 'ai');

  // Also trigger auto-organize when user types "organize my inbox" or similar
  var _origSendMsg = sendBtn && sendBtn.onclick;
  // Detect intent from chat input
  document.addEventListener('autoOrganizeIntent', function() { autoOrganizeWithAI(); });

  // Run immediately on page load — reads storage directly, no timing dependency
  checkChatKey();

  // Auto-trigger if opened from the popup "Auto-organize" button
  chrome.storage.local.get({ autoOrganizeTrigger: 0 }, function(data) {
    if (data.autoOrganizeTrigger && (Date.now() - data.autoOrganizeTrigger < 10000)) {
      chrome.storage.local.remove('autoOrganizeTrigger');
      // Step 1: navigate to the AI Chat panel
      showPanel('ai-chat', 'AI Chat');
      // Step 2: click Auto-organize
      setTimeout(function() {
        var btn = document.getElementById('btnAutoOrganize');
        if (btn && !btn.disabled) btn.click();
      }, 200);
    }
  });
})();
