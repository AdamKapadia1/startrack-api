"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const axios_1 = __importDefault(require("axios"));
const supabase_js_1 = require("@supabase/supabase-js");
const passAgent_js_1 = require("./agents/passAgent.js");
dotenv_1.default.config();
const OBS_LAT = 51.7957;
const OBS_LON = -0.6572;
const OBS_ALT_KM = 0.148;
const R_EARTH_KM = 6371.0;
// ── Supabase client (null-safe — won't crash if env vars are missing) ────────
const _supabaseUrl = process.env.SUPABASE_URL ?? '';
const _supabaseKey = process.env.SUPABASE_ANON_KEY ?? '';
const supabase = _supabaseUrl && _supabaseKey
    ? (0, supabase_js_1.createClient)(_supabaseUrl, _supabaseKey)
    : null;
// ── Geometry helpers ─────────────────────────────────────────────────────────
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
    const elevation = toDeg(Math.asin(up / range));
    const azimuth = (toDeg(Math.atan2(east, -south)) + 360) % 360;
    return { elevation, azimuth, range };
}
function signalScore(satellites) {
    if (!satellites.length)
        return 0;
    const best = Math.max(...satellites.map(s => s.elevation));
    const avg = satellites.reduce((s, x) => s + x.elevation, 0) / satellites.length;
    return Math.min(100, Math.round(satellites.length * 6 + avg * 0.4 + (best > 60 ? 15 : best > 30 ? 8 : 0)));
}
// ── In-memory caches ─────────────────────────────────────────────────────────
let _visibleCache = null;
const VISIBLE_TTL_S = 5 * 60;
let _weatherCache = null;
const WEATHER_TTL_S = 10 * 60;
// ── Express app ──────────────────────────────────────────────────────────────
const app = (0, express_1.default)();
app.use((0, cors_1.default)({ origin: true, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express_1.default.json());
// ── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});
// ── Visible satellites (Starlink cat 52 + OneWeb cat 53) ─────────────────────
app.get('/api/satellites/visible', async (_req, res) => {
    const now = Math.floor(Date.now() / 1000);
    if (_visibleCache && (now - _visibleCache.fetchedAt) < VISIBLE_TTL_S) {
        res.json(_visibleCache.payload);
        return;
    }
    const N2YO_KEY = process.env.N2YO_API_KEY ?? 'GMVRQ4-MY5LN2-UZUBTB-5RSS';
    const aboveUrl = (cat) => `https://api.n2yo.com/rest/v1/satellite/above/${OBS_LAT}/${OBS_LON}/148/10/${cat}/&apiKey=${N2YO_KEY}`;
    try {
        const [starlinkRes, onewebRes] = await Promise.allSettled([
            axios_1.default.get(aboveUrl(52), { timeout: 30000 }),
            axios_1.default.get(aboveUrl(53), { timeout: 30000 }),
        ]);
        const rawSats = [];
        for (const r of [starlinkRes, onewebRes]) {
            if (r.status === 'fulfilled')
                rawSats.push(...(r.value.data.above ?? []));
        }
        const seen = new Set();
        const satellites = rawSats
            .filter(sat => { if (seen.has(sat.satname))
            return false; seen.add(sat.satname); return true; })
            .map(sat => {
            const { elevation, azimuth, range } = lookAngles(OBS_LAT, OBS_LON, OBS_ALT_KM, sat.satlat, sat.satlng, sat.satalt);
            return {
                satname: sat.satname,
                elevation: Math.round(elevation * 10) / 10,
                azimuth: Math.round(azimuth * 10) / 10,
                range: Math.round(range),
            };
        })
            .sort((a, b) => b.elevation - a.elevation);
        const payload = {
            location: { name: 'Tring, Hertfordshire', lat: OBS_LAT, lon: OBS_LON },
            count: satellites.length,
            satellites,
        };
        _visibleCache = { payload, fetchedAt: now };
        res.json(payload);
        // Fire-and-forget: log snapshot to Supabase for historical charting.
        if (supabase) {
            const maxEl = satellites.length ? Math.max(...satellites.map(s => s.elevation)) : 0;
            const score = signalScore(satellites);
            supabase.from('pass_predictions').insert({
                norad_id: 0,
                user_lat: OBS_LAT,
                user_lon: OBS_LON,
                aos_time: new Date().toISOString(),
                max_elevation: maxEl,
                signal_score: score,
                computed_at: new Date().toISOString(),
            }).then(({ error }) => {
                if (error)
                    console.error('[supabase] insert failed:', error.message);
            });
        }
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── Weather ──────────────────────────────────────────────────────────────────
app.get('/api/weather', async (_req, res) => {
    const now = Math.floor(Date.now() / 1000);
    if (_weatherCache && (now - _weatherCache.fetchedAt) < WEATHER_TTL_S) {
        res.json(_weatherCache.payload);
        return;
    }
    const OWM_KEY = process.env.OPENWEATHER_API_KEY ?? '972df7e7ae348374ec129fe9d7f2e5bd';
    try {
        const { data } = await axios_1.default.get(`https://api.openweathermap.org/data/2.5/weather?lat=${OBS_LAT}&lon=${OBS_LON}&appid=${OWM_KEY}&units=metric`, { timeout: 15000 });
        const cloudCover = data.clouds?.all ?? 0;
        const payload = {
            temp: Math.round(data.main?.temp ?? 0),
            description: data.weather?.[0]?.description ?? '',
            cloudCover,
            windSpeed: Math.round((data.wind?.speed ?? 0) * 10) / 10,
            visibility: data.visibility ?? 10000,
            isGoodForSatellites: cloudCover < 50,
        };
        _weatherCache = { payload, fetchedAt: now };
        res.json(payload);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── AI recommendation ────────────────────────────────────────────────────────
app.get('/api/recommendation', async (_req, res) => {
    try {
        const result = await (0, passAgent_js_1.getPassRecommendation)();
        res.json(result);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── Notification check ───────────────────────────────────────────────────────
app.get('/api/notifications/check', async (_req, res) => {
    try {
        const result = await (0, passAgent_js_1.checkAndNotify)();
        res.json(result);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── ntfy.sh subscribe info ───────────────────────────────────────────────────
app.get('/api/notifications/subscribe', (_req, res) => {
    res.json({
        topic: 'startrack-tring-alerts',
        url: passAgent_js_1.NTFY_SUBSCRIBE_URL,
        webUrl: `${passAgent_js_1.NTFY_SUBSCRIBE_URL}/`,
        instructions: 'Install the ntfy app (ntfy.sh), tap Subscribe, enter topic: startrack-tring-alerts. Or open the web URL in any browser.',
    });
});
// ── Historical pass data (last 48 h) ─────────────────────────────────────────
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
// ── Server start ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => {
    console.log(`StarTrack API listening on port ${PORT}`);
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
});
