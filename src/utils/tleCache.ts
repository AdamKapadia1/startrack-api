import axios from 'axios';
import fs from 'fs';
import path from 'path';

export interface TleEntry {
  name: string;
  noradId: number;
  line1: string;
  line2: string;
}

interface TleCache {
  entries: TleEntry[];
  fetchedAt: number;
}

// Seed data: 406 evenly-sampled Starlink TLEs bundled at build time.
// Loaded immediately so the server works from cold start without network fetches.
type SeedEntry = { name: string; line1: string; line2: string };
const _seed: SeedEntry[] = (() => {
  try {
    const seedPath = path.resolve(__dirname, '../../src/data/starlink-seed.json');
    return JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  } catch {
    return [];
  }
})();

function seedEntries(): TleEntry[] {
  return _seed.map(s => {
    const noradId = parseInt(s.line1.substring(2, 7).trim(), 10);
    return { name: s.name, noradId, line1: s.line1, line2: s.line2 };
  }).filter(e => !isNaN(e.noradId));
}

let _cache: TleCache = {
  entries:   seedEntries(),
  fetchedAt: 0, // age=0 triggers background refresh on first use
};

const TTL_S = 6 * 60 * 60;

// All constellation sources fetched in parallel on every refresh
const TLE_SOURCES: Array<{ label: string; urls: string[] }> = [
  {
    label: 'Starlink',
    urls: [
      'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=tle',
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle',
    ],
  },
  {
    label: 'OneWeb',
    urls: [
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=oneweb&FORMAT=tle',
    ],
  },
  {
    label: 'Stations (ISS)',
    urls: [
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle',
    ],
  },
  {
    label: 'GPS',
    urls: [
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=gps-ops&FORMAT=tle',
    ],
  },
];

function parseTleText(text: string): TleEntry[] {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const entries: TleEntry[] = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = lines[i], line1 = lines[i + 1], line2 = lines[i + 2];
    if (!line1?.startsWith('1 ') || !line2?.startsWith('2 ')) continue;
    const noradId = parseInt(line1.substring(2, 7).trim(), 10);
    if (isNaN(noradId)) continue;
    entries.push({ name, noradId, line1, line2 });
  }
  return entries;
}

async function fetchOneSource(label: string, urls: string[]): Promise<TleEntry[]> {
  for (const url of urls) {
    try {
      const { data } = await axios.get(url, {
        timeout: 30_000,
        headers: { 'User-Agent': 'StarTrack/1.0 (satellite tracker)', Accept: 'text/plain' },
        responseType: 'text',
      });
      const text = String(data);
      if (text.includes('1 ') && text.includes('2 ')) {
        const entries = parseTleText(text);
        console.log(`[tleCache] ${label}: fetched ${entries.length} TLEs from ${url}`);
        return entries;
      }
      console.warn(`[tleCache] ${label}: ${url} returned no TLE data`);
    } catch (err: any) {
      console.warn(`[tleCache] ${label}: ${url} failed: ${err.message}`);
    }
  }
  console.error(`[tleCache] ${label}: all sources failed`);
  return [];
}

// Callback so index.ts can clear visible-satellite cache when TLEs refresh
let _onRefresh: (() => void) | null = null;
export function setOnTleRefresh(cb: () => void) { _onRefresh = cb; }

let _refreshing = false;

function refreshInBackground() {
  if (_refreshing) return;
  _refreshing = true;

  Promise.all(TLE_SOURCES.map(src => fetchOneSource(src.label, src.urls)))
    .then(results => {
      // Merge all constellations, deduplicate by NORAD ID
      const merged: TleEntry[] = [];
      const seen = new Set<number>();
      for (const entries of results) {
        for (const entry of entries) {
          if (!seen.has(entry.noradId)) {
            seen.add(entry.noradId);
            merged.push(entry);
          }
        }
      }

      if (merged.length > 0) {
        _cache = { entries: merged, fetchedAt: Math.floor(Date.now() / 1000) };
        const sl  = merged.filter(e => e.name.toUpperCase().includes('STARLINK')).length;
        const ow  = merged.filter(e => e.name.toUpperCase().includes('ONEWEB')).length;
        const iss = merged.filter(e => e.name.toUpperCase().includes('ISS') || e.name.toUpperCase().includes('ZARYA')).length;
        const gps = merged.filter(e => e.name.toUpperCase().includes('GPS') || e.name.toUpperCase().includes('NAVSTAR')).length;
        console.log(`[tleCache] Refreshed: ${merged.length} total — Starlink: ${sl}, OneWeb: ${ow}, ISS/Stations: ${iss}, GPS: ${gps}`);
        // Clear visible-satellite cache so next request re-propagates all new TLEs
        _onRefresh?.();
      }
    })
    .catch(err => console.error('[tleCache] Background refresh failed:', err.message))
    .finally(() => { _refreshing = false; });
}

export async function getActiveSatellites(limit = 50): Promise<TleEntry[]> {
  const now = Math.floor(Date.now() / 1000);
  if (now - _cache.fetchedAt > TTL_S) refreshInBackground();
  return _cache.entries.slice(0, limit);
}

export function getTleStatus() {
  const now = Math.floor(Date.now() / 1000);
  const entries = _cache.entries;
  return {
    lastRefreshed:    _cache.fetchedAt > 0 ? new Date(_cache.fetchedAt * 1000).toISOString() : 'seed',
    satelliteCount:   entries.length,
    starlink:         entries.filter(e => e.name.toUpperCase().includes('STARLINK')).length,
    oneweb:           entries.filter(e => e.name.toUpperCase().includes('ONEWEB')).length,
    iss:              entries.filter(e => e.name.toUpperCase().includes('ISS') || e.name.toUpperCase().includes('ZARYA')).length,
    gps:              entries.filter(e => e.name.toUpperCase().includes('GPS') || e.name.toUpperCase().includes('NAVSTAR')).length,
    nextRefresh:      new Date((_cache.fetchedAt + TTL_S) * 1000).toISOString(),
    cacheAgeMinutes:  Math.round((now - _cache.fetchedAt) / 60),
  };
}

export function getAllSatellites(): TleEntry[] {
  return _cache.entries;
}

export function findTleByName(name: string): TleEntry | undefined {
  const upper = name.toUpperCase().trim();
  const exact = _cache.entries.find(e => e.name.toUpperCase().trim() === upper);
  if (exact) return exact;
  return _cache.entries.find(e => e.name.toUpperCase().trim().startsWith(upper));
}
