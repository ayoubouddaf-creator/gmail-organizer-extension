const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const cors = require("cors")({ origin: true });

admin.initializeApp();
const db = admin.firestore();

// ─── Plan definitions ────────────────────────────────────────────────────────
const PLANS = {
  free:         { credits: 20,        label: "Free" },
  basic:        { credits: 999999,    label: "Basic",      durationDays: 7 },
  pro_monthly:  { credits: 999999,    label: "Pro Monthly" },
  pro_yearly:   { credits: 999999,    label: "Pro Yearly"  },
};

// Stripe price IDs — fill these in after creating products in Stripe dashboard
const STRIPE_PRICES = {
  basic:       process.env.STRIPE_PRICE_BASIC,
  pro_monthly: process.env.STRIPE_PRICE_PRO_MONTHLY,
  pro_yearly:  process.env.STRIPE_PRICE_PRO_YEARLY,
};

// ─── Helper: get or create user doc ─────────────────────────────────────────
async function getOrCreateUser(email) {
  const ref = db.collection("users").doc(email);
  const snap = await ref.get();

  if (!snap.exists) {
    const now = new Date();
    const resetDate = new Date(now.getFullYear(), now.getMonth() + 1, 1); // 1st of next month
    await ref.set({
      email,
      plan: "free",
      creditsUsed: 0,
      creditsReset: resetDate.toISOString(),
      planExpiry: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      createdAt: now.toISOString(),
    });
    return (await ref.get()).data();
  }
  return snap.data();
}

// ─── Helper: reset credits if month rolled over ──────────────────────────────
async function maybeResetCredits(email, userData) {
  const now = new Date();
  const reset = new Date(userData.creditsReset);
  if (now >= reset) {
    const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    await db.collection("users").doc(email).update({
      creditsUsed: 0,
      creditsReset: nextReset.toISOString(),
    });
    userData.creditsUsed = 0;
    userData.creditsReset = nextReset.toISOString();
  }
  return userData;
}

// ─── 1. CHECK ACCESS ─────────────────────────────────────────────────────────
// Called by the extension before every action.
// Returns: { allowed: true/false, creditsLeft: number, plan: string }
exports.checkAccess = onRequest({ cors: true, invoker: "public" }, async (req, res) => {
  const email = req.body?.email || req.query.email;
  if (!email) return res.status(400).json({ error: "email required" });

  try {
    let user = await getOrCreateUser(email);
    user = await maybeResetCredits(email, user);

    const plan = PLANS[user.plan] || PLANS.free;

    // Check if basic (7-day) plan has expired
    if (user.plan === "basic" && user.planExpiry) {
      if (new Date() > new Date(user.planExpiry)) {
        await db.collection("users").doc(email).update({ plan: "free" });
        user.plan = "free";
      }
    }

    const creditsLeft = plan.credits - user.creditsUsed;
    const allowed = creditsLeft > 0;

    return res.json({
      allowed,
      plan: user.plan,
      creditsUsed: user.creditsUsed,
      creditsLeft: Math.max(0, creditsLeft),
      creditsTotal: plan.credits,
      creditsReset: user.creditsReset,
    });
  } catch (err) {
    console.error("checkAccess error", err);
    return res.status(500).json({ error: "server error" });
  }
});

// ─── 2. CONSUME CREDIT ───────────────────────────────────────────────────────
// Called by the extension after a successful action.
exports.consumeCredit = onRequest({ cors: true, invoker: "public" }, async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email required" });

  try {
    let user = await getOrCreateUser(email);
    user = await maybeResetCredits(email, user);

    const plan = PLANS[user.plan] || PLANS.free;
    if (user.creditsUsed >= plan.credits) {
      return res.status(403).json({ error: "no credits left" });
    }

    await db.collection("users").doc(email).update({
      creditsUsed: admin.firestore.FieldValue.increment(1),
    });

    return res.json({ success: true, creditsUsed: user.creditsUsed + 1 });
  } catch (err) {
    console.error("consumeCredit error", err);
    return res.status(500).json({ error: "server error" });
  }
});

