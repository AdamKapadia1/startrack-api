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
const N2YO_KEY = process.env.N2YO_API_KEY ?? 'GMVRQ4-MY5LN2-UZUBTB-5RSS';
const N2YO_BASE = 'https://api.n2yo.com/rest/v1/satellite';
const OBS = { lat: 51.7957, lon: -0.6572, alt: 148 };
const MIN_PASS_EL = 30;
const NTFY_TOPIC = 'startrack-tring-alerts';
const NTFY_URL = `https://ntfy.sh/${NTFY_TOPIC}`;
function utcToLocal(utc) {
    return new Date(utc * 1000).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/London',
    });
}
const notifiedPasses = new Set();
const STARLINK_SATS = [
    { satid: 44714, satname: 'STARLINK-1008' },
    { satid: 49181, satname: 'STARLINK-3059' },
    { satid: 52865, satname: 'STARLINK-4274' },
    { satid: 54205, satname: 'STARLINK-5249' },
    { satid: 56519, satname: 'STARLINK-6313' },
    { satid: 58041, satname: 'STARLINK-30542' },
    { satid: 59303, satname: 'STARLINK-31504' },
    { satid: 61515, satname: 'STARLINK-32136' },
    { satid: 63419, satname: 'STARLINK-33709' },
    { satid: 64495, satname: 'STARLINK-34364' },
    { satid: 65756, satname: 'STARLINK-35275' },
    { satid: 66863, satname: 'STARLINK-36134' },
    { satid: 67958, satname: 'STARLINK-36799' },
    { satid: 69187, satname: 'STARLINK-37209' },
];
// ── Pass cache (1-hour TTL) ──────────────────────────────────────────────────
let _passesCache = null;
const PASSES_TTL_S = 60 * 60;
async function fetchPassesForSat(satid, satname) {
    const url = `${N2YO_BASE}/radiopasses/${satid}/${OBS.lat}/${OBS.lon}/${OBS.alt}/1/${MIN_PASS_EL}/&apiKey=${N2YO_KEY}`;
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
async function getAllStarlinkPasses() {
    const now = Math.floor(Date.now() / 1000);
    if (_passesCache && (now - _passesCache.fetchedAt) < PASSES_TTL_S) {
        return _passesCache.data;
    }
    const results = await Promise.allSettled(STARLINK_SATS.map(({ satid, satname }) => fetchPassesForSat(satid, satname)));
    const allPasses = [];
    for (const r of results) {
        if (r.status === 'fulfilled')
            allPasses.push(...r.value);
    }
    const sorted = allPasses.sort((a, b) => b.maxEl - a.maxEl);
    _passesCache = { data: sorted, fetchedAt: now };
    return sorted;
}
// ── ntfy.sh push notification ────────────────────────────────────────────────
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
// ── Public: alert on imminent high-elevation Starlink passes ─────────────────
async function checkAndNotify() {
    const passes = await getAllStarlinkPasses();
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
// ── Public: AI recommendation over upcoming Starlink passes ─────────────────
async function getPassRecommendation() {
    const allPasses = await getAllStarlinkPasses();
    const now = Math.floor(Date.now() / 1000);
    const future = allPasses.filter(p => p.startUTC > now);
    const topPasses = future.slice(0, 10);
    if (!topPasses.length) {
        return {
            recommendation: 'No Starlink passes found in the next 24 hours over Tring. This may be a temporary gap — the constellation will return shortly.',
            satname: 'Starlink',
            topPasses: [],
        };
    }
    const passDescriptions = topPasses
        .slice(0, 5)
        .map((p, i) => {
        const start = utcToLocal(p.startUTC);
        const peak = utcToLocal(p.maxUTC);
        return `Pass ${i + 1}: ${p.satname}, starts ${start}, peaks ${peak} at ${p.maxEl}°, duration ${p.duration}s`;
    })
        .join('\n');
    const client = new sdk_1.default();
    const stream = client.messages.stream({
        model: 'claude-opus-4-8',
        max_tokens: 256,
        thinking: { type: 'adaptive' },
        messages: [
            {
                role: 'user',
                content: `You are a satellite connectivity assistant tracking Starlink satellites over Tring, Hertfordshire. Here are the next upcoming Starlink passes:\n\n${passDescriptions}\n\nWrite a single plain-English recommendation (2–3 sentences) identifying the best connectivity window and what it is ideal for. Name the specific satellite, time and elevation.`,
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
    return { recommendation, satname: topPasses[0].satname, topPasses };
}
// ── Exported constant for subscribe endpoint ─────────────────────────────────
exports.NTFY_SUBSCRIBE_URL = NTFY_URL;
