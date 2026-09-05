# Patient Fundraising Platform — Server-Controlled Settlement & Platform Fee

A real, working fundraising platform that hosts **unlimited patient
campaigns**, accepts **real Paystack payments**, tracks the exact
gross/Paystack-fee/platform-fee/net breakdown of every donation, and can
**automatically settle a share of each donation to a verified
beneficiary's bank account** — with the server, never the browser, as
the final authority over where money goes. Everything is managed from a
password-protected admin dashboard.

Built with plain HTML/CSS/JS, Vercel Serverless Functions, and Supabase.

> ⚠️ This started as a single campaign for "Lucy." That campaign still
> works and now lives at `campaign.html?slug=lucy` — see step 4's SQL for
> how it's migrated forward automatically.

---

## How it works (quick overview)

**Public site**
1. `index.html` — a Jiji-style homepage grid: every **active** campaign
   as a card showing photo, name, hospital, live progress bar, and a
   **View Details** button. Cards never show the full patient story,
   phone numbers, or any beneficiary/bank information.
2. `campaign.html?slug=...` — one patient's full fundraising page:
   photo, hospital, diagnosis, full story, live net-raised progress bar,
   Recent Donors list (with fee breakdown), and the Donate button.
3. The donation form asks for the donor's **name (required)**, an
   **optional email**, an amount, and a **"Donate anonymously"**
   checkbox. Clicking **Donate Now** does **not** open an in-page popup
   — it calls our own server (`/api/initialize-donation`), which decides
   everything about settlement and fees, then redirects the browser to
   Paystack's own hosted checkout page. See "Server-controlled checkout"
   below for exactly why.
4. After payment, Paystack redirects the browser back to the campaign
   page, and separately (asynchronously) calls `/api/paystack-webhook` —
   the webhook is still the **only** source of truth for whether a
   payment actually succeeded, and it's what actually updates Supabase.
   The campaign page just shows a "confirming your payment" message and
   refreshes itself a few seconds later. The webhook **requires** a
   valid `fundraiser_id` (set by `/api/initialize-donation` at checkout
   time) to identify which campaign a donation belongs to — there is no
   "default" campaign to fall back to on a multi-campaign platform. If
   that ID is ever missing or doesn't match any campaign, the webhook
   logs it clearly and rejects the request without crediting anything.
5. The progress bar's fill is **capped at 100% visually**, even past
   goal — the true net amount raised is always shown as a number, and a
   "🎉 Goal Achieved" badge appears once the goal is met. Donations keep
   being accepted after the goal is reached. `/api/progress` (which
   supplies these numbers) requires an explicit `?id=` or `?slug=` for
   every request — there is no default campaign to fall back to, so one
   campaign's totals can never accidentally be shown for another. A
   request with neither returns `400`; a request for a campaign that
   doesn't exist returns `404`.
6. `/api/donations` resolves "Anonymous" **on the server** — a donor's
   real name is never sent to the page at all if they asked to stay
   anonymous, and donor email is never exposed publicly. The public donor
   list shows the Paystack fee breakdown, e.g. *"₦250 payment processing
   fee · Campaign received ₦9,750."*

**Admin dashboard** (`admin/login.html` → `admin/dashboard.html`)
1. Log in with a username/password stored as Vercel environment
   variables — never in the database.
2. Four tabs — **Active**, **Goal Achieved**, **Archived**, **All** —
   over the same campaign list, each with a live count. "Goal Achieved"
   is based purely on `raised_amount >= goal_amount`, entirely
   independent of a campaign's archived/active status.
3. Create, edit, archive, or delete campaigns, with private phone
   numbers, image upload, and safe image lifecycle (rollback on failed
   creation, safe replacement, cleanup on delete) — all unchanged.
4. **Beneficiary & Settlement** — add a verified bank account per
   campaign, verify it with Paystack, and enable or pause automatic
   settlement at any time.
5. **Platform Fee** — a single ON/OFF switch (default **OFF**), stored
   in Supabase so it persists across logout, redeploys, and devices.
   When ON, new donations have 1% (capped at ₦1,000) deducted as a
   platform fee; existing donations are never recalculated.
6. See total patients, active campaigns, total **net** raised, total
   donors, total **gross** donations, total **Paystack fees**, and total
   **platform fees** across the whole platform, plus a feed of recent
   donations with their full gross/Paystack-fee/platform-fee/net
   breakdown.

