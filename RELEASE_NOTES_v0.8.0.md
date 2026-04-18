# Gmail Organizer v0.8.0 — Release Notes

v0.8.0 is the "powerful" release. It keeps all the reliability and security hardening from v0.7.0 and adds a wave of new capabilities across four directions: smarter AI rules, richer Gmail actions, analytics & insights, and power-user tooling.

## Smarter AI rules

### Natural-language rule editor
Type a plain-English description like "label receipts from amazon and apple as Receipts/Shopping, then archive them" and the extension parses it into a structured rule. Uses Gemini when configured, with a regex fallback so it still works offline. Parsed rules populate the form fields — no need to fight dropdowns. A confidence score shows how sure the parser is and whether AI or the fallback was used.

### Smart rule suggestions from your inbox
A new "Scan my inbox" button analyzes the last 500 messages, groups by sender domain, and proposes candidate rules for every domain with five or more messages. Gemini (when configured) cleans up the suggested rule names and picks reasonable labels. Review each suggestion and either add it with one click or dismiss it.

### Rich templates library (16 curated templates)
Browse a categorized library covering Newsletters, Receipts & Orders, Calendar & Meetings, Developer (GitHub, Stack Overflow), Travel, Finance, Marketing, and Social Media. One click adds the template to your rules. Search filters templates by name and description.

## More Gmail capabilities

### One-click unsubscribe
The existing unsubscribe scanner now has a real Unsubscribe button per sender. Behind the scenes it parses `List-Unsubscribe` and `List-Unsubscribe-Post` headers and handles three cases:

- **RFC 8058 one-click POST** — auto-submits the unsubscribe request, no user interaction needed
- **mailto:** — opens your email client pre-filled with the unsubscribe email
- **https:** — opens the provider's unsubscribe page in a new tab after confirmation

Never auto-opens account-related pages. Never sends emails on your behalf without your action.

### Thread-level rule execution
Rules already operated thread-first in v0.7.0 — v0.8.0 exposes the semantics clearly and is the foundation for planned v0.9.0 actions (snooze, auto-reply drafts, attachment handling).

## Analytics & insights

### New analytics dashboard
A full "Analytics" section in the options page with:

- **Four stat cards**: total organized, time saved (in human format — "2h 15m"), this week, this month
- **Top senders** with horizontal bars scaled by volume
- **Top labels** as colored pills
- **30-day daily trend** as an inline SVG bar chart (no charting library — tiny bundle)
- **Last 10 runs** as a compact table with timestamp, source, matched thread count, duration, and status
- **Quota indicator** showing Gmail API units used today

A "Refresh" button recalculates on demand. Time saved is computed at 15 seconds per organized message — configurable constant in the source.

### Per-rule performance badges
Every rule in the list now shows "N matches in 30d" once the dashboard loads. Tells you instantly which rules are pulling weight and which are dead.

## Power-user tooling

### Dry-run preview before saving a rule
Clicking Save on a new or edited rule now opens a preview modal showing how many of the last 50 inbox messages would match, plus the first five matches (from, subject, time). Warnings appear for zero matches ("no matches in recent inbox") and for overly broad rules (more than 25 matches). You can Save or Cancel back to edit. This closes the v0.7.0 gap.

### Rule templates picker (see above)

### Import/export rules
The existing import/export system from earlier releases is still there and now well-exercised by templates and suggestions.

## Performance (background.js)

### Incremental sync via `users.history.list`
The long-standing TODO from v0.7.0 is resolved. When `ff_incrementalSync` is on (default), each organize run calls Gmail's history endpoint starting from the last known `historyId` and processes only the delta. Full list fallback triggers when the history ID is too old (404), on first run, or when the flag is off. Dramatically reduces API quota usage on large inboxes.

New setting: `lastHistoryId` (stored in `chrome.storage.local`). New feature flag: `ff_incrementalSync`.

## New message handlers (background.js)

