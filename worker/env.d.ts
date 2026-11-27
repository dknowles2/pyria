import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { Env } from './types';

declare global {
  namespace Cloudflare {
    interface Env extends _PyriaTestEnv {}
  }
}

type _PyriaTestEnv = Env & {
  TEST_MIGRATIONS: D1Migration[];
};
