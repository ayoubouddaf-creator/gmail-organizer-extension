# Gmail Organizer Chrome Extension — Developer Reference

## Extension Architecture

This is a **Manifest V3 Chrome Extension** that organizes Gmail using labels, AI-generated rules, analytics, snooze, thread summaries, and a priority inbox.

```
gmail-organizer-extension/
├── manifest.json      # MV3 manifest — permissions, OAuth2, CSP, service worker
├── background.js      # Service worker — all Gmail API calls, rule logic, analytics
├── popup.html         # Extension popup HTML
├── popup.js           # Popup UI controller
├── options.html       # Full settings/analytics page HTML
├── options.js         # Options page controller
├── bridge.js          # Content script — bridges postMessage from localhost dev site
├── icons/             # Extension icons (16, 48, 128)
└── CLAUDE.md          # This file
```

## Key Files

### `background.js` (~4000 lines)
The service worker. This is the heart of the extension. Runs in a sandboxed context with no DOM access.

Responsibilities:
- OAuth token acquisition via `chrome.identity.getAuthToken`
- All Gmail REST API calls (list, get, modify threads/messages)
- Rule matching and inbox organization (`organizeInboxWithRules`)
- Label creation and caching (`labelIdCache`)
- Incremental sync via Gmail History API (`lastHistoryId`)
- Snooze via `chrome.alarms`
- Thread summarization via Gemini AI
- Priority inbox importance scoring with user feedback
- Analytics aggregation and storage
- Auto-run scheduling
- Unsubscribe / duplicate / follow-up scanning
- Message handler (`chrome.runtime.onMessage`) that routes all requests from popup and options page

### `popup.js` (~1659 lines)
Controls the extension popup (the small window when clicking the extension icon).

Responsibilities:
- Displaying inbox score, run status, rule list
- Run / Preview organize actions (via `runAction()`)
- Loading spinners (`setButtonLoading`) and toast notifications (`showToast`)
- Quick rule enable/disable toggles
- Snooze controls
- All user-facing strings sanitized via `escHtml()` before innerHTML

### `options.js` (~2100+ lines)
Controls the full options page (`options.html`).

Responsibilities:
- Settings management (rules, categories, AI secrets, feature flags)
- Analytics display (top senders, top labels, daily volume trend SVG chart, quota meter)
- Categorization panel (Gmail categories integration)
- Rule templates and AI rule generation
- Export/import of settings

### `bridge.js`
Content script injected on localhost dev origins only. Bridges `window.postMessage` from the React dev site to `chrome.runtime.sendMessage` in the background. Whitelists specific message types (`getSettings`, `getHistory`, `getAccountInfo`, `getInboxScore`, `detectConflicts`).

### `manifest.json`
- Manifest V3, minimum Chrome 116
- Service worker: `background.js` (module type)
- OAuth2: `gmail.modify` + `mail.google.com` scopes
- Host permissions: Gmail API, Gemini API, Cloud Functions endpoint
- `externally_connectable` for localhost dev origins

## Category System

Categories map Gmail's built-in tabs to label behavior.

Key constants in `background.js`:
- `CAT_PREFS_VERSION = 2` — version for migration
- `CAT_LABELS` — maps category key → Gmail label name (e.g., `promotions` → `'Promotions'`)
- `CAT_MATCH_PATTERNS` — regex patterns for subject/sender matching per category
- `GMAIL_CATEGORY_MAP` — maps Gmail API category header values to internal keys

`getCatPrefs()` reads category preferences from `chrome.storage.sync`. It performs version migration: if the stored version is < 2, it upgrades `'off'` action values to `'move-out'`.

Valid category actions:
- `'keep'` — leave in inbox, only label
- `'move-out'` — move to category label folder
- `'off'` — disabled (no-op for this category)

Category labels are pre-created upfront at the start of each organize run to avoid mid-run failures.

## Label Cache

`labelIdCache` is an in-memory `Map<labelName, labelId>`.

- Backed by `chrome.storage.local` key `labelIdCache` for persistence across service worker restarts
- Cleared (`labelIdCache.clear()`) at the start of every `organizeInboxWithRules` run
- `getLabelId(name)` — resolves a label name to its Gmail label ID, creating the label if it doesn't exist
- `ensureLabelExists(name)` — creates label via Gmail API if not present, returns label object

Why it's cleared each run: Labels can be renamed or deleted by the user between runs. Starting fresh prevents stale IDs from causing 404 errors mid-run.

## Run Mutex

