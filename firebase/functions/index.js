/**
 * Mendez Community — Firebase Cloud Functions
 * Features:
 *   1. S2S Postback endpoint  (Monetag / Adsterra → credits verifiedRewardPoints)
 *   2. Read-balance endpoint  (front-end reads wallet balance)
 *   3. requestWithdrawal      (user submits payout request)
 *   4. adminApproveWithdrawal (admin approves → optional PayPal Payouts API)
 *
 * CONFIG PLACEHOLDERS — fill these before `firebase deploy`:
 *   POSTBACK_SECRET  → firebase functions:secrets:set POSTBACK_SECRET
 *   ADMIN_SECRET     → firebase functions:secrets:set ADMIN_SECRET
 *   PAYPAL_CLIENT_ID → firebase functions:secrets:set PAYPAL_CLIENT_ID   (optional)
 *   PAYPAL_SECRET    → firebase functions:secrets:set PAYPAL_SECRET       (optional)
 *   PAYPAL_MODE      → "sandbox" or "live"  (set in functions config or env)
 */

const functions = require("firebase-functions");
const admin     = require("firebase-admin");
const https     = require("https");

admin.initializeApp();
const db = admin.firestore();

// ─── helpers ────────────────────────────────────────────────────────────────

/** Minimum withdrawal amount in USD (configurable). */
const MIN_WITHDRAWAL_USD = 1.00;

/** Points-to-USD conversion rate (1 point = $0.001 by default). */
const POINTS_TO_USD = 0.001;

/** New-user eligibility window: user can request after this many days of joining. */
const NEW_USER_ELIGIBLE_AFTER_DAYS = 2;

/** Regular-user salary cycles (days). */
const SALARY_CYCLES = [15, 25];

function ok(res, data)  { res.status(200).json({ success: true,  ...data }); }
function err(res, code, msg) { res.status(code).json({ success: false, error: msg }); }

// ─── 1. S2S POSTBACK ENDPOINT ───────────────────────────────────────────────
/**
 * Monetag postback URL:
 *   https://<region>-<project>.cloudfunctions.net/postback
 *   ?secret=YOUR_SECRET&userId={ymid}&payout={payout}&txid={clickid}&status={status}
 *
 * Adsterra postback URL:
 *   https://<region>-<project>.cloudfunctions.net/postback
 *   ?secret=YOUR_SECRET&userId={subid}&payout={revenue}&txid={click_id}&status=1
 */
