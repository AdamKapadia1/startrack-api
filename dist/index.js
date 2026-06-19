"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
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
const satelliteJs = __importStar(require("satellite.js"));
const tleCache_js_1 = require("./utils/tleCache.js");
const passPredictor_js_1 = require("./utils/passPredictor.js");
const spaceTrack_js_1 = require("./services/spaceTrack.js");
const doppler_js_1 = require("./utils/doppler.js");
const signalModel_js_1 = require("./utils/signalModel.js");
const horizonProfile_js_1 = require("./utils/horizonProfile.js");
dotenv_1.default.config();
const RAILWAY_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://web-production-98c0d.up.railway.app';
// ── ISS TLE — dedicated fetch using NORAD ID 25544, refreshed every 6 h ───────
let issTleData = null;
async function fetchIssTle() {
    try {
        const res = await axios_1.default.get('https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=tle', { timeout: 10000 });
        const lines = res.data.trim().split('\n');
        if (lines.length >= 3) {
            issTleData = { name: lines[0].trim(), line1: lines[1].trim(), line2: lines[2].trim() };
            console.log('[iss] TLE fetched:', issTleData.name);
        }
    }
    catch (err) {
        console.error('[iss] TLE fetch failed:', err.message);
    }
}
fetchIssTle();
setInterval(fetchIssTle, 6 * 60 * 60 * 1000);
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
// ── parseHorizonProfile ─────────────────────────────────────────────────────
function parseHorizonProfile(req) {
    const custom = req.query.horizonCustom?.trim();
    if (custom) {
        const parsed = (0, horizonProfile_js_1.parseCustomHorizon)(custom);
        if (parsed)
            return parsed;
    }
    const preset = req.query.horizon?.trim().toLowerCase();
    return (preset && horizonProfile_js_1.HORIZON_PRESETS[preset]) || horizonProfile_js_1.FLAT_HORIZON;
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
// ── Footprint helpers ─────────────────────────────────────────────────────────
function beamHalfAngle(constellation) {
    switch ((constellation ?? '').toUpperCase()) {
        case 'STARLINK': return 25;
        case 'ONEWEB': return 30;
        case 'GPS':
        case 'GALILEO':
        case 'GLONASS': return 70;
        default: return 25;
    }
}
// Correct spherical geometry (law of sines) — gives ~256 km for Starlink at 550 km, 25°
function calculateFootprintRadius(altKm, constellation) {
    const R = 6371;
    const θ_b = beamHalfAngle(constellation) * (Math.PI / 180);
    const d = R + altKm;
    const sinEdge = (d / R) * Math.sin(θ_b);
    if (sinEdge >= 1)
        return R * Math.acos(R / d); // beam past horizon
    const edgeAngle = Math.PI - Math.asin(sinEdge); // obtuse (low-elevation edge)
    const groundAngle = Math.PI - θ_b - edgeAngle;
    return groundAngle > 0 ? Math.min(R * groundAngle, R * Math.acos(R / d)) : 0;
}
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
        const orbitalSpeedKmS = tle ? (0, doppler_js_1.calculateOrbitalSpeedFromTle)(tle.line1, tle.line2) : null;
        return {
            satname: sat.satname,
            elevation: sat.elevation,
            azimuth: sat.azimuth,
            range: sat.range,
            dopplerShiftHz: doppler?.dopplerShiftHz ?? null,
            dopplerShiftKHz: doppler?.dopplerShiftKHz ?? null,
            orbitalSpeedKmS: orbitalSpeedKmS !== null ? parseFloat(orbitalSpeedKmS.toFixed(2)) : null,
            constellation: tle?.constellation ?? null,
            ...(() => {
                if (!tle)
                    return { altKm: null, footprintRadiusKm: null };
                try {
                    const sr = satelliteJs.twoline2satrec(tle.line1, tle.line2);
                    const pv = satelliteJs.propagate(sr, new Date());
                    const pos = pv?.position;
                    if (!pos || pos === false)
                        return { altKm: null, footprintRadiusKm: null };
                    const alt = Math.sqrt(pos.x ** 2 + pos.y ** 2 + pos.z ** 2) - 6371;
                    return {
                        altKm: Math.round(alt),
                        footprintRadiusKm: Math.round(calculateFootprintRadius(alt, tle.constellation ?? null)),
                    };
                }
                catch {
                    return { altKm: null, footprintRadiusKm: null };
                }
            })(),
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
        version: 'v10-0.0.0.0',
    });
});
app.get('/api/debug/server-info', (_req, res) => {
    res.json({
        port: process.env.PORT ?? 3001,
        wsClients: clients.size,
        wssAttached: !!wss,
        nodeVersion: process.version,
        uptime: Math.round(process.uptime()),
        env: {
            hasPort: !!process.env.PORT,
            portValue: process.env.PORT ?? '(not set, using 3001)',
        },
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
    const { minElevation, alertMinutesBefore, enabled, favouriteSatellitesOnly, favouriteSatelliteNames } = req.body;
    const updated = (0, passAgent_js_1.setAlertConfig)({
        ...(typeof minElevation === 'number' && { minElevation }),
        ...(typeof alertMinutesBefore === 'number' && { alertMinutesBefore }),
        ...(typeof enabled === 'boolean' && { enabled }),
        ...(typeof favouriteSatellitesOnly === 'boolean' && { favouriteSatellitesOnly }),
        ...(Array.isArray(favouriteSatelliteNames) && { favouriteSatelliteNames }),
    });
    res.json(updated);
});
app.post('/api/notifications/favourites', (req, res) => {
    const { satelliteNames } = req.body;
    if (!Array.isArray(satelliteNames)) {
        res.status(400).json({ error: 'satelliteNames must be an array' });
        return;
    }
    const updated = (0, passAgent_js_1.setAlertConfig)({ favouriteSatelliteNames: satelliteNames });
    console.log(`[favourites] synced ${satelliteNames.length} favourite satellite names to alert config`);
    res.json({ saved: true, count: satelliteNames.length, config: updated });
});
app.get('/api/digest/send-now', async (_req, res) => {
    try {
        res.json(await (0, passAgent_js_1.sendDailyDigest)());
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/insights/heatmap', async (req, res) => {
    if (!supabase) {
        res.json({ days: [] });
        return;
    }
    try {
        const days = Math.min(365, Math.max(7, parseInt(String(req.query.days || '90'), 10)));
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        const { data, error } = await supabase
            .from('pass_predictions')
            .select('computed_at, signal_score')
            .gte('computed_at', startDate.toISOString())
            .order('computed_at', { ascending: true });
        if (error)
            throw new Error(error.message);
        if (!data || data.length === 0) {
            res.json({ days: [] });
            return;
        }
        const buckets = {};
        for (const row of data) {
            const score = Number(row.signal_score);
            if (!Number.isFinite(score))
                continue;
            const day = new Date(row.computed_at).toISOString().split('T')[0];
            (buckets[day] ?? (buckets[day] = [])).push(score);
        }
        const result = Object.entries(buckets).map(([date, scores]) => ({
            date,
            avgScore: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
            sampleCount: scores.length,
        }));
        res.set('Cache-Control', 'public, max-age=300');
        res.json({ days: result });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/insights/patterns', async (_req, res) => {
    try {
        const result = await (0, passAgent_js_1.analyzeHistoricalPatterns)();
        res.json(result);
    }
    catch (err) {
        console.error('[patterns] unhandled error:', err.message, err.stack);
        res.status(500).json({ error: err.message, available: false, dataPoints: 0 });
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
    const orbitalSpeedKmS = parseFloat((0, doppler_js_1.calculateOrbitalSpeedFromTle)(line1, line2).toFixed(2));
    console.log(`[orbital-speed] ${tle.name}: altitude=${meanAltitude}km, speed=${orbitalSpeedKmS}km/s`);
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
        orbitalSpeedKmS,
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
    const horizonProfile = parseHorizonProfile(req);
    const passes = (0, passPredictor_js_1.predictPasses)([tle], lat, lon, altM / 1000, 7, 60, 10, horizonProfile);
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
// ── Prediction validation against Heavens-Above ───────────────────────────────
// NORAD ID + TLE epoch for a TLE, using the same parsing as /api/satellites/tle
function tleMeta(line1) {
    const noradId = parseInt(line1.substring(2, 7).trim(), 10);
    const epochStr = line1.substring(18, 32).trim();
    const yr2 = parseInt(epochStr.substring(0, 2), 10);
    const dayOfYear = parseFloat(epochStr.substring(2));
    const fullYear = yr2 >= 57 ? 1900 + yr2 : 2000 + yr2;
    const epochMs = Date.UTC(fullYear, 0, 1) + (dayOfYear - 1) * 86400000;
    return { noradId, epochIso: new Date(epochMs).toISOString() };
}
const HIGH_VALUE_MIN_EL = 70;
// Circular azimuth difference (0-360° wraps, e.g. 359° vs 1° is 2° apart, not 358°).
function azimuthDelta(a, b) {
    const diff = Math.abs(a - b) % 360;
    return diff > 180 ? 360 - diff : diff;
}
// Predicts the next 24h of passes and logs the top 5 by max elevation for later
// manual comparison against Heavens-Above. Runs once daily via the digest scheduler.
async function logTopPassesForValidation() {
    if (!supabase) {
        console.log('[validation] Supabase not configured — skipping daily auto-log');
        return;
    }
    try {
        await (0, tleCache_js_1.getActiveSatellites)(1);
        const tles = (0, tleCache_js_1.getAllSatellites)();
        const passes = (0, passPredictor_js_1.predictPasses)(tles, DEFAULT_LAT, DEFAULT_LON, DEFAULT_ALT_M / 1000, 1, 60, 0);
        const top5 = passes.sort((a, b) => b.maxEl - a.maxEl).slice(0, 5);
        const rows = top5.map(p => {
            const tle = (0, tleCache_js_1.findTleByName)(p.satname);
            const meta = tle ? tleMeta(tle.line1) : null;
            return {
                satellite_name: p.satname,
                norad_id: meta?.noradId ?? null,
                predicted_start_time: new Date(p.startUTC * 1000).toISOString(),
                predicted_peak_time: new Date(p.maxUTC * 1000).toISOString(),
                predicted_end_time: new Date(p.endUTC * 1000).toISOString(),
                predicted_max_elevation: p.maxEl,
                predicted_max_azimuth: p.maxAz,
                tle_epoch: meta?.epochIso ?? null,
            };
        });
        if (rows.length > 0) {
            const { error } = await supabase.from('prediction_validation').insert(rows);
            if (error)
                throw new Error(error.message);
        }
        console.log(`[validation] auto-logged ${rows.length} top passes for Heavens-Above comparison`);
    }
    catch (err) {
        console.error('[validation] daily auto-log failed:', err.message);
    }
}
app.get('/api/validation/log-predictions', async (_req, res) => {
    if (!supabase) {
        res.status(503).json({ error: 'Supabase not configured' });
        return;
    }
    try {
        await (0, tleCache_js_1.getActiveSatellites)(1);
        const tles = (0, tleCache_js_1.getAllSatellites)();
        const passes = (0, passPredictor_js_1.predictPasses)(tles, DEFAULT_LAT, DEFAULT_LON, DEFAULT_ALT_M / 1000, 1, 60, HIGH_VALUE_MIN_EL);
        const rows = passes.map(p => {
            const tle = (0, tleCache_js_1.findTleByName)(p.satname);
            const meta = tle ? tleMeta(tle.line1) : null;
            return {
                satellite_name: p.satname,
                norad_id: meta?.noradId ?? null,
                predicted_start_time: new Date(p.startUTC * 1000).toISOString(),
                predicted_peak_time: new Date(p.maxUTC * 1000).toISOString(),
                predicted_end_time: new Date(p.endUTC * 1000).toISOString(),
                predicted_max_elevation: p.maxEl,
                predicted_max_azimuth: p.maxAz,
                tle_epoch: meta?.epochIso ?? null,
            };
        });
        if (rows.length > 0) {
            const { error } = await supabase.from('prediction_validation').insert(rows);
            if (error)
                throw new Error(error.message);
        }
        res.json({ logged: rows.length, passes: rows });
    }
    catch (err) {
        console.error('[validation] log-predictions failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/validation/checklist', async (_req, res) => {
    if (!supabase) {
        res.status(503).json({ error: 'Supabase not configured' });
        return;
    }
    try {
        const { data, error } = await supabase
            .from('prediction_validation')
            .select('*')
            .eq('validated', false)
            .order('predicted_peak_time', { ascending: true })
            .limit(10);
        if (error)
            throw new Error(error.message);
        const checklist = (data ?? []).map(row => ({
            id: row.id,
            satelliteName: row.satellite_name,
            noradId: row.norad_id,
            predictedPeakTime: row.predicted_peak_time,
            predictedMaxElevation: row.predicted_max_elevation,
            predictedMaxAzimuth: row.predicted_max_azimuth,
            heavensAboveUrl: `https://www.heavens-above.com/PassSummary.aspx?satid=${row.norad_id}&lat=${DEFAULT_LAT}&lng=${DEFAULT_LON}&loc=Tring&alt=${DEFAULT_ALT_M}&tz=GMT`,
        }));
        res.json({
            instructions: 'Open each heavensAboveUrl, find the matching pass, and POST the actual peak time, max elevation, and (optionally) max azimuth to /api/validation/record-actual with { id, actualPeakTime, actualMaxElevation, actualAzimuth? }.',
            checklist,
        });
    }
    catch (err) {
        console.error('[validation] checklist failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});
app.post('/api/validation/record-actual', async (req, res) => {
    if (!supabase) {
        res.status(503).json({ error: 'Supabase not configured' });
        return;
    }
    try {
        const { id, actualPeakTime, actualMaxElevation, actualAzimuth } = req.body;
        if (!id || !actualPeakTime || actualMaxElevation == null) {
            res.status(400).json({ error: 'id, actualPeakTime, and actualMaxElevation are required' });
            return;
        }
        const { data: existing, error: fetchError } = await supabase
            .from('prediction_validation')
            .select('predicted_peak_time, predicted_max_elevation, predicted_max_azimuth')
            .eq('id', id)
            .single();
        if (fetchError)
            throw new Error(fetchError.message);
        if (!existing) {
            res.status(404).json({ error: `No prediction with id ${id}` });
            return;
        }
        const timeDelta = Math.abs((new Date(actualPeakTime).getTime() - new Date(existing.predicted_peak_time).getTime()) / 1000);
        const elevationDelta = Math.abs(actualMaxElevation - existing.predicted_max_elevation);
        const azDelta = actualAzimuth != null && existing.predicted_max_azimuth != null
            ? azimuthDelta(actualAzimuth, existing.predicted_max_azimuth)
            : null;
        const { error: updateError } = await supabase
            .from('prediction_validation')
            .update({
            actual_peak_time: actualPeakTime,
            actual_max_elevation: actualMaxElevation,
            time_delta_seconds: timeDelta,
            elevation_delta_degrees: elevationDelta,
            ...(azDelta != null && { actual_azimuth: actualAzimuth, azimuth_delta_degrees: azDelta }),
            validated: true,
        })
            .eq('id', id);
        if (updateError)
            throw new Error(updateError.message);
        res.json({ timeDelta, elevationDelta, azimuthDelta: azDelta, accurate: timeDelta < 5 && elevationDelta < 1 });
    }
    catch (err) {
        console.error('[validation] record-actual failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/validation/results', async (_req, res) => {
    if (!supabase) {
        res.status(503).json({ error: 'Supabase not configured' });
        return;
    }
    try {
        const { data, error } = await supabase
            .from('prediction_validation')
            .select('time_delta_seconds, elevation_delta_degrees, azimuth_delta_degrees')
            .eq('validated', true);
        if (error)
            throw new Error(error.message);
        const rows = data ?? [];
        if (rows.length === 0) {
            res.json({ validatedCount: 0, summary: 'No validated predictions yet.' });
            return;
        }
        const avgTimeDelta = rows.reduce((a, r) => a + (r.time_delta_seconds ?? 0), 0) / rows.length;
        const avgElevationDelta = rows.reduce((a, r) => a + (r.elevation_delta_degrees ?? 0), 0) / rows.length;
        const accurateCount = rows.filter(r => (r.time_delta_seconds ?? Infinity) < 5 && (r.elevation_delta_degrees ?? Infinity) < 1).length;
        const accuracyRate = (accurateCount / rows.length) * 100;
        const azRows = rows.filter(r => r.azimuth_delta_degrees != null);
        const avgAzDelta = azRows.length > 0
            ? azRows.reduce((a, r) => a + r.azimuth_delta_degrees, 0) / azRows.length
            : null;
        res.json({
            validatedCount: rows.length,
            avgTimeDeltaSeconds: parseFloat(avgTimeDelta.toFixed(2)),
            avgElevationDeltaDegrees: parseFloat(avgElevationDelta.toFixed(2)),
            ...(avgAzDelta != null && { avgAzimuthDeltaDegrees: parseFloat(avgAzDelta.toFixed(2)) }),
            accuracyRate: parseFloat(accuracyRate.toFixed(1)),
            summary: `Based on ${rows.length} validated pass${rows.length === 1 ? '' : 'es'}, predictions are accurate to within 5s/1° on ${accuracyRate.toFixed(1)}% of passes (avg time delta ${avgTimeDelta.toFixed(1)}s, avg elevation delta ${avgElevationDelta.toFixed(2)}°${avgAzDelta != null ? `, avg azimuth delta ${avgAzDelta.toFixed(2)}°` : ''}).`,
        });
    }
    catch (err) {
        console.error('[validation] results failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});
// ── Space-Track.org validation (secondary TLE source) ─────────────────────────
function findTleByNoradId(noradId) {
    return (0, tleCache_js_1.getAllSatellites)().find(tle => tleMeta(tle.line1).noradId === noradId);
}
app.get('/api/validate/spacetrack/:noradId', async (req, res) => {
    try {
        const noradId = req.params.noradId;
        await (0, tleCache_js_1.getActiveSatellites)(1);
        const celestrakSat = findTleByNoradId(parseInt(noradId, 10));
        if (!celestrakSat) {
            res.status(404).json({ error: 'Satellite not found in CelesTrak cache' });
            return;
        }
        const validation = await (0, spaceTrack_js_1.validateAgainstSpaceTrack)(noradId, {
            line1: celestrakSat.line1,
            line2: celestrakSat.line2,
        });
        res.json(validation);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
async function runDailyValidation() {
    await (0, tleCache_js_1.getActiveSatellites)(1);
    const visible = (0, passPredictor_js_1.getVisibleNow)((0, tleCache_js_1.getAllSatellites)(), DEFAULT_LAT, DEFAULT_LON, DEFAULT_ALT_M / 1000, 0);
    const sample = visible
        .map(v => (0, tleCache_js_1.findTleByName)(v.satname))
        .filter((tle) => !!tle)
        .sort(() => Math.random() - 0.5)
        .slice(0, 10);
    let matchCount = 0;
    for (const tle of sample) {
        const { noradId } = tleMeta(tle.line1);
        try {
            const result = await (0, spaceTrack_js_1.validateAgainstSpaceTrack)(String(noradId), tle);
            if (result.matches)
                matchCount++;
        }
        catch (err) {
            console.error('[validation] space-track check failed for', tle.name, err.message);
        }
        await new Promise(resolve => setTimeout(resolve, 2500)); // respect Space-Track rate limit
    }
    console.log(`[validation] ${matchCount}/${sample.length} satellites matched Space-Track data`);
}
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
// ── /api/pass-card — server-generated OG image for satellite pass sharing ─────
const passCardGenerator_js_1 = require("./services/passCardGenerator.js");
app.get('/api/pass-card', (req, res) => {
    try {
        const { sat, date, time, el, quality, loc, score } = req.query;
        const buffer = (0, passCardGenerator_js_1.generatePassCard)({
            satelliteName: String(sat || 'Unknown'),
            date: String(date || ''),
            time: String(time || ''),
            maxElevation: parseFloat(String(el || '0')),
            quality: String(quality || 'Good'),
            locationLabel: String(loc || 'your location'),
            signalScore: score ? parseInt(String(score), 10) : undefined,
        });
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'public, max-age=3600');
        res.send(buffer);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── /api/share — database-backed shareable pass IDs ──────────────────────────
const SHARE_SITE = 'https://startrack-delta.vercel.app';
app.post('/api/share/create', async (req, res) => {
    if (!supabase) {
        res.status(503).json({ error: 'Supabase not configured' });
        return;
    }
    try {
        const { satelliteName, noradId, passTime, maxElevation, durationSeconds, quality, locationLabel, signalScore } = req.body;
        const { data, error } = await supabase
            .from('shared_passes')
            .insert({
            satellite_name: satelliteName,
            norad_id: noradId ?? null,
            pass_time: passTime,
            max_elevation: maxElevation,
            duration_seconds: durationSeconds ?? null,
            quality: quality ?? null,
            location_label: locationLabel ?? null,
            signal_score: signalScore ?? null,
        })
            .select()
            .single();
        if (error)
            throw error;
        res.json({ id: data.id, url: `${SHARE_SITE}/pass?id=${data.id}` });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/share/:id', async (req, res) => {
    if (!supabase) {
        res.status(503).json({ error: 'Supabase not configured' });
        return;
    }
    try {
        const { data, error } = await supabase
            .from('shared_passes')
            .select('*')
            .eq('id', req.params.id)
            .single();
        if (error || !data) {
            res.status(404).json({ error: 'Pass not found' });
            return;
        }
        await supabase
            .from('shared_passes')
            .update({ view_count: (data.view_count ?? 0) + 1 })
            .eq('id', req.params.id);
        res.json(data);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── 3D globe positions ────────────────────────────────────────────────────────
app.get('/api/satellites/positions3d', async (_req, res) => {
    try {
        const tles = (0, tleCache_js_1.getAllSatellites)();
        const now = new Date();
        const gmst = satelliteJs.gstime(now);
        const out = [];
        for (const tle of tles) {
            try {
                const satrec = satelliteJs.twoline2satrec(tle.line1, tle.line2);
                const pv = satelliteJs.propagate(satrec, now);
                const pos = pv?.position;
                if (!pos || pos === false)
                    continue;
                const geo = satelliteJs.eciToGeodetic(pos, gmst);
                const altKm = geo.height;
                out.push({
                    satname: tle.name,
                    lat: satelliteJs.degreesLat(geo.latitude),
                    lon: satelliteJs.degreesLong(geo.longitude),
                    altKm,
                    constellation: tle.constellation ?? null,
                    footprintRadiusKm: Math.round(calculateFootprintRadius(altKm, tle.constellation ?? null)),
                });
            }
            catch { /* skip invalid TLE */ }
        }
        res.set('Cache-Control', 'public, max-age=5');
        res.json(out);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── Ground track ──────────────────────────────────────────────────────────────
app.get('/api/satellites/groundtrack', async (req, res) => {
    try {
        const name = String(req.query.name ?? '');
        const tle = (0, tleCache_js_1.findTleByName)(name);
        if (!tle) {
            res.status(404).json({ error: 'Satellite not found' });
            return;
        }
        const satrec = satelliteJs.twoline2satrec(tle.line1, tle.line2);
        const points = [];
        const now = new Date();
        for (let i = 0; i <= 100; i++) {
            const t = new Date(now.getTime() + i * 60000);
            const pv = satelliteJs.propagate(satrec, t);
            const pos = pv?.position;
            if (pos && pos !== false) {
                const gmst = satelliteJs.gstime(t);
                const geo = satelliteJs.eciToGeodetic(pos, gmst);
                points.push({
                    lat: satelliteJs.degreesLat(geo.latitude),
                    lon: satelliteJs.degreesLong(geo.longitude),
                    altKm: geo.height,
                    time: t.toISOString(),
                });
            }
        }
        const currentAltKm = points[0]?.altKm ?? 550;
        const footprintRadiusKm = Math.round(calculateFootprintRadius(currentAltKm, tle.constellation ?? null));
        res.set('Cache-Control', 'public, max-age=60');
        res.json({ satelliteName: name, constellation: tle.constellation ?? null, footprintRadiusKm, points });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── ISS info ──────────────────────────────────────────────────────────────────
// User-specified exterior ISS asset IDs — tried first via NASA Image Library manifest
const ISS_EXTERIOR_ASSETS = [
    'iss040e013377',
    'iss040e013376',
    'iss040e013378',
    'iss025e013923',
    'iss024e005949',
];
// Verified 200-OK CDN URLs used as fallback when manifest assets fail
const ISS_VERIFIED_PHOTOS = [
    'https://images-assets.nasa.gov/image/iss074e0403089/iss074e0403089~large.jpg',
    'https://images-assets.nasa.gov/image/iss073e0982217/iss073e0982217~large.jpg',
    'https://images-assets.nasa.gov/image/iss072e576465/iss072e576465~medium.jpg',
    'https://images-assets.nasa.gov/image/iss072e575553/iss072e575553~medium.jpg',
    'https://images-assets.nasa.gov/image/iss064e030164/iss064e030164~large.jpg',
    'https://images-assets.nasa.gov/image/iss061e006843/iss061e006843~medium.jpg',
    'https://images-assets.nasa.gov/image/iss061e006834/iss061e006834~medium.jpg',
    'https://images-assets.nasa.gov/image/iss059e035608/iss059e035608~large.jpg',
    'https://images-assets.nasa.gov/image/iss058e007453/iss058e007453~large.jpg',
];
let lastServedAssetId = null;
// Proxy endpoint — tries asset manifest first, falls back to verified CDN list
app.get('/api/iss/photo', async (_req, res) => {
    // Attempt each user-specified asset ID via the NASA Image Library manifest
    for (const assetId of ISS_EXTERIOR_ASSETS) {
        try {
            const manifest = await axios_1.default.get(`https://images-api.nasa.gov/asset/${assetId}`, { timeout: 8000 });
            const items = manifest.data?.collection?.items ?? [];
            const imageHref = items.find(i => i.href?.endsWith('~large.jpg'))?.href
                ?? items.find(i => i.href?.endsWith('~medium.jpg'))?.href;
            if (imageHref) {
                const img = await axios_1.default.get(imageHref, { responseType: 'arraybuffer', timeout: 12000 });
                res.set('Content-Type', 'image/jpeg');
                res.set('Cache-Control', 'no-cache');
                res.set('X-Asset-Id', assetId);
                lastServedAssetId = assetId;
                console.log(`[iss/photo] served manifest asset ${assetId}`);
                res.send(img.data);
                return;
            }
        }
        catch (err) {
            console.warn(`[iss/photo] manifest ${assetId} failed: ${err.message}`);
        }
    }
    // Fallback: rotate through verified CDN URLs
    lastServedAssetId = null;
    const idx = Math.floor(Math.random() * ISS_VERIFIED_PHOTOS.length);
    for (let i = 0; i < ISS_VERIFIED_PHOTOS.length; i++) {
        const url = ISS_VERIFIED_PHOTOS[(idx + i) % ISS_VERIFIED_PHOTOS.length];
        try {
            const img = await axios_1.default.get(url, { responseType: 'arraybuffer', timeout: 10000 });
            res.set('Content-Type', String(img.headers['content-type'] ?? 'image/jpeg'));
            res.set('Cache-Control', 'no-cache');
            res.send(img.data);
            return;
        }
        catch { /* try next */ }
    }
    res.status(503).json({ error: 'photo unavailable' });
});
app.get('/api/iss/track', async (_req, res) => {
    if (!issTleData) {
        res.json({ past: [], future: [] });
        return;
    }
    try {
        const satrec = satelliteJs.twoline2satrec(issTleData.line1, issTleData.line2);
        const now = new Date();
        function getPos(t) {
            const pv = satelliteJs.propagate(satrec, t);
            if (!pv || !pv.position || typeof pv.position === 'boolean')
                return null;
            const gmst = satelliteJs.gstime(t);
            const geo = satelliteJs.eciToGeodetic(pv.position, gmst);
            return {
                lat: parseFloat(satelliteJs.degreesLat(geo.latitude).toFixed(2)),
                lon: parseFloat(satelliteJs.degreesLong(geo.longitude).toFixed(2)),
            };
        }
        const past = [];
        const future = [];
        for (let i = 5; i >= 1; i--) {
            const p = getPos(new Date(now.getTime() - i * 60000));
            if (p)
                past.push(p);
        }
        for (let i = 0; i <= 20; i++) {
            const p = getPos(new Date(now.getTime() + i * 60000));
            if (p)
                future.push(p);
        }
        res.set('Cache-Control', 'public, max-age=30');
        res.json({ past, future });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/iss/info', async (req, res) => {
    try {
        const { lat, lon, altM } = parseObs(req);
        console.log('[iss] using TLE:', issTleData?.name ?? '(not yet fetched)');
        // ── Crew from Open Notify ──────────────────────────────────────────────────
        let crew = [];
        try {
            const crewRes = await axios_1.default.get('http://api.open-notify.org/astros.json', { timeout: 6000 });
            crew = crewRes.data.people
                .filter(p => p.craft === 'ISS')
                .map(p => p.name);
        }
        catch { /* leave crew empty — not critical */ }
        // ── Photo — always served via Railway proxy (asset manifest or CDN fallback)
        const nasaImageUrl = `${RAILWAY_URL}/api/iss/photo`;
        const nasaImageTitle = lastServedAssetId ? `NASA/JSC — ${lastServedAssetId}` : 'ISS exterior — NASA';
        console.log('[iss] photo URL:', nasaImageUrl);
        // ── SGP4 position + speed (uses dedicated issTleData, NORAD 25544) ─────────
        let altitudeKm = null;
        let speedKmS = null;
        let currentLat = null;
        let currentLon = null;
        if (issTleData) {
            try {
                const satrec = satelliteJs.twoline2satrec(issTleData.line1, issTleData.line2);
                const now = new Date();
                const pv = satelliteJs.propagate(satrec, now);
                if (pv && pv.position && typeof pv.position !== 'boolean') {
                    const gmst = satelliteJs.gstime(now);
                    const geo = satelliteJs.eciToGeodetic(pv.position, gmst);
                    altitudeKm = Math.round(geo.height);
                    currentLat = Math.round(satelliteJs.degreesLat(geo.latitude) * 100) / 100;
                    currentLon = Math.round(satelliteJs.degreesLong(geo.longitude) * 100) / 100;
                }
                if (pv && pv.velocity && typeof pv.velocity !== 'boolean') {
                    const v = pv.velocity;
                    speedKmS = Math.round(Math.sqrt(v.x ** 2 + v.y ** 2 + v.z ** 2) * 10) / 10;
                }
            }
            catch (e) {
                console.error('[iss] SGP4 error:', e.message);
            }
        }
        // ── All passes in next 24 h (uses issTleData, min 5°) ─────────────────────
        let nextPasses = [];
        if (issTleData) {
            try {
                const nowSecs = Math.floor(Date.now() / 1000);
                const noradId = parseInt(issTleData.line1.substring(2, 7).trim(), 10);
                const tleLike = { name: issTleData.name, noradId, line1: issTleData.line1, line2: issTleData.line2, constellation: 'iss' };
                const passes = (0, passPredictor_js_1.predictPasses)([tleLike], lat, lon, altM / 1000, 1, 60, 5)
                    .sort((a, b) => a.startUTC - b.startUTC)
                    .filter(p => p.endUTC > nowSecs);
                nextPasses = passes.map(p => ({
                    startUTC: p.startUTC, maxUTC: p.maxUTC, endUTC: p.endUTC,
                    maxEl: Math.round(p.maxEl), duration: p.duration,
                }));
            }
            catch { /* skip passes */ }
        }
        res.set('Cache-Control', 'public, max-age=10');
        res.json({ crew, crewCount: crew.length, altitudeKm, speedKmS, currentLat, currentLon, nextPasses, nasaImageUrl, nasaImageTitle });
    }
    catch (err) {
        console.error('[iss] error:', err.message);
        res.status(500).json({ error: err.message });
    }
});
// ── Daily digest state ────────────────────────────────────────────────────────
let lastDigestDate = null;
let lastValidationDate = null;
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
server.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`StarTrack API listening on 0.0.0.0:${PORT} (HTTP + WebSocket)`);
    // Fetch all constellations (Starlink + OneWeb + ISS + GPS + Galileo + GLONASS) on startup
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
    // Daily digest at 6:00 AM UK time — check every minute
    setInterval(async () => {
        const ukTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/London' }));
        const hours = ukTime.getHours();
        const minutes = ukTime.getMinutes();
        if (hours === 6 && minutes === 0) {
            const today = ukTime.toDateString();
            if (lastDigestDate !== today) {
                lastDigestDate = today;
                try {
                    await (0, passAgent_js_1.sendDailyDigest)();
                    console.log('[digest] sent for', today);
                }
                catch (err) {
                    console.error('[digest] failed:', err.message);
                }
                await logTopPassesForValidation();
            }
        }
    }, 60000);
    // Daily Space-Track validation at 7:00 AM UK time — check every minute.
    // Only runs if SPACETRACK_USERNAME/PASSWORD are set; this is a credibility
    // check (logged sample match-rate), not a real-time data path.
    if (process.env.SPACETRACK_USERNAME && process.env.SPACETRACK_PASSWORD) {
        setInterval(async () => {
            const ukTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/London' }));
            const hours = ukTime.getHours();
            const minutes = ukTime.getMinutes();
            if (hours === 7 && minutes === 0) {
                const today = ukTime.toDateString();
                if (lastValidationDate !== today) {
                    lastValidationDate = today;
                    try {
                        await runDailyValidation();
                    }
                    catch (err) {
                        console.error('[validation] daily Space-Track run failed:', err.message);
                    }
                }
            }
        }, 60000);
    }
    else {
        console.log('[validation] SPACETRACK_USERNAME/PASSWORD not set — daily Space-Track validation disabled');
    }
    // Keep Railway awake — ping /health every 4 min so the dyno never sleeps
    setInterval(async () => {
        try {
            await axios_1.default.get(`${RAILWAY_URL}/health`, { timeout: 5000 });
            console.log('[keep-alive] ping sent');
        }
        catch (err) {
            console.warn('[keep-alive] ping failed:', err.message);
        }
    }, 4 * 60 * 1000);
});
