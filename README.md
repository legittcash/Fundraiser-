# Patient Fundraising Platform — with Admin Dashboard

A real, working fundraising platform that hosts **unlimited patient
campaigns**, accepts **real Paystack payments**, and updates each
campaign's progress bar live. You manage everything — creating patients,
uploading photos, archiving finished campaigns — from a password-protected
admin dashboard. No GitHub uploads or Supabase table editing required for
day-to-day use.

Built with plain HTML/CSS/JS, Vercel Serverless Functions, and Supabase.

> ⚠️ This started as a single campaign for "Lucy." That campaign still
> works and now lives at `campaign.html?slug=lucy` — see step 4's SQL for
> how it's migrated forward automatically.

---

## How it works (quick overview)

**Public site**
1. `index.html` — homepage listing every **active** campaign, with search.
2. `campaign.html?slug=...` — one patient's fundraising page: photo,
   story, live progress bar, Recent Donors list, and the Donate button.
3. The donation form asks for the donor's **name (required)** and an
   **optional email**, plus a **"Donate anonymously"** checkbox. Donating
   opens the Paystack popup with the donor's name/email/anonymous choice
   and the campaign's `id` attached as metadata, so the webhook knows
   exactly which patient to credit and who gave.
4. Paystack calls `/api/paystack-webhook` after a real payment. The
   webhook verifies it, records it in `donations` (including the donor's
   name and anonymity choice), and updates only that one campaign's
   totals.
5. The progress bar's fill is **capped at 100% visually**, even if a
   campaign raises more than its goal — the true amount raised is always
   shown as a number, and a "🎉 Goal Achieved" badge appears once the
   goal is met. Donations keep being accepted after the goal is reached.
6. `/api/donations` resolves "Anonymous" **on the server**, not in the
   browser — a donor's real name is never sent to the page at all if they
   asked to stay anonymous, and donor email is never exposed publicly.

**Admin dashboard** (`admin/login.html` → `admin/dashboard.html`)
1. Log in with a username/password stored as Vercel environment
   variables — never in the database.
2. Create, edit, archive, or delete campaigns. The admin's private view
   of recent donations shows real donor names/emails even for donations
   marked anonymous on the public page.
3. Each campaign also stores a **private** primary contact phone number
   (required for new campaigns) and an optional secondary phone number —
   used to reach the patient or their authorized contact. These are
   visible only in the admin dashboard's Edit form and are never sent to
   the public website in any form.
4. Upload a patient photo directly from your phone — it's stored in
   Supabase Storage and the public URL is saved automatically.
5. Photo lifecycle is handled safely everywhere: if creating a campaign
   fails after its photo already uploaded, the orphaned photo is deleted
   automatically; replacing a photo only removes the old one after the
   new one is confirmed saved; deleting a campaign also deletes its photo
   (and only its photo). If a storage cleanup step ever fails, the
   dashboard tells you clearly instead of pretending everything succeeded.
6. See total patients, active campaigns, total raised, total donors, and
   a feed of recent donations across every campaign.

---

## Step-by-step deployment guide (Android phone only)

You do **not** need a laptop. Everything below can be done from Chrome on
an Android phone.

