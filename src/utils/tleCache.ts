import axios from 'axios';

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

let _cache: TleCache | null = null;
const TTL_S = 6 * 60 * 60;
const CELESTRAK_URL = 'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=tle';

export async function getActiveSatellites(limit = 50): Promise<TleEntry[]> {
  const now = Math.floor(Date.now() / 1000);
  if (_cache && (now - _cache.fetchedAt) < TTL_S) {
    return _cache.entries.slice(0, limit);
  }

  const { data } = await axios.get(CELESTRAK_URL, {
    timeout: 30000,
    headers: { 'User-Agent': 'StarTrack/1.0', Accept: 'text/plain' },
    responseType: 'text',
  });

  const lines = String(data)
    .split('\n')
    .map((l: string) => l.trim())
    .filter((l: string) => l.length > 0);

  const entries: TleEntry[] = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name  = lines[i];
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (!line1?.startsWith('1 ') || !line2?.startsWith('2 ')) continue;
    const noradId = parseInt(line1.substring(2, 7).trim(), 10);
    if (isNaN(noradId)) continue;
    entries.push({ name, noradId, line1, line2 });
  }

  _cache = { entries, fetchedAt: now };
  console.log(`[tleCache] Refreshed: ${entries.length} Starlink satellites`);
  return entries.slice(0, limit);
}

export function getTleStatus() {
  if (!_cache) {
    return { lastRefreshed: null, satelliteCount: 0, nextRefresh: null, sampleSatellites: [] };
  }
  const now = Math.floor(Date.now() / 1000);
  return {
    lastRefreshed:    new Date(_cache.fetchedAt * 1000).toISOString(),
    satelliteCount:   _cache.entries.length,
    nextRefresh:      new Date((_cache.fetchedAt + TTL_S) * 1000).toISOString(),
    sampleSatellites: _cache.entries.slice(0, 5).map(e => e.name),
    cacheAgeMinutes:  Math.round((now - _cache.fetchedAt) / 60),
  };
}

export function getAllSatellites(): TleEntry[] {
  return _cache?.entries ?? [];
}

export function findTleByName(name: string): TleEntry | undefined {
  if (!_cache) return undefined;
  const upper = name.toUpperCase().trim();
  // Exact match first
  const exact = _cache.entries.find(e => e.name.toUpperCase().trim() === upper);
  if (exact) return exact;
  // Prefix match — CelesTrak appends suffixes like "[DTC]" that N2YO omits
  return _cache.entries.find(e => e.name.toUpperCase().trim().startsWith(upper));
}
