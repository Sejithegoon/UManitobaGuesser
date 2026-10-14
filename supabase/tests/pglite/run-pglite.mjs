// Offline database test runner using PGlite (Postgres compiled to WebAssembly).
// For machines without Docker / the Supabase CLI. The authoritative run is
// still `supabase test db` against a real Supabase stack.
//
// Setup (once, outside the repo):
//   mkdir %TEMP%\pglite && cd %TEMP%\pglite && npm init -y && npm i @electric-sql/pglite
// Run (from the project folder):
//   set PGLITE_DIR=%TEMP%\pglite                (PowerShell: $env:PGLITE_DIR="$env:TEMP\pglite")
//   python supabase/scripts/import_locations.py --duplicates first --out %TEMP%\locations.sql
//   node supabase/tests/pglite/run-pglite.mjs --seed %TEMP%\locations.sql
//
// Exit code 0 = every test passed.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const supa = join(root, 'supabase');

const args = process.argv.slice(2);
const seedArg = args.includes('--seed') ? args[args.indexOf('--seed') + 1] : null;

const pgliteDir = process.env.PGLITE_DIR;
const { PGlite } = await import(pgliteDir
  ? pathToFileURL(join(pgliteDir, 'node_modules', '@electric-sql', 'pglite', 'dist', 'index.js')).href
  : '@electric-sql/pglite');

const db = new PGlite();
const read = (p) => readFileSync(p, 'utf8');
const sqlFiles = (dir) => readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

const ver = (await db.query('select version()')).rows[0].version;
console.log(`# ${ver.split(',')[0]}`);

// 1. Supabase stand-in + pgTAP subset
await db.exec(read(join(here, 'supabase-shim.sql')));
await db.exec(read(join(here, 'pgtap-shim.sql')));
await db.exec('set search_path to public, tap');

// 2. Migrations, in order, exactly as written
for (const f of sqlFiles(join(supa, 'migrations'))) {
  await db.exec(read(join(supa, 'migrations', f)));
  console.log(`# applied migration ${f}`);
}

// 3. Optional: the real location import (validates the generated SQL against the schema)
if (seedArg) {
  const res = await db.exec(read(seedArg));
  const n = (await db.query('select count(*)::int as n from public.locations')).rows[0].n;
  console.log(`# location import applied: ${n} rows in public.locations`);
  // Idempotency: running it a second time must not change anything
  const before = (await db.query('select legacy_name, public_key, lat, lng from public.locations order by 1')).rows;
  await db.exec(read(seedArg));
  const after = (await db.query('select legacy_name, public_key, lat, lng from public.locations order by 1')).rows;
  console.log(`# location import re-run: ${JSON.stringify(before) === JSON.stringify(after) ? 'no changes (idempotent)' : 'CHANGED ROWS (not idempotent!)'}`);
}

// 4. Test files
let total = 0, failed = 0, fileErrors = 0;
for (const f of sqlFiles(join(supa, 'tests', 'database'))) {
  console.log(`\n# ${f}`);
  try {
    const results = await db.exec(read(join(supa, 'tests', 'database', f)));
    for (const r of results) for (const row of r.rows) for (const v of Object.values(row)) {
      if (typeof v !== 'string' || !/^(not ok|ok |1\.\.|#)/.test(v)) continue;
      console.log(v);
      if (v.startsWith('ok ')) total++;
      if (v.startsWith('not ok')) { total += /^not ok \d/.test(v) ? 1 : 0; failed++; }
    }
  } catch (e) {
    fileErrors++;
    console.log(`not ok - ${f} aborted: ${e.message}`);
    try { await db.exec('rollback'); } catch { /* not in a transaction */ }
  }
}

console.log(`\n# ${total} assertions, ${failed} failed, ${fileErrors} file errors`);
await db.close();
process.exit(failed || fileErrors ? 1 : 0);
