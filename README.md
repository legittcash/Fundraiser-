# Help Lucy Fight Breast Cancer — Fundraising Website

A real, working fundraising page that accepts **real Paystack payments** and
automatically updates a live progress bar. Built with plain HTML/CSS/JS,
Vercel Serverless Functions, and Supabase.

> ⚠️ Before going live: replace `images/lucy.jpg` with a real, permission-cleared
> photo, and use your **real** Paystack keys (not test keys) once you're ready
> to accept real donations.

---

## How it works (quick overview)

1. `index.html` — the fundraising page. On load, it calls `/api/progress` to
   show the current amount raised, goal, percentage, and donor count.
2. When someone clicks **Donate Now**, the Paystack popup opens using your
   **public** key (safe to expose).
3. After payment, Paystack calls `/api/paystack-webhook` on your server —
   this is the only step that is trusted to confirm money actually arrived.
4. The webhook verifies the request really came from Paystack, then updates
   the `fundraiser` row in Supabase (adds to `raised_amount`, `donor_count`).
5. Next time `/api/progress` is called, it returns the new numbers, and the
   green bar animates to the new percentage.

---

## Step-by-step deployment guide (Android phone only)

You do **not** need a laptop. Everything below can be done from Chrome on
an Android phone.

### 1. Create a GitHub repository
1. Open **Chrome** and go to [github.com](https://github.com), then sign in
   (or create a free account).
2. Tap the **+** icon (top right) → **New repository**.
3. Name it something like `lucy-fundraiser`. Set it to **Public** or
   **Private** — either works. Tap **Create repository**.

### 2. Upload the project files
1. On your new repo's page, tap **Add file** → **Upload files**.
2. Tap **choose your files**, and select all the files/folders from this
   project: `index.html`, `supabase.sql`, `README.md`, the `api` folder
   (with `progress.js` and `paystack-webhook.js`), and the `images` folder
   (with `lucy.jpg`).
   - Chrome may only let you pick files one at a time or per folder —
     that's fine, just repeat the upload step until everything is added.
3. Scroll down and tap **Commit changes**.

### 3. Create a Supabase project
1. Go to [supabase.com](https://supabase.com) and sign up / log in.
2. Tap **New project**. Choose a name (e.g. `lucy-fundraiser`), set a
   database password (save it somewhere safe), and pick the region closest
   to your donors.
3. Wait 1–2 minutes for the project to finish setting up.

### 4. Run `supabase.sql`
1. In your Supabase project, open the left menu → **SQL Editor**.
2. Tap **New query**.
3. Open `supabase.sql` from your GitHub repo (tap the file to view its raw
   content), copy all of it, and paste it into the SQL Editor.
4. Tap **Run**. You should see a success message. This creates the
   `fundraiser` table (and inserts the starting row: Goal ₦1,000, Raised ₦0,
   Donors 0) as well as a `donations` table, which records every individual
   payment by its unique Paystack reference. The webhook uses this table to
   make sure the same payment is never counted twice, even if Paystack
   retries a webhook delivery.

### 5. Copy your environment variables
You'll need 4 values total:

**From Supabase:**
1. Left menu → **Project Settings** → **API**.
2. Copy the **Project URL** → this is your `SUPABASE_URL`.
3. Copy the **service_role** secret key → this is your
   `SUPABASE_SERVICE_ROLE_KEY`. ⚠️ Keep this secret — never put it in the
   frontend code.

**From Paystack:**
1. Go to [dashboard.paystack.com](https://dashboard.paystack.com) and sign
   up / log in.
2. Left menu → **Settings** → **API Keys & Webhooks**.
3. Copy your **Public Key** → this is your `PAYSTACK_PUBLIC_KEY`.
4. Copy your **Secret Key** → this is your `PAYSTACK_SECRET_KEY`. ⚠️ Keep
   this secret too.
5. While you're on this page, also set the **Webhook URL** to:
   `https://YOUR-VERCEL-DOMAIN.vercel.app/api/paystack-webhook`
   (you'll get your actual Vercel domain in step 7 — come back and set
   this afterward).

### 6. Import your GitHub repo into Vercel
1. Go to [vercel.com](https://vercel.com) and sign up / log in (choose
   "Continue with GitHub" to connect your account easily).
2. Tap **Add New...** → **Project**.
3. Find and select your `lucy-fundraiser` repository, then tap **Import**.
4. Before deploying, open **Environment Variables** and add all 4:
   - `PAYSTACK_PUBLIC_KEY`
   - `PAYSTACK_SECRET_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`

### 7. Deploy
1. Tap **Deploy**. Wait 1–2 minutes.
2. Once done, Vercel gives you a live URL like
   `https://lucy-fundraiser.vercel.app`.
3. Go back to Paystack's webhook settings (step 5.5) and paste in:
   `https://lucy-fundraiser.vercel.app/api/paystack-webhook`

### 8. Show the public key on the page
Since this project intentionally avoids build tools for simplicity, add
your Paystack public key directly in `index.html` on GitHub:
1. Open `index.html` in your GitHub repo and tap the pencil (✏️) icon to
   edit.
2. Find this line near the bottom:
   ```js
   const PAYSTACK_PUBLIC_KEY = window.PAYSTACK_PUBLIC_KEY || 'REPLACE_WITH_YOUR_PAYSTACK_PUBLIC_KEY';
   ```
3. Replace `'REPLACE_WITH_YOUR_PAYSTACK_PUBLIC_KEY'` with your real public
   key (the one starting with `pk_`), keeping the quotes.
4. Commit the change — Vercel will automatically redeploy.

> The public key is safe to put directly in the frontend code — it's
> designed to be publicly visible. Only the **secret** key must stay in
> Vercel's environment variables, never in `index.html`.

### 9. Test with a real Paystack payment
1. Open your live Vercel URL on your phone.
2. Enter your email and a small amount (e.g. ₦100), tap **Donate Now**.
3. Complete payment using a real card (or Paystack's test cards while
   your account is still in test mode).
4. Within a few seconds, refresh the page — the amount raised, percentage,
   and donor count should have gone up, and the green bar should have
   grown.
5. Check Supabase → **Table Editor** → `fundraiser` to confirm the row was
   updated directly in the database.

---

## Replacing the placeholder photo
`images/lucy.jpg` currently contains a simple placeholder graphic labeled
"Replace this file with images/lucy.jpg". To use a real photo:
1. On GitHub, open the `images` folder → tap `lucy.jpg` → tap the trash icon
   to delete it (commit the deletion).
2. Tap **Add file** → **Upload files** → upload your new photo, making sure
   it's named exactly `lucy.jpg`.
3. Commit — Vercel redeploys automatically and the new photo appears.

---

## Project structure
```
lucy-fundraiser/
├── index.html                 # The fundraising page (frontend)
├── images/
│   └── lucy.jpg                # Hero photo (replace with a real one)
├── api/
│   ├── progress.js             # Returns live totals from Supabase
│   └── paystack-webhook.js     # Verifies + records real payments
├── supabase.sql                # Creates the fundraiser + donations tables
└── README.md                   # This file
```

## Environment variables reference
| Variable | Where it's used | Keep secret? |
|---|---|---|
| `PAYSTACK_PUBLIC_KEY` | Frontend (opens payment popup) | No — safe to expose |
| `PAYSTACK_SECRET_KEY` | `api/paystack-webhook.js` (verifies payments) | **Yes** |
| `SUPABASE_URL` | Both API functions | No — safe to expose, but kept server-side anyway |
| `SUPABASE_SERVICE_ROLE_KEY` | Both API functions (reads/writes database) | **Yes** |

---

## Notes for beginners
- You never need to install anything or use a terminal — GitHub, Supabase,
  and Vercel all work through their websites in Chrome.
- Every time you edit a file on GitHub and commit, Vercel automatically
  redeploys your site within about a minute.
- If a donation doesn't show up, double check that the Paystack webhook
  URL (step 5.5) exactly matches your Vercel domain, and that all 4
  environment variables in Vercel are spelled correctly.
