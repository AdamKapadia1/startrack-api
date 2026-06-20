import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { getActiveSatellites, getAllSatellites } from '../utils/tleCache.js';
import { predictPasses } from '../utils/passPredictor.js';
import type { PredictedPass } from '../utils/passPredictor.js';

const DEFAULT_OBS = { lat: 51.7957, lon: -0.6572, alt: 148 } as const;
const MIN_PASS_EL = 30;

const NTFY_TOPIC = 'startrack-tring-alerts';
const NTFY_URL   = `https://ntfy.sh/${NTFY_TOPIC}`;
const APP_URL    = 'https://startrackv1-ui.vercel.app';

// ── Alert config ──────────────────────────────────────────────────────────────

export interface AlertConfig {
  minElevation:            number;
  alertMinutesBefore:      number;
  enabled:                 boolean;
  favouriteSatellitesOnly: boolean;
  favouriteSatelliteNames: string[];
}

const DEFAULT_ALERT_CONFIG: AlertConfig = {
  minElevation:            60,
  alertMinutesBefore:      10,
  enabled:                 true,
  favouriteSatellitesOnly: false,
  favouriteSatelliteNames: [],
};

let alertConfig: AlertConfig = { ...DEFAULT_ALERT_CONFIG };

const CONFIG_PATH = path.resolve(process.cwd(), 'data', 'alertSettings.json');

function loadAlertConfig(): void {
  try {
    const text   = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(text) as Partial<AlertConfig>;
    alertConfig  = { ...DEFAULT_ALERT_CONFIG, ...parsed };
    console.log('[passAgent] alert config loaded:', alertConfig);
  } catch { /* use defaults on first run */ }
}

function persistAlertConfig(): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(alertConfig, null, 2), 'utf8');
  } catch (err: any) {
    console.error('[passAgent] failed to persist config:', err.message);
  }
}

loadAlertConfig();

export function setAlertConfig(cfg: Partial<AlertConfig>): AlertConfig {
  alertConfig = { ...alertConfig, ...cfg };
  persistAlertConfig();
  return { ...alertConfig };
}

export function getAlertConfig(): AlertConfig {
  return { ...alertConfig };
}

export interface Pass {
  startUTC: number;
  maxUTC:   number;
  endUTC:   number;
  maxEl:    number;
  startAz:  number;
  maxAz:    number;
  duration: number;
  satname:  string;
}

export interface PassRecommendation {
  recommendation: string;
  satname:   string;
  topPasses: Pass[];
  today:     Pass[];
  tomorrow:  Pass[];
  thisWeek:  Pass[];
  bestPass:  Pass | null;
}

export interface NotificationAlert {
  satname:     string;
  maxEl:       number;
  minutesAway: number;
  startUTC:    number;
}

export interface NotificationCheckResult {
  checked: number;
  alerted: number;
  alerts:  NotificationAlert[];
}

type Obs = { lat: number; lon: number; alt: number };

