// Gmail Organizer v0.9.3 — snooze, thread summaries, priority inbox

const API_BASE = "https://us-central1-organizer-f5aa8.cloudfunctions.net";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const AUTO_RUN_ALARM = "gmailOrganizerAutoRun";
const AUTO_EMPTY_TRASH_ALARM = "gmailOrganizerEmptyTrash";
const HISTORY_LIMIT = 20;
const SETTINGS_VERSION = 3;
const NOTIFICATION_TARGETS_KEY = "notificationTargets";
const AI_SECRETS_KEY = "aiSecrets";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";
const LEGACY_DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const EXCLUDED_COMMON_DOMAINS = [
  "gmail.com", "google.com", "yahoo.com", "outlook.com", "hotmail.com",
  "icloud.com", "mail.com", "protonmail.com", "me.com"
];
const LEGACY_DAILY_ROUTINE_INSTRUCTIONS = "1. Run Preview first and review all matched emails.\n2. Apply inbox rules only when the preview looks correct.\n3. Keep work, client, banking, receipt, and personal important emails safe and visible.\n4. Archive routine updates that do not need action.\n5. Trash only obvious low-value promotions and repetitive marketing emails.\n6. Review the latest run summary and check emails needing follow-up.\n7. Use Undo latest run immediately if anything important was moved incorrectly.\n8. Enable auto-run only after several successful manual test runs.";
const RESERVED_GMAIL_LABEL_ROOTS = [
  "inbox", "trash", "spam", "sent", "drafts", "important", "starred",
  "chats", "all mail", "scheduled", "snoozed", "bin"
];
const GEMINI_RULES_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    rules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          label: { type: "string" },
          action: { type: "string", enum: ["label", "archive", "trash"] },
          color: { type: "string" },
          match: {
            type: "object",
            properties: {
              fromDomains: { type: "array", items: { type: "string" } },
              fromIncludes: { type: "array", items: { type: "string" } },
              subjectIncludes: { type: "array", items: { type: "string" } }
            },
            required: ["fromDomains", "fromIncludes", "subjectIncludes"]
          }
        },
        required: ["name", "label", "action", "match"]
      }
    }
  },
  required: ["rules"]
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Run up to `concurrency` async tasks at a time over an array of items.
// Returns an array of results in the same order (null on error).
async function parallelMap(items, fn, concurrency) {
  if (!items || !items.length) return [];
  concurrency = Math.min(concurrency || 10, items.length);
  var results = new Array(items.length).fill(null);
  var idx = 0;
  async function worker() {
    while (true) {
      var i = idx++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i); } catch (e) { results[i] = null; }
    }
  }
  var workers = [];
  for (var w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// Timestamped console logger — prefix every log with ISO timestamp for easier debugging
function tsLog(level, ...args) {
  const ts = new Date().toISOString();
  if (level === 'error') { console.error('[gmail-organizer]', ts, ...args); }
  else if (level === 'warn') { console.warn('[gmail-organizer]', ts, ...args); }
  else { console.log('[gmail-organizer]', ts, ...args); }
}

// Run mutex (prevent concurrent organizeInbox, emptyTrash runs)
const RUN_MUTEX_KEY = 'runMutex';
const RETRO_MUTEX_KEY = 'retroMutex'; // separate key so retroactive runs don't block inbox runs
const RUN_MUTEX_STALE_MS = 10 * 60 * 1000; // 10 minutes

async function _acquireMutex(key, type) {
  const current = await chrome.storage.local.get({ [key]: null });
  const existing = current[key];
  if (existing && existing.startedAt) {
    const age = Date.now() - new Date(existing.startedAt).getTime();
    if (age < RUN_MUTEX_STALE_MS) {
      throw new Error('Another run is already in progress. Please wait for it to finish or try again in a few minutes.');
    }
    console.warn('[gmail-organizer] stale mutex cleared:', key, 'age ms:', age);
  }
  const runId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
  await chrome.storage.local.set({ [key]: { runId, type, startedAt: new Date().toISOString() } });
  return runId;
}

async function _releaseMutex(key, runId) {
  const current = await chrome.storage.local.get({ [key]: null });
  if (current[key] && current[key].runId === runId) {
    await chrome.storage.local.remove(key);
  }
}

async function acquireRunMutex(type) { return _acquireMutex(RUN_MUTEX_KEY, type); }
async function releaseRunMutex(runId) { return _releaseMutex(RUN_MUTEX_KEY, runId); }
async function acquireRetroMutex(type) { return _acquireMutex(RETRO_MUTEX_KEY, type); }
async function releaseRetroMutex(runId) { return _releaseMutex(RETRO_MUTEX_KEY, runId); }

// History max entries and pruning
const HISTORY_MAX_ENTRIES = 500;

async function pruneHistory() {
  const h = await getHistory();
  const now = Date.now();
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  const pruned = h.filter(entry => {
    if (!entry.timestamp) return true;
    const entryTime = new Date(entry.timestamp).getTime();
    return (now - entryTime) < ninetyDaysMs;
  }).slice(0, HISTORY_MAX_ENTRIES);
  if (pruned.length < h.length) {
    await chrome.storage.local.set({ runHistory: pruned });
  }
}

// Storage quota check for rules
async function checkRulesStorageQuota(rules) {
  const serialized = JSON.stringify(rules || []);
  const bytes = new TextEncoder().encode(serialized).length;
  const QUOTA_ITEM = chrome.storage.sync.QUOTA_BYTES_PER_ITEM || 8192;
  const QUOTA_TOTAL = chrome.storage.sync.QUOTA_BYTES || 102400;
  return {
    bytes,
    perItemLimit: QUOTA_ITEM,
    totalLimit: QUOTA_TOTAL,
    exceedsItem: bytes > QUOTA_ITEM * 0.9, // warn at 90%
    exceedsTotal: bytes > QUOTA_TOTAL * 0.9
  };
}

// Gemini rate limiter (2s between calls – conservative but not sluggish)
const geminiRateLimit = { lastCallAt: 0, minIntervalMs: 2000 };

async function throttleGeminiCall() {
  const now = Date.now();
  const elapsed = now - geminiRateLimit.lastCallAt;
  if (elapsed < geminiRateLimit.minIntervalMs) {
    await sleep(geminiRateLimit.minIntervalMs - elapsed);
  }
  geminiRateLimit.lastCallAt = Date.now();
}

// Timezone helpers
function getCurrentTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function nextOccurrenceAtLocalTime(hours, minutes) {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime(); // ms until next occurrence
}

// Error translation for user-facing messages
function translateGmailError(status, body, defaultMsg) {
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body || {});
  if (status === 401) return 'Your Gmail session has expired. Please re-authorize in settings.';
  if (status === 403) {
    if (/quota|rate/i.test(bodyText)) return 'Gmail API quota reached. The extension will resume automatically tomorrow.';
    if (/insufficientPermissions|scope/i.test(bodyText)) return 'Gmail denied access. Please re-authorize with the required permissions.';
    return 'Gmail denied the request. Please check your account permissions.';
  }
  if (status === 429) return 'Gmail is rate limiting requests. Waiting a moment and retrying...';
  if (status >= 500 && status < 600) return 'Gmail is temporarily unavailable. We will retry in a few minutes.';
  if (status === 404) return 'The email or label was not found. It may have been moved or deleted.';
  if (status === 0 || !status) return 'No internet connection. Please check your network and try again.';
  return defaultMsg || ('Gmail returned an unexpected error (' + status + '). Please try again.');
}

// Error telemetry (collect locally only, no server send)
async function logAnonymousError(errorType, context) {
  const settings = await getSettings().catch(() => ({}));
  if (!settings.errorTelemetryEnabled) return;

  const sanitized = {
    errorType: String(errorType || ''),
    status: context && context.status ? Number(context.status) : null,
    functionName: context && context.functionName ? String(context.functionName) : '',
    featureFlags: context && context.featureFlags ? Object.assign({}, context.featureFlags) : {}
  };

  const buf = await chrome.storage.local.get({ errorTelemetryBuffer: [] });
  const buffer = Array.isArray(buf.errorTelemetryBuffer) ? buf.errorTelemetryBuffer : [];
  buffer.push({
    timestamp: new Date().toISOString(),
    ...sanitized
  });
  await chrome.storage.local.set({ errorTelemetryBuffer: buffer.slice(-100) });
}

async function fetchWithRetry(url, options, maxAttempts = 5) {
  const baseDelays = [500, 1000, 2000, 4000, 8000];
  let currentToken = null;
  let tokenRefreshAttempted = false;

  for (let i = 0; i < maxAttempts; i++) {
    const r = await fetch(url, options);

    // Handle 401: try to refresh token once
    if (r.status === 401 && !tokenRefreshAttempted && options && options.headers && options.headers.Authorization) {
      tokenRefreshAttempted = true;
      try {
        // Extract current token from Authorization header
        const authHeader = options.headers.Authorization || '';
        const tokenMatch = authHeader.match(/Bearer\s+(\S+)/);
        if (tokenMatch && tokenMatch[1]) {
          currentToken = tokenMatch[1];
          chrome.identity.removeCachedAuthToken({ token: currentToken }).catch(() => {});
          // Get fresh token without interactive prompt
          const freshToken = await new Promise((resolve) => {
            chrome.identity.getAuthToken({ interactive: false }, (token) => resolve(token || null));
          });
          if (freshToken) {
            // Retry with new token
            const newOptions = Object.assign({}, options, {
              headers: Object.assign({}, options.headers, { Authorization: 'Bearer ' + freshToken })
            });
            const retryR = await fetch(url, newOptions);
            if (retryR.status !== 401) {
              return retryR;
            }
            // Still 401 after refresh — permission was likely revoked
            throw new Error('Gmail access was revoked. Please click "Reset sign-in" in the extension settings to re-authorize.');
          } else {
            // No fresh token available — user needs to re-authorize interactively
            throw new Error('Gmail session expired. Please click "Reset sign-in" in the extension settings to sign back in.');
          }
        }
      } catch (refreshErr) {
        if (refreshErr.message && refreshErr.message.includes('revoked')) throw refreshErr;
        console.error('[gmail-organizer] Token refresh failed:', refreshErr && refreshErr.message);
        throw new Error('Gmail session expired. Please click "Reset sign-in" in the extension settings to sign back in.');
      }
    }

    if ((r.status === 429 || r.status >= 500) && i < maxAttempts - 1) {
      let delayMs = baseDelays[i] || 8000;
      // Check for Retry-After header on 429
      if (r.status === 429) {
        const retryAfter = r.headers.get('Retry-After');
        if (retryAfter) {
          delayMs = Math.max(delayMs, parseInt(retryAfter) * 1000);
        }
      }
      // Add jitter: random 0-250ms
      delayMs += Math.random() * 250;
      await sleep(delayMs);
      continue;
    }
    return r;
  }
  throw new Error("Request failed before a response was returned.");
}

async function trackQuotaUnit(units) {
  const now = Date.now();
  if (now - gmailQuota.windowStart > gmailQuota.WINDOW_MS) {
    gmailQuota.windowStart = now;
    gmailQuota.used = 0;
  }
  gmailQuota.used += units;
  if (gmailQuota.used > gmailQuota.LIMIT) {
    const sleepMs = gmailQuota.WINDOW_MS - (now - gmailQuota.windowStart) + 100;
    if (sleepMs > 0) {
      await sleep(sleepMs);
      gmailQuota.windowStart = Date.now();
      gmailQuota.used = units;
    }
  }
}

async function getFeatureFlag(name, defaultValue) {
  const s = await chrome.storage.sync.get({ featureFlags: {} });
  const flags = s.featureFlags || {};
  // Always return a boolean — prevents truthy/falsy edge cases from corrupted storage
  const value = flags.hasOwnProperty(name) ? flags[name] : defaultValue;
  return Boolean(value);
}

// Optional "tabs" permission helpers. The tabs permission is declared as
// optional in the manifest so first-install OAuth consent stays minimal.
// It's only needed for the debounced auto-run feature which checks if
// Gmail is currently the active tab.
async function hasTabsPermission() {
  try {
    if (!chrome.permissions || !chrome.permissions.contains) return false;
    return await chrome.permissions.contains({ permissions: ['tabs'] });
  } catch (_) {
    return false;
  }
}

async function requestTabsPermission() {
  try {
    if (!chrome.permissions || !chrome.permissions.request) {
      return { granted: false, reason: 'permissions_api_unavailable' };
    }
    const granted = await chrome.permissions.request({ permissions: ['tabs'] });
    return { granted: Boolean(granted) };
  } catch (err) {
    return { granted: false, reason: (err && err.message) || 'request_failed' };
  }
}

async function removeTabsPermission() {
  try {
    if (!chrome.permissions || !chrome.permissions.remove) return { removed: false };
    const removed = await chrome.permissions.remove({ permissions: ['tabs'] });
    return { removed: Boolean(removed) };
  } catch (err) {
    return { removed: false, reason: (err && err.message) || 'remove_failed' };
  }
}

async function gmailBatchModify(token, ids, addLabelIds, removeLabelIds) {
  // PRIVACY: Only send aggregate metadata to Gemini, never raw email bodies or full subjects.
  if (!ids || ids.length === 0) return;

  const enabled = await getFeatureFlag('ff_batchModify', true);
  if (!enabled) {
    // Fallback: use single-message modify
    for (let i = 0; i < ids.length; i++) {
      await fetch(GMAIL_API_BASE + "/messages/" + ids[i] + "/modify", {
        method: "POST",
        headers: buildHeaders(token),
        body: JSON.stringify({ addLabelIds: addLabelIds, removeLabelIds: removeLabelIds })
      });
      await trackQuotaUnit(5);
    }
    return;
  }

  // Use batch modify in chunks of 1000
  const chunkSize = 1000;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const r = await fetchWithRetry(GMAIL_API_BASE + "/messages/batchModify", {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify({
        ids: chunk,
        addLabelIds: addLabelIds,
        removeLabelIds: removeLabelIds
      })
    });
    await trackQuotaUnit(10);
    if (!r.ok) throw new Error("batchModify failed: " + r.status);
  }
}

const GMAIL_LABEL_COLORS = {
  "#4a86e8": "#ffffff", "#6d9eeb": "#ffffff", "#3c78d8": "#ffffff", "#285bac": "#ffffff",
  "#fb4c2f": "#ffffff", "#e66550": "#ffffff", "#cc3a21": "#ffffff",
  "#16a765": "#ffffff", "#44b984": "#000000", "#43d692": "#000000", "#149e60": "#ffffff",
  "#fad165": "#000000", "#f2c960": "#000000", "#ffad47": "#000000",
  "#a479e2": "#ffffff", "#b694e8": "#ffffff", "#8e63ce": "#ffffff",
  "#f691b3": "#000000", "#999999": "#ffffff", "#666666": "#ffffff",
};

function getLabelTextColor(bg) {
  return GMAIL_LABEL_COLORS[(bg || "").toLowerCase()] || "#ffffff";
}

// Auto-assign a color based on the top-level label category
function getCategoryColor(labelName) {
  var parent = (labelName || '').split('/')[0].toLowerCase();
  var map = {
    'work':     '#4a86e8', // blue
    'finance':  '#16a765', // green
    'shopping': '#ffad47', // orange
    'updates':  '#666666', // gray
    'social':   '#a479e2', // purple
    'reading':  '#6d9eeb', // light blue
    'travel':   '#44b984', // teal
    'marketing':'#f691b3', // pink (legacy)
  };
  return map[parent] || null;
}

const RULE_PRESETS = [
  {
    id: "preset-dev", name: "Development & Code", label: "Work/Dev", color: "#4a86e8", action: "archive",
    description: "GitHub, GitLab, CI/CD notifications.",
    match: { fromDomains: ["github.com","gitlab.com","bitbucket.org","circleci.com","vercel.com","netlify.com"], fromIncludes: ["noreply@github.com","notifications@gitlab.com"], subjectIncludes: ["pull request","code review","pipeline","deployment","build failed","build passed"] }
  },
  {
    id: "preset-receipts", name: "Receipts & Billing", label: "Finance/Receipts", color: "#16a765", action: "archive",
    description: "Receipts, invoices, and payment confirmations.",
    match: { fromDomains: ["stripe.com","paypal.com","paddle.com","gumroad.com","lemonsqueezy.com"], fromIncludes: ["receipt","billing","invoice","payment"], subjectIncludes: ["receipt","invoice","payment confirmation","order confirmation","subscription renewal"] }
  },
  {
    id: "preset-banking", name: "Banking & Alerts", label: "Finance/Payments", color: "#fb4c2f", action: "label",
    description: "Bank alerts, security warnings.",
    match: { fromDomains: ["citi.com","chase.com","wellsfargo.com","bankofamerica.com","hsbc.com","boursorama.com","fortuneo.fr","lcl.fr","bnpparibas.fr","societegenerale.fr","accounts.google.com","accountprotection.microsoft.com","appleid.apple.com","paypal.com"], fromIncludes: ["alert@","account-security-noreply","no-reply@account","security-noreply","noreply@accounts.google.com"], subjectIncludes: ["security alert","alerte de s\u00e9curit\u00e9","unusual activity","fraud","account suspended","verify your","login attempt","2-step","connexion","la m\u00e9thode de connexion"] }
  },
  {
    id: "preset-newsletters", name: "Newsletters", label: "Reading/Newsletter", color: "#fad165", action: "archive",
    description: "Newsletters and digests.",
    match: { fromDomains: ["substack.com","beehiiv.com","mail.beehiiv.com","convertkit.com","mailchimp.com","buttondown.email"], fromIncludes: ["newsletter","digest","weekly roundup"], subjectIncludes: ["newsletter","weekly roundup","digest","edition","issue #","monthly recap"] }
  },
  {
    id: "preset-shopping", name: "Shopping & Orders", label: "Shopping/Orders", color: "#ffad47", action: "archive",
    description: "Orders, shipping, delivery tracking.",
    match: { fromDomains: ["amazon.com","amazon.fr","amazon.co.uk","aliexpress.com","ebay.com","etsy.com","zalando.com","cdiscount.com","fnac.com"], fromIncludes: ["noreply@amazon","no-reply@amazon","shipment","tracking","delivery"], subjectIncludes: ["order confirmed","your order","has been shipped","out for delivery","delivered","tracking number"] }
  },
  {
    id: "preset-social", name: "Social & Notifications", label: "Social/Notifications", color: "#a479e2", action: "archive",
    description: "Social media alerts.",
    match: { fromDomains: ["twitter.com","x.com","linkedin.com","facebook.com","instagram.com","youtube.com","reddit.com","redditmail.com","discord.com","quora.com","medium.com","tiktok.com","pinterest.com"], fromIncludes: ["noreply@twitter","noreply@linkedin","noreply@facebook","noreply@reddit","notification"], subjectIncludes: ["mentioned you","tagged you","liked your","commented on","new follower","connection request","trending on","upvoted"] }
  },
  {
    id: "preset-travel", name: "Travel & Bookings", label: "Travel/Bookings", color: "#43d692", action: "label",
    description: "Flights, hotels, travel confirmations.",
    match: { fromDomains: ["booking.com","airbnb.com","expedia.com","skyscanner.com","hotels.com","uber.com","ryanair.com","easyjet.com","sncf.fr"], fromIncludes: ["reservation","booking","itinerary","boarding"], subjectIncludes: ["booking confirmation","reservation confirmed","your trip","flight confirmation","hotel booking","boarding pass"] }
  },
  {
    id: "preset-jobs", name: "Jobs & Recruiting", label: "Career/Applications", color: "#6d9eeb", action: "label",
    description: "Job applications, recruiters.",
    match: { fromDomains: ["greenhouse.io","lever.co","ashbyhq.com","workday.com","smartrecruiters.com","welcometothejungle.com"], fromIncludes: ["recruiter","talent","careers@","hr@"], subjectIncludes: ["job opportunity","application received","interview","next steps","your application"] }
  },
  {
    id: "preset-saas", name: "SaaS & App Updates", label: "Updates/Apps", color: "#b694e8", action: "archive",
    description: "Product updates, SaaS alerts.",
    match: { fromDomains: ["notion.so","figma.com","airtable.com","asana.com","trello.com","monday.com","clickup.com","linear.app","dropbox.com","zoom.us","slack.com","anthropic.com","openai.com","heroku.com","digitalocean.com"], fromIncludes: ["product update","release notes","team@"], subjectIncludes: ["what's new","product update","new feature","release notes","changelog","get better results","simplify your"] }
  },
  {
    id: "preset-promotions", name: "Promotions & Offers", label: "Promotions", color: "#f2c960", action: "archive",
    description: "Discounts, sales, offers.",
    match: { fromDomains: [], fromIncludes: ["marketing@","promo@","deals@","offers@","info@","hello@","contact@","noreply@"], subjectIncludes: ["% off","discount","sale","limited time","exclusive offer","promo code","coupon","flash sale","black friday","save now","last chance","never miss","don't miss","ne manquez pas","offre sp\u00e9ciale","est enfin arriv\u00e9","est disponible","votre essai"] }
  }
];

const RULE_TEMPLATE_LIBRARY = [
  {
    id: "tmpl-newsletters-substack", category: "Newsletters", name: "Substack & Beehiiv", description: "Auto-archive newsletters from Substack and Beehiiv",
    rule: { name: "Substack & Beehiiv", label: "Reading/Newsletters", action: "archive", color: "#fad165", match: { fromDomains: ["substack.com", "beehiiv.com", "mail.beehiiv.com"], fromIncludes: ["newsletter"], subjectIncludes: ["newsletter", "edition"] } }
  },
  {
    id: "tmpl-newsletters-mailchimp", category: "Newsletters", name: "Mailchimp & Email Newsletters", description: "Auto-archive email marketing newsletters",
    rule: { name: "Email Newsletters", label: "Reading/Newsletters", action: "archive", color: "#fad165", match: { fromDomains: ["mailchimp.com", "convertkit.com"], fromIncludes: ["newsletter", "digest"], subjectIncludes: ["newsletter", "weekly roundup", "digest"] } }
  },
  {
    id: "tmpl-newsletters-general", category: "Newsletters", name: "Weekly Digests & Roundups", description: "Archive any weekly digest or roundup email",
    rule: { name: "Weekly Digests", label: "Reading/Newsletters", action: "archive", color: "#fad165", match: { fromDomains: [], fromIncludes: ["roundup", "digest"], subjectIncludes: ["weekly", "digest", "roundup", "this week"] } }
  },
  {
    id: "tmpl-receipts-stripe", category: "Receipts & Orders", name: "Stripe & PayPal", description: "Label receipts from payment processors",
    rule: { name: "Payment Receipts", label: "Finance/Receipts", action: "label", color: "#16a765", match: { fromDomains: ["stripe.com", "paypal.com"], fromIncludes: ["receipt", "payment"], subjectIncludes: ["receipt", "payment confirmation"] } }
  },
  {
    id: "tmpl-receipts-ecommerce", category: "Receipts & Orders", name: "Amazon & E-commerce", description: "Label order receipts from online shopping",
    rule: { name: "Order Receipts", label: "Shopping/Receipts", action: "label", color: "#16a765", match: { fromDomains: ["amazon.com", "amazon.fr", "ebay.com"], fromIncludes: ["noreply@amazon", "order"], subjectIncludes: ["order confirmed", "your order"] } }
  },
  {
    id: "tmpl-receipts-delivery", category: "Receipts & Orders", name: "Shipping & Tracking", description: "Label shipping and delivery notifications",
    rule: { name: "Shipment Tracking", label: "Shopping/Shipping", action: "label", color: "#16a765", match: { fromDomains: [], fromIncludes: ["shipment", "tracking", "delivery"], subjectIncludes: ["shipped", "tracking", "delivery", "out for delivery"] } }
  },
  {
    id: "tmpl-calendar-google", category: "Calendar & Meetings", name: "Google Calendar Events", description: "Label calendar invites and meeting updates",
    rule: { name: "Calendar Events", label: "Calendar/Events", action: "label", color: "#5f9aff", match: { fromDomains: ["google.com"], fromIncludes: ["calendar"], subjectIncludes: ["invitation", "accepted", "event"] } }
  },
  {
    id: "tmpl-calendar-zoom", category: "Calendar & Meetings", name: "Zoom & Video Conferencing", description: "Label meeting links and join info",
    rule: { name: "Video Meetings", label: "Calendar/Meetings", action: "label", color: "#5f9aff", match: { fromDomains: ["zoom.us", "meet.google.com"], fromIncludes: ["meeting", "join"], subjectIncludes: ["join", "meeting", "call"] } }
  },
  {
    id: "tmpl-social-github", category: "Developer", name: "GitHub Notifications", description: "Archive GitHub issues, PRs, and notifications",
    rule: { name: "GitHub", label: "Work/Dev", action: "archive", color: "#4a86e8", match: { fromDomains: ["github.com"], fromIncludes: ["noreply@github.com"], subjectIncludes: ["pull request", "issue", "discussion"] } }
  },
  {
    id: "tmpl-social-stackoverflow", category: "Developer", name: "Stack Overflow & Dev Sites", description: "Archive development Q&A notifications",
    rule: { name: "Dev Communities", label: "Work/Dev", action: "archive", color: "#4a86e8", match: { fromDomains: ["stackoverflow.com", "stackexchange.com"], fromIncludes: ["notification"], subjectIncludes: ["answer", "question", "reputation"] } }
  },
  {
    id: "tmpl-travel-booking", category: "Travel", name: "Hotel & Flights", description: "Label travel reservation confirmations",
    rule: { name: "Travel Bookings", label: "Travel/Bookings", action: "label", color: "#43d692", match: { fromDomains: ["booking.com", "expedia.com", "hotels.com"], fromIncludes: ["reservation", "booking"], subjectIncludes: ["confirmation", "booking", "reservation"] } }
  },
  {
    id: "tmpl-travel-airlines", category: "Travel", name: "Airlines & Ground Transport", description: "Label flight and car rental reservations",
    rule: { name: "Flight & Transport", label: "Travel/Bookings", action: "label", color: "#43d692", match: { fromDomains: ["ryanair.com", "easyjet.com"], fromIncludes: ["booking", "itinerary"], subjectIncludes: ["flight", "booking", "boarding pass"] } }
  },
  {
    id: "tmpl-finance-banking", category: "Finance", name: "Bank Alerts & Statements", description: "Label bank alerts (NEVER archive or trash)",
    rule: { name: "Banking Alerts", label: "Finance/Payments", action: "label", color: "#fb4c2f", match: { fromDomains: ["chase.com", "bofa.com"], fromIncludes: ["alert", "security"], subjectIncludes: ["security alert", "alert", "verification"] } }
  },
  {
    id: "tmpl-promos-general", category: "Marketing/Promos", name: "All Promotions", description: "Archive discount and promotional emails",
    rule: { name: "Promotions", label: "Promotions", action: "archive", color: "#f2c960", match: { fromDomains: [], fromIncludes: ["promo@", "deals@", "marketing@"], subjectIncludes: ["% off", "sale", "discount", "limited time"] } }
  },
  {
    id: "tmpl-social-linkedin", category: "Social Media", name: "LinkedIn Notifications", description: "Archive LinkedIn activity notifications",
    rule: { name: "LinkedIn", label: "Social/Notifications", action: "archive", color: "#a479e2", match: { fromDomains: ["linkedin.com"], fromIncludes: ["noreply@linkedin"], subjectIncludes: ["profile", "connection", "message"] } }
  },
  {
    id: "tmpl-social-twitter", category: "Social Media", name: "Twitter/X Notifications", description: "Archive Twitter/X engagement notifications",
    rule: { name: "Twitter/X", label: "Social/Notifications", action: "archive", color: "#a479e2", match: { fromDomains: ["twitter.com", "x.com"], fromIncludes: ["noreply@twitter"], subjectIncludes: ["mentioned", "liked", "retweeted"] } }
  }
];

const DEFAULT_SETTINGS = {
  maxThreadsPerRun: 500,
  archiveMatches: false,
  onboardingComplete: false,
  autoRunEnabled: true,
  autoRunIntervalMinutes: 60,
  autoEmptyTrashEnabled: false,
  autoEmptyTrashIntervalMinutes: 10080,
  autoEmptyTrashOlderThanDays: 30,
  aiProvider: "local",
  geminiModel: DEFAULT_GEMINI_MODEL,
  aiInstructions: "Create one Work/Dev rule for all code platforms (GitHub, GitLab, Bitbucket, CI/CD) and archive them.\nCreate one Finance/Banking rule for all bank alerts, security warnings, and transaction confirmations — label only, never archive or trash.\nCreate one Finance/Receipts rule for all receipts, invoices, and payment confirmations from Stripe, PayPal, Amazon — label and archive.\nArchive newsletters, digests, and weekly roundups under Reading/Newsletters.\nArchive social notifications from LinkedIn, Twitter, Facebook, and Instagram under Social.\nTrash obvious promotional emails, flash sales, and repetitive marketing under Promotions.\nLabel travel bookings, flights, and hotel reservations under Travel.\nLabel job-related emails from recruiters and job boards under Jobs.\nArchive SaaS product updates and release notes under Updates.",
  dailyRoutineInstructions: "── Morning (daily) ──\n1. Open the extension and check your Inbox Score — aim for B or above.\n2. Run Preview to review matched emails before applying changes.\n3. If the preview looks correct, click Organize to apply rules.\n4. Check the run summary — verify scanned, matched, and action counts.\n5. Use Undo immediately if anything important was moved by mistake.\n\n── Weekly ──\n6. Run the Follow-Up scanner to catch emails waiting for a reply.\n7. Run the Unsubscribe scanner to find newsletters you no longer read.\n8. Preview and empty trash for emails older than 30 days.\n9. Review your rules and add new ones for any recurring uncategorized senders.\n\n── Monthly ──\n10. Run the Duplicate scanner to remove redundant threads.\n11. Export your settings as a backup before making major rule changes.\n12. Check if your Inbox Score trend has improved — adjust rules if below 70.\n\n── Safety reminders ──\n- Never trash banking, security alerts, receipts, or client emails — label only.\n- Keep thread limit at 25–50 during testing — raise only once rules are trusted.\n- Do not enable auto-run until you have completed at least 3 successful manual runs.",
  rules: [],
  errorTelemetryEnabled: false,
  rulesInLocal: false,
  lastTimeZone: null,
  lastHistoryId: null,
  dailyDigestEnabled: true
};

