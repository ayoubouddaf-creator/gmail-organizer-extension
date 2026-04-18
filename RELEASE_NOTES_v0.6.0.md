# Gmail Organizer v0.6.0 — Release Notes

Version 0.6.0 is a hardening release focused on security, Chrome Web Store compliance, Gmail API efficiency, and service worker reliability. No user-visible feature changes — this release fixes issues that would have caused store rejection and reliability problems in production.

## Security & privacy

- **Removed full-access Gmail scope.** The previous manifest requested both `gmail.modify` and `https://mail.google.com/`. The second scope grants full Gmail access including IMAP/SMTP, which is unnecessary for labeling and archiving and would have been rejected during Chrome Web Store OAuth verification. Only `gmail.modify` is now requested.
- **Added strict Content Security Policy.** New `content_security_policy` entry in manifest restricts `script-src`, `object-src`, `base-uri`, `form-action` to `'self'` and whitelists only `gmail.googleapis.com` and `generativelanguage.googleapis.com` for `connect-src`. Blocks all remote script loads.
- **Moved `tabs` permission to optional.** The extension no longer requests `tabs` at install time. It's promoted to `optional_permissions` so users only grant it if the debounced auto-run feature is used. New runtime helpers `hasTabsPermission()`, `requestTabsPermission()`, and `removeTabsPermission()` plus matching message handlers let the options page prompt for the permission on demand.
- **DOM XSS fixes in popup and options.** Four template-literal `innerHTML` assignments that interpolated untrusted data (Gmail API responses, stored rule names, history entries) were rewritten to use safe DOM construction with `createElement` and `textContent`. Affected: `runTestRule`, `renderHistory` (both files), and `checkAndShowConflicts`. No more XSS surface in rendered lists.
- **Added `minimum_chrome_version: 116`** to guarantee modern service worker behavior.
- **Gemini API key moved from sync to local storage.** The Gemini key was previously stored in `chrome.storage.sync` which is cloud-backed and synced across devices. It's now in `chrome.storage.local` only. A one-time migration runs on upgrade.
- **Explicit privacy comment on Gemini prompt builder.** Added a clear code comment documenting that only aggregate metadata (sender domains, label names, user instructions) is sent to Gemini — never raw email bodies.

## Gmail API hygiene

- **Upgraded retry with exponential backoff and jitter.** `fetchWithRetry` now does 5 attempts with 500/1000/2000/4000/8000 ms delays plus 0-250ms jitter. Honors `Retry-After` header on 429 responses.
- **Batch modify support.** Added `gmailBatchModify` helper that calls `users.messages.batchModify` in chunks of 1000. Rule execution now collects message IDs by label-change tuple and issues one batch call per group instead of N individual calls. This is ~10x faster and uses 1 quota unit instead of N.
- **Client-side quota tracking.** New `trackQuotaUnit` helper throttles API calls to stay under 200 units/second (Google's hard limit is 250/sec). Prevents 429 storms on large inboxes.

## Service worker robustness (MV3)

- **Cold start marker and error capture.** Service worker logs `sw_cold_start` on each wake and wraps the top-level with a try/catch that writes the last error to `chrome.storage.local.lastSwError`.
- **Progress checkpoints for long runs.** Long rule runs now checkpoint every 50 messages to `chrome.storage.local.ruleRunCheckpoint`. On next cold start, the extension logs a warning about incomplete runs from the last 10 minutes (auto-resume planned for v0.7.0).
- **Alarm handlers re-read storage on every invocation.** Verified handlers don't rely on module-global state.

## Rule engine

- **Idempotency.** Rule execution now skips messages that already have the target label. Running organize twice produces the same result instead of double-applying.
- **Undo history persistence + 24h retention.** History survives popup close and service worker restarts. Entries older than 24 hours are pruned automatically.

## Performance

- **Chunked processing.** Messages are processed in batches of 50 with a 50ms yield between chunks. No more loading 1000+ messages into memory at once.
- **Label ID cache.** Gmail label name → ID lookups are cached in memory and persisted to `chrome.storage.local`. On a stale cache hit (404), the cache entry is invalidated and retried. Saves a lot of round trips.
- **Debounced auto-run.** If the user has Gmail open and focused when the auto-run alarm fires, the run is deferred 5 minutes to avoid fighting the user for API quota.

## Migrations & feature flags

- **`SETTINGS_VERSION = 3`** tracks migration state in `chrome.storage.local`. Migrations run automatically on upgrade.
- **Feature flags.** Four new features (`ff_batchModify`, `ff_quotaTracking`, `ff_cacheLabels`, `ff_debouncedAutoRun`) can be toggled via `chrome.storage.sync.featureFlags` without shipping a new extension version. All default to enabled.

## Testing checklist before store submission

Run through these in an unpacked install before zipping for the store:

- Upgrade from v0.5.0: settings preserved, aiSecrets moved to local, presetVersion migration clean
- Fresh install: OAuth flow shows only `gmail.modify` consent (not full Gmail access)
- Run organize on a 100+ email inbox: completes in one service worker lifetime, checkpoints saved
- Run organize twice back-to-back: second run reports 0 changes (idempotent)
- Kill service worker mid-run via chrome://serviceworker-internals: checkpoint exists, cold start warning logged
- Undo after closing popup: undo still available for 24h
- Auto-run alarm with Gmail tab focused: run is deferred 5 minutes
- Auto-run alarm with Gmail tab not focused: run proceeds immediately

## Known limitations

- Checkpoint auto-resume is logged but not yet implemented — planned for v0.7.0
- Feature flag UI is not exposed in the options page; must be edited via `chrome.storage.sync` directly
- Idempotency check uses the message's current labelIds snapshot at fetch time; a message labeled by another client between fetch and modify will still get re-labeled (rare edge case)

## Files changed

- `manifest.json` — version, scopes, permissions, CSP, minimum_chrome_version
- `background.js` — 1361 → 1687 lines (+326 lines)
- `popup.js` — 922 → 949 lines (+27 lines, XSS fixes)
- `options.js` — 934 → 956 lines (+22 lines, XSS fixes)
- `icons/icon-16.png`, `icons/icon-48.png`, `icons/icon-128.png` — added (copied from chrome-store-prep)
- `styles.css` — unchanged
- `popup.html` / `options.html` — unchanged
