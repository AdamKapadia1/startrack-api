"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NTFY_SUBSCRIBE_URL = void 0;
exports.checkAndNotify = checkAndNotify;
exports.getPassRecommendation = getPassRecommendation;
const axios_1 = __importDefault(require("axios"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const tleCache_js_1 = require("../utils/tleCache.js");
const N2YO_KEY = process.env.N2YO_API_KEY ?? 'GMVRQ4-MY5LN2-UZUBTB-5RSS';
const N2YO_BASE = 'https://api.n2yo.com/rest/v1/satellite';
const DEFAULT_OBS = { lat: 51.7957, lon: -0.6572, alt: 148 };
const MIN_PASS_EL = 30;
const NTFY_TOPIC = 'startrack-tring-alerts';
const NTFY_URL = `https://ntfy.sh/${NTFY_TOPIC}`;
function obsKey(obs) {
    return `${obs.lat.toFixed(4)},${obs.lon.toFixed(4)},${obs.alt}`;
}
// ── Helpers ───────────────────────────────────────────────────────────────────
function utcToLocal(utc) {
    return new Date(utc * 1000).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/London',
    });
}
function utcToDate(utc) {
    return new Date(utc * 1000).toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'Europe/London',
    });
}
function groupPassesByDay(passes) {
    const now = Math.floor(Date.now() / 1000);
    const londonNow = new Date(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' }));
    londonNow.setHours(0, 0, 0, 0);
    const todayStart = Math.floor(londonNow.getTime() / 1000);
    const tomorrowStart = todayStart + 86400;
    const dayAfterStart = todayStart + 172800;
    const weekEnd = todayStart + 7 * 86400;
    const future = passes.filter(p => p.startUTC > now);
    return {
        today: future.filter(p => p.startUTC >= todayStart && p.startUTC < tomorrowStart),
        tomorrow: future.filter(p => p.startUTC >= tomorrowStart && p.startUTC < dayAfterStart),
        thisWeek: future.filter(p => p.startUTC >= dayAfterStart && p.startUTC < weekEnd),
    };
}
// ── Pass cache (1-hour TTL, keyed by location) ────────────────────────────────
const _passesCacheMap = new Map();
const PASSES_TTL_S = 60 * 60;
async function fetchPassesForSat(satid, satname, obs) {
    const url = `${N2YO_BASE}/radiopasses/${satid}/${obs.lat}/${obs.lon}/${obs.alt}/7/${MIN_PASS_EL}/&apiKey=${N2YO_KEY}`;
    const { data } = await axios_1.default.get(url, { timeout: 30000 });
    return (data.passes ?? []).map(p => ({
        startUTC: p.startUTC,
        maxUTC: p.maxUTC,
        endUTC: p.endUTC,
        maxEl: p.maxEl,
        startAz: p.startAz,
        maxAz: p.maxAz,
        duration: (p.duration ?? (p.endUTC - p.startUTC)),
        satname,
    }));
}
async function getAllStarlinkPasses(obs = DEFAULT_OBS) {
    const key = obsKey(obs);
    const now = Math.floor(Date.now() / 1000);
    const cached = _passesCacheMap.get(key);
    if (cached && (now - cached.fetchedAt) < PASSES_TTL_S) {
        return cached.data;
    }
    const activeSats = await (0, tleCache_js_1.getActiveSatellites)(50);
    const results = await Promise.allSettled(activeSats.map(({ noradId, name }) => fetchPassesForSat(noradId, name, obs)));
    const allPasses = [];
    for (const r of results) {
        if (r.status === 'fulfilled')
            allPasses.push(...r.value);
    }
    const sorted = allPasses.sort((a, b) => b.maxEl - a.maxEl);
    _passesCacheMap.set(key, { data: sorted, fetchedAt: now });
    console.log(`[passAgent] Cached ${sorted.length} passes for ${key} (7-day window)`);
    return sorted;
}
// ── ntfy.sh push notification ─────────────────────────────────────────────────
const notifiedPasses = new Set();
async function sendNtfy(satname, maxEl, minutesAway) {
    await axios_1.default.post(NTFY_URL, `${satname} passes at ${Math.round(maxEl)}° in ${minutesAway} min — good connectivity window`, {
        headers: {
            'Title': 'StarTrack Alert',
            'Priority': 'high',
            'Tags': 'satellite',
            'Content-Type': 'text/plain',
        },
        timeout: 10000,
    });
}
// ── Public: alert on imminent high-elevation passes ───────────────────────────
async function checkAndNotify() {
    const passes = await getAllStarlinkPasses(DEFAULT_OBS);
    const now = Math.floor(Date.now() / 1000);
    const windowEnd = now + 10 * 60;
    const alerts = [];
    for (const pass of passes) {
        if (pass.maxEl >= 60 &&
            pass.startUTC > now &&
            pass.startUTC <= windowEnd &&
            !notifiedPasses.has(pass.startUTC)) {
            notifiedPasses.add(pass.startUTC);
            const minutesAway = Math.max(1, Math.round((pass.startUTC - now) / 60));
            try {
                await sendNtfy(pass.satname, pass.maxEl, minutesAway);
            }
            catch (err) {
                console.error('[ntfy] push failed:', err.message);
            }
            alerts.push({ satname: pass.satname, maxEl: pass.maxEl, minutesAway, startUTC: pass.startUTC });
        }
    }
    return { checked: passes.length, alerted: alerts.length, alerts };
}
// ── Public: AI recommendation over 7-day Starlink passes ─────────────────────
async function getPassRecommendation(obs = DEFAULT_OBS, locationName = 'Tring, Hertfordshire') {
    const allPasses = await getAllStarlinkPasses(obs);
    const now = Math.floor(Date.now() / 1000);
    const future = allPasses.filter(p => p.startUTC > now);
    const { today, tomorrow, thisWeek } = groupPassesByDay(future);
    const topPasses = future.slice(0, 10);
    const bestPass = future.length > 0
        ? future.reduce((best, p) => p.maxEl > best.maxEl ? p : best, future[0])
        : null;
    if (!topPasses.length) {
        return {
            recommendation: `No Starlink passes found in the next 7 days over ${locationName}. The constellation will return shortly.`,
            satname: 'Starlink',
            topPasses: [],
            today,
            tomorrow,
            thisWeek,
            bestPass: null,
        };
    }
    const passDescriptions = topPasses
        .slice(0, 5)
        .map((p, i) => {
        const start = utcToLocal(p.startUTC);
        const peak = utcToLocal(p.maxUTC);
        const date = utcToDate(p.startUTC);
        return `Pass ${i + 1}: ${p.satname}, ${date} at ${start}, peaks ${peak} at ${p.maxEl.toFixed(1)}°, duration ${p.duration}s`;
    })
        .join('\n');
    const bestDesc = bestPass
        ? `Best pass of the week: ${bestPass.satname} on ${utcToDate(bestPass.startUTC)} at ${utcToLocal(bestPass.startUTC)}, peaking at ${bestPass.maxEl.toFixed(1)}°`
        : '';
    const client = new sdk_1.default();
    const stream = client.messages.stream({
        model: 'claude-opus-4-8',
        max_tokens: 300,
        thinking: { type: 'adaptive' },
        messages: [
            {
                role: 'user',
                content: `You are a satellite connectivity assistant tracking Starlink satellites over ${locationName}. Here are the top upcoming passes over the next 7 days:\n\n${passDescriptions}\n\n${bestDesc}\n\nWrite a 2–3 sentence plain-English recommendation. Identify the single best connectivity window of the entire week — name the satellite, date, time, and peak elevation. Mention what it is ideal for (video calls, IoT sync, etc.).`,
            },
        ],
    });
    const response = await stream.finalMessage();
    let recommendation = '';
    for (const block of response.content) {
        if (block.type === 'text') {
            recommendation = block.text;
            break;
        }
    }
    return {
        recommendation,
        satname: topPasses[0].satname,
        topPasses,
        today,
        tomorrow,
        thisWeek,
        bestPass,
    };
}
exports.NTFY_SUBSCRIBE_URL = NTFY_URL;
