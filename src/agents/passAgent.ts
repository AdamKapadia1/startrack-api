import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import notifier from 'node-notifier';

const N2YO_KEY  = process.env.N2YO_API_KEY ?? 'GMVRQ4-MY5LN2-UZUBTB-5RSS';
const N2YO_BASE = 'https://api.n2yo.com/rest/v1/satellite';
const OBS       = { lat: 51.7957, lon: -0.6572, alt: 148 } as const;
const STARLINK_CAT = 52;
const MAX_SATS     = 5;   // how many overhead Starlinks to query passes for
const MIN_PASS_EL  = 30;  // minimum elevation for pass results (degrees)

export interface Pass {
  startUTC: number;
  maxUTC: number;
  endUTC: number;
  maxEl: number;
  startAz: number;
  maxAz: number;
  duration: number;
  satname: string;
}

export interface PassRecommendation {
  recommendation: string;
  satname: string;
  topPasses: Pass[];
}

function utcToLocal(utc: number): string {
  return new Date(utc * 1000).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/London',
  });
}

// Deduplication set keyed by startUTC to avoid repeat desktop notifications.
const notifiedPasses = new Set<number>();

export interface NotificationAlert {
  satname: string;
  maxEl: number;
  minutesAway: number;
  startUTC: number;
}

export interface NotificationCheckResult {
  checked: number;
  alerted: number;
  alerts: NotificationAlert[];
}

// ── In-memory cache for overhead Starlink satellite list ─────────────────────
// search_radius=10 means elevation > 10° (N2YO param is minimum elevation angle).
// Refreshed every 15 minutes to avoid burning N2YO transactions.

interface SatEntry { satid: number; satname: string; }
let _satsCache: { data: SatEntry[]; fetchedAt: number } | null = null;
const SATS_TTL_S = 15 * 60;

async function fetchStarlinkSats(): Promise<SatEntry[]> {
  const now = Math.floor(Date.now() / 1000);
  if (_satsCache && (now - _satsCache.fetchedAt) < SATS_TTL_S) {
    return _satsCache.data;
  }
  const url = `${N2YO_BASE}/above/${OBS.lat}/${OBS.lon}/${OBS.alt}/10/${STARLINK_CAT}/&apiKey=${N2YO_KEY}`;
  const { data } = await axios.get(url, { timeout: 30000 });
  const sats: SatEntry[] = ((data.above ?? []) as any[])
    .slice(0, MAX_SATS)
    .map(s => ({ satid: s.satid as number, satname: s.satname as string }));
  _satsCache = { data: sats, fetchedAt: now };
  return sats;
}

// ── Get radio passes for one satellite ──────────────────────────────────────

async function fetchPassesForSat(satid: number, satname: string): Promise<Pass[]> {
  const url = `${N2YO_BASE}/radiopasses/${satid}/${OBS.lat}/${OBS.lon}/${OBS.alt}/1/${MIN_PASS_EL}/&apiKey=${N2YO_KEY}`;
  const { data } = await axios.get(url, { timeout: 30000 });
  return ((data.passes ?? []) as any[]).map(p => ({
    startUTC: p.startUTC as number,
    maxUTC:   p.maxUTC   as number,
    endUTC:   p.endUTC   as number,
    maxEl:    p.maxEl    as number,
    startAz:  p.startAz  as number,
    maxAz:    p.maxAz    as number,
    duration: (p.duration ?? (p.endUTC - p.startUTC)) as number,
    satname,
  }));
}

// ── Combined: fetch overhead Starlinks → their passes → sort by maxEl ────────

async function getAllStarlinkPasses(): Promise<Pass[]> {
  const sats = await fetchStarlinkSats();
  if (!sats.length) return [];

  const results = await Promise.allSettled(
    sats.map(({ satid, satname }) => fetchPassesForSat(satid, satname))
  );

  const allPasses: Pass[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') allPasses.push(...r.value);
  }

  return allPasses.sort((a, b) => b.maxEl - a.maxEl);
}

// ── Public: check for imminent high-elevation passes and notify ───────────────

export async function checkAndNotify(): Promise<NotificationCheckResult> {
  const passes    = await getAllStarlinkPasses();
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
      notifier.notify({
        title:   'StarTrack',
        message: `${pass.satname} passes at ${Math.round(pass.maxEl)}° in ${minutesAway} min. Good Starlink window.`,
        sound:   true,
      });
      alerts.push({ satname: pass.satname, maxEl: pass.maxEl, minutesAway, startUTC: pass.startUTC });
    }
  }

  return { checked: passes.length, alerted: alerts.length, alerts };
}

// ── Public: AI recommendation over upcoming Starlink passes ─────────────────

export async function getPassRecommendation(): Promise<PassRecommendation> {
  const allPasses = await getAllStarlinkPasses();
  const topPasses = allPasses.slice(0, 10);

  if (!topPasses.length) {
    return {
      recommendation: 'No Starlink passes found in the next 24 hours over Tring. This may be a temporary gap — the constellation will return shortly.',
      satname:   'Starlink',
      topPasses: [],
    };
  }

  const passDescriptions = topPasses
    .slice(0, 5)
    .map((p, i) => {
      const start = utcToLocal(p.startUTC);
      const peak  = utcToLocal(p.maxUTC);
      return `Pass ${i + 1}: ${p.satname}, starts ${start}, peaks ${peak} at ${p.maxEl}°, duration ${p.duration}s`;
    })
    .join('\n');

  const client = new Anthropic();

  const stream = client.messages.stream({
    model:      'claude-opus-4-8',
    max_tokens: 256,
    thinking:   { type: 'adaptive' },
    messages: [
      {
        role:    'user',
        content: `You are a satellite connectivity assistant tracking Starlink satellites over Tring, Hertfordshire. Here are the next upcoming Starlink passes:\n\n${passDescriptions}\n\nWrite a single plain-English recommendation (2–3 sentences) identifying the best connectivity window and what it is ideal for. Name the specific satellite, time and elevation.`,
      },
    ],
  });

  const response = await stream.finalMessage();

  let recommendation = '';
  for (const block of response.content) {
    if (block.type === 'text') { recommendation = block.text; break; }
  }

  return { recommendation, satname: topPasses[0].satname, topPasses };
}
