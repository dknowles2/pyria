import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig(async () => {
  const migrationsPath = path.join(import.meta.dirname, 'migrations');
  const migrations = await readD1Migrations(migrationsPath);

  return {
    test: {
      include: ['worker/**/*.test.ts'],
    },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            PYRIA_SESSION_SECRET: 'test-session-secret-at-least-32-bytes-long-0123456789',
            PYRIA_ADMIN_EMAILS: 'admin@pyria.test',
            GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
            GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
          },
        },
      }),
    ],
  };
});
