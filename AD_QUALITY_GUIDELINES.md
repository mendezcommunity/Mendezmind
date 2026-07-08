# 🛡️ Ad Quality & Safety Guidelines — Mendez Community

**Goal:** Block scam / gambling / adult / dating / aggressive ("fake system alert", "your device is infected", scare) ad categories, and serve only **clean mainstream** ads (e-commerce, software, brands, apps, utilities).

> ⚠️ **Reality check (important, honest):** Ad **category filtering is controlled inside the ad-network PUBLISHER DASHBOARDS — NOT in this website's code.** The Monetag Smartlink and zone scripts do **not** expose a JavaScript parameter that universally blocks a category. So the real fix is done in your Monetag & Adsterra dashboards (below). The website only adds an honest disclaimer + an optional self-curated clean-offer list (see the last section).

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
5. **ENABLE / KEEP ON** the clean ones:
   - **Mainstream**, **E-commerce / Shopping**, **Software / Apps / Utilities**, **Brands**, **Games (non-gambling)**.
6. **Ad formats (safety):** prefer **In-Page Push** and **Interstitial** with **frequency capping**; avoid aggressive full-screen loops. Turn ON any **"Safe / Family" / "Mainstream only"** toggle if your account has it.
7. **Blacklist (for repeat offenders):** find **Blacklist / Block advertiser / Block domain** and add any scam advertiser domain you spot. This permanently blocks that advertiser from your traffic.
8. **Save.** Changes usually take effect within a few minutes to a few hours.

> 💡 If you cannot find a category toggle, open a **Monetag support ticket** and ask them to **restrict your zone to "mainstream / safe" categories and block gambling + adult + scare ads.** They can set this account-side.

---

## 2) Adsterra — block bad categories (click-by-click)

1. Log in at **https://adsterra.com** (Publisher) → **Dashboard**.
2. Left menu → **Websites** (or **Placements**) → select your site.
3. Open **Ad settings** → **Ad categories / Category filter / Content filtering**.
4. **BLOCK (turn OFF)**:
   - **Gambling / Betting**
   - **Adult / Dating**
   - **Aggressive / Alert / "Fake system alert" / Scareware**
   - **Sweepstakes / Fake-prize**
5. **KEEP ON:** **Mainstream**, **E-commerce**, **Software / Utilities**, **Brands**.
6. **Ad-format safety:** choose **Native / Banner / Social Bar** over aggressive Popunder if user experience matters; keep **frequency capping** on.
7. **Blacklist / Advertiser blocklist:** Adsterra → **Ad settings → Blacklist** → add scam **domains / advertiser IDs** you want permanently blocked. Use this every time a bad offer appears — it sticks.
8. **Save.** Adsterra usually applies within ~1 hour.

> 💡 Adsterra also lets you request **"mainstream only"** approval per placement — contact your Adsterra manager to lock your placement to mainstream inventory.

---

## 3) Practical routine to keep inventory clean

- When you (or a user) see a **scammy/gambling/adult** ad: note the **advertiser domain** shown, then add it to the **Blacklist** in whichever network served it.
- Re-check both dashboards **weekly**; new advertisers appear constantly.
- Prefer **In-Page Push / Native / Banner** over raw Popunder for a cleaner feel.
- Keep **frequency caps** so users aren't spammed.

> ⚖️ **Trade-off (honest):** Fully-clean, mainstream-only inventory can **slightly lower your CPM/earnings** (gambling/adult usually pay more), **but it raises user trust, reduces complaints, and lowers ban risk.** For a community site this is the right long-term choice.

---

## 4) Optional: self-curated clean offers (code-side, safe)

Category blocking above fixes the **rotating** networks. If you want **full control**, the site's `silver-task.html` now has a clearly-commented **`CURATED_OFFERS`** array (empty by default). You can paste **your own vetted, clean offer URLs** there:

- If `CURATED_OFFERS` has entries → the sponsor button rotates through **your vetted clean links**.
- If it's empty (default) → the button falls back to the **real Monetag Smartlink** (unchanged behaviour).

**Rules:** only paste offer links you have personally checked are clean and legitimate. Keep `target="_blank"` + `rel="noopener noreferrer"`. Do **not** paste gambling/adult/scam links. Do **not** auto-open them — the button opens **one** offer only on a **voluntary user click** (ad-network policy).

---

## 5) What this repo change does NOT do (honesty)

- It does **NOT** magically filter ad content from JavaScript — that's impossible for third-party network scripts. The **dashboard settings above are the real control.**
- It does **NOT** add any fake/guaranteed cash, auto-fire ads, forced views, or fake impressions.
- On-page Monetag/Adsterra ads still require **your real official snippets** (see the commented placeholders in `silver-task.html`).

**Bottom line:** Do the **dashboard category-blocking + blacklist** (sections 1–2) for the biggest, real safety win. Use the **curated-offers list** (section 4) if you want tighter control. The website change here is the honest disclaimer + the optional curated-offer hook.
