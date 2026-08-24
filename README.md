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
   story, live progress bar, and the Donate button.
3. Donating opens the Paystack popup with the campaign's `id` attached as
   metadata, so the webhook knows exactly which patient to credit.
4. Paystack calls `/api/paystack-webhook` after a real payment. The
   webhook verifies it, records it in `donations`, and updates only that
   one campaign's totals.

**Admin dashboard** (`admin/login.html` → `admin/dashboard.html`)
1. Log in with a username/password stored as Vercel environment
   variables — never in the database.
2. Create, edit, archive, or delete campaigns.
3. Upload a patient photo directly from your phone — it's stored in
   Supabase Storage and the public URL is saved automatically.
4. See total patients, active campaigns, total raised, total donors, and
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
   (including `api/admin/`), and the whole `lib/` folder.
   - Chrome may only let you pick files a few at a time — that's fine,
     just repeat the upload step until every file is added, keeping the
     same folder names.
3. Scroll down and tap **Commit changes**.

### 3. Create a Supabase project
1. Go to [supabase.com](https://supabase.com) and sign up / log in.
2. Tap **New project**. Choose a name, set a database password (save it
   somewhere safe), and pick the region closest to your donors.
3. Wait 1–2 minutes for the project to finish setting up.

### 4. Run `supabase.sql`
1. In your Supabase project, open the left menu → **SQL Editor** → **New
   query**.
2. Open `supabase.sql` from your GitHub repo, copy all of it, and paste it
   into the SQL Editor.
3. Tap **Run**. This creates the `fundraiser` and `donations` tables,
   migrates the original Lucy campaign so it still works, sets up the
   `campaign-images` storage bucket, and makes campaign photos publicly
   viewable. It's safe to run even if you already ran an older version of
   this file — everything uses `if not exists` / safe backfills.

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
3. Tap **+ New Campaign**, fill in the patient's details, upload their
   photo, and tap **Save Campaign**. It appears on the homepage
   immediately.
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
│   └── admin-auth.js               # Shared login-session helper used by admin APIs
├── api/
│   ├── campaigns.js                # Public: list active campaigns (+ search)
│   ├── campaign.js                 # Public: fetch one campaign by slug
│   ├── progress.js                 # Public: live totals for one campaign (or the first, if none specified)
│   ├── paystack-webhook.js         # Verifies + records real payments, per campaign
│   └── admin/
│       ├── login.js                 # Checks credentials, issues session cookie
│       ├── logout.js                # Clears session cookie
│       ├── me.js                    # Lets dashboard.html check if you're logged in
│       ├── campaigns.js             # Protected: create / edit / delete / list campaigns
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
  side) `raised_amount` / `donor_count`.
- Every successful payment is one row in `donations`, linked to the
  campaign it belongs to via `fundraiser_id`, and keyed by Paystack's
  unique `paystack_reference` so a retried webhook can never double-count
  a donation.
- Patient photos live in the `campaign-images` Supabase Storage bucket,
  uploaded through the admin dashboard — you never need to touch GitHub
  or Supabase's file browser to add a new photo.

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