| Handler | Purpose |
|---|---|
| `testRule` | Dry-run preview — match a rule against recent messages without modifying anything |
| `getAnalytics` | Rich analytics payload for the dashboard |
| `unsubscribeFromSender` | Execute or return the unsubscribe action for a message |
| `suggestRulesFromInbox` | Propose rules based on inbox patterns |
| `parseNaturalLanguageRule` | Parse free-text into a structured rule |
| `getRuleTemplates` | Return the curated template library |
| `addRuleFromTemplate` | Copy a template into the user's rules |
| `getRulePerformance` | Per-rule stats (totals, last 30 days, avg per run) |

All handlers go through the existing dispatch switch, use `gmailRequest` / `fetchWithRetry` for Gmail API calls (so they inherit quota tracking, OAuth refresh, retries, and error taxonomy), and use `throttleGeminiCall` for any Gemini interactions.

## File changes

| File | v0.7.0 | v0.8.0 | Delta |
|---|---|---|---|
| manifest.json | 48 | 48 | version bump → 0.8.0 |
| background.js | 2001 | 2531 | +530 |
| popup.js | 975 | 1014 | +39 |
| options.js | 1196 | 1859 | +663 |
| popup.html | 232 | 232 | 0 |
| options.html | 400 | 497 | +97 |
| styles.css | 515 | 705 | +190 |

Unpacked bundle: ~356 KB — comfortably under any store limit.

## Testing checklist

Before zipping for the store:

- Upgrade from v0.7.0: settings, rules, history, feature flags all preserved
- Natural-language editor: type a description with Gemini configured, verify the form populates; disable Gemini, verify the regex fallback still works
- Smart suggestions: click "Scan my inbox" on an active account, verify domains appear with reasons, Add and Dismiss both work
- Template picker: open, search, add templates from 3 different categories, verify they show up in the rules list
- Dry-run preview: create a broad rule (should warn), create a narrow rule (should show matches), create a rule with no matches (should warn)
- Analytics dashboard: verify all 4 stat cards, top senders, top labels, daily trend SVG, last runs table, quota indicator render without errors on a fresh install (empty state) and an active install
- Per-rule badges: verify "N in 30d" badges appear after a moment on rules with history
- One-click unsubscribe: test against a newsletter with RFC 8058 header (should auto-POST), a mailto-only newsletter (should open mail client), an https-only newsletter (should confirm before opening tab)
- Incremental sync: run organize, verify `lastHistoryId` is saved to local; simulate an old historyId (manually set to an old value) and verify it falls back to full sync gracefully
- Run organize twice in rapid succession: v0.7.0 mutex still prevents double-runs
- All v0.7.0 Advanced section toggles still work, including the new `ff_incrementalSync` (add it to the UI manually or via `chrome.storage.sync.set`)

## Known limitations and v0.9.0 roadmap

**Deferred from v0.8.0** (not enough room for quality delivery):

- Snooze action (move to label, schedule return via alarms)
- Auto-reply drafts (create drafts, never auto-send)
- Attachment handling rules (save-to-drive, label-by-type)
- Sender reputation tracking with auto-categorization
- Advanced Gmail query builder UI
- Weekly digest notifications
- Unit tests and ESLint config

**Known UX quirks:**

- Dry-run preview modal intercepts Save; if you cancel, you stay in edit mode (intentional).
- Analytics SVG trend chart shows empty space for days without data (acceptable for a 30-day view).
- Performance badges load asynchronously after the rule list renders — there's a brief moment without badges.
- Natural-language parser populates the *last* empty rule card; if you have multiple empties, it may not target the one you expected.
- `ff_incrementalSync` UI toggle is not yet wired into the Advanced section — it's functional but you currently need to flip it via `chrome.storage.sync.set({ featureFlags: { ff_incrementalSync: false } })` if you want to force full sync for debugging. I'll add the toggle in v0.8.1.

## Upgrade path from v0.7.0

Drop-in upgrade. Migration runs automatically on install. All existing rules, history, settings, and feature flags are preserved. New features are additive — nothing is removed. All v0.7.0 handlers and behaviors still work.
