# Mendez Community — Verified Reward Wallet (Firebase + Ad-Network S2S Postback)

This folder is a **complete, ready-to-deploy reference implementation** for an
**honest** reward wallet. Reward points are credited to a user **only when the ad
network (Monetag / Adsterra) confirms a genuine conversion** via a Server-to-Server
(S2S) postback. There is **no client-side crediting, no timer, no fake or guaranteed
cash** — the website can only *read* the verified balance, never write it.

```
firebase/
├── functions/
│   ├── index.js        # /postback (S2S receiver) + /balance (read-only) Cloud Functions
│   └── package.json
├── firestore.rules     # wallets = public read / no client write; tx ledger = server-only
├── firebase.json
└── README.md           # this file
```

## How it works (the honest flow)

1. The front-end (`silver-task.html`) creates a stable **anonymous userId** (UUID in
   `localStorage`) and appends it to the sponsor link as the network's **subid / ymid**.
2. The user **voluntarily clicks** "Open Sponsor Offer" → the offer opens in a new tab.
3. If — and only if — the ad network **verifies a genuine view/conversion**, it calls
   your **postback URL** with `subid` (= userId) + a unique `txid` + `status`.
4. The `postback` Cloud Function validates a **shared secret**, ignores duplicates
   (idempotency by `txid`), and **atomically credits** `verifiedRewardPoints` in Firestore.
5. The front-end reads the **real** balance from the `balance` endpoint. Until a real
   verified postback arrives, the verified balance stays **0** — no fake numbers.

---

## Step-by-step setup (do this in YOUR OWN Firebase + ad-network accounts)

### A. Create the Firebase project
1. Go to <https://console.firebase.google.com> → **Add project** → name it (e.g. `mendez-wallet`).
2. In the project, open **Build → Firestore Database → Create database** → Production mode → pick a region.
3. Upgrade to the **Blaze (pay-as-you-go)** plan — Cloud Functions HTTPS endpoints require it
   (free tier quota is generous; small traffic ≈ ₹0).

### B. Install tools & log in (on your computer)
```bash
npm install -g firebase-tools
firebase login
cd firebase          # this folder
firebase use --add   # select the project you created
```

### C. Set the shared secret (NEVER put it in git)
Pick any long random string and register it as a secret:
```bash
firebase functions:secrets:set POSTBACK_SECRET
# paste your secret when prompted, e.g.  9f3c1a7e5b2d4f8a... (keep it private)
```

### D. Deploy the rules + functions
```bash
cd functions && npm install && cd ..
firebase deploy --only firestore:rules,functions
```
After deploy, the CLI prints your function URLs, e.g.:
```
postback: https://us-central1-mendez-wallet.cloudfunctions.net/postback
balance:  https://us-central1-mendez-wallet.cloudfunctions.net/balance
```
**Copy both URLs.** You'll paste them into the website config and the ad-network dashboard.

### E. Configure the ad-network S2S postback
Paste your **postback URL** into the network's Postback / S2S field, appending the secret +
the network's own macros. Use the network's exact macro names:

**Monetag** (Dashboard → your zone → *Postback / S2S*):
```
https://us-central1-mendez-wallet.cloudfunctions.net/postback?secret=YOUR_SECRET&subid={ymid}&txid={click_id}&payout={estimated_price}&status=confirmed
```

**Adsterra** (Dashboard → *S2S / Postback*):
```
https://us-central1-mendez-wallet.cloudfunctions.net/postback?secret=YOUR_SECRET&subid={{subid}}&txid={{click_id}}&payout={{payout}}&status={{status}}
```
> The exact macro tokens (`{ymid}`, `{click_id}`, `{{subid}}`, …) differ per network and per
> ad format — copy them from the network's own postback documentation page. The function
> already accepts several common aliases (`subid`/`ymid`, `txid`/`clickid`, `payout`/`reward`).

### F. Wire the website
In `silver-task.html`, fill the three commented `WALLET_CONFIG` placeholders:
- `firebaseConfig` → from Firebase Console → **Project settings → Your apps → Web app → SDK config**.
- `BALANCE_ENDPOINT` → the `balance` function URL from step D.
- `SUBID_PARAM` → the query-param name the network reads as subid (usually `subid` or `ymid`).

Commit `silver-task.html`, let GitHub Pages rebuild, done.

---

## Security & honesty guarantees
- **Clients can't write balances.** `firestore.rules` blocks all client writes to `wallets`;
  only the Admin SDK (inside the Cloud Function) can credit.
- **Secret-gated postback.** A request without the correct `secret` is rejected (403).
- **Idempotent.** Each conversion `txid` is processed once — replays are ignored.
- **No fabrication.** New/unknown user → balance `0`. Nothing is credited without a
  verified network postback. No timers, no auto-credit, no forced views.

## Test locally (optional)
```bash
firebase emulators:start --only functions,firestore
# simulate a verified postback:
curl "http://localhost:5001/<project>/us-central1/postback?secret=YOUR_SECRET&subid=test-user&txid=tx123&status=confirmed&payout=0.02"
# read it back:
curl "http://localhost:5001/<project>/us-central1/balance?userId=test-user"
```

---

## Admin Withdrawal Panel (v9 — 2026-07-08)

A password-protected admin panel (`admin.html`) is now included in the repo root.
It lets the site admin review, approve, and reject withdrawal requests without
touching the Firestore console.

### New Cloud Function endpoints (v9)

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `adminListWithdrawals` | GET | `adminSecret` query param | List all withdrawal requests (filter by status) |
| `adminRejectWithdrawal` | POST | `adminSecret` in body | Reject a pending request + atomically refund points |

### How to use admin.html

1. Open `https://mendezcommunity.github.io/Mendezmind/admin.html` in your browser.
2. Enter your `ADMIN_SECRET` (same secret set in Firebase Functions secrets).
3. The panel fetches pending requests from `adminListWithdrawals`.
4. Click **✅ Approve** → calls `adminApproveWithdrawal` (triggers PayPal if configured).
5. Click **❌ Reject** → enter optional reason → calls `adminRejectWithdrawal` (refunds user points).

### Configure admin.html

Open `admin.html`, find the `ADMIN_CONFIG` block in the `<script>` section, and paste:
```js
const ADMIN_CONFIG = {
  LIST_ENDPOINT:    "https://us-central1-YOUR-PROJECT.cloudfunctions.net/adminListWithdrawals",
  APPROVE_ENDPOINT: "https://us-central1-YOUR-PROJECT.cloudfunctions.net/adminApproveWithdrawal",
  REJECT_ENDPOINT:  "https://us-central1-YOUR-PROJECT.cloudfunctions.net/adminRejectWithdrawal",
};
```

### Set ADMIN_SECRET in Firebase

```bash
firebase functions:secrets:set ADMIN_SECRET
# Enter a strong random string when prompted
firebase deploy --only functions
```

### Security notes

- `ADMIN_SECRET` is **never stored in admin.html** — admin types it each session.
- All write operations go through Cloud Functions (Firestore rules deny client writes).
- The panel shows demo data when endpoints are not configured (no real data exposed).
