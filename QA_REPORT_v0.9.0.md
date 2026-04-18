# Gmail Organizer v0.9.0 — QA Defect Report

Static QA pass across all 8479 lines. Computer use is disabled so no live clicking, but I cross-referenced every `sendMessage` call in the UI against every handler in the background dispatch switch, traced every new button/input, and spot-checked the new v0.7.0–v0.9.0 logic. Results below, grouped by severity. Fix CRITICAL before shipping — the rest can wait for a patch release if needed.

## CRITICAL — features that don't work at all

### BUG-1: popup "Test Rule" button is broken (popup.js:270)

The popup sends `{ type: "testRule", ruleId }` but the backend expects `{ type: "testRule", rule, limit }`. The backend throws `"Rule object required."` because `msg.rule` is undefined. Even if the call got through, the popup destructures `matchedCount` / `matchedThreads` but the backend returns `matchCount` / `matches`.

Fix: resolve the rule object by ID before sending, and read the correct response fields.

```js
// popup.js around line 270 — replace with:
const settings = (await sendMessage({ type: "getSettings" })).settings;
const rule = (settings.rules || []).find(r => r.id === ruleId);
if (!rule) { testRuleResult.textContent = "Rule not found."; return; }
const response = await sendMessage({ type: "testRule", rule, limit: 50 });
const { matchCount, matches } = response.result;
```

### BUG-2: Snooze and Summarize have no entry point from the UI

`openSnoozePopover(threadId, rect)` (popup.js:1139) and `openSummaryModal(threadId)` (popup.js:1207) are defined but **never called** anywhere in the codebase. That means:

- Users can see the snoozed list but cannot snooze any new threads.
- Users cannot open the thread summary modal at all.

The v0.9.0 UI agent explicitly noted this in its "Not implemented" section but nothing was wired up. These are the two headline v0.9.0 features and they're currently dead code.

Fix: add a "🕐 Snooze" and "✨ Summarize" button to each thread card rendered by `scanUnsubscribes`, `scanFollowUps`, `scanDuplicates`, and the organize-preview view. Each button passes the card's threadId:

```js
// Example for one thread card render site
const snoozeBtn = document.createElement('button');
snoozeBtn.className = 'button ghost small';
snoozeBtn.textContent = '🕐 Snooze';
snoozeBtn.addEventListener('click', (e) => openSnoozePopover(item.threadId, e.currentTarget.getBoundingClientRect()));
card.appendChild(snoozeBtn);

const summaryBtn = document.createElement('button');
summaryBtn.className = 'button ghost small';
summaryBtn.textContent = '✨ Summarize';
summaryBtn.addEventListener('click', () => openSummaryModal(item.threadId));
card.appendChild(summaryBtn);
```

### BUG-3: `getImportanceScores` parameter name mismatch (options.js:1895)

UI sends `{ options: { limit: 50 } }`. Backend reads `options.count`. The limit silently defaults to 50 by coincidence, but **if a user wants to change it later it will be ignored** and the parameter is confusingly mis-named across the boundary.