// ─── 3. CREATE CHECKOUT SESSION ──────────────────────────────────────────────
// Called when user clicks a pricing button.
// Returns a Stripe Checkout URL to redirect the user to.
exports.createCheckout = onRequest({ cors: true, invoker: "public" }, async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  const { email, plan } = req.body;
  if (!email || !plan) return res.status(400).json({ error: "email and plan required" });

  const priceId = STRIPE_PRICES[plan];
  if (!priceId) return res.status(400).json({ error: "invalid plan" });

  try {
    const Stripe = require("stripe");
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

    let user = await getOrCreateUser(email);

    // Create or reuse Stripe customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email });
      customerId = customer.id;
      await db.collection("users").doc(email).update({ stripeCustomerId: customerId });
    }

    const isOneTime = plan === "basic";
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ["card"],
      mode: isOneTime ? "payment" : "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `https://ayoubouddaf-creator.github.io/gmail-organizer-extension/?payment=success&plan=${plan}`,
      cancel_url:  `https://ayoubouddaf-creator.github.io/gmail-organizer-extension/?payment=cancelled`,
      metadata: { email, plan },
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("createCheckout error", err);
    return res.status(500).json({ error: "server error" });
  }
});

// ─── 4. STRIPE WEBHOOK ───────────────────────────────────────────────────────
// Stripe calls this automatically when a payment succeeds or subscription changes.
exports.stripeWebhook = onRequest({ cors: false }, async (req, res) => {
  const Stripe = require("stripe");
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature failed", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const session = event.data.object;

  try {
    switch (event.type) {
      // ── One-time payment (Basic plan) ──
      case "checkout.session.completed": {
        const { email, plan } = session.metadata || {};
        if (!email || !plan) break;

        if (plan === "basic") {
          const expiry = new Date();
          expiry.setDate(expiry.getDate() + 7);
          await db.collection("users").doc(email).update({
            plan: "basic",
            planExpiry: expiry.toISOString(),
            creditsUsed: 0,
          });
        }
        break;
      }

      // ── Subscription activated (Pro monthly/yearly) ──
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object;
        const customerId = sub.customer;

        // Find user by Stripe customer ID
        const snap = await db.collection("users")
          .where("stripeCustomerId", "==", customerId).limit(1).get();
        if (snap.empty) break;

        const userDoc = snap.docs[0];
        const priceId = sub.items.data[0]?.price?.id;
        let plan = "free";
        if (priceId === STRIPE_PRICES.pro_monthly) plan = "pro_monthly";
        if (priceId === STRIPE_PRICES.pro_yearly)  plan = "pro_yearly";

        await userDoc.ref.update({
          plan,
          stripeSubscriptionId: sub.id,
          planExpiry: null,
          creditsUsed: 0,
        });
        break;
      }

      // ── Subscription cancelled ──
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const snap = await db.collection("users")
          .where("stripeCustomerId", "==", sub.customer).limit(1).get();
        if (!snap.empty) {
          await snap.docs[0].ref.update({
            plan: "free",
            stripeSubscriptionId: null,
          });
        }
        break;
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error("Webhook handler error", err);
    return res.status(500).json({ error: "handler error" });
  }
});

// ─── 5. GET USER STATUS ──────────────────────────────────────────────────────
// Called by the extension to show the user their current plan in the UI.
exports.getUserStatus = onRequest({ cors: true, invoker: "public" }, async (req, res) => {
  const email = req.body?.email || req.query.email;
  if (!email) return res.status(400).json({ error: "email required" });

  try {
    let user = await getOrCreateUser(email);
    user = await maybeResetCredits(email, user);
    const plan = PLANS[user.plan] || PLANS.free;

    return res.json({
      plan: user.plan,
      planLabel: plan.label,
      creditsUsed: user.creditsUsed,
      creditsTotal: plan.credits,
      creditsLeft: Math.max(0, plan.credits - user.creditsUsed),
      creditsReset: user.creditsReset,
      planExpiry: user.planExpiry,
    });
  } catch (err) {
    console.error("getUserStatus error", err);
    return res.status(500).json({ error: "server error" });
  }
});
