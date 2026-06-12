"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const http_1 = __importDefault(require("http"));
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const axios_1 = __importDefault(require("axios"));
const ws_1 = require("ws");
const supabase_js_1 = require("@supabase/supabase-js");
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const passAgent_js_1 = require("./agents/passAgent.js");
const tleCache_js_1 = require("./utils/tleCache.js");
const doppler_js_1 = require("./utils/doppler.js");
const signalModel_js_1 = require("./utils/signalModel.js");
dotenv_1.default.config();
const DEFAULT_LAT = 51.7957;
const DEFAULT_LON = -0.6572;
const DEFAULT_ALT_M = 148;
const R_EARTH_KM = 6371.0;
// ── Supabase ──────────────────────────────────────────────────────────────────
const _supabaseUrl = process.env.SUPABASE_URL ?? '';
const _supabaseKey = process.env.SUPABASE_ANON_KEY ?? '';
const supabase = _supabaseUrl && _supabaseKey
    ? (0, supabase_js_1.createClient)(_supabaseUrl, _supabaseKey)
    : null;
// ── parseObs ──────────────────────────────────────────────────────────────────
function parseObs(req) {
    const qLat = parseFloat(req.query.lat);
    const qLon = parseFloat(req.query.lon);
    const qAlt = parseFloat(req.query.alt);
    const lat = isNaN(qLat) ? DEFAULT_LAT : qLat;
    const lon = isNaN(qLon) ? DEFAULT_LON : qLon;
    const altM = isNaN(qAlt) ? DEFAULT_ALT_M : qAlt;
    return { lat, lon, altM, altKm: altM / 1000 };
}
// ── Geometry ──────────────────────────────────────────────────────────────────
function toRad(deg) { return deg * Math.PI / 180; }
function toDeg(rad) { return rad * 180 / Math.PI; }
function lookAngles(obsLat, obsLon, obsAltKm, satLat, satLon, satAltKm) {
    const latO = toRad(obsLat), lonO = toRad(obsLon);
    const latS = toRad(satLat), lonS = toRad(satLon);
    const rO = R_EARTH_KM + obsAltKm;
    const rS = R_EARTH_KM + satAltKm;
    const ox = rO * Math.cos(latO) * Math.cos(lonO);
    const oy = rO * Math.cos(latO) * Math.sin(lonO);
    const oz = rO * Math.sin(latO);
    const sx = rS * Math.cos(latS) * Math.cos(lonS);
    const sy = rS * Math.cos(latS) * Math.sin(lonS);
    const sz = rS * Math.sin(latS);
    const dx = sx - ox, dy = sy - oy, dz = sz - oz;
    const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const sinLat = Math.sin(latO), cosLat = Math.cos(latO);
    const sinLon = Math.sin(lonO), cosLon = Math.cos(lonO);
    const south = -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz;
    const east = -sinLon * dx + cosLon * dy;
    const up = cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz;
    return {
        elevation: toDeg(Math.asin(up / range)),
        azimuth: (toDeg(Math.atan2(east, -south)) + 360) % 360,
        range,
    };
}
// ── Caches ────────────────────────────────────────────────────────────────────
const _visibleCacheMap = new Map();
const VISIBLE_TTL_S = 5 * 60;
const _weatherCacheMap = new Map();
const WEATHER_TTL_S = 10 * 60;
// ── Shared data functions (used by REST endpoints + WS broadcasts) ────────────
async function getVisibleSatellitesData(lat, lon, altM, locationName = 'Tring, Hertfordshire') {
    const altKm = altM / 1000;
    const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)},${altM}`;
    const now = Math.floor(Date.now() / 1000);
    const cached = _visibleCacheMap.get(cacheKey);
    if (cached && (now - cached.fetchedAt) < VISIBLE_TTL_S)
        return cached.payload;
    const N2YO_KEY = process.env.N2YO_API_KEY ?? 'GMVRQ4-MY5LN2-UZUBTB-5RSS';
    const aboveUrl = (cat) => `https://api.n2yo.com/rest/v1/satellite/above/${lat}/${lon}/${altM}/10/${cat}/&apiKey=${N2YO_KEY}`;
    const [starlinkRes, onewebRes] = await Promise.allSettled([
        axios_1.default.get(aboveUrl(52), { timeout: 30000 }),
        axios_1.default.get(aboveUrl(53), { timeout: 30000 }),
    ]);
    const rawSats = [];
    for (const r of [starlinkRes, onewebRes]) {
        if (r.status === 'fulfilled')
            rawSats.push(...(r.value.data.above ?? []));
    }
    const weatherKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    const weather = _weatherCacheMap.get(weatherKey)?.payload ?? null;
    const cloudCover = weather?.cloudCover ?? 50;
    const windSpeed = weather?.windSpeed ?? 5;
    const visibility = weather?.visibility ?? 10000;
    const seen = new Set();
    const satellites = rawSats
        .filter(sat => { if (seen.has(sat.satname))
        return false; seen.add(sat.satname); return true; })
        .map(sat => {
        const { elevation, azimuth, range } = lookAngles(lat, lon, altKm, sat.satlat, sat.satlng, sat.satalt);
        const tle = (0, tleCache_js_1.findTleByName)(sat.satname);
        const doppler = tle ? (0, doppler_js_1.calculateDoppler)(lat, lon, altKm, tle.line1, tle.line2) : null;
        return {
            satname: sat.satname,
            elevation: Math.round(elevation * 10) / 10,
            azimuth: Math.round(azimuth * 10) / 10,
            range: Math.round(range),
            dopplerShiftHz: doppler?.dopplerShiftHz ?? null,
            dopplerShiftKHz: doppler?.dopplerShiftKHz ?? null,
        };
    })
        .sort((a, b) => b.elevation - a.elevation);
    const bestSat = satellites[0] ?? null;
    const signalResult = bestSat
        ? (0, signalModel_js_1.scoreSignal)({ elevation: bestSat.elevation, cloudCover, windSpeed, visibility, range: bestSat.range })
        : { total: 0, breakdown: { elevation: 0, cloud: 0, visibility: 0, wind: 0, range: 0 } };
    const payload = {
        location: { name: locationName, lat, lon },
        count: satellites.length,
        satellites,
        signalScore: signalResult.total,
        scoreBreakdown: signalResult.breakdown,
    };
    _visibleCacheMap.set(cacheKey, { payload, fetchedAt: now });
    return payload;
}
async function getWeatherData(lat, lon) {
    const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    const now = Math.floor(Date.now() / 1000);
    const cached = _weatherCacheMap.get(cacheKey);
    if (cached && (now - cached.fetchedAt) < WEATHER_TTL_S)
        return cached.payload;
    const OWM_KEY = process.env.OPENWEATHER_API_KEY ?? '972df7e7ae348374ec129fe9d7f2e5bd';
    const { data } = await axios_1.default.get(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${OWM_KEY}&units=metric`, { timeout: 15000 });
    const cloudCover = data.clouds?.all ?? 0;
    const payload = {
        temp: Math.round(data.main?.temp ?? 0),
        description: data.weather?.[0]?.description ?? '',
        cloudCover,
        windSpeed: Math.round((data.wind?.speed ?? 0) * 10) / 10,
        visibility: data.visibility ?? 10000,
        isGoodForSatellites: cloudCover < 50,
    };
    _weatherCacheMap.set(cacheKey, { payload, fetchedAt: now });
    return payload;
}
// ── Express app ───────────────────────────────────────────────────────────────
const app = (0, express_1.default)();
app.use((0, cors_1.default)({ origin: true, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express_1.default.json());
app.get('/health', (_req, res) => res.json({
    status: 'ok',
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    version: 'v8-heartbeat',
}));
app.get('/api/tles/status', async (_req, res) => {
    try {
        await (0, tleCache_js_1.getActiveSatellites)(50);
        res.json((0, tleCache_js_1.getTleStatus)());
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/satellites/visible', async (req, res) => {
    const { lat, lon, altM } = parseObs(req);
    const locationName = req.query.name ?? 'Tring, Hertfordshire';
    try {
        const payload = await getVisibleSatellitesData(lat, lon, altM, locationName);
        res.json(payload);
        // Fire-and-forget Supabase snapshot (REST calls only)
        const bestSat = payload.satellites?.[0] ?? null;
        if (supabase && bestSat) {
            supabase.from('pass_predictions').insert({
                norad_id: 0, user_lat: lat, user_lon: lon,
                aos_time: new Date().toISOString(),
                max_elevation: bestSat.elevation,
                signal_score: payload.signalScore ?? 0,
                computed_at: new Date().toISOString(),
            }).then(({ error }) => { if (error)
                console.error('[supabase]', error.message); });
        }
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/weather', async (req, res) => {
    const { lat, lon } = parseObs(req);
    try {
        res.json(await getWeatherData(lat, lon));
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/recommendation', async (req, res) => {
    const { lat, lon, altM } = parseObs(req);
    const locationName = req.query.name ?? 'Tring, Hertfordshire';
    try {
        res.json(await (0, passAgent_js_1.getPassRecommendation)({ lat, lon, alt: altM }, locationName));
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/notifications/check', async (_req, res) => {
    try {
        res.json(await (0, passAgent_js_1.checkAndNotify)());
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/notifications/subscribe', (_req, res) => {
    res.json({
        topic: 'startrack-tring-alerts',
        url: passAgent_js_1.NTFY_SUBSCRIBE_URL,
        webUrl: `${passAgent_js_1.NTFY_SUBSCRIBE_URL}/`,
        instructions: 'Install the ntfy app (ntfy.sh), tap Subscribe, enter topic: startrack-tring-alerts.',
    });
});
app.get('/api/history', async (_req, res) => {
    if (!supabase) {
        res.json([]);
        return;
    }
    try {
        const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
        const { data, error } = await supabase
            .from('pass_predictions')
            .select('computed_at, signal_score, max_elevation')
            .gte('computed_at', since)
            .order('computed_at', { ascending: true });
        if (error)
            throw new Error(error.message);
        res.json(data ?? []);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── Anthropic client ─────────────────────────────────────────────────────────
const anthropic = new sdk_1.default({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 20000, // fail fast so SSE error frame reaches the client
});
// ── /api/chat — SSE streaming chat endpoint ───────────────────────────────────
app.post('/api/chat', async (req, res) => {
    const { message, history = [] } = req.body;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    // Send an SSE comment immediately so Railway/proxies know the stream is live
    res.write(': connected\n\n');
    let closed = false;
    res.on('close', () => { closed = true; }); // fires when client disconnects
    // Heartbeat every 5 s keeps Railway's proxy from dropping the SSE connection
    const heartbeat = setInterval(() => {
        if (!closed)
            res.write(': ping\n\n');
    }, 5000);
    // Cap each context fetch at 8 s so streaming always starts promptly
    function cap(p, fallback, ms = 8000) {
        return Promise.race([p, new Promise(resolve => setTimeout(() => resolve(fallback), ms))]);
    }
    try {
        const [satData, weatherData, passData] = await Promise.all([
            cap(getVisibleSatellitesData(DEFAULT_LAT, DEFAULT_LON, DEFAULT_ALT_M), {}),
            cap(getWeatherData(DEFAULT_LAT, DEFAULT_LON), {}),
            cap((0, passAgent_js_1.getPassRecommendation)({ lat: DEFAULT_LAT, lon: DEFAULT_LON, alt: DEFAULT_ALT_M }, 'Tring, Hertfordshire'), { topPasses: [] }),
        ]);
        const sats = satData.satellites ?? [];
        const passes = passData.topPasses ?? [];
        const satList = sats.slice(0, 10).map((s) => {
            const d = s.dopplerShiftKHz != null
                ? `, doppler ${s.dopplerShiftKHz > 0 ? '+' : ''}${s.dopplerShiftKHz.toFixed(1)} kHz`
                : '';
            return `  ${s.satname}: el ${s.elevation}°, az ${s.azimuth}°${d}`;
        }).join('\n');
        const passList = passes.slice(0, 5).map((p, i) => {
            const peakDate = new Date(p.maxUTC * 1000);
            const dateStr = peakDate.toLocaleString('en-GB', {
                weekday: 'short', day: 'numeric', month: 'short',
                hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
            });
            return `  ${i + 1}. ${p.satname}: peak ${dateStr} BST, ${Math.round(p.maxEl)}° max elevation`;
        }).join('\n');
        const systemPrompt = `You are StarTrack AI, a satellite connectivity assistant. You have access to real-time data for the observer at Tring, Hertfordshire (51.79°N, 0.66°W, 148m altitude).

Current data as of ${new Date().toUTCString()}:
- Satellites overhead: ${sats.length} Starlink satellites
- Best elevation: ${sats[0]?.elevation ?? 0}°
- Signal score: ${satData.signalScore ?? 0}/100
- Weather: ${weatherData.description ?? 'unknown'}, ${weatherData.cloudCover ?? 0}% cloud cover, ${weatherData.temp ?? 0}°C
- Visible satellites:
${satList || '  (none)'}
- Upcoming passes (next 7 days):
${passList || '  (none scheduled)'}

Answer the user's question conversationally and precisely. Use the real data above. Be concise — 2–3 sentences maximum unless a detailed answer is needed. If asked about passes, always include exact times. If asked about signal quality, reference the weather and elevation data.`;
        if (closed) {
            res.end();
            return;
        }
        // Use raw streaming API for reliable event iteration
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            system: systemPrompt,
            messages: [
                ...history,
                { role: 'user', content: message },
            ],
            stream: true,
        });
        for await (const event of response) {
            if (closed)
                break;
            if (event.type === 'content_block_delta' &&
                event.delta.type === 'text_delta' &&
                event.delta.text) {
                res.write(`data: ${JSON.stringify({ chunk: event.delta.text })}\n\n`);
            }
        }
        clearInterval(heartbeat);
        if (!closed) {
            res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        }
        res.end();
    }
    catch (err) {
        clearInterval(heartbeat);
        console.error('[chat]', err.message);
        if (!closed) {
            res.write(`data: ${JSON.stringify({ error: true, message: err.message })}\n\n`);
            res.end();
        }
    }
});
// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ server });
const clients = new Set();
async function broadcastSatellites(target) {
    const targets = target ? [target] : Array.from(clients);
    if (targets.length === 0)
        return;
    try {
        const data = await getVisibleSatellitesData(DEFAULT_LAT, DEFAULT_LON, DEFAULT_ALT_M);
        const message = JSON.stringify({ type: 'satellites', data, timestamp: Date.now() });
        for (const client of targets) {
            if (client.readyState === ws_1.WebSocket.OPEN)
                client.send(message);
        }
    }
    catch (err) {
        console.error('[ws] satellite broadcast failed:', err.message);
    }
}
async function broadcastWeather() {
    if (clients.size === 0)
        return;
    try {
        const data = await getWeatherData(DEFAULT_LAT, DEFAULT_LON);
        const message = JSON.stringify({ type: 'weather', data, timestamp: Date.now() });
        for (const client of clients) {
            if (client.readyState === ws_1.WebSocket.OPEN)
                client.send(message);
        }
    }
    catch (err) {
        console.error('[ws] weather broadcast failed:', err.message);
    }
}
wss.on('connection', ws => {
    clients.add(ws);
    console.log(`[ws] client connected — ${clients.size} total`);
    ws.on('close', () => { clients.delete(ws); console.log(`[ws] client disconnected — ${clients.size} total`); });
    ws.on('error', () => clients.delete(ws));
    // Send current data immediately on connect
    broadcastSatellites(ws);
});
// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3001;
server.listen(PORT, () => {
    console.log(`StarTrack API listening on port ${PORT} (HTTP + WebSocket)`);
    (0, tleCache_js_1.getActiveSatellites)(50).catch(err => console.error('[startup] TLE pre-warm failed:', err.message));
    // Notification check every 60 s
    setInterval(async () => {
        try {
            const { alerted } = await (0, passAgent_js_1.checkAndNotify)();
            if (alerted > 0)
                console.log(`[notifications] sent ${alerted} ntfy alert(s)`);
        }
        catch (err) {
            console.error('[notifications] check failed:', err.message);
        }
    }, 60000);
    // Broadcast satellites every 10 s
    setInterval(() => broadcastSatellites(), 10000);
    // Broadcast weather every 60 s
    setInterval(broadcastWeather, 60000);
});