### 1. Create a GitHub repository
1. Open **Chrome** and go to [github.com](https://github.com), then sign in
   (or create a free account).
2. Tap the **+** icon (top right) → **New repository**.
3. Name it something like `patient-fundraiser`. Tap **Create repository**.

### 2. Upload the project files
1. On your repo's page, tap **Add file** → **Upload files**.
2. Upload everything, preserving folders: `index.html`, `campaign.html`,
   `supabase.sql`, `README.md`, `images/lucy.jpg`, the whole `api/` folder
   (including `api/admin/`, and the newer `api/donations.js`), and the
   whole `lib/` folder (including the newer `lib/campaign-images.js`).
   - Chrome may only let you pick files a few at a time — that's fine,
     just repeat the upload step until every file is added, keeping the
     same folder names.
   - If you're updating an existing repo rather than starting fresh,
     double-check each of these newer files actually made it in:
     `api/donations.js`, `lib/campaign-images.js`. It's easy to upload a
     batch of files and miss one on a phone.
3. Scroll down and tap **Commit changes**.

### 3. Create a Supabase project
1. Go to [supabase.com](https://supabase.com) and sign up / log in.
2. Tap **New project**. Choose a name, set a database password (save it
   somewhere safe), and pick the region closest to your donors.
3. Wait 1–2 minutes for the project to finish setting up.

### 4. Run `supabase.sql`
1. In your Supabase project, open the left menu → **SQL Editor** → **New
   query**.
2. Open `supabase.sql` from your GitHub repo, copy **all** of it, and
   paste it into the SQL Editor.
3. Tap **Run**. This creates the `fundraiser` and `donations` tables
   (including `donor_name`/`anonymous` on `donations`, and the private
   `phone_number`/`secondary_phone_number` fields on `fundraiser`),
   migrates the original Lucy campaign so it still works, sets up the
   `campaign-images` storage bucket, and makes campaign photos publicly
   viewable. It's safe to run even if you already ran an older version of
   this file — everything uses `if not exists` / safe backfills, so
   re-running it after any update to this project (like this one) is
   always the right move if something seems to be missing.

### 4b. Double check the storage bucket exists
The SQL above creates the `campaign-images` bucket for you, but it's
worth confirming:
1. Left menu → **Storage**.
2. You should see a bucket called `campaign-images` marked **Public**.
3. If it's missing for any reason, tap **New bucket**, name it exactly
   `campaign-images`, toggle **Public bucket** on, and create it.

### 5. Copy your environment variables
You'll need **7** values total:

**From Supabase** (Left menu → **Project Settings** → **API**):
- **Project URL** → `SUPABASE_URL`
- **service_role** secret key → `SUPABASE_SERVICE_ROLE_KEY` ⚠️ keep secret

**From Paystack** ([dashboard.paystack.com](https://dashboard.paystack.com)
→ **Settings** → **API Keys & Webhooks**):
- **Public Key** → `PAYSTACK_PUBLIC_KEY`
- **Secret Key** → `PAYSTACK_SECRET_KEY` ⚠️ keep secret
- Set the **Webhook URL** to `https://YOUR-VERCEL-DOMAIN.vercel.app/api/paystack-webhook`
  (come back and set this after step 7, once you know your real domain)

**Choose these yourself** (these protect your admin dashboard):
- `ADMIN_USERNAME` → any username you like, e.g. `admin`
- `ADMIN_PASSWORD` → a strong, unique password — this is what guards your
  dashboard, so don't reuse a password from elsewhere
- `ADMIN_SESSION_SECRET` → a long random string used to sign login
  sessions. Easiest way to generate one on your phone: open Chrome, go to
  a password generator site, and generate a 40+ character random string.
  It doesn't need to be memorable — you'll never type it in, only paste it
  into Vercel once.

### 6. Import your GitHub repo into Vercel
1. Go to [vercel.com](https://vercel.com) and sign up / log in ("Continue
   with GitHub" is easiest).
2. Tap **Add New...** → **Project** → select your repo → **Import**.
3. Before deploying, open **Environment Variables** and add all 7:
   - `PAYSTACK_PUBLIC_KEY`
   - `PAYSTACK_SECRET_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `ADMIN_USERNAME`
   - `ADMIN_PASSWORD`
   - `ADMIN_SESSION_SECRET`

### 7. Deploy
1. Tap **Deploy**. Wait 1–2 minutes.
2. Vercel gives you a live URL like `https://patient-fundraiser.vercel.app`.
3. Go back to Paystack's webhook settings and paste in:
   `https://patient-fundraiser.vercel.app/api/paystack-webhook`

### 8. Show the public key on the pages
Since this project intentionally avoids build tools, the Paystack public
key is pasted directly into the frontend files (it's meant to be public —
only the **secret** key must stay hidden in Vercel).
1. On GitHub, open **`campaign.html`**, tap the pencil (✏️) icon.
2. Find this line:
   ```js
   const PAYSTACK_PUBLIC_KEY = window.PAYSTACK_PUBLIC_KEY || 'pk_test_...';
   ```
3. Replace the placeholder with your real public key (starting `pk_`),
   keeping the quotes, and commit.
4. Vercel automatically redeploys within about a minute.

### 9. Log in to your admin dashboard and create your first real campaign
1. Visit `https://YOUR-VERCEL-DOMAIN.vercel.app/admin/login.html`.
2. Log in with the `ADMIN_USERNAME` / `ADMIN_PASSWORD` you set in step 5.
3. Tap **+ New Campaign**, fill in the patient's details — including a
   **primary contact phone number**, which is required for every new
   campaign — upload their photo, and tap **Save Campaign**. It appears
   on the homepage immediately. The phone number(s) stay private and are
   never shown on the public page.
4. To retire a campaign once its goal is met, tap **Archive** — it stays
   viewable by direct link but disappears from the homepage list.

### 10. Test with a real Paystack payment
1. Open a campaign from your homepage.
2. Enter an email and a small amount (e.g. ₦100), tap **Donate Now**, and
   complete payment (use Paystack's test cards while your account is
   still in test mode).
3. Within a few seconds, refresh — that campaign's raised amount, percent,
   and donor count should update, and it should also show up under
   **Recent Donations** in the admin dashboard.

---

## Project structure
```
patient-fundraiser/
├── index.html                    # Public homepage: lists active campaigns, search
├── campaign.html                 # Public page for one patient's campaign
├── admin/
│   ├── login.html                 # Admin login form
│   └── dashboard.html             # Manage campaigns, view analytics
├── images/
│   └── lucy.jpg                   # Fallback image used if a campaign has no photo
├── lib/
│   ├── admin-auth.js               # Shared login-session helper used by admin APIs
│   └── campaign-images.js          # Shared helper: safely delete/roll back campaign photos in Storage
├── api/
│   ├── campaigns.js                # Public: list active campaigns (+ search) — explicit column list, no private fields
│   ├── campaign.js                 # Public: fetch one campaign by slug — explicit column list, no private fields
│   ├── donations.js                # Public: recent donors for one campaign (anonymity resolved server-side)
│   ├── progress.js                 # Public: live totals for one campaign (or the first, if none specified)
│   ├── paystack-webhook.js         # Verifies + records real payments, per campaign, with donor name/anonymity
│   └── admin/
│       ├── login.js                 # Checks credentials, issues session cookie
│       ├── logout.js                # Clears session cookie
│       ├── me.js                    # Lets dashboard.html check if you're logged in
│       ├── campaigns.js             # Protected: create / edit / delete / list campaigns, incl. private phone numbers, with safe image lifecycle
│       ├── upload-image.js          # Protected: uploads a patient photo to Supabase Storage
│       └── analytics.js             # Protected: dashboard overview numbers
├── supabase.sql                   # Full schema: tables, migration, storage bucket
└── README.md                      # This file
```

## Environment variables reference
| Variable | Where it's used | Keep secret? |
|---|---|---|
| `PAYSTACK_PUBLIC_KEY` | Frontend (`campaign.html`) — opens payment popup | No — safe to expose |
| `PAYSTACK_SECRET_KEY` | `api/paystack-webhook.js` — verifies payments | **Yes** |
| `SUPABASE_URL` | All API functions | No, but kept server-side anyway |
| `SUPABASE_SERVICE_ROLE_KEY` | All API functions — reads/writes database & storage | **Yes** |
| `ADMIN_USERNAME` | `api/admin/login.js` | **Yes** |
| `ADMIN_PASSWORD` | `api/admin/login.js` | **Yes** |
| `ADMIN_SESSION_SECRET` | `lib/admin-auth.js` — signs login sessions | **Yes** |

---

## How campaigns, donations, and images fit together
- Every patient is one row in the `fundraiser` table: name, hospital,
  diagnosis, story, photo URL, goal, and (read-only from the admin's
  side) `raised_amount` / `donor_count`. It also stores two **private**
  contact fields — `phone_number` (required for new campaigns) and
  `secondary_phone_number` (optional) — used only by the admin.
- Every successful payment is one row in `donations`, linked to the
  campaign it belongs to via `fundraiser_id`, and keyed by Paystack's
  unique `paystack_reference` so a retried webhook can never double-count
  a donation. Each row also stores the donor's name, their optional
  email, and whether they asked to stay anonymous.
- Patient photos live in the `campaign-images` Supabase Storage bucket,
  uploaded through the admin dashboard — you never need to touch GitHub
  or Supabase's file browser to add a new photo.

## Donor privacy
- Donor **name is required**; donor **email is optional** — Paystack
  still requires some email to process the transaction, so a harmless
  placeholder is used internally when a donor leaves it blank, but that
  placeholder is never saved as if it were their real email.
- If a donor ticks **"Donate anonymously,"** their real name is still
  saved privately in `donations` (so you, the admin, always know who
  gave), but `/api/donations` — the endpoint the public campaign page
  uses — resolves them to `"Anonymous"` **on the server**. Their real
  name is never even sent to the browser in that case.
- Donor email is never included in any public-facing response, anonymous
  or not.

## Private contact phone numbers
Each campaign has two contact fields meant for the admin's own follow-up
with the patient or their authorized contact — **never for donors or the
public**:
- **Primary phone number** — required when creating a new campaign
  (e.g. `08012345678` or `+2348012345678`). Both local Nigerian formats
  and international `+` formats are accepted as plain text; there's no
  format restriction beyond "not empty."
- **Secondary phone number** — always optional. Can be added, changed, or
  cleared at any time from the Edit form.
- Both are stored as plain **text** columns (never numeric), since phone
  numbers can start with a leading zero or `+` and are never used in math.
- Existing campaigns created before this feature existed (including the
  original "Lucy" campaign) simply have a blank phone number on file —
  they remain fully editable, and the admin is never forced to fill one
  in just to save an otherwise-unrelated edit.
- These two fields are only ever selected by admin-only endpoints
  (`api/admin/campaigns.js`). The public endpoints (`api/campaign.js`,
  `api/campaigns.js`) select an explicit, named list of columns — never
  `*` — specifically so a private field can never leak onto the public
  site just because it exists in the table.

## Image lifecycle safety
Because campaign photos are uploaded to Supabase Storage in a separate
step from saving the campaign itself, a few safeguards keep the bucket
and the database from drifting apart:
- **Creating a campaign**: if the photo uploads successfully but the
  campaign row then fails to save (e.g. a duplicate slug, or a database
  error), the just-uploaded photo is automatically deleted so it doesn't
  sit in Storage with nothing pointing to it.
- **Replacing a photo**: the new photo is uploaded and the campaign row
  is updated *first* — the old photo is only deleted from Storage
  *after* that update is confirmed successful. If the update fails for
  any reason, the old photo is left completely untouched.
- **Deleting a campaign**: removes the campaign row (and its donation
  history) *and* its photo from Storage — but only that campaign's own
  photo, never another campaign's.
- If a Storage cleanup step ever fails on its own (rare, but possible),
  the admin dashboard shows a clear warning telling you a manual cleanup
  in Supabase Storage may be needed, rather than silently claiming
  everything succeeded.

## A note on admin dashboard security
The dashboard checks your login on every page load and every API call —
without a valid session, no campaign data or actions are available. Since
this project deliberately avoids build tools, the dashboard's HTML/CSS
shell itself is a public file (like everything on the internet), but it's
empty and non-functional without logging in first. For extra peace of
mind, keep your `ADMIN_PASSWORD` and `ADMIN_SESSION_SECRET` long and
unique, and consider enabling Vercel's built-in deployment protection
features for another layer of defense.

---

## Notes for beginners
- You never need to install anything or use a terminal — GitHub,
  Supabase, and Vercel all work through their websites in Chrome.
- Every time you edit a file on GitHub and commit, Vercel automatically
  redeploys your site within about a minute.
- If a donation doesn't show up, double-check that the Paystack webhook
  URL matches your Vercel domain exactly, and that `campaign.html`'s
  Paystack popup is passing `metadata.fundraiser_id` (it does this
  automatically — no changes needed unless you've customized the file).
- If uploading a photo fails, make sure the `campaign-images` bucket
  exists in Supabase Storage and is marked **Public** (step 4b).
- If creating or editing a campaign fails with a message like *"Could not
  find the '...' column of 'fundraiser' in the schema cache"* (Postgres
  error code `PGRST204`), it means `supabase.sql` hasn't been (re-)run
  against your database — go back to step 4 and run the full file again.
  It's always safe to re-run.
