// One-time script: set founder account to pro_yearly
// Run from this folder: node set-founder-plan.js

const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const EMAIL = "ayoub.ouddaf@gmail.com";

async function main() {
  const ref = db.collection("users").doc(EMAIL);
  const snap = await ref.get();

  if (!snap.exists) {
    // Create the doc if it doesn't exist yet
    await ref.set({
      email: EMAIL,
      plan: "pro_yearly",
      creditsUsed: 0,
      creditsReset: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString(),
      planExpiry: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      createdAt: new Date().toISOString(),
    });
    console.log("✅ Created user doc with pro_yearly plan.");
  } else {
    await ref.update({
      plan: "pro_yearly",
      planExpiry: null,
      creditsUsed: 0,
    });
    console.log("✅ Updated", EMAIL, "→ pro_yearly (unlimited credits).");
  }

  process.exit(0);
}

main().catch(err => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
