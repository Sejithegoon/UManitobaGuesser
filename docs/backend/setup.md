# Backend setup (Phase 2)

Nothing in this phase changes the live website. These steps create and fill the database only.

## A. Create the Supabase project (you, in the dashboard)

1. Go to <https://supabase.com/dashboard> and click **New project**.
   - **Name**: `umanitoba-guesser`.
   - **Database password**: click *Generate*. Store it in your password manager only, and don't paste it into chat or any file in the repo.
   - **Region**: **Canada (Central)** (`ca-central-1`).
   - **Plan**: Free.
   - If you're offered *"Automatically expose new tables"*, leave it **unchecked**. The migrations add the exact grants needed.
2. Once it's ready, make these settings until Phase 4:
   - **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up", and leave **Anonymous sign-ins off**. Nobody should be able to create accounts with the public key yet.
3. **Settings → API Keys**: you'll see a **publishable** key (`sb_publishable_…`, public) and a **secret** key (`sb_secret_…`).
   - The secret key isn't needed in Phase 2. Never share it.

**What I need from you, and only this, since all of it is public information:**
- the **project ref** (the `xxxx` in `https://xxxx.supabase.co`)
- optionally, the project URL and the publishable key, for Phase 3

Never send the database password, the secret key or an access token.

## B. Local environment (your machine)

```bash
cp .env.example .env
```

Fill in `.env` with your values. `.env` is git-ignored.

## C. Decide the duplicate location first

`locations.json` has **two different `ENG11` entries**, about 9 m apart, sharing one photo. Pick the correct one, then either:
- fix `locations.json` (a change to the live game file, which is your call), or
- import with `--duplicates first` or `--duplicates last`.

## D. Apply the migrations (Supabase CLI via npx, no global install)

```bash
npx supabase@latest login
npx supabase@latest link --project-ref YOUR_PROJECT_REF
npx supabase@latest db push --dry-run
npx supabase@latest db push
```

- `link` asks for the database password; type it into the prompt.
- `db push --dry-run` lists the 3 migrations it would apply and changes nothing. Read the list before the real push.

## E. Import the locations

```bash
python supabase/scripts/import_locations.py --duplicates first
```

This validates the data and writes `supabase/seed/locations.local.sql`, which is git-ignored. Apply it with **one** of these:

- **psql** (if installed): `psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/seed/locations.local.sql`
- **Dashboard → SQL Editor**: paste the file's contents and run it.

Either way, it ends with `location import OK: 86 rows verified` (or 85 if you fix the duplicate by deleting an entry). Re-running is safe.

## F. Tests

**Never run the test suite against the production project.** `00_helpers.sql` installs a `tests` schema.

- **Offline (no Docker), as used for Phase 2:** see the header of `supabase/tests/pglite/run-pglite.mjs`.
  ```bash
  node supabase/tests/pglite/run-pglite.mjs --seed path/to/locations.local.sql
  ```
- **Full Supabase stack (needs Docker Desktop):**
  ```bash
  npx supabase@latest start
  npx supabase@latest db reset
  npx supabase@latest test db
  ```

## G. Before merging to `main` (decision needed)

GitHub Pages publishes **every file in the repo**. Once merged, `supabase/` and `docs/` would be reachable on umanitobaguesser.ca:
- The migrations and docs contain no secrets. RLS design being public is normal.
- The generated seed (coordinates) is git-ignored.

To keep the site minimal, add a `_config.yml` with `exclude: [supabase, docs, .env.example]`. The site has no `.nojekyll`, so GitHub Pages' Jekyll build honours it. That changes deployment behaviour, so it needs your OK.
