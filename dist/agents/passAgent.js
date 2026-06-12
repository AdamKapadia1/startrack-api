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
const passPredictor_js_1 = require("../utils/passPredictor.js");
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
// Returns Unix seconds for London midnight on today+daysOffset, correctly handling BST/GMT.
// Uses sv-SE locale (YYYY-MM-DD) to avoid V8's ambiguous MM/DD/YYYY parsing of en-GB strings.
function londonDayStartSecs(daysOffset = 0) {
    const d = new Date(Date.now() + daysOffset * 86400000);
    const ymd = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/London' }).format(d); // "2026-06-12"
    const [y, m, day] = ymd.split('-').map(Number);
    const utcMidnightMs = Date.UTC(y, m - 1, day);
    // Ask London what hour UTC-midnight appears as (0 = GMT, 1 = BST)
    const londonHourAtUtcMidnight = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23' })
        .format(new Date(utcMidnightMs)));
    // London midnight = UTC midnight minus that offset
    return Math.floor((utcMidnightMs - londonHourAtUtcMidnight * 3600000) / 1000);
}
function groupPassesByDay(passes) {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayStart = londonDayStartSecs(0);
    const tomorrowStart = londonDayStartSecs(1);
    const dayAfterStart = londonDayStartSecs(2);
    const weekEnd = londonDayStartSecs(7);
    const future = passes.filter(p => p.startUTC > nowSec);
    return {
        today: future.filter(p => p.startUTC >= todayStart && p.startUTC < tomorrowStart),
        tomorrow: future.filter(p => p.startUTC >= tomorrowStart && p.startUTC < dayAfterStart),
        thisWeek: future.filter(p => p.startUTC >= dayAfterStart && p.startUTC < weekEnd),
    };
}
// ── Pass cache (6-hour TTL, keyed by location, computed locally via SGP4) ────
const _passesCacheMap = new Map();
const PASSES_TTL_S = 6 * 60 * 60;
async function getAllStarlinkPasses(obs = DEFAULT_OBS) {
    const key = obsKey(obs);
    const now = Math.floor(Date.now() / 1000);
    const cached = _passesCacheMap.get(key);
    if (cached && (now - cached.fetchedAt) < PASSES_TTL_S)
        return cached.data;
    // Ensure TLE cache is warm, then sample evenly for orbital plane diversity
    await (0, tleCache_js_1.getActiveSatellites)(1);
    const allTles = (0, tleCache_js_1.getAllSatellites)();
    const stride = Math.max(1, Math.floor(allTles.length / 200));
    const tles = allTles.filter((_, i) => i % stride === 0);
    const altKm = obs.alt / 1000;
    console.log(`[passAgent] TLEs loaded: ${allTles.length}, sampled: ${tles.length} (stride ${stride})`);
    // 2-min step; cached 6 hours so first-request compute cost is acceptable
    const raw = (0, passPredictor_js_1.predictPasses)(tles, obs.lat, obs.lon, altKm, 7, 120, MIN_PASS_EL);
    // Convert PredictedPass → Pass (shapes are compatible; just assert type)
    const sorted = raw.sort((a, b) => b.maxEl - a.maxEl);
    // Only cache non-empty results; if 0 passes found, return without caching so next request retries
    if (sorted.length > 0) {
        _passesCacheMap.set(key, { data: sorted, fetchedAt: now });
    }
    console.log(`[passAgent] SGP4 computed ${sorted.length} passes for ${key} (7-day window, ${tles.length} sats)`);
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
async function getPassRecommendation(obs = DEFAULT_OBS, locationName = 'Tring, Hertfordshire', currentSatellites = []) {
    const allPasses = await getAllStarlinkPasses(obs);
    const now = Math.floor(Date.now() / 1000);
    const future = allPasses.filter(p => p.startUTC > now);
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
            const client = new sdk_1.default();
            const stream = client.messages.stream({
                model: 'claude-opus-4-8',
                max_tokens: 300,
                thinking: { type: 'adaptive' },
                messages: [{
                        role: 'user',
                        content: `You are a satellite connectivity assistant. Current date and time in UK (BST): ${bstFallbackNow}\n\nScheduled pass data is temporarily being computed. However, there are currently ${currentSatellites.length} Starlink satellites visible overhead from ${locationName}:\n\n${satList}\n\nWrite 2–3 sentences assessing current connectivity based on what is overhead right now. Focus on the highest-elevation satellite. Mention that scheduled pass data will be available shortly.`,
                    }],
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
                satname: currentSatellites[0].satname,
                topPasses: [],
                today,
                tomorrow,
                thisWeek,
                bestPass: null,
            };
        }
        return {
            recommendation: `No Starlink passes found in the next 7 days over ${locationName}. N2YO pass data may be temporarily rate-limited — check back in a few minutes.`,
            satname: 'Starlink',
            topPasses: [],
            today,
            tomorrow,
            thisWeek,
            bestPass: null,
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
        const peak = utcToLocal(p.maxUTC);
        const date = utcToDate(p.startUTC);
        return `Pass ${i + 1}: ${p.satname}, ${date} at ${start} BST, peaks ${peak} BST at ${p.maxEl.toFixed(1)}°, duration ${p.duration}s`;
    })
        .join('\n');
    const bestDesc = bestPass
        ? `Best pass of the week: ${bestPass.satname} on ${utcToDate(bestPass.startUTC)} at ${utcToLocal(bestPass.startUTC)} BST, peaking at ${bestPass.maxEl.toFixed(1)}°`
        : '';
    const client = new sdk_1.default();
    const stream = client.messages.stream({
        model: 'claude-opus-4-8',
        max_tokens: 300,
        thinking: { type: 'adaptive' },
        messages: [
            {
                role: 'user',
                content: `You are a satellite connectivity assistant tracking Starlink satellites over ${locationName}.\n\nCurrent date and time in UK (BST): ${bstNow}\n\nHere are the top upcoming passes over the next 7 days (all times in BST/Europe/London):\n\n${passDescriptions}\n\n${bestDesc}\n\nWrite a 2–3 sentence plain-English recommendation. Identify the single best connectivity window of the entire week — name the satellite, date, time in BST, and peak elevation. Mention what it is ideal for (video calls, IoT sync, etc.). Always refer to dates relative to today.`,
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