---

## Server-controlled checkout (why this changed)

**The old flow** had `campaign.html` fetch a campaign's Paystack
subaccount code from a public API, then call `PaystackPop.setup()`
directly in the browser using only the public key. That meant the
**browser** decided which subaccount a donation would split to. A
technically inclined visitor could tamper with that configuration, or a
browser tab left open across an admin pausing settlement or changing a
beneficiary could still submit a payment using stale settlement details,
since nothing forced the browser's claim to be re-checked.

**The current flow** fixes this structurally:

```
Visitor clicks Donate
        ↓
Browser calls POST /api/initialize-donation
   (sends ONLY: fundraiser_id, donor_name, donor_email, amount, anonymous)
        ↓
Server (never the browser) looks up, fresh, right now:
   - the campaign
   - its beneficiary's CURRENT verification/settlement status
   - the platform fee master switch's CURRENT state
        ↓
Server calls Paystack's Initialize Transaction API with the
final, authoritative subaccount + platform fee decision
        ↓
Server returns a Paystack-hosted "authorization_url"
        ↓
Browser redirects to Paystack's own checkout page
        ↓
Paystack webhook (unchanged, still the source of truth)
        ↓
Existing donation accounting / progress update
```

The browser is never told a subaccount code, never sees the platform fee
setting, and cannot influence either. If an admin pauses settlement or
swaps a beneficiary while a donor already has the campaign page open,
the very next `/api/initialize-donation` call (which happens the moment
they click Donate, not before) picks up the new configuration
automatically — there is no stale value anywhere in the browser to fall
back on.

**A real UX trade-off, stated plainly:** because the subaccount/fee
terms must be finalized *before* Paystack starts collecting payment,
checkout now redirects to Paystack's own hosted page instead of staying
in an in-page popup. This is the standard, fully-documented way to do
server-initiated Paystack transactions.

---

## Donation fee accounting (gross / Paystack fee / platform fee / net)

Every donation now distinguishes **four** figures, never combined:

| Field | Meaning |
|---|---|
| `amount` | **Gross** — the exact amount the donor paid |
| `paystack_fee` | Paystack's own transaction fee for that specific payment |
| `platform_fee` | This platform's own fee (1% of gross, capped at ₦1,000) — only ever nonzero when the master switch is ON **and** the campaign has a verified, settlement-enabled beneficiary |
| `net_amount` | `amount - paystack_fee - platform_fee` — what's actually attributable to the campaign/beneficiary |

**Where the Paystack fee comes from:** the documented `fees` field in
Paystack's `charge.success` webhook payload (kobo, same unit as
`amount`) — never a guessed number.

**Where the platform fee comes from:** computed entirely server-side in
`api/initialize-donation.js`, using the fixed formula
`min(gross × 1%, ₦1,000)`, and only when the master switch (read fresh
from Supabase at that moment) is ON. This value is then passed to
Paystack via the documented `transaction_charge` parameter, and
round-tripped back to the webhook through the same trusted metadata
channel already used for `fundraiser_id`/`donor_name` — it is a value
**our own server decided**, never something the browser supplied or
could influence.

**Precision:** the fee is calculated entirely in **kobo** (Paystack's
smallest currency unit — 1 naira = 100 kobo), not naira. Rounding to
whole naira first, then converting to kobo, would throw away up to 99
kobo of precision on every donation (e.g. a ₦150 donation's true 1% fee
is ₦1.50/150 kobo — rounding to whole naira first would incorrectly
charge ₦2/200 kobo instead). There's a single rounding step, at the
kobo level, since kobo is the smallest unit Paystack itself accepts.

**The platform fee is only ever charged when it can actually be
collected.** `transaction_charge` only has meaning as part of a Paystack
split — it requires a `subaccount`. If a campaign has no verified,
settlement-enabled beneficiary, there is no split at all: the full gross
amount already goes straight to the platform's main Paystack account, so
`platform_fee` is forced to `₦0` for that donation regardless of the
master switch's state. This keeps Supabase's accounting and Paystack's
actual settlement in agreement at all times — the database never claims
a fee was collected that Paystack wasn't actually configured to collect.

