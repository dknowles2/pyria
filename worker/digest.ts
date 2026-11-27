import { getSessionSecret } from './auth';
import { signToken, verifyToken } from './crypto';
import { PyriaD1, utcNowIso } from './db';
import { type EmailSender, createEmailSender, getEmailFrom } from './email';
import type {
  ActivityEventRecord,
  AttemptRecord,
  DigestRunSummary,
  Env,
  HeroWeeklyDigest,
  ParentWeeklyDigest,
  RenderedDigestEmail,
  SaveRecord,
  WeeklyDigestUnsubPayload,
} from './types';
import { normalizeEmail } from './validation';

export const UNSUBSCRIBE_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 180; // 180 days
export const DEFAULT_DIGEST_BASE_URL = 'https://pyria.dev';
export const DEFAULT_DIGEST_BATCH_SIZE = 25;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const MILESTONE_EVENT_TYPES = new Set([
  'realm_entered',
  'dragon_rescued',
  'realm_completed',
  'era_completed',
]);

export interface TrialMetadata {
  id: string;
  title: string;
  realmId: string;
  realmName: string;
  eraId: string;
  eraName: string;
  concepts: string[];
}

export interface RealmMetadata {
  id: string;
  name: string;
  eraId: string;
  eraName: string;
  primaryConcepts: string[];
}

export interface ContentIndex {
  trials: Map<string, TrialMetadata>;
  realms: Map<string, RealmMetadata>;
  eras: Map<string, string>;
  conceptLabels: Map<string, string>;
  totalTrials: number;
}

/**
 * Compute ISO-8601 week key (e.g. '2026-W48') in UTC.
 */
export function getIsoWeekKey(date: Date = new Date()): string {
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  // ISO week date weeks start on Monday (1) .. Sunday (7)
  const dayNum = target.getUTCDay() || 7;
  // Move to nearest Thursday to determine ISO week year
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function getDigestBaseUrl(env: Env, fallbackOrigin?: string): string {
  const configured = (env.PYRIA_BASE_URL || '').trim().replace(/\/+$/, '');
  if (configured && /^https?:\/\//i.test(configured)) {
    return configured;
  }
  if (fallbackOrigin && /^https?:\/\//i.test(fallbackOrigin)) {
    return fallbackOrigin.replace(/\/+$/, '');
  }
  return DEFAULT_DIGEST_BASE_URL;
}

export async function createUnsubscribeToken(
  email: string,
  secret: string,
  ttlSeconds = UNSUBSCRIBE_TOKEN_TTL_SECONDS
): Promise<string> {
  const norm = normalizeEmail(email);
  if (!norm) {
    throw new Error('Cannot create unsubscribe token for invalid email');
  }
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload: WeeklyDigestUnsubPayload = {
    typ: 'weekly_digest_unsub',
    email: norm,
    exp,
  };
  return signToken(payload, secret);
}

export async function verifyUnsubscribeToken(
  token: string | undefined,
  secret: string
): Promise<WeeklyDigestUnsubPayload | null> {
  const payload = await verifyToken<WeeklyDigestUnsubPayload>(
    token,
    secret,
    'weekly_digest_unsub'
  );
  if (!payload || typeof payload.email !== 'string') {
    return null;
  }
  const norm = normalizeEmail(payload.email);
  if (!norm) return null;
  return { ...payload, email: norm };
}

function humanizeSlug(raw: string): string {
  return raw
    .replace(/^(realm|era|trial|dragon)-\d+-/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function fetchJsonAsset<T>(
  env: Env,
  baseUrl: string,
  assetPath: string
): Promise<T | null> {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') return null;
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(assetPath, baseUrl).toString()));
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function loadContentIndex(
  env: Env,
  baseUrl: string = DEFAULT_DIGEST_BASE_URL
): Promise<ContentIndex> {
  const trials = new Map<string, TrialMetadata>();
  const realms = new Map<string, RealmMetadata>();
  const eras = new Map<string, string>();
  const conceptLabels = new Map<string, string>();

  const game = await fetchJsonAsset<{
    eraOrder?: string[];
    conceptProgression?: Array<{ id?: string; label?: string }>;
  }>(env, baseUrl, '/content/game.json');

  for (const c of game?.conceptProgression ?? []) {
    if (c.id && c.label) {
      conceptLabels.set(c.id, c.label);
    }
  }

  const eraIds = game?.eraOrder ?? [
    'era-01-8bit',
    'era-02-16bit',
    'era-03-32bit',
    'era-04-64bit',
  ];

  const eraDocs = await Promise.all(
    eraIds.map((eraId) =>
      fetchJsonAsset<{
        id?: string;
        name?: string;
        realms?: Array<{
          id?: string;
          name?: string;
          primaryConcepts?: string[];
          trials?: Array<{
            id?: string;
            title?: string;
            concepts?: string[];
          }>;
        }>;
      }>(env, baseUrl, `/content/eras/${encodeURIComponent(eraId)}.json`)
    )
  );

  let totalTrials = 0;
  for (let i = 0; i < eraIds.length; i += 1) {
    const eraId = eraIds[i];
    const era = eraDocs[i];
    if (!era) continue;
    const eraName = era.name || humanizeSlug(eraId);
    eras.set(eraId, eraName);

    for (const realm of era.realms ?? []) {
      if (!realm.id) continue;
      const realmName = realm.name || humanizeSlug(realm.id);
      const primaryConcepts = Array.isArray(realm.primaryConcepts)
        ? realm.primaryConcepts.map(String)
        : [];
      realms.set(realm.id, {
        id: realm.id,
        name: realmName,
        eraId,
        eraName,
        primaryConcepts,
      });

      for (const trial of realm.trials ?? []) {
        if (!trial.id) continue;
        totalTrials += 1;
        trials.set(trial.id, {
          id: trial.id,
          title: trial.title || trial.id,
          realmId: realm.id,
          realmName,
          eraId,
          eraName,
          concepts: Array.isArray(trial.concepts) ? trial.concepts.map(String) : primaryConcepts,
        });
      }
    }
  }

  return {
    trials,
    realms,
    eras,
    conceptLabels,
    totalTrials,
  };
}

function getConceptLabel(index: ContentIndex, conceptId: string): string {
  return index.conceptLabels.get(conceptId) || humanizeSlug(conceptId);
}

function extractSaveStringSet(save: SaveRecord, ...keys: string[]): Set<string> {
  const out = new Set<string>();
  for (const key of keys) {
    const val = save[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item !== null && item !== undefined) {
          out.add(String(item));
        }
      }
    }
  }
  return out;
}

