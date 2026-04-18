#!/bin/bash
SK="sk_test_YOUR_STRIPE_SECRET_KEY_HERE"

echo "🚀 Creating Stripe products..."

# Basic ($5 one-time)
BASIC_PROD=$(curl -s https://api.stripe.com/v1/products -u "$SK:" -d "name=Gmail Organizer Basic" -d "description=7 days of unlimited inbox access")
BASIC_ID=$(echo "$BASIC_PROD" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
BASIC_PRICE=$(curl -s https://api.stripe.com/v1/prices -u "$SK:" -d "product=$BASIC_ID" -d "unit_amount=500" -d "currency=usd")
BASIC_PRICE_ID=$(echo "$BASIC_PRICE" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "✅ Basic: $BASIC_PRICE_ID"

# Pro Monthly ($7/month)
PRO_M_PROD=$(curl -s https://api.stripe.com/v1/products -u "$SK:" -d "name=Gmail Organizer Pro Monthly" -d "description=Unlimited cleanups, billed monthly")
PRO_M_ID=$(echo "$PRO_M_PROD" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
PRO_M_PRICE=$(curl -s https://api.stripe.com/v1/prices -u "$SK:" -d "product=$PRO_M_ID" -d "unit_amount=700" -d "currency=usd" -d "recurring[interval]=month")
PRO_M_PRICE_ID=$(echo "$PRO_M_PRICE" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "✅ Pro Monthly: $PRO_M_PRICE_ID"

# Pro Yearly ($48/year)
PRO_Y_PROD=$(curl -s https://api.stripe.com/v1/products -u "$SK:" -d "name=Gmail Organizer Pro Yearly" -d "description=Unlimited cleanups, billed yearly")
PRO_Y_ID=$(echo "$PRO_Y_PROD" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
PRO_Y_PRICE=$(curl -s https://api.stripe.com/v1/prices -u "$SK:" -d "product=$PRO_Y_ID" -d "unit_amount=4800" -d "currency=usd" -d "recurring[interval]=year")
PRO_Y_PRICE_ID=$(echo "$PRO_Y_PRICE" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "✅ Pro Yearly: $PRO_Y_PRICE_ID"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "STRIPE_SECRET_KEY=$SK"
echo "STRIPE_PRICE_BASIC=$BASIC_PRICE_ID"
echo "STRIPE_PRICE_PRO_MONTHLY=$PRO_M_PRICE_ID"
echo "STRIPE_PRICE_PRO_YEARLY=$PRO_Y_PRICE_ID"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
