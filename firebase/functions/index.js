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

// ─── 7. ADMIN LIST WITHDRAWALS ────────────────────────────────────────────────
/**
 * adminListWithdrawals — protected by ADMIN_SECRET
 * GET ?secret=ADMIN_SECRET&status=pending|approved|rejected|all&limit=50
 * Returns withdrawal requests sorted by requestedAt desc, plus summary stats.
 */
exports.adminListWithdrawals = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).send("");
  try {
    const adminSecret = process.env.ADMIN_SECRET ||
                        (functions.config().admin && functions.config().admin.secret);
    const { secret, status = "pending", limit = "50" } = req.query;
    if (!adminSecret || secret !== adminSecret) return err(res, 403, "Unauthorized");

    let query = db.collection("withdrawalRequests").orderBy("requestedAt", "desc");
    if (status !== "all") query = query.where("status", "==", status);
    query = query.limit(Math.min(parseInt(limit, 10) || 50, 200));

    const snap = await query.get();
    const requests = snap.docs.map(doc => {
      const d = doc.data();
      return {
        id:           doc.id,
        userId:       d.userId,
        paypalEmail:  d.paypalEmail,
        amount:       d.amount,
        tier:         d.tier,
        salaryCycle:  d.salaryCycle,
        status:       d.status,
        rejectReason: d.rejectReason || null,
        requestedAt:  d.requestedAt ? d.requestedAt.toDate().toISOString() : null,
        approvedAt:   d.approvedAt  ? d.approvedAt.toDate().toISOString()  : null,
        rejectedAt:   d.rejectedAt  ? d.rejectedAt.toDate().toISOString()  : null,
        paypalBatchId: d.paypalBatchId || null,
      };
    });

    const todayStart = admin.firestore.Timestamp.fromDate(
      new Date(new Date().setHours(0, 0, 0, 0))
    );
    const [pendingSnap, approvedTodaySnap, rejectedTodaySnap] = await Promise.all([
      db.collection("withdrawalRequests").where("status", "==", "pending").count().get(),
      db.collection("withdrawalRequests")
        .where("status", "==", "approved")
        .where("approvedAt", ">=", todayStart).count().get(),
      db.collection("withdrawalRequests")
        .where("status", "==", "rejected")
        .where("rejectedAt", ">=", todayStart).count().get(),
    ]);

    return ok(res, {
      requests,
      stats: {
        totalPending:  pendingSnap.data().count,
        approvedToday: approvedTodaySnap.data().count,
        rejectedToday: rejectedTodaySnap.data().count,
      },
    });
  } catch (e) {
    console.error("adminListWithdrawals error", e);
    return err(res, 500, e.message);
  }
});

// ─── 8. ADMIN REJECT WITHDRAWAL ──────────────────────────────────────────────
/**
 * adminRejectWithdrawal — protected by ADMIN_SECRET
 * POST { secret, withdrawalRequestId, rejectReason }
 * Sets status to "rejected", refunds verifiedRewardPoints atomically.
 */