/**
 * Evaluate a single hero's weekly progress within [windowStart, windowEnd].
 * Returns null if the hero had zero meaningful progress (zero-noise rule).
 */
export function buildHeroWeeklyDigest(params: {
  save: SaveRecord;
  attempts: AttemptRecord[];
  events: ActivityEventRecord[];
  content: ContentIndex;
}): HeroWeeklyDigest | null {
  const { save, attempts, events, content } = params;

  const passedTrialIds = new Set<string>();
  const attemptsByTrial = new Map<string, { attempts: number; hints: number; passed: boolean }>();
  const activeDays = new Set<string>();

  for (const att of attempts) {
    const day = att.createdAt.slice(0, 10);
    if (day) activeDays.add(day);

    const cur = attemptsByTrial.get(att.trialId) ?? { attempts: 0, hints: 0, passed: false };
    cur.attempts += 1;
    cur.hints += Math.max(0, Number(att.hintsUsed) || 0);
    if (att.passed) {
      cur.passed = true;
      passedTrialIds.add(att.trialId);
    }
    attemptsByTrial.set(att.trialId, cur);
  }

  const realmsEntered = new Set<string>();
  let dragonsRescuedThisWeek = 0;
  let hasMilestoneEvent = false;

  for (const ev of events) {
    const day = ev.createdAt.slice(0, 10);
    if (ev.eventType === 'trial_passed' && ev.trialId) {
      passedTrialIds.add(ev.trialId);
      if (day) activeDays.add(day);
    } else if (
      ev.eventType === 'parent_override' &&
      ev.trialId &&
      ev.details &&
      ev.details.solved === true
    ) {
      passedTrialIds.add(ev.trialId);
      if (day) activeDays.add(day);
    } else if (MILESTONE_EVENT_TYPES.has(ev.eventType)) {
      hasMilestoneEvent = true;
      if (day) activeDays.add(day);
      if (ev.eventType === 'dragon_rescued') {
        dragonsRescuedThisWeek += 1;
      }
      if (ev.eventType === 'realm_entered') {
        const toRealm =
          (typeof ev.details?.toRealmId === 'string' && ev.details.toRealmId) || ev.realmId;
        if (toRealm) realmsEntered.add(toRealm);
      }
    }
  }

  // Zero-noise rule: must have >= 1 passed trial or meaningful milestone event
  if (passedTrialIds.size === 0 && !hasMilestoneEvent) {
    return null;
  }

  const conceptsSet = new Set<string>();
  const realmsProgressedSet = new Set<string>();
  const notableTrialsSolved: string[] = [];

  for (const trialId of passedTrialIds) {
    const meta = content.trials.get(trialId);
    if (meta) {
      notableTrialsSolved.push(meta.title);
      realmsProgressedSet.add(meta.realmName);
      for (const c of meta.concepts) {
        conceptsSet.add(getConceptLabel(content, c));
      }
    } else {
      notableTrialsSolved.push(humanizeSlug(trialId) || trialId);
    }
  }

  for (const rId of realmsEntered) {
    const realmMeta = content.realms.get(rId);
    if (realmMeta) {
      realmsProgressedSet.add(realmMeta.name);
      for (const c of realmMeta.primaryConcepts) {
        conceptsSet.add(getConceptLabel(content, c));
      }
    } else {
      realmsProgressedSet.add(humanizeSlug(rId));
    }
  }

  const currentRealmId =
    typeof save.realmId === 'string' && save.realmId ? save.realmId : 'realm-01-meadow';
  const currentEraId =
    typeof save.eraId === 'string' && save.eraId ? save.eraId : 'era-01-8bit';
  const currentRealmMeta = content.realms.get(currentRealmId);
  const realmName = currentRealmMeta?.name || humanizeSlug(currentRealmId);
  const eraName = content.eras.get(currentEraId) || currentRealmMeta?.eraName || humanizeSlug(currentEraId);

  if (realmsProgressedSet.size === 0) {
    realmsProgressedSet.add(realmName);
  }

  // Gentle coaching tip when a hero spent extra persistence (attempts/hints) on a concept
  // Never exposes raw code or sounds punitive.
  let coachingTip: string | null = null;
  let hardestTrialId: string | null = null;
  let hardestScore = 0;
  for (const [trialId, stat] of attemptsByTrial.entries()) {
    const effortScore = stat.attempts + stat.hints * 2;
    if ((stat.attempts >= 3 || stat.hints >= 2) && effortScore > hardestScore) {
      hardestScore = effortScore;
      hardestTrialId = trialId;
    }
  }

  if (hardestTrialId) {
    const meta = content.trials.get(hardestTrialId);
    const stat = attemptsByTrial.get(hardestTrialId)!;
    const conceptName =
      meta && meta.concepts.length > 0
        ? getConceptLabel(content, meta.concepts[0])
        : meta?.title || 'a tricky Python puzzle';
    if (stat.passed) {
      coachingTip = `${save.heroName} showed great persistence working through ${conceptName} this week — ask them to show you how they solved it!`;
    } else {
      coachingTip = `${save.heroName} spent extra time exploring ${conceptName} — practicing a quick example together could give them a fun boost.`;
    }
  }

  const overallSolvedSet = extractSaveStringSet(save, 'solvedTrials', 'completedTrials');
  const rescuedDragonsSet = extractSaveStringSet(save, 'rescuedDragons');
  const byteShards =
    typeof save.byteShards === 'number' && Number.isFinite(save.byteShards)
      ? Math.max(0, Math.trunc(save.byteShards))
      : 0;

  return {
    saveId: save.id,
    heroName: save.heroName,
    eraId: currentEraId,
    eraName,
    realmId: currentRealmId,
    realmName,
    byteShards,
    overallSolvedCount: Math.max(overallSolvedSet.size, passedTrialIds.size),
    totalTrials: content.totalTrials,
    rescuedDragonsCount: rescuedDragonsSet.size,
    trialsSolvedThisWeek: passedTrialIds.size,
    notableTrialsSolved: notableTrialsSolved.slice(0, 5),
    conceptsProgressed: [...conceptsSet].slice(0, 6),
    realmsProgressed: [...realmsProgressedSet].slice(0, 4),
    dragonsRescuedThisWeek,
    activeDaysThisWeek: Math.max(1, activeDays.size),
    coachingTip,
  };
}

