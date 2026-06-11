import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import cors from 'cors';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import { getPassRecommendation, checkAndNotify, NTFY_SUBSCRIBE_URL } from './agents/passAgent.js';
import { getActiveSatellites, getTleStatus, findTleByName } from './utils/tleCache.js';
import { calculateDoppler } from './utils/doppler.js';
import { scoreSignal, ScoreBreakdown } from './utils/signalModel.js';

dotenv.config();

const DEFAULT_LAT    = 51.7957;
const DEFAULT_LON    = -0.6572;
const DEFAULT_ALT_M  = 148;
const R_EARTH_KM     = 6371.0;

// ── Supabase client (null-safe) ──────────────────────────────────────────────
const _supabaseUrl = process.env.SUPABASE_URL ?? '';
const _supabaseKey = process.env.SUPABASE_ANON_KEY ?? '';
const supabase = _supabaseUrl && _supabaseKey
  ? createClient(_supabaseUrl, _supabaseKey)
  : null;

// ── Parse observer location from query params ────────────────────────────────
function parseObs(req: Request) {
  const qLat = parseFloat(req.query.lat as string);
  const qLon = parseFloat(req.query.lon as string);
  const qAlt = parseFloat(req.query.alt as string);
  const lat   = isNaN(qLat) ? DEFAULT_LAT   : qLat;
  const lon   = isNaN(qLon) ? DEFAULT_LON   : qLon;
  const altM  = isNaN(qAlt) ? DEFAULT_ALT_M : qAlt;
  return { lat, lon, altM, altKm: altM / 1000 };
}

// ── Geometry helpers ─────────────────────────────────────────────────────────
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
  const range    = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const sinLat   = Math.sin(latO), cosLat = Math.cos(latO);
  const sinLon   = Math.sin(lonO), cosLon = Math.cos(lonO);
  const south    = -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz;
  const east     = -sinLon * dx + cosLon * dy;
  const up       =  cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz;
  const elevation = toDeg(Math.asin(up / range));
  const azimuth   = (toDeg(Math.atan2(east, -south)) + 360) % 360;
  return { elevation, azimuth, range };
}

// ── In-memory caches (keyed by location) ─────────────────────────────────────
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

// ── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: true, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// ── TLE status ───────────────────────────────────────────────────────────────
app.get('/api/tles/status', async (_req: Request, res: Response) => {
  try {
    await getActiveSatellites(50);
    res.json(getTleStatus());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Visible satellites ────────────────────────────────────────────────────────
app.get('/api/satellites/visible', async (req: Request, res: Response) => {
  const { lat, lon, altM, altKm } = parseObs(req);
  const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)},${altM}`;
  const now = Math.floor(Date.now() / 1000);

  const cached = _visibleCacheMap.get(cacheKey);
  if (cached && (now - cached.fetchedAt) < VISIBLE_TTL_S) {
    res.json(cached.payload);
    return;
  }

  const N2YO_KEY = process.env.N2YO_API_KEY ?? 'GMVRQ4-MY5LN2-UZUBTB-5RSS';
  const aboveUrl = (cat: number) =>
    `https://api.n2yo.com/rest/v1/satellite/above/${lat}/${lon}/${altM}/10/${cat}/&apiKey=${N2YO_KEY}`;

  try {
    const [starlinkRes, onewebRes] = await Promise.allSettled([
      axios.get(aboveUrl(52), { timeout: 30_000 }),
      axios.get(aboveUrl(53), { timeout: 30_000 }),
    ]);

    const rawSats: any[] = [];
    for (const r of [starlinkRes, onewebRes]) {
      if (r.status === 'fulfilled') rawSats.push(...(r.value.data.above ?? []));
    }

    // Use weather for current location if cached
    const weatherKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    const weather = _weatherCacheMap.get(weatherKey)?.payload ?? null;
    const cloudCover  = weather?.cloudCover  ?? 50;
    const windSpeed   = weather?.windSpeed   ?? 5;
    const visibility  = weather?.visibility  ?? 10_000;

    const seen = new Set<string>();
    const satellites = rawSats
      .filter(sat => { if (seen.has(sat.satname)) return false; seen.add(sat.satname); return true; })
      .map(sat => {
        const { elevation, azimuth, range } = lookAngles(
          lat, lon, altKm,
          sat.satlat, sat.satlng, sat.satalt,
        );

        const tle = findTleByName(sat.satname);
        const doppler = tle
          ? calculateDoppler(lat, lon, altKm, tle.line1, tle.line2)
          : null;

        return {
          satname:          sat.satname,
          elevation:        Math.round(elevation * 10) / 10,
          azimuth:          Math.round(azimuth   * 10) / 10,
          range:            Math.round(range),
          dopplerShiftHz:   doppler?.dopplerShiftHz  ?? null,
          dopplerShiftKHz:  doppler?.dopplerShiftKHz ?? null,
        };
      })
      .sort((a, b) => b.elevation - a.elevation);

    const bestSat = satellites[0] ?? null;
    const signalResult = bestSat
      ? scoreSignal({
          elevation:  bestSat.elevation,
          cloudCover,
          windSpeed,
          visibility,
          range:      bestSat.range,
        })
      : { total: 0, breakdown: { elevation: 0, cloud: 0, visibility: 0, wind: 0, range: 0 } as ScoreBreakdown };

    const locationName = (req.query.name as string) ?? 'Tring, Hertfordshire';

    const payload = {
      location: { name: locationName, lat, lon },
      count:       satellites.length,
      satellites,
      signalScore:    signalResult.total,
      scoreBreakdown: signalResult.breakdown,
    };

    _visibleCacheMap.set(cacheKey, { payload, fetchedAt: now });
    res.json(payload);

    if (supabase) {
      supabase.from('pass_predictions').insert({
        norad_id:      0,
        user_lat:      lat,
        user_lon:      lon,
        aos_time:      new Date().toISOString(),
        max_elevation: bestSat?.elevation ?? 0,
        signal_score:  signalResult.total,
        computed_at:   new Date().toISOString(),
      }).then(({ error }) => {
        if (error) console.error('[supabase] insert failed:', error.message);
      });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Weather ──────────────────────────────────────────────────────────────────
app.get('/api/weather', async (req: Request, res: Response) => {
  const { lat, lon } = parseObs(req);
  const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const now = Math.floor(Date.now() / 1000);

  const cached = _weatherCacheMap.get(cacheKey);
  if (cached && (now - cached.fetchedAt) < WEATHER_TTL_S) {
    res.json(cached.payload);
    return;
  }

  const OWM_KEY = process.env.OPENWEATHER_API_KEY ?? '972df7e7ae348374ec129fe9d7f2e5bd';
  try {
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
    res.json(payload);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── AI recommendation (7-day grouped) ────────────────────────────────────────
app.get('/api/recommendation', async (req: Request, res: Response) => {
  const { lat, lon, altM } = parseObs(req);
  const locationName = (req.query.name as string) ?? 'Tring, Hertfordshire';
  try {
    const result = await getPassRecommendation({ lat, lon, alt: altM }, locationName);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Notification check ───────────────────────────────────────────────────────
app.get('/api/notifications/check', async (_req: Request, res: Response) => {
  try {
    const result = await checkAndNotify();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── ntfy.sh subscribe info ───────────────────────────────────────────────────
app.get('/api/notifications/subscribe', (_req: Request, res: Response) => {
  res.json({
    topic:        'startrack-tring-alerts',
    url:          NTFY_SUBSCRIBE_URL,
    webUrl:       `${NTFY_SUBSCRIBE_URL}/`,
    instructions: 'Install the ntfy app (ntfy.sh), tap Subscribe, enter topic: startrack-tring-alerts.',
  });
});

// ── Historical pass data (last 48 h) ─────────────────────────────────────────
app.get('/api/history', async (_req: Request, res: Response) => {
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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Server start ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3001;

app.listen(PORT, () => {
  console.log(`StarTrack API listening on port ${PORT}`);

  getActiveSatellites(50).catch(err =>
    console.error('[startup] TLE pre-warm failed:', err.message)
  );

  setInterval(async () => {
    try {
      const { alerted } = await checkAndNotify();
      if (alerted > 0) console.log(`[notifications] sent ${alerted} ntfy alert(s)`);
    } catch (err: any) {
      console.error('[notifications] check failed:', err.message);
    }
  }, 60_000);
});