function obsKey(obs: Obs) {
  return `${obs.lat.toFixed(4)},${obs.lon.toFixed(4)},${obs.alt}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Replaces all dash variants used as clause separators with ", ".
// Covers: U+2014 em dash, U+2013 en dash, U+2015 horizontal bar, U+2212 minus sign.
// Handles spaced (" — "), leading-spaced (" —"), trailing-spaced ("— "), and
// unspaced ("—") forms. Collapses any double spaces left after replacement.
function sanitiseDashes(text: string): string {
  return text
    .replace(/ *[—–―−] */g, ', ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function utcToLocal(utc: number): string {
  return new Date(utc * 1000).toLocaleTimeString('en-GB', {
    hour:     '2-digit',
    minute:   '2-digit',
    timeZone: 'Europe/London',
  });
}

function utcToDate(utc: number): string {
  return new Date(utc * 1000).toLocaleDateString('en-GB', {
    weekday:  'short',
    day:      'numeric',
    month:    'short',
    timeZone: 'Europe/London',
  });
}

// Returns Unix seconds for London midnight on today+daysOffset, correctly handling BST/GMT.
// Uses sv-SE locale (YYYY-MM-DD) to avoid V8's ambiguous MM/DD/YYYY parsing of en-GB strings.
function londonDayStartSecs(daysOffset = 0): number {
  const d   = new Date(Date.now() + daysOffset * 86_400_000);
  const ymd = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/London' }).format(d); // "2026-06-12"
  const [y, m, day] = ymd.split('-').map(Number);
  const utcMidnightMs = Date.UTC(y, m - 1, day);
  // Ask London what hour UTC-midnight appears as (0 = GMT, 1 = BST)
  const londonHourAtUtcMidnight = parseInt(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23' })
      .format(new Date(utcMidnightMs)),
  );
  // London midnight = UTC midnight minus that offset
  return Math.floor((utcMidnightMs - londonHourAtUtcMidnight * 3_600_000) / 1000);
}

function groupPassesByDay(passes: Pass[]): { today: Pass[]; tomorrow: Pass[]; thisWeek: Pass[] } {
  const nowSec        = Math.floor(Date.now() / 1000);
  const todayStart    = londonDayStartSecs(0);
  const tomorrowStart = londonDayStartSecs(1);
  const dayAfterStart = londonDayStartSecs(2);
  const weekEnd       = londonDayStartSecs(7);

  const future = passes.filter(p => p.startUTC > nowSec);

  return {
    today:    future.filter(p => p.startUTC >= todayStart    && p.startUTC < tomorrowStart),
    tomorrow: future.filter(p => p.startUTC >= tomorrowStart && p.startUTC < dayAfterStart),
    thisWeek: future.filter(p => p.startUTC >= dayAfterStart && p.startUTC < weekEnd),
  };
}

// ── Pass cache (6-hour TTL, keyed by location, computed locally via SGP4) ────

const _passesCacheMap = new Map<string, { data: Pass[]; fetchedAt: number }>();
const PASSES_TTL_S = 6 * 60 * 60;

async function getAllStarlinkPasses(obs: Obs = DEFAULT_OBS): Promise<Pass[]> {
  const key = obsKey(obs);
  const now = Math.floor(Date.now() / 1000);
  const cached = _passesCacheMap.get(key);
  if (cached && (now - cached.fetchedAt) < PASSES_TTL_S) return cached.data;

  // Ensure TLE cache is warm, then sample evenly for orbital plane diversity
  await getActiveSatellites(1);
  const allTles = getAllSatellites();
  const stride  = Math.max(1, Math.floor(allTles.length / 200));
  const tles    = allTles.filter((_, i) => i % stride === 0);
  const altKm   = obs.alt / 1000;
  console.log(`[passAgent] TLEs loaded: ${allTles.length}, sampled: ${tles.length} (stride ${stride})`);

  // 2-min step; cached 6 hours so first-request compute cost is acceptable
  const raw: PredictedPass[] = predictPasses(tles, obs.lat, obs.lon, altKm, 7, 120, MIN_PASS_EL);

  // Convert PredictedPass → Pass (shapes are compatible; just assert type)
  const sorted = (raw as Pass[]).sort((a, b) => b.maxEl - a.maxEl);

  // Only cache non-empty results; if 0 passes found, return without caching so next request retries
  if (sorted.length > 0) {
    _passesCacheMap.set(key, { data: sorted, fetchedAt: now });
  }
  console.log(`[passAgent] SGP4 computed ${sorted.length} passes for ${key} (7-day window, ${tles.length} sats)`);
  return sorted;
}

// ── ntfy.sh push notification ─────────────────────────────────────────────────

function passScore(maxEl: number): number {
  return Math.round(40 + (maxEl / 90) * 60);
}

function qualityLabel(score: number): string {
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 50) return 'Fair';
  return 'Poor';
}

async function sendNtfy(pass: Pass, minutesAway: number, isFavourite = false): Promise<void> {
  const score     = passScore(pass.maxEl);
  const quality   = qualityLabel(score);
  const timeStr   = utcToLocal(pass.startUTC);
  const durationM = Math.round((pass.duration ?? 600) / 60);

  const title = isFavourite
    ? `⭐ Your favourite ${pass.satname} is passing in ${minutesAway} minute${minutesAway === 1 ? '' : 's'}`
    : `StarTrack — Pass in ${minutesAway} minute${minutesAway === 1 ? '' : 's'}`;

  const body     = `${pass.satname} reaches ${Math.round(pass.maxEl)}° at ${timeStr} BST. Signal score: ${score}/100. Duration: ~${durationM}m. Quality: ${quality}`;
  const priority = quality === 'Excellent' ? 'high' : 'default';
  const tags     = isFavourite ? 'star,satellite' : (quality === 'Excellent' ? 'satellite,starlink' : 'satellite');

  await axios.post(NTFY_URL, body, {
    headers: {
      'Title':        title,
      'Priority':     priority,
      'Tags':         tags,
      'Click':        APP_URL,
      'Content-Type': 'text/plain',
    },
    timeout: 10_000,
  });
}

// ── Alert tracking (cleared every 24 h to allow re-alerting) ─────────────────

const notifiedPasses = new Set<string>();

setInterval(() => {
  notifiedPasses.clear();
  console.log('[notifications] daily alert-tracking sets cleared');
}, 24 * 60 * 60 * 1_000);

// ── Public: alert on imminent high-elevation passes ───────────────────────────

export async function checkAndNotify(): Promise<NotificationCheckResult> {
  if (!alertConfig.enabled) return { checked: 0, alerted: 0, alerts: [] };

  const isFavMode = alertConfig.favouriteSatellitesOnly;

  // Resolve observer location: read from Supabase app_settings at check time so the location
  // survives Railway redeploys. Falls back to DEFAULT_OBS (Tring) when Supabase is unavailable.
  let obs: Obs = DEFAULT_OBS;
  const sb = _getSupabase();
  if (sb) {
    const { data: settingsRow } = await sb
      .from('app_settings')
      .select('value')
      .eq('key', 'observer')
      .maybeSingle();
    if (settingsRow?.value) {
      const { lat, lon, alt } = settingsRow.value as { lat?: number; lon?: number; alt?: number };
      if (typeof lat === 'number' && typeof lon === 'number' && typeof alt === 'number') {
        obs = { lat, lon, alt };
        console.log(`[passAgent] observer from Supabase: ${lat.toFixed(4)},${lon.toFixed(4)}`);
      }
    }
  }

  let passes: Pass[];

  if (isFavMode) {
    // Read favourite satellite names from Supabase at check time so the list survives redeploys
    // and does not depend on a client POST having been made since the last Railway deployment.
    // Falls back to in-memory alertConfig.favouriteSatelliteNames when Supabase is unavailable.
    let favNames: string[] = [];
    if (sb) {
      const { data: favRows } = await sb
        .from('favourite_satellites')
        .select('satellite_name');
      favNames = (favRows ?? []).map((r: { satellite_name: string }) => r.satellite_name.toUpperCase());
      console.log(`[passAgent] favourites from Supabase: ${favNames.length} satellites`);
    }
    if (favNames.length === 0) {
      favNames = alertConfig.favouriteSatelliteNames.map(n => n.toUpperCase());
      console.log(`[passAgent] favourites fallback to in-memory: ${favNames.length} satellites`);
    }
    if (favNames.length === 0) return { checked: 0, alerted: 0, alerts: [] };

    await getActiveSatellites(1);
    const allTles = getAllSatellites();
    const favTles = allTles.filter(t => favNames.includes(t.name.toUpperCase()));
    const altKm   = obs.alt / 1000;
    const raw     = predictPasses(favTles, obs.lat, obs.lon, altKm, 7, 120, 10);
    passes = (raw as Pass[]).sort((a, b) => b.maxEl - a.maxEl);
    console.log(`[passAgent] favourites mode: ${favTles.length} TLEs matched, ${passes.length} passes found at ${obs.lat.toFixed(4)},${obs.lon.toFixed(4)}`);
  } else {
    passes = await getAllStarlinkPasses(obs);
  }

  const now          = Math.floor(Date.now() / 1000);
  const windowSecs   = alertConfig.alertMinutesBefore * 60;
  const reminderSecs = 2 * 60;
  const alerts: NotificationAlert[] = [];

  for (const pass of passes) {
    // In standard mode: skip passes below elevation threshold
    if (!isFavMode && pass.maxEl < alertConfig.minElevation) continue;
    if (pass.startUTC <= now) continue;

    const secsAway    = pass.startUTC - now;
    const minutesAway = Math.max(1, Math.round(secsAway / 60));
    const initKey     = `${pass.startUTC}-${pass.satname}`;
    const reminderKey = `${pass.startUTC}-${pass.satname}-r`;

    // Initial alert
    if (secsAway <= windowSecs && !notifiedPasses.has(initKey)) {
      notifiedPasses.add(initKey);
      try {
        await sendNtfy(pass, minutesAway, isFavMode);
        console.log(`[ntfy] initial alert: ${pass.satname} in ${minutesAway}min (fav=${isFavMode})`);
      } catch (err: any) {
        console.error('[ntfy] push failed:', err.message);
      }
      alerts.push({ satname: pass.satname, maxEl: pass.maxEl, minutesAway, startUTC: pass.startUTC });
    }

    // 2-minute reminder (only after initial alert was already sent)
    if (
      secsAway <= reminderSecs &&
      notifiedPasses.has(initKey) &&
      !notifiedPasses.has(reminderKey)
    ) {
      notifiedPasses.add(reminderKey);
      try {
        await sendNtfy(pass, minutesAway, isFavMode);
        console.log(`[ntfy] 2-min reminder: ${pass.satname} (fav=${isFavMode})`);
      } catch (err: any) {
        console.error('[ntfy] reminder push failed:', err.message);
      }
      alerts.push({ satname: pass.satname, maxEl: pass.maxEl, minutesAway, startUTC: pass.startUTC });
    }
  }

  return { checked: passes.length, alerted: alerts.length, alerts };
}

// ── Public: AI recommendation over 7-day Starlink passes ─────────────────────

// Shape shared with index.ts — avoid importing from there to prevent circular deps
export interface VisibleSatellite {
  satname:         string;
  elevation:       number;
  azimuth:         number;
  range:           number;
  dopplerShiftKHz: number | null;
}

export async function getPassRecommendation(
  obs: Obs = DEFAULT_OBS,
  locationName = 'Tring, Hertfordshire',
  currentSatellites: VisibleSatellite[] = [],
): Promise<PassRecommendation> {
  const allPasses = await getAllStarlinkPasses(obs);
  const now       = Math.floor(Date.now() / 1000);
  const future    = allPasses.filter(p => p.startUTC > now);

  const { today, tomorrow, thisWeek } = groupPassesByDay(future);

  const topPasses = future.slice(0, 10);

  const bestPass = future.length > 0
    ? future.reduce((best, p) => p.maxEl > best.maxEl ? p : best, future[0])
    : null;

  if (!topPasses.length) {
    // N2YO rate-limited or no passes — fall back to currently visible satellites
    if (currentSatellites.length > 0) {
      const satList = currentSatellites.slice(0, 5).map(s => {
        const d = s.dopplerShiftKHz != null
          ? `, Doppler ${s.dopplerShiftKHz > 0 ? '+' : ''}${s.dopplerShiftKHz.toFixed(1)} kHz`
          : '';
        return `${s.satname}: elevation ${s.elevation}°, azimuth ${s.azimuth}°, range ${s.range} km${d}`;
      }).join('\n');

      const bstFallbackNow = new Date().toLocaleString('en-GB', {
        timeZone: 'Europe/London', weekday: 'long', year: 'numeric',
        month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      const client = new Anthropic();
      const stream = client.messages.stream({
        model:    'claude-opus-4-8',
        max_tokens: 300,
        thinking:   { type: 'adaptive' },
        messages: [{
          role:    'user',
          content: `You are a satellite connectivity assistant. Current date and time in UK (BST): ${bstFallbackNow}\n\nScheduled pass data is temporarily being computed. However, there are currently ${currentSatellites.length} Starlink satellites visible overhead from ${locationName}:\n\n${satList}\n\nWrite 2 to 3 sentences in British English assessing current connectivity based on what is overhead right now. Focus on the highest-elevation satellite. Mention that scheduled pass data will be available shortly. Do not use em dashes, en dashes, or any long dash symbol. Use commas or full stops to join clauses instead.`,
        }],
      });

      const response = await stream.finalMessage();
      let recommendation = '';
      for (const block of response.content) {
        if (block.type === 'text') { recommendation = sanitiseDashes(block.text); break; }
      }

      return {
        recommendation,
        satname:   currentSatellites[0].satname,
        topPasses: [],
        today,
        tomorrow,
        thisWeek,
        bestPass:  null,
      };
    }

    return {
      recommendation: `No Starlink passes found in the next 7 days over ${locationName}. N2YO pass data may be temporarily rate-limited — check back in a few minutes.`,
      satname:   'Starlink',
      topPasses: [],
      today,
      tomorrow,
      thisWeek,
      bestPass:  null,
    };
  }

  const bstNow = new Date().toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const passDescriptions = topPasses
    .slice(0, 5)
    .map((p, i) => {
      const start = utcToLocal(p.startUTC);
      const peak  = utcToLocal(p.maxUTC);
      const date  = utcToDate(p.startUTC);
      return `Pass ${i + 1}: ${p.satname}, ${date} at ${start} BST, peaks ${peak} BST at ${p.maxEl.toFixed(1)}°, duration ${p.duration}s`;
    })
    .join('\n');

  const bestDesc = bestPass
    ? `Best pass of the week: ${bestPass.satname} on ${utcToDate(bestPass.startUTC)} at ${utcToLocal(bestPass.startUTC)} BST, peaking at ${bestPass.maxEl.toFixed(1)}°`
    : '';

  const client = new Anthropic();

  const stream = client.messages.stream({
    model:      'claude-opus-4-8',
    max_tokens: 300,
    thinking:   { type: 'adaptive' },
    messages: [
      {
        role:    'user',
        content: `You are a satellite connectivity assistant tracking Starlink satellites over ${locationName}.\n\nCurrent date and time in UK (BST): ${bstNow}\n\nHere are the top upcoming passes over the next 7 days (all times in BST/Europe/London):\n\n${passDescriptions}\n\n${bestDesc}\n\nWrite a 2 to 3 sentence plain-English recommendation in British English. Identify the single best connectivity window of the entire week: name the satellite, date, time in BST, and peak elevation. Mention what it is ideal for (video calls, IoT sync, etc.). Always refer to dates relative to today. Do not use em dashes, en dashes, or any long dash symbol. Use commas or full stops to join clauses instead.`,
      },
    ],
  });

  const response = await stream.finalMessage();

  let recommendation = '';
  for (const block of response.content) {
    if (block.type === 'text') { recommendation = sanitiseDashes(block.text); break; }
  }

  return {
    recommendation,
    satname:   topPasses[0].satname,
    topPasses,
    today,
    tomorrow,
    thisWeek,
    bestPass,
  };
}

export const NTFY_SUBSCRIBE_URL = NTFY_URL;

// ── Daily digest ──────────────────────────────────────────────────────────────

export interface DigestResult {
  title:      string;
  body:       string;
  passCount:  number;
  sent:       boolean;
}

export async function sendDailyDigest(): Promise<DigestResult> {
  const now    = Math.floor(Date.now() / 1000);
  const in24h  = now + 24 * 60 * 60;

  const allPasses = await getAllStarlinkPasses(DEFAULT_OBS);
  const next24h   = allPasses.filter(p => p.startUTC >= now && p.startUTC <= in24h);

  // Try ≥60° first, fall back to ≥40° if fewer than 3 qualify
  let top = next24h
    .filter(p => p.maxEl >= 60)
    .sort((a, b) => passScore(b.maxEl) - passScore(a.maxEl))
    .slice(0, 3);

  if (top.length < 3) {
    top = next24h
      .filter(p => p.maxEl >= 40)
      .sort((a, b) => passScore(b.maxEl) - passScore(a.maxEl))
      .slice(0, 3);
  }

  const dateStr = new Date().toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', timeZone: 'Europe/London',
  });
  const title = `☀️ StarTrack Daily Digest — ${dateStr}`;

  const lines = top.map((p, i) => {
    const quality = qualityLabel(passScore(p.maxEl));
    return `${i + 1}. ${p.satname} at ${utcToLocal(p.startUTC)} — ${Math.round(p.maxEl)}° (${quality})`;
  });

  const body = top.length > 0
    ? `Today's best connectivity windows:\n\n${lines.join('\n')}\n\nPlan your video calls and large transfers around these times.`
    : "No high-quality passes predicted for today. Signal conditions may be limited.";

  await axios.post(NTFY_URL, body, {
    headers: {
      'Title':        title,
      'Priority':     'default',
      'Tags':         'sunrise,satellite',
      'Click':        APP_URL,
      'Content-Type': 'text/plain',
    },
    timeout: 10_000,
  });

  console.log(`[digest] sent: ${top.length} passes`);
  return { title, body, passCount: top.length, sent: true };
}