/**
 * Consolidate all linked heroes under one parent account into a single weekly digest.
 * Returns null if zero linked heroes made meaningful progress.
 */
export function buildParentWeeklyDigest(params: {
  ownerEmail: string;
  weekKey: string;
  windowStart: string;
  windowEnd: string;
  saves: SaveRecord[];
  attemptsBySave: Map<string, AttemptRecord[]>;
  eventsBySave: Map<string, ActivityEventRecord[]>;
  content: ContentIndex;
}): ParentWeeklyDigest | null {
  const activeHeroes: HeroWeeklyDigest[] = [];
  const inactiveHeroNames: string[] = [];

  for (const save of params.saves) {
    const heroDigest = buildHeroWeeklyDigest({
      save,
      attempts: params.attemptsBySave.get(save.id) ?? [],
      events: params.eventsBySave.get(save.id) ?? [],
      content: params.content,
    });
    if (heroDigest) {
      activeHeroes.push(heroDigest);
    } else {
      inactiveHeroNames.push(save.heroName);
    }
  }

  if (activeHeroes.length === 0) {
    return null;
  }

  // Sort most active hero first
  activeHeroes.sort((a, b) => b.trialsSolvedThisWeek - a.trialsSolvedThisWeek);
  const totalTrialsSolved = activeHeroes.reduce((sum, h) => sum + h.trialsSolvedThisWeek, 0);

  return {
    ownerEmail: params.ownerEmail,
    weekKey: params.weekKey,
    windowStart: params.windowStart,
    windowEnd: params.windowEnd,
    activeHeroes,
    inactiveHeroNames,
    totalTrialsSolved,
  };
}