exports.adminRejectWithdrawal = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return err(res, 405, "POST required");
  try {
    const adminSecret = process.env.ADMIN_SECRET ||
                        (functions.config().admin && functions.config().admin.secret);
    const { secret, withdrawalRequestId, rejectReason = "Rejected by admin" } = req.body;
    if (!adminSecret || secret !== adminSecret) return err(res, 403, "Unauthorized");
    if (!withdrawalRequestId) return err(res, 400, "withdrawalRequestId required");

    const reqRef  = db.collection("withdrawalRequests").doc(withdrawalRequestId);
    const reqSnap = await reqRef.get();
    if (!reqSnap.exists) return err(res, 404, "Withdrawal request not found");

    const data = reqSnap.data();
    if (data.status !== "pending") return err(res, 409, `Request is already ${data.status}`);

    const userRef        = db.collection("wallets").doc(data.userId);
    const pointsToRefund = Math.round(data.amount / POINTS_TO_USD);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error("User wallet not found");
      const currentPoints = userSnap.data().verifiedRewardPoints || 0;
      tx.update(reqRef, {
        status:      "rejected",
        rejectReason,
        rejectedAt:  admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.update(userRef, {
        verifiedRewardPoints: currentPoints + pointsToRefund,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return ok(res, {
      message:        "Withdrawal rejected and points refunded",
      refundedPoints: pointsToRefund,
      userId:         data.userId,
    });
  } catch (e) {
    console.error("adminRejectWithdrawal error", e);
    return err(res, 500, e.message);
  }
});

// ─── 9. ADMIN AUTH — Firebase Hosting server-side authentication ──────────────
/**
 * adminAuth — Cloud Function that acts as server-side auth middleware for /admin
 *
 * How it works:
 *   GET  /admin  (no valid __session cookie) → serve login HTML form
 *   POST /admin  (form submit)               → validate ADMIN_SECRET → set __session cookie → redirect
 *   GET  /admin  (valid __session cookie)    → serve full admin panel HTML
 *
 * Security features:
 *   - __session cookie: HttpOnly, Secure, SameSite=Strict, 30-min expiry
 *     (Firebase Hosting CDN only forwards the __session cookie — all others stripped)
 *   - Rate limiting: 5 failed attempts per IP → 15-min lockout (Firestore-backed)
 *   - Session tokens: crypto.randomBytes(32) stored in Firestore adminSessions collection
 *   - Constant-time secret comparison via crypto.timingSafeEqual (prevents timing attacks)
 *   - ADMIN_SECRET never sent to client
 *
 * firebase.json rewrite:
 *   { "source": "/admin", "function": "adminAuth" }
 *
 * Access URL after deploy: https://YOUR-PROJECT.web.app/admin
 */
const crypto = require("crypto");

const ADMIN_RATE_LIMIT_ATTEMPTS = 5;
const ADMIN_LOCKOUT_MS          = 15 * 60 * 1000; // 15 minutes
const SESSION_EXPIRY_MS         = 30 * 60 * 1000; // 30 minutes

function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function isRateLimited(ip) {
  const docRef = db.collection("adminRateLimit").doc(ip.replace(/[:.]/g, "_"));
  const snap   = await docRef.get();
  if (!snap.exists) return false;
  const { lockedUntil } = snap.data();
  return !!(lockedUntil && lockedUntil.toMillis() > Date.now());
}

async function recordFailedAttempt(ip) {
  const docRef = db.collection("adminRateLimit").doc(ip.replace(/[:.]/g, "_"));
  const snap   = await docRef.get();
  const now    = Date.now();
  let attempts = 1;
  if (snap.exists) {
    const d = snap.data();
    if (d.lockedUntil && d.lockedUntil.toMillis() < now) { attempts = 1; }
    else { attempts = (d.attempts || 0) + 1; }
  }
  const lockedUntil = attempts >= ADMIN_RATE_LIMIT_ATTEMPTS
    ? admin.firestore.Timestamp.fromMillis(now + ADMIN_LOCKOUT_MS)
    : null;
  await docRef.set({
    attempts,
    lockedUntil,
    lastAttempt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return attempts;
}

async function clearRateLimit(ip) {
  await db.collection("adminRateLimit").doc(ip.replace(/[:.]/g, "_")).delete().catch(() => {});
}

async function validateSession(token) {
  if (!token) return false;
  const docRef = db.collection("adminSessions").doc(token);
  const snap   = await docRef.get();
  if (!snap.exists) return false;
  const { expiresAt } = snap.data();
  if (expiresAt && expiresAt.toMillis() < Date.now()) {
    await docRef.delete().catch(() => {});
    return false;
  }
  // Refresh expiry on valid access (sliding window)
  await docRef.update({
    expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + SESSION_EXPIRY_MS),
  });
  return true;
}

async function createSession() {
  const token = generateSessionToken();
  await db.collection("adminSessions").doc(token).set({
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + SESSION_EXPIRY_MS),
  });
  return token;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(";").forEach(part => {
    const [k, ...v] = part.trim().split("=");
    if (k) cookies[k.trim()] = decodeURIComponent(v.join("=").trim());
  });
  return cookies;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", chunk => { body += chunk.toString(); });
    req.on("end", () => {
      const params = {};
      body.split("&").forEach(pair => {
        const [k, v] = pair.split("=");
        if (k) params[decodeURIComponent(k)] = decodeURIComponent((v || "").replace(/\+/g, " "));
      });
      resolve(params);
    });
  });
}