Prevents concurrent organize runs which would cause race conditions on label creation and thread modification.

- `acquireRunMutex(type)` — stores `{runId, type, startedAt}` in `chrome.storage.local`
- `releaseRunMutex(runId)` — clears the mutex
- Stale mutex threshold: 10 minutes (`RUN_MUTEX_STALE_MS`)
- If a run is still in progress (mutex held < 10 min), new runs are rejected with a user-friendly error

## Analytics Shape

`getAnalytics()` returns:

```javascript
{
  topSenders: [{ from: string, count: number }],       // top 10 senders
  topLabels:  [{ label: string, count: number }],       // top 10 applied labels
  dailyVolume: [{ date: string, count: number, organized: number }], // last 30 days
  dailyTrend:  [{ date: string, count: number, organized: number }], // alias for dailyVolume
  lastRuns: [...],    // last 10 run summaries
  quotaUsed: number,  // 0-100 percentage of daily Gmail API quota
  totalOrganized: number,
  totalMatched: number,
  avgMatchRate: number,   // 0-100 percentage
  totals: {
    thisWeek: number,
    thisMonth: number,
    allTime: number
  }
}
```

`options.js` destructures as `dailyVolume || dailyTrend` for backward compatibility.
`quotaUsed` is already a percentage (0-100); do NOT divide by 10 again.

## Timestamped Logging

Use `tsLog(level, ...args)` for all debug output:

```javascript
tsLog('info', 'organize started', { threadCount });
tsLog('warn', 'label not found', labelName);
tsLog('error', 'Gmail API failed', error);
```

This prefixes every log line with `[gmail-organizer] <ISO timestamp>` for easy filtering in chrome://extensions → service worker console.

## Common Pitfalls

### 1. `translateGmailError` signature
```javascript
// WRONG — do not pass the error object directly:
throw translateGmailError(error);

// CORRECT:
const _errMsg = translateGmailError(error && error.status, null, error && error.message);
throw new Error(_errMsg);
```

### 2. `normalizeRule` vs `normalizeRules`
`normalizeRules(arr)` takes an array. The singular `normalizeRule(rule)` wraps it:
```javascript
function normalizeRule(rule) {
  const normalized = normalizeRules([rule]);
  return normalized.length > 0 ? normalized[0] : rule;
}
```
Both must be present — `parseNaturalLanguageRule` calls the singular form.

### 3. `escHtml()` in popup/options
Always use `escHtml(str)` before inserting user-controlled strings into `innerHTML`.
Safe patterns: `element.textContent = str` (always safe), `element.innerHTML = escHtml(str)`.

### 4. Service worker lifecycle
The MV3 service worker can be suspended at any time. Do not store state in module-level variables that must survive restarts — persist to `chrome.storage.local` instead. The `labelIdCache` is persisted; the run mutex is persisted.

### 5. OAuth token expiry
`getAuthToken({ interactive: false })` may return a cached but expired token. If a Gmail API call returns 401, call `chrome.identity.removeCachedAuthToken` then retry with `interactive: true`.

### 6. Gmail History API (`lastHistoryId`)
Incremental sync reads only changes since `lastHistoryId`. If `lastHistoryId` is stale (>7 days) Gmail returns 404 — fall back to a full scan. The code handles this; don't remove the fallback.

### 7. Feature flags
Feature flags live in `chrome.storage.local` under key `featureFlags`. Keys include `ff_batchModify`, `ff_incrementalSync`, etc. Read them with `getFeatureFlags()` before conditional logic.

## Debugging

1. Open `chrome://extensions` → find Gmail Organizer → click "Service Worker" link to open the background console.
2. All logs are prefixed `[gmail-organizer]` with ISO timestamps — filter by this prefix.
3. To inspect storage: in the service worker console run `chrome.storage.local.get(null, console.log)`.
4. To force-clear the run mutex: `chrome.storage.local.remove('runMutex')`.
5. To force-clear the label cache: `chrome.storage.local.remove('labelIdCache')`.
6. To check quota: `chrome.storage.local.get('dailyQuota', console.log)`.

## Version History

- **v0.9.3** — Added timestamped logging (`tsLog`), fixed `translateGmailError` call sites, added `normalizeRule` singular helper, fixed analytics field shapes (`dailyVolume`, `quotaUsed` as percentage, `totalOrganized`, `totalMatched`, `avgMatchRate`), fixed silent `catch (_) {}` blocks, improved popup loading states and toast notifications.
- **v0.9.2** — Initial public release.
