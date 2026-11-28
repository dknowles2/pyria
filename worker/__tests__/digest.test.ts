import { applyD1Migrations, env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PARENT_SESSION_COOKIE,
  PARENT_SESSION_TTL_SECONDS,
  signToken,
} from '../crypto';
import { PyriaD1 } from '../db';
import {
  createUnsubscribeToken,
  getIsoWeekKey,
  runWeeklyDigestJob,
  verifyUnsubscribeToken,
} from '../digest';
import {
  CloudflareEmailBindingSender,
  type EmailMessage,
  type EmailSender,
  HttpApiEmailSender,
  buildRawMimeMessage,
} from '../email';
import workerDefault from '../index';
import type { ParentSessionPayload } from '../types';

const BASE = 'https://pyria.test';

async function makeParentCookie(email: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + PARENT_SESSION_TTL_SECONDS;
  const token = await signToken(
    { typ: 'parent', email, exp } satisfies ParentSessionPayload,
    env.PYRIA_SESSION_SECRET!
  );
  return `${PARENT_SESSION_COOKIE}=${token}`;
}

async function apiJson(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string | null;
    headers?: Record<string, string>;
  } = {}
): Promise<{ res: Response; data: any }> {
  const headers: Record<string, string> = {
    Origin: BASE,
    ...(options.headers || {}),
  };
  if (options.cookie) {
    headers.Cookie = options.cookie;
  }
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  const res = await SELF.fetch(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers,
    body,
    redirect: 'manual',
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { res, data };
}

async function insertAttemptAt(params: {
  saveId: string;
  trialId: string;
  passed: boolean;
  hintsUsed?: number;
  code?: string;
  createdAt: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO trial_attempts (save_id, trial_id, passed, hints_used, code, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      params.saveId,
      params.trialId,
      params.passed ? 1 : 0,
      params.hintsUsed ?? 0,
      params.code ?? '',
      params.createdAt
    )
    .run();
}

async function insertEventAt(params: {
  saveId: string;
  heroName: string;
  eventType: string;
  realmId?: string | null;
  trialId?: string | null;
  summary: string;
  details?: Record<string, unknown>;
  createdAt: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO activity_events
       (save_id, hero_name, event_type, realm_id, trial_id, summary, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      params.saveId,
      params.heroName,
      params.eventType,
      params.realmId ?? null,
      params.trialId ?? null,
      params.summary,
      JSON.stringify(params.details ?? {}),
      params.createdAt
    )
    .run();
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM digest_deliveries'),
    env.DB.prepare('DELETE FROM parent_preferences'),
    env.DB.prepare('DELETE FROM trial_attempts'),
    env.DB.prepare('DELETE FROM activity_events'),
    env.DB.prepare('DELETE FROM saves'),
    env.DB.prepare('DELETE FROM rate_limits'),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Weekly Digest — ISO Week & Progress Detection', () => {
  it('computes ISO-8601 week keys accurately including year boundaries', () => {
    expect(getIsoWeekKey(new Date('2026-11-29T23:00:00Z'))).toBe('2026-W48');
    expect(getIsoWeekKey(new Date('2026-01-01T12:00:00Z'))).toBe('2026-W01');
    expect(getIsoWeekKey(new Date('2025-12-31T12:00:00Z'))).toBe('2026-W01');
  });

  it('skips zero-progress, stale (>7d), and failed-only parents while emailing active & milestone parents', async () => {
    const db = new PyriaD1(env);
    const now = new Date('2026-11-29T23:00:00Z');
    const twoDaysAgo = '2026-11-27T18:00:00Z';
    const tenDaysAgo = '2026-11-19T18:00:00Z';

    // 1. Parent with zero activity
    await db.createSave({ heroName: 'IdleHero' }, { ownerEmail: 'idle@example.com' });

    // 2. Parent with only stale (>7d) passed trial
    const staleSave = await db.createSave(
      { heroName: 'StaleHero', solvedTrials: ['trial-01-01'] },
      { ownerEmail: 'stale@example.com' }
    );
    await insertAttemptAt({
      saveId: staleSave.id,
      trialId: 'trial-01-01',
      passed: true,
      createdAt: tenDaysAgo,
    });

    // 3. Parent with only failed attempts this week (zero-noise rule)
    const stuckSave = await db.createSave(
      { heroName: 'StuckHero' },
      { ownerEmail: 'stuck@example.com' }
    );
    await insertAttemptAt({
      saveId: stuckSave.id,
      trialId: 'trial-01-01',
      passed: false,
      hintsUsed: 2,
      code: 'say(broken_secret_code)',
      createdAt: twoDaysAgo,
    });

    // 4. Parent with passed trial + persistence (should trigger coaching tip without exposing raw code!)
    const activeSave = await db.createSave(
      {
        heroName: 'Ada<Hero>',
        eraId: 'era-01-8bit',
        realmId: 'realm-01-meadow',
        byteShards: 60,
        solvedTrials: ['trial-01-01', 'trial-01-02'],
      },
      { ownerEmail: 'active@example.com' }
    );
    await insertAttemptAt({
      saveId: activeSave.id,
      trialId: 'trial-01-01',
      passed: false,
      hintsUsed: 1,
      code: 'SECRET_STUDENT_CODE_LINE_1',
      createdAt: '2026-11-26T15:00:00Z',
    });
    await insertAttemptAt({
      saveId: activeSave.id,
      trialId: 'trial-01-01',
      passed: false,
      hintsUsed: 1,
      code: 'SECRET_STUDENT_CODE_LINE_2',
      createdAt: '2026-11-26T15:05:00Z',
    });
    await insertAttemptAt({
      saveId: activeSave.id,
      trialId: 'trial-01-01',
      passed: true,
      hintsUsed: 0,
      code: 'SECRET_STUDENT_CODE_LINE_3',
      createdAt: twoDaysAgo,
    });

    // 5. Parent with milestone-only progress (realm_entered)
    const milestoneSave = await db.createSave(
      {
        heroName: 'Nova',
        eraId: 'era-01-8bit',
        realmId: 'realm-02-forest',
        byteShards: 40,
      },
      { ownerEmail: 'milestone@example.com' }
    );
    await insertEventAt({
      saveId: milestoneSave.id,
      heroName: 'Nova',
      eventType: 'realm_entered',
      realmId: 'realm-02-forest',
      summary: 'Entered realm-02-forest',
      details: { fromRealmId: 'realm-01-meadow', toRealmId: 'realm-02-forest' },
      createdAt: twoDaysAgo,
    });

    const sent: EmailMessage[] = [];
    const mockSender: EmailSender = {
      async send(msg) {
        sent.push(msg);
        return { providerMessageId: `msg-${sent.length}` };
      },
    };

    const summary = await runWeeklyDigestJob(env, {
      now,
      sender: mockSender,
      baseUrl: BASE,
    });

    expect(summary.weekKey).toBe('2026-W48');
    expect(summary.evaluatedParents).toBe(5);
    expect(summary.eligibleParents).toBe(2);
    expect(summary.skippedNoProgress).toBe(3);
    expect(summary.sentCount).toBe(2);
    expect(summary.failedCount).toBe(0);

    const recipients = sent.map((m) => m.to).sort();
    expect(recipients).toEqual(['active@example.com', 'milestone@example.com']);

    const activeMail = sent.find((m) => m.to === 'active@example.com')!;
    expect(activeMail.subject).toContain('Ada<Hero>');
    expect(activeMail.subject).toContain('1 new Python trial');
    // HTML escapes hero name & never exposes raw code
    expect(activeMail.html).toContain('Ada&lt;Hero&gt;');
    expect(activeMail.html).not.toContain('Ada<Hero>');
    expect(activeMail.html).not.toContain('SECRET_STUDENT_CODE');
    expect(activeMail.text).not.toContain('SECRET_STUDENT_CODE');
    // Coaching tip included
    expect(activeMail.html).toContain("Pip's Coaching Tip");
    expect(activeMail.text).toContain("Pip's Coaching Tip");
    // /console CTA + one-click unsubscribe + RFC 8058 headers
    expect(activeMail.html).toContain(`${BASE}/console`);
    expect(activeMail.text).toContain(`${BASE}/console`);
    expect(activeMail.headers?.['List-Unsubscribe']).toMatch(
      /^<https:\/\/pyria\.test\/api\/email\/unsubscribe\?token=[^>]+>$/
    );
    expect(activeMail.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');

    const milestoneMail = sent.find((m) => m.to === 'milestone@example.com')!;
    expect(milestoneMail.subject).toContain('Nova made new progress in Pyria');
  });
});

describe('Weekly Digest — Multi-Hero Consolidation, Idempotency & Error Isolation', () => {
  it('consolidates multiple active heroes under one owner_email into a single email', async () => {
    const db = new PyriaD1(env);
    const now = new Date('2026-11-29T23:00:00Z');
    const recent = '2026-11-28T14:00:00Z';

    const hero1 = await db.createSave(
      { heroName: 'Rowan', solvedTrials: ['trial-01-01', 'trial-01-02'], byteShards: 40 },
      { ownerEmail: 'family@example.com' }
    );
    const hero2 = await db.createSave(
      { heroName: 'Pippin', solvedTrials: ['trial-01-01'], byteShards: 20 },
      { ownerEmail: 'family@example.com' }
    );
    // Third sibling who did not play this week
    await db.createSave({ heroName: 'SleepySib' }, { ownerEmail: 'family@example.com' });

    await insertAttemptAt({
      saveId: hero1.id,
      trialId: 'trial-01-01',
      passed: true,
      createdAt: recent,
    });
    await insertAttemptAt({
      saveId: hero1.id,
      trialId: 'trial-01-02',
      passed: true,
      createdAt: recent,
    });
    await insertAttemptAt({
      saveId: hero2.id,
      trialId: 'trial-01-01',
      passed: true,
      createdAt: recent,
    });

    const sent: EmailMessage[] = [];
    const mockSender: EmailSender = {
      async send(msg) {
        sent.push(msg);
        return { providerMessageId: 'msg-multi-1' };
      },
    };

    const summary = await runWeeklyDigestJob(env, {
      now,
      sender: mockSender,
      baseUrl: BASE,
    });

    expect(summary.sentCount).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('family@example.com');
    expect(sent[0].subject).toContain('Rowan & Pippin');
    expect(sent[0].subject).toContain('3 new Python trials');
    expect(sent[0].html).toContain('Rowan');
    expect(sent[0].html).toContain('Pippin');
    expect(sent[0].html).toContain('Resting in camp this week: SleepySib');
    expect(sent[0].text).toContain('=== Rowan ===');
    expect(sent[0].text).toContain('=== Pippin ===');

    const delivery = await db.getDigestDelivery('family@example.com', '2026-W48');
    expect(delivery).toMatchObject({
      ownerEmail: 'family@example.com',
      weekKey: '2026-W48',
      heroCount: 2,
      trialsSolved: 3,
      status: 'sent',
      providerMessageId: 'msg-multi-1',
    });
  });

  it('enforces idempotent delivery per (owner_email, week_key) and isolates per-parent errors with retry support', async () => {
    const db = new PyriaD1(env);
    const now = new Date('2026-11-29T23:00:00Z');
    const recent = '2026-11-28T10:00:00Z';

    const s1 = await db.createSave({ heroName: 'Alpha' }, { ownerEmail: 'a@example.com' });
    const s2 = await db.createSave({ heroName: 'Beta' }, { ownerEmail: 'b@example.com' });
    const s3 = await db.createSave({ heroName: 'Gamma' }, { ownerEmail: 'c@example.com' });

    for (const s of [s1, s2, s3]) {
      await insertAttemptAt({
        saveId: s.id,
        trialId: 'trial-01-01',
        passed: true,
        createdAt: recent,
      });
    }

    // First run: b@example.com fails transiently, a and c succeed (batchSize = 2 tests multi-batching too)
    const sentRun1: string[] = [];
    const flakySender: EmailSender = {
      async send(msg) {
        if (msg.to === 'b@example.com') {
          throw new Error('SMTP temporary 421 error');
        }
        sentRun1.push(msg.to);
        return { providerMessageId: `id-${msg.to}` };
      },
    };

    const run1 = await runWeeklyDigestJob(env, {
      now,
      sender: flakySender,
      batchSize: 2,
      baseUrl: BASE,
    });
    expect(run1.sentCount).toBe(2);
    expect(run1.failedCount).toBe(1);
    expect(sentRun1.sort()).toEqual(['a@example.com', 'c@example.com']);

    const failedRow = await db.getDigestDelivery('b@example.com', '2026-W48');
    expect(failedRow?.status).toBe('failed');
    expect(failedRow?.errorMessage).toContain('421');

    // Second run for the SAME week: a and c are skipped (idempotent), b is retried and succeeds!
    const sentRun2: string[] = [];
    const healthySender: EmailSender = {
      async send(msg) {
        sentRun2.push(msg.to);
        return { providerMessageId: `retry-${msg.to}` };
      },
    };

    const run2 = await runWeeklyDigestJob(env, {
      now,
      sender: healthySender,
      batchSize: 2,
      baseUrl: BASE,
    });
    expect(run2.skippedAlreadySent).toBe(2);
    expect(run2.sentCount).toBe(1);
    expect(run2.failedCount).toBe(0);
    expect(sentRun2).toEqual(['b@example.com']);

    const retriedRow = await db.getDigestDelivery('b@example.com', '2026-W48');
    expect(retriedRow?.status).toBe('sent');
    expect(retriedRow?.providerMessageId).toBe('retry-b@example.com');

    // Third run for the SAME week: all 3 skipped, zero emails sent
    const sentRun3: string[] = [];
    const run3 = await runWeeklyDigestJob(env, {
      now,
      sender: {
        async send(msg) {
          sentRun3.push(msg.to);
          return { providerMessageId: null };
        },
      },
      baseUrl: BASE,
    });
    expect(run3.skippedAlreadySent).toBe(3);
    expect(run3.sentCount).toBe(0);
    expect(sentRun3).toHaveLength(0);
  });

  it('invokes weekly digest via Worker scheduled() Cron Trigger', async () => {
    const db = new PyriaD1(env);
    const save = await db.createSave({ heroName: 'CronHero' }, { ownerEmail: 'cron@example.com' });
    await insertAttemptAt({
      saveId: save.id,
      trialId: 'trial-01-01',
      passed: true,
      createdAt: '2026-11-28T12:00:00Z',
    });

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'cron-msg-1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(p: Promise<unknown>) {
        pending.push(p);
      },
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext;

    const controller = {
      cron: '0 23 * * SUN',
      scheduledTime: Date.parse('2026-11-29T23:00:00Z'),
      noRetry() {},
    } as unknown as ScheduledController;

    const testEnv = {
      ...env,
      EMAIL_API_KEY: 'test-api-key',
      EMAIL_FROM: 'Pyria <updates@pyria.dev>',
      PYRIA_BASE_URL: BASE,
    };

    await workerDefault.scheduled(controller, testEnv, ctx);
    await Promise.all(pending);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const delivery = await db.getDigestDelivery('cron@example.com', '2026-W48');
    expect(delivery?.status).toBe('sent');
    expect(delivery?.providerMessageId).toBe('cron-msg-1');
  });
});

describe('Email Transports — HTTP API & Cloudflare Email Sending Binding', () => {
  it('sends via HttpApiEmailSender with bearer auth and RFC 8058 headers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ id: 're_12345' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const sender = new HttpApiEmailSender('secret-key', 'https://api.resend.com/emails', mockFetch);
    const res = await sender.send({
      to: 'parent@example.com',
      from: 'Pyria <updates@pyria.dev>',
      subject: 'Pyria Weekly Update',
      html: '<p>Hello</p>',
      text: 'Hello',
      headers: {
        'List-Unsubscribe': '<https://pyria.test/api/email/unsubscribe?token=abc>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });

    expect(res.providerMessageId).toBe('re_12345');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    const hdrs = calls[0].init.headers as Record<string, string>;
    expect(hdrs.Authorization).toBe('Bearer secret-key');
    const parsedBody = JSON.parse(String(calls[0].init.body));
    expect(parsedBody.to).toEqual(['parent@example.com']);
    expect(parsedBody.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('sends via CloudflareEmailBindingSender with RFC 5322 multipart/alternative MIME', async () => {
    const payloads: any[] = [];
    const binding = {
      async send(msg: unknown) {
        payloads.push(msg);
      },
    };
    const sender = new CloudflareEmailBindingSender(binding);
    const msg: EmailMessage = {
      to: 'parent@example.com',
      from: 'Pyria <updates@pyria.dev>',
      subject: 'Pyria Weekly Update',
      html: '<p>Hello</p>',
      text: 'Hello plain',
      headers: {
        'List-Unsubscribe': '<https://pyria.test/api/email/unsubscribe?token=xyz>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    };

    await sender.send(msg);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].from).toBe('updates@pyria.dev');
    expect(payloads[0].to).toBe('parent@example.com');
    expect(payloads[0].raw).toContain('multipart/alternative');
    expect(payloads[0].raw).toContain('List-Unsubscribe: <https://pyria.test/api/email/unsubscribe?token=xyz>');
    expect(payloads[0].raw).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect(buildRawMimeMessage(msg)).toContain('Hello plain');
  });
});

describe('Parent Console Preferences, One-Click Unsubscribe & Admin Preview', () => {
  it('supports GET/PUT /api/console/preferences, UI toggle page, and opt-in notice on hero creation & claim', async () => {
    const parentCookie = await makeParentCookie('mom@example.com');

    // Unauthenticated rejected
    const unauth = await apiJson('/api/console/preferences');
    expect(unauth.res.status).toBe(403);

    // Default enabled
    const initial = await apiJson('/api/console/preferences', { cookie: parentCookie });
    expect(initial.res.status).toBe(200);
    expect(initial.data.preferences.weeklyDigestEnabled).toBe(true);
    expect(initial.data.notice).toContain('Weekly progress emails');

    // Hero creation returns opt-in notice
    const created = await apiJson('/api/console/heroes', {
      method: 'POST',
      cookie: parentCookie,
      body: { heroName: 'Sunny' },
    });
    expect(created.res.status).toBe(201);
    expect(created.data.weeklyDigestEnabled).toBe(true);
    expect(created.data.weeklyDigestNotice).toContain('mom@example.com');

    // Claiming an unowned hero returns opt-in notice
    const anonHero = await apiJson('/api/auth/hero-code/create', {
      method: 'POST',
      body: { heroName: 'Wanderer' },
    });
    const claimed = await apiJson('/api/console/claim-hero', {
      method: 'POST',
      cookie: parentCookie,
      body: { heroCode: anonHero.data.heroCode },
    });
    expect(claimed.res.status).toBe(200);
    expect(claimed.data.weeklyDigestEnabled).toBe(true);
    expect(claimed.data.weeklyDigestNotice).toContain('mom@example.com');

    // Invalid payload rejected
    const badPut = await apiJson('/api/console/preferences', {
      method: 'PUT',
      cookie: parentCookie,
      body: { weeklyDigestEnabled: 'yes' },
    });
    expect(badPut.res.status).toBe(400);

    // Disable via API
    const disabled = await apiJson('/api/console/preferences', {
      method: 'PUT',
      cookie: parentCookie,
      body: { weeklyDigestEnabled: false },
    });
    expect(disabled.res.status).toBe(200);
    expect(disabled.data.preferences.weeklyDigestEnabled).toBe(false);
    expect(disabled.data.preferences.unsubscribedAt).toBeTruthy();

    // Verify digest job skips disabled parent
    const db = new PyriaD1(env);
    await insertAttemptAt({
      saveId: created.data.save.id,
      trialId: 'trial-01-01',
      passed: true,
      createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
    const runRes = await runWeeklyDigestJob(env, {
      sender: {
        async send() {
          throw new Error('Should not send to disabled parent');
        },
      },
      baseUrl: BASE,
    });
    expect(runRes.skippedDisabled).toBe(1);
    expect(runRes.sentCount).toBe(0);

    // UI toggle page (/console/preferences) & /console toggle script
    const prefPage = await SELF.fetch(`${BASE}/console/preferences`, {
      headers: { Cookie: parentCookie },
    });
    expect(prefPage.status).toBe(200);
    const prefHtml = await prefPage.text();
    expect(prefHtml).toContain('Weekly Progress Emails');
    expect(prefHtml).toContain('Paused');

    const consoleRes = await SELF.fetch(`${BASE}/console`);
    expect(consoleRes.status).toBe(200);
    const consoleHtml = await consoleRes.text();
    expect(consoleHtml).toContain('/console/digest-prefs.js');

    const scriptRes = await SELF.fetch(`${BASE}/console/digest-prefs.js`);
    expect(scriptRes.status).toBe(200);
    expect(scriptRes.headers.get('Content-Type')).toContain('javascript');
  });

  it('verifies stateless HMAC-SHA256 unsubscribe tokens and supports GET + cross-origin RFC 8058 POST without login', async () => {
    const secret = env.PYRIA_SESSION_SECRET!;
    const token = await createUnsubscribeToken('dad@example.com', secret);

    const verified = await verifyUnsubscribeToken(token, secret);
    expect(verified?.email).toBe('dad@example.com');
    expect(verified?.typ).toBe('weekly_digest_unsub');

    // Reject tampered token, expired token, and wrong-type (parent session) token
    expect(await verifyUnsubscribeToken(`${token}tampered`, secret)).toBeNull();
    const expiredToken = await createUnsubscribeToken('dad@example.com', secret, -10);
    expect(await verifyUnsubscribeToken(expiredToken, secret)).toBeNull();
    const parentSessionToken = await signToken(
      { typ: 'parent', email: 'dad@example.com', exp: Math.floor(Date.now() / 1000) + 3600 },
      secret
    );
    expect(await verifyUnsubscribeToken(parentSessionToken, secret)).toBeNull();

    // Cross-origin RFC 8058 POST without cookies succeeds!
    const postRes = await SELF.fetch(
      `${BASE}/api/email/unsubscribe?token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: 'https://mail.google.com',
          'Sec-Fetch-Site': 'cross-site',
        },
        body: 'List-Unsubscribe=One-Click',
      }
    );
    expect(postRes.status).toBe(200);
    const postData = (await postRes.json()) as any;
    expect(postData.ok).toBe(true);
    expect(postData.email).toBe('dad@example.com');
    expect(postData.weeklyDigestEnabled).toBe(false);

    // Re-enable, then test GET link click returning HTML confirmation page
    const db = new PyriaD1(env);
    await db.setParentPreferences('dad@example.com', true);
    const getRes = await SELF.fetch(
      `${BASE}/api/email/unsubscribe?token=${encodeURIComponent(token)}`,
      {
        method: 'GET',
        headers: { Accept: 'text/html' },
      }
    );
    expect(getRes.status).toBe(200);
    const getHtml = await getRes.text();
    expect(getHtml).toContain('Weekly Progress Emails Paused');
    expect(getHtml).toContain('dad@example.com');

    const prefs = await db.getParentPreferences('dad@example.com');
    expect(prefs.weeklyDigestEnabled).toBe(false);

    // Invalid token returns 400
    const badRes = await SELF.fetch(`${BASE}/api/email/unsubscribe?token=invalid.token`);
    expect(badRes.status).toBe(400);
  });

  it('exposes admin-only POST /api/admin/digest/preview returning rendered HTML/text/headers', async () => {
    const parentCookie = await makeParentCookie('mom@example.com');
    const adminCookie = await makeParentCookie('admin@pyria.test');

    // Non-admin blocked
    const forbidden = await apiJson('/api/admin/digest/preview', {
      method: 'POST',
      cookie: parentCookie,
      body: { ownerEmail: 'mom@example.com' },
    });
    expect(forbidden.res.status).toBe(403);

    // Parent with no progress returns hasProgress: false
    const db = new PyriaD1(env);
    const save = await db.createSave({ heroName: 'Ember' }, { ownerEmail: 'mom@example.com' });
    const emptyPreview = await apiJson('/api/admin/digest/preview', {
      method: 'POST',
      cookie: adminCookie,
      body: { ownerEmail: 'mom@example.com' },
    });
    expect(emptyPreview.res.status).toBe(200);
    expect(emptyPreview.data.hasProgress).toBe(false);
    expect(emptyPreview.data.email).toBeNull();

    // Add recent passed trial and preview again
    await insertAttemptAt({
      saveId: save.id,
      trialId: 'trial-01-01',
      passed: true,
      createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
    const preview = await apiJson('/api/admin/digest/preview', {
      method: 'POST',
      cookie: adminCookie,
      body: { ownerEmail: 'mom@example.com' },
    });
    expect(preview.res.status).toBe(200);
    expect(preview.data.ok).toBe(true);
    expect(preview.data.hasProgress).toBe(true);
    expect(preview.data.email.subject).toContain('Ember');
    expect(preview.data.email.html).toContain('Open Parent Console');
    expect(preview.data.email.text).toContain('=== Ember ===');
    expect(preview.data.email.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(preview.data.testSent).toBe(false);
  });
});