**Who bears Paystack's own fee:** whenever a subaccount is used,
Paystack's documented `bearer` parameter is set to `"subaccount"` — the
beneficiary absorbs Paystack's transaction fee, not the platform's main
account. This is what makes the beneficiary's real settlement match the
accounting formula above exactly: `beneficiary receives = gross -
paystack_fee - platform_fee`. When there's no subaccount, `bearer` is
never sent at all (it has no meaning outside a split payment).

**`fundraiser.raised_amount` increases by the NET amount only.**

**Historical donations** recorded before fee tracking existed have
`paystack_fee = 0`, `platform_fee = 0`, and `net_amount = amount` — real
historical fees were never captured and can't be safely reconstructed,
so old rows and old `raised_amount` totals are never altered. Changing
the platform fee master switch never recalculates or alters any
already-completed donation either — only donations initialized *after*
a change reflect it.

---

## Concurrency & robustness

**Fully transactional donation recording.** Recording a donation and
crediting the campaign for it happens as **one atomic database
operation**, via a Postgres function called
`record_donation_and_update_totals(...)` (see `supabase.sql`). This
function, invoked once per webhook via
`POST /rest/v1/rpc/record_donation_and_update_totals`:
1. Confirms the target `fundraiser_id` actually exists (no fallback to
   any other campaign).
2. Inserts the donation row using
   `insert ... on conflict (paystack_reference) do nothing` — the
   `UNIQUE` constraint on `paystack_reference` makes duplicate detection
   itself part of the same atomic statement, so a retried/duplicate
   Paystack webhook can never insert a second donation row or credit a
   campaign twice.
3. If (and only if) a new row was actually inserted, credits that
   campaign's `raised_amount` (by the net amount) and `donor_count` (by
   1) in the same function call.

Because a single PL/pgSQL function body runs inside the one transaction
PostgREST opens for that RPC call, steps 2 and 3 either **both** succeed
or, if anything fails partway through, the **entire thing rolls back
together** — including the donation insert. This closes a real gap that
existed in an earlier version of this code: previously, the insert and
the totals update were two separate database round trips (each
individually safe, but not atomic *together*), so if the insert
succeeded and the totals-update call then failed for any reason, the
donation would be permanently recorded while the campaign was never
credited — and a Paystack retry of that same webhook would then be
treated as a duplicate and silently skipped, meaning the campaign would
never receive that money's credit at all. That can no longer happen.

An earlier, narrower function, `increment_fundraiser_totals(...)`
(update-only, no insert), remains defined in `supabase.sql` for
reference but is **no longer called** by the webhook — it's superseded
by the combined function above, not run alongside it.

**Defensive platform fee cap, enforced twice.** `/api/initialize-donation`
already caps the platform fee at `min(gross × 1%, ₦1,000)` when it's
computed. The webhook independently re-enforces that same ₦1,000
(100,000 kobo) cap on whatever value actually arrives in
`metadata.platform_fee_kobo` — accepting it as either a number or a
numeric string, rounding to a whole kobo integer, and clamping it to
100,000 kobo — so even a corrupted, tampered, or buggy metadata payload
can never credit a platform fee above ₦1,000 for a single transaction.

**Platform fee metadata parsing.** `platform_fee_kobo` can arrive in
Paystack's metadata echo as either a number or a numeric string. The
webhook explicitly parses either representation and rejects anything
that isn't a finite, non-negative number (`NaN`, `Infinity`, negative
values, or garbage strings) by falling back to `0` — malformed metadata
can never produce an unexpected or negative platform fee.

**Donation amount validation.** `/api/initialize-donation` validates the
requested amount with `Number.isFinite()` rather than a plain truthy
check, so `NaN`, `Infinity`, and `-Infinity` are rejected outright (a
plain `!amount || amount < 100` check lets `Infinity` slip through,
since it's truthy and isn't `< 100`) — alongside the existing rejection
of zero, negative numbers, non-numeric input, and amounts below the
₦100 minimum.

---

## Beneficiary & automatic settlement system

### The model: automatic by default, admin control when necessary
Each campaign can have **one** verified beneficiary bank account. Once
verified **and** explicitly enabled by an admin, every donation to that
campaign automatically splits between the beneficiary's bank account and
the platform — decided fresh, server-side, at the moment each donation
starts (see "Server-controlled checkout" above). There is no separate
"payout" step your server has to run:
- **You are never required to manually receive and forward every
  patient's donations.**
- **The same donation can never be settled twice** — settlement isn't a
  separate action at all, it's built into the one Paystack charge,
  already protected by the existing reference-based duplicate-webhook
  check.
