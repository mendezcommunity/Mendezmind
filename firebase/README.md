# Mendez Community — Firebase Backend + Admin Panel Setup Guide

> **Updated:** 2026-07-08 — Added admin panel security hardening (hash gate, rate limiting, session timeout).

---

## Architecture Overview

```
Ad Network (Monetag/Adsterra)
        │  S2S Postback (verified conversion)
        ▼
Firebase Cloud Function: /postback
        │  atomic credit
        ▼
Firestore: wallets/{userId}.verifiedRewardPoints
        │  read
        ▼
silver-task.html: "Verified Reward Balance"
        │  withdrawal request
        ▼
Firebase Cloud Function: /requestWithdrawal
        │  pending doc
        ▼
Firestore: withdrawalRequests/{reqId}
        │  admin reviews
        ▼
admin.html#auth → adminApproveWithdrawal / adminRejectWithdrawal
        │  PayPal Payouts API (if configured)
        ▼
User's PayPal account
```

---

## Step 1 — Create Firebase Project

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Click **Add project** → name it (e.g. `mendezmind`)
3. Enable **Firestore Database** → Start in **production mode**
4. Upgrade to **Blaze plan** (required for Cloud Functions)

---

## Step 2 — Install Firebase CLI

```bash
npm install -g firebase-tools
firebase login
cd /path/to/your/repo
firebase use --add   # select your project
```

---

## Step 3 — Set Secrets

```bash
# Required: ad network postback verification
firebase functions:secrets:set POSTBACK_SECRET
# Enter any long random string (e.g. openssl rand -hex 32)

# Required: admin panel authentication
firebase functions:secrets:set ADMIN_SECRET
# Enter a strong password you'll use to log into admin.html

# Optional: PayPal auto-payout
firebase functions:secrets:set PAYPAL_CLIENT_ID
firebase functions:secrets:set PAYPAL_SECRET
# Get these from developer.paypal.com → My Apps & Credentials
```

---

## Step 4 — Deploy

```bash
cd firebase
npm install --prefix functions
firebase deploy --only firestore:rules,functions
```

After deploy, you'll see URLs like:
```
Function URL (postback):              https://us-central1-YOUR-PROJECT.cloudfunctions.net/postback
Function URL (balance):               https://us-central1-YOUR-PROJECT.cloudfunctions.net/balance
Function URL (requestWithdrawal):     https://us-central1-YOUR-PROJECT.cloudfunctions.net/requestWithdrawal
Function URL (adminListWithdrawals):  https://us-central1-YOUR-PROJECT.cloudfunctions.net/adminListWithdrawals
Function URL (adminApproveWithdrawal):https://us-central1-YOUR-PROJECT.cloudfunctions.net/adminApproveWithdrawal
Function URL (adminRejectWithdrawal): https://us-central1-YOUR-PROJECT.cloudfunctions.net/adminRejectWithdrawal
Function URL (setSalaryCycle):        https://us-central1-YOUR-PROJECT.cloudfunctions.net/setSalaryCycle
Function URL (withdrawalHistory):     https://us-central1-YOUR-PROJECT.cloudfunctions.net/withdrawalHistory
```

---

## Step 5 — Configure silver-task.html

Open `silver-task.html` and find the `WALLET_CONFIG` block. Replace placeholders:

```js
const WALLET_CONFIG = {
  BALANCE_ENDPOINT:    "https://us-central1-YOUR-PROJECT.cloudfunctions.net/balance",
  WITHDRAWAL_ENDPOINT: "https://us-central1-YOUR-PROJECT.cloudfunctions.net/requestWithdrawal",
  HISTORY_ENDPOINT:    "https://us-central1-YOUR-PROJECT.cloudfunctions.net/withdrawalHistory",
  CYCLE_ENDPOINT:      "https://us-central1-YOUR-PROJECT.cloudfunctions.net/setSalaryCycle",
  SUBID_PARAM:         "ymid",   // Monetag uses ymid; Adsterra uses subid
};
```

---

## Step 6 — Configure admin.html

Open `admin.html` and find the `ADMIN_CONFIG` block. Replace placeholders:

```js
const ADMIN_CONFIG = {
  LIST_ENDPOINT:    "https://us-central1-YOUR-PROJECT.cloudfunctions.net/adminListWithdrawals",
  APPROVE_ENDPOINT: "https://us-central1-YOUR-PROJECT.cloudfunctions.net/adminApproveWithdrawal",
  REJECT_ENDPOINT:  "https://us-central1-YOUR-PROJECT.cloudfunctions.net/adminRejectWithdrawal",
};
```

