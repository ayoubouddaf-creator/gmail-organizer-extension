#\!/bin/bash
# Gmail Organizer — Backend Deploy Script
# Run this from your Firebase project folder

# ── CONFIG (fill these in) ────────────────────────────────────────────────────
STRIPE_SECRET_KEY="sk_test_YOUR_STRIPE_SECRET_KEY_HERE"
STRIPE_WEBHOOK_SECRET="YOUR_WEBHOOK_SECRET_HERE"
# ─────────────────────────────────────────────────────────────────────────────

echo "📦 Installing dependencies..."
npm install stripe firebase-admin @google-cloud/functions-framework node-fetch@2

echo "🔑 Setting Firebase config..."
firebase functions:config:set \
  stripe.secret="$STRIPE_SECRET_KEY" \
  stripe.webhook_secret="$STRIPE_WEBHOOK_SECRET"

echo "🚀 Deploying functions..."
firebase deploy --only functions

echo "✅ Done\! Don't forget to:"
echo "  1. Register the webhook URL in Stripe Dashboard"
echo "  2. Regenerate your Stripe secret key (it was shared in chat)"
