# Poolie — 58-Point Pool Health Inspection

A single-page web app your techs open on a phone, fill out in the field, and submit. Reports and
photos go straight into Supabase. Static files only, so GitHub Pages can host it for free.

- **Supabase project:** `58 Point Pool Exam` (`jlelvhhypwwkrkjxyewc`) — already set up.
- **Files:** `index.html` (the inspection app), `pool-review.js` (the Pool Review tab), `config.js`
  (connection settings), `supabase/pool_review.sql` (tables for the Pool Review tab).

## Where data goes

| What | Where |
|---|---|
| The report (all 58 ratings, chemistry values, yes/no answers, every notes box) | `public.inspections`, one row per submission |
| Photo records (category, caption, filename, size) | `public.inspection_photos` |
| The photo files | Storage bucket `inspection-photos` |

Each submission gets its own folder, named with the inspection's UUID, with a subfolder per photo
category:

```
inspection-photos/
└── inspections/
    └── 6b1f2f8a-…-4c9d/          ← one inspection
        ├── equipment_pad/001-pad_wide.jpg
        ├── full_pool/001-pool.jpg
        ├── entrance/001-gate.jpg
        ├── signs_markers/001-depth_marker.jpg
        ├── access_area/001-side_gate.jpg
        └── additional/001-cracked_tile.jpg
```

The folder path is stored on the row (`storage_folder`), so a report and its photos never drift
apart. There is no cap on photos — techs tap **+ Add photos** as many times as they like in any
category, and each photo can carry a caption.

## Deploy to GitHub Pages

1. Create a repo (public or private — Pages works with both on paid plans; public is fine here, see
   the security note below) and push these files to the root of the `main` branch.
2. Repo → **Settings → Pages** → Source: *Deploy from a branch*, Branch: `main`, folder `/ (root)`.
3. Wait a minute, then open `https://<your-org>.github.io/<repo>/`.
4. In Supabase → **Authentication → URL Configuration**, add that Pages URL to **Site URL** and
   **Redirect URLs**. This is only needed for the "email me a sign-in link" button.

Any other static host works the same way (Netlify, Vercel, Cloudflare Pages, or Supabase's own
hosting). To test on your laptop first: `python3 -m http.server 8000` in this folder, then open
`http://localhost:8000`.

## Adding staff accounts

Everything is locked behind a login — nobody can read or write without one.

1. Supabase dashboard → **Authentication → Users → Add user**.
2. Enter the tech's email and a password, and tick **Auto Confirm User**.
3. Send them the Pages link and their password. Sessions persist, so they sign in once per device.

Optional: under **Authentication → Providers → Email**, turn **Enable signups** off so only you can
create accounts. Turn it back on briefly if you'd rather have techs self-register.

## Notes for whoever maintains this

- The publishable key in `config.js` is meant to be public. It grants nothing on its own — every
  table and storage policy requires an authenticated user.
- Photos are downscaled to 2200px / JPEG 82% on the phone before upload, which keeps a 50-photo
  inspection to a few hundred MB of bandwidth instead of several GB. Files under 600 KB are sent
  untouched. The bucket caps any single file at 50 MB.
- The form autosaves a draft to the phone's local storage as it's filled in, so a dropped connection
  or an accidental tab close doesn't lose an hour of work. Photos aren't part of the draft.
- The **Inspection Log** tab lists everything submitted by anyone, with search, a detail view
  (including the photos, via one-hour signed URLs), and **Export CSV** for the whole log.
- Techs can edit or delete only their own submissions; everyone can read everything. To let a
  manager edit anyone's, change the `staff update own inspections` policy in `supabase/schema.sql`.
- Checklist items live at the top of the `<script>` block in `index.html` (`chemistry`, `surface`,
  `equipment`, `safety`, `commercial`, `surrounding`, `PHOTO_CATEGORIES`). Add or rename items there;
  the point count in the title recalculates itself. Old rows keep the wording they were saved with,
  since each row stores its own item names.
- Free-tier Supabase includes 1 GB of storage. A busy season of photo-heavy inspections will pass
  that — watch **Reports → Storage** and upgrade when it gets close.

## Pool Review tab

The third tab reviews a client's property list before a bid (first list: NRP Group, 47 properties,
due October 2, 2026). For each property it shows:

- **58-point exam results**, pulled from `inspections`. A property links automatically to the newest
  inspection whose Property Name (or Customer) matches the property's name; pick a different one
  from the "Inspection on file" menu if the match is wrong. Section scores, chemistry readings,
  notes, a "Needs attention" list of failed/caution items, and the inspection's photos all come
  straight from what the tech submitted.
- **Category 0–5** and **Inspection Result** (Fail / At risk / Pass), set by the reviewer.
- **Poolbrain link** next to the property name.
- **Service pricing**: April–October 3x/week and November–March 2x/week monthly prices; yearly is
  7 × the 3x price + 5 × the 2x price.
- **Summary** and **Repairs / Renovations / Maintenance needed** boxes.
- **Photos**: drag and drop (or Choose photos) to add any number at once, filed by category.

Everything saves automatically and shows up live for anyone else who has the tab open.

| What | Where |
|---|---|
| The property list | `public.pool_review_properties` (edit or add rows in the Supabase table editor) |
| Category, result, pricing, notes, Poolbrain link | `public.pool_reviews`, one row per property |
| Review photo records | `public.pool_review_photos` |
| Review photo files | bucket `inspection-photos`, under `reviews/<property_id>/<category>/` |

To add another client's list later, insert rows into `pool_review_properties` with a different
`client` value and a unique `id`. Any signed-in staff member can edit reviews and delete review
photos; inspection photos stay owner-only as before.