---

## Step 7 — Configure Ad Network S2S Postback

### Monetag
- Dashboard → Sites/Zones → your zone → **Postback URL**
- Set: `https://us-central1-YOUR-PROJECT.cloudfunctions.net/postback?userId={ymid}&txId={click_id}&payout={payout}&secret=YOUR_POSTBACK_SECRET`
- In silver-task.html smartlink, append `?ymid={userId}` (already done via UUID logic)

### Adsterra
- Dashboard → Websites → your site → **Postback URL**
- Set: `https://us-central1-YOUR-PROJECT.cloudfunctions.net/postback?userId={subid}&txId={click_id}&payout={payout}&secret=YOUR_POSTBACK_SECRET`

---

## Step 8 — Access Admin Panel (SECURITY HARDENED)

### How to open the admin panel

The admin panel is protected by a **hash gate**. Without the correct URL hash, the page shows a fake 404.

**Correct URL:**
```
https://mendezcommunity.github.io/Mendezmind/admin.html#auth
```

**Never share** the plain URL `admin.html` — always include `#auth`.

### Security features implemented

| Feature | Details |
|---|---|
| **Hash gate** | Without `#auth` in URL → shows fake 404 page |
| **Rate limiting** | 5 failed login attempts → 15-minute lockout (sessionStorage) |
| **Session timeout** | Auto-logout after 30 minutes of inactivity |
| **noindex/nofollow** | Search engines cannot index or archive the page |
| **Referrer-Policy: no-referrer** | No referrer header sent on navigation |
| **No public links** | admin.html is not linked from index.html or silver-task.html |
| **Backend verification** | ADMIN_SECRET verified against Cloud Function (not hardcoded) |
| **Demo mode** | If URLs not configured, shows sample data (no real data exposed) |

### Login steps

1. Open: `https://mendezcommunity.github.io/Mendezmind/admin.html#auth`
2. Enter your **ADMIN_SECRET** (the one you set in Firebase secrets)
3. Click **Sign In**
4. View pending withdrawal requests → click **Approve** or **Reject**

### Limitations (honest note)

GitHub Pages is **static hosting** — it cannot enforce server-side HTTP Basic Auth or IP allowlisting. The security measures above are client-side hardening:
- A determined attacker who views page source can see the JavaScript logic
- For true server-side protection, move the admin panel to **Firebase Hosting** with a Cloud Functions auth middleware, or use a private URL only you know

---

## Cloud Function Endpoints Reference

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/postback` | GET | POSTBACK_SECRET query param | Receives S2S postback from ad network, credits wallet |
| `/balance` | GET | none (userId query param) | Returns verifiedRewardPoints for a userId |
| `/requestWithdrawal` | POST | none (userId in body) | User submits withdrawal request |
| `/adminListWithdrawals` | GET | x-admin-secret header | Lists withdrawal requests (filterable by status) |
| `/adminApproveWithdrawal` | POST | x-admin-secret header | Approves request, triggers PayPal payout |
| `/adminRejectWithdrawal` | POST | x-admin-secret header | Rejects request, refunds user points |
| `/setSalaryCycle` | POST | none (userId in body) | Sets user's salary cycle (15 or 25 days) |
| `/withdrawalHistory` | GET | none (userId query param) | Returns user's withdrawal history |

---

## Firestore Collections

| Collection | Document | Fields |
|---|---|---|
| `wallets` | `{userId}` | verifiedRewardPoints, pendingClicks, joinedAt, tier, salaryCycle, lastPayoutAt, firstPayoutCompletedAt, paypalEmail, lastUpdated |
| `withdrawalRequests` | `{auto-id}` | userId, paypalEmail, amountUSD, pointsDeducted, tier, salaryCycle, status, requestedAt, approvedAt, rejectedAt, rejectReason, paypalBatchId |
| `processedTx` | `{txId}` | processedAt (idempotency — prevents duplicate postback credits) |

---

## Honest Notes

- **Payouts come from real ad revenue only** — not from fabricated funds
- **Verified Reward Balance = 0** until real S2S postbacks arrive from the ad network
- **Withdrawal requests are not guaranteed** — admin reviews and approves based on available revenue
- **PayPal Payouts API** requires a PayPal Business account with Payouts enabled (apply at developer.paypal.com)
- **CPM may be slightly lower** with clean/mainstream ad categories, but user trust improves