exports.postback = functions.https.onRequest(async (req, res) => {
  try {
    const secret = process.env.POSTBACK_SECRET ||
                   (functions.config().postback && functions.config().postback.secret);
    const { secret: reqSecret, userId, payout, txid, status } = req.query;

    // 1. Validate shared secret
    if (!secret || reqSecret !== secret) return err(res, 403, "Invalid secret");

    // 2. Require userId + txid
    if (!userId || !txid) return err(res, 400, "Missing userId or txid");

    // 3. Only credit on verified/confirmed status (Monetag: status=2; Adsterra: status=1)
    const statusNum = parseInt(status, 10);
    if (![1, 2].includes(statusNum)) {
      return ok(res, { message: "Non-confirmed status — no credit", status });
    }

    // 4. Idempotency — ignore duplicate txid
    const txRef = db.collection("processedTx").doc(txid);
    const txSnap = await txRef.get();
    if (txSnap.exists) return ok(res, { message: "Duplicate txid — already processed" });

    // 5. Atomic credit
    const payoutUSD   = parseFloat(payout) || 0;
    const pointsToAdd = Math.round(payoutUSD / POINTS_TO_USD);
    const userRef     = db.collection("wallets").doc(userId);

    await db.runTransaction(async (t) => {
      const userSnap = await t.get(userRef);
      const current  = userSnap.exists ? (userSnap.data().verifiedRewardPoints || 0) : 0;

      // Ensure user doc exists with joinedAt for tier logic
      if (!userSnap.exists) {
        t.set(userRef, {
          userId,
          verifiedRewardPoints: pointsToAdd,
          pendingClicks: 0,
          tier: "new",
          joinedAt: admin.firestore.FieldValue.serverTimestamp(),
          salaryCycle: 15,
          lastPayoutAt: null,
          firstPayoutCompletedAt: null,
          lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        t.update(userRef, {
          verifiedRewardPoints: current + pointsToAdd,
          lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // Mark txid as processed
      t.set(txRef, { userId, payout: payoutUSD, processedAt: admin.firestore.FieldValue.serverTimestamp() });
    });

    return ok(res, { message: "Credited", pointsAdded: pointsToAdd });
  } catch (e) {
    console.error("postback error", e);
    return err(res, 500, "Internal error");
  }
});

// ─── 2. READ-BALANCE ENDPOINT ────────────────────────────────────────────────
exports.balance = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  const { userId } = req.query;
  if (!userId) return err(res, 400, "Missing userId");

  try {
    const snap = await db.collection("wallets").doc(userId).get();
    if (!snap.exists) return ok(res, { verifiedRewardPoints: 0, tier: "new", salaryCycle: 15 });
    const d = snap.data();
    return ok(res, {
      verifiedRewardPoints: d.verifiedRewardPoints || 0,
      tier:                 d.tier || "new",
      salaryCycle:          d.salaryCycle || 15,
      joinedAt:             d.joinedAt ? d.joinedAt.toDate().toISOString() : null,
      lastPayoutAt:         d.lastPayoutAt ? d.lastPayoutAt.toDate().toISOString() : null,
      firstPayoutCompletedAt: d.firstPayoutCompletedAt
                              ? d.firstPayoutCompletedAt.toDate().toISOString() : null,
    });
  } catch (e) {
    console.error("balance error", e);
    return err(res, 500, "Internal error");
  }
});

// ─── 3. REQUEST WITHDRAWAL ───────────────────────────────────────────────────
/**
 * POST /requestWithdrawal
 * Body: { userId, paypalEmail, amountUSD }
 *
 * Rules:
 *  - User must have sufficient verifiedRewardPoints (amountUSD / POINTS_TO_USD)
 *  - New users: eligible after NEW_USER_ELIGIBLE_AFTER_DAYS days from joinedAt
 *  - Regular users: eligible every salaryCycle days from lastPayoutAt
 *  - Minimum withdrawal: MIN_WITHDRAWAL_USD
 */
exports.requestWithdrawal = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.set("Access-Control-Allow-Methods","POST"); return res.status(204).send(""); }
  if (req.method !== "POST") return err(res, 405, "POST only");

  const { userId, paypalEmail, amountUSD } = req.body || {};

  // Basic validation
  if (!userId || !paypalEmail || !amountUSD) return err(res, 400, "Missing userId, paypalEmail, or amountUSD");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(paypalEmail)) return err(res, 400, "Invalid PayPal email");
  const amount = parseFloat(amountUSD);
  if (isNaN(amount) || amount < MIN_WITHDRAWAL_USD)
    return err(res, 400, `Minimum withdrawal is $${MIN_WITHDRAWAL_USD}`);

  try {
    const userRef  = db.collection("wallets").doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return err(res, 404, "User not found — no verified rewards yet");

    const d = userSnap.data();
    const requiredPoints = Math.ceil(amount / POINTS_TO_USD);

    // Check sufficient balance
    if ((d.verifiedRewardPoints || 0) < requiredPoints)
      return err(res, 400, `Insufficient balance. You have ${d.verifiedRewardPoints || 0} points (~$${((d.verifiedRewardPoints||0)*POINTS_TO_USD).toFixed(2)})`);

    // Check eligibility by tier
    const now = new Date();
    const tier = d.tier || "new";

    if (tier === "new") {
      if (!d.joinedAt) return err(res, 400, "joinedAt missing — contact admin");
      const joinedAt = d.joinedAt.toDate();
      const eligibleAt = new Date(joinedAt.getTime() + NEW_USER_ELIGIBLE_AFTER_DAYS * 86400000);
      if (now < eligibleAt)
        return err(res, 400, `New users can request after ${NEW_USER_ELIGIBLE_AFTER_DAYS} days. Eligible from: ${eligibleAt.toISOString()}`);
    } else {
      // Regular user — check salary cycle
      const cycle = d.salaryCycle || 15;
      if (!SALARY_CYCLES.includes(cycle)) return err(res, 400, "Invalid salary cycle");
      if (d.lastPayoutAt) {
        const lastPayout = d.lastPayoutAt.toDate();
        const nextEligible = new Date(lastPayout.getTime() + cycle * 86400000);
        if (now < nextEligible)
          return err(res, 400, `Next withdrawal eligible on: ${nextEligible.toISOString()}`);
      }
    }

    // Atomic: deduct points + create withdrawal request
    const withdrawalRef = db.collection("withdrawalRequests").doc();
    await db.runTransaction(async (t) => {
      const freshSnap = await t.get(userRef);
      const freshPoints = freshSnap.data().verifiedRewardPoints || 0;
      if (freshPoints < requiredPoints) throw new Error("Insufficient balance (race condition)");

      t.update(userRef, {
        verifiedRewardPoints: freshPoints - requiredPoints,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        // Save PayPal email to user doc
        paypalEmail,
      });

      t.set(withdrawalRef, {
        withdrawalId: withdrawalRef.id,
        userId,
        paypalEmail,
        amountUSD: amount,
        pointsDeducted: requiredPoints,
        tier,
        status: "pending",
        requestedAt: admin.firestore.FieldValue.serverTimestamp(),
        approvedAt: null,
        paypalPayoutId: null,
        adminNote: "",
      });
    });

    return ok(res, {
      message: "Withdrawal request submitted. Admin will review and process.",
      withdrawalId: withdrawalRef.id,
      amountUSD: amount,
      pointsDeducted: requiredPoints,
    });
  } catch (e) {
    console.error("requestWithdrawal error", e);
    return err(res, 500, e.message || "Internal error");
  }
});

