# Gmail Organizer v0.7.0 — Release Notes

Version 0.7.0 is a reliability, resilience, and UX hardening release. Building on the v0.6.0 security and Chrome Web Store compliance work, v0.7.0 closes remaining gaps around concurrency, OAuth recovery, long-running jobs, storage limits, error presentation, and day-to-day usability. Ready for store submission.

## Reliability & resilience (background.js)

- **Concurrent run mutex.** A single mutex (`RUN_MUTEX_KEY`) now guards `organizeInboxWithRules` and `emptyTrash`. If a run is already in flight (popup click, alarm fire, options-page manual run), subsequent attempts bail out cleanly instead of double-processing messages. Stale mutexes older than 10 minutes are auto-released to recover from crashed service workers.
- **OAuth token auto-refresh.** `fetchWithRetry` now detects 401 responses, removes the cached auth token via `chrome.identity.removeCachedAuthToken`, fetches a fresh one, and retries the request exactly once. Users no longer have to re-authenticate manually when a token expires mid-run.
- **Checkpoint auto-resume.** The v0.6.0 checkpoint machinery now actually resumes on cold start. `resumeCheckpointedRunIfStale()` runs on startup, gated by the `ff_autoResume` feature flag, and picks up interrupted organize runs where they left off. Checkpoints older than 10 minutes are discarded as stale.
- **Error taxonomy.** New `translateGmailError(status, body, defaultMsg)` helper maps Gmail API failures (401, 403, 429, 5xx, 404, network) to clear, user-readable strings. All error surfaces — popup toasts, options page banners, history entries — now use the taxonomy instead of raw HTTP error text.
- **Anonymous error telemetry (opt-in).** A new `logAnonymousError(errorType, context)` helper writes a sanitized, 100-entry circular buffer to `chrome.storage.local`. It is **disabled by default** and guarded by the `ff_telemetryOptIn` feature flag plus the `errorTelemetryEnabled` user setting. Users can view or clear the buffer from the options page at any time. No message content, email addresses, or subjects are ever collected.

## Storage, limits, and quotas

- **History auto-pruning.** `HISTORY_MAX_ENTRIES = 500`, plus a 90-day cutoff in `appendHistoryEntry`. Stops history from silently growing past storage limits on long-running installs.
- **Rules storage quota check.** `checkRulesStorageQuota(rules)` computes byte usage against `chrome.storage.sync`'s 100 KB per-extension and 8 KB per-item limits. If a user's rule set gets too big, the extension transparently falls back to `chrome.storage.local` (`rulesInLocal` setting) and exposes this via the `getStorageQuota` handler. The options page shows a yellow warning banner at >80% usage.
- **Wake frequency enforcement.** Auto-run cannot be set tighter than 15 minutes; auto-trash-empty cannot be set tighter than 60 minutes. Guarded by `ff_strictMinInterval`. Protects users from accidentally burning through Gmail API quota with runaway schedules.
- **Gemini rate limiting.** New `throttleGeminiCall()` enforces a 5-second minimum interval between Gemini Flash API calls. Prevents accidental quota exhaustion when generating AI rules rapidly.

## UX & usability (popup.js, options.js, options.html, styles.css)

- **Conflict detection UI.** Options page rule cards now display a red warning badge (⚠) when a rule conflicts with another (e.g., two rules writing contradictory labels to the same messages). Tooltip lists the conflicting rule names. Rendered with safe DOM construction — no innerHTML with interpolated data.
- **Friendly error messages.** A small `formatError(err)` helper in both popup.js and options.js maps known error shapes to human-readable strings. All error displays now go through it. Users see "Gmail is rate-limiting us — please try again in a minute" instead of raw "429 Too Many Requests".
- **Feature flag panel.** New collapsible Advanced section in options.html with toggles for all seven feature flags (`ff_batchModify`, `ff_quotaTracking`, `ff_cacheLabels`, `ff_debouncedAutoRun`, `ff_autoResume`, `ff_strictMinInterval`, `ff_telemetryOptIn`). Each toggle has a one-line description. Removes the need to edit `chrome.storage.sync` manually for power users.
- **Telemetry opt-in panel.** Checkbox to enable anonymous error reporting, a "View telemetry buffer" button that dumps the sanitized buffer as readonly JSON, and a "Clear" button.
- **Tabs permission prompt flow.** When the user enables debounced auto-run, the options page calls `hasTabsPermission` first, and if missing, calls `requestTabsPermission` directly from the checkbox change handler (required for the user-gesture constraint on `chrome.permissions.request`). If the user denies, the toggle reverts and a friendly message is shown. Disabling the feature offers to revoke the permission.
- **Storage quota warning banner.** Options page shows a yellow inline banner at top when rule storage usage exceeds 80%.
- **Timezone hint.** Auto-run schedule section now displays "Times are in: America/Los_Angeles" (or wherever the user is) pulled from `getCurrentTimeZone`. Handles the confusion of DST and travel.
- **chrome.storage.onChanged reactivity.** Both popup.js and options.js listen for storage changes and re-render the affected sections with a 200ms debounce. Opening the popup in a second window, or having the background update state, now reflects live in the UI.
- **DocumentFragment batching.** Rule list rendering was refactored to build a `DocumentFragment` once and append in a single operation, reducing DOM reflows from O(n) to O(1). Noticeable improvement with large rule sets.