function formatHeroNameList(names: string[]): string {
  if (names.length === 0) return 'Your hero';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

export function buildDigestSubject(digest: ParentWeeklyDigest): string {
  const names = formatHeroNameList(digest.activeHeroes.map((h) => h.heroName));
  if (digest.totalTrialsSolved > 0) {
    const unit = digest.totalTrialsSolved === 1 ? 'trial' : 'trials';
    return `Pyria Weekly Update: ${names} solved ${digest.totalTrialsSolved} new Python ${unit}!`;
  }
  return `Pyria Weekly Update: ${names} made new progress in Pyria!`;
}

/**
 * Render warm, kid-safe, mobile-friendly HTML + plain-text weekly digest email
 * with RFC 8058 one-click unsubscribe headers.
 */
export function renderWeeklyDigestEmail(
  digest: ParentWeeklyDigest,
  options: {
    baseUrl: string;
    unsubscribeToken: string;
  }
): RenderedDigestEmail {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const consoleUrl = `${baseUrl}/console`;
  const preferencesUrl = `${baseUrl}/console/preferences`;
  const unsubscribeUrl = `${baseUrl}/api/email/unsubscribe?token=${encodeURIComponent(
    options.unsubscribeToken
  )}`;
  const subject = buildDigestSubject(digest);

  const heroCardsHtml = digest.activeHeroes
    .map((hero) => {
      const progressPct =
        hero.totalTrials > 0
          ? Math.min(100, Math.round((hero.overallSolvedCount / hero.totalTrials) * 100))
          : 0;
      const overallProgressText =
        hero.totalTrials > 0
          ? `${hero.overallSolvedCount} / ${hero.totalTrials} trials (${progressPct}%)`
          : `${hero.overallSolvedCount} trials solved overall`;

      const trialsSummary =
        hero.trialsSolvedThisWeek > 0
          ? `${hero.trialsSolvedThisWeek} Python ${
              hero.trialsSolvedThisWeek === 1 ? 'trial' : 'trials'
            } solved this week`
          : 'New adventure milestone reached this week';

      const notableHtml =
        hero.notableTrialsSolved.length > 0
          ? `<p style="margin:8px 0 0;font-size:13px;color:#475569;"><strong>Highlights:</strong> ${hero.notableTrialsSolved
              .map((t) => escapeHtml(t))
              .join(' &bull; ')}</p>`
          : '';

      const conceptsHtml =
        hero.conceptsProgressed.length > 0
          ? `<div style="margin-top:10px;">${hero.conceptsProgressed
              .map(
                (c) =>
                  `<span style="display:inline-block;margin:0 6px 6px 0;padding:3px 9px;border-radius:999px;background:#eef2ff;color:#3730a3;font-size:12px;font-weight:600;">${escapeHtml(
                    c
                  )}</span>`
              )
              .join('')}</div>`
          : '';

      const progressBarHtml =
        hero.totalTrials > 0
          ? `<div style="margin-top:12px;">
               <div style="font-size:12px;color:#475569;margin-bottom:4px;">Overall journey: <strong>${escapeHtml(
                 overallProgressText
               )}</strong></div>
               <div style="width:100%;height:8px;background:#e2e8f0;border-radius:999px;overflow:hidden;">
                 <div style="width:${progressPct}%;height:8px;background:#4f46e5;border-radius:999px;"></div>
               </div>
             </div>`
          : `<p style="margin:10px 0 0;font-size:13px;color:#475569;">Overall journey: <strong>${escapeHtml(
              overallProgressText
            )}</strong></p>`;

      const dragonBadge =
        hero.dragonsRescuedThisWeek > 0
          ? ` &bull; ${hero.dragonsRescuedThisWeek} ${
              hero.dragonsRescuedThisWeek === 1 ? 'dragon' : 'dragons'
            } rescued`
          : '';

      const coachingHtml = hero.coachingTip
        ? `<div style="margin-top:12px;padding:10px 12px;border-radius:8px;background:#fffbeb;border:1px solid #fde68a;font-size:13px;color:#92400e;">
             <strong>Pip's Coaching Tip:</strong> ${escapeHtml(hero.coachingTip)}
           </div>`
        : '';

      return `<div style="margin:0 0 16px;padding:18px;border-radius:12px;background:#ffffff;border:1px solid #e2e8f0;">
        <div style="font-size:18px;font-weight:700;color:#0f172a;">${escapeHtml(hero.heroName)}</div>
        <div style="margin-top:4px;font-size:13px;color:#64748b;">
          ${escapeHtml(hero.realmName)} &bull; ${escapeHtml(hero.eraName)} &bull; ${hero.byteShards} Byte Shards
        </div>
        <div style="margin-top:10px;font-size:15px;font-weight:600;color:#1e293b;">
          ${escapeHtml(trialsSummary)}${escapeHtml(dragonBadge)}
        </div>
        <div style="margin-top:4px;font-size:13px;color:#475569;">
          Active ${hero.activeDaysThisWeek} ${hero.activeDaysThisWeek === 1 ? 'day' : 'days'} this week
          ${
            hero.realmsProgressed.length > 0
              ? ` &bull; Realms: ${hero.realmsProgressed.map((r) => escapeHtml(r)).join(', ')}`
              : ''
          }
        </div>
        ${notableHtml}
        ${conceptsHtml}
        ${progressBarHtml}
        ${coachingHtml}
      </div>`;
    })
    .join('\n');

  const inactiveNoteHtml =
    digest.inactiveHeroNames.length > 0
      ? `<p style="margin:0 0 18px;font-size:13px;color:#64748b;">Resting in camp this week: ${digest.inactiveHeroNames
          .map((n) => escapeHtml(n))
          .join(', ')}.</p>`
      : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;">
    <div style="padding:20px 22px;border-radius:14px 14px 0 0;background:#1e1b4b;color:#ffffff;">
      <div style="font-size:12px;letter-spacing:1.2px;text-transform:uppercase;color:#c7d2fe;font-weight:700;">Pyria Weekly Progress</div>
      <h1 style="margin:6px 0 0;font-size:21px;line-height:1.3;color:#ffffff;">${escapeHtml(subject)}</h1>
      <div style="margin-top:6px;font-size:13px;color:#e0e7ff;">Week ${escapeHtml(digest.weekKey)}</div>
    </div>

    <div style="padding:20px 22px;background:#f1f5f9;border-radius:0 0 14px 14px;">
      <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#334155;">
        Here is a quick look at the Python adventures your ${
          digest.activeHeroes.length === 1 ? 'hero' : 'heroes'
        } completed this week in Pyria.
      </p>

      ${heroCardsHtml}
      ${inactiveNoteHtml}

      <div style="text-align:center;margin:22px 0 12px;">
        <a href="${escapeHtml(
          consoleUrl
        )}" style="display:inline-block;padding:12px 24px;border-radius:8px;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;">
          Open Parent Console
        </a>
      </div>
      <p style="margin:0;text-align:center;font-size:12px;color:#64748b;">
        View full attempt history or adjust difficulty and hint settings anytime in the Parent Console.
      </p>
    </div>

    <div style="padding:16px 8px;text-align:center;font-size:12px;color:#64748b;line-height:1.6;">
      You are receiving this weekly summary because a hero is linked to ${escapeHtml(
        digest.ownerEmail
      )} and made progress this week.<br />
      <a href="${escapeHtml(preferencesUrl)}" style="color:#4f46e5;text-decoration:underline;">Manage email preferences</a>
      &nbsp;&bull;&nbsp;
      <a href="${escapeHtml(unsubscribeUrl)}" style="color:#4f46e5;text-decoration:underline;">One-click unsubscribe</a>
    </div>
  </div>
