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
  fetchedAt: 0, // age=0 triggers background refresh on first use, but seed is available immediately
};

const TTL_S = 6 * 60 * 60;

// Supplemental first — no "GP data not updated" delta-download issue.
// Main group second as fallback.
const TLE_URLS = [
  'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=tle',
  'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle',
];

async function fetchTleText(): Promise<string> {
  for (const url of TLE_URLS) {
    try {
      const { data } = await axios.get(url, {
        timeout: 60_000,
        headers: { 'User-Agent': 'StarTrack/1.0 (satellite tracker)', Accept: 'text/plain' },
        responseType: 'text',
      });
      const text = String(data);
      if (text.includes('1 ') && text.includes('2 ')) return text;
      console.warn(`[tleCache] ${url} returned no TLE data (delta-download response?)`);
    } catch (err: any) {
      console.warn(`[tleCache] ${url} failed: ${err.message} — trying next`);
    }
  }
  throw new Error('[tleCache] All TLE sources failed');
}

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

// Refresh in background without blocking callers
let _refreshing = false;
function refreshInBackground() {
  if (_refreshing) return;
  _refreshing = true;
  fetchTleText()
    .then(text => {
      const entries = parseTleText(text);
      if (entries.length > 0) {
        _cache = { entries, fetchedAt: Math.floor(Date.now() / 1000) };
        console.log(`[tleCache] Refreshed: ${entries.length} Starlink satellites`);
      }
    })
    .catch(err => console.error('[tleCache] Background refresh failed:', err.message))
    .finally(() => { _refreshing = false; });
}

export async function getActiveSatellites(limit = 50): Promise<TleEntry[]> {
  const now = Math.floor(Date.now() / 1000);
  // If cache is stale, trigger background refresh (don't block)
  if (now - _cache.fetchedAt > TTL_S) refreshInBackground();
  return _cache.entries.slice(0, limit);
}

export function getTleStatus() {
  const now = Math.floor(Date.now() / 1000);
  return {
    lastRefreshed:    _cache.fetchedAt > 0 ? new Date(_cache.fetchedAt * 1000).toISOString() : 'seed',
    satelliteCount:   _cache.entries.length,
    nextRefresh:      new Date((_cache.fetchedAt + TTL_S) * 1000).toISOString(),
    sampleSatellites: _cache.entries.slice(0, 5).map(e => e.name),
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