## Feature flags (new)

- `ff_autoResume` — enable checkpoint auto-resume on cold start
- `ff_strictMinInterval` — enforce minimum wake intervals (15 min / 60 min)
- `ff_telemetryOptIn` — allow the user-facing telemetry opt-in toggle

All v0.6.0 flags remain enabled by default.

## New settings

- `errorTelemetryEnabled` (default: false) — user-facing telemetry opt-in
- `rulesInLocal` (default: false) — automatic fallback for oversized rule sets
- `lastTimeZone` — cached timezone string, updated on each run

## New message handlers (background.js)

- `pruneHistory` — manually trigger the 500-entry / 90-day prune
- `getStorageQuota` — returns `{ rulesBytes, historyBytes, syncUsedPercent, warning }`
- `getCurrentTimeZone` — returns the IANA timezone string
- `getTelemetryBuffer` — returns the 100-entry sanitized error buffer
- `clearTelemetry` — clears the buffer
- `hasTabsPermission` / `requestTabsPermission` / `removeTabsPermission` — runtime permission management for the `tabs` optional permission

## File changes

| File          | v0.6.0 | v0.7.0 | Delta   |
|---------------|--------|--------|---------|
| manifest.json | 48     | 48     | version bump to 0.7.0 |
| background.js | 1687   | 2001   | +314    |
| popup.js      | 949    | 975    | +26     |
| options.js    | 956    | 1196   | +240    |
| options.html  | 316    | 400    | +84     |
| popup.html    | 232    | 232    | 0       |
| styles.css    | 478    | 515    | +37     |

Total bundle: ~280 KB unpacked (well under any store limit).

## Testing checklist

Run these before zipping for the store:

- Upgrade from v0.6.0: settings preserved, new defaults applied, no console errors on cold start
- Fresh install: OAuth consent shows only `gmail.modify`, options page opens automatically
- Run organize twice simultaneously (click button twice fast): second invocation bails out with a clear "already running" message
- Let a run get killed mid-flight (chrome://serviceworker-internals → stop): next cold start resumes from checkpoint
- Expire the OAuth token (sign out from Google in another tab mid-run): run recovers with a fresh token, no user action needed
- Enable debounced auto-run toggle: permission prompt appears, decline reverts the toggle
- Create 50+ rules until quota warning banner appears at >80%
- Enable telemetry → cause an error (invalid query) → view buffer → confirm only metadata is present
- Travel/DST test: change system timezone, reload options page, verify timezone hint updates
- Open popup and options page in two windows, edit a rule in one, verify the other re-renders within 200ms

## Known limitations

- Dry-run preview for new rules is not in this release (pending a `testRule` message handler in background.js) — deferred to v0.8.0.
- Telemetry buffer is displayed as raw JSON — readable but no syntax highlighting.
- Historical incremental sync via `users.history.list` is not implemented; organize still uses `users.messages.list`. Marked with a TODO in background.js and planned for v0.8.0.
- No unit tests or ESLint config yet — planned for v0.8.0.

## Upgrade path from v0.6.0

No manual steps required. Migration runs automatically on upgrade. All existing rules, history, and settings are preserved. Feature flags default to enabled; users who want to opt out can do so in the new Advanced section.