</body>
</html>`;

  const heroSectionsText = digest.activeHeroes
    .map((hero) => {
      const lines: string[] = [
        `=== ${hero.heroName} ===`,
        `Current Realm: ${hero.realmName} (${hero.eraName}) | ${hero.byteShards} Byte Shards`,
        hero.trialsSolvedThisWeek > 0
          ? `This Week: ${hero.trialsSolvedThisWeek} Python ${
              hero.trialsSolvedThisWeek === 1 ? 'trial' : 'trials'
            } solved (${hero.activeDaysThisWeek} active ${
              hero.activeDaysThisWeek === 1 ? 'day' : 'days'
            })`
          : `This Week: New milestone reached (${hero.activeDaysThisWeek} active ${
              hero.activeDaysThisWeek === 1 ? 'day' : 'days'
            })`,
      ];
      if (hero.notableTrialsSolved.length > 0) {
        lines.push(`Highlights: ${hero.notableTrialsSolved.join(', ')}`);
      }
      if (hero.conceptsProgressed.length > 0) {
        lines.push(`Concepts Practiced: ${hero.conceptsProgressed.join(', ')}`);
      }
      if (hero.realmsProgressed.length > 0) {
        lines.push(`Realms Progressed: ${hero.realmsProgressed.join(', ')}`);
      }
      if (hero.totalTrials > 0) {
        lines.push(`Overall Progress: ${hero.overallSolvedCount} / ${hero.totalTrials} trials`);
      } else {
        lines.push(`Overall Progress: ${hero.overallSolvedCount} trials solved`);
      }
      if (hero.coachingTip) {
        lines.push(`Pip's Coaching Tip: ${hero.coachingTip}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');

  const textLines: string[] = [
    subject,
    `Week ${digest.weekKey}`,
    '',
    heroSectionsText,
  ];
  if (digest.inactiveHeroNames.length > 0) {
    textLines.push('', `Resting in camp this week: ${digest.inactiveHeroNames.join(', ')}.`);
  }
  textLines.push(
    '',
    `Open Parent Console: ${consoleUrl}`,
    `Manage Email Preferences: ${preferencesUrl}`,
    `One-Click Unsubscribe: ${unsubscribeUrl}`
  );

  return {
    to: digest.ownerEmail,
    subject,
    html,
    text: textLines.join('\n'),
    unsubscribeUrl,
    consoleUrl,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

/**
 * Build a weekly digest for a single parent account (used by admin preview and tests).
 */
export async function buildDigestForParent(
  db: PyriaD1,
  env: Env,
  ownerEmail: string,
  options?: {
    now?: Date;
    weekKey?: string;
    baseUrl?: string;
    content?: ContentIndex;
  }
): Promise<{
  digest: ParentWeeklyDigest | null;
  weeklyDigestEnabled: boolean;
  weekKey: string;
}> {
  const norm = normalizeEmail(ownerEmail);
  const now = options?.now ?? new Date();
  const weekKey = options?.weekKey || getIsoWeekKey(now);
  if (!norm) {
    return { digest: null, weeklyDigestEnabled: false, weekKey };
  }

  const windowEnd = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const windowStart = new Date(now.getTime() - SEVEN_DAYS_MS)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  const [prefs, saves, content] = await Promise.all([
    db.getParentPreferences(norm),
    db.listSavesForOwners([norm]),
    options?.content
      ? Promise.resolve(options.content)
      : loadContentIndex(
          env,
          options?.baseUrl ? options.baseUrl.replace(/\/+$/, '') : getDigestBaseUrl(env)
        ),
  ]);

  if (saves.length === 0) {
    return { digest: null, weeklyDigestEnabled: prefs.weeklyDigestEnabled, weekKey };
  }

  const saveIds = saves.map((s) => s.id);
  const [attempts, events] = await Promise.all([
    db.listAttemptsForSavesInWindow(saveIds, windowStart, windowEnd),
    db.listEventsForSavesInWindow(saveIds, windowStart, windowEnd),
  ]);

  const attemptsBySave = new Map<string, AttemptRecord[]>();
  for (const att of attempts) {
    const list = attemptsBySave.get(att.saveId) ?? [];
    list.push(att);
    attemptsBySave.set(att.saveId, list);
  }

  const eventsBySave = new Map<string, ActivityEventRecord[]>();
  for (const ev of events) {
    const list = eventsBySave.get(ev.saveId) ?? [];
    list.push(ev);
    eventsBySave.set(ev.saveId, list);
  }

  const digest = buildParentWeeklyDigest({
    ownerEmail: norm,
    weekKey,
    windowStart,
    windowEnd,
    saves,
    attemptsBySave,
    eventsBySave,
    content,
  });

  return {
    digest,
    weeklyDigestEnabled: prefs.weeklyDigestEnabled,
    weekKey,
  };
}

/**
 * Run the weekly digest job across all parent accounts with linked saves.
 * - Processes parents in bounded batches.
 * - Isolates errors per parent so one failed send never aborts the rest.
 * - Idempotent per (owner_email, week_key): skips already-sent rows.
 */
export async function runWeeklyDigestJob(
  env: Env,
  options?: {
    scheduledTime?: number;
    now?: Date;
    weekKey?: string;
    sender?: EmailSender | null;
    batchSize?: number;
    baseUrl?: string;
  }
): Promise<DigestRunSummary> {
  const now =
    options?.now ??
    (typeof options?.scheduledTime === 'number' ? new Date(options.scheduledTime) : new Date());
  const weekKey = options?.weekKey || getIsoWeekKey(now);
  const windowEnd = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const windowStart = new Date(now.getTime() - SEVEN_DAYS_MS)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  const db = new PyriaD1(env);
  const baseUrl = options?.baseUrl ? options.baseUrl.replace(/\/+$/, '') : getDigestBaseUrl(env);
  const configuredBatch = Number.parseInt(env.PYRIA_DIGEST_BATCH_SIZE || '', 10);
  const batchSize = Math.max(
    1,
    Math.min(
      100,
      options?.batchSize ??
        (Number.isFinite(configuredBatch) && configuredBatch > 0
          ? configuredBatch
          : DEFAULT_DIGEST_BATCH_SIZE)
    )
  );

  const summary: DigestRunSummary = {
    weekKey,
    evaluatedParents: 0,
    eligibleParents: 0,
    skippedNoProgress: 0,
    skippedDisabled: 0,
    skippedAlreadySent: 0,
    sentCount: 0,
    failedCount: 0,
    errors: [],
  };

  const sender = options?.sender !== undefined ? options.sender : createEmailSender(env);
  if (!sender) {
    console.warn('[weekly-digest] Skipping run: no EMAIL_API_KEY or SEND_EMAIL binding configured.');
    return summary;
  }

  const secret = getSessionSecret(env);
  const from = getEmailFrom(env);

  const [allParents, alreadySentOwners, content] = await Promise.all([
    db.listParentEmailsWithSaves(),
    db.listSentDigestOwnersForWeek(weekKey),
    loadContentIndex(env, baseUrl),
  ]);

  summary.evaluatedParents = allParents.length;
  if (allParents.length === 0) {
    return summary;
  }

  for (let i = 0; i < allParents.length; i += batchSize) {
    const batchOwners = allParents.slice(i, i + batchSize);
    const pendingOwners: string[] = [];

    for (const email of batchOwners) {
      if (alreadySentOwners.has(email)) {
        summary.skippedAlreadySent += 1;
      } else {
        pendingOwners.push(email);
      }
    }
    if (pendingOwners.length === 0) continue;

    const prefsMap = await db.getParentPreferencesMap(pendingOwners);
    const enabledOwners: string[] = [];
    for (const email of pendingOwners) {
      const pref = prefsMap.get(email);
      if (pref && !pref.weeklyDigestEnabled) {
        summary.skippedDisabled += 1;
      } else {
        enabledOwners.push(email);
      }
    }
    if (enabledOwners.length === 0) continue;

    const batchSaves = await db.listSavesForOwners(enabledOwners);
    const saveIds = batchSaves.map((s) => s.id);
    const [batchAttempts, batchEvents] = await Promise.all([
      db.listAttemptsForSavesInWindow(saveIds, windowStart, windowEnd),
      db.listEventsForSavesInWindow(saveIds, windowStart, windowEnd),
    ]);

    const savesByOwner = new Map<string, SaveRecord[]>();
    for (const save of batchSaves) {
      const norm = normalizeEmail(save.ownerEmail);
      if (!norm) continue;
      const list = savesByOwner.get(norm) ?? [];
      list.push(save);
      savesByOwner.set(norm, list);
    }

    const attemptsBySave = new Map<string, AttemptRecord[]>();
    for (const att of batchAttempts) {
      const list = attemptsBySave.get(att.saveId) ?? [];
      list.push(att);
      attemptsBySave.set(att.saveId, list);
    }

    const eventsBySave = new Map<string, ActivityEventRecord[]>();
    for (const ev of batchEvents) {
      const list = eventsBySave.get(ev.saveId) ?? [];
      list.push(ev);
      eventsBySave.set(ev.saveId, list);
    }

    for (const ownerEmail of enabledOwners) {
      const saves = savesByOwner.get(ownerEmail) ?? [];
      const digest = buildParentWeeklyDigest({
        ownerEmail,
        weekKey,
        windowStart,
        windowEnd,
        saves,
        attemptsBySave,
        eventsBySave,
        content,
      });

      if (!digest) {
        summary.skippedNoProgress += 1;
        continue;
      }

      summary.eligibleParents += 1;

      try {
        const unsubToken = await createUnsubscribeToken(ownerEmail, secret);
        const rendered = renderWeeklyDigestEmail(digest, {
          baseUrl,
          unsubscribeToken: unsubToken,
        });

        const result = await sender.send({
          to: rendered.to,
          from,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          headers: rendered.headers,
        });

        await db.recordDigestDelivery({
          ownerEmail,
          weekKey,
          heroCount: digest.activeHeroes.length,
          trialsSolved: digest.totalTrialsSolved,
          status: 'sent',
          providerMessageId: result.providerMessageId,
          sentAt: utcNowIso(),
        });

        alreadySentOwners.add(ownerEmail);
        summary.sentCount += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        summary.failedCount += 1;
        summary.errors.push({ ownerEmail, error: msg });
        try {
          await db.recordDigestDelivery({
            ownerEmail,
            weekKey,
            heroCount: digest.activeHeroes.length,
            trialsSolved: digest.totalTrialsSolved,
            status: 'failed',
            errorMessage: msg,
            sentAt: utcNowIso(),
          });
        } catch (dbErr) {
          console.error('[weekly-digest] Failed to record delivery failure:', dbErr);
        }
      }
    }
  }

  return summary;
}
