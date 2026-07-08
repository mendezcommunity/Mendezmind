# Mendez Community — Firebase Backend

## Overview

This folder contains the complete Firebase backend for the Mendez Community website:
- **S2S Postback** — credits `verifiedRewardPoints` on network-verified ad conversions
- **Verified Reward Wallet** — read-only balance endpoint for the front-end
- **Withdrawal Request System** — user-submitted payout requests (PayPal)
- **Admin Panel** — server-side authenticated admin UI (Firebase Hosting)

---

## 🔐 Admin Panel — Firebase Hosting (Server-Side Auth)

### Why Firebase Hosting instead of GitHub Pages?

| Feature | GitHub Pages (old) | Firebase Hosting (new) |
|---|---|---|
| Auth type | Client-side JS (bypassable) | **Server-side** (true HTTP auth) |
| Cookie security | Client-readable | **HttpOnly, Secure, SameSite=Strict** |
| Rate limiting | sessionStorage only | **Firestore-backed** (persists across devices) |
| Secret exposure | Hash gate visible in source | **Never sent to client** |
| CDN caching | Public CDN | **Private, no-store headers** |

### Access URL (after deploy)
```
https://YOUR-PROJECT.web.app/admin
```
No hash needed — the server handles auth before serving any HTML.

### How it works
1. Browser visits `/admin` → `adminAuth` Cloud Function intercepts
2. No valid `__session` cookie → server returns **login form HTML** (no panel HTML in source)
3. Admin submits correct `ADMIN_SECRET` → server creates session token in Firestore, sets **HttpOnly `__session` cookie**, redirects to `/admin`
4. Valid cookie → server returns **full admin panel HTML**
5. Wrong secret → rate limit recorded in Firestore; after 5 failures → 15-min lockout
6. Session expires after 30 min of inactivity (sliding window)

---

## 📁 File Structure

```
firebase/
├── functions/
│   ├── index.js          <- All 9 Cloud Functions (including adminAuth)
│   └── package.json      <- Node.js dependencies
├── firebase.json         <- Hosting + Functions + Firestore config
├── firestore.rules       <- Security rules
└── README.md             <- This file
```

---

## 🚀 Deployment Steps

### Prerequisites
```bash
npm install -g firebase-tools
firebase login
```

### Step 1 — Initialize Firebase project
```bash
cd firebase/
firebase use --add
# Select your Firebase project
```

### Step 2 — Set secrets
```bash
firebase functions:secrets:set POSTBACK_SECRET
# Enter: any long random string (e.g. openssl rand -hex 32)

firebase functions:secrets:set ADMIN_SECRET
# Enter: your admin password (keep this safe!)

firebase functions:secrets:set PAYPAL_CLIENT_ID
# Enter: your PayPal Business app Client ID (optional, for auto-payouts)

firebase functions:secrets:set PAYPAL_SECRET
# Enter: your PayPal Business app Secret (optional)
```

### Step 3 — Create public/ directory for Firebase Hosting
```bash
mkdir -p public
# Copy your main site files to public/
# The /admin route is handled by adminAuth Cloud Function (no file needed in public/)
cp ../silver-task.html public/
cp ../index.html public/
```

### Step 4 — Deploy
```bash
firebase deploy --only firestore:rules,functions,hosting
```

After deploy you will see:
```
functions[adminAuth(us-central1)]: Successful create operation.
functions[adminListWithdrawals(us-central1)]: Successful create operation.
...
Hosting URL: https://YOUR-PROJECT.web.app
```

### Step 5 — Copy Cloud Function URLs
From the deploy output, copy the URLs for each function and paste into:
- `postback` URL → Monetag/Adsterra S2S postback field in their dashboards
- `balance` URL → `BALANCE_ENDPOINT` in silver-task.html
- `requestWithdrawal` URL → `WITHDRAWAL_ENDPOINT` in silver-task.html
- `adminListWithdrawals` URL → `LIST_ENDPOINT` in admin panel ADMIN_CONFIG
- `adminApproveWithdrawal` URL → `APPROVE_ENDPOINT` in admin panel ADMIN_CONFIG
- `adminRejectWithdrawal` URL → `REJECT_ENDPOINT` in admin panel ADMIN_CONFIG

### Step 6 — Access admin panel
```
https://YOUR-PROJECT.web.app/admin
```
Enter your `ADMIN_SECRET` and sign in. No hash or URL tricks needed.

---

## Cloud Functions Reference (9 endpoints)

| # | Function | Method | Auth | Purpose |
|---|---|---|---|---|
| 1 | `postback` | GET | POSTBACK_SECRET | S2S postback from Monetag/Adsterra |
| 2 | `balance` | GET | userId param | Read wallet balance |
| 3 | `requestWithdrawal` | POST | userId in body | Submit withdrawal request |
| 4 | `adminApproveWithdrawal` | POST | ADMIN_SECRET | Approve + optional PayPal payout |
| 5 | `setSalaryCycle` | POST | userId in body | Set 15/25-day cycle |
| 6 | `withdrawalHistory` | GET | userId param | User's withdrawal history |
| 7 | `adminListWithdrawals` | GET | ADMIN_SECRET | List all requests (filterable by status) |
| 8 | `adminRejectWithdrawal` | POST | ADMIN_SECRET | Reject + refund points atomically |
| 9 | `adminAuth` | GET/POST | ADMIN_SECRET (server-side) | Firebase Hosting auth middleware |

---

## Firestore Collections

| Collection | Purpose | Client write? |
|---|---|---|
| `wallets/{userId}` | Reward points, tier, cycle | No |
| `processedTx/{txid}` | Idempotency for postbacks | No |
| `withdrawalRequests/{id}` | Payout requests | No |
| `adminSessions/{token}` | Server-side session tokens | No |
| `adminRateLimit/{ip}` | Failed login tracking | No |

---

## Monetag S2S Postback URL
```
https://us-central1-YOUR-PROJECT.cloudfunctions.net/postback?secret=YOUR_POSTBACK_SECRET&userId={ymid}&payout={payout}&txid={clickid}&status={status}
```

## Adsterra S2S Postback URL
```
https://us-central1-YOUR-PROJECT.cloudfunctions.net/postback?secret=YOUR_POSTBACK_SECRET&userId={subid}&payout={revenue}&txid={click_id}&status=1
```

---

## Honest Notes

- Payouts come from real ad revenue only — no guaranteed salary or fabricated funds.
- Verified Reward Balance stays 0 until real S2S postbacks arrive from the ad network.
- PayPal Payouts API requires a PayPal Business account with Payouts enabled.
  Without credentials, admin can approve manually and send via PayPal dashboard.
- GitHub Pages fallback: admin.html on GitHub Pages still works with client-side
  hardening (hash gate + rate limit). Firebase Hosting is the recommended secure option.

---

## GitHub Pages Fallback (admin.html)

The admin.html on GitHub Pages remains available as a fallback:
- Access via: https://mendezcommunity.github.io/Mendezmind/admin.html#auth
- Client-side rate limiting (5 attempts / 15-min lockout in sessionStorage)
- Session timeout (30 min inactivity)
- noindex/nofollow meta tags

For production use, Firebase Hosting is strongly recommended for true server-side security.

---

Last updated: 2026-07-08 — Added Firebase Hosting server-side auth (adminAuth),
adminListWithdrawals, adminRejectWithdrawal endpoints, firebase.json Hosting config.
