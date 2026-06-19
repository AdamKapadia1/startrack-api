import axios from 'axios';
import fs from 'fs';
import path from 'path';

export interface TleEntry {
  name: string;
  noradId: number;
  line1: string;
  line2: string;
  constellation: string;
}

interface TleCache {
  entries: TleEntry[];
  fetchedAt: number;
}

// Seed data bundled at build time so the server works from cold start without network fetches.
type SeedEntry = { name: string; line1: string; line2: string };

function loadSeedFile(filename: string): SeedEntry[] {
  try {
    const seedPath = path.resolve(__dirname, '../../src/data/', filename);
    return JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  } catch {
    return [];
  }
}

const _seedByConstellation: Record<string, SeedEntry[]> = {
  starlink: loadSeedFile('starlink-seed.json'),
  oneweb:   loadSeedFile('oneweb-seed.json'),
  iss:      loadSeedFile('iss-seed.json'),
  gps:      loadSeedFile('gps-seed.json'),
  galileo:  loadSeedFile('galileo-seed.json'),
  glonass:  loadSeedFile('glonass-seed.json'),
};

function seedEntries(): TleEntry[] {
  const entries: TleEntry[] = [];
  for (const [constellation, seeds] of Object.entries(_seedByConstellation)) {
    for (const s of seeds) {
      const noradId = parseInt(s.line1.substring(2, 7).trim(), 10);
      if (isNaN(noradId)) continue;
      entries.push({ name: s.name, noradId, line1: s.line1, line2: s.line2, constellation });
    }
  }
  return entries;
}

let _cache: TleCache = {
  entries:   seedEntries(),
  fetchedAt: 0, // age=0 triggers background refresh on first use
};

const TTL_S = 6 * 60 * 60;

// All constellation sources fetched in parallel on every refresh
const TLE_SOURCES: Array<{ label: string; constellation: string; urls: string[] }> = [
  {
    label: 'Starlink',
    constellation: 'starlink',
    urls: [
      'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=tle',
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle',
    ],
  },
  {
    label: 'OneWeb',
    constellation: 'oneweb',
    urls: [
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=oneweb&FORMAT=tle',
    ],
  },
  {
    label: 'Stations (ISS)',
    constellation: 'iss',
    urls: [
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle',
    ],
  },
  {
    label: 'GPS',
    constellation: 'gps',
    urls: [
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=gps-ops&FORMAT=tle',
    ],
  },
  {
    label: 'Galileo',
    constellation: 'galileo',
    urls: [
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=galileo&FORMAT=tle',
    ],
  },
  {
    label: 'GLONASS',
    constellation: 'glonass',
    urls: [
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=glo-ops&FORMAT=tle',
    ],
  },
];

function parseTleText(text: string, constellation: string): TleEntry[] {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const entries: TleEntry[] = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = lines[i], line1 = lines[i + 1], line2 = lines[i + 2];
    if (!line1?.startsWith('1 ') || !line2?.startsWith('2 ')) continue;
    const noradId = parseInt(line1.substring(2, 7).trim(), 10);
    if (isNaN(noradId)) continue;
    entries.push({ name, noradId, line1, line2, constellation });
  }
  return entries;
}

async function fetchOneSource(label: string, constellation: string, urls: string[]): Promise<TleEntry[]> {
  for (const url of urls) {
    try {
      const { data } = await axios.get(url, {
        timeout: 30_000,
        headers: { 'User-Agent': 'StarTrack/1.0 (satellite tracker)', Accept: 'text/plain' },
        responseType: 'text',
      });
      const text = String(data);
      if (text.includes('1 ') && text.includes('2 ')) {
        const entries = parseTleText(text, constellation);
        console.log(`[tleCache] ${label}: fetched ${entries.length} TLEs from ${url}`);
        return entries;
      }
      console.warn(`[tleCache] ${label}: ${url} returned no TLE data`);
    } catch (err: any) {
      console.warn(`[tleCache] ${label}: ${url} failed: ${err.message}`);
    }
  }
  console.warn(`[tleCache] ${label}: all sources failed, falling back to seed data if available`);
  return [];
}

// Callback so index.ts can clear visible-satellite cache when TLEs refresh
let _onRefresh: (() => void) | null = null;
export function setOnTleRefresh(cb: () => void) { _onRefresh = cb; }

let _refreshing = false;

function seedFallbackFor(constellation: string): TleEntry[] {
  const seeds = _seedByConstellation[constellation] ?? [];
  return seeds.map(s => {
    const noradId = parseInt(s.line1.substring(2, 7).trim(), 10);
    return { name: s.name, noradId, line1: s.line1, line2: s.line2, constellation };
  }).filter(e => !isNaN(e.noradId));
}

function refreshInBackground() {
  if (_refreshing) return;
  _refreshing = true;

  // Sequential fetches with 1 s delay between requests — CelesTrak rate limits
  // parallel requests from server IPs. If a live fetch fails the seed fallback
  // keeps that constellation on the map.
  (async () => {
    const merged: TleEntry[] = [];
    const seen = new Set<number>();

    for (const src of TLE_SOURCES) {
      let entries = await fetchOneSource(src.label, src.constellation, src.urls);
      if (entries.length === 0) entries = seedFallbackFor(src.constellation);
      for (const entry of entries) {
        if (!seen.has(entry.noradId)) {
          seen.add(entry.noradId);
          merged.push(entry);
        }
      }
      // Polite 1 s gap so CelesTrak does not rate-limit subsequent requests
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }

    if (merged.length > 0) {
      // Never downgrade the cache — if the live fetch returns fewer satellites
      // than the current cache (e.g. CelesTrak returned an error page for some
      // sources), keep the existing data rather than replacing it with a subset.
      if (merged.length >= _cache.entries.length || _cache.fetchedAt === 0) {
        _cache = { entries: merged, fetchedAt: Math.floor(Date.now() / 1000) };
        const counts = TLE_SOURCES.map(src =>
          `${src.label}: ${merged.filter(e => e.constellation === src.constellation).length}`,
        ).join(', ');
        console.log(`[tleCache] Refreshed: ${merged.length} total. ${counts}`);
        _onRefresh?.();
      } else {
        console.warn(`[tleCache] Refresh returned ${merged.length} vs current ${_cache.entries.length}, keeping existing cache`);
      }
    }
  })()
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
    starlink:         entries.filter(e => e.constellation === 'starlink').length,
    oneweb:           entries.filter(e => e.constellation === 'oneweb').length,
    iss:              entries.filter(e => e.constellation === 'iss').length,
    gps:              entries.filter(e => e.constellation === 'gps').length,
    galileo:          entries.filter(e => e.constellation === 'galileo').length,
    glonass:          entries.filter(e => e.constellation === 'glonass').length,
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