function clonePreset(p) {
  return Object.assign({}, p, {
    match: {
      fromDomains: p.match.fromDomains.slice(),
      fromIncludes: p.match.fromIncludes.slice(),
      subjectIncludes: p.match.subjectIncludes.slice()
    }
  });
}

const RECOMMENDED_PRESET_ACTIONS = {
  "preset-receipts": "archive",
  "preset-shopping": "archive"
};

const DEFAULT_RULES = RULE_PRESETS.map(function(p) {
  var r = clonePreset(p);
  if (RECOMMENDED_PRESET_ACTIONS[r.id]) r.action = RECOMMENDED_PRESET_ACTIONS[r.id];
  return r;
});
DEFAULT_SETTINGS.rules = DEFAULT_RULES;

// Service worker cold start marker
console.log('[gmail-organizer] sw_cold_start', Date.now());

// Module-level quota tracker (200 units/sec, leaving headroom under Google's 250/sec hard limit)
const gmailQuota = { windowStart: 0, used: 0, WINDOW_MS: 1000, LIMIT: 200 };

// Module-level label ID cache
const labelIdCache = new Map();

// Feature flags with defaults
const DEFAULT_FEATURE_FLAGS = {
  ff_batchModify: true,
  ff_quotaTracking: true,
  ff_cacheLabels: true,
  ff_debouncedAutoRun: true,
  ff_autoResume: true,
  ff_strictMinInterval: true,
  ff_telemetryOptIn: false,
  ff_incrementalSync: true,
  ff_snooze: true,
  ff_threadSummary: true,
  ff_priorityInbox: true
};

// Merge feature flags into DEFAULT_SETTINGS
DEFAULT_SETTINGS.featureFlags = DEFAULT_FEATURE_FLAGS;

// Default learning table for importance scoring
const DEFAULT_LEARNING = {
  frequentRepliers: {},
  starredSenders: {},
  lowImportanceSenders: {},
  userFeedback: {}
};

// Module-level helpers — must be outside the try block so they are
// accessible as true module-scope bindings in Chrome's strict ES module runtime.
function buildHeaders(token) {
  return { Authorization: "Bearer " + token, "Content-Type": "application/json" };
}

try {
  // Main initialization and event handlers

chrome.runtime.onInstalled.addListener(async (details) => {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set(current);

  if (details.reason === 'install') {
    await chrome.storage.sync.set({ onboardingComplete: false });
    await chrome.storage.local.set({ settingsVersion: SETTINGS_VERSION });
    try {
      await chrome.runtime.openOptionsPage();
    } catch (err) {
      console.warn('[gmail-organizer] Could not open options page:', err && err.message);
    }
  } else if (details.reason === 'update') {
    const previousVersion = details.previousVersion || '0.0.0';
    console.log('[gmail-organizer] Updated from', previousVersion, 'to current version');
    await migrateSettings(parseInt(previousVersion.split('.')[0]) || 0);
  }

  await loadLabelIdCache();
  await applyRecommendedPresetMigrations();
  await applyDefaultRulesMigration();
  await applyMiscategorizedDomainsFix();
  await applyDailyRoutineMigration();
  await applyGeminiModelMigration();
  await migrateSyncToLocalStorage();
  await syncAutoRunAlarm();
  await syncAutoEmptyTrashAlarm();
  await initializeLearningTable();
  await restoreSnoozeAlarms();
  await scheduleDailyDigestAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  await checkPendingCheckpoint();
  const autoResumeEnabled = await getFeatureFlag('ff_autoResume', true);
  if (autoResumeEnabled) {
    await resumeCheckpointedRunIfStale();
  }
  await loadLabelIdCache();
  await migrateSettings(0);
  await applyRecommendedPresetMigrations();
  await applyDefaultRulesMigration();
  await applyMiscategorizedDomainsFix();
  await applyDailyRoutineMigration();
  await applyGeminiModelMigration();
  await migrateSyncToLocalStorage();

  // Update timezone in settings
  const tz = getCurrentTimeZone();
  const s = await getSettings();
  if (s.lastTimeZone !== tz) {
    await chrome.storage.sync.set({ lastTimeZone: tz });
  }

  await syncAutoRunAlarm();
  await syncAutoEmptyTrashAlarm();
  await initializeLearningTable();
  await restoreSnoozeAlarms();
  // Register badge update alarm — refresh unread count every 15 minutes
  const existingBadgeAlarm = await chrome.alarms.get('gmailOrganizerBadgeUpdate');
  if (!existingBadgeAlarm) {
    chrome.alarms.create('gmailOrganizerBadgeUpdate', { delayInMinutes: 1, periodInMinutes: 15 });
  }
  updateBadgeCount().catch(function() {});
  await scheduleDailyDigestAlarm();
});

async function checkPendingCheckpoint() {
  const stored = await chrome.storage.local.get({ ruleRunCheckpoint: null });
  const checkpoint = stored.ruleRunCheckpoint;
  if (checkpoint && checkpoint.startedAt) {
    const elapsed = Date.now() - parseInt(checkpoint.startedAt);
    const tenMinutes = 10 * 60 * 1000;
    if (elapsed < tenMinutes) {
      console.warn('[gmail-organizer] Found pending checkpoint from', new Date(checkpoint.startedAt).toISOString(), '— runId:', checkpoint.runId, 'ruleId:', checkpoint.ruleId, 'processedCount:', checkpoint.processedCount);
    }
  }
}

async function resumeCheckpointedRunIfStale() {
  const stored = await chrome.storage.local.get({ ruleRunCheckpoint: null });
  const checkpoint = stored.ruleRunCheckpoint;
  if (!checkpoint || !checkpoint.startedAt || !checkpoint.runId) return;

  const elapsed = Date.now() - parseInt(checkpoint.startedAt);
  const tenMinutes = 10 * 60 * 1000;
  if (elapsed >= tenMinutes) return; // Only resume if checkpoint is fresh

  try {
    // Reuse the original runId to acquire mutex
    const mutex = { runId: checkpoint.runId, type: 'organize-resumed', startedAt: new Date().toISOString() };
    const current = await chrome.storage.local.get({ [RUN_MUTEX_KEY]: null });
    if (current[RUN_MUTEX_KEY]) {
      console.log('[gmail-organizer] Cannot resume: run already in progress');
      return;
    }

    await chrome.storage.local.set({ [RUN_MUTEX_KEY]: mutex });
    console.log('[gmail-organizer] Resuming checkpointed run:', checkpoint.runId);

    // TODO: implement actual checkpoint resume logic here
    // For now, just log and clear
    await clearRuleRunCheckpoint();
    await releaseRunMutex(checkpoint.runId);
  } catch (err) {
    console.error('[gmail-organizer] Resume failed:', err && err.message);
    await releaseRunMutex(checkpoint.runId).catch(() => {});
  }
}

async function loadLabelIdCache() {
  const cacheEnabled = await getFeatureFlag('ff_cacheLabels', true);
  if (!cacheEnabled) return;
  const stored = await chrome.storage.local.get({ labelIdCache: {} });
  const cacheObj = stored.labelIdCache || {};
  labelIdCache.clear();
  Object.keys(cacheObj).forEach(name => labelIdCache.set(name, cacheObj[name]));
}

async function saveRuleRunCheckpoint(runId, ruleId, lastProcessedMessageId, processedCount) {
  await chrome.storage.local.set({
    ruleRunCheckpoint: {
      runId: runId,
      ruleId: ruleId,
      lastProcessedMessageId: lastProcessedMessageId,
      processedCount: processedCount,
      startedAt: Date.now()
    }
  });
}

async function clearRuleRunCheckpoint() {
  await chrome.storage.local.set({ ruleRunCheckpoint: null });
}

async function migrateSettings(fromVersion) {
  const stored = await chrome.storage.local.get({ settingsVersion: 0 });
  const currentVersion = stored.settingsVersion || 0;
  if (currentVersion >= SETTINGS_VERSION) return;

  // 1 → 2: placeholder
  // 2 → 3: move aiSecrets from sync to local (handled in migrateSyncToLocalStorage)

  await chrome.storage.local.set({ settingsVersion: SETTINGS_VERSION });
}

async function migrateSyncToLocalStorage() {
  const syncData = await chrome.storage.sync.get({ [AI_SECRETS_KEY]: null });
  const aiSecrets = syncData[AI_SECRETS_KEY];
  if (aiSecrets) {
    // Copy from sync to local
    const localData = await chrome.storage.local.get({ [AI_SECRETS_KEY]: {} });
    const localSecrets = Object.assign({}, localData[AI_SECRETS_KEY] || {}, aiSecrets);
    await chrome.storage.local.set({ [AI_SECRETS_KEY]: localSecrets });
    // Delete from sync
    await chrome.storage.sync.remove([AI_SECRETS_KEY]);
    console.log('[gmail-organizer] Migrated aiSecrets from sync to local');
  }
}

async function pruneUndoHistory() {
  const history = await getHistory();
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const pruned = history.filter(entry => {
    if (!entry.timestamp) return true;
    const entryTime = new Date(entry.timestamp).getTime();
    return (now - entryTime) < dayMs;
  });
  if (pruned.length < history.length) {
    await replaceHistory(pruned);
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'gmailOrganizerBadgeUpdate') {
    updateBadgeCount().catch(function() {});
    return;
  }
  if (alarm.name === 'gmailOrganizerDailyDigest') {
    sendDailyDigest().catch(function() {});
    return;
  }
  if (alarm.name === 'gmailOrganizerUnsubVerify') {
    _runUnsubVerification().catch(function() {});
    return;
  }
  if (alarm.name === AUTO_EMPTY_TRASH_ALARM) {
    try { await emptyTrash({ dryRun: false, source: "auto" }); } catch (e) { console.error("Auto trash error:", e); }
    return;
  }
  if (alarm.name && alarm.name.startsWith("snooze-wake-")) {
    const threadId = alarm.name.slice("snooze-wake-".length);
    try { await wakeSnoozedThread(threadId); } catch (e) { console.error("Snooze wake error:", e); }
    return;
  }
  if (alarm.name !== AUTO_RUN_ALARM) return;
  try {
    // Debounced auto-run: check if Gmail tab is active and defer if so.
    // Requires the optional "tabs" permission. If not granted, silently skip
    // the debounce check and proceed with the run.
    const debouncedAutoRun = await getFeatureFlag('ff_debouncedAutoRun', true);
    if (debouncedAutoRun && await hasTabsPermission()) {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0 && tabs[0].url && tabs[0].url.includes('mail.google.com')) {
          // Gmail is active; defer by rescheduling 5 minutes out
          const s = await getSettings();
          await chrome.alarms.clear(AUTO_RUN_ALARM);
          chrome.alarms.create(AUTO_RUN_ALARM, { delayInMinutes: 5, periodInMinutes: s.autoRunIntervalMinutes });
          return;
        }
      } catch (err) {
        // Permission was revoked between check and query, or tabs API threw.
        // Fall through and run normally.
        console.warn('[gmail-organizer] debounce check failed, running anyway:', err && err.message);
      }
    }
    // Check access before auto-run — prevents free/expired users from getting unlimited runs
    try {
      await checkAccessOrThrow();
    } catch (accessErr) {
      if (accessErr.message === 'UPGRADE_REQUIRED') {
        console.warn('[gmail-organizer] Auto-run skipped: upgrade required for', accessErr.upgradeEmail);
        return;
      }
      // Backend unreachable — allow auto-run to proceed rather than silently failing users
      console.warn('[gmail-organizer] Access check failed during auto-run, proceeding anyway:', accessErr.message);
    }
    const _autoEmail = await getUserEmail().catch(() => null);
    const result = await organizeInbox({ dryRun: false, source: "auto" });
    if (_autoEmail) await consumeCredit(_autoEmail);
  } catch (error) {
    await appendHistoryEntry({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), source: "auto", status: "error", summary: error.message || String(error), scannedThreads: 0, matchedThreads: 0, actions: [] });
  }
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  let url = "https://mail.google.com/mail/u/0/#inbox";
  if (notificationId.indexOf("organize::") === 0) {
    const withoutPrefix = notificationId.slice("organize::".length);
    const label = withoutPrefix.replace(/::\d+$/, "").trim();
    if (label) {
      url = "https://mail.google.com/mail/u/0/#search/label%3A" + encodeURIComponent(label);
    }
  } else {
    const targets = await getNotificationTargets();
    const target = targets[notificationId];
    if (target && target.type === "trash") {
      url = "https://mail.google.com/mail/u/0/#trash";
    }

    if (target) {
      delete targets[notificationId];
      await chrome.storage.local.set({ [NOTIFICATION_TARGETS_KEY]: targets });
    }
  }

  try {
    await chrome.tabs.create({ url: url });
  } catch (tabErr) { tsLog('warn', 'Could not open tab:', tabErr && tabErr.message); }
  try { await chrome.notifications.clear(notificationId); } catch (_) {}
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(result => sendResponse({ ok: true, ...result }))
    .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

// Allow the Gmail Organizer web app (localhost:5173) to communicate directly
chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(result => sendResponse({ ok: true, ...result }))
    .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

async function handleMessage(msg) {
  switch (msg && msg.type) {
    case "getSettings":       return { settings: await getSettings() };
    case "getDashboard":      return { settings: await getSettings(), history: await getHistory(), schedule: await getScheduleState() };
    case "saveSettings":      await saveSettings(msg.settings); return { settings: await getSettings(), schedule: await getScheduleState() };
    case "generateAiRules":   return await generateAiRules(msg);
    case "getPresets":        return { presets: RULE_PRESETS.map(clonePreset) };
    case "exportSettings":    return { data: await buildExportData() };
    case "importSettings":    await importSettings(msg.data); return { settings: await getSettings(), schedule: await getScheduleState() };
    case "completeOnboarding": await chrome.storage.sync.set({ onboardingComplete: true }); return { settings: await getSettings() };
    case "diagnose": {
      const diagToken = await getToken();
      const profile = await gmailRequest(diagToken, "/profile");
      const inboxRef = await gmailRequest(diagToken, "/threads?q=in:inbox&maxResults=5");
      const settings = await getSettings();
      return {
        email: profile.emailAddress,
        inboxThreadsScanned: (inboxRef.threads || []).length,
        rulesCount: (settings.rules || []).length,
        rules: (settings.rules || []).map(r => ({ name: r.name, label: r.label, action: r.action }))
      };
    }
    case "previewOrganize":   return { result: await organizeInbox({ dryRun: true, source: "manual-preview" }) };
    case "runOrganize": {
      const _email = await checkAccessOrThrow();
      const _ps2 = await getPlanStatus();
      const _opts2 = { dryRun: false, source: "manual" };
      if (!isPaidPlan(_ps2.plan)) { _opts2.maxRules = 3; _opts2.maxThreads = 50; }
      const result = await organizeInbox(_opts2);
      await consumeCredit(_email);
      return { result };
    }
    case "getHistory":        return { history: await getHistory() };
    case "clearHistory":      await chrome.storage.local.set({ runHistory: [] }); return { history: [] };
    case "undoRun":           return { result: await undoRun(msg.runId) };
    case "signOut":           await revokeToken(); _cachedEmail = null; _accessCache = null; return {};
    case "previewEmptyTrash": return { result: await emptyTrash({ dryRun: true, source: "manual-preview" }) };
    case "emptyTrash": {
      if (!msg.confirmed) throw new Error("Please confirm before permanently deleting trash emails.");
      const _email = await checkAccessOrThrow();
      const result = await emptyTrash({ dryRun: false, source: "manual" });
      await consumeCredit(_email);
      return { result };
    }
    case "trashProgress":     return {};
    case "getInboxScore":     return { result: await getInboxScore() };
    case "getUnreadCount": {
      try {
        const _tok = await getToken();
        const _r = await fetch(`${GMAIL_API_BASE}/messages?q=is:unread in:inbox&maxResults=1`, { headers: buildHeaders(_tok) });
        const _d = await _r.json();
        return { count: _d.resultSizeEstimate || 0 };
      } catch (_) { return { count: 0 }; }
    }
    case "scanUnsubscribes":  return { result: await scanUnsubscribes() };
    case "scanDuplicates": {
      const _ps = await getPlanStatus();
      if (!isPaidPlan(_ps.plan)) throw Object.assign(new Error("PRO_REQUIRED"), { feature: "Duplicate scanner" });
      return { result: await scanDuplicates() };
    }
    case "deleteDuplicates": {
      if (!msg.confirmed) throw new Error("Please confirm before permanently deleting duplicate emails.");
      const _email = await checkAccessOrThrow();
      const result = await deleteDuplicates(msg.threadIds);
      await consumeCredit(_email);
      return { result };
    }
    case "scanFollowUps":     return { result: await scanFollowUps() };
    case "getStats":          return { result: await getStats() };
    case "getAnalytics": {
      const _ps = await getPlanStatus();
      if (!isPaidPlan(_ps.plan)) throw Object.assign(new Error("PRO_REQUIRED"), { feature: "Full analytics" });
      return { result: await getAnalytics() };
    }
    case "getLabelStats":     return { result: await getLabelStats() };
    case "scanFlatLabels":          return { result: await scanFlatLabels() };
    case "retroactiveCatLabels": {
      const _ps = await getPlanStatus();
      if (!isPaidPlan(_ps.plan)) throw Object.assign(new Error("PRO_REQUIRED"), { feature: "Retroactive labeling" });
      return { result: await retroactiveCatLabels(msg.options || {}) };
    }
    case "deleteLabels": {
      if (!Array.isArray(msg.labelIds) || !msg.labelIds.length)
        throw new Error("No label IDs provided.");
      return { result: await deleteLabels(msg.labelIds) };
    }
    case "detectConflicts": {
      const s = await getSettings();
      var cleaned = dedupeRulesByName(s.rules);
      if (cleaned.length !== s.rules.length) {
        // Use saveSettings to respect rulesInLocal overflow — never write rules directly to sync
        await saveSettings(Object.assign({}, s, { rules: cleaned }));
      }
      return { result: detectRuleConflicts(cleaned) };
    }
    case "testRule": {
      let _rule = msg.rule;
      if (!_rule && msg.ruleId) {
        const _s = await getSettings();
        _rule = (_s.rules || []).find(r => r.id === msg.ruleId) || null;
      }
      if (!_rule) throw new Error("Rule not found.");
      return { result: await testRule(_rule, msg.limit) };
    }
    case "unsubscribeFromSender": {
      const _email = await checkAccessOrThrow();
      const result = await unsubscribeFromSender(msg.messageId);
      await consumeCredit(_email);
      return { result };
    }
    case "blockSender": {
      if (!msg.from) throw new Error("Sender 'from' field required.");
      const _email = await checkAccessOrThrow();
      const result = await blockSender({ from: msg.from, messageId: msg.messageId || null });
      await consumeCredit(_email);
      return { result };
    }
    case "getLabelDecisions":    return await getLabelDecisionLog(msg.opts || {});
    case "getUnsubscribeLog":    return await getUnsubscribeLog();
    case "scanReadLater": {
      const _ps = await getPlanStatus();
      if (!isPaidPlan(_ps.plan)) throw Object.assign(new Error("PRO_REQUIRED"), { feature: "Read Later" });
      return { result: await scanReadLater(msg.opts || {}) };
    }
    case "getTodayEmails":       return { result: await getTodayEmails() };
    case "bulkAction": {
      const _psB = await getPlanStatus();
      if (!isPaidPlan(_psB.plan)) throw Object.assign(new Error("PRO_REQUIRED"), { feature: "Bulk action" });
      const _bulkOpts = msg.opts || {};
      if (!_bulkOpts.dryRun) {
        const _email = await checkAccessOrThrow();
        const result = await bulkAction(_bulkOpts);
        await consumeCredit(_email);
        return { result };
      }
      return { result: await bulkAction(_bulkOpts) };
    }
    case "autoLabelFollowUps": {
      const _psF = await getPlanStatus();
      if (!isPaidPlan(_psF.plan)) throw Object.assign(new Error("PRO_REQUIRED"), { feature: "Auto-label follow-ups" });
      if (msg.dryRun) return { result: await autoLabelFollowUps({ dryRun: true, daysThreshold: msg.daysThreshold || 3 }) };
      const _email = await checkAccessOrThrow();
      const result = await autoLabelFollowUps({ dryRun: false, daysThreshold: msg.daysThreshold || 3 });
      await consumeCredit(_email);
      return { result };
    }
    case "runSelectedRules": {
      const _ps3 = await getPlanStatus();
      const _freeOpts3 = !isPaidPlan(_ps3.plan) ? { maxRules: 3, maxThreads: 50 } : {};
      if (msg.dryRun) return { result: await organizeInboxWithRules({ dryRun: true, source: "manual", ruleIds: msg.ruleIds, ..._freeOpts3 }) };
      const _email = await checkAccessOrThrow();
      const result = await organizeInboxWithRules({ dryRun: false, source: "manual", ruleIds: msg.ruleIds, ..._freeOpts3 });
      await consumeCredit(_email);
      return { result };
    }
    case "bulkArchiveOld": {
      const _psA = await getPlanStatus();
      if (!isPaidPlan(_psA.plan)) throw Object.assign(new Error("PRO_REQUIRED"), { feature: "Archive old emails" });
      if (msg.dryRun) return { result: await bulkArchiveOldThreads({ dryRun: true, olderThanDays: msg.olderThanDays || 14 }) };
      const _email = await checkAccessOrThrow();
      const result = await bulkArchiveOldThreads({ dryRun: false, olderThanDays: msg.olderThanDays || 14 });
      await consumeCredit(_email);
      return { result };
    }
    case "bulkDeleteSearch": {
      const token = await getToken();
      const q = buildBulkDeleteQuery(msg.query);
      const count = await countAllThreads(token, q);
      return { count, query: q };
    }
    case "bulkDeleteRun": {
      const _psD = await getPlanStatus();
      if (!isPaidPlan(_psD.plan)) throw Object.assign(new Error("PRO_REQUIRED"), { feature: "Bulk delete" });
      const token = await getToken();
      const q = buildBulkDeleteQuery(msg.query);
      const result = await bulkDeleteAllThreads(token, q);
      return { result };
    }
    case "signOut": {
      _cachedEmail = null;
      _accessCache = null;
      return { ok: true };
    }
    case "getUserPlanStatus": {
      const email = await getUserEmail();
      if (!email) throw new Error("Not signed in.");
      return await getBackendUserStatus(email);
    }
    case "getAccountInfo": {
      const email = await getUserEmail();
      if (!email) return { email: null, plan: "free", planLabel: "Free", creditsLeft: 0, creditsTotal: 20, creditsUsed: 0 };
      // 🛠️ Developer override
      const { devPlanOverride } = await chrome.storage.local.get('devPlanOverride');
      if (devPlanOverride) return { email, ...devPlanOverride };
      try {
        const status = await getBackendUserStatus(email);
        return { email, ...status };
      } catch (_) {
        return { email, plan: "free", planLabel: "Free", creditsLeft: null, creditsTotal: null, creditsUsed: null };
      }
    }
    case "setPlanOverride": {
      await chrome.storage.local.set({ devPlanOverride: msg.override });
      _accessCache = null;
      return { ok: true };
    }
    case "clearPlanOverride": {
      await chrome.storage.local.remove('devPlanOverride');
      _accessCache = null;
      return { ok: true };
    }
    case "createCheckoutSession": {
      const email = await getUserEmail();
      if (!email) throw new Error("Not signed in.");
      return await createStripeCheckout(email, msg.plan);
    }
    case "archiveThread": {
      const _tok = await getToken();
      await modifyThread(_tok, msg.threadId, null, true);
      return { ok: true };
    }
    case "archiveAllFromSender": {
      // Archive every inbox thread from a given sender domain/address after unsubscribing
      const _tok2 = await getToken();
      const _from = msg.senderEmail || "";
      if (!_from) return { archived: 0 };
      const _q = "in:inbox from:" + _from;
      const _refs = await gmailRequest(_tok2, "/threads?q=" + encodeURIComponent(_q) + "&maxResults=50");
      const _threads = (_refs.threads || []);
      let _archived = 0;
      for (const _t of _threads) {
        try { await modifyThread(_tok2, _t.id, null, true); _archived++; } catch (_) {}
      }
      return { archived: _archived };
    }
    case "retroactiveLabel": {
      const retroResult = await applyRulesRetroactive(msg.options || {});
      return { result: retroResult };
    }
    case "debugRules": {
      const _syncRaw = await chrome.storage.sync.get({ rules: [], rulesInLocal: false });
      const _locRaw = await chrome.storage.local.get({ rulesOverflow: null });
      const _settings = await getSettings();
      return {
        syncRulesCount: (_syncRaw.rules || []).length,
        rulesInLocal: _syncRaw.rulesInLocal,
        overflowCount: (_locRaw.rulesOverflow || []).length,
        settingsRulesCount: (_settings.rules || []).length,
        ruleNames: (_settings.rules || []).slice(0, 5).map(function(r) { return r.name; })
      };
    }
    case "suggestRulesFromInbox": return { result: await suggestRulesFromInbox(msg.options || {}) };
    case "parseNaturalLanguageRule": return { result: await parseNaturalLanguageRule(msg.text) };
    case "getRuleTemplates": return { templates: RULE_TEMPLATE_LIBRARY };
    case "addRuleFromTemplate": await addRuleFromTemplate(msg.templateId); return { settings: await getSettings() };
    case "getRulePerformance": return { result: await getRulePerformance(msg.ruleId) };
    case "hasTabsPermission": return { granted: await hasTabsPermission() };
    case "requestTabsPermission": return await requestTabsPermission();
    case "removeTabsPermission": return await removeTabsPermission();
    case "pruneHistory": await pruneHistory(); return { history: await getHistory() };
    case "getStorageQuota": {
      const s = await getSettings();
      const quotaInfo = await checkRulesStorageQuota(s.rules);
      const hist = await getHistory();
      const mutex = await chrome.storage.local.get({ [RUN_MUTEX_KEY]: null });
      return { rules: quotaInfo, historyCount: hist.length, lastRunMutex: mutex[RUN_MUTEX_KEY] };
    }
    case "getCurrentTimeZone": return { timeZone: getCurrentTimeZone() };
    case "getTelemetryBuffer": {
      const buf = await chrome.storage.local.get({ errorTelemetryBuffer: [] });
      return { buffer: Array.isArray(buf.errorTelemetryBuffer) ? buf.errorTelemetryBuffer : [] };
    }
    case "clearTelemetry": {
      await chrome.storage.local.set({ errorTelemetryBuffer: [] });
      return { cleared: true };
    }
    // Snooze handlers
    case "snoozeThread": return { result: await snoozeThread(msg.threadId, msg.wakeAt) };
    case "listSnoozedThreads": return { snoozed: await listSnoozedThreads() };
    case "cancelSnooze": return { result: await cancelSnooze(msg.threadId) };
    case "wakeSnoozedThreadNow": return { result: await wakeSnoozedThread(msg.threadId) };
    // Thread summary handlers
    case "summarizeThread": {
      const _ps = await getPlanStatus();
      if (!isPaidPlan(_ps.plan)) throw Object.assign(new Error("PRO_REQUIRED"), { feature: "Thread summary" });
      return { result: await summarizeThread(msg.threadId, msg.options || {}) };
    }
    case "clearSummaryCache": await chrome.storage.local.set({ threadSummaryCache: {} }); return { cleared: true };
    // Importance/priority inbox handlers
    case "getImportanceScores": return { result: await getImportanceScores(msg.options || {}) };
    case "recordImportanceFeedback": return { result: await recordImportanceFeedback(msg.messageId, msg.feedback) };
    case "getImportanceLearning": return { learning: await getImportanceLearning() };
    case "resetImportanceLearning": await chrome.storage.local.set({ importanceLearning: DEFAULT_LEARNING }); return { reset: true };
    default: throw new Error("Unknown message type: " + (msg && msg.type));
  }
}

async function getSettings() {
  const s = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const local = await chrome.storage.local.get({ [AI_SECRETS_KEY]: {}, rulesOverflow: null });
  const secrets = local[AI_SECRETS_KEY] || {};

  // One-time migration: enable auto-run for existing users who had it off by default.
  if (!s.autoRunEnabled && !s.settingsV2Migrated) {
    chrome.storage.sync.set({ autoRunEnabled: true, settingsV2Migrated: true });
    s.autoRunEnabled = true;
  }

  // Check if rules are overflowed to local storage
  let rules = Array.isArray(s.rules) ? normalizeRules(s.rules) : [];
  if (s.rulesInLocal && local.rulesOverflow) {
    rules = Array.isArray(local.rulesOverflow) ? normalizeRules(local.rulesOverflow) : rules;
  }

  return {
    maxThreadsPerRun: Number(s.maxThreadsPerRun) || 50,
    archiveMatches: Boolean(s.archiveMatches),
    onboardingComplete: Boolean(s.onboardingComplete),
    autoRunEnabled: Boolean(s.autoRunEnabled),
    autoRunIntervalMinutes: normalizeIntervalMinutes(s.autoRunIntervalMinutes),
    autoEmptyTrashEnabled: Boolean(s.autoEmptyTrashEnabled),
    autoEmptyTrashIntervalMinutes: normalizeTrashIntervalMinutes(s.autoEmptyTrashIntervalMinutes),
    autoEmptyTrashOlderThanDays: normalizeOlderThanDays(s.autoEmptyTrashOlderThanDays),
    aiProvider: normalizeAiProvider(s.aiProvider),
    geminiModel: normalizeGeminiModel(s.geminiModel),
    geminiApiKey: String(secrets.geminiApiKey || ""),
    aiInstructions: String(s.aiInstructions || ""),
    dailyRoutineInstructions: String(s.dailyRoutineInstructions || DEFAULT_SETTINGS.dailyRoutineInstructions),
    rules: rules,
    errorTelemetryEnabled: Boolean(s.errorTelemetryEnabled),
    rulesInLocal: Boolean(s.rulesInLocal),
    lastTimeZone: String(s.lastTimeZone || ""),
    dailyDigestEnabled: s.dailyDigestEnabled !== false
  };
}

