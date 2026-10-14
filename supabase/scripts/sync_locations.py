#!/usr/bin/env python3
"""
sync_locations.py - one command to get new/changed locations live.

    python supabase/scripts/sync_locations.py            # prepare only
    python supabase/scripts/sync_locations.py --publish  # prepare + push + update database

Prepare (safe, local only):
  1. validate locations/locations.json and the photos (same rules as import_locations.py)
  2. write supabase/seed/locations.local.sql        (git-ignored, has coordinates)
  3. make resized, renamed photo copies in locations/p/ + supabase/seed/photo_keys.local.sql

Publish (needs: git push access, and `npx supabase@latest login` + `link` done once):
  4. git add + commit + push the photo and location files
  5. wait until umanitobaguesser.ca serves the new photo copies
  6. run both SQL files on the linked Supabase project (`supabase db query --linked`)

Exit code 0 = everything succeeded. Used by the Discord bot.
"""
import argparse
import json
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

# Windows consoles default to cp1252; keep emoji/arrows from crashing the output
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

sys.path.insert(0, str(Path(__file__).resolve().parent))
from import_locations import ROOT, build_sql, load_and_validate  # noqa: E402

SITE = 'https://umanitobaguesser.ca'
SEED = ROOT / 'supabase' / 'seed'
LOC_SQL = SEED / 'locations.local.sql'
KEYS_SQL = SEED / 'photo_keys.local.sql'
KEYS_JSON = SEED / 'photo_keys.local.json'
PUBLISH_PATHS = ['locations/IMG', 'locations/locations.json', 'locations/p']


def step(msg):
    print(f'\n▶ {msg}', flush=True)


def run(cmd, check=True):
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise SystemExit(f'✗ {" ".join(cmd[:4])}… failed:\n{(r.stderr or r.stdout).strip()[-1500:]}')
    return r


def prepare():
    step('Checking locations.json and photos')
    rows, missing, _ = load_and_validate('fail')
    if missing:
        raise SystemExit(f'✗ No photo in locations/IMG for: {", ".join(missing)}')
    print(f'  {len(rows)} locations OK')

    step('Writing the database import')
    SEED.mkdir(parents=True, exist_ok=True)
    LOC_SQL.write_text(build_sql(rows), encoding='utf-8', newline='\n')

    step('Making photo copies')
    run([sys.executable, str(ROOT / 'supabase' / 'scripts' / 'build_photos.py')])
    print('  done')
    return rows


def changed_files():
    r = run(['git', 'status', '--porcelain', '--', *PUBLISH_PATHS])
    return [line[3:].strip().strip('"') for line in r.stdout.splitlines() if line.strip()]


def wait_for_site(new_photos, timeout_s=360):
    if not new_photos:
        return
    step(f'Waiting for the website to publish {len(new_photos)} new photo(s)')
    deadline = time.time() + timeout_s
    pending = set(new_photos)
    while pending and time.time() < deadline:
        for p in list(pending):
            try:
                with urllib.request.urlopen(f'{SITE}/{p}?nc={int(time.time())}', timeout=10) as r:
                    if r.status == 200:
                        pending.discard(p)
            except Exception:
                pass
        if pending:
            time.sleep(10)
    if pending:
        raise SystemExit('✗ The website did not update in time. Run this again in a few minutes.')
    print('  website is up to date')


def apply_sql():
    npx = shutil.which('npx')
    if not npx:
        raise SystemExit('✗ npx (Node.js) not found.')
    for f in (LOC_SQL, KEYS_SQL):
        step(f'Updating the database: {f.name}')
        r = run([npx, '--yes', 'supabase@latest', 'db', 'query', '--linked', '-f', str(f)], check=False)
        out = (r.stdout + r.stderr)
        if r.returncode != 0 or 'ERROR' in out:
            raise SystemExit(f'✗ Database update failed:\n{out.strip()[-1500:]}')
        print('  done')


def publish(names_added):
    files = changed_files()
    if not files:
        print('\nNothing new to publish: the website already has these files.')
    else:
        step(f'Pushing {len(files)} file(s) to GitHub')
        run(['git', 'add', '--', *PUBLISH_PATHS])
        label = ', '.join(names_added[:6]) + ('…' if len(names_added) > 6 else '') if names_added else 'location updates'
        run(['git', 'commit', '-m', f'Add/update locations: {label}'])
        run(['git', 'push'])
        print('  pushed')
        wait_for_site([f for f in files if f.startswith('locations/p/') and f.endswith('.jpg')])
    apply_sql()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--publish', action='store_true', help='also push to GitHub and update the database')
    args = ap.parse_args()

    before = set(json.loads(KEYS_JSON.read_text(encoding='utf-8'))) if KEYS_JSON.exists() else set()
    rows = prepare()
    added = sorted({n for n, _, _ in rows} - before)
    if added:
        print(f'\n  New: {", ".join(added)}')

    if args.publish:
        publish(added)
        print('\n✅ Live: new locations are in the game.')
    else:
        print('\n✅ Prepared. Run with --publish (or ./ publish in Discord) to go live.')


if __name__ == '__main__':
    main()
