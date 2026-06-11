import dotenv from 'dotenv';
import http from 'http';
import express, { Request, Response } from 'express';
import cors from 'cors';
import axios from 'axios';
import { WebSocketServer, WebSocket } from 'ws';
import { createClient } from '@supabase/supabase-js';
import { getPassRecommendation, checkAndNotify, NTFY_SUBSCRIBE_URL } from './agents/passAgent.js';
import { getActiveSatellites, getTleStatus, findTleByName } from './utils/tleCache.js';
import { calculateDoppler } from './utils/doppler.js';
import { scoreSignal, ScoreBreakdown } from './utils/signalModel.js';

dotenv.config();

const DEFAULT_LAT   = 51.7957;
const DEFAULT_LON   = -0.6572;
const DEFAULT_ALT_M = 148;
const R_EARTH_KM    = 6371.0;

// ── Supabase ──────────────────────────────────────────────────────────────────
const _supabaseUrl = process.env.SUPABASE_URL ?? '';
const _supabaseKey = process.env.SUPABASE_ANON_KEY ?? '';
const supabase = _supabaseUrl && _supabaseKey
  ? createClient(_supabaseUrl, _supabaseKey)
  : null;

// ── parseObs ──────────────────────────────────────────────────────────────────
function parseObs(req: Request) {
  const qLat = parseFloat(req.query.lat as string);
  const qLon = parseFloat(req.query.lon as string);
  const qAlt = parseFloat(req.query.alt as string);
  const lat  = isNaN(qLat) ? DEFAULT_LAT   : qLat;
  const lon  = isNaN(qLon) ? DEFAULT_LON   : qLon;
  const altM = isNaN(qAlt) ? DEFAULT_ALT_M : qAlt;
  return { lat, lon, altM, altKm: altM / 1000 };
}

// ── Geometry ──────────────────────────────────────────────────────────────────
function toRad(deg: number) { return deg * Math.PI / 180; }
function toDeg(rad: number) { return rad * 180 / Math.PI; }

function lookAngles(
  obsLat: number, obsLon: number, obsAltKm: number,
  satLat: number, satLon: number, satAltKm: number,
) {
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
  const range  = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const sinLat = Math.sin(latO), cosLat = Math.cos(latO);
  const sinLon = Math.sin(lonO), cosLon = Math.cos(lonO);
  const south  = -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz;
  const east   = -sinLon * dx + cosLon * dy;
  const up     =  cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz;
  return {
    elevation: toDeg(Math.asin(up / range)),
    azimuth:   (toDeg(Math.atan2(east, -south)) + 360) % 360,
    range,
  };
}

// ── Caches ────────────────────────────────────────────────────────────────────
const _visibleCacheMap = new Map<string, { payload: object; fetchedAt: number }>();
const VISIBLE_TTL_S = 5 * 60;

const _weatherCacheMap = new Map<string, {
  payload: {
    temp: number; description: string; cloudCover: number;
    windSpeed: number; visibility: number; isGoodForSatellites: boolean;
  };
  fetchedAt: number;
}>();
const WEATHER_TTL_S = 10 * 60;

// ── Shared data functions (used by REST endpoints + WS broadcasts) ────────────

async function getVisibleSatellitesData(
  lat: number, lon: number, altM: number,
  locationName = 'Tring, Hertfordshire',
): Promise<object> {
  const altKm   = altM / 1000;
  const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)},${altM}`;
  const now      = Math.floor(Date.now() / 1000);

  const cached = _visibleCacheMap.get(cacheKey);
  if (cached && (now - cached.fetchedAt) < VISIBLE_TTL_S) return cached.payload;

  const N2YO_KEY = process.env.N2YO_API_KEY ?? 'GMVRQ4-MY5LN2-UZUBTB-5RSS';
  const aboveUrl = (cat: number) =>
    `https://api.n2yo.com/rest/v1/satellite/above/${lat}/${lon}/${altM}/10/${cat}/&apiKey=${N2YO_KEY}`;

  const [starlinkRes, onewebRes] = await Promise.allSettled([
    axios.get(aboveUrl(52), { timeout: 30_000 }),
    axios.get(aboveUrl(53), { timeout: 30_000 }),
  ]);

  const rawSats: any[] = [];
  for (const r of [starlinkRes, onewebRes]) {
    if (r.status === 'fulfilled') rawSats.push(...(r.value.data.above ?? []));
  }

  const weatherKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const weather    = _weatherCacheMap.get(weatherKey)?.payload ?? null;
  const cloudCover = weather?.cloudCover ?? 50;
  const windSpeed  = weather?.windSpeed  ?? 5;
  const visibility = weather?.visibility ?? 10_000;

  const seen = new Set<string>();
  const satellites = rawSats
    .filter(sat => { if (seen.has(sat.satname)) return false; seen.add(sat.satname); return true; })
    .map(sat => {
      const { elevation, azimuth, range } = lookAngles(
        lat, lon, altKm, sat.satlat, sat.satlng, sat.satalt,
      );
      const tle     = findTleByName(sat.satname);
      const doppler = tle ? calculateDoppler(lat, lon, altKm, tle.line1, tle.line2) : null;
      return {
        satname:         sat.satname,
        elevation:       Math.round(elevation * 10) / 10,
        azimuth:         Math.round(azimuth   * 10) / 10,
        range:           Math.round(range),
        dopplerShiftHz:  doppler?.dopplerShiftHz  ?? null,
        dopplerShiftKHz: doppler?.dopplerShiftKHz ?? null,
      };
    })
    .sort((a, b) => b.elevation - a.elevation);

  const bestSat      = satellites[0] ?? null;
  const signalResult = bestSat
    ? scoreSignal({ elevation: bestSat.elevation, cloudCover, windSpeed, visibility, range: bestSat.range })
    : { total: 0, breakdown: { elevation: 0, cloud: 0, visibility: 0, wind: 0, range: 0 } as ScoreBreakdown };

  const payload = {
    location: { name: locationName, lat, lon },
    count:          satellites.length,
    satellites,
    signalScore:    signalResult.total,
    scoreBreakdown: signalResult.breakdown,
  };

  _visibleCacheMap.set(cacheKey, { payload, fetchedAt: now });
  return payload;
}