async function saveSettings(ns) {
  const nextAiProvider = normalizeAiProvider((ns || {}).aiProvider);
  const nextGeminiModel = normalizeGeminiModel((ns || {}).geminiModel);
  const nextRules = normalizeRules((ns || {}).rules || []);

  // Check storage quota for rules
  const quotaInfo = await checkRulesStorageQuota(nextRules);
  let syncUpdate = {
    maxThreadsPerRun: Math.min(Math.max(Number((ns || {}).maxThreadsPerRun) || 500, 1), 500),
    archiveMatches: Boolean((ns || {}).archiveMatches),
    onboardingComplete: Boolean((ns || {}).onboardingComplete),
    autoRunEnabled: Boolean((ns || {}).autoRunEnabled),
    autoRunIntervalMinutes: normalizeIntervalMinutes((ns || {}).autoRunIntervalMinutes),
    autoEmptyTrashEnabled: Boolean((ns || {}).autoEmptyTrashEnabled),
    autoEmptyTrashIntervalMinutes: normalizeTrashIntervalMinutes((ns || {}).autoEmptyTrashIntervalMinutes),
    autoEmptyTrashOlderThanDays: normalizeOlderThanDays((ns || {}).autoEmptyTrashOlderThanDays),
    aiProvider: nextAiProvider,
    geminiModel: nextGeminiModel,
    aiInstructions: String((ns || {}).aiInstructions || ""),
    dailyRoutineInstructions: String((ns || {}).dailyRoutineInstructions || DEFAULT_SETTINGS.dailyRoutineInstructions),
    errorTelemetryEnabled: Boolean((ns || {}).errorTelemetryEnabled),
    rulesInLocal: false,
    lastTimeZone: String((ns || {}).lastTimeZone || getCurrentTimeZone()),
    dailyDigestEnabled: (ns || {}).dailyDigestEnabled !== false
  };

  if (quotaInfo.exceedsItem) {
    // Write overflow FIRST so rules are always persisted before touching sync
    tsLog('warn', 'saveSettings: rules exceed sync quota, storing in local overflow');
    await chrome.storage.local.set({ rulesOverflow: nextRules });
    syncUpdate.rulesInLocal = true;
    syncUpdate.rules = [];
    await chrome.storage.sync.set(syncUpdate);
  } else {
    syncUpdate.rules = nextRules;
    // Write to sync FIRST — only remove overflow after successful sync write
    await chrome.storage.sync.set(syncUpdate);
    await chrome.storage.local.remove('rulesOverflow');
  }
  await saveAiSecrets({ geminiApiKey: String((ns || {}).geminiApiKey || "").trim() });
  await syncAutoRunAlarm();
  await syncAutoEmptyTrashAlarm();
  await scheduleDailyDigestAlarm();
}

async function syncAutoRunAlarm() {
  const s = await getSettings();
  if (!s.autoRunEnabled) { await chrome.alarms.clear(AUTO_RUN_ALARM); return; }

  // Enforce minimum interval of 15 minutes for auto-run
  const strictMin = await getFeatureFlag('ff_strictMinInterval', true);
  let interval = s.autoRunIntervalMinutes;
  if (strictMin && interval < 15) {
    console.warn('[gmail-organizer] autoRunIntervalMinutes below 15 min minimum, clamping to 15');
    interval = 15;
  }

  chrome.alarms.create(AUTO_RUN_ALARM, { delayInMinutes: interval, periodInMinutes: interval });
}

async function syncAutoEmptyTrashAlarm() {
  const s = await getSettings();
  if (!s.autoEmptyTrashEnabled) { await chrome.alarms.clear(AUTO_EMPTY_TRASH_ALARM); return; }

  // Enforce minimum interval of 60 minutes for auto-empty-trash
  const strictMin = await getFeatureFlag('ff_strictMinInterval', true);
  let interval = s.autoEmptyTrashIntervalMinutes;
  if (strictMin && interval < 60) {
    console.warn('[gmail-organizer] autoEmptyTrashIntervalMinutes below 60 min minimum, clamping to 60');
    interval = 60;
  }

  chrome.alarms.create(AUTO_EMPTY_TRASH_ALARM, { delayInMinutes: interval, periodInMinutes: interval });
}

async function getScheduleState() {
  const s = await getSettings();
  const alarm = await chrome.alarms.get(AUTO_RUN_ALARM);
  return { enabled: s.autoRunEnabled, intervalMinutes: s.autoRunIntervalMinutes, nextRunAt: alarm && alarm.scheduledTime ? new Date(alarm.scheduledTime).toISOString() : null };
}

async function getHistory() {
  const s = await chrome.storage.local.get({ runHistory: [] });
  return Array.isArray(s.runHistory) ? s.runHistory : [];
}

async function appendHistoryEntry(entry) {
  const h = await getHistory();
  h.unshift(entry);

  // Prune: keep max 500 entries and entries < 90 days old
  const now = Date.now();
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  const pruned = h.filter(e => {
    if (!e.timestamp) return true;
    const entryTime = new Date(e.timestamp).getTime();
    return (now - entryTime) < ninetyDaysMs;
  }).slice(0, HISTORY_MAX_ENTRIES);

  await chrome.storage.local.set({ runHistory: pruned });
}

async function replaceHistory(h) {
  await chrome.storage.local.set({ runHistory: h.slice(0, HISTORY_LIMIT) });
}

async function buildExportData() {
  return { version: 1, exportedAt: new Date().toISOString(), settings: await getExportableSettings() };
}

async function importSettings(data) {
  if (!data || !data.settings) throw new Error("Invalid import file.");
  await saveSettings(Object.assign({}, data.settings, { onboardingComplete: true }));
}

async function getExportableSettings() {
  const settings = await getSettings();
  // Explicitly strip all sensitive credentials — never include API keys in exports
  const exported = Object.assign({}, settings);
  delete exported.geminiApiKey;
  exported.geminiApiKey = "";  // Belt-and-suspenders: zero out even if delete fails
  return exported;
}

async function applyRecommendedPresetMigrations() {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  if (!Array.isArray(current.rules) || !current.rules.length) return;

  const nextRules = normalizeRules(current.rules).map(function(rule) {
    const recommendedAction = RECOMMENDED_PRESET_ACTIONS[rule.id];
    if (!recommendedAction || rule.action === recommendedAction) return rule;
    return Object.assign({}, rule, {
      action: recommendedAction,
      archive: recommendedAction === "archive"
    });
  });

  const changed = nextRules.some(function(rule, index) {
    const currentRule = current.rules[index] || {};
    return normalizeAction(currentRule.action, currentRule.archive) !== rule.action ||
      Boolean(currentRule.archive) !== rule.archive;
  });

  if (!changed) return;
  const quotaInfo1 = await checkRulesStorageQuota(nextRules);
  if (quotaInfo1.exceedsItem) {
    await chrome.storage.sync.set({ rulesInLocal: true, rules: [] });
    await chrome.storage.local.set({ rulesOverflow: nextRules });
  } else {
    await chrome.storage.sync.set({ rulesInLocal: false, rules: nextRules });
    await chrome.storage.local.remove('rulesOverflow');
  }
}

async function applyDefaultRulesMigration() {
  var PRESET_VERSION = 3;
  var stored = await chrome.storage.local.get({ presetVersion: 0 });
  var current = await chrome.storage.sync.get({ rules: [] });
  var rules = Array.isArray(current.rules) ? current.rules : [];

  var presetMap = {};
  var presetByName = {};
  var presetByLabel = {};
  for (var i = 0; i < DEFAULT_RULES.length; i++) {
    presetMap[DEFAULT_RULES[i].id] = DEFAULT_RULES[i];
    presetByName[String(DEFAULT_RULES[i].name || "").toLowerCase()] = DEFAULT_RULES[i];
    presetByLabel[String(DEFAULT_RULES[i].label || "").toLowerCase()] = DEFAULT_RULES[i];
  }

  // Replace user rules that match a preset by ID, name, or label with the updated preset
  var consumedPresetIds = new Set();
  var merged = rules.map(function(r) {
    var matchedPreset = null;
    if (r.id && r.id.indexOf("preset-") === 0 && presetMap[r.id]) {
      matchedPreset = presetMap[r.id];
    } else if (presetByName[String(r.name || "").toLowerCase()]) {
      matchedPreset = presetByName[String(r.name || "").toLowerCase()];
    } else if (presetByLabel[String(r.label || "").toLowerCase()]) {
      matchedPreset = presetByLabel[String(r.label || "").toLowerCase()];
    }
    if (matchedPreset && !consumedPresetIds.has(matchedPreset.id)) {
      consumedPresetIds.add(matchedPreset.id);
      var updated = clonePreset(matchedPreset);
      updated.action = r.action;
      return updated;
    }
    return r;
  });

  // Remove duplicate rules with the same name (keep first occurrence)
  var seenNames = new Set();
  merged = merged.filter(function(r) {
    var key = String(r.name || "").toLowerCase();
    if (seenNames.has(key)) return false;
    seenNames.add(key);
    return true;
  });

  // Add any missing presets
  var existingIds = new Set(merged.map(function(r) { return r.id; }));
  var existingLabels = new Set(merged.map(function(r) { return String(r.label || "").toLowerCase(); }));
  var existingNames = new Set(merged.map(function(r) { return String(r.name || "").toLowerCase(); }));
  for (var j = 0; j < DEFAULT_RULES.length; j++) {
    var preset = DEFAULT_RULES[j];
    if (!existingIds.has(preset.id) && !existingLabels.has(String(preset.label || "").toLowerCase()) && !existingNames.has(String(preset.name || "").toLowerCase())) {
      merged.push(clonePreset(preset));
    }
  }

  const quotaInfo2 = await checkRulesStorageQuota(merged);
  if (quotaInfo2.exceedsItem) {
    await chrome.storage.sync.set({ rulesInLocal: true, rules: [] });
    await chrome.storage.local.set({ rulesOverflow: merged });
  } else {
    await chrome.storage.sync.set({ rulesInLocal: false, rules: merged });
    await chrome.storage.local.remove('rulesOverflow');
  }
  await chrome.storage.local.set({ presetVersion: PRESET_VERSION });
}

// Removes tech/SaaS domains that the AI commonly misclassifies into Travel or Finance rules.
// Runs once per install/update so saved rules are cleaned up, not just the runtime matching.
async function applyMiscategorizedDomainsFix() {
  const CLEANUP_VERSION_KEY = "miscatDomainsFixV1";
  const done = await chrome.storage.local.get({ [CLEANUP_VERSION_KEY]: false });
  if (done[CLEANUP_VERSION_KEY]) return;

  const current = await chrome.storage.sync.get({ rules: [] });
  const rules = Array.isArray(current.rules) ? current.rules : [];
  const badDomains = new Set([
    "n8n.io","notion.so","figma.com","airtable.com","asana.com","trello.com",
    "monday.com","clickup.com","linear.app","slack.com","discord.com",
    "github.com","gitlab.com","bitbucket.org","vercel.com","netlify.com",
    "heroku.com","digitalocean.com","anthropic.com","openai.com",
    "zapier.com","make.com","hubspot.com","intercom.io",
    "mailchimp.com","convertkit.com","beehiiv.com","substack.com",
    "twilio.com","sendgrid.com","sentry.io","supabase.com",
    "planetscale.com","railway.app","render.com","firebase.google.com"
  ]);

  let changed = false;
  const cleaned = rules.map(function(rule) {
    const label = String(rule.label || "").toLowerCase();
    if (!label.startsWith("travel") && !label.startsWith("finance")) return rule;
    const fd = (rule.match && rule.match.fromDomains) || [];
    const filtered = fd.filter(function(d) { return !badDomains.has(String(d).toLowerCase()); });
    if (filtered.length === fd.length) return rule;
    changed = true;
    console.log("[gmail-organizer] Removed tech domains from rule \"" + rule.name + "\":", fd.filter(function(d) { return badDomains.has(String(d).toLowerCase()); }));
    return Object.assign({}, rule, { match: Object.assign({}, rule.match, { fromDomains: filtered }) });
  });

  if (changed) {
    const quotaInfo3 = await checkRulesStorageQuota(cleaned);
    if (quotaInfo3.exceedsItem) {
      await chrome.storage.sync.set({ rulesInLocal: true, rules: [] });
      await chrome.storage.local.set({ rulesOverflow: cleaned });
    } else {
      await chrome.storage.sync.set({ rulesInLocal: false, rules: cleaned });
      await chrome.storage.local.remove('rulesOverflow');
    }
  }
  await chrome.storage.local.set({ [CLEANUP_VERSION_KEY]: true });
}

async function applyDailyRoutineMigration() {
  const current = await chrome.storage.sync.get({ dailyRoutineInstructions: "" });
  const existing = String(current.dailyRoutineInstructions || "").trim();
  const LEGACY_V2 = "1. Run Preview first and review all matched emails before making any changes.";
  if (existing && existing !== LEGACY_DAILY_ROUTINE_INSTRUCTIONS && !existing.startsWith(LEGACY_V2)) return;
  await chrome.storage.sync.set({ dailyRoutineInstructions: DEFAULT_SETTINGS.dailyRoutineInstructions });
}

async function applyGeminiModelMigration() {
  const current = await chrome.storage.sync.get({ geminiModel: "" });
  const existing = String(current.geminiModel || "").trim();
  if (existing && existing !== LEGACY_DEFAULT_GEMINI_MODEL) return;
  await chrome.storage.sync.set({ geminiModel: DEFAULT_GEMINI_MODEL });
}

function normalizeRules(rules) {
  var normalized = (rules || []).filter(function(r) { return r && r.label; }).map(function(r, i) {
    return {
      id: r.id || ("rule-" + (i + 1)),
      name: r.name || r.label,
      label: String(r.label).trim(),
      color: r.color || null,
      archive: Boolean(r.archive),
      action: normalizeAction(r.action, r.archive),
      description: String(r.description || "").trim(),
      match: {
        fromDomains: normalizeList(r.match && r.match.fromDomains),
        fromIncludes: normalizeList(r.match && r.match.fromIncludes),
        subjectIncludes: normalizeList(r.match && r.match.subjectIncludes)
      }
    };
  });
  return dedupeRules(normalized);
}

// Single-rule normalizer (used by parseNaturalLanguageRule)
function normalizeRule(rule) {
  const normalized = normalizeRules([rule]);
  return normalized.length > 0 ? normalized[0] : rule;
}

function dedupeRules(rules) {
  var seen = new Map();
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    var key = [
      String(rule.name || "").trim().toLowerCase(),
      String(rule.label || "").trim().toLowerCase(),
      String(rule.action || ""),
      normalizeList(rule.match && rule.match.fromDomains).join("|"),
      normalizeList(rule.match && rule.match.fromIncludes).join("|"),
      normalizeList(rule.match && rule.match.subjectIncludes).join("|")
    ].join("::");
    if (!seen.has(key)) {
      seen.set(key, rule);
    }
  }
  return Array.from(seen.values());
}

function dedupeRulesByName(rules) {
  // First pass: find conflicts between preset and non-preset rules
  var conflicts = detectRuleConflicts(rules);
  var dropIds = new Set();
  for (var c = 0; c < conflicts.length; c++) {
    var conf = conflicts[c];
    var idA = conf.ruleA.id, idB = conf.ruleB.id;
    var aIsPreset = idA && idA.indexOf("preset-") === 0;
    var bIsPreset = idB && idB.indexOf("preset-") === 0;
    // If one is a preset and the other isn't, drop the non-preset
    if (aIsPreset && !bIsPreset) dropIds.add(idB);
    else if (bIsPreset && !aIsPreset) dropIds.add(idA);
    // If neither is a preset, drop the second one
    else if (!aIsPreset && !bIsPreset) dropIds.add(idB);
  }

  // Second pass: also dedupe by exact name
  var seen = new Set();
  return rules.filter(function(r) {
    if (r.id && dropIds.has(r.id)) return false;
    var name = String(r.name || "").trim().toLowerCase();
    if (name && seen.has(name)) return false;
    if (name) seen.add(name);
    return true;
  });
}

function normalizeList(v) {
  if (!Array.isArray(v)) return [];
  return v.map(function(i) { return String(i || "").trim().toLowerCase(); }).filter(Boolean);
}

function normalizeIntervalMinutes(v) {
  var allowed = [15, 30, 60, 120, 180, 360, 720, 1440];
  var p = Number(v);
  return allowed.indexOf(p) !== -1 ? p : 60;
}

function normalizeTrashIntervalMinutes(v) {
  var allowed = [1440, 10080, 20160, 43200];
  var p = Number(v);
  return allowed.indexOf(p) !== -1 ? p : 10080;
}

function normalizeOlderThanDays(v) {
  var allowed = [0, 7, 14, 30];
  var p = Number(v);
  return allowed.indexOf(p) !== -1 ? p : 30;
}

function normalizeAction(v, fb) {
  if (v === "label" || v === "archive" || v === "trash") return v;
  return fb ? "archive" : "label";
}

function normalizeAiProvider(value) {
  return value === "gemini" ? "gemini" : "local";
}

function normalizeGeminiModel(value) {
  var model = String(value || "").trim();
  return model || DEFAULT_GEMINI_MODEL;
}

function validateLabelName(name) {
  var normalized = String(name || "").trim();
  if (!normalized) throw new Error("Gmail label cannot be empty.");

  var root = normalized.split("/")[0].trim().toLowerCase();
  if (RESERVED_GMAIL_LABEL_ROOTS.indexOf(root) !== -1) {
    throw new Error('Label "' + normalized + '" uses reserved Gmail system label "' + normalized.split("/")[0].trim() + '" as its root. Rename it to something like "Promotions/Trash" or "Review/Promotions".');
  }
}

async function saveAiSecrets(nextSecrets) {
  const local = await chrome.storage.local.get({ [AI_SECRETS_KEY]: {} });
  const secrets = Object.assign({}, local[AI_SECRETS_KEY] || {});
  if (nextSecrets.geminiApiKey) {
    secrets.geminiApiKey = nextSecrets.geminiApiKey;
  } else {
    delete secrets.geminiApiKey;
  }
  await chrome.storage.local.set({ [AI_SECRETS_KEY]: secrets });
}

async function generateAiRules(msg) {
  const settings = await getSettings();
  const provider = normalizeAiProvider(msg && msg.provider ? msg.provider : settings.aiProvider);
  const instructions = String(msg && msg.instructions || "").trim();
  const model = normalizeGeminiModel(msg && msg.model ? msg.model : settings.geminiModel);
  if (!instructions) throw new Error("Add a few plain-language instructions first.");

  if (provider === "gemini") {
    if (!String(settings.geminiApiKey || "").trim()) {
      throw new Error("Add your Gemini API key in Settings before using Gemini Flash.");
    }
    const geminiRules = await generateAiRulesWithGemini(instructions, model).catch(function(error) {
      return { rules: [], error: error };
    });
    if (geminiRules.rules && geminiRules.rules.length > 0) {
      return { rules: geminiRules.rules, providerUsed: "gemini" };
    }
    if (geminiRules.error) {
      throw geminiRules.error;
    }
  }

  const fallbackRules = inferRulesFromInstructions(instructions, RULE_PRESETS.map(clonePreset));
  return { rules: normalizeRules(fallbackRules), providerUsed: "local" };
}

async function generateAiRulesWithGemini(instructions, model) {
  const settings = await getSettings();
  const apiKey = String(settings.geminiApiKey || "").trim();
  if (!apiKey) throw new Error("Add your Gemini API key in Settings before using Gemini Flash.");

  const attempts = [
    { prompt: buildGeminiRulePrompt(instructions, false), maxOutputTokens: 1400 },
    { prompt: buildGeminiRulePrompt(instructions, true), maxOutputTokens: 2600 }
  ];

  let lastError = null;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    try {
      const data = await requestGeminiRules({
        apiKey: apiKey,
        model: model,
        prompt: attempt.prompt,
        maxOutputTokens: attempt.maxOutputTokens
      });
      const finishReason = (((data || {}).candidates || [])[0] || {}).finishReason || "";
      const text = extractGeminiText(data);
      const parsed = parseGeminiRules(text);
      const rules = normalizeRules(parsed.rules || []);
      if (rules.length) {
        return { rules: rules };
      }
      if (finishReason === "MAX_TOKENS") {
        lastError = new Error("Gemini output was truncated before the JSON finished.");
        continue;
      }
      lastError = new Error("Gemini Flash returned a response, but no valid Gmail rules were found.");
    } catch (error) {
      lastError = error;
      if (!shouldRetryGeminiRequest(error)) {
        break;
      }
    }
  }

  throw lastError || new Error("Gemini Flash could not generate valid rules.");
}

async function requestGeminiRules(opts) {
  // Apply Gemini rate limiting (5 sec minimum between calls)
  await throttleGeminiCall();

  const response = await fetchWithRetry("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(opts.model) + ":generateContent", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": opts.apiKey
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: opts.prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: opts.maxOutputTokens,
        responseMimeType: "application/json",
        responseSchema: GEMINI_RULES_RESPONSE_SCHEMA
      }
    })
  });

  if (!response.ok) {
    let details = null;
    try { details = await response.json(); } catch (_) {}
    const errorMsg = (details && details.error && details.error.message) || ("Gemini API error (" + response.status + ")");
    await logAnonymousError('gemini_api_error', { status: response.status, functionName: 'requestGeminiRules' });
    throw new Error(errorMsg);
  }

  return response.json();
}

function buildGeminiRulePrompt(instructions, compactMode) {
  // PRIVACY: Only send aggregate metadata to Gemini, never raw email bodies or full subjects.
  const prompt = [
    "Convert the user's Gmail organization request into JSON rules for a Chrome extension.",
    "Return only JSON. Do not include markdown fences or explanations.",
    "Use this exact shape:",
    "{\"rules\":[{\"name\":\"string\",\"label\":\"string\",\"action\":\"label|archive|trash\",\"color\":null,\"match\":{\"fromDomains\":[\"domain.com\"],\"fromIncludes\":[\"partial sender text\"],\"subjectIncludes\":[\"keyword\"]}}]}",
    "Requirements:",
    "- Create practical Gmail labels like Work/Dev or Finance/Receipts.",
    "- Never create two rules whose fromDomains, fromIncludes, or subjectIncludes overlap — merge related services into one rule.",
    compactMode ? "- Prefer 3 to 5 rules." : "- Prefer 3 to 10 rules.",
    "- Keep fromDomains lowercase.",
    compactMode ? "- Keep arrays very short: 0 to 3 items each." : "- Keep subjectIncludes and fromIncludes concise.",
    "- Use archive for routine items, label for important visible items, trash only for obvious low-value promotions.",
    "- If the user does not specify enough detail, infer reasonable common email categories.",
    "User instructions:",
    instructions
  ];

  if (compactMode) {
    prompt.splice(prompt.length - 2, 0, "- Minimize output size and avoid verbose keywords.");
  }

  return prompt.join("\n");
}

function shouldRetryGeminiRequest(error) {
  const message = String(error && error.message || "");
  return message.indexOf("invalid JSON") !== -1 ||
    message.indexOf("No JSON payload found") !== -1 ||
    message.indexOf("truncated") !== -1;
}

function extractGeminiText(data) {
  const parts = (((data || {}).candidates || [])[0] || {}).content;
  const textParts = Array.isArray(parts && parts.parts) ? parts.parts : [];
  return textParts
    .map(function(part) { return part && part.text ? part.text : ""; })
    .join("\n")
    .trim();
}

function parseGeminiRules(text) {
  const raw = String(text || "").trim();
  if (!raw) return { rules: [] };
  const cleaned = raw
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  try {
    const parsed = parseGeminiJsonPayload(cleaned);
    if (Array.isArray(parsed)) return { rules: parsed };
    return { rules: Array.isArray(parsed.rules) ? parsed.rules : [] };
  } catch (_) {
    throw new Error("Gemini returned invalid JSON. Raw response: " + raw.slice(0, 300));
  }
}

function parseGeminiJsonPayload(text) {
  try {
    return JSON.parse(text);
  } catch (_) {}

  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd !== -1 && objectEnd > objectStart) {
    const objectCandidate = text.slice(objectStart, objectEnd + 1);
    try {
      return JSON.parse(objectCandidate);
    } catch (_) {}
  }

  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    const arrayCandidate = text.slice(arrayStart, arrayEnd + 1);
    return JSON.parse(arrayCandidate);
  }

  throw new Error("No JSON payload found.");
}

function inferRulesFromInstructions(instructions, presets) {
  const text = String(instructions || "").toLowerCase();
  const suggestions = [];
  const matchedPresetIds = new Set();
  const presetMatchers = [
    { id: "preset-dev", terms: ["github", "development", "dev", "code", "deploy", "build"] },
    { id: "preset-receipts", terms: ["receipt", "receipts", "billing", "invoice", "invoices"] },
    { id: "preset-banking", terms: ["bank", "banking", "security alert", "fraud", "transaction"] },
    { id: "preset-newsletters", terms: ["newsletter", "newsletters", "digest", "weekly roundup"] },
    { id: "preset-shopping", terms: ["shopping", "orders", "deliveries", "delivery", "tracking", "amazon"] },
    { id: "preset-social", terms: ["social", "notifications", "linkedin", "x.com", "twitter", "facebook", "instagram", "reddit", "youtube", "tiktok"] },
    { id: "preset-travel", terms: ["travel", "bookings", "flights", "hotel", "reservation"] },
    { id: "preset-jobs", terms: ["jobs", "job", "recruiting", "recruiter", "applications", "career", "interview"] },
    { id: "preset-saas", terms: ["saas", "app updates", "updates", "product updates", "release notes"] },
    { id: "preset-promotions", terms: ["promotions", "promotion", "offers", "sales", "discounts", "promo"] }
  ];

  for (const matcher of presetMatchers) {
    if (!matcher.terms.some((term) => text.includes(term))) {
      continue;
    }

    const preset = presets.find((item) => item.id === matcher.id);
    if (!preset || matchedPresetIds.has(preset.id)) {
      continue;
    }

    const action = inferActionForTerms(text, matcher.terms, preset.action);
    const suggestion = clonePreset(preset);
    suggestion.action = action;
    suggestion.archive = action === "archive";
    suggestions.push(suggestion);
    matchedPresetIds.add(preset.id);
  }

  const customRules = inferCustomRules(text);
  return suggestions.concat(customRules);
}

function inferActionForTerms(text, terms, fallbackAction) {
  const contextualTerms = terms.map(escapeRegExp).join("|");
  if ((new RegExp("(?:trash|delete|remove)[^.\\n]{0,80}(?:" + contextualTerms + ")")).test(text) ||
      (new RegExp("(?:" + contextualTerms + ")[^.\\n]{0,80}(?:trash|delete|remove)")).test(text)) {
    return "trash";
  }
  if ((new RegExp("(?:archive|file away|clean up)[^.\\n]{0,80}(?:" + contextualTerms + ")")).test(text) ||
      (new RegExp("(?:" + contextualTerms + ")[^.\\n]{0,80}(?:archive|file away|clean up)")).test(text)) {
    return "archive";
  }
  if ((new RegExp("(?:keep|visible|important|leave in inbox)[^.\\n]{0,80}(?:" + contextualTerms + ")")).test(text) ||
      (new RegExp("(?:" + contextualTerms + ")[^.\\n]{0,80}(?:keep|visible|important|leave in inbox)")).test(text)) {
    return "label";
  }
  return fallbackAction || "label";
}

function inferCustomRules(text) {
  const rules = [];
  const workDomains = extractDomainsNearKeyword(text, ["work", "client", "clients"]);
  if (workDomains.length > 0) {
    rules.push({
      id: "ai-work-custom",
      name: "AI: Work and clients",
      label: "Work/General",
      archive: false,
      action: "label",
      color: "#4a86e8",
      match: {
        fromDomains: workDomains,
        fromIncludes: [],
        subjectIncludes: []
      }
    });
  }
  return rules;
}

