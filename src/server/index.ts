import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { seedDemo } from './demo.js';
import { Store } from './store.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const store = new Store(process.env.DATABASE_PATH ?? 'data/verdict.db');

if (process.env.SEED_DEMO === 'true' && store.listFlags().length === 0) {
  seedDemo(store);
}

const app = buildApp({
  store,
  adminToken: process.env.VERDICT_ADMIN_TOKEN || undefined,
  staticDir: resolve('web/dist'),
  logger: true,
});

app.listen({ port, host }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
