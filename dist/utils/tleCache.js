"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getActiveSatellites = getActiveSatellites;
exports.getTleStatus = getTleStatus;
exports.getAllSatellites = getAllSatellites;
exports.findTleByName = findTleByName;
const axios_1 = __importDefault(require("axios"));
let _cache = null;
const TTL_S = 6 * 60 * 60;
// Primary: main Starlink group (~400 KB, fast). Fallback: supplemental (~900 KB).
const TLE_URLS = [
    'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle',
    'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=tle',
];
async function fetchTleText() {
    for (const url of TLE_URLS) {
        try {
            const { data } = await axios_1.default.get(url, {
                timeout: 60000,
                headers: { 'User-Agent': 'StarTrack/1.0 (satellite tracker)', Accept: 'text/plain' },
                responseType: 'text',
            });
            if (String(data).includes('1 '))
                return String(data);
        }
        catch (err) {
            console.warn(`[tleCache] ${url} failed: ${err.message} — trying next`);
        }
    }
    throw new Error('[tleCache] All TLE sources failed');
}
async function getActiveSatellites(limit = 50) {
    const now = Math.floor(Date.now() / 1000);
    if (_cache && (now - _cache.fetchedAt) < TTL_S) {
        return _cache.entries.slice(0, limit);
    }
    const data = await fetchTleText();
    const lines = String(data)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    const entries = [];
    for (let i = 0; i + 2 < lines.length; i += 3) {
        const name = lines[i];
        const line1 = lines[i + 1];
        const line2 = lines[i + 2];
        if (!line1?.startsWith('1 ') || !line2?.startsWith('2 '))
            continue;
        const noradId = parseInt(line1.substring(2, 7).trim(), 10);
        if (isNaN(noradId))
            continue;
        entries.push({ name, noradId, line1, line2 });
    }
    _cache = { entries, fetchedAt: now };
    console.log(`[tleCache] Refreshed: ${entries.length} Starlink satellites`);
    return entries.slice(0, limit);
}
function getTleStatus() {
    if (!_cache) {
        return { lastRefreshed: null, satelliteCount: 0, nextRefresh: null, sampleSatellites: [] };
    }
    const now = Math.floor(Date.now() / 1000);
    return {
        lastRefreshed: new Date(_cache.fetchedAt * 1000).toISOString(),
        satelliteCount: _cache.entries.length,
        nextRefresh: new Date((_cache.fetchedAt + TTL_S) * 1000).toISOString(),
        sampleSatellites: _cache.entries.slice(0, 5).map(e => e.name),
        cacheAgeMinutes: Math.round((now - _cache.fetchedAt) / 60),
    };
}
function getAllSatellites() {
    return _cache?.entries ?? [];
}
function findTleByName(name) {
    if (!_cache)
        return undefined;
    const upper = name.toUpperCase().trim();
    // Exact match first
    const exact = _cache.entries.find(e => e.name.toUpperCase().trim() === upper);
    if (exact)
        return exact;
    // Prefix match — CelesTrak appends suffixes like "[DTC]" that N2YO omits
    return _cache.entries.find(e => e.name.toUpperCase().trim().startsWith(upper));
}
