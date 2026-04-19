#!/bin/bash
set -e
cd "/Users/ayoubouddaf/Documents/New project/gmail-organizer-extension/backend"

SK="sk_test_YOUR_STRIPE_SECRET_KEY_HERE"
PRICE_BASIC="price_1TN36WJVYSKAeN51gqC3o8op"
PRICE_PRO_MONTHLY="price_1TN36XJVYSKAeN51tCdE9a1Q"
PRICE_PRO_YEARLY="price_1TN36YJVYSKAeN51M5QZFiTi"

echo "📦 Installing dependencies..."
npm install --prefix functions

echo "🔧 Installing Firebase CLI..."
npm install -g firebase-tools 2>/dev/null || true

echo "🔑 Setting Firebase secrets..."
echo "$SK" | firebase functions:secrets:set STRIPE_SECRET_KEY --force
echo "$PRICE_BASIC" | firebase functions:secrets:set STRIPE_PRICE_BASIC --force
echo "$PRICE_PRO_MONTHLY" | firebase functions:secrets:set STRIPE_PRICE_PRO_MONTHLY --force
echo "$PRICE_PRO_YEARLY" | firebase functions:secrets:set STRIPE_PRICE_PRO_YEARLY --force
echo "YOUR_WEBHOOK_SECRET_HERE" | firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --force

echo "🚀 Deploying Cloud Functions..."
firebase deploy --only functions

echo ""
echo "✅ DONE! Your Cloud Functions are live."
echo "Find your URLs in the Firebase console:"
echo "https://console.firebase.google.com/project/organizer-f5aa8/functions"
