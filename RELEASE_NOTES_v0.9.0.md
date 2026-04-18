# Gmail Organizer v0.9.0 — Release Notes

v0.9.0 closes the feature gap with paid email tools like SaneBox, Shortwave, and Boomerang. Three big additions: snooze, AI thread summaries, and a priority inbox with learning. All still privacy-first, still bring-your-own-Gemini-key, still free.

## Snooze

Hide a thread from your inbox and have it reappear at a time you pick. Powered by a dedicated `GmailOrganizer/Snoozed` label (auto-created on first use) and `chrome.alarms`.

- **Presets**: 1 hour, Tomorrow 9am, Next week, or Custom datetime picker
- **Snoozed list view**: see every snoozed thread with subject, sender, and humanized time remaining ("2h 30m", "1d 3h", "in 5 min")
- **Wake now** or **Cancel snooze** on any snoozed thread
- **Crash recovery**: if the service worker dies, snooze alarms are re-registered on cold start via `restoreSnoozeAlarms()`
- **Validation**: wake times must be ≥5 minutes out and ≤1 year
- Gated by new feature flag `ff_snooze` (default on)

New backend handlers: `snoozeThread`, `listSnoozedThreads`, `cancelSnooze`, `wakeSnoozedThreadNow`. New storage key: `snoozedThreads` in `chrome.storage.local`.

## AI thread summaries

Open any thread in your scan results and click "✨ Summarize thread" to get a structured Gemini summary. No more scrolling through 40-message threads to find what was decided.

The summary modal shows:
- **Summary** — 2-3 sentence overview
- **Key points** — bullet list of what was said
- **Action items** — what still needs doing, each with a visual checkbox
- **Participants** — chips showing who was involved and their role
- **Sentiment badge** — color-coded as neutral, urgent, friendly, or formal
- **Message count** and **generated-at timestamp**

Implementation details:
- Extracts plain text from `text/plain` parts, falls back to HTML stripping for `text/html`
- Cuts quoted replies at `On <date>, <sender> wrote:` and `-----Original Message-----` markers
- Caps input at ~20000 chars to stay within Gemini token limits
- Strict JSON output prompt — on parse failure, returns a graceful text-only degraded response
- **24-hour cache** per threadId in `chrome.storage.local` (`threadSummaryCache`) so re-opening the same thread is instant
- `clearSummaryCache` handler for debugging

Requires Gemini to be configured in settings. Gated by `ff_threadSummary` (default on). Goes through `throttleGeminiCall` for rate limiting.

## Priority inbox with learning

A SaneBox-style importance scorer that ranks your last 50 inbox messages by how likely you care about them. Scores are 0-100 and come with a reason list so you can see *why* something was ranked high or low.

**Scoring signals:**

| Signal | Points |
|---|---|
| Sender you reply to often (≥3 replies) | +30 |
| You've starred this sender before | +20 |
| Urgency keywords (urgent, asap, deadline, today, action required) | +15 |
| You're in `To:` (not just Cc/Bcc) | +15 |
| Direct reply to one of your sent messages | +10 |
| Small thread (1-on-1 or small group) | +10 |
| Sender marked as low-importance by your past actions | −15 |
| Promo words (sale, % off, unsubscribe, discount, deal) | −10 |
| Gmail categorized it as Promotions / Social / Updates | −10 |

Clamped to 0-100. Color-coded: red >70, orange 40-70, gray <40.

**Learning table** stored in `chrome.storage.local` under `importanceLearning`:

```
{
  frequentRepliers: { [email]: sentCount },
  starredSenders: { [email]: count },
  lowImportanceSenders: { [email]: negativeCount },
  userFeedback: { [messageId]: 'important'|'not-important' }
}
```

**Feedback loop**: every ranked message has "Important 👍" / "Not important 👎" buttons. Pressing one trains the learning table — future messages from that sender get a permanent +20 or −15 nudge. A "Reset learning" button (with confirmation) wipes the table.

**Passive learning hook** (`updateLearningFromActions`) is called after every organize run so rule-driven archives/trashes contribute to the low-importance signal over time.

**Caching**: importance scores are cached for 5 minutes to avoid recomputing on every scroll.

Gated by `ff_priorityInbox` (default on). New handlers: `getImportanceScores`, `recordImportanceFeedback`, `getImportanceLearning`, `resetImportanceLearning`.

## New feature flags in the Advanced panel

All four new flags are now wired into the Advanced section toggles in options.html (the missing v0.8.0 `ff_incrementalSync` toggle is also there now):

