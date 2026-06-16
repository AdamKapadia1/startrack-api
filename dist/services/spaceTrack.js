"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchSpaceTrackTLE = fetchSpaceTrackTLE;
exports.validateAgainstSpaceTrack = validateAgainstSpaceTrack;
const axios_1 = __importDefault(require("axios"));
const SPACETRACK_BASE = 'https://www.space-track.org';
const MIN_REQUEST_GAP_MS = 2000;
let sessionCookie = null;
let lastRequestTime = 0;
async function authenticate() {
    const response = await axios_1.default.post(`${SPACETRACK_BASE}/ajaxauth/login`, new URLSearchParams({
        identity: process.env.SPACETRACK_USERNAME ?? '',
        password: process.env.SPACETRACK_PASSWORD ?? '',
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const rawCookie = response.headers['set-cookie']?.[0];
    if (!rawCookie)
        throw new Error('Space-Track authentication failed: no session cookie returned');
    // Strip cookie attributes (path, secure, etc.) — only the name=value pair is needed.
    return rawCookie.split(';')[0];
}
async function rateLimitedRequest(url) {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < MIN_REQUEST_GAP_MS) {
        await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_GAP_MS - elapsed));
    }
    lastRequestTime = Date.now();
    if (!sessionCookie) {
        sessionCookie = await authenticate();
    }
    try {
        const response = await axios_1.default.get(url, { headers: { Cookie: sessionCookie } });
        return response.data;
    }
    catch (err) {
        if (err.response?.status === 401) {
            sessionCookie = await authenticate();
            const retryResponse = await axios_1.default.get(url, { headers: { Cookie: sessionCookie } });
            return retryResponse.data;
        }
        throw err;
    }
}
async function fetchSpaceTrackTLE(noradId) {
    try {
        const url = `${SPACETRACK_BASE}/basicspacedata/query/class/gp/NORAD_CAT_ID/${noradId}/orderby/EPOCH%20desc/limit/1/format/json`;
        const data = await rateLimitedRequest(url);
        if (!data || data.length === 0)
            return null;
        const sat = data[0];
        return { line1: sat.TLE_LINE1, line2: sat.TLE_LINE2 };
    }
    catch (err) {
        console.error('[spacetrack] fetch failed:', err.message);
        return null;
    }
}
// TLE epoch (cols 19-32, e.g. "24001.50000000") → ms since epoch.
function epochToMs(line1) {
    const epochStr = line1.substring(18, 32).trim();
    const yr2 = parseInt(epochStr.substring(0, 2), 10);
    const dayOfYear = parseFloat(epochStr.substring(2));
    const fullYear = yr2 >= 57 ? 1900 + yr2 : 2000 + yr2;
    return Date.UTC(fullYear, 0, 1) + (dayOfYear - 1) * 86400000;
}
async function validateAgainstSpaceTrack(noradId, celestrakTle) {
    const spaceTrackTle = await fetchSpaceTrackTLE(noradId);
    if (!spaceTrackTle) {
        return { matches: false, epochDifferenceHours: -1, spaceTrackTle: null };
    }
    const celestrakEpochMs = epochToMs(celestrakTle.line1);
    const spaceTrackEpochMs = epochToMs(spaceTrackTle.line1);
    const epochDifferenceHours = Math.abs(celestrakEpochMs - spaceTrackEpochMs) / 3600000;
    return {
        matches: epochDifferenceHours < 0.01, // same epoch to within ~36s of rounding error
        epochDifferenceHours: parseFloat(epochDifferenceHours.toFixed(2)),
        spaceTrackTle,
    };
}
