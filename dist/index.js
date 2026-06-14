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
const passPredictor_js_1 = require("./utils/passPredictor.js");
const doppler_js_1 = require("./utils/doppler.js");
const signalModel_js_1 = require("./utils/signalModel.js");
dotenv_1.default.config();
const DEFAULT_LAT = 51.7957;
const DEFAULT_LON = -0.6572;
const DEFAULT_ALT_M = 148;
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
// ── Caches ────────────────────────────────────────────────────────────────────
const _visibleCacheMap = new Map();
const VISIBLE_TTL_S = 5 * 60;
// Clear visible cache whenever the TLE cache refreshes (new constellations appear immediately)
(0, tleCache_js_1.setOnTleRefresh)(() => {
    _visibleCacheMap.clear();
    console.log('[tleCache] visible satellite cache cleared — new TLEs will propagate on next request');
});
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
    // Warm TLE cache then propagate all satellites locally — no N2YO rate limits
    await (0, tleCache_js_1.getActiveSatellites)(1);
    const tles = (0, tleCache_js_1.getAllSatellites)();
    const weatherKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    const weather = _weatherCacheMap.get(weatherKey)?.payload ?? null;
    const cloudCover = weather?.cloudCover ?? 50;
    const windSpeed = weather?.windSpeed ?? 5;
    const visibility = weather?.visibility ?? 10000;
    const visible = (0, passPredictor_js_1.getVisibleNow)(tles, lat, lon, altKm, 0);
    const satellites = visible.map(sat => {
        const tle = (0, tleCache_js_1.findTleByName)(sat.satname);
        const doppler = tle ? (0, doppler_js_1.calculateDoppler)(lat, lon, altKm, tle.line1, tle.line2) : null;
        return {
            satname: sat.satname,
            elevation: sat.elevation,
            azimuth: sat.azimuth,
            range: sat.range,
            dopplerShiftHz: doppler?.dopplerShiftHz ?? null,
            dopplerShiftKHz: doppler?.dopplerShiftKHz ?? null,
        };
    });
    const bestSat = satellites[0] ?? null;
    const signalResult = bestSat
        ? (0, signalModel_js_1.scoreSignal)({ elevation: bestSat.elevation, cloudCover, windSpeed, visibility, range: bestSat.range, count: satellites.length })
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
app.get('/health', (req, res) => {
    console.log('[health] headers:', JSON.stringify(req.headers));
    res.json({
        status: 'ok',
        hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
        wsClients: clients.size,
        version: 'v9-ws-diag',
    });
});
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
                user_lat: lat, user_lon: lon,
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
        // Fetch satellite data first so it can serve as fallback when N2YO is rate-limited
        const satData = await getVisibleSatellitesData(lat, lon, altM, locationName);
        res.json(await (0, passAgent_js_1.getPassRecommendation)({ lat, lon, alt: altM }, locationName, satData.satellites ?? []));
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
app.get('/api/notifications/settings', (_req, res) => {
    res.json((0, passAgent_js_1.getAlertConfig)());
});
app.post('/api/notifications/settings', (req, res) => {
    const { minElevation, alertMinutesBefore, enabled } = req.body;
    const updated = (0, passAgent_js_1.setAlertConfig)({
        ...(typeof minElevation === 'number' && { minElevation }),
        ...(typeof alertMinutesBefore === 'number' && { alertMinutesBefore }),
        ...(typeof enabled === 'boolean' && { enabled }),
    });
    res.json(updated);
});
app.get('/api/notifications/subscribe', (_req, res) => {
    res.json({
        topic: 'startrack-tring-alerts',
        url: passAgent_js_1.NTFY_SUBSCRIBE_URL,
        webUrl: `${passAgent_js_1.NTFY_SUBSCRIBE_URL}/`,
        instructions: 'Install the ntfy app (ntfy.sh), tap Subscribe, enter topic: startrack-tring-alerts.',
    });
});
app.get('/api/satellites/tle', async (req, res) => {
    const name = req.query.name?.trim();
    if (!name) {
        res.status(400).json({ error: 'name is required' });
        return;
    }
    await (0, tleCache_js_1.getActiveSatellites)(1);
    const tle = (0, tleCache_js_1.findTleByName)(name);
    if (!tle) {
        res.status(404).json({ error: `TLE not found for "${name}"` });
        return;
    }
    const { line1, line2 } = tle;
    // NORAD ID from line 1 cols 3-7 (0-indexed: 2-7)
    const noradId = parseInt(line1.substring(2, 7).trim(), 10);
    // Epoch from line 1 cols 19-32 (0-indexed: 18-32)
    const epochStr = line1.substring(18, 32).trim();
    const yr2 = parseInt(epochStr.substring(0, 2), 10);
    const dayOfYear = parseFloat(epochStr.substring(2));
    const fullYear = yr2 >= 57 ? 1900 + yr2 : 2000 + yr2;
    const epochMs = Date.UTC(fullYear, 0, 1) + (dayOfYear - 1) * 86400000;
    // Line 2 orbital elements
    const inclination = parseFloat(line2.substring(8, 16).trim());
    const raan = parseFloat(line2.substring(17, 25).trim());
    const eccentricity = parseFloat('0.' + line2.substring(26, 33).trim());
    const meanMotion = parseFloat(line2.substring(52, 63).trim()); // rev/day
    // Derived quantities
    const period = 1440 / meanMotion; // minutes
    const mu = 398600.4418; // km³/s²
    const semiMajorAxis = Math.cbrt(mu * Math.pow((period * 60) / (2 * Math.PI), 2));
    const meanAltitude = Math.round(semiMajorAxis - 6371);
    res.json({
        name: tle.name,
        tle_line1: line1,
        tle_line2: line2,
        noradId,
        epoch: new Date(epochMs).toISOString(),
        inclination: parseFloat(inclination.toFixed(4)),
        raan: parseFloat(raan.toFixed(4)),
        eccentricity: parseFloat(eccentricity.toFixed(7)),
        period: parseFloat(period.toFixed(2)),
        meanAltitude,
    });
});
app.get('/api/satellites/passes', async (req, res) => {
    const name = req.query.name?.trim();
    if (!name) {
        res.status(400).json({ error: 'name is required' });
        return;
    }
    const { lat, lon, altM } = parseObs(req);
    await (0, tleCache_js_1.getActiveSatellites)(1);
    const tle = (0, tleCache_js_1.findTleByName)(name);
    if (!tle) {
        res.status(404).json({ error: `TLE not found for "${name}"` });
        return;
    }
    const passes = (0, passPredictor_js_1.predictPasses)([tle], lat, lon, altM / 1000, 7, 60, 10);
    const result = passes
        .sort((a, b) => a.startUTC - b.startUTC)
        .slice(0, 10)
        .map(p => ({
        satname: p.satname,
        startUTC: p.startUTC,
        maxUTC: p.maxUTC,
        endUTC: p.endUTC,
        maxEl: p.maxEl,
        duration: p.duration,
        score: Math.round(40 + (p.maxEl / 90) * 60),
    }));
    res.json(result);
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
        // Fetch sat + weather in parallel first; sat data feeds the pass fallback
        const [satData, weatherData] = await Promise.all([
            cap(getVisibleSatellitesData(DEFAULT_LAT, DEFAULT_LON, DEFAULT_ALT_M), {}),
            cap(getWeatherData(DEFAULT_LAT, DEFAULT_LON), {}),
        ]);
        const passData = await cap((0, passAgent_js_1.getPassRecommendation)({ lat: DEFAULT_LAT, lon: DEFAULT_LON, alt: DEFAULT_ALT_M }, 'Tring, Hertfordshire', satData.satellites ?? []), { topPasses: [] });
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
        const now = new Date();
        const bstDateTime = now.toLocaleString('en-GB', {
            timeZone: 'Europe/London', dateStyle: 'full', timeStyle: 'short',
        });
        const bstDateOnly = now.toLocaleDateString('en-GB', {
            timeZone: 'Europe/London', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        });
        const systemPrompt = `You are StarTrack AI, a satellite connectivity assistant. You have access to real-time data for the observer at Tring, Hertfordshire (51.79°N, 0.66°W, 148m altitude).

Current date and time in UK (BST): ${bstDateTime}
Today's date: ${bstDateOnly}

Current data:
- Satellites overhead: ${sats.length} Starlink satellites
- Best elevation: ${sats[0]?.elevation ?? 0}°
- Signal score: ${satData.signalScore ?? 0}/100
- Weather: ${weatherData.description ?? 'unknown'}, ${weatherData.cloudCover ?? 0}% cloud cover, ${weatherData.temp ?? 0}°C
- Visible satellites:
${satList || '  (none)'}
- Upcoming passes (all times in BST/Europe/London):
${passList || '  (none scheduled)'}

Answer the user's question conversationally and precisely. Use the real data above. Be concise — 2–3 sentences maximum unless a detailed answer is needed. Always refer to dates relative to today (${bstDateOnly}). All pass times are in BST. Never mention a pass that is in the past. If asked about passes, always include exact BST times.`;
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
console.log('[ws] WebSocket server attached to HTTP server');
wss.on('error', (err) => {
    console.error('[ws] SERVER ERROR:', err.message);
});
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
async function broadcastPositions() {
    if (clients.size === 0)
        return;
    const tles = (0, tleCache_js_1.getAllSatellites)();
    if (tles.length === 0)
        return;
    try {
        const positions = (0, passPredictor_js_1.getPositionsNow)(tles, DEFAULT_LAT, DEFAULT_LON, DEFAULT_ALT_M / 1000);
        const message = JSON.stringify({ type: 'positions', satellites: positions, timestamp: Date.now() });
        for (const client of clients) {
            if (client.readyState === ws_1.WebSocket.OPEN)
                client.send(message);
        }
    }
    catch (err) {
        console.error('[ws] positions broadcast failed:', err.message);
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
wss.on('connection', (ws, req) => {
    clients.add(ws);
    console.log('[ws] NEW CONNECTION from', req.socket.remoteAddress);
    console.log('[ws] upgrade headers:', JSON.stringify({
        host: req.headers['host'],
        origin: req.headers['origin'],
        upgrade: req.headers['upgrade'],
        connection: req.headers['connection'],
    }));
    console.log('[ws] total clients now:', clients.size);
    ws.on('close', (code, reason) => {
        clients.delete(ws);
        console.log(`[ws] client disconnected — code: ${code}, reason: ${reason.toString() || '(none)'} — ${clients.size} remaining`);
    });
    ws.on('error', (err) => {
        console.error('[ws] client error:', err.message);
        clients.delete(ws);
    });
    // Send current data immediately on connect
    broadcastSatellites(ws);
});
// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3001;
server.listen(PORT, () => {
    console.log(`StarTrack API listening on port ${PORT} (HTTP + WebSocket)`);
    // Fetch all constellations (Starlink + OneWeb + ISS + GPS) on startup
    (0, tleCache_js_1.getActiveSatellites)(9999).catch(err => console.error('[startup] TLE pre-warm failed:', err.message));
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
    // Broadcast lightweight positions every 5 s (for smooth animation)
    setInterval(() => broadcastPositions(), 5000);
    // Broadcast full satellite data every 30 s
    setInterval(() => broadcastSatellites(), 30000);
    // Broadcast weather every 60 s
    setInterval(broadcastWeather, 60000);
    // Keep Railway awake — ping /health every 4 min so the dyno never sleeps
    const BACKEND_URL = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : 'https://web-production-98c0d.up.railway.app';
    setInterval(async () => {
        try {
            await axios_1.default.get(`${BACKEND_URL}/health`, { timeout: 5000 });
            console.log('[keep-alive] ping sent');
        }
        catch (err) {
            console.warn('[keep-alive] ping failed:', err.message);
        }
    }, 4 * 60 * 1000);
});