function loginPageHTML(errorMsg, locked) {
  const errorBlock  = errorMsg ? `<div class="error">${errorMsg}</div>` : "";
  const lockedBlock = `<div class="locked">Too many failed attempts. Please wait 15 minutes before trying again.</div>`;
  const formBlock   = `<form method="POST" action="/admin">
    <label for="s">Admin Secret</label>
    <input type="password" id="s" name="secret" placeholder="Enter admin secret" required autocomplete="current-password">
    ${errorBlock}
    <button type="submit">Sign In</button>
  </form>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>Admin Login — Mendez Community</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0a;color:#e0e0e0;font-family:'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#111;border:1px solid #222;border-radius:12px;padding:40px;width:100%;max-width:400px;box-shadow:0 8px 32px rgba(0,0,0,.6)}
.logo{text-align:center;margin-bottom:28px}
.logo h1{font-size:1.4rem;color:#c0a060;letter-spacing:2px;text-transform:uppercase}
.logo p{font-size:.8rem;color:#666;margin-top:4px}
label{display:block;font-size:.8rem;color:#888;margin-bottom:6px;margin-top:18px}
input[type=password]{width:100%;padding:12px 14px;background:#1a1a1a;border:1px solid #333;border-radius:8px;color:#e0e0e0;font-size:1rem;outline:none}
button{width:100%;margin-top:22px;padding:13px;background:#c0a060;color:#000;border:none;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer}
.error{background:#2a1010;border:1px solid #5a2020;border-radius:6px;padding:10px 14px;margin-top:16px;font-size:.85rem;color:#e07070}
.locked{background:#1a1a2a;border:1px solid #3a3a6a;border-radius:6px;padding:10px 14px;margin-top:16px;font-size:.85rem;color:#8080e0}
.footer{text-align:center;margin-top:24px;font-size:.75rem;color:#444}
</style>
</head>
<body>
<div class="card">
  <div class="logo"><h1>MENDEZ ADMIN</h1><p>Withdrawal Management Portal</p></div>
  ${locked ? lockedBlock : formBlock}
  <div class="footer">Mendez Community · Secure Admin Access</div>
</div>
</body>
</html>`;
}

