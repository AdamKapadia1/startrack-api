import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import { getActiveSatellites, getAllSatellites } from '../utils/tleCache.js';
import { predictPasses } from '../utils/passPredictor.js';
import type { PredictedPass } from '../utils/passPredictor.js';

const DEFAULT_OBS = { lat: 51.7957, lon: -0.6572, alt: 148 } as const;
const MIN_PASS_EL = 30;

const NTFY_TOPIC = 'startrack-tring-alerts';
const NTFY_URL   = `https://ntfy.sh/${NTFY_TOPIC}`;

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

function groupPassesByDay(passes: Pass[]): { today: Pass[]; tomorrow: Pass[]; thisWeek: Pass[] } {
  const now = Math.floor(Date.now() / 1000);
  const londonNow = new Date(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' }));
  londonNow.setHours(0, 0, 0, 0);
  const todayStart    = Math.floor(londonNow.getTime() / 1000);
  const tomorrowStart = todayStart + 86_400;
  const dayAfterStart = todayStart + 172_800;
  const weekEnd       = todayStart + 7 * 86_400;

  const future = passes.filter(p => p.startUTC > now);

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

  // Ensure TLE cache is warm, then use all loaded satellites
  await getActiveSatellites(1);
  const tles = getAllSatellites().slice(0, 100);
  const altKm = obs.alt / 1000;

  const raw: PredictedPass[] = predictPasses(tles, obs.lat, obs.lon, altKm, 7, 60, MIN_PASS_EL);

  // Convert PredictedPass → Pass (shapes are compatible; just assert type)
  const sorted = (raw as Pass[]).sort((a, b) => b.maxEl - a.maxEl);
  _passesCacheMap.set(key, { data: sorted, fetchedAt: now });
  console.log(`[passAgent] SGP4 computed ${sorted.length} passes for ${key} (7-day window, ${tles.length} sats)`);
  return sorted;
}

// ── ntfy.sh push notification ─────────────────────────────────────────────────

const notifiedPasses = new Set<number>();

async function sendNtfy(satname: string, maxEl: number, minutesAway: number): Promise<void> {
  await axios.post(
    NTFY_URL,
    `${satname} passes at ${Math.round(maxEl)}° in ${minutesAway} min — good connectivity window`,
    {
      headers: {
        'Title':        'StarTrack Alert',
        'Priority':     'high',
        'Tags':         'satellite',
        'Content-Type': 'text/plain',
      },
      timeout: 10_000,
    }
  );
}

// ── Public: alert on imminent high-elevation passes ───────────────────────────

export async function checkAndNotify(): Promise<NotificationCheckResult> {
  const passes    = await getAllStarlinkPasses(DEFAULT_OBS);
  const now       = Math.floor(Date.now() / 1000);
  const windowEnd = now + 10 * 60;
  const alerts: NotificationAlert[] = [];

  for (const pass of passes) {
    if (
      pass.maxEl >= 60 &&
      pass.startUTC > now &&
      pass.startUTC <= windowEnd &&
      !notifiedPasses.has(pass.startUTC)
    ) {
      notifiedPasses.add(pass.startUTC);
      const minutesAway = Math.max(1, Math.round((pass.startUTC - now) / 60));
      try {
        await sendNtfy(pass.satname, pass.maxEl, minutesAway);
      } catch (err: any) {
        console.error('[ntfy] push failed:', err.message);
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

      const client = new Anthropic();
      const stream = client.messages.stream({
        model:    'claude-opus-4-8',
        max_tokens: 300,
        thinking:   { type: 'adaptive' },
        messages: [{
          role:    'user',
          content: `You are a satellite connectivity assistant. Scheduled pass data from N2YO is temporarily unavailable (API rate limit). However, there are currently ${currentSatellites.length} Starlink satellites visible overhead from ${locationName}:\n\n${satList}\n\nWrite 2–3 sentences assessing current connectivity based on what is overhead right now. Focus on the highest-elevation satellite. Mention that scheduled pass data is temporarily unavailable and will refresh within the hour.`,
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

  const passDescriptions = topPasses
    .slice(0, 5)
    .map((p, i) => {
      const start = utcToLocal(p.startUTC);
      const peak  = utcToLocal(p.maxUTC);
      const date  = utcToDate(p.startUTC);
      return `Pass ${i + 1}: ${p.satname}, ${date} at ${start}, peaks ${peak} at ${p.maxEl.toFixed(1)}°, duration ${p.duration}s`;
    })
    .join('\n');

  const bestDesc = bestPass
    ? `Best pass of the week: ${bestPass.satname} on ${utcToDate(bestPass.startUTC)} at ${utcToLocal(bestPass.startUTC)}, peaking at ${bestPass.maxEl.toFixed(1)}°`
    : '';

  const client = new Anthropic();

  const stream = client.messages.stream({
    model:      'claude-opus-4-8',
    max_tokens: 300,
    thinking:   { type: 'adaptive' },
    messages: [
      {
        role:    'user',
        content: `You are a satellite connectivity assistant tracking Starlink satellites over ${locationName}. Here are the top upcoming passes over the next 7 days:\n\n${passDescriptions}\n\n${bestDesc}\n\nWrite a 2–3 sentence plain-English recommendation. Identify the single best connectivity window of the entire week — name the satellite, date, time, and peak elevation. Mention what it is ideal for (video calls, IoT sync, etc.).`,
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