async function getWeatherData(lat: number, lon: number) {
  const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const now      = Math.floor(Date.now() / 1000);

  const cached = _weatherCacheMap.get(cacheKey);
  if (cached && (now - cached.fetchedAt) < WEATHER_TTL_S) return cached.payload;

  const OWM_KEY = process.env.OPENWEATHER_API_KEY ?? '972df7e7ae348374ec129fe9d7f2e5bd';
  const { data } = await axios.get(
    `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${OWM_KEY}&units=metric`,
    { timeout: 15_000 },
  );

  const cloudCover = data.clouds?.all ?? 0;
  const payload = {
    temp:               Math.round(data.main?.temp ?? 0),
    description:        data.weather?.[0]?.description ?? '',
    cloudCover,
    windSpeed:          Math.round((data.wind?.speed ?? 0) * 10) / 10,
    visibility:         data.visibility ?? 10_000,
    isGoodForSatellites: cloudCover < 50,
  };
  _weatherCacheMap.set(cacheKey, { payload, fetchedAt: now });
  return payload;
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: true, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/tles/status', async (_req, res) => {
  try { await getActiveSatellites(50); res.json(getTleStatus()); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/satellites/visible', async (req: Request, res: Response) => {
  const { lat, lon, altM } = parseObs(req);
  const locationName = (req.query.name as string) ?? 'Tring, Hertfordshire';
  try {
    const payload = await getVisibleSatellitesData(lat, lon, altM, locationName);
    res.json(payload);

    // Fire-and-forget Supabase snapshot (REST calls only)
    const bestSat = (payload as any).satellites?.[0] ?? null;
    if (supabase && bestSat) {
      supabase.from('pass_predictions').insert({
        norad_id: 0, user_lat: lat, user_lon: lon,
        aos_time: new Date().toISOString(),
        max_elevation: bestSat.elevation,
        signal_score: (payload as any).signalScore ?? 0,
        computed_at: new Date().toISOString(),
      }).then(({ error }) => { if (error) console.error('[supabase]', error.message); });
    }
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/weather', async (req: Request, res: Response) => {
  const { lat, lon } = parseObs(req);
  try { res.json(await getWeatherData(lat, lon)); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/recommendation', async (req: Request, res: Response) => {
  const { lat, lon, altM } = parseObs(req);
  const locationName = (req.query.name as string) ?? 'Tring, Hertfordshire';
  try { res.json(await getPassRecommendation({ lat, lon, alt: altM }, locationName)); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/notifications/check', async (_req, res) => {
  try { res.json(await checkAndNotify()); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/notifications/subscribe', (_req, res) => {
  res.json({
    topic:        'startrack-tring-alerts',
    url:          NTFY_SUBSCRIBE_URL,
    webUrl:       `${NTFY_SUBSCRIBE_URL}/`,
    instructions: 'Install the ntfy app (ntfy.sh), tap Subscribe, enter topic: startrack-tring-alerts.',
  });
});

app.get('/api/history', async (_req, res) => {
  if (!supabase) { res.json([]); return; }
  try {
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from('pass_predictions')
      .select('computed_at, signal_score, max_elevation')
      .gte('computed_at', since)
      .order('computed_at', { ascending: true });
    if (error) throw new Error(error.message);
    res.json(data ?? []);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const clients = new Set<WebSocket>();

async function broadcastSatellites(target?: WebSocket) {
  const targets = target ? [target] : Array.from(clients);
  if (targets.length === 0) return;
  try {
    const data    = await getVisibleSatellitesData(DEFAULT_LAT, DEFAULT_LON, DEFAULT_ALT_M);
    const message = JSON.stringify({ type: 'satellites', data, timestamp: Date.now() });
    for (const client of targets) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  } catch (err: any) {
    console.error('[ws] satellite broadcast failed:', err.message);
  }
}

async function broadcastWeather() {
  if (clients.size === 0) return;
  try {
    const data    = await getWeatherData(DEFAULT_LAT, DEFAULT_LON);
    const message = JSON.stringify({ type: 'weather', data, timestamp: Date.now() });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  } catch (err: any) {
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

  getActiveSatellites(50).catch(err =>
    console.error('[startup] TLE pre-warm failed:', err.message),
  );

  // Notification check every 60 s
  setInterval(async () => {
    try {
      const { alerted } = await checkAndNotify();
      if (alerted > 0) console.log(`[notifications] sent ${alerted} ntfy alert(s)`);
    } catch (err: any) {
      console.error('[notifications] check failed:', err.message);
    }
  }, 60_000);

  // Broadcast satellites every 10 s
  setInterval(() => broadcastSatellites(), 10_000);

  // Broadcast weather every 60 s
  setInterval(broadcastWeather, 60_000);
});