function extractDomainsNearKeyword(text, keywords) {
  const domains = Array.from(new Set((text.match(/\b[a-z0-9.-]+\.[a-z]{2,}\b/g) || []).map(function(item) { return item.toLowerCase(); })));
  if (domains.length === 0) {
    return [];
  }
  return domains.filter(function(domain) {
    return EXCLUDED_COMMON_DOMAINS.indexOf(domain) === -1 &&
      keywords.some(function(keyword) { return text.includes(keyword); });
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function getIncrementalChanges(token, startHistoryId) {
  if (!startHistoryId) throw new Error("startHistoryId required");

  const changes = { messageIds: new Set(), latestHistoryId: null };
  let nextPageToken = null;

  try {
    do {
      const params = "startHistoryId=" + encodeURIComponent(startHistoryId) + "&historyTypes=messageAdded&labelId=INBOX" + (nextPageToken ? "&pageToken=" + encodeURIComponent(nextPageToken) : "");
      const data = await gmailRequest(token, "/history?" + params);
      const history = data.history || [];
      history.forEach(entry => {
        (entry.messagesAdded || []).forEach(msg => {
          if (msg.message && msg.message.id) changes.messageIds.add(msg.message.id);
        });
      });
      changes.latestHistoryId = data.historyId || startHistoryId;
      nextPageToken = data.nextPageToken || null;
    } while (nextPageToken);
  } catch (error) {
    if (error.message && error.message.includes("Invalid startHistoryId")) {
      return null;
    }
    throw error;
  }

  return changes;
}

async function getCurrentHistoryId(token) {
  try {
    const data = await gmailRequest(token, "/profile");
    return data.historyId || null;
  } catch (error) {
    console.warn("Could not get current history ID:", error.message);
    return null;
  }
}

// Shared: map a flat label name to its canonical hierarchical form.
// Called both during organize runs AND retroactive labeling so deletions
// of flat labels are never immediately recreated under the old flat name.
const _FLAT_LABEL_MAP = {
  'marketing':'Marketing','promotions':'Marketing',
  'newsletters':'Reading/Newsletter','newsletter':'Reading/Newsletter',
  'social':'Social Emails','notifications':'Notifications',
  'updates':'Notifications','work':'Work Projects',
  'finance':'Finance/Payments','shopping':'Shopping/Orders',
  'travel':'Travel/Bookings','reading':'Reading/Newsletter',
  'receipts':'Finance/Payments','orders':'Shopping/Orders',
  'invoices':'Finance/Payments','info/fyi':'Notifications',
  'collaboration/comments':'Work Projects','notifications/tools':'Notifications',
  'calendar/meetings':'Follow Up','career/applications':'Work Projects',
  'finance/banking':'Finance/Payments','travel/stays':'Travel/Bookings',
  'travel/flights':'Travel/Bookings','social/general':'Social Emails'
};
function normalizeLabelName(raw) {
  if (!raw || raw.indexOf('/') !== -1) return raw || 'Updates/General';
  var k = raw.toLowerCase().trim();
  if (_FLAT_LABEL_MAP[k]) return _FLAT_LABEL_MAP[k];
  if (/pay|bank|financ|invoice|receipt|bill/i.test(k)) return 'Finance/' + raw;
  if (/shop|order|store|buy/i.test(k)) return 'Shopping/' + raw;
  if (/news|letter|digest|blog|read/i.test(k)) return 'Reading/' + raw;
  if (/social|network/i.test(k)) return 'Social/' + raw;
  if (/work|job|dev|git/i.test(k)) return 'Work/' + raw;
  if (/travel|flight|hotel/i.test(k)) return 'Travel/' + raw;
  return 'Updates/' + raw;
}

async function organizeInbox(opts) {
  return organizeInboxWithRules({ dryRun: opts.dryRun, source: opts.source, ruleIds: null });
}

async function organizeInboxWithRules(opts) {
  const mutexType = opts.ruleIds ? 'organize-selected' : 'organize';
  let mutexId = null;
  try {
    mutexId = await acquireRunMutex(mutexType);
    tsLog('log', 'organizeInboxWithRules started — dryRun:', opts.dryRun, 'source:', opts.source, 'ruleIds:', opts.ruleIds ? opts.ruleIds.length : 'all');

    var dryRun = opts.dryRun, source = opts.source, ruleIds = opts.ruleIds;
    var _freeLimitRules = opts.maxRules || null;
    var _freeLimitThreads = opts.maxThreads || null;
    var runId = crypto.randomUUID();
    var settings = await getSettings();
    var rules = ruleIds ? settings.rules.filter(function(r) { return ruleIds.indexOf(r.id) !== -1; }) : settings.rules;
    if (_freeLimitRules && rules.length > _freeLimitRules) {
      rules = rules.slice(0, _freeLimitRules);
      tsLog('info', 'Free plan: rules limited to', _freeLimitRules);
    }

    // Load categorization preferences
    var catPrefs = await getCatPrefs();
    var keepInCats  = Object.keys(catPrefs.prefs).filter(function(id) { return catPrefs.prefs[id] === 'keep-in'; });
    var moveOutCats = Object.keys(catPrefs.prefs).filter(function(id) { return catPrefs.prefs[id] === 'move-out'; });
    var token = await getToken();
    var refs = null, threads = [];

    // Always flush the label cache at run start so we work with fresh Gmail label data.
    labelIdCache.clear();

    const incrementalEnabled = await getFeatureFlag('ff_incrementalSync', true);
    const lastHistoryId = settings.lastHistoryId || null;

    if (incrementalEnabled && lastHistoryId && !ruleIds) {
      try {
        const changes = await getIncrementalChanges(token, lastHistoryId);
        if (changes && changes.messageIds.size > 0) {
          refs = { threads: Array.from(changes.messageIds).slice(0, settings.maxThreadsPerRun).map(id => ({ id: id })) };
        } else if (!changes) {
          console.warn('[gmail-organizer] history ID too old, falling back to full sync');
          refs = null;
        }
      } catch (error) {
        console.warn('[gmail-organizer] incremental sync failed:', error.message);
        refs = null;
      }
    }

    if (!refs) {
      refs = await gmailRequest(token, "/threads?q=" + encodeURIComponent("in:inbox") + "&maxResults=" + (_freeLimitThreads || settings.maxThreadsPerRun));
      await trackQuotaUnit(5);
    }

    threads = refs.threads || [];
    var labelsByName = await getLabelsByName(token);
    var createdLabels = [], actions = [];
    var processedCount = 0;

    // ── Pre-create all enabled category labels upfront ────────────────────────
    // This ensures labels always appear in Gmail's sidebar after a run,
    // even before any email is matched, and eliminates per-thread label creation races.
    if (!dryRun && moveOutCats.length > 0) {
      for (var ci = 0; ci < moveOutCats.length; ci++) {
        var preCatId = moveOutCats[ci];
        var preLabelName = CAT_LABELS[preCatId];
        if (!preLabelName) continue;
        if (!labelsByName.has(preLabelName)) {
          try {
            var newLabelId = await createLabel(token, preLabelName, null);
            labelsByName.set(preLabelName, newLabelId);
            createdLabels.push(preLabelName);
            console.log('[gmail-organizer] Pre-created label:', preLabelName);
          } catch (labelErr) {
            console.warn('[gmail-organizer] Could not pre-create label "' + preLabelName + '":', labelErr.message);
          }
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (!threads.length) {
      var r = buildResult({ actions: [], dryRun: dryRun, scannedThreads: 0, source: source });
      if (!dryRun) await appendHistoryEntry(toHistoryEntry(r, "success"));
      return r;
    }

    // ── Phase 1: Fetch all thread metadata in parallel (10 at a time) ────────
    // This replaces sequential one-by-one fetches and is ~10× faster.
    tsLog('log', 'organizeInboxWithRules — fetching', threads.length, 'thread(s) in parallel');
    var threadMetas = await parallelMap(threads, async function(ref) {
      var t = await gmailRequest(token, "/threads/" + ref.id + "?format=metadata&metadataHeaders=From&metadataHeaders=Subject");
      await trackQuotaUnit(5);
      return t;
    }, 10);
    // ─────────────────────────────────────────────────────────────────────────

    // Collect deferred apply actions so we can batch-apply after matching
    var pendingApply = []; // { threadId, labelId, action, decisionMeta }

    for (var i = 0; i < threadMetas.length; i++) {
      // Save checkpoint every 50 messages
      if (!dryRun && i % 50 === 0 && i > 0) {
        const lastAction = actions[actions.length - 1];
        await saveRuleRunCheckpoint(runId, rules.length > 0 ? rules[0].id : "default", lastAction ? lastAction.threadId : "", processedCount);
      }

      var thread = threadMetas[i];
      if (!thread) { processedCount++; continue; }

      // ── Categorization guards ──────────────────────────────────────────────
      var firstMsg = thread.messages && thread.messages[0];
      var threadHeaders = (firstMsg && firstMsg.payload && firstMsg.payload.headers) || [];
      var threadFrom    = (threadHeaders.find(function(h) { return h.name.toLowerCase() === 'from'; }) || {}).value || '';
      var threadSubject = (threadHeaders.find(function(h) { return h.name.toLowerCase() === 'subject'; }) || {}).value || '';
      var threadLabelIds = (firstMsg && firstMsg.labelIds) || [];

      // catRespectExisting: skip threads that already have a user-created label
      if (catPrefs.respectExisting) {
        var hasUserLabel = threadLabelIds.some(function(lid) { return !isSystemLabel(lid); });
        if (hasUserLabel) { processedCount++; continue; }
      }

      // keep-in: never archive/trash threads matching a keep-in category
      var isProtected = keepInCats.some(function(catId) { return threadMatchesCat(threadFrom, threadSubject, catId, threadLabelIds); });

      var match = findRuleMatch(thread, rules);
      if (!match) {
        // No rule match — check move-out categories
        if (!isProtected && moveOutCats.length > 0) {
          var matchedMoveCat = moveOutCats.find(function(catId) { return threadMatchesCat(threadFrom, threadSubject, catId, threadLabelIds); });
          if (matchedMoveCat) {
            var catLabel = CAT_LABELS[matchedMoveCat] || matchedMoveCat;
            var catLabelId = labelsByName.get(catLabel) || null;
            // Fallback: create label on-demand if pre-creation was skipped (e.g. dry-run) or failed
            if (!catLabelId && !dryRun) {
              try {
                catLabelId = await createLabel(token, catLabel, null);
                labelsByName.set(catLabel, catLabelId);
                createdLabels.push(catLabel);
              } catch (labelErr) {
                console.error('[gmail-organizer] Failed to create label "' + catLabel + '":', labelErr.message);
              }
            }
            actions.push({ threadId: thread.id, subject: threadSubject, from: threadFrom, label: catLabel, labelId: catLabelId, action: 'archive' });
            if (!dryRun && catLabelId) {
              pendingApply.push({ threadId: thread.id, labelId: catLabelId, action: 'archive', decisionMeta: { label: catLabel, ruleId: 'category:' + matchedMoveCat, ruleName: 'Category: ' + matchedMoveCat, from: threadFrom, subject: threadSubject, reason: 'category:' + matchedMoveCat } });
            } else if (!dryRun && !catLabelId) {
              console.warn('[gmail-organizer] Skipping thread ' + thread.id + ' — no label ID for "' + catLabel + '"');
            }
            processedCount++;
          }
        }
        continue;
      }

      // Rule matched — but if thread is keep-in protected, downgrade action to label-only
      if (isProtected) {
        var origAction = getActionMode(match.rule, settings.archiveMatches);
        if (origAction === 'archive' || origAction === 'trash') {
          // Only label, don't move out of inbox
          match = Object.assign({}, match, { rule: Object.assign({}, match.rule, { action: 'label' }) });
        }
      }

      // Enforce Category/Subcategory label style (shared normalizeLabelName)
      var _rawLabel = normalizeLabelName(match.rule.label || 'Updates/General');
      if (_rawLabel !== match.rule.label) {
        match = Object.assign({}, match, { rule: Object.assign({}, match.rule, { label: _rawLabel }) });
      }
      var labelId = labelsByName.get(match.rule.label) || null;

      // Idempotency check: skip if message already has the target Gmail label
      const existingLabelIds = (thread.messages && thread.messages[0] && thread.messages[0].labelIds) || [];
      if (labelId && existingLabelIds.indexOf(labelId) !== -1) {
        processedCount++;
        continue;
      }
      if (!labelId && !dryRun) {
        try {
          labelId = await createLabel(token, match.rule.label, match.rule.color);
          labelsByName.set(match.rule.label, labelId);
          createdLabels.push(match.rule.label);
        } catch (labelErr) {
          labelsByName = await getLabelsByName(token);
          await trackQuotaUnit(5);
          labelId = labelsByName.get(match.rule.label) || null;
          if (!labelId) {
            console.warn("Could not create or find label \"" + match.rule.label + "\":", labelErr.message);
          }
        }
      }
      // If label is still missing after creation attempt, skip — don't count as organized
      if (!labelId && !dryRun) {
        console.warn("[gmail-organizer] Skipping thread " + thread.id + " — no labelId for \"" + match.rule.label + "\"");
        continue;
      }

      var action = getActionMode(match.rule, settings.archiveMatches);
      actions.push({ threadId: thread.id, subject: match.subject, from: match.from, label: match.rule.label, labelId: labelId, action: action });
      if (!dryRun && labelId) {
        pendingApply.push({ threadId: thread.id, labelId: labelId, action: action, decisionMeta: { label: match.rule.label, ruleId: match.rule.id || null, ruleName: match.rule.name || '', from: match.from, subject: match.subject, reason: 'rule:' + (match.rule.name || match.rule.label) } });
      }
      processedCount++;
    }

    // ── Phase 2: Apply all actions concurrently (10 at a time) ───────────────
    // Group archive/label actions by (labelId, action) and batch-modify, trash individually.
    if (!dryRun && pendingApply.length > 0) {
      tsLog('log', 'organizeInboxWithRules — applying', pendingApply.length, 'action(s) in batch');

      // Separate trash from label/archive actions
      var trashItems = pendingApply.filter(function(p) { return p.action === 'trash'; });
      var modifyItems = pendingApply.filter(function(p) { return p.action !== 'trash'; });

      // Group modify actions by key "labelId|action" for batchModify
      var modifyGroups = new Map();
      for (var _mi = 0; _mi < modifyItems.length; _mi++) {
        var _p = modifyItems[_mi];
        var _key = (_p.labelId || '') + '|' + _p.action;
        if (!modifyGroups.has(_key)) modifyGroups.set(_key, { labelId: _p.labelId, action: _p.action, threadIds: [] });
        modifyGroups.get(_key).threadIds.push(_p.threadId);
      }

      // Batch-modify each group: get all message IDs for threads then call batchModify
      for (var _group of modifyGroups.values()) {
        var _addLabels = _group.labelId ? [_group.labelId] : [];
        var _removeLabels = (_group.action === 'archive') ? ['INBOX'] : [];
        // Use threads modify endpoint for each thread in parallel (batchModify is message-level)
        await parallelMap(_group.threadIds, async function(tid) {
          var _r = await fetch(GMAIL_API_BASE + "/threads/" + tid + "/modify", {
            method: "POST", headers: buildHeaders(token),
            body: JSON.stringify({ addLabelIds: _addLabels, removeLabelIds: _removeLabels })
          });
          await trackQuotaUnit(5);
          if (!_r.ok) tsLog('warn', 'thread modify failed', tid, _r.status);
        }, 10);
      }

      // Trash actions in parallel
      if (trashItems.length > 0) {
        await parallelMap(trashItems, async function(_p) {
          try {
            if (_p.labelId) {
              await fetch(GMAIL_API_BASE + "/threads/" + _p.threadId + "/modify", {
                method: "POST", headers: buildHeaders(token),
                body: JSON.stringify({ addLabelIds: [_p.labelId], removeLabelIds: [] })
              });
              await trackQuotaUnit(5);
            }
            await trashThread(token, _p.threadId);
          } catch (_e) { tsLog('warn', 'trash thread failed', _p.threadId, _e && _e.message); }
        }, 10);
      }

      // Store label decisions (fast, in-memory storage)
      for (var _pi = 0; _pi < pendingApply.length; _pi++) {
        var _dm = pendingApply[_pi].decisionMeta;
        if (_dm) _storeLabelDecision({ threadId: pendingApply[_pi].threadId, label: _dm.label, ruleId: _dm.ruleId, ruleName: _dm.ruleName, from: _dm.from, subject: _dm.subject, reason: _dm.reason });
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (!dryRun) {
      await clearRuleRunCheckpoint();
    }

    if (!dryRun && actions.length) {
      var notificationId = "organize::" + (actions[0] && actions[0].label ? actions[0].label : "unlabeled") + "::" + Date.now();
      await chrome.notifications.create(notificationId, { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon-128.png"), title: "Gmail Organizer", message: "Organized " + actions.length + " thread(s)." });
    }
    tsLog('log', 'organizeInboxWithRules done — scanned:', threads.length, 'matched:', actions.length, 'dryRun:', dryRun);
    var result = buildResult({ actions: actions, dryRun: dryRun, scannedThreads: threads.length, createdLabels: createdLabels, source: source });
    if (!dryRun) {
      await pruneUndoHistory();
      await appendHistoryEntry(toHistoryEntry(result, "success"));
      const incrementalEnabled = await getFeatureFlag('ff_incrementalSync', true);
      if (incrementalEnabled) {
        try {
          const currentHistoryId = await getCurrentHistoryId(token);
          if (currentHistoryId) {
            const updatedSettings = Object.assign({}, settings, { lastHistoryId: currentHistoryId });
            await chrome.storage.sync.set({ lastHistoryId: currentHistoryId });
          }
        } catch (e) {
          console.warn('[gmail-organizer] could not update historyId:', e.message);
        }
      }
    }
    return result;
  } finally {
    if (mutexId) await releaseRunMutex(mutexId);
  }
}

async function bulkArchiveOldThreads(opts) {
  var dryRun = opts.dryRun;
  var olderThanDays = opts.olderThanDays || 14;
  var token = await getToken();
  var query = "in:inbox is:read older_than:" + olderThanDays + "d";
  var refs = await gmailRequest(token, "/threads?q=" + encodeURIComponent(query) + "&maxResults=200");
  var threads = refs.threads || [];
  if (!threads.length) {
    return { dryRun: dryRun, archived: 0, total: 0, message: "No old read threads found.", previews: [] };
  }

  // On dry run, fetch subject/sender/date for each thread (up to 50 for preview)
  var previews = [];
  if (dryRun) {
    var previewThreads = threads.slice(0, 50);
    await Promise.all(previewThreads.map(async function(t) {
      try {
        var detail = await gmailRequest(token, "/threads/" + t.id + "?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date");
        var msg = detail.messages && detail.messages[0];
        var headers = (msg && msg.payload && msg.payload.headers) || [];
        var get = function(name) { var h = headers.find(function(h) { return h.name.toLowerCase() === name.toLowerCase(); }); return h ? h.value : ""; };
        previews.push({
          threadId: t.id,
          from: get("From"),
          subject: get("Subject") || "(no subject)",
          date: get("Date")
        });
      } catch (_) {}
    }));
  }

  var archived = 0;
  if (!dryRun) {
    var threadIds = threads.map(function(t) { return t.id; });
    const batchEnabled = await getFeatureFlag('ff_batchModify', true);
    if (batchEnabled && threadIds.length > 1) {
      await gmailBatchModify(token, threadIds, [], ["INBOX"]);
      archived = threadIds.length;
    } else {
      for (var i = 0; i < threadIds.length; i++) {
        await fetch(GMAIL_API_BASE + "/threads/" + threadIds[i] + "/modify", {
          method: "POST",
          headers: buildHeaders(token),
          body: JSON.stringify({ removeLabelIds: ["INBOX"] })
        });
        await trackQuotaUnit(5);
        archived++;
        await sleep(50);
      }
    }
  }
  return { dryRun: dryRun, archived: dryRun ? threads.length : archived, total: threads.length, message: dryRun ? threads.length + " old read thread(s) would be archived." : "Archived " + archived + " old read thread(s).", previews: previews };
}

function buildResult(opts) {
  return { dryRun: opts.dryRun, source: opts.source || "manual", scannedThreads: opts.scannedThreads, matchedThreads: opts.actions.length, createdLabels: opts.createdLabels || [], actions: opts.actions };
}

function toHistoryEntry(result, status) {
  var arch = result.actions.filter(function(a) { return a.action === "archive"; }).length;
  var trash = result.actions.filter(function(a) { return a.action === "trash"; }).length;
  var cl = result.createdLabels || [];
  var parts = [result.matchedThreads + " matched", cl.length > 0 ? cl.length + " label(s) created" : "", arch > 0 ? arch + " archived" : "", trash > 0 ? trash + " trashed" : ""].filter(Boolean);
  return { id: crypto.randomUUID(), timestamp: new Date().toISOString(), source: result.source, status: status, undoable: status === "success" && result.actions.length > 0 && !result.dryRun, undoneAt: null, summary: parts.join(", ") || "No matches", scannedThreads: result.scannedThreads, matchedThreads: result.matchedThreads, actions: result.actions, previewActions: result.actions.slice(0, 5) };
}

async function undoRun(runId) {
  if (!runId) throw new Error("Missing run id.");
  var history = await getHistory();
  var idx = -1;
  for (var i = 0; i < history.length; i++) { if (history[i].id === runId) { idx = i; break; } }
  if (idx === -1) throw new Error("Run not found.");
  var entry = history[idx];
  if (!entry.undoable || entry.status !== "success") throw new Error("Cannot undo this run.");
  var token = await getToken();
  for (var j = 0; j < (entry.actions || []).length; j++) {
    var a = entry.actions[j];
    if (a.threadId && a.labelId) await reverseThreadUpdate(token, a.threadId, a.labelId, a.action);
  }
  var undoneAt = new Date().toISOString();
  history[idx] = Object.assign({}, entry, { status: "undone", undoable: false, undoneAt: undoneAt, summary: "Undone: " + entry.summary });
  history.unshift({ id: crypto.randomUUID(), timestamp: undoneAt, source: "undo", status: "success", undoable: false, undoneAt: null, summary: "Reverted " + (entry.matchedThreads || 0) + " thread(s).", scannedThreads: entry.scannedThreads || 0, matchedThreads: entry.matchedThreads || 0, actions: [], previewActions: [] });
  await replaceHistory(history);
  return { runId: runId, undoneAt: undoneAt, matchedThreads: entry.matchedThreads || 0 };
}

// Tech/SaaS domains that should never be labelled as Travel or Finance,
// even if the user's AI-generated rules accidentally put them there.
var NEVER_TRAVEL_OR_FINANCE_DOMAINS = [
  "n8n.io","notion.so","figma.com","airtable.com","asana.com","trello.com",
  "monday.com","clickup.com","linear.app","slack.com","discord.com",
  "github.com","gitlab.com","bitbucket.org","vercel.com","netlify.com",
  "heroku.com","digitalocean.com","firebase.google.com","anthropic.com",
  "openai.com","zapier.com","make.com","hubspot.com","intercom.io",
  "mailchimp.com","convertkit.com","beehiiv.com","substack.com",
  "twilio.com","sendgrid.com","sentry.io","datadog.com","supabase.com",
  "planetscale.com","railway.app","render.com","aws.amazon.com"
];

function isMiscategorized(rule, from) {
  var label = (rule.label || "").toLowerCase();
  if (!label.startsWith("travel") && !label.startsWith("finance")) return false;
  return NEVER_TRAVEL_OR_FINANCE_DOMAINS.some(function(d) { return senderMatchesDomain(from, d); });
}

function findRuleMatch(thread, rules) {
  var msg = thread.messages && thread.messages[0];
  var headers = (msg && msg.payload && msg.payload.headers) || [];
  var from = getHeader(headers, "From").toLowerCase();
  var subject = getHeader(headers, "Subject");
  var subjectLow = subject.toLowerCase();
  for (var i = 0; i < rules.length; i++) {
    var rule = rules[i];
    var fd = rule.match.fromDomains, fi = rule.match.fromIncludes, si = rule.match.subjectIncludes;
    var hasSenderCriteria = (fd && fd.length > 0) || (fi && fi.length > 0);
    var domainMatch = fd && fd.some(function(d) { return senderMatchesDomain(from, d); });
    var includeMatch = fi && fi.some(function(s) { return from.indexOf(s) !== -1; });
    var subjectMatch = si && si.some(function(s) { return subjectLow.indexOf(s) !== -1; });

    var matched = hasSenderCriteria ? (domainMatch || includeMatch) : subjectMatch;
    if (!matched) continue;

    // Veto matches where a known tech/SaaS domain got mislabelled as Travel or Finance
    // (common when AI rules are auto-generated from inbox history).
    if (isMiscategorized(rule, from)) continue;

    return { rule: rule, from: getHeader(headers, "From"), subject: subject };
  }
  return null;
}

function senderMatchesDomain(from, domain) {
  var normalizedDomain = String(domain || "").toLowerCase().trim();
  if (!normalizedDomain) return false;

  var emailMatches = from.match(/[a-z0-9._%+-]+@([a-z0-9.-]+\.[a-z]{2,})/g) || [];
  for (var i = 0; i < emailMatches.length; i++) {
    var email = emailMatches[i];
    var atIndex = email.lastIndexOf("@");
    var emailDomain = atIndex >= 0 ? email.slice(atIndex + 1).toLowerCase() : "";
    if (emailDomain === normalizedDomain || emailDomain.endsWith("." + normalizedDomain)) {
      return true;
    }
  }

  return false;
}

function getHeader(headers, name) {
  var n = name.toLowerCase();
  for (var i = 0; i < headers.length; i++) {
    if (headers[i].name && headers[i].name.toLowerCase() === n) return headers[i].value || "";
  }
  return "";
}

async function getLabelsByName(token) {
  const cacheEnabled = await getFeatureFlag('ff_cacheLabels', true);
  if (cacheEnabled && labelIdCache.size > 0) {
    return new Map(labelIdCache);
  }

  var r = await gmailRequest(token, "/labels");
  var map = new Map();
  (r.labels || []).forEach(function(l) { map.set(l.name, l.id); });

  // Persist cache to storage and memory
  if (cacheEnabled) {
    labelIdCache.clear();
    map.forEach((id, name) => labelIdCache.set(name, id));
    const cacheObj = {};
    map.forEach((id, name) => cacheObj[name] = id);
    await chrome.storage.local.set({ labelIdCache: cacheObj });
  }

  return map;
}

async function createLabel(token, name, color) {
  validateLabelName(name);
  await ensureParentLabels(token, name);
  var body = { name: name, labelListVisibility: "labelShow", messageListVisibility: "show" };
  var resolvedColor = color || getCategoryColor(name);
  if (resolvedColor) body.color = { backgroundColor: resolvedColor, textColor: getLabelTextColor(resolvedColor) };
  var r = await fetch(GMAIL_API_BASE + "/labels", { method: "POST", headers: buildHeaders(token), body: JSON.stringify(body) });
  await trackQuotaUnit(10);
  if (!r.ok) {
    var errBody = null;
    try { errBody = await r.json(); } catch (_) {}
    if (r.status === 409 || (errBody && errBody.error && errBody.error.message && errBody.error.message.indexOf("already exists") !== -1)) {
      var existing = await getLabelsByName(token);
      var existingId = existing.get(name);
      if (existingId) return existingId;
    }
    throw new Error("Failed to create label \"" + name + "\": " + (errBody && errBody.error && errBody.error.message ? errBody.error.message : "HTTP " + r.status));
  }
  return (await r.json()).id;
}

async function ensureParentLabels(token, fullName) {
  validateLabelName(fullName);
  if (String(fullName).indexOf("/") === -1) return;

  var labelsByName = await getLabelsByName(token);
  var parts = String(fullName).split("/");
  for (var i = 1; i < parts.length; i++) {
    var parentName = parts.slice(0, i).join("/");
    if (labelsByName.has(parentName)) continue;

    var r = await fetch(GMAIL_API_BASE + "/labels", {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify({
        name: parentName,
        labelListVisibility: "labelShow",
        messageListVisibility: "show"
      })
    });
    if (!r.ok) {
      // Always try a fresh lookup first — label may already exist (409 or system label conflict)
      var refreshed = await getLabelsByName(token);
      var existingId = refreshed.get(parentName);
      if (existingId) { labelsByName.set(parentName, existingId); continue; }
      // Non-fatal: log and skip rather than aborting the whole organize run
      tsLog('warn', 'ensureParentLabels: could not create parent "' + parentName + '" (HTTP ' + r.status + '), skipping');
      continue;
    }
    var created = await r.json();
    labelsByName.set(parentName, created.id);
  }
}

async function modifyThread(token, threadId, labelId, removeInbox) {
  var addLabelIds = labelId ? [labelId] : [];
  var r = await fetch(GMAIL_API_BASE + "/threads/" + threadId + "/modify", { method: "POST", headers: buildHeaders(token), body: JSON.stringify({ addLabelIds: addLabelIds, removeLabelIds: removeInbox ? ["INBOX"] : [] }) });
  await trackQuotaUnit(5);
  if (!r.ok) throw new Error("Failed to modify thread.");
}

async function applyThreadAction(token, threadId, labelId, action) {
  if (action === "trash") { await modifyThread(token, threadId, labelId, false); await trashThread(token, threadId); return; }
  await modifyThread(token, threadId, labelId, action === "archive");
}

async function trashThread(token, id) {
  var r = await fetch(GMAIL_API_BASE + "/threads/" + id + "/trash", { method: "POST", headers: buildHeaders(token) });
  await trackQuotaUnit(5);
  if (!r.ok) throw new Error("Failed to trash thread.");
}

async function untrashThread(token, id) {
  var r = await fetch(GMAIL_API_BASE + "/threads/" + id + "/untrash", { method: "POST", headers: buildHeaders(token) });
  await trackQuotaUnit(5);
  if (!r.ok) throw new Error("Failed to untrash thread.");
}

// Labels that are important enough to keep in inbox (not archived after labeling).
// Everything else gets archived (removed from inbox) so the inbox actually gets cleaned.
var KEEP_IN_INBOX_LABEL_PREFIXES = ["finance", "work", "important", "urgent", "inbox"];

function getActionMode(rule, fb) {
  if (rule.action === "trash") return "trash";
  if (rule.action === "archive" || fb) return "archive";
  // "label"-action rules: archive everything except finance/work/important labels
  // so that "Organize Inbox" actually clears the inbox instead of just tagging
  if (rule.action === "label") {
    var labelLow = String(rule.label || "").toLowerCase();
    var keepInInbox = KEEP_IN_INBOX_LABEL_PREFIXES.some(function(p) { return labelLow.startsWith(p); });
    return keepInInbox ? "label" : "archive";
  }
  return "label";
}

async function reverseThreadUpdate(token, threadId, labelId, action) {
  if (action === "trash") await untrashThread(token, threadId);
  var r = await fetch(GMAIL_API_BASE + "/threads/" + threadId + "/modify", { method: "POST", headers: buildHeaders(token), body: JSON.stringify({ addLabelIds: (action === "archive" || action === "trash") ? ["INBOX"] : [], removeLabelIds: [labelId] }) });
  await trackQuotaUnit(5);
  if (!r.ok) throw new Error("Failed to undo thread.");
}

async function emptyTrash(opts) {
  let mutexId = null;
  try {
    mutexId = await acquireRunMutex('empty-trash');

    var dryRun = opts.dryRun, source = opts.source || "manual";
    var settings = await getSettings();
    var token = await getToken();
    var threads = await listTrashThreads(token, settings.autoEmptyTrashOlderThanDays);
    var deleted = 0, failed = 0;
    if (!dryRun) {
      for (var i = 0; i < threads.length; i += 5) {
        var batch = threads.slice(i, i + 5);
        await Promise.all(batch.map(async function(t) { try { await permanentlyDeleteThread(token, t.id); deleted++; } catch (_) { failed++; } }));
        chrome.runtime.sendMessage({ type: "trashProgress", deleted: deleted, total: threads.length, failed: failed }).catch(function() {});
        if (i + 5 < threads.length) await sleep(150);
      }
      if (deleted > 0) {
        var notificationId = "trash-" + crypto.randomUUID();
        await chrome.notifications.create(notificationId, { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon-128.png"), title: "Gmail Organizer", message: "Deleted " + deleted + " trash email(s)." + (failed > 0 ? " " + failed + " skipped." : "") });
        await rememberNotificationTarget(notificationId, { type: "trash" });
      }
      var ageNote = settings.autoEmptyTrashOlderThanDays > 0 ? " older than " + settings.autoEmptyTrashOlderThanDays + " days" : "";
      await appendHistoryEntry({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), source: "empty-trash", status: "success", undoable: false, undoneAt: null, summary: "Deleted " + deleted + " trash thread(s)" + ageNote + (failed > 0 ? ", " + failed + " skipped." : "."), scannedThreads: threads.length, matchedThreads: deleted, actions: [], previewActions: [] });
    }
    return { dryRun: dryRun, source: source, count: threads.length, deleted: deleted, failed: failed, olderThanDays: settings.autoEmptyTrashOlderThanDays };
  } finally {
    if (mutexId) await releaseRunMutex(mutexId);
  }
}

async function listTrashThreads(token, days) {
  var q = days > 0 ? "in:trash older_than:" + days + "d" : "in:trash";
  var all = [], pt = null;
  do {
    var r = await gmailRequest(token, "/threads?q=" + encodeURIComponent(q) + "&maxResults=100" + (pt ? "&pageToken=" + pt : ""));
    all = all.concat(r.threads || []);
    pt = r.nextPageToken || null;
  } while (pt && all.length < 500);
  return all;
}

async function permanentlyDeleteThread(token, id) {
  var r = await fetchWithRetry(GMAIL_API_BASE + "/threads/" + id, { method: "DELETE", headers: { Authorization: "Bearer " + token } });
  await trackQuotaUnit(5);
  if (!r.ok && r.status !== 204) throw new Error("Failed to delete thread.");
}

var _inboxScoreCache = null;
var _inboxScoreCacheAt = 0;
const INBOX_SCORE_CACHE_MS = 3 * 60 * 1000; // 3 minutes

async function getInboxScore() {
  // Return cached result if fresh enough
  if (_inboxScoreCache && (Date.now() - _inboxScoreCacheAt) < INBOX_SCORE_CACHE_MS) {
    return _inboxScoreCache;
  }
  var token = await getToken();
  var results = await Promise.all([
    gmailRequest(token, "/threads?q=in:inbox&maxResults=1").catch(function() { return { resultSizeEstimate: 0 }; }),
    gmailRequest(token, "/threads?q=in:inbox is:unread&maxResults=1").catch(function() { return { resultSizeEstimate: 0 }; }),
    gmailRequest(token, "/threads?q=in:inbox older_than:7d&maxResults=1").catch(function() { return { resultSizeEstimate: 0 }; })
  ]);
  var total = results[0].resultSizeEstimate || 0;
  var unread = results[1].resultSizeEstimate || 0;
  var old = results[2].resultSizeEstimate || 0;
  var score = 100;
  var breakdown = [];

  if (total > 0) {
    var unreadPenalty = Math.min(40, Math.round((unread / Math.max(total, 1)) * 40));
    if (unreadPenalty > 0) { score -= unreadPenalty; breakdown.push({ label: 'Unread emails', value: unread, penalty: unreadPenalty }); }

    var oldPenalty = Math.min(30, Math.round((old / Math.max(total, 1)) * 30));
    if (oldPenalty > 0) { score -= oldPenalty; breakdown.push({ label: 'Emails older than 7 days', value: old, penalty: oldPenalty }); }

    if (total > 1000) { score -= 10; breakdown.push({ label: 'Inbox over 1,000 threads', value: total, penalty: 10 }); }
    else if (total > 500) { score -= 10; breakdown.push({ label: 'Inbox over 500 threads', value: total, penalty: 10 }); }
    else if (total > 100) { score -= 10; breakdown.push({ label: 'Inbox over 100 threads', value: total, penalty: 10 }); }
  }

  score = Math.max(0, Math.min(100, score));
  var grade, label;
  if (score >= 85) { grade = "A"; label = "Excellent"; }
  else if (score >= 70) { grade = "B"; label = "Good"; }
  else if (score >= 50) { grade = "C"; label = "Fair"; }
  else if (score >= 30) { grade = "D"; label = "Needs work"; }
  else { grade = "F"; label = "Critical"; }
  var _scoreResult = { score: score, grade: grade, label: label, total: total, unread: unread, old: old, breakdown: breakdown };
  _inboxScoreCache = _scoreResult;
  _inboxScoreCacheAt = Date.now();
  return _scoreResult;
}

async function scanUnsubscribes() {
  var token = await getToken();
  var data = await gmailRequest(token, "/threads?q=" + encodeURIComponent("in:inbox (unsubscribe OR \"opt out\")") + "&maxResults=50");
  var threads = (data.threads || []).slice(0, 20);
  var metas = await parallelMap(threads, async function(ref) {
    try {
      return await gmailRequest(token, "/threads/" + ref.id + "?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe");
    } catch (e) { return null; }
  }, 10);
  var results = [];
  for (var i = 0; i < metas.length; i++) {
    var t = metas[i];
    if (!t) continue;
    var firstMsg = t.messages && t.messages[0];
    var headers = (firstMsg && firstMsg.payload && firstMsg.payload.headers) || [];
    var from = getHeader(headers, "From");
    var subject = getHeader(headers, "Subject");
    var lu = getHeader(headers, "List-Unsubscribe");
    if (lu || subject.toLowerCase().indexOf("unsubscribe") !== -1) {
      var urlM = lu ? lu.match(/<(https?:[^>]+)>/) : null;
      var mailM = lu ? lu.match(/<mailto:([^>]+)>/) : null;
      results.push({ threadId: threads[i].id, messageId: firstMsg ? firstMsg.id : null, from: from, subject: subject, unsubUrl: urlM ? urlM[1] : null, unsubMailto: mailM ? mailM[1] : null, hasHeader: !!lu });
    }
  }
  return { count: results.length, items: results };
}

async function scanDuplicates() {
  var token = await getToken();
  var data = await gmailRequest(token, "/threads?q=in:inbox&maxResults=100");
  var threads = data.threads || [];
  // Fetch all metadata in parallel — was sequential with 80ms sleep per thread (8s+ for 100 threads)
  var metas = await parallelMap(threads, async function(ref) {
    try {
      return await gmailRequest(token, "/threads/" + ref.id + "?format=metadata&metadataHeaders=From&metadataHeaders=Subject");
    } catch (e) { return null; }
  }, 10);
  var seen = new Map(), dupes = [];
  var DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
  for (var i = 0; i < metas.length; i++) {
    var t = metas[i];
    if (!t) continue;
    var firstMsg = t.messages && t.messages[0];
    var headers = (firstMsg && firstMsg.payload && firstMsg.payload.headers) || [];
    var from = getHeader(headers, "From");
    var subject = getHeader(headers, "Subject").trim().toLowerCase().replace(/^(re:|fwd?:|fw:)\s*/gi, "");
    var date = parseInt(firstMsg && firstMsg.internalDate || "0", 10);
    var key = from + "|||" + subject;
    if (seen.has(key)) {
      var orig = seen.get(key);
      var timeDiff = Math.abs(date - orig.date);
      if (timeDiff <= DUPLICATE_WINDOW_MS) {
        if (!orig.counted) { dupes.push({ threadId: orig.threadId, from: from, subject: subject, isDuplicate: false }); orig.counted = true; }
        dupes.push({ threadId: threads[i].id, from: from, subject: subject, isDuplicate: true });
      }
    } else {
      seen.set(key, { threadId: threads[i].id, date: date, counted: false });
    }
  }
  var ids = dupes.filter(function(d) { return d.isDuplicate; }).map(function(d) { return d.threadId; });
  return { count: ids.length, threadIds: ids, items: dupes.slice(0, 10) };
}

async function deleteDuplicates(threadIds) {
  if (!threadIds || !threadIds.length) return { deleted: 0 };
  var token = await getToken();
  var deleted = 0;
  // Use trash (not permanent delete) — permanent delete requires the
  // https://mail.google.com/ scope which we don't request. gmail.modify allows trash.
  for (var i = 0; i < threadIds.length; i += 5) {
    var batch = threadIds.slice(i, i + 5);
    await Promise.all(batch.map(async function(id) {
      try { await trashThread(token, id); deleted++; } catch (_) {}
    }));
    if (i + 5 < threadIds.length) await sleep(150);
  }
  return { deleted: deleted };
}

async function scanFollowUps() {
  var token = await getToken();
  var data = await gmailRequest(token, "/threads?q=in:sent older_than:3d&maxResults=50");
  var threads = (data.threads || []).slice(0, 30);
  var metas = await parallelMap(threads, async function(ref) {
    try {
      return await gmailRequest(token, "/threads/" + ref.id + "?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=To");
    } catch (e) { return null; }
  }, 10);
  var items = [];
  for (var i = 0; i < metas.length; i++) {
    var t = metas[i];
    if (!t) continue;
    var msgs = t.messages || [];
    if (msgs.length === 1) {
      var headers = (msgs[0].payload && msgs[0].payload.headers) || [];
      var to = getHeader(headers, "To");
      var subject = getHeader(headers, "Subject");
      var internalDate = parseInt(msgs[0].internalDate || "0", 10);
      var daysAgo = internalDate > 0 ? Math.floor((Date.now() - internalDate) / 86400000) : 0;
      items.push({ threadId: threads[i].id, to: to, subject: subject, daysAgo: daysAgo });
    }
  }
  return { count: items.length, items: items.slice(0, 8) };
}

async function getStats() {
  var history = await getHistory();
  var now = Date.now();
  var oneWeek = 7 * 24 * 3600 * 1000;
  var organized = history.filter(function(e) { return e.source !== "empty-trash" && e.status === "success"; });
  var trashRuns = history.filter(function(e) { return e.source === "empty-trash" && e.status === "success"; });
  var thisWeek = organized.filter(function(e) { return now - new Date(e.timestamp).getTime() < oneWeek; });
  var labelCounts = {};
  history.forEach(function(e) { (e.actions || []).forEach(function(a) { if (a.label) labelCounts[a.label] = (labelCounts[a.label] || 0) + 1; }); });
  var topLabels = Object.keys(labelCounts).map(function(k) { return { label: k, count: labelCounts[k] }; }).sort(function(a, b) { return b.count - a.count; }).slice(0, 5);
  return {
    totalOrganized: organized.reduce(function(s, e) { return s + (e.matchedThreads || 0); }, 0),
    totalDeleted: trashRuns.reduce(function(s, e) { return s + (e.matchedThreads || 0); }, 0),
    weekOrganized: thisWeek.reduce(function(s, e) { return s + (e.matchedThreads || 0); }, 0),
    totalRuns: organized.length, topLabels: topLabels,
    lastRun: organized.length > 0 ? organized[0].timestamp : null
  };
}

const TIME_PER_EMAIL_SECONDS = 15;

async function getAnalytics() {
  const history = await getHistory();
  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  const organized = history.filter(e => e.source !== "empty-trash" && e.status === "success");
  const deleted = history.filter(e => e.source === "empty-trash" && e.status === "success");
  const unsubscribed = history.filter(e => e.source === "unsubscribe" && e.status === "success");
  const thisWeek = organized.filter(e => now - new Date(e.timestamp).getTime() < 7 * 24 * 60 * 60 * 1000);
  const thisMonth = organized.filter(e => now - new Date(e.timestamp).getTime() < thirtyDaysMs);

  const totalOrganized = organized.reduce((s, e) => s + (e.matchedThreads || 0), 0);
  const totalDeleted = deleted.reduce((s, e) => s + (e.matchedThreads || 0), 0);
  const totalUnsubscribed = unsubscribed.reduce((s, e) => s + (e.matchedThreads || 0), 0);
  const weekOrganized = thisWeek.reduce((s, e) => s + (e.matchedThreads || 0), 0);
  const monthOrganized = thisMonth.reduce((s, e) => s + (e.matchedThreads || 0), 0);

  const ruleStats = {};
  history.forEach(e => {
    (e.actions || []).forEach(a => {
      if (!a.label) return;
      if (!ruleStats[a.label]) ruleStats[a.label] = { matches: 0, lastMatch: null, runs: 0 };
      ruleStats[a.label].matches++;
      if (!ruleStats[a.label].lastMatch) ruleStats[a.label].lastMatch = e.timestamp;
    });
  });

  const perRule = Object.keys(ruleStats).map(label => {
    const stat = ruleStats[label];
    return { label: label, matches: stat.matches, lastMatch: stat.lastMatch, avgPerRun: stat.matches / Math.max(1, stat.runs) };
  }).sort((a, b) => b.matches - a.matches).slice(0, 20);

  const senderStats = {};
  history.forEach(e => {
    (e.actions || []).forEach(a => {
      if (!a.from) return;
      if (!senderStats[a.from]) senderStats[a.from] = 0;
      senderStats[a.from]++;
    });
  });
  const topSenders = Object.keys(senderStats).map(from => ({ from: from, count: senderStats[from] })).sort((a, b) => b.count - a.count).slice(0, 10);

  const labelCounts = {};
  history.forEach(e => {
    (e.actions || []).forEach(a => {
      if (a.label) labelCounts[a.label] = (labelCounts[a.label] || 0) + 1;
    });
  });
  const topLabels = Object.keys(labelCounts).map(k => ({ label: k, count: labelCounts[k] })).sort((a, b) => b.count - a.count).slice(0, 10);

  const dailyTrend = {};
  organized.forEach(e => {
    const day = e.timestamp ? new Date(e.timestamp).toISOString().slice(0, 10) : null;
    if (day) dailyTrend[day] = (dailyTrend[day] || 0) + (e.matchedThreads || 0);
  });
  const thirtyDaysAgo = new Date(now - thirtyDaysMs);
  // Build dailyVolume array — use 'count' field (also keep 'organized' as alias for backwards compat)
  const trend = [];
  for (let d = new Date(thirtyDaysAgo); d <= new Date(now); d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    const cnt = dailyTrend[dateStr] || 0;
    trend.push({ date: dateStr, count: cnt, organized: cnt });
  }

  const quotaInfo = await getQuotaUsage();
  const lastRuns = history.filter(e => e.source === "manual" || e.source === "auto").slice(0, 10);

  // Compute totalMatched (last 30 days) and avgMatchRate
  const totalMatched = thisMonth.reduce((s, e) => s + (e.matchedThreads || 0), 0);
  const totalScanned = thisMonth.reduce((s, e) => s + (e.scannedThreads || 0), 0);
  const avgMatchRate = totalScanned > 0 ? Math.round((totalMatched / totalScanned) * 100) : 0;

  // quotaUsed as a percentage (estimate: daily Gmail API quota is ~1000 units, use today's count)
  const quotaUsedPct = Math.min(100, Math.round(((quotaInfo.today || 0) / 1000) * 100));

  tsLog('log', 'getAnalytics completed — totalOrganized:', totalOrganized, 'topSenders:', topSenders.length, 'topLabels:', topLabels.length);

  return {
    totals: { organized: totalOrganized, deleted: totalDeleted, unsubscribed: totalUnsubscribed, weekOrganized: weekOrganized, monthOrganized: monthOrganized, thisWeek: weekOrganized, thisMonth: monthOrganized },
    timeSavedSeconds: totalOrganized * TIME_PER_EMAIL_SECONDS,
    perRule: perRule,
    topSenders: topSenders,          // array of { from: string, count: number }
    topLabels: topLabels,            // array of { label: string, count: number }
    dailyTrend: trend,               // kept for backward compat (uses 'organized' field)
    dailyVolume: trend,              // canonical field name (uses 'count' field)
    quotaUsed: quotaUsedPct,         // number 0-100 (percentage)
    quotaRaw: quotaInfo,             // raw {today, thisMinute} for display
    lastRuns: lastRuns,              // last 10 manual/auto history entries
    totalOrganized: totalOrganized,  // all-time total
    totalMatched: totalMatched,      // last 30 days total matched
    avgMatchRate: avgMatchRate       // last 30 days match rate %
  };
}

async function getLabelStats() {
  try {
    const token = await getToken();
    // labels.list returns basic info; labels.get returns threadsTotal per label
    const listResp = await fetch(`${GMAIL_API_BASE}/labels`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!listResp.ok) return { labels: [] };
    const listData = await listResp.json();
    const userLabels = (listData.labels || []).filter(l => l.type === 'user');
    if (!userLabels.length) return { labels: [] };

    // Fetch thread counts for each user label in parallel (batched to avoid quota)
    const detailed = await Promise.all(
      userLabels.map(async l => {
        try {
          const r = await fetch(`${GMAIL_API_BASE}/labels/${l.id}`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          if (!r.ok) return null;
          return await r.json();
        } catch (_) { return null; }
      })
    );

    const result = detailed
      .filter(l => l && (l.threadsTotal > 0 || l.messagesTotal > 0))
      .sort((a, b) => (b.threadsTotal || 0) - (a.threadsTotal || 0))
      .map(l => ({ label: l.name, count: l.threadsTotal || 0, messages: l.messagesTotal || 0 }));

    tsLog('log', 'getLabelStats — found', result.length, 'user labels with threads');
    return { labels: result };
  } catch (e) {
    tsLog('warn', 'getLabelStats failed:', e.message);
    return { labels: [] };
  }
}

// ── Clean-up: scan for flat labels (no "/" in name) ──────────────────────────
async function scanFlatLabels() {
  try {
    const token = await getToken();
    const listResp = await fetch(`${GMAIL_API_BASE}/labels`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!listResp.ok) return { labels: [] };
    const listData = await listResp.json();
    const flat = (listData.labels || [])
      .filter(l => l.type === 'user' && l.name.indexOf('/') === -1);
    tsLog('log', 'scanFlatLabels — found', flat.length, 'flat labels');
    return { labels: flat.map(l => ({ id: l.id, name: l.name })) };
  } catch (e) {
    tsLog('warn', 'scanFlatLabels failed:', e.message);
    return { labels: [] };
  }
}

// ── Clean-up: delete an array of label IDs ────────────────────────────────────
async function deleteLabels(labelIds) {
  if (!Array.isArray(labelIds) || !labelIds.length) return { deleted: 0, errors: [] };
  const token = await getToken();
  let deleted = 0;
  const errors = [];
  const deletedIdSet = new Set();
  for (const id of labelIds) {
    try {
      const resp = await fetch(`${GMAIL_API_BASE}/labels/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (resp.ok || resp.status === 404) { deleted++; deletedIdSet.add(id); }
      else { errors.push(id); }
    } catch (e) { errors.push(id); }
  }

  // Evict deleted labels from the in-memory + persisted cache so the next
  // organize run doesn't try to reuse a stale ID and recreate the label.
  if (deletedIdSet.size > 0) {
    labelIdCache.forEach((cachedId, name) => {
      if (deletedIdSet.has(cachedId)) labelIdCache.delete(name);
    });
    // Persist the updated cache
    const cacheObj = {};
    labelIdCache.forEach((id, name) => { cacheObj[name] = id; });
    await chrome.storage.local.set({ labelIdCache: cacheObj });
  }

  tsLog('log', 'deleteLabels — deleted', deleted, 'errors', errors.length);
  return { deleted, errors };
}

// ── Retroactive category labeling ────────────────────────────────────────────
// Applies category labels (Action/To Respond, Updates/Marketing, etc.)
// to past emails using Gmail search queries — not domain rules.
async function retroactiveCatLabels(opts) {
  var maxPerCat = (opts && opts.maxPerCat) || 300;
  var token = await getToken();
  var totalLabeled = 0;
  var summary = [];

  // Pre-load label name → id map once
  var labelsByName = new Map();
  try {
    var listData = await gmailRequest(token, '/labels');
    for (var l of (listData.labels || [])) {
      labelsByName.set(l.name.toLowerCase(), l.id);
    }
  } catch (_) {}

  // Gmail search queries per category — each query targets the most common patterns
  var CAT_QUERIES = {
    'to-respond': [
      'newer_than:6m -from:noreply -from:no-reply subject:"quick question"',
      'newer_than:6m -from:noreply -from:no-reply subject:"can you"',
      'newer_than:6m -from:noreply -from:no-reply subject:"please review"',
      'newer_than:6m -from:noreply -from:no-reply subject:"following up"',
      'newer_than:6m -from:noreply -from:no-reply subject:"your feedback"',
      'newer_than:6m -from:noreply -from:no-reply subject:"let me know"',
      'newer_than:6m -from:noreply -from:no-reply subject:"please confirm"',
      'newer_than:6m -from:noreply -from:no-reply subject:"your thoughts"',
      'newer_than:6m -from:noreply -from:no-reply subject:"any update"',
      'newer_than:6m -from:noreply -from:no-reply subject:"waiting for"',
    ],
    'marketing': [
      'newer_than:6m (subject:"% off" OR subject:"discount" OR subject:"flash sale" OR subject:"limited time" OR subject:"promo code")',
      'newer_than:6m (subject:"new arrivals" OR subject:"shop now" OR subject:"exclusive offer" OR subject:"last chance")',
    ],
    'to-follow-up': [
      'newer_than:6m (subject:"follow up" OR subject:"checking in" OR subject:"gentle reminder" OR subject:"just checking")',
    ],
  };

  var catPrefs = await getCatPrefs();

  for (var catId of Object.keys(CAT_QUERIES)) {
    // Skip if category is disabled
    var pref = catPrefs[catId];
    if (pref && pref.action === 'off') continue;

    var labelName = CAT_LABELS[catId];
    if (!labelName) continue;

    // Get or create label
    var labelId = labelsByName.get(labelName.toLowerCase()) || null;
    if (!labelId) {
      try { var created = await ensureLabelExists(labelName); labelId = created && created.id; } catch (_) {}
    }
    if (!labelId) continue;

    // Collect unique thread IDs across all queries for this category
    var threadIds = new Set();
    for (var query of CAT_QUERIES[catId]) {
      try {
        var page = await gmailRequest(token, '/threads?q=' + encodeURIComponent(query) + '&maxResults=100');
        for (var t of (page.threads || [])) {
          if (threadIds.size < maxPerCat) threadIds.add(t.id);
        }
      } catch (_) {}
      await sleep(100);
    }

    if (threadIds.size === 0) continue;

    // Parallel apply — 10 at a time
    var ids = Array.from(threadIds);
    var catLabeled = 0;
    var PARALLEL = 10;
    for (var pi = 0; pi < ids.length; pi += PARALLEL) {
      var chunk = ids.slice(pi, pi + PARALLEL);
      var results = await Promise.allSettled(chunk.map(function(id) {
        return fetch(GMAIL_API_BASE + '/threads/' + id + '/modify', {
          method: 'POST',
          headers: buildHeaders(token),
          body: JSON.stringify({ addLabelIds: [labelId], removeLabelIds: [] })
        }).then(function(r) { return r.ok ? 1 : 0; });
      }));
      catLabeled += results.reduce(function(s, r) { return s + (r.status === 'fulfilled' ? (r.value || 0) : 0); }, 0);
      await trackQuotaUnit(chunk.length * 5);
      if (pi + PARALLEL < ids.length) await sleep(150);
    }

    if (catLabeled > 0) {
      totalLabeled += catLabeled;
      summary.push({ label: labelName, count: catLabeled });
      tsLog('info', 'retroactiveCatLabels: labeled', catLabeled, 'threads as', labelName);
    }
  }

  return { totalLabeled: totalLabeled, summary: summary };
}

async function getQuotaUsage() {
  const local = await chrome.storage.local.get({ gmailQuotaLog: [] });
  const log = Array.isArray(local.gmailQuotaLog) ? local.gmailQuotaLog : [];
  const now = Date.now();
  const oneMinute = 60000;
  const oneDay = 24 * 60 * 60 * 1000;

  const thisMinute = log.filter(t => now - t < oneMinute).length;
  const today = log.filter(t => now - t < oneDay).length;

  return { today: today, thisMinute: thisMinute };
}

async function testRule(rule, limit) {
  if (!rule) throw new Error("Rule object required.");
  const maxLimit = Math.min(limit || 50, 100);

  try {
    const token = await getToken();
    const data = await gmailRequest(token, "/threads?q=" + encodeURIComponent("in:inbox") + "&maxResults=" + maxLimit);
    const threads = data.threads || [];

    let checkedCount = 0, matchCount = 0, matches = [];
    for (let i = 0; i < threads.length; i++) {
      try {
        const t = await gmailRequest(token, "/threads/" + threads[i].id + "?format=metadata&metadataHeaders=From&metadataHeaders=Subject");
        checkedCount++;
        const match = findRuleMatch(t, [rule]);
        if (match) {
          matchCount++;
          if (matches.length < 5) {
            const headers = (t.messages && t.messages[0] && t.messages[0].payload && t.messages[0].payload.headers) || [];
            const from = getHeader(headers, "From");
            const subject = getHeader(headers, "Subject");
            const snippet = t.messages && t.messages[0] && t.messages[0].snippet ? t.messages[0].snippet.slice(0, 100) : "";
            const receivedAt = t.messages && t.messages[0] && t.messages[0].internalDate ? new Date(parseInt(t.messages[0].internalDate)).toISOString() : null;
            matches.push({ id: t.messages[0].id, threadId: threads[i].id, from: from, subject: subject, snippet: snippet, receivedAt: receivedAt });
          }
        }
      } catch (_) {}
      await sleep(50);
    }

    return { checkedCount: checkedCount, matchCount: matchCount, matches: matches };
  } catch (error) {
    const msg = translateGmailError(error && error.status, null, error && error.message);
    throw new Error(msg);
  }
}

// Store an unsubscribe event to the persistent log (max 200 entries)
// Also schedules a 7-day verification alarm for mailto/https unsubs
async function _storeUnsubscribeLog(entry) {
  try {
    const id = entry.id || ('unsub-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
    const stored = await chrome.storage.local.get({ unsubscribeLog: [] });
    const log = Array.isArray(stored.unsubscribeLog) ? stored.unsubscribeLog : [];
    log.unshift({ ...entry, id, timestamp: new Date().toISOString() });
    if (log.length > 200) log.length = 200;
    await chrome.storage.local.set({ unsubscribeLog: log });
    // Schedule 7-day verification for unsubscribes that need follow-up confirmation
    if (entry.verified !== 'confirmed' && entry.from) {
      const verifyAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
      chrome.alarms.create('gmailOrganizerUnsubVerify', { when: verifyAt });
    }
  } catch (_) {}
}

// Check pending unsubscribes — if sender still sending after 7 days, mark as failed
async function _runUnsubVerification() {
  try {
    const token = await getAuthToken({ interactive: false });
    if (!token) return;
    const stored = await chrome.storage.local.get({ unsubscribeLog: [] });
    const log = Array.isArray(stored.unsubscribeLog) ? stored.unsubscribeLog : [];
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let changed = false;
    for (let i = 0; i < log.length; i++) {
      const entry = log[i];
      if (entry.verified === 'confirmed' || entry.verified === 'failed') continue;
      if (!entry.from) continue;
      const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
      // Only check entries that are at least 7 days old
      if (ts > sevenDaysAgo) continue;
      // Search for emails from this sender received after the unsubscribe timestamp
      try {
        const afterEpoch = Math.floor(ts / 1000);
        const query = 'from:' + entry.from + ' after:' + afterEpoch;
        const resp = await fetch(
          GMAIL_API_BASE + '/messages?q=' + encodeURIComponent(query) + '&maxResults=1',
          { headers: buildHeaders(token) });
        const data = await resp.json();
        if (data.messages && data.messages.length > 0) {
          // Sender is still sending — unsubscribe failed
          log[i] = { ...entry, verified: 'failed', verifiedAt: new Date().toISOString() };
        } else {
          // No new emails — unsubscribe confirmed!
          log[i] = { ...entry, verified: 'confirmed', verifiedAt: new Date().toISOString() };
        }
        changed = true;
      } catch (_) {}
    }
    if (changed) {
      await chrome.storage.local.set({ unsubscribeLog: log });
    }
  } catch (_) {}
}

// Auto-send a mailto unsubscribe via Gmail API — returns true if sent
async function _sendMailtoUnsubscribe(token, mailtoStr) {
  // Parse: mailto:user@example.com?subject=unsubscribe&body=...
  const withoutScheme = mailtoStr.replace(/^mailto:/i, '');
  const qIdx = withoutScheme.indexOf('?');
  const toAddr = (qIdx > -1 ? withoutScheme.slice(0, qIdx) : withoutScheme).trim();
  if (!toAddr || !toAddr.includes('@')) return false;

  const params = new URLSearchParams(qIdx > -1 ? withoutScheme.slice(qIdx + 1) : '');
  const subject = params.get('subject') || 'Unsubscribe';
  const bodyText = params.get('body') || 'Please unsubscribe me from this mailing list.';

  // Build RFC 2822 raw message
  const rawMsg = [
    'To: ' + toAddr,
    'Subject: ' + subject,
    'Content-Type: text/plain; charset=utf-8',
    '',
    bodyText
  ].join('\r\n');

  // Base64url-encode
  const encoded = btoa(unescape(encodeURIComponent(rawMsg)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  try {
    const r = await fetch(GMAIL_API_BASE + '/messages/send', {
      method: 'POST',
      headers: buildHeaders(token),
      body: JSON.stringify({ raw: encoded })
    });
    await trackQuotaUnit(10);
    return r.ok;
  } catch (_) {
    return false;
  }
}

async function unsubscribeFromSender(messageId) {
  if (!messageId) throw new Error("Message ID required.");

  try {
    const token = await getToken();
    const msg = await gmailRequest(token, "/messages/" + messageId + "?format=metadata&metadataHeaders=From&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post");

    const headers = (msg.payload && msg.payload.headers) || [];
    const listUnsubscribe = getHeader(headers, "List-Unsubscribe") || "";
    const listUnsubscribePost = getHeader(headers, "List-Unsubscribe-Post") || "";
    const fromHeader = getHeader(headers, "From") || "";

    const isRfc8058 = listUnsubscribePost.toLowerCase().includes("list-unsubscribe=one-click");

    if (isRfc8058) {
      const urlMatch = listUnsubscribe.match(/<(https?:[^>]+)>/);
      if (urlMatch) {
        const unsubscribeUrl = urlMatch[1];
        try {
          const response = await fetchWithRetry(unsubscribeUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "List-Unsubscribe=One-Click"
          });
          if (response.ok || response.status === 200) {
            try { const threadId = msg.threadId; if (threadId) await modifyThread(token, threadId, null, true); } catch (_) {}
            await _storeUnsubscribeLog({ from: fromHeader, method: 'one-click', verified: 'posted', url: unsubscribeUrl });
            return { action: "auto-post", url: unsubscribeUrl, method: "one-click", verified: true, threadId: msg.threadId };
          }
        } catch (_) {
          // fall through to mailto / https
        }
      }
    }

    // Try mailto auto-send first — most reliable, verifiable
    const mailtoMatch = listUnsubscribe.match(/<mailto:([^>]+)>/);
    if (mailtoMatch) {
      const mailtoStr = 'mailto:' + mailtoMatch[1];
      const sent = await _sendMailtoUnsubscribe(token, mailtoStr);
      if (sent) {
        try { if (msg.threadId) await modifyThread(token, msg.threadId, null, true); } catch (_) {}
        await _storeUnsubscribeLog({ from: fromHeader, method: 'mailto-sent', verified: 'sent', url: mailtoStr });
        return { action: "auto-mailto", url: mailtoStr, method: "mailto-sent", verified: true, threadId: msg.threadId };
      }
      // If send failed, fall through to https or return mailto for manual
      await _storeUnsubscribeLog({ from: fromHeader, method: 'mailto-failed', verified: 'pending', url: mailtoStr });
      return { action: "mailto", url: mailtoStr, method: "mailto", verified: false };
    }

    const httpsMatch = listUnsubscribe.match(/<(https?:[^>]+)>/);
    if (httpsMatch) {
      await _storeUnsubscribeLog({ from: fromHeader, method: 'https-manual', verified: 'pending', url: httpsMatch[1] });
      return { action: "manual", url: httpsMatch[1], method: "https-get", verified: false };
    }

    return { action: "not-found", reason: "No List-Unsubscribe header or URL found" };
  } catch (error) {
    const _errMsg = translateGmailError(error && error.status, null, error && error.message);
    throw new Error(_errMsg);
  }
}

// Build a Gmail search query string from a rule's match criteria
function buildRuleQuery(rule) {
  if (!rule || !rule.match) return '';
  var fd = rule.match.fromDomains || [];
  var fi = rule.match.fromIncludes || [];
  var si = rule.match.subjectIncludes || [];

  var fromParts = [];
  // Use "from:domain.com" (no @) — valid Gmail search substring match
  fd.forEach(function(d) { if (d && d.trim()) fromParts.push('from:' + d.trim().toLowerCase()); });
  fi.forEach(function(s) { if (s && s.trim()) fromParts.push('from:' + s.trim()); });

  var parts = [];
  if (fromParts.length === 1) parts.push(fromParts[0]);
  else if (fromParts.length > 1) parts.push('{' + fromParts.join(' ') + '}');

  if (si.length > 0) {
    var subParts = si.filter(Boolean).map(function(s) { return 'subject:"' + s.trim() + '"'; });
    if (subParts.length === 1) parts.push(subParts[0]);
    else if (subParts.length > 1) parts.push('{' + subParts.join(' ') + '}');
  }

  // Attachment condition — maps to Gmail's built-in has:attachment operator
  if (rule.match.hasAttachment === true) parts.push('has:attachment');

  return parts.join(' ');
}

// Apply all saved rules retroactively to ALL mail (not just inbox)
// Labels are added only — INBOX label is never removed — so nothing gets archived
async function applyRulesRetroactive(opts) {
  var maxPerRule = (opts && opts.maxPerRule) || 500;
  var dryRun = !!(opts && opts.dryRun);
  var mutexId = null;
  try {
    mutexId = await acquireRetroMutex('retroactive');
    var settings = await getSettings();
    var rules = (settings.rules || []).filter(function(r) { return r.enabled !== false; });

    // Fallback: read from local overflow directly if getSettings returned nothing
    if (!rules.length) {
      var fallback = await chrome.storage.local.get({ rulesOverflow: [] });
      if (fallback.rulesOverflow && fallback.rulesOverflow.length) {
        tsLog('warn', 'applyRulesRetroactive: getSettings returned 0 rules, using rulesOverflow fallback (' + fallback.rulesOverflow.length + ')');
        rules = normalizeRules(fallback.rulesOverflow).filter(function(r) { return r.enabled !== false; });
      }
    }

    if (!rules.length) return { totalLabeled: 0, totalScanned: 0, labelSummary: [], dryRun: dryRun };

    var token = await getToken();
    labelIdCache.clear();
    var labelsByName = await getLabelsByName(token);

    var totalLabeled = 0;
    var totalScanned = 0;
    var labelSummary = [];

    for (var ri = 0; ri < rules.length; ri++) {
      var rule = rules[ri];
      var query = buildRuleQuery(rule);
      if (!query) continue;

      // Normalize flat label names → hierarchical (same logic as organize runs)
      // This prevents recreating labels that were just deleted via "Clean up labels"
      var retroLabelName = normalizeLabelName(rule.label || 'Updates/General');

      // Resolve or create the Gmail label
      var labelId = labelsByName.get(retroLabelName) || null;
      if (!labelId && !dryRun) {
        try {
          labelId = await createLabel(token, retroLabelName, rule.color || null);
          labelsByName.set(retroLabelName, labelId);
        } catch (_createErr) {
          labelsByName = await getLabelsByName(token);
          await trackQuotaUnit(5);
          labelId = labelsByName.get(retroLabelName) || null;
        }
      }
      if (!labelId && !dryRun) {
        tsLog('warn', 'applyRulesRetroactive: skipping rule "' + rule.name + '" — no label ID');
        continue;
      }

      var pageToken = null;
      var ruleLabeled = 0;
      var ruleScanned = 0;

      tsLog('info', 'applyRulesRetroactive: rule "' + rule.name + '" query:', query);

      do {
        var listUrl = '/threads?q=' + encodeURIComponent(query) + '&maxResults=100';
        if (pageToken) listUrl += '&pageToken=' + encodeURIComponent(pageToken);

        var page;
        try {
          page = await gmailRequest(token, listUrl); // gmailRequest already tracks quota internally
        } catch (listErr) {
          tsLog('warn', 'applyRulesRetroactive: list error for rule "' + rule.name + '" query "' + query + '":', listErr.message);
          break;
        }

        var pageThreads = page.threads || [];
        pageToken = page.nextPageToken || null;

        // Respect maxPerRule cap
        var remaining = maxPerRule - ruleScanned;
        var batch = pageThreads.slice(0, remaining);
        ruleScanned += batch.length;
        totalScanned += batch.length;

        if (!dryRun && labelId && batch.length > 0) {
          // Process threads in parallel chunks of 10 — ~10x faster than sequential + 80ms sleep
          var PARALLEL = 10;
          for (var pi = 0; pi < batch.length; pi += PARALLEL) {
            var chunk = batch.slice(pi, pi + PARALLEL);
            var results = await Promise.allSettled(chunk.map(function(t) {
              return fetch(GMAIL_API_BASE + '/threads/' + t.id + '/modify', {
                method: 'POST',
                headers: buildHeaders(token),
                body: JSON.stringify({ addLabelIds: [labelId], removeLabelIds: [] })
              }).then(function(r) { return r.ok ? 1 : 0; });
            }));
            var chunkLabeled = results.reduce(function(sum, r) {
              return sum + (r.status === 'fulfilled' ? (r.value || 0) : 0);
            }, 0);
            ruleLabeled += chunkLabeled;
            totalLabeled += chunkLabeled;
            await trackQuotaUnit(chunk.length * 5);
            // Small pause between parallel chunks to avoid quota bursts
            if (pi + PARALLEL < batch.length) await sleep(150);
          }
        } else if (dryRun) {
          ruleLabeled += batch.length;
          totalLabeled += batch.length;
        }

        if (ruleScanned >= maxPerRule) break;
      } while (pageToken);

      if (ruleLabeled > 0) {
        labelSummary.push({ label: retroLabelName, count: ruleLabeled });
        tsLog('info', 'applyRulesRetroactive: rule "' + rule.name + '" labeled ' + ruleLabeled + ' → ' + retroLabelName);
      }
    }

    tsLog('info', 'applyRulesRetroactive done — scanned:', totalScanned, 'labeled:', totalLabeled, 'dryRun:', dryRun);
    return { totalLabeled: totalLabeled, totalScanned: totalScanned, labelSummary: labelSummary, dryRun: dryRun };
  } finally {
    if (mutexId) await releaseRetroMutex(mutexId);
  }
}

async function suggestRulesFromInbox(options) {
  const maxDomains = options.maxDomains || 25;
  const minFrequency = options.minFrequency || 1;

  try {
    const token = await getToken();

    // Scan ALL recent mail (not just inbox) so archived emails are also analyzed
    // Use newer_than:6m to get last 6 months of received email
    const queries = [
      "newer_than:6m",           // all recent mail
      "in:inbox",                // current inbox as fallback
      "in:all newer_than:3m",    // everything including sent/spam
    ];

    const senderDomains = {};
    const senderNames = {};
    const senderSubjects = {}; // up to 5 subject samples per domain

    // Try each query until we get some messages
    let messages = [];
    for (const q of queries) {
      try {
        const data = await gmailRequest(token, "/messages?q=" + encodeURIComponent(q) + "&maxResults=300");
        messages = data.messages || [];
        tsLog('info', 'suggestRulesFromInbox: query "' + q + '" returned', messages.length, 'messages');
        if (messages.length > 0) break;
      } catch(_) {}
    }

    tsLog('info', 'suggestRulesFromInbox: scanning', messages.length, 'messages total');

    // Fetch in smaller batches of 10 to avoid rate limits
    const batchSize = 10;
    for (let i = 0; i < Math.min(messages.length, 300); i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      await Promise.all(batch.map(async (msg) => {
        try {
          const m = await gmailRequest(token, "/messages/" + msg.id + "?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject");
          const headers = (m.payload && m.payload.headers) || [];
          const from = getHeader(headers, "From");
          if (!from) return;
          // Case-insensitive: lowercase first
          const fromLow = from.toLowerCase();
          // Extract domain from email address
          const emailMatch = fromLow.match(/@([a-z0-9][a-z0-9\-]*(?:\.[a-z0-9][a-z0-9\-]*)*\.[a-z]{2,})/);
          if (!emailMatch) return;
          const domain = emailMatch[1];
          senderDomains[domain] = (senderDomains[domain] || 0) + 1;
          if (!senderNames[domain]) {
            // Extract display name before the <
            const nameMatch = from.match(/^"?([^"<@\n]+?)"?\s*</);
            senderNames[domain] = nameMatch ? nameMatch[1].trim() : domain;
          }
          // Collect up to 5 subject samples per domain for smarter categorization
          const subject = getHeader(headers, "Subject") || '';
          if (subject) {
            if (!senderSubjects[domain]) senderSubjects[domain] = [];
            if (senderSubjects[domain].length < 5) senderSubjects[domain].push(subject);
          }
        } catch (_) {}
      }));
      await sleep(80);
    }

    tsLog('info', 'suggestRulesFromInbox: found domains', Object.keys(senderDomains).length, Object.keys(senderDomains).slice(0,10));

    const settings = await getSettings();
    const existingDomains = new Set();
    (settings.rules || []).forEach(r => {
      (r.match && r.match.fromDomains || []).forEach(d => existingDomains.add(d.toLowerCase()));
    });

    // Only skip truly personal domains (very tight list) — let AI handle the rest
    const skipDomains = new Set(['gmail.com', 'googlemail.com']);

    const candidates = Object.keys(senderDomains)
      .filter(d => senderDomains[d] >= minFrequency && !existingDomains.has(d) && !skipDomains.has(d))
      .sort((a, b) => senderDomains[b] - senderDomains[a])
      .slice(0, maxDomains)
      .map(domain => {
        const baseName = domain.split('.')[0];
        const labelName = baseName.charAt(0).toUpperCase() + baseName.slice(1);
        return {
          name: senderNames[domain] || labelName,
          label: "Inbox/" + labelName,
          action: "label",
          match: { fromDomains: [domain], fromIncludes: [], subjectIncludes: [] },
          suggested: true,
          reason: senderDomains[domain] + " email" + (senderDomains[domain] > 1 ? "s" : "") + " found",
          sampleSubjects: senderSubjects[domain] || []
        };
      });

    tsLog('info', 'suggestRulesFromInbox: candidates after filter', candidates.length);

    // If Gemini key is set, enhance labels with AI
    if (candidates.length > 0 && String(settings.geminiApiKey || "").trim()) {
      try {
        const geminiSuggestions = await suggestLabelsWithGemini(candidates);
        candidates.forEach((c, i) => {
          if (geminiSuggestions[i]) {
            c.label = geminiSuggestions[i].label || c.label;
            c.name = geminiSuggestions[i].name || c.name;
          }
        });
      } catch (_) {}
    }

    return { suggestions: candidates };
  } catch (error) {
    const _errMsg = translateGmailError(error && error.status, null, error && error.message);
    throw new Error(_errMsg);
  }
}

async function suggestLabelsWithGemini(candidates) {
  const settings = await getSettings();
  if (!String(settings.geminiApiKey || "").trim()) return [];

  const candidateTexts = candidates.map((c, i) => (i + 1) + ". " + c.reason + " (" + c.name + ")").join("\n");
  const prompt = "Given these email sender domains, suggest practical Gmail label names in the format 'label/subcategory':\n" + candidateTexts + "\nReturn a JSON array with { label, name } for each, in the same order. Be concise.";

  try {
    await throttleGeminiCall();
    const response = await fetchWithRetry("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(settings.geminiModel || DEFAULT_GEMINI_MODEL) + ":generateContent", {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": settings.geminiApiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 500, responseMimeType: "application/json" }
      })
    });

    if (response.ok) {
      const data = await response.json();
      const text = extractGeminiText(data);
      try {
        return JSON.parse(text);
      } catch (_) {}
    }
  } catch (_) {}

  return [];
}

async function parseNaturalLanguageRule(text) {
  if (!text || !String(text).trim()) throw new Error("Please provide a rule description.");

  const settings = await getSettings();
  let rule = null, usedAI = false;

  if (String(settings.geminiApiKey || "").trim()) {
    try {
      rule = await parseRuleWithGemini(text, settings.geminiModel || DEFAULT_GEMINI_MODEL, settings.geminiApiKey);
      usedAI = true;
    } catch (e) {
      console.warn("Gemini parsing failed, falling back to regex:", e.message);
    }
  }

  if (!rule) {
    rule = parseRuleWithRegex(text);
  }

  if (!rule || !rule.match) throw new Error("Could not parse rule. Try: 'label emails from amazon.com as Shopping'");

  rule = normalizeRule(rule);
  return { rule: rule, confidence: usedAI ? 0.85 : 0.6, usedAI: usedAI };
}

async function parseRuleWithGemini(text, model, apiKey) {
  const prompt = "Convert this natural-language rule into JSON matching this schema:\n{\"name\":\"string\",\"label\":\"string\",\"action\":\"label|archive|trash\",\"color\":null,\"match\":{\"fromDomains\":[],\"fromIncludes\":[],\"subjectIncludes\":[]}}\nUser: " + text + "\nReturn only the JSON object, no explanations.";

  await throttleGeminiCall();
  const response = await fetchWithRetry("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 400, responseMimeType: "application/json" }
    })
  });

  if (!response.ok) throw new Error("Gemini parsing failed");

  const data = await response.json();
  const text_content = extractGeminiText(data);
  try {
    const cleaned = text_content.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    return JSON.parse(cleaned);
  } catch (_) {
    throw new Error("Invalid JSON from Gemini");
  }
}

function parseRuleWithRegex(text) {
  const lower = text.toLowerCase();
  const rule = { name: "Auto Rule", label: "Organized/Auto", action: "label", match: { fromDomains: [], fromIncludes: [], subjectIncludes: [] } };

  const fromMatch = text.match(/from\s+([a-z0-9.\-@]+(?:\.[a-z]{2,})?)/i);
  if (fromMatch) {
    const domain = fromMatch[1];
    if (domain.includes("@")) rule.match.fromIncludes.push(domain);
    else rule.match.fromDomains.push(domain);
    rule.name = "From " + domain;
  }

  const subjectMatch = text.match(/subject\s+(?:contains|has)\s+["\']?([^"\']+)["\']?/i);
  if (subjectMatch) rule.match.subjectIncludes.push(subjectMatch[1]);

  const labelMatch = text.match(/(?:label|tag)\s+(?:as\s+)?["\']?([^"\']+)["\']?/i);
  if (labelMatch) rule.label = labelMatch[1];

  const actionMatch = text.match(/(archive|trash|delete)/i);
  if (actionMatch) rule.action = actionMatch[1].toLowerCase() === "delete" ? "trash" : actionMatch[1].toLowerCase();

  return rule;
}

async function addRuleFromTemplate(templateId) {
  const template = RULE_TEMPLATE_LIBRARY.find(t => t.id === templateId);
  if (!template) throw new Error("Template not found: " + templateId);

  const settings = await getSettings();
  const newRule = Object.assign({}, template.rule, { id: crypto.randomUUID(), suggested: false });
  const updatedRules = [...(settings.rules || []), newRule];
  await saveSettings(Object.assign({}, settings, { rules: updatedRules }));
}

async function getRulePerformance(ruleId) {
  if (!ruleId) throw new Error("Rule ID required.");

  const history = await getHistory();
  let totalMatches = 0, last30Days = 0, lastMatchTimestamp = null, runCount = 0;
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;

  history.forEach(entry => {
    (entry.actions || []).forEach(action => {
      if (action.label && action.label.includes(ruleId)) {
        totalMatches++;
        if (!lastMatchTimestamp) lastMatchTimestamp = entry.timestamp;
        if (now - new Date(entry.timestamp).getTime() < thirtyDays) last30Days++;
      }
    });
  });

  const successRuns = history.filter(e => e.status === "success" && (e.source === "manual" || e.source === "auto")).length;

  return {
    ruleId: ruleId,
    totalMatches: totalMatches,
    last30Days: last30Days,
    lastMatchTimestamp: lastMatchTimestamp,
    avgMatchesPerRun: successRuns > 0 ? totalMatches / successRuns : 0
  };
}

function detectRuleConflicts(rules) {
  var conflicts = [];
  for (var i = 0; i < rules.length; i++) {
    for (var j = i + 1; j < rules.length; j++) {
      var a = rules[i], b = rules[j];
      if (areEquivalentRules(a, b)) {
        conflicts.push({
          type: "duplicate",
          ruleA: { id: a.id, name: a.name },
          ruleB: { id: b.id, name: b.name },
          sharedDomains: normalizeList(a.match && a.match.fromDomains),
          sharedSenders: normalizeList(a.match && a.match.fromIncludes),
          sharedSubjects: normalizeList(a.match && a.match.subjectIncludes)
        });
        continue;
      }
      var labelA = String(a.label || "").toLowerCase();
      var labelB = String(b.label || "").toLowerCase();
      var parentA = labelA.indexOf("/") !== -1 ? labelA.slice(0, labelA.indexOf("/")) : labelA;
      var parentB = labelB.indexOf("/") !== -1 ? labelB.slice(0, labelB.indexOf("/")) : labelB;
      if (parentA && parentB && parentA === parentB) continue;
      if (String(a.action || "") !== String(b.action || "")) continue;
      var sd = a.match.fromDomains.filter(function(d) { return b.match.fromDomains.indexOf(d) !== -1; });
      var ss = a.match.fromIncludes.filter(function(s) { return b.match.fromIncludes.indexOf(s) !== -1; });
      var sk = a.match.subjectIncludes.filter(function(s) { return b.match.subjectIncludes.indexOf(s) !== -1; });
      var totalShared = sd.length + ss.length + sk.length;
      var smallerRuleSize = Math.min(
        a.match.fromDomains.length + a.match.fromIncludes.length + a.match.subjectIncludes.length,
        b.match.fromDomains.length + b.match.fromIncludes.length + b.match.subjectIncludes.length
      );
      var overlapRatio = smallerRuleSize > 0 ? totalShared / smallerRuleSize : 0;
      if (sd.length >= 2 || overlapRatio >= 0.3) {
        conflicts.push({ type: "overlap", ruleA: { id: a.id, name: a.name }, ruleB: { id: b.id, name: b.name }, sharedDomains: sd, sharedSenders: ss, sharedSubjects: sk });
      }
    }
  }
  return conflicts;
}

function areEquivalentRules(a, b) {
  if (!a || !b) return false;
  return String(a.name || "").trim().toLowerCase() === String(b.name || "").trim().toLowerCase() &&
    String(a.label || "").trim().toLowerCase() === String(b.label || "").trim().toLowerCase() &&
    String(a.action || "") === String(b.action || "") &&
    normalizeList(a.match && a.match.fromDomains).join("|") === normalizeList(b.match && b.match.fromDomains).join("|") &&
    normalizeList(a.match && a.match.fromIncludes).join("|") === normalizeList(b.match && b.match.fromIncludes).join("|") &&
    normalizeList(a.match && a.match.subjectIncludes).join("|") === normalizeList(b.match && b.match.subjectIncludes).join("|");
}

async function gmailRequest(token, path) {
  // Quota tracking: list/search = 5 units, get = 1 unit
  const quotaEnabled = await getFeatureFlag('ff_quotaTracking', true);
  if (quotaEnabled) {
    // Detect operation type from path
    if (path.includes('?q=') || path.includes('threads?')) {
      await trackQuotaUnit(5);  // list/search
    } else if (path.includes('/threads/') || path.includes('/messages/')) {
      if (path.endsWith('/modify') || path.endsWith('/trash') || path.endsWith('/untrash')) {
        // Modify operations handled separately
      } else {
        await trackQuotaUnit(1);  // get
      }
    }
  }

  var r = await fetchWithRetry(GMAIL_API_BASE + path, { headers: buildHeaders(token) });
  if (!r.ok) {
    var d = null;
    try { d = await r.json(); } catch (_) {}
    throw new Error((d && d.error && d.error.message) || "Gmail API error (" + r.status + ")");
  }
  return r.json();
}

async function getToken() {
  return Promise.race([
    new Promise(function(resolve, reject) {
      chrome.identity.getAuthToken({ interactive: true }, function(token) {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (!token) { reject(new Error("No auth token returned.")); return; }
        resolve(token);
      });
    }),
    new Promise(function(_, reject) {
      setTimeout(function() {
        reject(new Error("Auth token request timed out."));
      }, 30000);
    })
  ]);
}

async function revokeToken() {
  var token = await new Promise(function(r) { chrome.identity.getAuthToken({ interactive: false }, function(v) { r(v || null); }); });
  if (token) {
    // 1. Remove from Chrome's local cache
    await new Promise(function(r) { chrome.identity.removeCachedAuthToken({ token: token }, r); });
    // 2. Revoke the token at Google's endpoint so Chrome forgets the account binding
    //    Without this step, getAuthToken({ interactive: true }) silently reuses the same account
    try {
      await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token), { method: 'POST' });
    } catch (e) {
      tsLog('warn', 'revokeToken: revocation endpoint failed (token may already be expired)', e.message);
    }
  }
  // 3. Clear ALL cached tokens — ensures no stale grant survives
  await new Promise(function(r) { chrome.identity.clearAllCachedAuthTokens(r); });
  // 4. Reset in-memory caches
  _cachedEmail = null;
  _accessCache = null;
  // 5. Clear dev plan override so switching accounts doesn't inherit a stale plan
  await chrome.storage.local.remove('devPlanOverride');
}

// ── Backend credit / access helpers ──────────────────────────────────────────

// In-memory caches (live for the service worker's lifetime, ~30s idle)
let _cachedEmail = null;
let _accessCache = null; // { email, expiresAt }

async function getUserEmail() {
  if (_cachedEmail) return _cachedEmail;
  try {
    const token = await getToken();
    const res = await fetch(GMAIL_API_BASE + "/profile", {
      headers: { Authorization: "Bearer " + token }
    });
    const data = await res.json();
    _cachedEmail = data.emailAddress || null;
    return _cachedEmail;
  } catch (e) {
    return null;
  }
}

async function checkAccessOrThrow() {
  const email = await getUserEmail();
  if (!email) throw new Error("Could not determine your email. Please sign in again.");

  // 🛠️ Developer plan override — bypasses backend for local testing
  // Set via: chrome.storage.local.set({ devPlanOverride: { plan:'free', creditsLeft:0, allowed:false } })
  const { devPlanOverride } = await chrome.storage.local.get('devPlanOverride');
  if (devPlanOverride) {
    if (!devPlanOverride.allowed) {
      _accessCache = null;
      const err = new Error("UPGRADE_REQUIRED");
      err.upgradeEmail = email;
      err.creditsTotal = devPlanOverride.creditsTotal;
      err.plan = devPlanOverride.plan;
      throw err;
    }
    _accessCache = { email, expiresAt: Date.now() + 60_000 };
    return email;
  }

  // Use cached result if still fresh (60s TTL)
  const now = Date.now();
  if (_accessCache && _accessCache.email === email && _accessCache.expiresAt > now) {
    return email;
  }

  // Get OAuth token to prove request authenticity — backend can verify against Google
  let token = null;
  try {
    token = await new Promise((resolve) => {
      chrome.identity.getAuthToken({ interactive: false }, (t) => resolve(t || null));
    });
  } catch (_) {}

  let res, data;
  try {
    res = await fetch(API_BASE + "/checkAccess?email=" + encodeURIComponent(email), {
      method: "GET",
      headers: {
        ...(token ? { "X-Auth-Token": token } : {})
      }
    });
  } catch (fetchErr) {
    // Backend unreachable — fail open so Gmail organizing still works
    tsLog('warn', 'checkAccess: backend unreachable, proceeding anyway:', fetchErr.message);
    _accessCache = { email, expiresAt: now + 60_000 };
    return email;
  }
  try {
    data = await res.json();
  } catch (parseErr) {
    // Invalid response — fail open
    tsLog('warn', 'checkAccess: invalid backend response, proceeding anyway');
    _accessCache = { email, expiresAt: now + 60_000 };
    return email;
  }
  if (!data.allowed) {
    _accessCache = null; // don't cache a denied response
    const err = new Error("UPGRADE_REQUIRED");
    err.upgradeEmail = email;
    err.creditsTotal = data.creditsTotal;
    err.plan = data.plan;
    throw err;
  }

  _accessCache = { email, expiresAt: now + 60_000 };
  return email;
}

// Returns plan info without throwing — used for feature gating
async function getPlanStatus() {
  const { devPlanOverride } = await chrome.storage.local.get('devPlanOverride');
  if (devPlanOverride) return devPlanOverride;
  const email = await getUserEmail().catch(() => null);
  if (!email) return { plan: 'free', creditsLeft: 20, creditsTotal: 20, allowed: true };
  try { return await getBackendUserStatus(email); } catch (_) {
    return { plan: 'free', creditsLeft: null, creditsTotal: null, allowed: true };
  }
}

function isPaidPlan(plan) {
  return plan === 'pro_monthly' || plan === 'pro_yearly' || plan === 'basic';
}

async function consumeCredit(email) {
  // 🛠️ Developer override — decrement local credits instead of calling backend
  const { devPlanOverride } = await chrome.storage.local.get('devPlanOverride');
  if (devPlanOverride) {
    if (typeof devPlanOverride.creditsLeft === 'number' && devPlanOverride.creditsLeft > 0 && devPlanOverride.creditsLeft < 999999) {
      devPlanOverride.creditsLeft -= 1;
      devPlanOverride.creditsUsed = (devPlanOverride.creditsUsed || 0) + 1;
      if (devPlanOverride.creditsLeft <= 0) devPlanOverride.allowed = false;
      await chrome.storage.local.set({ devPlanOverride });
    }
    _accessCache = null;
    return;
  }

  // Get OAuth token to authenticate the credit consumption request
  let token = null;
  try {
    token = await new Promise((resolve) => {
      chrome.identity.getAuthToken({ interactive: false }, (t) => resolve(t || null));
    });
  } catch (_) {}

  // Fire-and-forget — don't block the UI waiting for this
  fetch(API_BASE + "/consumeCredit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Auth-Token": token } : {})
    },
    body: JSON.stringify({ email })
  }).then(() => {
    // Invalidate access cache after consuming so next action re-checks credits
    _accessCache = null;
  }).catch(e => {
    console.warn('[gmail-organizer] Could not consume credit:', e.message);
  });
}

async function getBackendUserStatus(email) {
  // Get OAuth token for authenticated request
  let token = null;
  try {
    token = await new Promise((resolve) => {
      chrome.identity.getAuthToken({ interactive: false }, (t) => resolve(t || null));
    });
  } catch (_) {}

  let res;
  try {
    res = await fetch(API_BASE + "/getUserStatus?email=" + encodeURIComponent(email), {
      method: "GET",
      headers: {
        ...(token ? { "X-Auth-Token": token } : {})
      }
    });
  } catch (fetchErr) {
    console.error('[gmail-organizer] getUserStatus fetch failed:', fetchErr.message);
    return { plan: "free", creditsLeft: 0, creditsTotal: 20, creditsUsed: 0, error: fetchErr.message };
  }
  if (!res.ok) {
    console.error('[gmail-organizer] getUserStatus returned status:', res.status);
    return { plan: "free", creditsLeft: 0, creditsTotal: 20, creditsUsed: 0, error: 'status_' + res.status };
  }
  try {
    return await res.json();
  } catch (parseErr) {
    console.error('[gmail-organizer] getUserStatus parse failed:', parseErr.message);
    return { plan: "free", creditsLeft: 0, creditsTotal: 20, creditsUsed: 0, error: 'parse_error' };
  }
}

// ── Categorization preferences ───────────────────────────────────────────────
// Mirror of CAT_DEFINITIONS from options.js — match criteria only.
const CAT_MATCH_PATTERNS = {
  'to-respond': {
    fromIncludes: [],
    subjectIncludes: [
      // Explicit ask phrases
      'action required','response needed','please respond','reply needed',
      'your input needed','kindly respond','requires your attention',
      // Common real-world request phrases
      'quick question','can you','could you','would you mind','please review',
      'please check','please confirm','please approve','please advise',
      'for your review','for your approval','your feedback','your thoughts',
      'your opinion','your input','what do you think','let me know',
      'following up','just checking in','any update','have you had a chance',
      'waiting for your','pending your','need your','i need your',
      // Interview / meeting / collaboration
      'invitation to','you are invited','interview','meeting request',
      'proposal for you','offer for you','job offer','collaboration'
    ]
  },
  'fyi':          { fromIncludes: [], subjectIncludes: ['fyi','for your information','heads up','just so you know','no action needed','no reply needed'] },
  'comment':      { fromDomains: ['docs.google.com','figma.com','notion.so','coda.io'], fromIncludes: ['comments-noreply@docs.google.com','noreply@figma.com','noreply@notion.so'], subjectIncludes: ['commented on','left a comment','mentioned you in','new comment on'] },
  'notification': { fromDomains: ['github.com','gitlab.com','trello.com','asana.com','linear.app','clickup.com','monday.com'], fromIncludes: ['noreply@github.com','notifications@gitlab.com'], subjectIncludes: ['pull request','build failed','build passed','pipeline','deployment','task assigned'] },
  'meeting-update': { fromDomains: ['zoom.us','calendly.com','doodle.com'], fromIncludes: ['calendar-notification@google.com','noreply@zoom.us','noreply@calendly.com'], subjectIncludes: ['invitation','meeting invite','join zoom','calendar invite','event update','event cancelled'] },
  'to-follow-up': { fromIncludes: [], subjectIncludes: ['follow up','following up','checking in','gentle reminder','any update'] },
  'marketing':    { fromIncludes: ['marketing@','sales@','newsletter@','promo@'], subjectIncludes: ['% off','discount','sale','limited time','exclusive offer','flash sale','last chance','promo code'] },
  'social':       { fromDomains: ['facebook.com','twitter.com','linkedin.com','instagram.com','tiktok.com'], fromIncludes: ['noreply@linkedin.com','notification@twitter.com','noreply@facebook.com'], subjectIncludes: ['connected with you','sent you a message','mentioned you','liked your','commented on your','new follower','friend request'] },
  'reading-later': {
    fromDomains: ['substack.com','beehiiv.com','ghost.io','medium.com','mailchimp.com','convertkit.com','buttondown.email','revue.co','tinyletter.com'],
    fromIncludes: ['digest@','weekly@','daily@','newsletter@','letter@','roundup@','edition@'],
    subjectIncludes: [
      'weekly digest','daily digest','weekly roundup','newsletter','this week in',
      'new post','new article','new issue','issue #','vol.','volume ',
      'you might like','curated for you','reading list','top stories',
      'in case you missed','things to read','worth reading','links for'
    ]
  },
};

const CAT_LABELS = {
  'to-respond':     'To Respond',
  'fyi':            'Notifications',
  'comment':        'Work Projects',
  'notification':   'Notifications',
  'meeting-update': 'Follow Up',
  'to-follow-up':   'Follow Up',
  'marketing':      'Marketing',
  'social':         'Social Emails',
  'reading-later':  'Read Later',
};

// Default state for all categories — mirrors options.js defaults so a fresh install
// starts with everything enabled without needing an explicit save from the options page.
const CAT_DEFAULT_IDS = ['to-respond','fyi','comment','notification','meeting-update','to-follow-up','marketing','social','reading-later'];
// Bump this number whenever default states change — triggers a one-time migration for existing users.
const CAT_PREFS_VERSION = 2;

async function getCatPrefs() {
  const stored = await chrome.storage.sync.get({ categorizationPrefs: null, catRespectExisting: true, catPrefsVersion: 0 });
  var prefs = stored.categorizationPrefs || {};

  if ((stored.catPrefsVersion || 0) < CAT_PREFS_VERSION) {
    // Migration: old default was 'off' for everything. Upgrade any 'off' or missing
    // category to 'move-out' so categories are enabled out of the box.
    CAT_DEFAULT_IDS.forEach(function(id) {
      if (!(id in prefs) || prefs[id] === 'off') prefs[id] = 'move-out';
    });
    // Persist migration so it only runs once per version bump.
    chrome.storage.sync.set({ categorizationPrefs: prefs, catPrefsVersion: CAT_PREFS_VERSION });
  } else {
    // Normal path: fill in any newly added categories with the default.
    CAT_DEFAULT_IDS.forEach(function(id) { if (!(id in prefs)) prefs[id] = 'move-out'; });
  }

  return {
    prefs: prefs,
    respectExisting: stored.catRespectExisting !== false,
  };
}

// Maps category IDs to Gmail's native CATEGORY_* system labels for accurate matching.
// Gmail automatically assigns these labels — checking them is far more reliable than keyword guessing.
const GMAIL_CATEGORY_MAP = {
  'marketing':      'CATEGORY_PROMOTIONS',
  'social':         'CATEGORY_SOCIAL',
  'notification':   'CATEGORY_UPDATES',
  'comment':        'CATEGORY_FORUMS',
  'meeting-update': 'CATEGORY_UPDATES',
};

// Returns true if the from address looks like an automated/noreply sender
function isAutomatedSender(from) {
  var f = (from || '').toLowerCase();
  return /noreply|no-reply|donotreply|do-not-reply|notifications?@|alerts?@|mailer@|automated@|newsletter@|updates?@|support@|hello@|team@|info@|news@|digest@|weekly@|daily@/.test(f);
}

function threadMatchesCat(from, subject, catId, labelIds) {
  // 1. Gmail native category label — most accurate, check first
  var nativeLabel = GMAIL_CATEGORY_MAP[catId];
  if (nativeLabel && labelIds && labelIds.indexOf(nativeLabel) !== -1) return true;

  // 2. Smart heuristic for "to-respond": subject contains a ? AND sender is a real person
  if (catId === 'to-respond') {
    var subLowQ = (subject || '').toLowerCase();
    if (subLowQ.includes('?') && !isAutomatedSender(from)) return true;
  }

  // 3. Keyword/domain fallback for categories without a native Gmail label
  var pat = CAT_MATCH_PATTERNS[catId];
  if (!pat) return false;
  var fromLow = (from || '').toLowerCase();
  var subLow = (subject || '').toLowerCase();
  if (pat.fromDomains && pat.fromDomains.some(function(d) { return fromLow.includes(d.toLowerCase()); })) return true;
  if (pat.fromIncludes && pat.fromIncludes.some(function(k) { return k && fromLow.includes(k.toLowerCase()); })) return true;
  if (pat.subjectIncludes && pat.subjectIncludes.some(function(k) { return k && subLow.includes(k.toLowerCase()); })) return true;
  return false;
}

function isSystemLabel(labelId) {
  var systemPrefixes = ['INBOX','SENT','DRAFTS','SPAM','TRASH','STARRED','IMPORTANT','UNREAD','CATEGORY_','Label_'];
  // Gmail user-created labels start with "Label_" (numeric IDs)
  // So anything NOT starting with a system prefix = user label
  return systemPrefixes.some(function(p) { return labelId.startsWith(p); }) || /^[A-Z_]+$/.test(labelId);
}

// ── Bulk Delete helpers ───────────────────────────────────────────────────────

function buildBulkDeleteQuery(raw) {
  var q = (raw || "").trim();
  if (!q) throw new Error("Please enter a sender or keyword.");
  // If it looks like an email address or domain, use from: prefix
  if (/^[\w.+%-]+@[\w.-]+$/.test(q)) return "from:" + q;
  if (/^[\w.-]+\.[a-z]{2,}$/.test(q)) return "from:@" + q;
  // Otherwise treat as a free-text Gmail search (subject, body, etc.)
  return q;
}

async function countAllThreads(token, q) {
  // Use Gmail's resultSizeEstimate for a fast count without paging
  var r = await gmailRequest(token, "/threads?q=" + encodeURIComponent(q) + "&maxResults=1");
  return r.resultSizeEstimate || 0;
}

async function bulkDeleteAllThreads(token, q) {
  var deleted = 0, failed = 0, pageToken = null;
  do {
    var url = "/threads?q=" + encodeURIComponent(q) + "&maxResults=100" + (pageToken ? "&pageToken=" + pageToken : "");
    var page = await gmailRequest(token, url);
    var threads = page.threads || [];
    pageToken = page.nextPageToken || null;

    // Delete in parallel batches of 10
    for (var i = 0; i < threads.length; i += 10) {
      var batch = threads.slice(i, i + 10);
      await Promise.all(batch.map(async function(t) {
        try {
          await permanentlyDeleteThread(token, t.id);
          deleted++;
        } catch (_) {
          // Fall back to trash if permanent delete fails
          try { await trashThread(token, t.id); deleted++; } catch (__) { failed++; }
        }
      }));
      // Progress update to popup
      chrome.runtime.sendMessage({ type: "bulkDeleteProgress", deleted, failed }).catch(function() {});
      if (i + 10 < threads.length) await sleep(100);
    }
  } while (pageToken);

  return { deleted, failed };
}

async function createStripeCheckout(email, plan) {
  const res = await fetch(API_BASE + "/createCheckout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, plan })
  });
  return res.json();
}

async function getNotificationTargets() {
  var stored = await chrome.storage.local.get({ [NOTIFICATION_TARGETS_KEY]: {} });
  return stored[NOTIFICATION_TARGETS_KEY] || {};
}

async function rememberNotificationTarget(notificationId, target) {
  var targets = await getNotificationTargets();
  targets[notificationId] = target;
  await chrome.storage.local.set({ [NOTIFICATION_TARGETS_KEY]: targets });
}

// ============================================================================
// SNOOZE FEATURE (v0.9.0)
// ============================================================================

/**
 * Initialize the snoozed threads tracking if not present
 */
async function initializeSnoozedThreads() {
  const stored = await chrome.storage.local.get({ snoozedThreads: null });
  if (stored.snoozedThreads === null) {
    await chrome.storage.local.set({ snoozedThreads: [] });
  }
}

/**
 * Snooze a thread until a specified time
 * @param {string} threadId - Gmail thread ID
 * @param {number} wakeAt - Unix timestamp (ms) when to wake the thread
 * @returns {Promise<{threadId, wakeAt, label}>}
 */
async function snoozeThread(threadId, wakeAt) {
  const enabled = await getFeatureFlag('ff_snooze', true);
  if (!enabled) throw new Error("Snooze feature is disabled.");

  const now = Date.now();
  const minWake = now + 5 * 60 * 1000; // 5 minutes minimum
  const maxWake = now + 365 * 24 * 60 * 60 * 1000; // 1 year max

  if (wakeAt < minWake) {
    throw new Error("Snooze time must be at least 5 minutes in the future.");
  }
  if (wakeAt > maxWake) {
    throw new Error("Snooze time cannot exceed 1 year.");
  }

  const token = await getToken();

  // Fetch thread to get metadata
  let thread = null;
  try {
    thread = await gmailRequest(token, "/threads/" + encodeURIComponent(threadId) + "?format=minimal");
  } catch (err) {
    throw new Error("Could not fetch thread: " + (err.message || String(err)));
  }

  if (!thread) throw new Error("Thread not found.");

  // Get the subject and from address from the first message
  const firstMsg = (thread.messages && thread.messages[0]) || {};
  const headers = firstMsg.payload && firstMsg.payload.headers ? firstMsg.payload.headers : [];
  const subject = headers.find(h => h.name === 'Subject') ? headers.find(h => h.name === 'Subject').value : "(no subject)";
  const from = headers.find(h => h.name === 'From') ? headers.find(h => h.name === 'From').value : "(unknown sender)";
  // thread.labels doesn't exist — label IDs live on the first message
  const labelIds = firstMsg.labelIds || [];

  // Create the GmailOrganizer/Snoozed label if needed
  const snoozeLabel = await getOrCreateLabel(token, "GmailOrganizer/Snoozed", null);

  // Remove INBOX, add Snoozed label
  const removeIds = labelIds.includes("INBOX") ? ["INBOX"] : [];
  const addIds = [snoozeLabel];

  try {
    const modifyUrl = "/threads/" + encodeURIComponent(threadId) + "/modify";
    const r = await fetch(GMAIL_API_BASE + modifyUrl, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify({ addLabelIds: addIds, removeLabelIds: removeIds })
    });
    await trackQuotaUnit(5);
    if (!r.ok) throw new Error("Failed to modify thread labels.");
  } catch (err) {
    throw new Error("Failed to apply snooze label: " + (err.message || String(err)));
  }

  // Store the snooze record
  const snoozeRecord = {
    threadId: threadId,
    snoozedAt: Date.now(),
    wakeAt: wakeAt,
    originalLabels: labelIds.filter(id => id !== "INBOX"), // preserve non-INBOX labels
    subject: subject,
    from: from
  };

  await initializeSnoozedThreads();
  const stored = await chrome.storage.local.get({ snoozedThreads: [] });
  const threads = Array.isArray(stored.snoozedThreads) ? stored.snoozedThreads : [];
  threads.push(snoozeRecord);
  await chrome.storage.local.set({ snoozedThreads: threads });

  // Schedule the alarm
  const delayMs = wakeAt - Date.now();
  const delayMinutes = Math.ceil(delayMs / 60000);
  try {
    chrome.alarms.create("snooze-wake-" + threadId, { delayInMinutes: Math.max(1, delayMinutes) });
  } catch (err) {
    console.warn("[gmail-organizer] Failed to schedule snooze alarm:", err.message);
  }

  return { threadId: threadId, wakeAt: wakeAt, label: snoozeLabel };
}

/**
 * List all snoozed threads with time remaining
 * @returns {Promise<Array>} Array of snoozed thread records with timeRemaining
 */
async function listSnoozedThreads() {
  await initializeSnoozedThreads();
  const stored = await chrome.storage.local.get({ snoozedThreads: [] });
  let threads = Array.isArray(stored.snoozedThreads) ? stored.snoozedThreads : [];

  const now = Date.now();
  const token = await getToken().catch(() => null);

  // Prune threads that no longer exist (best effort)
  let pruned = [];
  for (const t of threads) {
    if (!token) {
      pruned.push(t);
      continue;
    }
    try {
      await gmailRequest(token, "/threads/" + encodeURIComponent(t.threadId) + "?format=minimal");
      pruned.push(t);
    } catch (err) {
      if (err.message && err.message.includes("404")) {
        // Thread deleted, skip it
        console.log("[gmail-organizer] Pruning deleted snoozed thread:", t.threadId);
      } else {
        // Temp error, keep it
        pruned.push(t);
      }
    }
  }

  if (pruned.length < threads.length) {
    await chrome.storage.local.set({ snoozedThreads: pruned });
  }

  // Add timeRemaining and sort by wakeAt
  const enriched = pruned.map(t => ({
    ...t,
    timeRemaining: Math.max(0, t.wakeAt - now)
  })).sort((a, b) => a.wakeAt - b.wakeAt);

  return enriched;
}

/**
 * Wake a snoozed thread (restore to inbox)
 * @param {string} threadId - Gmail thread ID
 * @returns {Promise<{success, threadId}>}
 */
async function wakeSnoozedThread(threadId) {
  const token = await getToken();

  await initializeSnoozedThreads();
  const stored = await chrome.storage.local.get({ snoozedThreads: [] });
  let threads = Array.isArray(stored.snoozedThreads) ? stored.snoozedThreads : [];

  const snoozeRecord = threads.find(t => t.threadId === threadId);
  if (!snoozeRecord) {
    return { success: false, threadId: threadId, error: "Thread not found in snooze list." };
  }

  // Get the snooze label ID
  const snoozeLabel = await getOrCreateLabel(token, "GmailOrganizer/Snoozed", null);

  // Add INBOX back, remove Snoozed
  try {
    const modifyUrl = "/threads/" + encodeURIComponent(threadId) + "/modify";
    const r = await fetch(GMAIL_API_BASE + modifyUrl, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify({
        addLabelIds: ["INBOX"],
        removeLabelIds: [snoozeLabel]
      })
    });
    await trackQuotaUnit(5);
    if (!r.ok) throw new Error("Failed to modify thread.");
  } catch (err) {
    return { success: false, threadId: threadId, error: "Failed to restore thread: " + (err.message || String(err)) };
  }

  // Remove from snoozed list
  threads = threads.filter(t => t.threadId !== threadId);
  await chrome.storage.local.set({ snoozedThreads: threads });

  // Cancel the alarm
  try {
    chrome.alarms.clear("snooze-wake-" + threadId);
  } catch (_) {}

  // Append history
  await appendHistoryEntry({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    source: "snooze-wake",
    status: "completed",
    summary: "Snoozed thread woken: " + (snoozeRecord.subject || threadId),
    scannedThreads: 1,
    matchedThreads: 1,
    actions: [{ threadId: threadId, action: "label", label: "INBOX", removed: ["GmailOrganizer/Snoozed"] }]
  });

  return { success: true, threadId: threadId };
}

/**
 * Cancel a snooze (manually un-snooze before wake time)
 * @param {string} threadId - Gmail thread ID
 * @returns {Promise<{success, threadId}>}
 */
async function cancelSnooze(threadId) {
  const token = await getToken();

  await initializeSnoozedThreads();
  const stored = await chrome.storage.local.get({ snoozedThreads: [] });
  let threads = Array.isArray(stored.snoozedThreads) ? stored.snoozedThreads : [];

  const snoozeRecord = threads.find(t => t.threadId === threadId);
  if (!snoozeRecord) {
    return { success: false, threadId: threadId, error: "Thread not found in snooze list." };
  }

  // Get the snooze label ID
  const snoozeLabel = await getOrCreateLabel(token, "GmailOrganizer/Snoozed", null);

  // Add INBOX back, remove Snoozed
  try {
    const modifyUrl = "/threads/" + encodeURIComponent(threadId) + "/modify";
    const r = await fetch(GMAIL_API_BASE + modifyUrl, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify({
        addLabelIds: ["INBOX"],
        removeLabelIds: [snoozeLabel]
      })
    });
    await trackQuotaUnit(5);
    if (!r.ok) throw new Error("Failed to modify thread.");
  } catch (err) {
    return { success: false, threadId: threadId, error: "Failed to cancel snooze: " + (err.message || String(err)) };
  }

  // Remove from snoozed list
  threads = threads.filter(t => t.threadId !== threadId);
  await chrome.storage.local.set({ snoozedThreads: threads });

  // Cancel the alarm
  try {
    chrome.alarms.clear("snooze-wake-" + threadId);
  } catch (_) {}

  // Append history
  await appendHistoryEntry({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    source: "snooze-cancel",
    status: "completed",
    summary: "Snooze cancelled: " + (snoozeRecord.subject || threadId),
    scannedThreads: 1,
    matchedThreads: 1,
    actions: [{ threadId: threadId, action: "label", label: "INBOX", removed: ["GmailOrganizer/Snoozed"] }]
  });

  return { success: true, threadId: threadId };
}

/**
 * Re-register alarms for snoozed threads on startup (in case alarms were lost)
 */
async function restoreSnoozeAlarms() {
  const enabled = await getFeatureFlag('ff_snooze', true);
  if (!enabled) return;

  await initializeSnoozedThreads();
  const stored = await chrome.storage.local.get({ snoozedThreads: [] });
  const threads = Array.isArray(stored.snoozedThreads) ? stored.snoozedThreads : [];

  // Check which alarms already exist
  const existingAlarms = await chrome.alarms.getAll();
  const existingNames = new Set(existingAlarms.map(a => a.name));

  const now = Date.now();
  for (const t of threads) {
    const alarmName = "snooze-wake-" + t.threadId;
    if (existingNames.has(alarmName)) continue; // Already registered

    const delayMs = Math.max(0, t.wakeAt - now);
    if (delayMs <= 0) {
      // Time has already passed, wake immediately
      try {
        await wakeSnoozedThread(t.threadId);
      } catch (err) {
        console.warn("[gmail-organizer] Failed to wake expired snoozed thread:", err.message);
      }
    } else {
      const delayMinutes = Math.ceil(delayMs / 60000);
      try {
        chrome.alarms.create(alarmName, { delayInMinutes: Math.max(1, delayMinutes) });
      } catch (err) {
        console.warn("[gmail-organizer] Failed to restore snooze alarm:", err.message);
      }
    }
  }
}

// ============================================================================
// THREAD SUMMARIZATION FEATURE (v0.9.0) — Gemini
// ============================================================================

/**
 * Summarize a thread using Gemini API
 * @param {string} threadId - Gmail thread ID
 * @param {Object} options - Optional parameters
 * @returns {Promise<{threadId, summary, keyPoints, actionItems, participants, sentiment, messageCount, generatedAt}>}
 */
async function summarizeThread(threadId, options) {
  const enabled = await getFeatureFlag('ff_threadSummary', true);
  if (!enabled) throw new Error("Thread summary feature is disabled.");

  // Check cache first
  const cache = await chrome.storage.local.get({ threadSummaryCache: {} });
  const cacheObj = cache.threadSummaryCache || {};
  const cached = cacheObj[threadId];
  if (cached && cached.generatedAt) {
    const cacheAgeMs = Date.now() - new Date(cached.generatedAt).getTime();
    const cacheTtlMs = 24 * 60 * 60 * 1000; // 24 hours
    if (cacheAgeMs < cacheTtlMs) {
      return cached;
    }
  }

  // Check Gemini config
  const settings = await getSettings();
  if (settings.aiProvider !== 'gemini' || !settings.geminiApiKey) {
    throw new Error("Gemini is not configured. Add your API key in Settings.");
  }

  const token = await getToken();

  // Fetch full thread
  let thread = null;
  try {
    thread = await gmailRequest(token, "/threads/" + encodeURIComponent(threadId) + "?format=full");
  } catch (err) {
    throw new Error("Could not fetch thread: " + (err.message || String(err)));
  }

  if (!thread || !thread.messages) {
    throw new Error("No messages found in thread.");
  }

  // Extract plain text from all messages
  const messageTexts = [];
  for (const msg of thread.messages) {
    const text = extractPlainTextFromMessage(msg);
    if (text) messageTexts.push(text);
  }

  // Combine and cap at ~20000 characters
  let combinedText = messageTexts.join("\n\n---\n\n");
  if (combinedText.length > 20000) {
    console.warn("[gmail-organizer] Thread text exceeded 20k chars, truncating");
    combinedText = combinedText.slice(0, 20000);
  }

  if (!combinedText.trim()) {
    throw new Error("Could not extract text from thread messages.");
  }

  // Extract participants
  const participants = extractParticipants(thread.messages);

  // Build prompt
  const prompt = `You are summarizing an email thread. Extract the following information and return ONLY valid JSON (no markdown, no extra text):

{
  "summary": "2-3 sentence overview of the main topic",
  "keyPoints": ["point 1", "point 2", ...],
  "actionItems": ["action 1", "action 2", ...],
  "participants": [{"name": "Name", "role": "sender|recipient|cc"}],
  "sentiment": "neutral|urgent|friendly|formal"
}

Thread info:
- Message count: ${thread.messages.length}
- Participants: ${participants.map(p => p.name).join(", ")}

Email thread to summarize:

${combinedText}`;

  // Call Gemini
  let summary = null;
  try {
    const response = await requestGeminiSummary({
      apiKey: settings.geminiApiKey,
      model: settings.geminiModel || DEFAULT_GEMINI_MODEL,
      prompt: prompt,
      maxOutputTokens: 800
    });

    const text = extractGeminiText(response);
    if (text) {
      try {
        summary = JSON.parse(text);
      } catch (parseErr) {
        console.warn("[gmail-organizer] Failed to parse Gemini summary JSON:", parseErr.message);
        // Degrade gracefully
        summary = {
          summary: combinedText.slice(0, 500),
          keyPoints: [],
          actionItems: [],
          participants: participants,
          sentiment: "neutral"
        };
      }
    }
  } catch (err) {
    console.warn("[gmail-organizer] Gemini summary failed:", err.message);
    // Degrade to truncated text
    summary = {
      summary: combinedText.slice(0, 500),
      keyPoints: [],
      actionItems: [],
      participants: participants,
      sentiment: "neutral"
    };
  }

  const result = {
    threadId: threadId,
    summary: summary.summary || "",
    keyPoints: Array.isArray(summary.keyPoints) ? summary.keyPoints : [],
    actionItems: Array.isArray(summary.actionItems) ? summary.actionItems : [],
    participants: Array.isArray(summary.participants) ? summary.participants : participants,
    sentiment: summary.sentiment || "neutral",
    messageCount: thread.messages.length,
    generatedAt: new Date().toISOString()
  };

  // Cache the result
  cacheObj[threadId] = result;
  await chrome.storage.local.set({ threadSummaryCache: cacheObj });

  return result;
}

/**
 * Call Gemini API for thread summarization
 */
async function requestGeminiSummary(opts) {
  await throttleGeminiCall();

  const response = await fetchWithRetry("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(opts.model) + ":generateContent", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": opts.apiKey
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: opts.maxOutputTokens || 800
      }
    })
  });

  if (!response.ok) {
    let details = null;
    try { details = await response.json(); } catch (_) {}
    const errorMsg = (details && details.error && details.error.message) || ("Gemini API error (" + response.status + ")");
    await logAnonymousError('gemini_summary_error', { status: response.status, functionName: 'requestGeminiSummary' });
    throw new Error(errorMsg);
  }

  return response.json();
}

/**
 * Extract plain text from a message, stripping HTML and quoted content
 */
function extractPlainTextFromMessage(msg) {
  if (!msg.payload) return "";

  const parts = msg.payload.parts || [{ body: msg.payload.body }];
  let text = "";

  for (const part of parts) {
    if (part.mimeType === "text/plain" && part.body && part.body.data) {
      try {
        text += decodeBase64Url(part.body.data) + "\n";
      } catch (e) {
        console.warn("[gmail-organizer] Failed to decode message part:", e.message);
      }
    } else if (part.mimeType === "text/html" && part.body && part.body.data) {
      try {
        const html = decodeBase64Url(part.body.data);
        const plain = stripHtml(html);
        text += plain + "\n";
      } catch (e) {
        console.warn("[gmail-organizer] Failed to decode HTML message part:", e.message);
      }
    }
  }

  // Strip quoted replies and signatures
  const quoteMarkers = [
    /On .+?wrote:/i,
    /-----Original Message-----/i,
    /^>+\s/m,
    /^--\s*$/m
  ];

  for (const marker of quoteMarkers) {
    const idx = text.search(marker);
    if (idx !== -1) {
      text = text.slice(0, idx);
    }
  }

  return text.trim();
}

/**
 * Decode base64 URL-safe encoding (Gmail format)
 */
function decodeBase64Url(str) {
  try {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/');
    const padding = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    const bytes = new Uint8Array(atob(padded + padding).split('').map(c => c.charCodeAt(0)));
    return new TextDecoder().decode(bytes);
  } catch (e) {
    console.warn("[gmail-organizer] Base64 decode failed:", e.message);
    return "";
  }
}

/**
 * Strip HTML tags from text
 */
function stripHtml(html) {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n\n+/g, '\n');
}

/**
 * Extract participants from messages
 */
function extractParticipants(messages) {
  const seen = new Set();
  const participants = [];

  for (const msg of messages) {
    if (!msg.payload || !msg.payload.headers) continue;
    const headers = msg.payload.headers;

    const from = headers.find(h => h.name === 'From');
    const to = headers.find(h => h.name === 'To');
    const cc = headers.find(h => h.name === 'Cc');

    const addParticipant = (header, role) => {
      if (!header || !header.value) return;
      const emails = header.value.split(',');
      for (const email of emails) {
        const trimmed = email.trim();
        if (!seen.has(trimmed)) {
          seen.add(trimmed);
          const match = trimmed.match(/^(.+?)\s*<(.+?)>$/) || [null, trimmed, trimmed];
          participants.push({
            name: match[1] || match[2],
            email: match[2],
            role: role
          });
        }
      }
    };

    addParticipant(from, 'sender');
    addParticipant(to, 'recipient');
    addParticipant(cc, 'cc');
  }

  return participants;
}

// ============================================================================
// IMPORTANCE SCORING / PRIORITY INBOX FEATURE (v0.9.0)
// ============================================================================

/**
 * Initialize the learning table if not present
 */
async function initializeLearningTable() {
  const stored = await chrome.storage.local.get({ importanceLearning: null });
  if (stored.importanceLearning === null) {
    await chrome.storage.local.set({ importanceLearning: DEFAULT_LEARNING });
  }
}

/**
 * Get the current learning table
 */
async function getImportanceLearning() {
  const stored = await chrome.storage.local.get({ importanceLearning: {} });
  return stored.importanceLearning || DEFAULT_LEARNING;
}

/**
 * Compute importance score for a message (0-100)
 * @param {Object} message - Gmail message object
 * @param {Object} context - Additional context (learning table, etc.)
 * @returns {number} Importance score 0-100
 */
function computeMessageImportance(message, context) {
  let score = 50; // baseline
  const learning = context.learning || {};
  const frequentRepliers = learning.frequentRepliers || {};
  const starredSenders = learning.starredSenders || {};
  const lowImportanceSenders = learning.lowImportanceSenders || {};
  const userFeedback = learning.userFeedback || {};

  if (!message.payload || !message.payload.headers) return score;

  const headers = message.payload.headers;
  const getHeader = (name) => {
    const h = headers.find(h => h.name === name);
    return h ? h.value : "";
  };

  const from = getHeader('From');
  const subject = getHeader('Subject').toLowerCase();
  const to = getHeader('To');
  const inReplyTo = getHeader('In-Reply-To');

  // Extract sender email
  const senderMatch = from.match(/<(.+?)>/);
  const senderEmail = senderMatch ? senderMatch[1] : from;
  const senderDomain = senderEmail.includes('@') ? senderEmail.split('@')[1] : '';

  // +30 if sender is frequent replier
  if (frequentRepliers[senderEmail] && frequentRepliers[senderEmail] >= 3) {
    score += 30;
  }

  // +20 if user has starred messages from this sender
  if (starredSenders[senderEmail] && starredSenders[senderEmail] > 0) {
    score += 20;
  }

  // +15 if subject contains urgency keywords
  const urgencyKeywords = ['urgent', 'asap', 'important', 'action required', 'deadline', 'today'];
  if (urgencyKeywords.some(kw => subject.includes(kw))) {
    score += 15;
  }

  // +15 if user is in To: (not just Cc/Bcc)
  if (to && to.toLowerCase().includes(context.userEmail || '')) {
    score += 15;
  }

  // +10 if direct reply to user's sent message
  if (inReplyTo) {
    score += 10;
  }

  // +10 if small thread (1-on-1 or small group)
  const toList = to.split(',').filter(x => x.trim()).length;
  if (toList <= 3) {
    score += 10;
  }

  // -15 if sender in low importance list
  if (lowImportanceSenders[senderEmail] && lowImportanceSenders[senderEmail] > 0) {
    score -= 15;
  }
  if (lowImportanceSenders[senderDomain] && lowImportanceSenders[senderDomain] > 0) {
    score -= 15;
  }

  // -10 if subject contains promo keywords
  const promoKeywords = ['sale', 'unsubscribe', '% off', 'discount', 'deal'];
  if (promoKeywords.some(kw => subject.includes(kw))) {
    score -= 10;
  }

  // -10 if labeled as CATEGORY_PROMOTIONS, CATEGORY_SOCIAL, CATEGORY_UPDATES
  const lowPriorityLabels = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES'];
  if (message.labelIds && message.labelIds.some(lid => lowPriorityLabels.includes(lid))) {
    score -= 10;
  }

  // Clamp to 0-100
  return Math.max(0, Math.min(100, score));
}

/**
 * Get importance scores for recent inbox messages
 * @param {Object} options - { count: number (default 50, max 200) }
 * @returns {Promise<{items, computedAt}>}
 */
async function getImportanceScores(options) {
  const enabled = await getFeatureFlag('ff_priorityInbox', true);
  if (!enabled) throw new Error("Priority inbox feature is disabled.");

  // Check cache (5 minute TTL)
  const cache = await chrome.storage.local.get({ importanceScoresCache: null });
  if (cache.importanceScoresCache && cache.importanceScoresCache.computedAt) {
    const ageMs = Date.now() - new Date(cache.importanceScoresCache.computedAt).getTime();
    if (ageMs < 5 * 60 * 1000) {
      return cache.importanceScoresCache;
    }
  }

  const token = await getToken();
  const learning = await getImportanceLearning();
  const settings = await getSettings();
  const userEmail = settings.userEmail || '';

  const count = Math.min(options.count || 50, 200);

  // Fetch recent INBOX messages
  let messages = [];
  try {
    const response = await gmailRequest(token, "/messages?q=in:inbox&maxResults=" + count);
    const messageIds = response.messages ? response.messages.map(m => m.id) : [];

    // Fetch full message data for each
    for (const msgId of messageIds.slice(0, count)) {
      try {
        const msg = await gmailRequest(token, "/messages/" + encodeURIComponent(msgId) + "?format=full");
        messages.push(msg);
      } catch (err) {
        console.warn("[gmail-organizer] Failed to fetch message:", err.message);
      }
    }
  } catch (err) {
    throw new Error("Failed to fetch inbox messages: " + (err.message || String(err)));
  }

  // Compute scores
  const items = messages.map(msg => {
    const score = computeMessageImportance(msg, { learning, userEmail });
    const headers = msg.payload && msg.payload.headers ? msg.payload.headers : [];
    const from = (headers.find(h => h.name === 'From') || {}).value || '';
    const subject = (headers.find(h => h.name === 'Subject') || {}).value || '';
    const receivedAt = (headers.find(h => h.name === 'Date') || {}).value || '';

    // Build reasons array
    const reasons = [];
    const ctx = { learning, userEmail };
    if (score >= 50) {
      const frequentRepliers = learning.frequentRepliers || {};
      const senderMatch = from.match(/<(.+?)>/);
      const senderEmail = senderMatch ? senderMatch[1] : from;
      if (frequentRepliers[senderEmail] && frequentRepliers[senderEmail] >= 3) {
        reasons.push('+30 frequent replier');
      }
      const starredSenders = learning.starredSenders || {};
      if (starredSenders[senderEmail] && starredSenders[senderEmail] > 0) {
        reasons.push('+20 starred sender');
      }
      const subjectLower = subject.toLowerCase();
      if (['urgent', 'asap', 'important', 'action required', 'deadline', 'today'].some(kw => subjectLower.includes(kw))) {
        reasons.push('+15 urgency keyword');
      }
    }

    return {
      messageId: msg.id,
      threadId: msg.threadId,
      from: from,
      subject: subject,
      score: Math.round(score),
      reasons: reasons,
      receivedAt: receivedAt
    };
  }).sort((a, b) => b.score - a.score);

  const result = {
    items: items,
    computedAt: new Date().toISOString()
  };

  // Cache result
  await chrome.storage.local.set({ importanceScoresCache: result });

  return result;
}

/**
 * Record user feedback on message importance
 * @param {string} messageId - Gmail message ID
 * @param {string} feedback - 'important' or 'not-important'
 * @returns {Promise<{recorded}>}
 */
async function recordImportanceFeedback(messageId, feedback) {
  if (!['important', 'not-important'].includes(feedback)) {
    throw new Error("Feedback must be 'important' or 'not-important'.");
  }

  const token = await getToken();
  const learning = await getImportanceLearning();

  // Fetch message to get sender
  let message = null;
  try {
    message = await gmailRequest(token, "/messages/" + encodeURIComponent(messageId) + "?format=minimal");
  } catch (err) {
    throw new Error("Could not fetch message: " + (err.message || String(err)));
  }

  if (!message.payload || !message.payload.headers) {
    throw new Error("Message has no headers.");
  }

  const headers = message.payload.headers;
  const senderMatch = (headers.find(h => h.name === 'From') || {}).value || '';
  const senderEmail = senderMatch.match(/<(.+?)>/) ? senderMatch.match(/<(.+?)>/)[1] : senderMatch;

  // Update learning
  if (feedback === 'important') {
    if (!learning.starredSenders) learning.starredSenders = {};
    learning.starredSenders[senderEmail] = (learning.starredSenders[senderEmail] || 0) + 1;
  } else if (feedback === 'not-important') {
    if (!learning.lowImportanceSenders) learning.lowImportanceSenders = {};
    learning.lowImportanceSenders[senderEmail] = (learning.lowImportanceSenders[senderEmail] || 0) + 1;
  }

  // Record per-message feedback
  if (!learning.userFeedback) learning.userFeedback = {};
  learning.userFeedback[messageId] = feedback;

  // Clear cache since learning changed
  await chrome.storage.local.set({ importanceLearning: learning, importanceScoresCache: null });

  return { recorded: true, messageId: messageId, feedback: feedback };
}

/**
 * Update learning from organize actions
 * @param {Object} historyEntry - History entry with actions
 */
async function updateLearningFromActions(historyEntry) {
  const enabled = await getFeatureFlag('ff_priorityInbox', true);
  if (!enabled) return;

  if (!historyEntry.actions || !Array.isArray(historyEntry.actions)) return;

  const learning = await getImportanceLearning();

  // For each action, update learning
  for (const action of historyEntry.actions) {
    if (!action.threadId) continue;

    // If user archived or trashed via a rule, mark sender as low-importance
    if (action.action === 'archive' || action.action === 'trash') {
      // We don't have direct access to the message here, so this is a passive signal
      // Future enhancement: fetch message and extract sender
    }
  }

  await chrome.storage.local.set({ importanceLearning: learning });
}

/**
 * Helper to get or create a label (reusable from existing code)
 */
async function getOrCreateLabel(token, labelName, color) {
  const labelsByName = await getLabelsByName(token);
  const existingId = labelsByName.get(labelName);
  if (existingId) return existingId;
  return createLabel(token, labelName, color);
}

// ============================================================================
// LABEL DECISIONS LOG — powers "Why was this labeled?" feature
// ============================================================================

/**
 * Store a label decision (max 300 most recent entries)
 */
function _storeLabelDecision(decision) {
  // Fire-and-forget — never block the main organize loop
  chrome.storage.local.get({ labelDecisionLog: [] }).then(function(stored) {
    var log = Array.isArray(stored.labelDecisionLog) ? stored.labelDecisionLog : [];
    log.unshift(Object.assign({ timestamp: new Date().toISOString() }, decision));
    if (log.length > 300) log.length = 300;
    chrome.storage.local.set({ labelDecisionLog: log }).catch(function() {});
  }).catch(function() {});
}

/**
 * Get label decisions for a specific thread or all recent decisions
 */
async function getLabelDecisionLog(opts) {
  var stored = await chrome.storage.local.get({ labelDecisionLog: [] });
  var log = Array.isArray(stored.labelDecisionLog) ? stored.labelDecisionLog : [];
  if (opts && opts.threadId) {
    return { decisions: log.filter(function(d) { return d.threadId === opts.threadId; }) };
  }
  if (opts && opts.ruleId) {
    return { decisions: log.filter(function(d) { return d.ruleId === opts.ruleId; }).slice(0, 10) };
  }
  return { decisions: log.slice(0, 50) };
}

// ============================================================================
// BLOCK SENDER — nuclear option: rule + retroactive trash + unsubscribe
// ============================================================================

/**
 * Block a sender: creates auto-trash rule, retroactively trashes, attempts unsubscribe
 */
async function blockSender(opts) {
  var from = opts && opts.from || '';
  var messageId = opts && opts.messageId || null;
  if (!from) throw new Error('Sender address required.');

  // Extract bare email
  var emailMatch = from.match(/<([^>]+)>/) || from.match(/([^\s@]+@[^\s@]+)/);
  var senderEmail = emailMatch ? emailMatch[1].trim() : from.trim();
  if (!senderEmail || !senderEmail.includes('@')) throw new Error('Could not parse sender email from: ' + from);

  var token = await getToken();
  var results = { senderEmail: senderEmail, ruleCreated: false, trashed: 0, unsubscribed: null };

  // 1. Create/update auto-trash rule for this sender
  var settings = await getSettings();
  var rules = settings.rules || [];
  var existingBlock = rules.find(function(r) {
    return r.action === 'trash' && r.match && (r.match.fromIncludes || []).some(function(f) { return f.toLowerCase() === senderEmail.toLowerCase(); });
  });
  if (!existingBlock) {
    var blockRule = {
      id: 'block-' + Date.now(),
      name: 'Blocked: ' + senderEmail,
      label: 'Blocked',
      action: 'trash',
      enabled: true,
      match: { fromDomains: [], fromIncludes: [senderEmail], subjectIncludes: [] }
    };
    rules.unshift(blockRule);
    await saveSettings(Object.assign({}, settings, { rules: rules }));
    results.ruleCreated = true;
    tsLog('info', 'blockSender: rule created for', senderEmail);
  }

  // 2. Retroactively trash all existing emails from this sender
  try {
    var query = 'from:' + senderEmail;
    var page = null, trashedCount = 0;
    do {
      var listUrl = '/threads?q=' + encodeURIComponent(query) + '&maxResults=100';
      if (page) listUrl += '&pageToken=' + encodeURIComponent(page);
      var data = await gmailRequest(token, listUrl);
      var threads = data.threads || [];
      page = data.nextPageToken || null;
      // Trash in chunks of 10 in parallel
      for (var ci = 0; ci < threads.length; ci += 10) {
        var chunk = threads.slice(ci, ci + 10);
        await Promise.allSettled(chunk.map(function(t) { return trashThread(token, t.id).then(function() { trashedCount++; }); }));
        if (ci + 10 < threads.length) await sleep(100);
      }
    } while (page && trashedCount < 2000);
    results.trashed = trashedCount;
    tsLog('info', 'blockSender: trashed', trashedCount, 'threads from', senderEmail);
  } catch (trashErr) {
    tsLog('warn', 'blockSender: retroactive trash error', trashErr && trashErr.message);
  }

  // 3. Attempt unsubscribe if we have a message ID
  if (messageId) {
    try {
      var unsubResult = await unsubscribeFromSender(messageId);
      results.unsubscribed = unsubResult;
    } catch (_) {}
  }

  return results;
}

/**
 * Ad-hoc bulk action: search Gmail with an arbitrary query and apply label/archive/trash
 * opts: { query, action, label, dryRun, maxThreads }
 * Returns { matched, applied, action, label, dryRun, preview }
 */
async function bulkAction(opts) {
  var query = (opts && opts.query || '').trim();
  var action = (opts && opts.action) || 'label';
  var label = (opts && opts.label || '').trim();
  var dryRun = (opts && opts.dryRun) !== false; // default dry run for safety
  var maxThreads = Math.min(Math.max(Number(opts && opts.maxThreads) || 100, 1), 500);

  if (!query) throw new Error('Search query is required.');
  if (action === 'label' && !label) throw new Error('Label name is required for label action.');

  var token = await getToken();
  var matched = 0;
  var preview = [];
  var page = null;
  var allThreadIds = [];

  // Collect matching thread IDs (up to maxThreads)
  do {
    var listUrl = '/threads?q=' + encodeURIComponent(query) + '&maxResults=100';
    if (page) listUrl += '&pageToken=' + encodeURIComponent(page);
    var data = await gmailRequest(token, listUrl);
    var threads = data.threads || [];
    page = data.nextPageToken || null;
    for (var i = 0; i < threads.length && allThreadIds.length < maxThreads; i++) {
      allThreadIds.push(threads[i].id);
    }
    matched = allThreadIds.length;
  } while (page && allThreadIds.length < maxThreads);

  // For dry-run preview, fetch subject+from of first 10
  if (dryRun) {
    var previewIds = allThreadIds.slice(0, 10);
    for (var pi = 0; pi < previewIds.length; pi++) {
      try {
        var thread = await gmailRequest(token, '/threads/' + previewIds[pi] + '?format=metadata&metadataHeaders=Subject&metadataHeaders=From');
        var msg = (thread.messages || [])[0];
        if (msg) {
          var headers = (msg.payload && msg.payload.headers) || [];
          var subject = (headers.find(function(h) { return h.name === 'Subject'; }) || {}).value || '(no subject)';
          var from = (headers.find(function(h) { return h.name === 'From'; }) || {}).value || '';
          preview.push({ threadId: previewIds[pi], subject: subject, from: from });
        }
      } catch (_) {}
    }
    return { matched: matched, applied: 0, action: action, label: label, dryRun: true, preview: preview };
  }

  // Apply action
  var applied = 0;
  var labelId = null;
  if (action === 'label' || action === 'archive-label') {
    // Normalize flat label name to hierarchical (e.g. "security alert" → "Updates/security alert")
    var normalizedLabel = normalizeLabelName(label);
    var token2 = await getToken();
    var labelsByName2 = await getLabelsByName(token2);
    labelId = labelsByName2.get(normalizedLabel) || labelsByName2.get(label) || null;
    if (!labelId) {
      try {
        labelId = await createLabel(token2, normalizedLabel, null);
      } catch (_le) {
        // Refresh and try original name as fallback
        var fresh = await getLabelsByName(token2);
        labelId = fresh.get(normalizedLabel) || fresh.get(label) || null;
      }
    }
    if (!labelId) throw new Error('Could not create or find label "' + label + '".');
  }

  for (var ci = 0; ci < allThreadIds.length; ci += 10) {
    var chunk = allThreadIds.slice(ci, ci + 10);
    await Promise.allSettled(chunk.map(async function(tid) {
      try {
        if (action === 'label') {
          await modifyThread(token, tid, labelId, false);
        } else if (action === 'archive') {
          await modifyThread(token, tid, null, true);
        } else if (action === 'archive-label') {
          await modifyThread(token, tid, labelId, true);
        } else if (action === 'trash') {
          await trashThread(token, tid);
        }
        applied++;
      } catch (_) {}
    }));
    if (ci + 10 < allThreadIds.length) await sleep(80);
  }

  tsLog('info', 'bulkAction: action=' + action + ' query=' + query + ' applied=' + applied + '/' + matched);
  return { matched: matched, applied: applied, action: action, label: label, dryRun: false, preview: [] };
}

// ============================================================================
// AUTO-LABEL FOLLOW-UPS
// ============================================================================

/**
 * Scan sent mail and auto-apply Action/Follow Up label to unanswered threads
 */
async function autoLabelFollowUps(opts) {
  var daysThreshold = (opts && opts.daysThreshold) || 3;
  var maxItems = (opts && opts.maxItems) || 100;
  var dryRun = !!(opts && opts.dryRun);

  var token = await getToken();
  var followUpLabelId = await getOrCreateLabel(token, 'Follow Up', null);
  var query = 'in:sent older_than:' + daysThreshold + 'd';
  var data = await gmailRequest(token, '/threads?q=' + encodeURIComponent(query) + '&maxResults=' + Math.min(maxItems, 200));
  await trackQuotaUnit(5);
  var threads = data.threads || [];
  var labeled = 0, skipped = 0;

  for (var i = 0; i < Math.min(threads.length, maxItems); i++) {
    try {
      var t = await gmailRequest(token, '/threads/' + threads[i].id + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject');
      await trackQuotaUnit(5);
      var msgs = t.messages || [];
      // Only flag if thread has exactly 1 message (I sent, nobody replied)
      if (msgs.length === 1) {
        var existingLabels = msgs[0].labelIds || [];
        // Skip if already labeled as follow-up or if it's in trash/spam
        if (existingLabels.includes(followUpLabelId) || existingLabels.includes('TRASH') || existingLabels.includes('SPAM')) {
          skipped++;
          continue;
        }
        if (!dryRun) {
          await fetch(GMAIL_API_BASE + '/threads/' + encodeURIComponent(threads[i].id) + '/modify', {
            method: 'POST',
            headers: buildHeaders(token),
            body: JSON.stringify({ addLabelIds: [followUpLabelId] })
          });
          await trackQuotaUnit(5);
          _storeLabelDecision({ threadId: threads[i].id, label: 'Follow Up', ruleId: 'auto-followup', ruleName: 'Auto: no reply', from: '', subject: '', reason: 'sent ' + daysThreshold + '+ days ago, no reply' });
        }
        labeled++;
      }
    } catch (_) { skipped++; }
    if (i % 10 === 9) await sleep(150);
  }
  return { labeled: labeled, skipped: skipped, dryRun: dryRun };
}

// ============================================================================
// READ-LATER QUEUE
// ============================================================================

/**
 * Return emails received in the inbox today (since midnight local time).
 * Uses Gmail's `after:` date filter so only today's messages are returned.
 */
async function getTodayEmails() {
  var token = await getToken();

  // Build today's date in YYYY/MM/DD format (Gmail after: filter expects this)
  var now = new Date();
  var y = now.getFullYear();
  var m = String(now.getMonth() + 1).padStart(2, '0');
  var d = String(now.getDate()).padStart(2, '0');
  var todayStr = y + '/' + m + '/' + d;

  // Query: inbox emails received today
  var q = 'in:inbox after:' + todayStr;
  var data = await gmailRequest(token, '/threads?q=' + encodeURIComponent(q) + '&maxResults=50');
  await trackQuotaUnit(5);

  var threads = data.threads || [];
  var total = data.resultSizeEstimate || threads.length;

  // Fetch metadata for first 25 in parallel
  var preview = threads.slice(0, 25);
  var metas = await parallelMap(preview, async function(ref) {
    try {
      return await gmailRequest(token, '/threads/' + ref.id + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date');
    } catch (_) { return null; }
  }, 10);

  var items = [];
  var unreadCount = 0;

  for (var i = 0; i < metas.length; i++) {
    var t = metas[i];
    if (!t) continue;
    // Use the LAST message in thread (most recent reply/email)
    var msgs = t.messages || [];
    var msg = msgs[msgs.length - 1] || msgs[0];
    if (!msg) continue;
    var headers = (msg.payload && msg.payload.headers) || [];
    var from    = getHeader(headers, 'From');
    var subject = getHeader(headers, 'Subject');
    var isUnread = Array.isArray(msg.labelIds) && msg.labelIds.includes('UNREAD');
    if (isUnread) unreadCount++;

    // Format arrival time as HH:MM
    var internalDate = parseInt(msg.internalDate || '0', 10);
    var timeStr = '';
    if (internalDate > 0) {
      var dt = new Date(internalDate);
      timeStr = dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }

    // Clean up "Name <email>" → just name for display
    var displayFrom = from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || from;

    items.push({ threadId: preview[i].id, from: displayFrom, subject: subject, isUnread: isUnread, time: timeStr });
  }

  // Sort: unread first, then by time descending
  items.sort(function(a, b) {
    if (a.isUnread !== b.isUnread) return a.isUnread ? -1 : 1;
    return (b.time || '').localeCompare(a.time || '');
  });

  tsLog('info', 'getTodayEmails — total:', total, 'unread:', unreadCount);
  return { count: total, unread: unreadCount, items: items };
}

/**
 * Return threads in the Reading/Saved label (the Read-Later queue)
 */
async function scanReadLater(opts) {
  var token = await getToken();
  var maxResults = (opts && opts.maxResults) || 30;

  // Find label ID for Reading/Saved
  var labelsByName = await getLabelsByName(token);
  var savedLabelId = labelsByName.get('Read Later');

  if (!savedLabelId) {
    return { count: 0, unread: 0, items: [], labelExists: false };
  }

  // Use labelIds= parameter instead of a text query — avoids the Gmail search
  // slash-vs-hyphen mismatch (label:Reading/Saved returns nothing; labelIds works by ID).
  var data = await gmailRequest(token, '/threads?labelIds=' + encodeURIComponent(savedLabelId) + '&maxResults=' + maxResults);
  await trackQuotaUnit(5);
  var threads = data.threads || [];
  var total = data.resultSizeEstimate || threads.length;
  var items = [];
  var unreadCount = 0;

  // Fetch metadata in parallel (was sequential with sleep)
  var previewThreads = threads.slice(0, 20);
  var metas = await parallelMap(previewThreads, async function(ref) {
    try {
      return await gmailRequest(token, '/threads/' + ref.id + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject');
    } catch (_) { return null; }
  }, 10);

  for (var i = 0; i < metas.length; i++) {
    var t = metas[i];
    if (!t) continue;
    var firstMsg = t.messages && t.messages[0];
    var headers = (firstMsg && firstMsg.payload && firstMsg.payload.headers) || [];
    var from = getHeader(headers, 'From');
    var subject = getHeader(headers, 'Subject');
    var isUnread = firstMsg && firstMsg.labelIds && firstMsg.labelIds.includes('UNREAD');
    if (isUnread) unreadCount++;
    items.push({ threadId: previewThreads[i].id, from: from, subject: subject, isUnread: !!isUnread });
  }

  return { count: total, unread: unreadCount, items: items, labelExists: true };
}

// ============================================================================
// UNSUBSCRIBE LOG ACCESS
// ============================================================================

async function getUnsubscribeLog() {
  var stored = await chrome.storage.local.get({ unsubscribeLog: [] });
  return { log: Array.isArray(stored.unsubscribeLog) ? stored.unsubscribeLog : [] };
}

// ============================================================================
// DAILY EMAIL DIGEST — 8am Chrome notification with yesterday's summary
// ============================================================================

function _getNext8amMs() {
  var now = new Date();
  var next = new Date(now);
  next.setHours(8, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

async function scheduleDailyDigestAlarm() {
  var settings = await getSettings();
  // Only schedule if user has digest enabled (default: on)
  if (settings.dailyDigestEnabled === false) {
    chrome.alarms.clear('gmailOrganizerDailyDigest');
    return;
  }
  var existing = await chrome.alarms.get('gmailOrganizerDailyDigest');
  if (!existing) {
    chrome.alarms.create('gmailOrganizerDailyDigest', {
      when: _getNext8amMs(),
      periodInMinutes: 24 * 60
    });
    tsLog('info', 'dailyDigest: alarm scheduled for', new Date(_getNext8amMs()).toLocaleString());
  }
}

async function sendDailyDigest() {
  try {
    var settings = await getSettings();
    if (settings.dailyDigestEnabled === false) return;

    var history = await getHistory();
    var now = Date.now();
    var oneDayMs = 24 * 60 * 60 * 1000;
    var yesterday = now - oneDayMs;

    // Events from the last 24 hours
    var recentRuns = history.filter(function(e) { return new Date(e.timestamp).getTime() > yesterday; });
    var organized = recentRuns.filter(function(e) { return e.source !== 'empty-trash' && e.status === 'success'; });
    var totalOrganized = organized.reduce(function(s, e) { return s + (e.matchedThreads || 0); }, 0);

    // Unsubscribes in last 24h from log
    var unsubStored = await chrome.storage.local.get({ unsubscribeLog: [] });
    var unsubLog = unsubStored.unsubscribeLog || [];
    var recentUnsubs = unsubLog.filter(function(e) { return e.timestamp && new Date(e.timestamp).getTime() > yesterday; });
    var verifiedUnsubs = recentUnsubs.filter(function(e) { return e.verified === 'posted' || e.verified === 'sent'; });

    // Inbox score for follow-up hint
    var scoreData = null;
    try { scoreData = await getInboxScore(); } catch (_) {}
    var unreadCount = scoreData ? scoreData.unread : 0;

    if (totalOrganized === 0 && recentUnsubs.length === 0 && unreadCount === 0) return; // Nothing to report

    var lines = [];
    if (totalOrganized > 0) lines.push(totalOrganized + ' emails organized');
    if (verifiedUnsubs.length > 0) lines.push(verifiedUnsubs.length + ' unsubscribed');
    if (unreadCount > 0) lines.push(unreadCount + ' unread emails');
    var message = lines.join(' · ') || 'Your inbox is up to date';

    chrome.notifications.create('gmailOrganizerDailyDigest-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: '📬 Gmail Organizer — Daily Summary',
      message: message,
      priority: 1
    });

    tsLog('info', 'dailyDigest sent:', message);
  } catch (err) {
    tsLog('warn', 'dailyDigest error:', err && err.message);
  }
}

// ============================================================================
// BADGE COUNT — update extension badge with actionable count
// ============================================================================

async function updateBadgeCount() {
  try {
    var token = await getToken().catch(function() { return null; });
    if (!token) { chrome.action.setBadgeText({ text: '' }); return; }
    // Count: unread inbox threads needing action
    var data = await gmailRequest(token, '/threads?q=in:inbox is:unread&maxResults=1').catch(function() { return { resultSizeEstimate: 0 }; });
    var count = data.resultSizeEstimate || 0;
    if (count > 0) {
      chrome.action.setBadgeText({ text: count > 99 ? '99+' : String(count) });
      chrome.action.setBadgeBackgroundColor({ color: '#4f9cf9' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (_) {
    chrome.action.setBadgeText({ text: '' });
  }
}

} catch (error) {
  // Service worker error handler
  const errorLog = {
    timestamp: new Date().toISOString(),
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : ""
  };
  console.error('[gmail-organizer] Unhandled service worker error:', errorLog);
  chrome.storage.local.set({ lastSwError: errorLog }).catch(function() {});
}