// ── Historical pattern analysis ───────────────────────────────────────────────

function _getSupabase() {
  const url = process.env.SUPABASE_URL     ?? '';
  const key = process.env.SUPABASE_ANON_KEY ?? '';
  if (!url || !key) return null;
  return createClient(url, key);
}

function _fmtHour(h: number): string {
  if (h === 0)  return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

export interface HourScore { hour: number; avgScore: number; }

export interface PatternAnalysis {
  available:    boolean;
  message?:     string;
  dataPoints?:  number;
  insight?:     string;
  bestHours?:   HourScore[];
  worstHours?:  HourScore[];
  trend?:       string;
  hourlyScores?: HourScore[];
}

export async function analyzeHistoricalPatterns(): Promise<PatternAnalysis> {
  const supabase = _getSupabase();
  if (!supabase) {
    console.warn('[patterns] Supabase not configured — missing env vars');
    return { available: false, message: 'Database not configured.', dataPoints: 0 };
  }

  // Log total row count for debugging
  const { count: totalCount } = await supabase
    .from('pass_predictions')
    .select('*', { count: 'exact', head: true });
  console.log('[patterns] total rows in pass_predictions:', totalCount);

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('pass_predictions')
    .select('computed_at, signal_score, max_elevation')
    .gte('computed_at', sevenDaysAgo)
    .order('computed_at', { ascending: true });

  console.log('[patterns] 7-day query returned:', data?.length ?? 0, 'rows, error:', error?.message ?? 'none');

  if (error) {
    console.error('[patterns] Supabase query failed:', error.message, error);
    return { available: false, message: 'Could not query history.', dataPoints: 0 };
  }

  const rows = (data ?? []).filter(r => typeof r.signal_score === 'number');

  if (rows.length < 50) {
    return {
      available:  false,
      message:    'Not enough historical data yet. Check back after a few more days of tracking.',
      dataPoints: rows.length,
    };
  }

  // Group scores by hour of day in Europe/London timezone
  const buckets = new Map<number, number[]>();
  for (const row of rows) {
    const h = parseInt(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23',
      }).format(new Date(row.computed_at)),
      10,
    );
    if (!buckets.has(h)) buckets.set(h, []);
    buckets.get(h)!.push(row.signal_score as number);
  }

  const hourlyScores: HourScore[] = Array.from({ length: 24 }, (_, h) => {
    const s = buckets.get(h) ?? [];
    return {
      hour:     h,
      avgScore: s.length > 0 ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : 0,
    };
  });

  const ranked     = [...hourlyScores].filter(x => x.avgScore > 0).sort((a, b) => b.avgScore - a.avgScore);
  const bestHours  = ranked.slice(0, 3);
  const worstHours = ranked.slice(-3).reverse();

  // Overall trend: first half vs second half of collected data
  const half       = Math.floor(rows.length / 2);
  const avgFirst   = Math.round(rows.slice(0, half).reduce((a, r) => a + r.signal_score, 0) / half);
  const avgSecond  = Math.round(rows.slice(half).reduce((a, r)  => a + r.signal_score, 0) / (rows.length - half));
  const diff       = avgSecond - avgFirst;
  const trendWord  = diff > 3 ? 'improving' : diff < -3 ? 'declining' : 'stable';
  const trend      = `${trendWord} (${avgFirst} → ${avgSecond})`;

  const bestStr  = bestHours.map(b  => `  ${_fmtHour(b.hour)}: ${b.avgScore}/100`).join('\n');
  const worstStr = worstHours.map(w => `  ${_fmtHour(w.hour)}: ${w.avgScore}/100`).join('\n');

  const prompt = `Based on 7 days of signal score data for Tring, Hertfordshire:

Best hours (average score):
${bestStr}

Worst hours (average score):
${worstStr}

Overall trend: ${trendWord} (first half avg: ${avgFirst}, second half avg: ${avgSecond})

Write a 2 to 3 sentence insight in British English about when the user gets the best connectivity, in a friendly, specific tone. Mention actual times. Do not use em dashes, en dashes, or any long dash symbol. Use commas or full stops to join clauses instead. Example style: 'Your best connectivity is consistently between 10pm and 2am, likely due to favourable orbital geometry during those hours. Avoid scheduling important calls between 2pm and 4pm when signal tends to be weakest.'`;

  const client = new Anthropic();
  const stream = client.messages.stream({
    model:      'claude-opus-4-8',
    max_tokens: 220,
    thinking:   { type: 'adaptive' },
    messages:   [{ role: 'user', content: prompt }],
  });

  const resp = await stream.finalMessage();
  let insight = '';
  for (const block of resp.content) {
    if (block.type === 'text') { insight = sanitiseDashes(block.text); break; }
  }

  return { available: true, insight, bestHours, worstHours, trend, hourlyScores };
}