- `ff_incrementalSync` — use `users.history.list` delta sync instead of full inbox scan
- `ff_snooze` — enable snooze
- `ff_threadSummary` — enable AI thread summaries
- `ff_priorityInbox` — enable priority inbox scoring and learning

## File changes

| File | v0.8.0 | v0.9.0 | Delta |
|---|---|---|---|
| manifest.json | 48 | 48 | version bump → 0.9.0 |
| background.js | 2531 | 3451 | +920 |
| popup.js | 1014 | 1318 | +304 |
| options.js | 1859 | 2007 | +148 |
| popup.html | 232 | 285 | +53 |
| options.html | 497 | 541 | +44 |
| styles.css | 705 | 829 | +124 |

Unpacked bundle: ~420 KB. Still well under any store limit.

## Positioning (the pitch)

You now compete with:

- **SaneBox** ($7–15/mo) — beaten on price, privacy, and template library. Matched on priority inbox and learning. Their advantage: longer-trained ML models, multi-account, mobile.
- **Boomerang** ($5–15/mo) — matched on snooze. They still have send-later, read receipts, and AI writing that you don't.
- **Shortwave** (free/$10) — still ahead on full AI-native inbox (their whole client is AI). You have parity on thread summaries now.
- **Trimbox** ($10–40 one-time) — you beat them on everything: unsubscribe + organize + analytics + snooze + priority inbox.

Your unique angle: **the only Gmail organizer that runs entirely in your browser, uses your own Gemini key, and costs nothing per month**. Lean into that on the store listing.

## Testing checklist

Before zipping:

- Upgrade from v0.8.0 preserves all rules, history, settings, analytics data, feature flags
- Snooze a thread for "1 hour", verify it disappears from INBOX, gets the `GmailOrganizer/Snoozed` label, appears in the snoozed list with ~1h remaining
- Wake a snoozed thread manually via "Wake now" — verify it returns to INBOX and is removed from the snoozed list
- Cancel a snoozed thread — same effect, different history entry source (`snooze-cancel`)
- Kill the service worker mid-snooze (chrome://serviceworker-internals → Stop), then cold-start — verify the alarm is re-registered
- Snooze a thread for 5+ minutes, wait, verify the alarm fires and the thread returns to INBOX automatically
- Custom datetime picker: pick a time 3 minutes from now (should error with "≥5 minutes"), then a valid time
- Summarize a long thread with Gemini configured — verify summary, key points, action items, participants, sentiment render correctly
- Summarize the same thread again — should be instant (cache hit within 24h)
- Clear summary cache, summarize again — should re-fetch
- Try summarize without Gemini configured — should show a clear error
- Priority inbox: click Scan, verify scores 0-100, reason chips, sorted desc
- Rate a few messages as Important / Not important, scan again, verify ratings influenced ranking
- Reset learning table, verify all feedback cleared
- Toggle each new feature flag in the Advanced section, verify the UI sections gracefully disable
- All v0.8.0 and v0.7.0 features still work (templates, analytics, dry-run, unsubscribe, incremental sync, etc.)

## Known limitations and v1.0 roadmap

**Not in this release:**

- **Send-later / scheduled send** — low-hanging fruit for v0.9.1
- **Canned reply templates** — useful for sales/support use cases
- **Large attachment finder / storage cleanup** — unique Gmail storage pain, nobody solves it well
- **Tracking pixel blocker** — would fit the privacy story but needs `declarativeNetRequest` permission which changes the OAuth consent screen
- **Task extraction** — turn an action item into a Todoist / Notion / calendar entry
- **Keyboard shortcuts** — power user delight
- **Unit tests, ESLint, bundle minification** — for v1.0 store release polish

**Known UX quirks:**

- Snooze picker is a fixed-position popover; on small popup windows it may clip at screen edges
- Summary modal is max-width 500px — fine for popup, might need breakpoints if you ever render it elsewhere
- Priority inbox feedback buttons mark the row as rated but don't re-sort the list in place — you need to click Scan again
- Passive learning from actions (`updateLearningFromActions`) has a placeholder implementation — it's wired to the history entry hook but doesn't fully parse all action types yet. Explicit Important/Not-important feedback works perfectly.

## Upgrade path from v0.8.0

Drop-in. Migration runs on install. All existing features preserved. New features are additive and flag-gated, so even if something misbehaves you can disable it in the Advanced panel without losing the rest.
