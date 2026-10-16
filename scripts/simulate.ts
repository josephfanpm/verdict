/**
 * Populate the local database with demo experiments and print each verdict.
 *
 *   npm run simulate            # seed into data/verdict.db
 *   npm run simulate -- --reset # wipe the database first
 */
import { rmSync } from 'node:fs';
import { analyze } from '../src/core/analyze.js';
import { seedDemo } from '../src/server/demo.js';
import { Store } from '../src/server/store.js';

const path = process.env.DATABASE_PATH ?? 'data/verdict.db';
if (process.argv.includes('--reset')) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
}

const started = performance.now();
const store = new Store(path);
seedDemo(store);
const seededIn = Math.round(performance.now() - started);

console.log(`Seeded ${path} in ${seededIn} ms\n`);
for (const flag of store.listFlags()) {
  const report = analyze(flag, store.variantCounts(flag.key, flag.primaryMetric));
  console.log(`${report.verdict.kind.padEnd(13)} ${flag.key.padEnd(22)} ${report.totalExposures.toLocaleString('en-US').padStart(7)} users  ${report.verdict.headline}`);
}
store.close();
