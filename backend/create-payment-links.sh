#!/bin/bash
SK="sk_test_YOUR_STRIPE_SECRET_KEY_HERE"
REDIRECT="https://mail.google.com"

echo "🔗 Creating Stripe Payment Links..."

BASIC=$(curl -s https://api.stripe.com/v1/payment_links \
  -u "$SK:" \
  -d "line_items[0][price]=price_1TN36WJVYSKAeN51gqC3o8op" \
  -d "line_items[0][quantity]=1" \
  -d "after_completion[type]=redirect" \
  -d "after_completion[redirect][url]=$REDIRECT")
BASIC_URL=$(echo "$BASIC" | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])")
echo "✅ Basic: $BASIC_URL"

PRO_M=$(curl -s https://api.stripe.com/v1/payment_links \
  -u "$SK:" \
  -d "line_items[0][price]=price_1TN36XJVYSKAeN51tCdE9a1Q" \
  -d "line_items[0][quantity]=1" \
  -d "after_completion[type]=redirect" \
  -d "after_completion[redirect][url]=$REDIRECT")
PRO_M_URL=$(echo "$PRO_M" | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])")
echo "✅ Pro Monthly: $PRO_M_URL"

PRO_Y=$(curl -s https://api.stripe.com/v1/payment_links \
  -u "$SK:" \
  -d "line_items[0][price]=price_1TN36YJVYSKAeN51M5QZFiTi" \
  -d "line_items[0][quantity]=1" \
  -d "after_completion[type]=redirect" \
  -d "after_completion[redirect][url]=$REDIRECT")
PRO_Y_URL=$(echo "$PRO_Y" | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])")
echo "✅ Pro Yearly: $PRO_Y_URL"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "BASIC_URL=$BASIC_URL"
echo "PRO_MONTHLY_URL=$PRO_M_URL"
echo "PRO_YEARLY_URL=$PRO_Y_URL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
