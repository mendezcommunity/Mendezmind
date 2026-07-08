/**
 * Mendez Community — Verified Reward Wallet
 * Firebase Cloud Functions (2nd gen, HTTPS)
 *
 * HONEST DESIGN:
 *   Rewards are credited ONLY when the ad network (Monetag / Adsterra) sends a
 *   genuine Server-to-Server (S2S) postback for a VERIFIED conversion. There is
 *   NO client-side crediting, NO timer, NO fake/guaranteed cash. The front-end
 *   only READS the verified balance from Firestore — it can never write to it.
 *
 * Two endpoints:
 *   1) POST/GET  /postback   — receives the ad-network S2S callback, validates a
 *                              shared secret, is idempotent (dedupes by txId),
 *                              and atomically credits the user's verifiedRewardPoints.
 *   2) GET       /balance    — read-only: returns { userId, verifiedRewardPoints,
 *                              pendingClicks, lastUpdated } for the front-end.
 *
 * SECURITY NOTES:
 *   - POSTBACK_SECRET is stored in an environment variable / Secret Manager,
 *     NEVER in the repo. You set it with:  firebase functions:config or
 *     `firebase functions:secrets:set POSTBACK_SECRET`
 *   - The ad network must be configured to append your secret + subid (=userId)
 *     + a unique transaction id to the postback URL. See README.md.
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// Shared secret used to authenticate the ad-network postback.
// Set it once (never committed to git):
//   firebase functions:secrets:set POSTBACK_SECRET
const POSTBACK_SECRET = defineSecret("POSTBACK_SECRET");

// Small helper: read a param from query OR JSON/form body (networks vary).
function param(req, ...names) {
  for (const n of names) {
    if (req.query && req.query[n] != null && req.query[n] !== "") return String(req.query[n]);
    if (req.body && req.body[n] != null && req.body[n] !== "") return String(req.body[n]);
  }
  return "";
}

// Basic CORS for the read-only balance endpoint (front-end fetch()).
function cors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

/* =========================================================================
 * 1) S2S POSTBACK ENDPOINT
 *    URL you paste into Monetag/Adsterra dashboard (Postback / S2S field):
 *    https://<region>-<project>.cloudfunctions.net/postback
 *       ?secret=YOUR_SECRET&subid={SUBID}&txid={CLICK_ID}&payout={PAYOUT}&status={STATUS}
 *    (Replace {SUBID} / {CLICK_ID} / {PAYOUT} / {STATUS} with each network's
 *     own MACRO — see README.md for the exact macro names.)
 * =======================================================================*/
exports.postback = onRequest(
  { secrets: [POSTBACK_SECRET], cors: false },
  async (req, res) => {
    try {
      // ---- 1. Validate shared secret ----
      const secret = param(req, "secret", "key");
      if (!secret || secret !== POSTBACK_SECRET.value()) {
        logger.warn("postback rejected: bad secret");
        return res.status(403).send("forbidden: invalid secret");
      }

      // ---- 2. Extract & validate params (network macro names vary) ----
      // subid / ymid = our userId ; txid / clickid = unique conversion id
      const userId = param(req, "subid", "ymid", "sub_id", "var");
      const txId = param(req, "txid", "clickid", "click_id", "cid", "transaction_id");
      const status = (param(req, "status", "event") || "confirmed").toLowerCase();
      const payoutRaw = param(req, "payout", "reward", "sum");
      const payout = parseFloat(payoutRaw);

      if (!userId || !txId) {
        logger.warn("postback rejected: missing userId/txId", { userId, txId });
        return res.status(400).send("bad request: missing subid or txid");
      }

      // ---- 3. Only credit genuine confirmed conversions ----
      const OK = ["confirmed", "approved", "1", "lead", "conversion", "sale", "verified"];
      if (!OK.includes(status)) {
        logger.info("postback ignored: non-confirmed status", { status });
        return res.status(200).send("ignored: status not confirmed");
      }

      // How many points this verified conversion is worth. If the network sends a
      // real payout figure we scale by it; otherwise a verified conversion = 1 point.
      const points = !isNaN(payout) && payout > 0 ? Math.round(payout * 100) : 1;

      // ---- 4. Idempotency + atomic credit (Firestore transaction) ----
      const txRef = db.collection("postback_tx").doc(txId); // unique per conversion
      const userRef = db.collection("wallets").doc(userId);

      const result = await db.runTransaction(async (t) => {
        const txSnap = await t.get(txRef);
        if (txSnap.exists) {
          return { duplicate: true }; // already processed this conversion — skip
        }
        const userSnap = await t.get(userRef);
        const prev = userSnap.exists ? (userSnap.data().verifiedRewardPoints || 0) : 0;

        t.set(txRef, {
          userId, points, status, payout: isNaN(payout) ? null : payout,
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        t.set(userRef, {
          userId,
          verifiedRewardPoints: prev + points,
          lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        return { duplicate: false, credited: points, balance: prev + points };
      });

      if (result.duplicate) {
        return res.status(200).send("ok: duplicate ignored (idempotent)");
      }
      logger.info("verified reward credited", { userId, txId, credited: result.credited });
      return res.status(200).send(`ok: credited ${result.credited}`);
    } catch (err) {
      logger.error("postback error", err);
      return res.status(500).send("server error");
    }
  }
);

/* =========================================================================
 * 2) READ-ONLY BALANCE ENDPOINT (front-end calls this)
 *    GET https://<region>-<project>.cloudfunctions.net/balance?userId=XYZ
 *    Returns the REAL verified balance. If the user has no verified rewards
 *    yet, verifiedRewardPoints is 0 — no fake numbers are ever invented.
 * =======================================================================*/
exports.balance = onRequest({ cors: false }, async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");

  const userId = param(req, "userId", "subid", "uid");
  if (!userId) {
    return res.status(400).json({ error: "missing userId" });
  }
  try {
    const snap = await db.collection("wallets").doc(userId).get();
    if (!snap.exists) {
      // No verified rewards yet — return an honest zero, not a fabricated value.
      return res.status(200).json({
        userId, verifiedRewardPoints: 0, pendingClicks: 0, lastUpdated: null,
      });
    }
    const d = snap.data();
    return res.status(200).json({
      userId,
      verifiedRewardPoints: d.verifiedRewardPoints || 0,
      pendingClicks: d.pendingClicks || 0,
      lastUpdated: d.lastUpdated ? d.lastUpdated.toDate().toISOString() : null,
    });
  } catch (err) {
    logger.error("balance error", err);
    return res.status(500).json({ error: "server error" });
  }
});