// ─── 4. ADMIN APPROVE WITHDRAWAL ────────────────────────────────────────────
/**
 * POST /adminApproveWithdrawal
 * Body: { adminSecret, withdrawalId, action: "approve"|"reject", adminNote? }
 *
 * If PayPal credentials are configured, triggers PayPal Payouts API automatically.
 * Otherwise marks as "approved_manual" for admin to send manually.
 *
 * CONFIG PLACEHOLDERS (set via Firebase secrets before deploy):
 *   ADMIN_SECRET     — protects this endpoint
 *   PAYPAL_CLIENT_ID — PayPal Business app Client ID
 *   PAYPAL_SECRET    — PayPal Business app Secret
 *   PAYPAL_MODE      — "sandbox" or "live"
 */
exports.adminApproveWithdrawal = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") return err(res, 405, "POST only");

  const adminSecret = process.env.ADMIN_SECRET ||
                      (functions.config().admin && functions.config().admin.secret);
  const { adminSecret: reqSecret, withdrawalId, action, adminNote } = req.body || {};

  if (!adminSecret || reqSecret !== adminSecret) return err(res, 403, "Invalid admin secret");
  if (!withdrawalId || !["approve","reject"].includes(action)) return err(res, 400, "Missing withdrawalId or invalid action");

  try {
    const wRef  = db.collection("withdrawalRequests").doc(withdrawalId);
    const wSnap = await wRef.get();
    if (!wSnap.exists) return err(res, 404, "Withdrawal request not found");

    const w = wSnap.data();
    if (w.status !== "pending") return err(res, 400, `Request already ${w.status}`);

    if (action === "reject") {
      // Refund points
      const userRef = db.collection("wallets").doc(w.userId);
      await db.runTransaction(async (t) => {
        const uSnap = await t.get(userRef);
        const pts   = uSnap.exists ? (uSnap.data().verifiedRewardPoints || 0) : 0;
        t.update(userRef, { verifiedRewardPoints: pts + w.pointsDeducted, lastUpdated: admin.firestore.FieldValue.serverTimestamp() });
        t.update(wRef, { status: "rejected", adminNote: adminNote || "", approvedAt: admin.firestore.FieldValue.serverTimestamp() });
      });
      return ok(res, { message: "Rejected and points refunded", withdrawalId });
    }

    // ── APPROVE ──
    // Try PayPal Payouts API if credentials are configured
    const ppClientId = process.env.PAYPAL_CLIENT_ID ||
                       (functions.config().paypal && functions.config().paypal.client_id);
    const ppSecret   = process.env.PAYPAL_SECRET ||
                       (functions.config().paypal && functions.config().paypal.secret);
    const ppMode     = process.env.PAYPAL_MODE ||
                       (functions.config().paypal && functions.config().paypal.mode) || "sandbox";

    if (ppClientId && ppSecret) {
      // ── PayPal Payouts API ──
      try {
        const accessToken = await getPayPalAccessToken(ppClientId, ppSecret, ppMode);
        const payoutResult = await sendPayPalPayout(accessToken, ppMode, {
          email:  w.paypalEmail,
          amount: w.amountUSD,
          note:   `Mendez Community withdrawal #${withdrawalId}`,
          sender_item_id: withdrawalId,
        });
        await wRef.update({
          status: "paid",
          paypalPayoutId: payoutResult.batch_header.payout_batch_id,
          adminNote: adminNote || "Auto-paid via PayPal Payouts API",
          approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        // Promote new user to regular after first payout
        await promoteUserIfNew(w.userId);
        return ok(res, { message: "Approved and paid via PayPal", paypalBatchId: payoutResult.batch_header.payout_batch_id });
      } catch (ppErr) {
        console.error("PayPal payout error", ppErr);
        // Fall through to manual
        await wRef.update({
          status: "approved_manual",
          adminNote: `PayPal API error: ${ppErr.message}. Send manually to ${w.paypalEmail}`,
          approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        await promoteUserIfNew(w.userId);
        return ok(res, { message: "Approved (PayPal API failed — send manually)", withdrawalId, paypalEmail: w.paypalEmail, amountUSD: w.amountUSD });
      }
    } else {
      // No PayPal credentials — mark for manual send
      await wRef.update({
        status: "approved_manual",
        adminNote: adminNote || "Approved — send manually via PayPal",
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await promoteUserIfNew(w.userId);
      return ok(res, { message: "Approved (manual PayPal send required)", withdrawalId, paypalEmail: w.paypalEmail, amountUSD: w.amountUSD });
    }
  } catch (e) {
    console.error("adminApproveWithdrawal error", e);
    return err(res, 500, e.message || "Internal error");
  }
});

// ─── 5. UPDATE SALARY CYCLE (user preference) ───────────────────────────────
exports.setSalaryCycle = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.set("Access-Control-Allow-Methods","POST"); return res.status(204).send(""); }
  if (req.method !== "POST") return err(res, 405, "POST only");

  const { userId, cycle } = req.body || {};
  if (!userId) return err(res, 400, "Missing userId");
  const cycleNum = parseInt(cycle, 10);
  if (!SALARY_CYCLES.includes(cycleNum)) return err(res, 400, `cycle must be one of: ${SALARY_CYCLES.join(", ")}`);

  try {
    await db.collection("wallets").doc(userId).set(
      { salaryCycle: cycleNum, lastUpdated: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    return ok(res, { message: `Salary cycle set to ${cycleNum} days`, cycle: cycleNum });
  } catch (e) {
    return err(res, 500, e.message);
  }
});

// ─── 6. GET WITHDRAWAL HISTORY (client-safe read) ───────────────────────────
exports.withdrawalHistory = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  const { userId } = req.query;
  if (!userId) return err(res, 400, "Missing userId");

  try {
    const snap = await db.collection("withdrawalRequests")
      .where("userId", "==", userId)
      .orderBy("requestedAt", "desc")
      .limit(20)
      .get();

    const requests = snap.docs.map(d => {
      const data = d.data();
      return {
        withdrawalId: d.id,
        amountUSD:    data.amountUSD,
        status:       data.status,
        requestedAt:  data.requestedAt ? data.requestedAt.toDate().toISOString() : null,
        approvedAt:   data.approvedAt  ? data.approvedAt.toDate().toISOString()  : null,
        // Do NOT expose paypalEmail in history for privacy
      };
    });
    return ok(res, { requests });
  } catch (e) {
    console.error("withdrawalHistory error", e);
    return err(res, 500, e.message);
  }
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function promoteUserIfNew(userId) {
  const userRef  = db.collection("wallets").doc(userId);
  const userSnap = await userRef.get();
  if (!userSnap.exists) return;
  const d = userSnap.data();
  if (d.tier === "new") {
    await userRef.update({
      tier: "regular",
      firstPayoutCompletedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastPayoutAt: admin.firestore.FieldValue.serverTimestamp(),
      lastUpdated:  admin.firestore.FieldValue.serverTimestamp(),
    });
  } else {
    await userRef.update({
      lastPayoutAt: admin.firestore.FieldValue.serverTimestamp(),
      lastUpdated:  admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

function getPayPalAccessToken(clientId, secret, mode) {
  return new Promise((resolve, reject) => {
    const host = mode === "live" ? "api-m.paypal.com" : "api-m.sandbox.paypal.com";
    const auth = Buffer.from(`${clientId}:${secret}`).toString("base64");
    const body = "grant_type=client_credentials";
    const options = {
      hostname: host, path: "/v1/oauth2/token", method: "POST",
      headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": body.length },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { const j = JSON.parse(data); j.access_token ? resolve(j.access_token) : reject(new Error(j.error_description || "PayPal auth failed")); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function sendPayPalPayout(accessToken, mode, { email, amount, note, sender_item_id }) {
  return new Promise((resolve, reject) => {
    const host = mode === "live" ? "api-m.paypal.com" : "api-m.sandbox.paypal.com";
    const payload = JSON.stringify({
      sender_batch_header: { sender_batch_id: sender_item_id, email_subject: "Mendez Community Payout", email_message: note },
      items: [{ recipient_type: "EMAIL", amount: { value: amount.toFixed(2), currency: "USD" }, receiver: email, note, sender_item_id }],
    });
    const options = {
      hostname: host, path: "/v1/payments/payouts", method: "POST",
      headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { const j = JSON.parse(data); res.statusCode === 201 ? resolve(j) : reject(new Error(j.message || `PayPal status ${res.statusCode}`)); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
