# Gmail Organizer — Market Research vs. Current Features
## Gap Analysis & Priority Roadmap

---

## 1. What Users Are Screaming About (Pain Points from Research)

| # | Pain Point | Competitors Failing At | Your Extension Today |
|---|-----------|----------------------|---------------------|
| 1 | **Unsubscribe doesn't actually work** | Clean Email ~70-85% success, SaneBox redirects to spam but doesn't remove you | ✅ Fixed — mailto auto-sent via Gmail API; 7-day verification confirms removal |
| 2 | **Rules don't apply to old emails** | Mailstrom, SaneBox — only works on new mail | ✅ Fixed — retroactive labeling now works |
| 3 | **Too expensive for what you get** | Superhuman $30/mo, SaneBox $7-36/mo, Clean Email $10/mo | ✅ Free / one-time (massive advantage) |
| 4 | **"My data is being mined"** | Mailstrom reads all email content, SaneBox trains on your habits on their servers | ✅ All processing local or your own Gemini key |
| 5 | **Slow sync / days behind** | Mailstrom known for slow processing | ✅ Runs on-demand, instant |
| 6 | **Label mess after using the tool** | Clean Email creates confusing folder structures | ✅ Clean Up Labels feature built |
| 7 | **Inbox zero is never actually achieved** | All tools help organize but inbox refills fast | ✅ Auto-run + Read Later category keeps inbox clear |
| 8 | **Can't bulk act on search results** | SaneBox, Mailstrom — limited batch actions | ✅ Built — ⚡ Bulk Action tool: search any query, preview matches, apply label/archive/trash to all |
| 9 | **No follow-up reminders** | Most tools ignore this entirely | ✅ Smart follow-up detection: scans sent mail, surfaces unanswered threads |
| 10 | **Poor customer support** | Superhuman notorious for ignoring power users | N/A — you set your own support standard |

---

## 2. What Users Most Want (Top Feature Requests)

| # | Feature | Users Asking For | Gap vs. Your Extension |
|---|---------|-----------------|----------------------|
| 1 | **AI auto-label with explanation** | "Why did it put this here?" | ✅ Built — "?" button per rule shows last 10 decisions with reason |
| 2 | **Reliable one-click unsubscribe** | 95%+ success rate, confirmed | ✅ Built — mailto auto-sent; 7-day verification confirms; `verified` field in log |
| 3 | **Read-Later folder** | Newsletters, long reads → save for later | ✅ Built — `Reading/Saved` category + 📖 popup tool button |
| 4 | **Smart follow-up reminders** | "If no reply in 3 days, remind me" | ✅ Built — scans sent, labels `Action/Follow Up`, shown in popup |
| 5 | **Multi-condition rules** | `FROM + SUBJECT + has:attachment` | ✅ Built — `hasAttachment` checkbox in rule editor; `has:attachment` in Gmail query |
| 6 | **Daily digest email summary** | "Tell me what I missed" | ✅ Built — 8am Chrome notification with organized count, unsubs, unread |
| 7 | **Undo any action easily** | "I mislabeled 200 emails, fix it" | ✅ Undo last run exists |
| 8 | **Attachment detection in rules** | `has:attachment AND from:boss` | ✅ Built — checkbox in rule editor, `buildRuleQuery` adds `has:attachment` |
| 9 | **Priority inbox that actually works** | Surface genuinely important emails first | ✅ Built — importance scoring with user feedback |
| 10 | **"Black hole" for senders** | Block + unsubscribe + auto-trash new ones | ✅ Built — ☠️ Block button per sender in unsub modal; auto-trash rule + retroactive trash |

---

## 3. Your Extension vs. Top 5 Competitors

| Feature | **Your Extension** | Clean Email | SaneBox | Mailstrom | Superhuman |
|---------|-------------------|-------------|---------|-----------|------------|
| Price | **Free** | $10/mo | $7-36/mo | $5/mo | $30/mo |
| Privacy (local processing) | **✅ Yes** | ❌ Cloud | ❌ Cloud | ❌ Cloud | ❌ Cloud |
| Retroactive bulk labeling | **✅ Yes** | ✅ Yes | ❌ No | ✅ Yes | ❌ No |
| AI label generation | **✅ Gemini** | ⚠️ Basic | ⚠️ Basic | ❌ None | ✅ GPT-4 |
| Thread summaries | **✅ Yes** | ❌ No | ❌ No | ❌ No | ✅ Yes |
| Snooze | **✅ Yes** | ✅ Yes | ✅ Yes | ❌ No | ✅ Yes |
| Analytics | **✅ Yes** | ✅ Yes | ❌ No | ✅ Yes | ❌ No |
| Reliable unsubscribe | **✅ Auto-sent + 7-day verified** | ⚠️ ~80% | ⚠️ ~75% | ⚠️ ~70% | ❌ No |
| Works in Gmail (no new app) | **✅ Yes** | ❌ New UI | ✅ Yes | ❌ New UI | ❌ New UI |
| Label cleanup | **✅ Yes** | ✅ Yes | ❌ No | ❌ No | ❌ No |
| Preview before applying | **✅ Yes** | ❌ No | ❌ No | ❌ No | ❌ No |
| Export/import settings | **✅ Yes** | ❌ No | ❌ No | ❌ No | ❌ No |
| AI explains labeling decisions | **✅ Yes** | ❌ No | ❌ No | ❌ No | ❌ No |
| Read Later queue | **✅ Yes** | ❌ No | ❌ No | ❌ No | ❌ No |
| has:attachment rule condition | **✅ Yes** | ❌ No | ❌ No | ❌ No | ❌ No |
| Daily digest notification | **✅ Yes** | ❌ No | ❌ No | ❌ No | ❌ No |
| Inbox score with breakdown | **✅ Yes** | ❌ No | ❌ No | ❌ No | ❌ No |

