# Backend Setup Guide

## What was built
5 Cloud Functions:
- `checkAccess` — extension calls this before every action to see if user has credits
- `consumeCredit` — extension calls this after a successful action to deduct 1 credit
- `createCheckout` — creates a Stripe payment link when user clicks a pricing button
- `stripeWebhook` — Stripe calls this when payment succeeds / subscription changes
- `getUserStatus` — returns current plan + credit info to show in the extension UI

---

## Step 1 — Firebase setup (do once in the console)

1. Enable **Firestore Database** → production mode → region `us-central1`
2. Enable **Authentication** → Google provider → add your email as support email
3. Upgrade to **Blaze plan** (required for Cloud Functions)

---

## Step 2 — Stripe setup

1. Go to https://dashboard.stripe.com/products
2. Create 3 products:
   - **Basic** → one-time price → $5
   - **Pro Monthly** → recurring monthly → $7/month
   - **Pro Yearly** → recurring yearly → $48/year ($4/month)
3. Copy each Price ID (starts with `price_...`)

---

## Step 3 — Set environment variables

In your terminal, inside the `backend/` folder:

```bash
firebase functions:secrets:set STRIPE_SECRET_KEY
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
firebase functions:secrets:set STRIPE_PRICE_BASIC
firebase functions:secrets:set STRIPE_PRICE_PRO_MONTHLY
firebase functions:secrets:set STRIPE_PRICE_PRO_YEARLY
```

Enter the values when prompted. These are stored securely in Google Secret Manager.

---

## Step 4 — Deploy

```bash
# Install Firebase CLI if you haven't
npm install -g firebase-tools

# Login
firebase login

# Inside backend/ folder
cd backend
npm install --prefix functions
firebase use --add   # select your Gmail-Organizer project
firebase deploy
```

After deploy, you'll get URLs like:
```
https://us-central1-gmail-organizer-XXXXX.cloudfunctions.net/checkAccess
https://us-central1-gmail-organizer-XXXXX.cloudfunctions.net/consumeCredit
https://us-central1-gmail-organizer-XXXXX.cloudfunctions.net/createCheckout
https://us-central1-gmail-organizer-XXXXX.cloudfunctions.net/stripeWebhook
https://us-central1-gmail-organizer-XXXXX.cloudfunctions.net/getUserStatus
```

Copy the base URL — you'll need it for the extension.

---

## Step 5 — Stripe Webhook

1. Go to https://dashboard.stripe.com/webhooks
2. Click **Add endpoint**
3. URL: `https://us-central1-YOUR-PROJECT.cloudfunctions.net/stripeWebhook`
4. Select events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
5. Copy the **Signing secret** and set it:
   ```bash
   firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
   ```

---

## Step 6 — Update the extension

Add your Cloud Functions base URL to `background.js`:

```javascript
const API_BASE = 'https://us-central1-YOUR-PROJECT.cloudfunctions.net';
```

That's it — the extension will automatically check credits and enforce limits.