exports.adminAuth = functions.https.onRequest(async (req, res) => {
  const ip = ((req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.ip || "unknown";
  try {
    // ── GET: check session ────────────────────────────────────────────────────
    if (req.method === "GET") {
      const cookies = parseCookies(req.headers.cookie);
      const valid   = await validateSession(cookies["__session"]);
      res.set("Cache-Control", "private, no-cache, no-store");
      res.set("X-Robots-Tag", "noindex, nofollow");
      if (valid) {
        // Authenticated — serve full admin panel HTML (no client-side secret needed)
        return res.status(200).send(getAdminPanelHTML());
      }
      const locked = await isRateLimited(ip);
      return res.status(locked ? 429 : 200).send(loginPageHTML("", locked));
    }

    // ── POST: process login ───────────────────────────────────────────────────
    if (req.method === "POST") {
      const locked = await isRateLimited(ip);
      if (locked) return res.status(429).send(loginPageHTML("", true));

      const body        = await parseBody(req);
      const adminSecret = process.env.ADMIN_SECRET ||
                          (functions.config().admin && functions.config().admin.secret);

      if (!adminSecret) {
        return res.status(500).send(loginPageHTML("Server config error: ADMIN_SECRET not set.", false));
      }

      // Constant-time comparison to prevent timing attacks
      const secretBuf  = Buffer.from(body.secret || "");
      const correctBuf = Buffer.from(adminSecret);
      const match = secretBuf.length === correctBuf.length &&
                    crypto.timingSafeEqual(secretBuf, correctBuf);

      if (!match) {
        const attempts  = await recordFailedAttempt(ip);
        const remaining = ADMIN_RATE_LIMIT_ATTEMPTS - attempts;
        const msg = remaining <= 0
          ? "Too many failed attempts. Locked for 15 minutes."
          : `Incorrect secret. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`;
        return res.status(401).send(loginPageHTML(msg, remaining <= 0));
      }

      // Correct — create session, set HttpOnly cookie, redirect
      await clearRateLimit(ip);
      const token = await createSession();
      res.set("Set-Cookie",
        `__session=${token}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_EXPIRY_MS / 1000}; Path=/admin`
      );
      res.set("Cache-Control", "no-store");
      return res.redirect(302, "/admin");
    }

    return res.status(405).send("Method Not Allowed");
  } catch (e) {
    console.error("adminAuth error", e);
    return res.status(500).send(loginPageHTML("Internal server error. Please try again.", false));
  }
});

/**
 * getAdminPanelHTML — returns the full admin panel HTML.
 * Served ONLY after successful server-side authentication via adminAuth.
 * CONFIG PLACEHOLDERS: replace YOUR-PROJECT with your Firebase project ID.
 */
function getAdminPanelHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<title>Admin Panel — Mendez Community</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0a;color:#e0e0e0;font-family:'Segoe UI',sans-serif;min-height:100vh}
header{background:#111;border-bottom:1px solid #222;padding:16px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
header h1{font-size:1.1rem;color:#c0a060;letter-spacing:2px;text-transform:uppercase}
.logout-btn{background:transparent;border:1px solid #444;color:#888;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:.8rem}
.session-timer{font-size:.75rem;color:#555;margin-right:12px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;padding:24px}
.stat-card{background:#111;border:1px solid #222;border-radius:10px;padding:20px;text-align:center}
.stat-card .num{font-size:2rem;font-weight:700;color:#c0a060}
.stat-card .lbl{font-size:.75rem;color:#666;margin-top:4px;text-transform:uppercase;letter-spacing:1px}
.tabs{display:flex;border-bottom:1px solid #222;padding:0 24px;background:#0d0d0d;overflow-x:auto}
.tab{padding:12px 20px;cursor:pointer;font-size:.85rem;color:#666;border-bottom:2px solid transparent;white-space:nowrap}
.tab.active{color:#c0a060;border-bottom-color:#c0a060}
.tab-content{display:none;padding:24px;overflow-x:auto}
.tab-content.active{display:block}
table{width:100%;border-collapse:collapse;font-size:.85rem;min-width:600px}
th{background:#111;color:#888;padding:10px 12px;text-align:left;font-weight:600;text-transform:uppercase;font-size:.75rem;border-bottom:1px solid #222}
td{padding:10px 12px;border-bottom:1px solid #1a1a1a;vertical-align:middle}
tr:hover td{background:#111}
.badge{display:inline-block;padding:3px 8px;border-radius:4px;font-size:.75rem;font-weight:600;text-transform:uppercase}
.badge-new{background:#1a2a1a;color:#60c060}.badge-regular{background:#1a1a2a;color:#6080e0}
.badge-pending{background:#2a2a1a;color:#c0c060}.badge-approved{background:#1a2a1a;color:#60c060}
.badge-rejected{background:#2a1a1a;color:#e06060}.badge-paid{background:#1a2a2a;color:#60c0c0}
.btn{padding:6px 14px;border:none;border-radius:6px;cursor:pointer;font-size:.8rem;font-weight:600}
.btn-approve{background:#1a3a1a;color:#60c060;border:1px solid #2a5a2a}
.btn-reject{background:#3a1a1a;color:#e06060;border:1px solid #5a2a2a;margin-left:6px}
.empty{text-align:center;padding:40px;color:#444;font-size:.9rem}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:1000;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal{background:#111;border:1px solid #333;border-radius:12px;padding:28px;width:100%;max-width:440px;margin:16px}
.modal h3{color:#c0a060;margin-bottom:16px}
.modal textarea{width:100%;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#e0e0e0;padding:10px;font-size:.9rem;resize:vertical;min-height:80px;outline:none}
.modal-btns{display:flex;gap:10px;margin-top:16px;justify-content:flex-end}
.toast{position:fixed;bottom:24px;right:24px;background:#1a2a1a;border:1px solid #2a5a2a;color:#60c060;padding:12px 20px;border-radius:8px;font-size:.9rem;z-index:2000;opacity:0;transition:opacity .3s;pointer-events:none}
.toast.show{opacity:1}.toast.error{background:#2a1a1a;border-color:#5a2a2a;color:#e06060}
.loading{text-align:center;padding:40px;color:#555}
.demo-banner{background:#1a1a2a;border:1px solid #3a3a6a;border-radius:6px;padding:10px 16px;margin:16px 24px 0;font-size:.8rem;color:#8080e0}
</style>
</head>
<body>
<header>
  <h1>MENDEZ ADMIN — Withdrawal Requests</h1>
  <div style="display:flex;align-items:center">
    <span class="session-timer" id="sessionTimer">Session: 30:00</span>
    <button class="logout-btn" onclick="logout()">Logout</button>
  </div>
</header>

<div class="stats">
  <div class="stat-card"><div class="num" id="statPending">—</div><div class="lbl">Pending</div></div>
  <div class="stat-card"><div class="num" id="statApproved">—</div><div class="lbl">Approved Today</div></div>
  <div class="stat-card"><div class="num" id="statRejected">—</div><div class="lbl">Rejected Today</div></div>
</div>

<div class="tabs">
  <div class="tab active" onclick="switchTab('pending')">Pending</div>
  <div class="tab" onclick="switchTab('approved')">Approved</div>
  <div class="tab" onclick="switchTab('rejected')">Rejected</div>
  <div class="tab" onclick="switchTab('all')">All</div>
</div>

<div id="tab-pending" class="tab-content active">
  <div class="loading" id="loading-pending">Loading...</div>
  <table id="table-pending" style="display:none"><thead><tr>
    <th>User ID</th><th>PayPal Email</th><th>Amount</th><th>Tier</th><th>Cycle</th><th>Requested</th><th>Actions</th>
  </tr></thead><tbody id="tbody-pending"></tbody></table>
  <div class="empty" id="empty-pending" style="display:none">No pending requests</div>
</div>
<div id="tab-approved" class="tab-content">
  <div class="loading" id="loading-approved">Loading...</div>
  <table id="table-approved" style="display:none"><thead><tr>
    <th>User ID</th><th>Amount</th><th>Tier</th><th>Requested</th><th>Approved</th><th>Status</th>
  </tr></thead><tbody id="tbody-approved"></tbody></table>
  <div class="empty" id="empty-approved" style="display:none">No approved requests yet.</div>
</div>
<div id="tab-rejected" class="tab-content">
  <div class="loading" id="loading-rejected">Loading...</div>
  <table id="table-rejected" style="display:none"><thead><tr>
    <th>User ID</th><th>Amount</th><th>Tier</th><th>Requested</th><th>Rejected</th><th>Reason</th>
  </tr></thead><tbody id="tbody-rejected"></tbody></table>
  <div class="empty" id="empty-rejected" style="display:none">No rejected requests yet.</div>
</div>
<div id="tab-all" class="tab-content">
  <div class="loading" id="loading-all">Loading...</div>
  <table id="table-all" style="display:none"><thead><tr>
    <th>User ID</th><th>Amount</th><th>Tier</th><th>Status</th><th>Requested</th>
  </tr></thead><tbody id="tbody-all"></tbody></table>
  <div class="empty" id="empty-all" style="display:none">No requests found.</div>
</div>

<div class="modal-overlay" id="rejectModal">
  <div class="modal">
    <h3>Reject Withdrawal Request</h3>
    <p style="color:#888;font-size:.85rem;margin-bottom:12px">Rejecting will refund the user points automatically.</p>
    <textarea id="rejectReason" placeholder="Reason for rejection (optional)..."></textarea>
    <div class="modal-btns">
      <button class="btn btn-approve" onclick="closeRejectModal()">Cancel</button>
      <button class="btn btn-reject" onclick="confirmReject()">Confirm Reject</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
// CONFIG PLACEHOLDERS — replace YOUR-PROJECT with your Firebase project ID after deploy:
const ADMIN_CONFIG = {
  LIST_ENDPOINT:    "https://us-central1-YOUR-PROJECT.cloudfunctions.net/adminListWithdrawals",
  APPROVE_ENDPOINT: "https://us-central1-YOUR-PROJECT.cloudfunctions.net/adminApproveWithdrawal",
  REJECT_ENDPOINT:  "https://us-central1-YOUR-PROJECT.cloudfunctions.net/adminRejectWithdrawal",
  // ADMIN_SECRET is NOT stored here — validated server-side via __session cookie.
  // The session was established by the adminAuth Cloud Function on login.
};
const DEMO_MODE = ADMIN_CONFIG.LIST_ENDPOINT.includes("YOUR-PROJECT");
if (DEMO_MODE) {
  const b = document.createElement("div");
  b.className = "demo-banner";
  b.textContent = "DEMO MODE — Cloud Function URLs not configured. Showing sample data. Replace YOUR-PROJECT in ADMIN_CONFIG after firebase deploy.";
  document.querySelector(".stats").before(b);
}

// Session inactivity timeout (30 min)
let sessionSeconds = 30 * 60;
let pendingRejectId = null;
const timerEl = document.getElementById("sessionTimer");
const sessionInterval = setInterval(() => {
  sessionSeconds--;
  if (sessionSeconds <= 0) { clearInterval(sessionInterval); logout(); return; }
  const m = Math.floor(sessionSeconds / 60).toString().padStart(2, "0");
  const s = (sessionSeconds % 60).toString().padStart(2, "0");
  timerEl.textContent = "Session: " + m + ":" + s;
}, 1000);
["click","keydown","mousemove","touchstart"].forEach(e =>
  document.addEventListener(e, () => { sessionSeconds = 30 * 60; }, { passive: true })
);

function logout() {
  document.cookie = "__session=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/admin";
  window.location.href = "/admin";
}

const loadedTabs = new Set();
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t, i) => {
    t.classList.toggle("active", ["pending","approved","rejected","all"][i] === name);
  });
  document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
  document.getElementById("tab-" + name).classList.add("active");
  if (!loadedTabs.has(name)) loadData(name);
}

async function loadData(status) {
  loadedTabs.add(status);
  const loadingEl = document.getElementById("loading-" + status);
  const tableEl   = document.getElementById("table-" + status);
  const emptyEl   = document.getElementById("empty-" + status);
  const tbodyEl   = document.getElementById("tbody-" + status);
  loadingEl.style.display = "block"; tableEl.style.display = "none"; emptyEl.style.display = "none";

  if (DEMO_MODE) {
    await new Promise(r => setTimeout(r, 600));
    const demo = getDemoData(status);
    renderTable(status, demo.requests, tbodyEl);
    updateStats(demo.stats);
    loadingEl.style.display = "none";
    if (demo.requests.length === 0) emptyEl.style.display = "block";
    else tableEl.style.display = "table";
    return;
  }

  try {
    // Session cookie is sent automatically (credentials: include)
    // No ADMIN_SECRET needed in client — server validates via __session cookie
    const resp = await fetch(ADMIN_CONFIG.LIST_ENDPOINT + "?status=" + status + "&limit=100", {
      credentials: "include"
    });
    if (resp.status === 403) {
      showToast("Session expired. Logging out.", true);
      setTimeout(logout, 2000);
      return;
    }
    const data = await resp.json();
    if (!data.success) throw new Error(data.error);
    renderTable(status, data.requests, tbodyEl);
    if (data.stats) updateStats(data.stats);
    loadingEl.style.display = "none";
    if (data.requests.length === 0) emptyEl.style.display = "block";
    else tableEl.style.display = "table";
  } catch (e) {
    loadingEl.textContent = "Error loading data: " + e.message;
  }
}

function updateStats(s) {
  if (!s) return;
  document.getElementById("statPending").textContent  = s.totalPending  ?? "—";
  document.getElementById("statApproved").textContent = s.approvedToday ?? "—";
  document.getElementById("statRejected").textContent = s.rejectedToday ?? "—";
}

function renderTable(status, requests, tbody) {
  tbody.innerHTML = "";
  requests.forEach(r => {
    const tr = document.createElement("tr");
    const date  = r.requestedAt ? new Date(r.requestedAt).toLocaleDateString() : "—";
    const aDate = r.approvedAt  ? new Date(r.approvedAt).toLocaleDateString()  : "—";
    const rDate = r.rejectedAt  ? new Date(r.rejectedAt).toLocaleDateString()  : "—";
    const tierB = r.tier === "new"
      ? '<span class="badge badge-new">New</span>'
      : '<span class="badge badge-regular">Regular</span>';
    const statB = {
      pending:          '<span class="badge badge-pending">Pending</span>',
      approved:         '<span class="badge badge-approved">Approved</span>',
      approved_manual:  '<span class="badge badge-approved">Manual</span>',
      rejected:         '<span class="badge badge-rejected">Rejected</span>',
      paid:             '<span class="badge badge-paid">Paid</span>',
    }[r.status] || r.status;
    const uid = (r.userId || "").slice(0, 12) + "...";
    const amt = "$" + (r.amount || 0).toFixed(2);

    if (status === "pending") {
      tr.innerHTML = '<td style="font-family:monospace;font-size:.75rem">' + uid + '</td>'
        + '<td>' + (r.paypalEmail || "—") + '</td>'
        + '<td style="color:#c0a060;font-weight:700">' + amt + '</td>'
        + '<td>' + tierB + '</td>'
        + '<td>' + (r.salaryCycle ? r.salaryCycle + "d" : "—") + '</td>'
        + '<td>' + date + '</td>'
        + '<td><button class="btn btn-approve" onclick="approveRequest(\'' + r.id + '\')">Approve</button>'
        + '<button class="btn btn-reject" onclick="openRejectModal(\'' + r.id + '\')">Reject</button></td>';
    } else if (status === "approved") {
      tr.innerHTML = '<td style="font-family:monospace;font-size:.75rem">' + uid + '</td>'
        + '<td style="color:#c0a060;font-weight:700">' + amt + '</td>'
        + '<td>' + tierB + '</td><td>' + date + '</td><td>' + aDate + '</td><td>' + statB + '</td>';
    } else if (status === "rejected") {
      tr.innerHTML = '<td style="font-family:monospace;font-size:.75rem">' + uid + '</td>'
        + '<td style="color:#c0a060;font-weight:700">' + amt + '</td>'
        + '<td>' + tierB + '</td><td>' + date + '</td><td>' + rDate + '</td>'
        + '<td style="color:#888;font-size:.8rem">' + (r.rejectReason || "—") + '</td>';
    } else {
      tr.innerHTML = '<td style="font-family:monospace;font-size:.75rem">' + uid + '</td>'
        + '<td style="color:#c0a060;font-weight:700">' + amt + '</td>'
        + '<td>' + tierB + '</td><td>' + statB + '</td><td>' + date + '</td>';
    }
    tbody.appendChild(tr);
  });
}

async function approveRequest(id) {
  if (!confirm("Approve this withdrawal request?")) return;
  if (DEMO_MODE) { showToast("Demo mode: approval simulated"); return; }
  try {
    const resp = await fetch(ADMIN_CONFIG.APPROVE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ withdrawalRequestId: id }),
    });
    const data = await resp.json();
    if (!data.success) throw new Error(data.error);
    showToast("Approved! " + (data.paypalStatus || ""));
    loadedTabs.clear(); loadData("pending");
  } catch (e) { showToast("Error: " + e.message, true); }
}

function openRejectModal(id) {
  pendingRejectId = id;
  document.getElementById("rejectReason").value = "";
  document.getElementById("rejectModal").classList.add("open");
}
function closeRejectModal() {
  pendingRejectId = null;
  document.getElementById("rejectModal").classList.remove("open");
}
async function confirmReject() {
  const reason = document.getElementById("rejectReason").value.trim() || "Rejected by admin";
  closeRejectModal();
  if (DEMO_MODE) { showToast("Demo mode: rejection simulated"); return; }
  try {
    const resp = await fetch(ADMIN_CONFIG.REJECT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ withdrawalRequestId: pendingRejectId, rejectReason: reason }),
    });
    const data = await resp.json();
    if (!data.success) throw new Error(data.error);
    showToast("Rejected. Points refunded to user.");
    loadedTabs.clear(); loadData("pending");
  } catch (e) { showToast("Error: " + e.message, true); }
}

function showToast(msg, isError = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast show" + (isError ? " error" : "");
  setTimeout(() => { t.className = "toast"; }, 3500);
}

function getDemoData(status) {
  const all = [
    { id:"req001", userId:"user-abc123def456", paypalEmail:"alice@example.com", amount:2.50, tier:"new",     salaryCycle:null, status:"pending",  requestedAt:new Date().toISOString(),                    approvedAt:null, rejectedAt:null, rejectReason:null },
    { id:"req002", userId:"user-xyz789ghi012", paypalEmail:"bob@example.com",   amount:5.00, tier:"regular", salaryCycle:15,   status:"pending",  requestedAt:new Date(Date.now()-86400000).toISOString(),  approvedAt:null, rejectedAt:null, rejectReason:null },
    { id:"req003", userId:"user-mno345pqr678", paypalEmail:"carol@example.com", amount:3.75, tier:"regular", salaryCycle:25,   status:"approved", requestedAt:new Date(Date.now()-172800000).toISOString(), approvedAt:new Date().toISOString(), rejectedAt:null, rejectReason:null },
    { id:"req004", userId:"user-stu901vwx234", paypalEmail:"dave@example.com",  amount:1.00, tier:"new",     salaryCycle:null, status:"rejected", requestedAt:new Date(Date.now()-259200000).toISOString(), approvedAt:null, rejectedAt:new Date().toISOString(), rejectReason:"Insufficient verified activity" },
  ];
  const filtered = status === "all" ? all : all.filter(r => r.status === status);
  return { requests: filtered, stats: { totalPending: 2, approvedToday: 1, rejectedToday: 1 } };
}

loadData("pending");
</script>
</body>
</html>`;
}