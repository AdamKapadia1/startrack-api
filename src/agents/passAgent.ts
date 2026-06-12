import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
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
  minElevation:       number;
  alertMinutesBefore: number;
  enabled:            boolean;
}

const DEFAULT_ALERT_CONFIG: AlertConfig = {
  minElevation:       60,
  alertMinutesBefore: 10,
  enabled:            true,
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

async function sendNtfy(pass: Pass, minutesAway: number): Promise<void> {
  const score    = passScore(pass.maxEl);
  const quality  = qualityLabel(score);
  const timeStr  = utcToLocal(pass.startUTC);
  const durationM = Math.round((pass.duration ?? 600) / 60);

  const title    = `StarTrack — Pass in ${minutesAway} minute${minutesAway === 1 ? '' : 's'}`;
  const body     = `${pass.satname} reaches ${Math.round(pass.maxEl)}° at ${timeStr} BST. Signal score: ${score}/100. Duration: ~${durationM}m. Quality: ${quality}`;
  const priority = quality === 'Excellent' ? 'high' : 'default';
  const tags     = quality === 'Excellent' ? 'satellite,starlink' : 'satellite';

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

  const passes       = await getAllStarlinkPasses(DEFAULT_OBS);
  const now          = Math.floor(Date.now() / 1000);
  const windowSecs   = alertConfig.alertMinutesBefore * 60;
  const reminderSecs = 2 * 60;
  const alerts: NotificationAlert[] = [];

  for (const pass of passes) {
    if (pass.maxEl < alertConfig.minElevation) continue;
    if (pass.startUTC <= now) continue;

    const secsAway    = pass.startUTC - now;
    const minutesAway = Math.max(1, Math.round(secsAway / 60));
    const initKey     = `${pass.startUTC}`;
    const reminderKey = `${pass.startUTC}-r`;

    // Initial alert
    if (secsAway <= windowSecs && !notifiedPasses.has(initKey)) {
      notifiedPasses.add(initKey);
      try {
        await sendNtfy(pass, minutesAway);
        console.log(`[ntfy] initial alert: ${pass.satname} in ${minutesAway}min`);
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
        await sendNtfy(pass, minutesAway);
        console.log(`[ntfy] 2-min reminder: ${pass.satname}`);
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
          content: `You are a satellite connectivity assistant. Current date and time in UK (BST): ${bstFallbackNow}\n\nScheduled pass data is temporarily being computed. However, there are currently ${currentSatellites.length} Starlink satellites visible overhead from ${locationName}:\n\n${satList}\n\nWrite 2–3 sentences assessing current connectivity based on what is overhead right now. Focus on the highest-elevation satellite. Mention that scheduled pass data will be available shortly.`,
        }],
      });

      const response = await stream.finalMessage();
      let recommendation = '';
      for (const block of response.content) {
        if (block.type === 'text') { recommendation = block.text; break; }
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
        content: `You are a satellite connectivity assistant tracking Starlink satellites over ${locationName}.\n\nCurrent date and time in UK (BST): ${bstNow}\n\nHere are the top upcoming passes over the next 7 days (all times in BST/Europe/London):\n\n${passDescriptions}\n\n${bestDesc}\n\nWrite a 2–3 sentence plain-English recommendation. Identify the single best connectivity window of the entire week — name the satellite, date, time in BST, and peak elevation. Mention what it is ideal for (video calls, IoT sync, etc.). Always refer to dates relative to today.`,
      },
    ],
  });

  const response = await stream.finalMessage();

  let recommendation = '';
  for (const block of response.content) {
    if (block.type === 'text') { recommendation = block.text; break; }
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