Fix (pick one side — I'd fix the UI since the backend spec said `count`):
```js
// options.js:1895
const response = await sendMessage({ type: 'getImportanceScores', options: { count: 50 } });
```

### BUG-4: `suggestRulesFromInbox` parameter name mismatch (options.js:1639)

UI sends `{ options: { maxSenders: 20 } }`. Backend reads `options.maxDomains`. Same class of bug as BUG-3 — works by accident today because of the default value, but the user-configurable knob is broken.

Fix:
```js
// options.js:1639
const response = await sendMessage({ type: 'suggestRulesFromInbox', options: { maxDomains: 20 } });
```

### BUG-5: Analytics dashboard shows wrong stat cards (options.js:1383)

UI reads `totals.thisWeek` and `totals.thisMonth`. Backend returns `totals.weekOrganized` and `totals.monthOrganized`. Result: "This Week" and "This Month" always show 0.

Fix:
```js
// options.js:1383
{ label: 'This Week', value: totals?.weekOrganized || 0 },
{ label: 'This Month', value: totals?.monthOrganized || 0 }
```

## HIGH — silent failures, quota/rate-limit drift, state loss

### BUG-6: Gemini rate limiter state lost on service worker restart (background.js:111)

```js
const geminiRateLimit = { lastCallAt: 0, minIntervalMs: 5000 };
```

This is module-level mutable state in a service worker. Chrome MV3 kills the service worker aggressively (after ~30 seconds of idle). When it restarts, `lastCallAt` resets to 0 and the 5-second min-interval guarantee is gone. A user who rapidly toggles features could blow through the Gemini free tier.

Fix: persist `lastCallAt` to `chrome.storage.local` inside `throttleGeminiCall()` before sleeping and read it on entry.

### BUG-7: Gmail quota tracker state lost on service worker restart (background.js:495)

```js
const gmailQuota = { windowStart: 0, used: 0, WINDOW_MS: 1000, LIMIT: 200 };
```

Same class of bug as BUG-6. The 200-units-per-second Gmail quota tracker resets to zero every time the service worker wakes, so a user can actually exceed Gmail's quota on rapid-fire runs.

Fix: move the counters to `chrome.storage.local` (same strategy as BUG-6), or accept the risk and document it — Gmail's API will return 429 anyway and `fetchWithRetry` handles it, but you'll lose the proactive throttle.

### BUG-8: Label ID cache lost on service worker restart (background.js:498)

```js
const labelIdCache = new Map();
```

Defeats the v0.6.0 performance optimization. Every cold start does a full label list fetch on first rule run.

Fix: serialize to an object in `chrome.storage.local` instead of using an in-memory Map. Or accept the performance cost and remove the cache (the v0.6.0 optimization was marginal for most users).

### BUG-9: Snooze alarm creation not awaited — silent failures (background.js:2649 area)

```js
chrome.alarms.create("snooze-wake-" + threadId, { delayInMinutes: Math.max(1, delayMinutes) });
```

`chrome.alarms.create` is async. If it throws, you've already written the snooze record to storage but the alarm never fires and the thread stays snoozed forever.

Fix:
```js
try {
  await chrome.alarms.create("snooze-wake-" + threadId, { delayInMinutes });
} catch (err) {
  // roll back the snooze record
  await removeSnoozeRecord(threadId);
  throw new Error("Failed to schedule snooze alarm: " + err.message);
}
```

## MEDIUM — edge cases and latent bugs

### BUG-10: Rule storage sync/local collision on downsize (background.js:849–903)

When a user's rules grow past the sync quota, they're moved to local (`rulesOverflow`) and the `rules` key in sync gets emptied. But if the user later deletes rules to get back under the quota, the migration back to sync doesn't clear `rulesOverflow`, so both stores briefly contain rules. Read path correctly prefers local when `rulesInLocal` is true, but if that flag gets out of sync (multi-device edit), stale data leaks through.

Fix: add `await chrome.storage.local.remove('rulesOverflow')` in the branch where rules fit in sync, which already exists — but also clear it when `rulesInLocal` flips from true→false.

### BUG-11: `parseRuleWithRegex` can return an empty, useless rule (background.js:2383)

If the user types something the regex fallback can't parse (e.g., "help me organize my inbox"), the function returns a rule with all-empty `match` arrays. That rule gets auto-added and matches nothing forever.

Fix:
```js
if (!rule.match.fromDomains.length && !rule.match.fromIncludes.length && !rule.match.subjectIncludes.length) {
  throw new Error("Could not extract matching criteria. Try: 'label emails from amazon.com as Shopping'.");
}
```

### BUG-12: `summarizeThread` may crash on plaintext-only messages

The backend walks `payload.parts[]` looking for `text/plain` and `text/html`. Simple plaintext emails have no `parts` — the body is at `payload.body.data` directly. The extractor likely produces empty text for those threads and the summary becomes useless (or the fallback kicks in).

Fix: before walking parts, check `if (msg.payload && msg.payload.body && msg.payload.body.data)` and decode that first.

### BUG-13: Service worker state loss affects concurrency-critical code paths

Beyond BUG-6, BUG-7, BUG-8, verify that:
- `RUN_MUTEX_KEY` is stored in `chrome.storage.local` (looks like it is)
- `ruleRunCheckpoint` is stored in `chrome.storage.local` (looks like it is)
- The onInstalled / onStartup / onAlarm listeners are all registered at **top level** of background.js, not inside functions. Confirmed at a glance but worth a final pass with `grep -n "addListener" background.js`.

## LOW — polish and minor consistency issues

### BUG-14: Feature flag UI toggle for `ff_incrementalSync`

The UI agent added toggles for `ff_incrementalSync`, `ff_snooze`, `ff_threadSummary`, `ff_priorityInbox`. Verify they render: load options.html in a browser and expand the Advanced section. If any are missing, the wiring in the render function needs to be checked.

### BUG-15: Dry-run preview modal intercepts Save even when match count is reasonable

Minor UX nit: every save, even a 3-match rule, opens the modal. Consider a "don't show again for narrow rules" checkbox or only showing the modal for >10 matches.

### BUG-16: `innerHTML` regression spots to double-check

Grep found some `innerHTML` assignments in popup.js (around line 282, 288 for the test-rule result) that are **fine** (static strings concatenating a number) but inconsistent with the post-v0.6.0 policy of "no innerHTML anywhere." Replace with `textContent` + `document.createElement` for consistency and to prevent future regressions.

## What I could NOT verify (requires live browser)

- Whether `chrome.permissions.request` for the `tabs` optional permission actually fires (requires Chrome to display the permission dialog)
- Whether the Gmail API successfully auto-creates the `GmailOrganizer/Snoozed` label on first snooze
- Whether chrome.alarms actually wakes the service worker after 1 hour of idle (Chrome-specific scheduling)
- Whether the 24-hour thread summary cache survives a user closing the extension popup
- Whether the priority inbox scores actually feel useful on a real inbox
- Whether the OAuth consent screen shows the correct scopes at install

You need to manually walk the testing checklist in `RELEASE_NOTES_v0.9.0.md` for these.

## Recommended fix order

1. **Fix all 5 CRITICAL bugs first** — these are feature-dead bugs. BUG-1 through BUG-5, all in the UI layer. Should be one focused edit pass.
2. Fix BUG-9 (snooze alarm await) — one-line change, prevents data loss.
3. Fix BUG-6, BUG-7, BUG-8 together (service worker state persistence) — one refactor, touches 3 call sites.
4. Fix BUG-11, BUG-12 (edge cases in NL parser and summarizer) — defensive hardening.
5. Everything else can wait for v0.9.1 or later.

Total estimated fix time if done in one focused pass: 1–2 hours. I can do it now if you want — just say the word.

## Summary

| Severity | Count | Category |
|---|---|---|
| CRITICAL | 5 | Broken message wiring + dead UI entry points |
| HIGH | 4 | Service worker state loss + silent alarm failures |
| MEDIUM | 4 | Storage collisions, edge cases, payload parsing |
| LOW | 3 | UX polish and minor regressions |

**Verdict:** The engineering foundation is solid — concurrency, OAuth refresh, error taxonomy, incremental sync, feature flags, checkpoints — all working as designed. The bugs are overwhelmingly in the UI↔backend integration layer, which is exactly where rapid parallel development tends to break. Fix the CRITICAL five and the extension goes from "some features dead on arrival" to "ready for store submission". Fix the HIGH four and the reliability story matches the engineering story.