**You are already winning on: price, privacy, transparency (preview mode), AI quality, and verified unsubscribe.**

---

## 4. Priority Improvements — Status

### 🔴 CRITICAL

#### ✅ 4.1 Verified Unsubscribe — COMPLETE
- `mailto:` unsubscribes are auto-sent via Gmail API (`/messages/send`) — no user action needed
- Returns `verified: true` immediately for mailto; `verified: 'posted'` for RFC 8058 one-click POST
- 7-day verification alarm: `_runUnsubVerification()` checks if sender still sends; marks `verified: 'confirmed'` or `verified: 'failed'`
- Unsubscribe log stored in `chrome.storage.local` key `unsubscribeLog`

---

#### ✅ 4.2 "Why was this labeled?" Tooltip — COMPLETE
- Every label applied in `organizeInboxWithRules` stores `{ threadId, label, reason, ruleId, from, subject, timestamp }` via `_storeLabelDecision()`
- Popup rules list: each rule has a `?` button → `showLabelDecisionsModal()` shows last 10 decisions with subject, from, reason, timestamp
- Max 300 entries in `labelDecisionLog` (≈ ~50KB)

---

### 🟡 HIGH VALUE

#### ✅ 4.3 Read-Later Label — COMPLETE
- `reading-later` category added to `CAT_MATCH_PATTERNS`, `CAT_LABELS`, `CAT_DEFAULT_IDS` in `background.js`
- Matches Substack, Beehiiv, Ghost, Medium, Mailchimp, ConvertKit, digest emails, newsletter keywords
- Action: auto-archive → `Reading/Saved` label
- Popup: 📖 Read Later button → `runReadLaterScan()` → queue modal with count + unread badge
- Options page: `reading-later` added to `CAT_DEFINITIONS` with correct match patterns

---

#### ✅ 4.4 Smart Follow-Up Detection — COMPLETE
- `autoLabelFollowUps()` scans `SENT` label for threads older than N days with only 1 message (no reply)
- Labels them `Action/Follow Up` automatically
- Popup: "To reply" tool button scans and shows modal; "Label all as Action/Follow Up" bulk button in modal

---

#### ✅ 4.5 Sender "Black Hole" — COMPLETE
- `blockSender(opts)` creates auto-trash rule + retroactively trashes all emails + attempts unsubscribe
- Exposed in popup unsub modal: ☠️ Block button per sender row
- Confirms with count of trashed emails

---

### 🟢 QUICK WINS

#### ✅ 4.6 Attachment Rule Condition — COMPLETE
- `hasAttachment` checkbox added to rule editor in `options.html` / `options.js`
- `collectRules()` includes `hasAttachment: true` in `match` object when checked
- `buildRuleQuery()` in `background.js` appends `has:attachment` to Gmail search query when `rule.match.hasAttachment === true`

---

#### ✅ 4.7 Inbox Score Explanation — COMPLETE
- `getInboxScore()` returns `breakdown` array: `[{ label, value, penalty }]`
- Popup: clicking score arc shows tooltip with penalty breakdown per factor
- "Close" button + click-outside dismissal

---

#### ✅ 4.8 Daily Email Digest — COMPLETE
- `sendDailyDigest()`: Chrome notification at 8am with count of organized, unsubscribed, unread
- `scheduleDailyDigestAlarm()`: schedules `gmailOrganizerDailyDigest` alarm — daily at 8am
- Called in both `onInstalled` and `onStartup` handlers
- `alarms.onAlarm` handler routes `gmailOrganizerDailyDigest` → `sendDailyDigest()`
- Respects `settings.dailyDigestEnabled` flag (default: on)

---

#### ✅ 4.9 Better Unread Count in Badge — COMPLETE
- `updateBadgeCount()` calls `getInboxScore()` and sets `chrome.action.setBadgeText` with unread count
- Alarm `gmailOrganizerBadgeUpdate` fires every 15 minutes
- Badge cleared when count is 0

---

## 5. Build Order — Completed

```
✅ Week 1-2: Verified Unsubscribe (4.1) + 7-day verification
✅ Week 2:   "Why was this labeled?" tooltip (4.2)
✅ Week 3:   Smart Follow-Up Detection (4.4)
✅ Week 3:   Sender Black Hole (4.5)
✅ Week 4:   Read-Later Label (4.3) — category + popup tool
✅ Week 4:   Attachment rule condition (4.6)
✅ Ongoing:  Inbox score explanation (4.7), daily digest (4.8), badge count (4.9)
```

**All Section 4 items are now complete.**

---

## 6. Your Unique Selling Points to Emphasize

These are things NO competitor can match. Lead with them:

1. **100% free** — no subscription, no credit card
2. **Your data never leaves your browser** — Gemini only sees what you explicitly send it
3. **Preview before applying** — see exactly what will change before confirming
4. **Works inside Gmail** — no new app to learn, no email client to switch to
5. **Retroactive** — labels all your existing 5,000 emails, not just new ones
6. **Open rules** — export, share, import rule sets with others
7. **AI that explains itself** — "?" button shows exactly why each email was labeled
8. **Verified unsubscribe** — mailto auto-sent; 7-day check confirms you're actually removed
9. **Read Later queue** — newsletters auto-archived, accessible from popup
10. **Attachment-aware rules** — `FROM boss AND has:attachment` works out of the box

---

*Last updated: 2026-04-18 | Version 2.0.0 — All items complete including ad-hoc bulk action*