- **A problem with one campaign's beneficiary never affects another.**
- **When settlement is paused**, the very next donation to that campaign
  (initialized after the pause) is sent to Paystack with no `subaccount`
  at all — the full gross amount goes to the platform's main account,
  and `platform_fee` is `₦0` for that donation, exactly as if the
  campaign never had a beneficiary. Nothing about already-completed
  donations changes.

### How this is actually implemented (Paystack's documented behavior)
- **Create Subaccount** (`POST /subaccount`) — creates a Paystack
  subaccount for the beneficiary and returns a `subaccount_code`.
- **Resolve Account Number** (`GET /bank/resolve`) — verifies a
  bank_code + account_number pair and returns the registered name.
- **List Banks** (`GET /bank`) — powers the admin's bank dropdown.
- **Initialize Transaction** (`POST /transaction/initialize`) —
  accepts `subaccount` (which beneficiary to split with),
  `transaction_charge` (an exact kobo amount that goes to the platform's
  main account for THIS transaction, overriding the subaccount's default
  split — this is what makes a variable, capped 1% platform fee
  possible, per Paystack's own documentation: *"the amount specified
  goes to the main account regardless of the split configuration"*), and
  `bearer` (which side absorbs Paystack's own transaction fee).
- **Who bears Paystack's own fee:** set to `"subaccount"` whenever a
  subaccount is used, so the beneficiary's settlement matches the
  gross/Paystack-fee/platform-fee/net accounting above. Never sent when
  there's no subaccount.

### Verification states
- **Pending verification** — bank details saved, not yet checked.
- **Verification Failed** — Paystack couldn't resolve the account.
- **Verified · Settlement Paused** — confirmed real, subaccount exists,
  but not yet enabled (or paused).
- **Settlement Enabled** — the only state in which new donations use the
  subaccount.

Verifying a beneficiary **never** automatically enables settlement.

### Changing bank details resets verification
Editing an existing beneficiary's bank code or account number
automatically resets verification to "Pending" and pauses settlement.

### How to verify a beneficiary and enable settlement
1. Admin dashboard → find the campaign's row → tap **Beneficiary**.
2. Fill in name, bank, account number, optional platform fee %, phones.
   Tap **Save Details**.
3. Tap **Verify with Paystack**.
4. Once **Verified · Settlement Paused**, tap **Enable Settlement**.
5. Tap **Pause Settlement** any time to stop future donations from using
   it — instantly, with no effect on other campaigns or past donations.

### What's protected/private
- Bank account numbers are shown **masked** everywhere except the
  focused edit form.
- Beneficiary phone numbers, bank name, account number, and verification
  detail are **never** returned by any public endpoint.
- The public site never receives a subaccount code, a beneficiary's
  existence, or the platform fee setting at all — not even indirectly.

---

## Platform fee master switch

- **Default: OFF.** Stored in Supabase's `platform_settings` table (a
  single row), not browser localStorage — persists across logout,
  redeploys, and devices.
- **Rate: 1% of gross, capped at ₦1,000 per transaction.** Fixed in code
  (`api/initialize-donation.js`), not admin-adjustable — the only control
  is ON/OFF.
- **Only an authenticated admin can change it** (`api/admin/beneficiaries.js?route=platform-fee`,
  behind the same session-cookie check as every other admin endpoint).
- **The dashboard asks for confirmation** before turning it on or off.
- **Applies only to newly initialized transactions** — never
  recalculates or alters already-completed donations, because the fee
  actually charged is fixed at the moment Paystack's transaction is
  initialized, not looked up again later.
- **When OFF:** platform fee is ₦0 for every new donation; a campaign's
  beneficiary receives the normal settlement amount per its own
  subaccount configuration.
- **The switch alone doesn't guarantee a fee is charged.** Turning it ON
  only takes effect for a campaign that also has a verified,
  settlement-enabled beneficiary — without a subaccount to split
  through, Paystack has nothing to collect a platform fee from, so the
  fee stays ₦0 for that campaign's donations regardless of the switch.

---

## Step-by-step deployment guide (Android phone only)

You do **not** need a laptop. Everything below can be done from Chrome on
an Android phone.

### 1. Create a GitHub repository
1. Open **Chrome** and go to [github.com](https://github.com), sign in.
2. Tap **+** → **New repository**, name it, **Create repository**.

### 2. Upload the project files
Upload everything, preserving folders — see **Project structure** below
for the complete, current file list (9 API files total). Pay particular
attention to the router-style consolidated files: `api/admin/auth.js`,
`api/admin/beneficiaries.js`, `api/admin/campaigns.js`,
`api/initialize-donation.js`, and `lib/paystack.js`.

### 3. Create a Supabase project
Go to [supabase.com](https://supabase.com), create a project, note the
database password.

### 4. Run `supabase.sql`
Supabase → **SQL Editor** → **New query** → paste the **entire**
`supabase.sql` file → **Run**. This creates/updates every table this
project needs, including `beneficiaries` and `platform_settings`, and is
always safe to re-run — everything uses `if not exists` / safe
backfills, and nothing here ever deletes or resets existing data.

### 4b. Double check the storage bucket exists
Storage → confirm a **Public** bucket named exactly `campaign-images`
exists (create it if not).

### 5. Copy your environment variables
You'll need **7** values — no new ones were introduced by this update.

**From Supabase** (Project Settings → API): `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` ⚠️

**From Paystack** (Settings → API Keys & Webhooks): `PAYSTACK_PUBLIC_KEY`,
`PAYSTACK_SECRET_KEY` ⚠️ — this is also what the beneficiary/settlement
system and `/api/initialize-donation` use to talk to Paystack, no
separate key needed. Set the **Webhook URL** to
`https://YOUR-VERCEL-DOMAIN.vercel.app/api/paystack-webhook`.

**Choose these yourself:** `ADMIN_USERNAME`, `ADMIN_PASSWORD` ⚠️,
`ADMIN_SESSION_SECRET` ⚠️ (40+ random characters).

> Note: `PAYSTACK_PUBLIC_KEY` is still listed and configured as before,
> but the frontend no longer actively uses it now that checkout is
> server-initiated — it's kept in the environment variable list for
> completeness and in case it's needed again in future, but nothing
> currently reads it from `campaign.html`.

### 6. Import into Vercel
Add New → Project → select repo → add all 7 environment variables →
**Deploy**.

### 7. Set the webhook URL
Go back to Paystack's webhook settings and paste in your real Vercel
domain + `/api/paystack-webhook`.

### 8. Log in and create your first real campaign
Visit `/admin/login.html`, log in, **+ New Campaign**, fill in details
(primary phone required), upload a photo, **Save Campaign**. Optionally
tap **Beneficiary** to add and verify a bank account, then enable
settlement.

### 9. Test with a real payment
Open a campaign, tap **View Details**, donate a small test amount. You
should be redirected to Paystack's hosted checkout page, then redirected
back to the campaign page with a "confirming your payment" message; a
few seconds later the totals and Recent Donors list update.

### Paystack dashboard configuration required
- The webhook URL — required for any donation to be recorded at all.
- **Nothing else.** Subaccount creation happens automatically through
  the admin dashboard's "Verify with Paystack" action.

---

## Project structure

> **Note on Vercel's Hobby plan function limit:** Vercel's Hobby plan
> caps a deployment at **12 Serverless Functions** (each file under
> `api/` counts as one). This project intentionally consolidates several
> related admin operations into fewer, router-style files — using a
> `?route=` or `?action=` query parameter to pick which section of the
> file handles a given request — to stay comfortably under that limit
> (**9 functions total**) while keeping every feature working exactly as
> before. This is purely a file-organization choice; none of the
> underlying logic changed.

```
patient-fundraiser/
├── index.html                      # Public homepage: Jiji-style campaign cards, search
├── campaign.html                   # Public campaign details page — donate button calls
│                                    # /api/initialize-donation and redirects to Paystack's
│                                    # hosted checkout (no PaystackPop / public key used here anymore)
├── admin/
│   ├── login.html                    # Admin login form
│   └── dashboard.html                # Campaigns (4 tabs), analytics, beneficiary/settlement UI,
│                                      # Platform Fee master switch
├── images/
│   └── lucy.jpg                      # Fallback image used if a campaign has no photo
├── lib/
│   ├── admin-auth.js                  # Shared login-session helper used by admin APIs
│   ├── campaign-images.js             # Shared helper: safely delete/roll back campaign photos in Storage
│   └── paystack.js                    # Shared helper: List Banks / Resolve Account / Create & Update
│                                       # Subaccount / Initialize Transaction (server-side checkout)
├── api/                              # 9 files total = 9 Vercel Serverless Functions
│   ├── campaigns.js                   # Public: list active campaigns (+ search) — explicit column list
│   ├── campaign.js                    # Public: fetch one campaign by slug — explicit column list,
│   │                                   # NEVER returns anything about beneficiaries/subaccounts
│   ├── initialize-donation.js         # Public: securely starts a donation server-side; decides
│   │                                   # settlement subaccount + platform fee, the browser never does
│   ├── donations.js                   # Public: recent donors for one campaign, incl. gross/fee/net —
│   │                                   # anonymity resolved server-side
│   ├── progress.js                    # Public: live totals for one campaign
│   ├── paystack-webhook.js            # Verifies + records real payments: gross/Paystack-fee/
│   │                                   # platform-fee/net accounting, per-campaign targeting,
│   │                                   # settlement audit trail
│   └── admin/
│       ├── auth.js                     # Protected/login: login + logout + session check, via
│       │                                # ?action=login | ?action=logout | ?action=me
│       │                                # (previously three separate files: login.js, logout.js, me.js)
│       ├── campaigns.js                # Protected: create/edit/delete/list campaigns, safe image
│       │                                # lifecycle, PLUS ?route=analytics (dashboard overview numbers)
│       │                                # and ?route=upload-image (patient photo upload) — previously
│       │                                # three separate files: campaigns.js, analytics.js, upload-image.js
│       └── beneficiaries.js            # Protected: view/save a campaign's beneficiary (full or masked),
│                                        # PLUS ?route=banks (Paystack bank list), ?route=verify (Paystack
│                                        # account verification + subaccount creation), ?route=settlement
│                                        # (enable/pause), and ?route=platform-fee (the master switch) —
│                                        # previously five separate files: beneficiaries.js, banks.js,
│                                        # verify-beneficiary.js, settlement.js, platform-fee.js
├── supabase.sql                     # Full schema: tables, migrations, storage bucket — always safe to re-run
└── README.md                        # This file
```

## Environment variables reference
| Variable | Where it's used | Keep secret? |
|---|---|---|
| `PAYSTACK_PUBLIC_KEY` | Configured but not currently used by the frontend (see note above) | No — safe to expose |
| `PAYSTACK_SECRET_KEY` | `api/paystack-webhook.js`, `api/initialize-donation.js`, `lib/paystack.js` | **Yes** |
| `SUPABASE_URL` | All API functions | No, but kept server-side anyway |
| `SUPABASE_SERVICE_ROLE_KEY` | All API functions — reads/writes database & storage | **Yes** |
| `ADMIN_USERNAME` | `api/admin/auth.js` (login) | **Yes** |
| `ADMIN_PASSWORD` | `api/admin/auth.js` (login) | **Yes** |
| `ADMIN_SESSION_SECRET` | `lib/admin-auth.js` — signs login sessions | **Yes** |

**No new Vercel environment variables are required** for this update —
platform fee and settlement logic reuse the existing
`PAYSTACK_SECRET_KEY` and Supabase credentials.

---

## Image lifecycle safety (unchanged)
- **Creating a campaign**: if the photo uploads but the campaign row
  fails to save, the photo is automatically deleted.
- **Replacing a photo**: the new photo is saved and the campaign row is
  updated *first* — the old photo is only deleted *after* success.
- **Deleting a campaign**: removes the row, its donation history, and
  its photo — never another campaign's.

## A note on admin dashboard security
The dashboard checks your login on every page load and every API call.
Keep `ADMIN_PASSWORD` and `ADMIN_SESSION_SECRET` long and unique.

---

## Notes for beginners
- GitHub, Supabase, and Vercel all work through their websites in Chrome
  — no terminal needed.
- If a donation doesn't show up, double-check the Paystack webhook URL
  matches your Vercel domain exactly.
- If creating/editing a campaign fails with a `PGRST204` "column not
  found" error, re-run the full `supabase.sql` file.
- If "Verify with Paystack" fails, the error shown comes directly from
  Paystack (e.g. invalid account number/bank code) — double-check and
  retry.
- If a donor reports being "stuck" after paying, remember the webhook
  (not the redirect) is the source of truth — check Vercel's function
  logs for `api/paystack-webhook` if a payment doesn't reflect within a
  minute or two.
