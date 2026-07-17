# 🛡️ Ad Quality & Safety Guidelines — Mendez Community
**Version 2 — Updated 17 July 2026**

**Goal:** Block scam / gambling / adult / dating / aggressive ("fake system alert", "your device is infected", scare) ad categories, and serve only **clean mainstream** ads (e-commerce, software, brands, apps, utilities).

> ⚠️ **Reality check (important, honest):** Ad **category filtering is controlled inside the ad-network PUBLISHER DASHBOARDS — NOT in this website's code.** The website adds an honest disclaimer, a Content Security Policy (CSP) meta tag, and an optional self-curated clean-offer list. The real blocking is done in your Monetag & Adsterra dashboards (below).

---

## ✅ What is already in place on the website (as of v2)

| Protection | Where | Status |
|---|---|---|
| Dead Monetag script (`monetag.com/showads/pub-11242429.js`) | silver-task.html | ✅ Removed (was 404, now clean comment only) |
| Content Security Policy (CSP) meta tag | Both pages `<head>` | ✅ Added — blocks unknown external scripts |
| Ad Safety Notice (strengthened) | Both pages | ✅ Updated — no network branding, clear "no auto-fire" statement |
| "Monetag Powered" branding | silver-task.html header | ✅ Removed — replaced with "Verified Offers Only" |
| Voluntary smartlink only | silver-task.html | ✅ No auto-fire, no popunder, user-initiated only |
| CURATED_OFFERS whitelist placeholder | silver-task.html JS | ✅ Present — add clean offer URLs here |
| Honest wallet copy | Both pages | ✅ No fake cash, no guaranteed payout claims |

---

## 1) Monetag — block bad categories (click-by-click)

1. Log in at **https://monetag.com** → **Dashboard**.
2. Left menu → **Sites** (or **Zones**) → click your site **mendezcommunity.github.io**.
3. Open **Ad categories** / **Category settings** / **Content settings** (name varies by account).
4. **DISABLE (turn OFF / block)** these categories:
   - **Gambling / Betting / Casino**
   - **Adult / 18+ / Dating**
   - **Aggressive / Alert / Scare / "System warning"** style ads
   - **Sweepstakes / "You won a prize" / Fake-reward**
   - **Crypto "get rich" / financial scam** offers
   - **Fake PhonePe / UPI reward** offers (report these as policy violations)
5. **ENABLE / KEEP ON** the clean ones:
   - **Mainstream**, **E-commerce / Shopping**, **Software / Apps / Utilities**, **Brands**, **Games (non-gambling)**.
6. **Ad formats (safety):** prefer **In-Page Push** and **Interstitial** with **frequency capping**; avoid aggressive full-screen loops. Turn ON any **"Safe / Family" / "Mainstream only"** toggle if your account has it.
7. **Blacklist (for repeat offenders):** find **Blacklist / Block advertiser / Block domain** and add any scam advertiser domain you spot. This permanently blocks that advertiser from your traffic.
8. **Save.** Changes usually take effect within a few minutes to a few hours.

> 💡 If you cannot find a category toggle, open a **Monetag support ticket** and ask them to **restrict your zone to "mainstream / safe" categories and block gambling + adult + scare ads.** They can set this account-side.

---

## 2) Adsterra — block bad categories (click-by-click)

1. Log in at **https://publishers.adsterra.com** → **Dashboard**.
2. Left menu → **My Sites** → click your site.
3. Find **Ad Settings** / **Category Filter** / **Content Restrictions**.
4. **BLOCK** the same categories as Monetag above (gambling, adult, scare, fake-reward, crypto scam).
5. **Blacklist advertisers:** go to **Statistics** → find the scam ad's domain → **Block domain**.
6. **Contact Adsterra support** if you cannot find the category filter — ask for "mainstream-only" restriction.

---

## 3) EffectiveCPMNetwork Smartlink — current setup

- **URL:** `https://www.effectivecpmnetwork.com/t2wmd8z5e1?key=b6fd7888ad71cbead0fa77c25665a19f`
- **Status:** ✅ Active, HTTP 200, `target="_blank"`, `rel="noopener noreferrer"` — all correct
- **Type:** Voluntary user-initiated click only (no auto-fire, no popunder)
- **If scam offers appear via this link:** Log in to EffectiveCPMNetwork dashboard → Publisher settings → block gambling/adult/scam categories, or contact their support.

---

## 4) Content Security Policy (CSP) — what it does

The CSP meta tag added to both pages (`<meta http-equiv="Content-Security-Policy" ...>`) does the following:

| Rule | Effect |
|---|---|
| `script-src 'self' 'unsafe-inline' cdnjs.cloudflare.com fonts.googleapis.com` | Only scripts from these trusted CDNs can load. Unknown ad-injector scripts are **blocked by the browser**. |
| `frame-src 'none'` | No iframes from unknown sources (blocks many ad-injection vectors) |
| `object-src 'none'` | Blocks Flash/plugin-based ads entirely |
| `connect-src 'self' cloudfunctions.net` | Only our own backend API calls allowed |

> ⚠️ **Note:** CSP does NOT block ads that load through the smartlink (which opens in a new tab). It only protects the Mendez Community page itself from having rogue scripts injected.

---

## 5) CURATED_OFFERS whitelist (optional, code-side control)

In `silver-task.html`, there is a JavaScript array:
```js
const CURATED_OFFERS = [];
```
To add your own vetted clean offer URLs, paste them here:
```js
const CURATED_OFFERS = [
  { url: "https://your-clean-offer-1.com", label: "Clean Offer 1" },
  { url: "https://your-clean-offer-2.com", label: "Clean Offer 2" },
];
```
When this array is non-empty, the "Open Sponsor Offer" button will rotate through these vetted URLs instead of the smartlink fallback.

---

## 6) Reporting scam ads

If a user reports a scam ad:
1. Ask them for the **advertiser domain / URL** shown in the ad.
2. Log in to the relevant ad-network dashboard and **blacklist that domain**.
3. File a **policy violation report** with the network (most have a "Report abuse" link).
4. Email **ads@mendezcommunity.com** to log the incident.

---

## 7) What NOT to do

- ❌ Do NOT add a new `<script src="monetag.com/...">` tag — the old URL is dead (404). Get a fresh snippet from your Monetag dashboard.
- ❌ Do NOT add auto-fire popunders or forced-view scripts — this violates ad-network policy and harms users.
- ❌ Do NOT show fake balance numbers or guaranteed cash claims — this is dishonest and may violate consumer protection laws.
- ❌ Do NOT add scripts from unknown ad networks without verifying their reputation first.

---

*Last updated: 17 July 2026 — Mendez Community Agent*
