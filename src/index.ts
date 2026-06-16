import dotenv from 'dotenv';
import http from 'http';
import express, { Request, Response } from 'express';
import cors from 'cors';
import axios from 'axios';
import { WebSocketServer, WebSocket } from 'ws';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { getPassRecommendation, checkAndNotify, getAlertConfig, setAlertConfig, NTFY_SUBSCRIBE_URL, sendDailyDigest, analyzeHistoricalPatterns } from './agents/passAgent.js';
import { getActiveSatellites, getAllSatellites, getTleStatus, findTleByName, setOnTleRefresh } from './utils/tleCache.js';
import { getVisibleNow, getPositionsNow, predictPasses } from './utils/passPredictor.js';
import { calculateDoppler, calculateOrbitalSpeedFromTle } from './utils/doppler.js';
import { scoreSignal, ScoreBreakdown } from './utils/signalModel.js';

dotenv.config();

const DEFAULT_LAT   = 51.7957;
const DEFAULT_LON   = -0.6572;
const DEFAULT_ALT_M = 148;

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


// ── Caches ────────────────────────────────────────────────────────────────────
const _visibleCacheMap = new Map<string, { payload: object; fetchedAt: number }>();
const VISIBLE_TTL_S = 5 * 60;

// Clear visible cache whenever the TLE cache refreshes (new constellations appear immediately)
setOnTleRefresh(() => {
  _visibleCacheMap.clear();
  console.log('[tleCache] visible satellite cache cleared — new TLEs will propagate on next request');
});

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

  // Warm TLE cache then propagate all satellites locally — no N2YO rate limits
  await getActiveSatellites(1);
  const tles = getAllSatellites();

  const weatherKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const weather    = _weatherCacheMap.get(weatherKey)?.payload ?? null;
  const cloudCover = weather?.cloudCover ?? 50;
  const windSpeed  = weather?.windSpeed  ?? 5;
  const visibility = weather?.visibility ?? 10_000;

  const visible = getVisibleNow(tles, lat, lon, altKm, 0);

  const satellites = visible.map(sat => {
    const tle           = findTleByName(sat.satname);
    const doppler       = tle ? calculateDoppler(lat, lon, altKm, tle.line1, tle.line2) : null;
    const orbitalSpeedKmS = tle ? calculateOrbitalSpeedFromTle(tle.line1, tle.line2) : null;
    return {
      satname:         sat.satname,
      elevation:       sat.elevation,
      azimuth:         sat.azimuth,
      range:           sat.range,
      dopplerShiftHz:  doppler?.dopplerShiftHz  ?? null,
      dopplerShiftKHz: doppler?.dopplerShiftKHz ?? null,
      orbitalSpeedKmS: orbitalSpeedKmS !== null ? parseFloat(orbitalSpeedKmS.toFixed(2)) : null,
      constellation:   tle?.constellation ?? null,
    };
  });

  const bestSat      = satellites[0] ?? null;
  const signalResult = bestSat
    ? scoreSignal({ elevation: bestSat.elevation, cloudCover, windSpeed, visibility, range: bestSat.range, count: satellites.length })
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
    port:       process.env.PORT ?? 3001,
    wsClients:  clients.size,
    wssAttached: !!wss,
    nodeVersion: process.version,
    uptime:     Math.round(process.uptime()),
    env: {
      hasPort:   !!process.env.PORT,
      portValue: process.env.PORT ?? '(not set, using 3001)',
    },
  });
});

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
        user_lat: lat, user_lon: lon,
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
  try {
    // Fetch satellite data first so it can serve as fallback when N2YO is rate-limited
    const satData = await getVisibleSatellitesData(lat, lon, altM, locationName) as any;
    res.json(await getPassRecommendation(
      { lat, lon, alt: altM },
      locationName,
      satData.satellites ?? [],
    ));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/notifications/check', async (_req, res) => {
  try { res.json(await checkAndNotify()); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/notifications/settings', (_req, res) => {
  res.json(getAlertConfig());
});

app.post('/api/notifications/settings', (req: Request, res: Response) => {
  const { minElevation, alertMinutesBefore, enabled } = req.body;
  const updated = setAlertConfig({
    ...(typeof minElevation       === 'number'  && { minElevation }),
    ...(typeof alertMinutesBefore === 'number'  && { alertMinutesBefore }),
    ...(typeof enabled            === 'boolean' && { enabled }),
  });
  res.json(updated);
});

app.get('/api/digest/send-now', async (_req, res) => {
  try { res.json(await sendDailyDigest()); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/insights/patterns', async (_req, res) => {
  try {
    const result = await analyzeHistoricalPatterns();
    res.json(result);
  } catch (err: any) {
    console.error('[patterns] unhandled error:', err.message, err.stack);
    res.status(500).json({ error: err.message, available: false, dataPoints: 0 });
  }
});

app.get('/api/notifications/subscribe', (_req, res) => {
  res.json({
    topic:        'startrack-tring-alerts',
    url:          NTFY_SUBSCRIBE_URL,
    webUrl:       `${NTFY_SUBSCRIBE_URL}/`,
    instructions: 'Install the ntfy app (ntfy.sh), tap Subscribe, enter topic: startrack-tring-alerts.',
  });
});

app.get('/api/satellites/tle', async (req: Request, res: Response) => {
  const name = (req.query.name as string)?.trim();
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }

  await getActiveSatellites(1);
  const tle = findTleByName(name);
  if (!tle) { res.status(404).json({ error: `TLE not found for "${name}"` }); return; }

  const { line1, line2 } = tle;

  // NORAD ID from line 1 cols 3-7 (0-indexed: 2-7)
  const noradId = parseInt(line1.substring(2, 7).trim(), 10);

  // Epoch from line 1 cols 19-32 (0-indexed: 18-32)
  const epochStr  = line1.substring(18, 32).trim();
  const yr2       = parseInt(epochStr.substring(0, 2), 10);
  const dayOfYear = parseFloat(epochStr.substring(2));
  const fullYear  = yr2 >= 57 ? 1900 + yr2 : 2000 + yr2;
  const epochMs   = Date.UTC(fullYear, 0, 1) + (dayOfYear - 1) * 86_400_000;

  // Line 2 orbital elements
  const inclination  = parseFloat(line2.substring(8,  16).trim());
  const raan         = parseFloat(line2.substring(17, 25).trim());
  const eccentricity = parseFloat('0.' + line2.substring(26, 33).trim());
  const meanMotion   = parseFloat(line2.substring(52, 63).trim()); // rev/day

  // Derived quantities
  const period        = 1440 / meanMotion;                                  // minutes
  const mu            = 398_600.4418;                                        // km³/s²
  const semiMajorAxis = Math.cbrt(mu * Math.pow((period * 60) / (2 * Math.PI), 2));
  const meanAltitude  = Math.round(semiMajorAxis - 6_371);
  const orbitalSpeedKmS = parseFloat(calculateOrbitalSpeedFromTle(line1, line2).toFixed(2));

  console.log(`[orbital-speed] ${tle.name}: altitude=${meanAltitude}km, speed=${orbitalSpeedKmS}km/s`);

  res.json({
    name:         tle.name,
    tle_line1:    line1,
    tle_line2:    line2,
    noradId,
    epoch:        new Date(epochMs).toISOString(),
    inclination:  parseFloat(inclination.toFixed(4)),
    raan:         parseFloat(raan.toFixed(4)),
    eccentricity: parseFloat(eccentricity.toFixed(7)),
    period:       parseFloat(period.toFixed(2)),
    meanAltitude,
    orbitalSpeedKmS,
  });
});

app.get('/api/satellites/passes', async (req: Request, res: Response) => {
  const name = (req.query.name as string)?.trim();
  if (!name) { res.status(400).json({ error: 'name is required' }); return; }

  const { lat, lon, altM } = parseObs(req);
  await getActiveSatellites(1);
  const tle = findTleByName(name);
  if (!tle) { res.status(404).json({ error: `TLE not found for "${name}"` }); return; }

  const passes = predictPasses([tle], lat, lon, altM / 1000, 7, 60, 10);
  const result = passes
    .sort((a, b) => a.startUTC - b.startUTC)
    .slice(0, 10)
    .map(p => ({
      satname:  p.satname,
      startUTC: p.startUTC,
      maxUTC:   p.maxUTC,
      endUTC:   p.endUTC,
      maxEl:    p.maxEl,
      duration: p.duration,
      score:    Math.round(40 + (p.maxEl / 90) * 60),
    }));

  res.json(result);
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

// ── Prediction validation against Heavens-Above ───────────────────────────────

// NORAD ID + TLE epoch for a TLE, using the same parsing as /api/satellites/tle
function tleMeta(line1: string): { noradId: number; epochIso: string } {
  const noradId   = parseInt(line1.substring(2, 7).trim(), 10);
  const epochStr  = line1.substring(18, 32).trim();
  const yr2       = parseInt(epochStr.substring(0, 2), 10);
  const dayOfYear = parseFloat(epochStr.substring(2));
  const fullYear  = yr2 >= 57 ? 1900 + yr2 : 2000 + yr2;
  const epochMs   = Date.UTC(fullYear, 0, 1) + (dayOfYear - 1) * 86_400_000;
  return { noradId, epochIso: new Date(epochMs).toISOString() };
}

const HIGH_VALUE_MIN_EL = 70;

app.get('/api/validation/log-predictions', async (_req, res) => {
  if (!supabase) { res.status(503).json({ error: 'Supabase not configured' }); return; }
  try {
    await getActiveSatellites(1);
    const tles = getAllSatellites();
    const passes = predictPasses(tles, DEFAULT_LAT, DEFAULT_LON, DEFAULT_ALT_M / 1000, 1, 60, HIGH_VALUE_MIN_EL);

    const rows = passes.map(p => {
      const tle = findTleByName(p.satname);
      const meta = tle ? tleMeta(tle.line1) : null;
      return {
        satellite_name:        p.satname,
        norad_id:               meta?.noradId ?? null,
        predicted_start_time:   new Date(p.startUTC * 1000).toISOString(),
        predicted_peak_time:    new Date(p.maxUTC   * 1000).toISOString(),
        predicted_end_time:     new Date(p.endUTC   * 1000).toISOString(),
        predicted_max_elevation: p.maxEl,
        predicted_max_azimuth:  p.maxAz,
        tle_epoch:               meta?.epochIso ?? null,
      };
    });

    if (rows.length > 0) {
      const { error } = await supabase.from('prediction_validation').insert(rows);
      if (error) throw new Error(error.message);
    }

    res.json({ logged: rows.length, passes: rows });
  } catch (err: any) {
    console.error('[validation] log-predictions failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/validation/checklist', async (_req, res) => {
  if (!supabase) { res.status(503).json({ error: 'Supabase not configured' }); return; }
  try {
    const { data, error } = await supabase
      .from('prediction_validation')
      .select('*')
      .eq('validated', false)
      .order('predicted_peak_time', { ascending: true })
      .limit(10);
    if (error) throw new Error(error.message);

    const checklist = (data ?? []).map(row => ({
      id:               row.id,
      satelliteName:    row.satellite_name,
      noradId:          row.norad_id,
      predictedPeakTime: row.predicted_peak_time,
      predictedMaxElevation: row.predicted_max_elevation,
      heavensAboveUrl:  `https://www.heavens-above.com/PassSummary.aspx?satid=${row.norad_id}&lat=${DEFAULT_LAT}&lng=${DEFAULT_LON}&loc=Tring&alt=${DEFAULT_ALT_M}&tz=GMT`,
    }));

    res.json({
      instructions: 'Open each heavensAboveUrl, find the matching pass, and POST the actual peak time and max elevation to /api/validation/record-actual with { id, actualPeakTime, actualMaxElevation }.',
      checklist,
    });
  } catch (err: any) {
    console.error('[validation] checklist failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/validation/record-actual', async (req: Request, res: Response) => {
  if (!supabase) { res.status(503).json({ error: 'Supabase not configured' }); return; }
  try {
    const { id, actualPeakTime, actualMaxElevation } = req.body as {
      id: number; actualPeakTime: string; actualMaxElevation: number;
    };
    if (!id || !actualPeakTime || actualMaxElevation == null) {
      res.status(400).json({ error: 'id, actualPeakTime, and actualMaxElevation are required' });
      return;
    }

    const { data: existing, error: fetchError } = await supabase
      .from('prediction_validation')
      .select('predicted_peak_time, predicted_max_elevation')
      .eq('id', id)
      .single();
    if (fetchError) throw new Error(fetchError.message);
    if (!existing) { res.status(404).json({ error: `No prediction with id ${id}` }); return; }

    const timeDelta = Math.abs(
      (new Date(actualPeakTime).getTime() - new Date(existing.predicted_peak_time).getTime()) / 1000,
    );
    const elevationDelta = Math.abs(actualMaxElevation - existing.predicted_max_elevation);

    const { error: updateError } = await supabase
      .from('prediction_validation')
      .update({
        actual_peak_time:        actualPeakTime,
        actual_max_elevation:    actualMaxElevation,
        time_delta_seconds:      timeDelta,
        elevation_delta_degrees: elevationDelta,
        validated:               true,
      })
      .eq('id', id);
    if (updateError) throw new Error(updateError.message);

    res.json({ timeDelta, elevationDelta, accurate: timeDelta < 5 && elevationDelta < 1 });
  } catch (err: any) {
    console.error('[validation] record-actual failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/validation/results', async (_req, res) => {
  if (!supabase) { res.status(503).json({ error: 'Supabase not configured' }); return; }
  try {
    const { data, error } = await supabase
      .from('prediction_validation')
      .select('time_delta_seconds, elevation_delta_degrees')
      .eq('validated', true);
    if (error) throw new Error(error.message);

    const rows = data ?? [];
    if (rows.length === 0) {
      res.json({ validatedCount: 0, summary: 'No validated predictions yet.' });
      return;
    }

    const avgTimeDelta      = rows.reduce((a, r) => a + (r.time_delta_seconds ?? 0), 0) / rows.length;
    const avgElevationDelta = rows.reduce((a, r) => a + (r.elevation_delta_degrees ?? 0), 0) / rows.length;
    const accurateCount     = rows.filter(r => (r.time_delta_seconds ?? Infinity) < 5 && (r.elevation_delta_degrees ?? Infinity) < 1).length;
    const accuracyRate      = (accurateCount / rows.length) * 100;

    res.json({
      validatedCount:    rows.length,
      avgTimeDeltaSeconds: parseFloat(avgTimeDelta.toFixed(2)),
      avgElevationDeltaDegrees: parseFloat(avgElevationDelta.toFixed(2)),
      accuracyRate:      parseFloat(accuracyRate.toFixed(1)),
      summary: `Based on ${rows.length} validated pass${rows.length === 1 ? '' : 'es'}, predictions are accurate to within 5s/1° on ${accuracyRate.toFixed(1)}% of passes (avg time delta ${avgTimeDelta.toFixed(1)}s, avg elevation delta ${avgElevationDelta.toFixed(2)}°).`,
    });
  } catch (err: any) {
    console.error('[validation] results failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Anthropic client ─────────────────────────────────────────────────────────
const anthropic = new Anthropic({
  apiKey:  process.env.ANTHROPIC_API_KEY,
  timeout: 20_000, // fail fast so SSE error frame reaches the client
});

// ── /api/chat — SSE streaming chat endpoint ───────────────────────────────────
app.post('/api/chat', async (req: Request, res: Response) => {
  const { message, history = [] } = req.body as {
    message: string;
    history: { role: 'user' | 'assistant'; content: string }[];
  };

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
    if (!closed) res.write(': ping\n\n');
  }, 5_000);

  // Cap each context fetch at 8 s so streaming always starts promptly
  function cap<T>(p: Promise<T>, fallback: T, ms = 8_000): Promise<T> {
    return Promise.race([p, new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))]);
  }

  try {
    // Fetch sat + weather in parallel first; sat data feeds the pass fallback
    const [satData, weatherData] = await Promise.all([
      cap(getVisibleSatellitesData(DEFAULT_LAT, DEFAULT_LON, DEFAULT_ALT_M) as Promise<any>, {}),
      cap(getWeatherData(DEFAULT_LAT, DEFAULT_LON) as Promise<any>, {}),
    ]);
    const passData = await cap(
      getPassRecommendation(
        { lat: DEFAULT_LAT, lon: DEFAULT_LON, alt: DEFAULT_ALT_M },
        'Tring, Hertfordshire',
        (satData as any).satellites ?? [],
      ) as Promise<any>,
      { topPasses: [] },
    );

    const sats:   any[] = satData.satellites  ?? [];
    const passes: any[] = passData.topPasses  ?? [];

    const satList = sats.slice(0, 10).map((s: any) => {
      const d = s.dopplerShiftKHz != null
        ? `, doppler ${s.dopplerShiftKHz > 0 ? '+' : ''}${(s.dopplerShiftKHz as number).toFixed(1)} kHz`
        : '';
      return `  ${s.satname}: el ${s.elevation}°, az ${s.azimuth}°${d}`;
    }).join('\n');

    const passList = passes.slice(0, 5).map((p: any, i: number) => {
      const peakDate = new Date(p.maxUTC * 1000);
      const dateStr  = peakDate.toLocaleString('en-GB', {
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

    if (closed) { res.end(); return; }

    // Use raw streaming API for reliable event iteration
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1024,
      system:     systemPrompt,
      messages:   [
        ...history,
        { role: 'user', content: message },
      ],
      stream: true,
    });

    for await (const event of response) {
      if (closed) break;
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta' &&
        event.delta.text
      ) {
        res.write(`data: ${JSON.stringify({ chunk: event.delta.text })}\n\n`);
      }
    }

    clearInterval(heartbeat);
    if (!closed) {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    }
    res.end();
  } catch (err: any) {
    clearInterval(heartbeat);
    console.error('[chat]', err.message);
    if (!closed) {
      res.write(`data: ${JSON.stringify({ error: true, message: err.message })}\n\n`);
      res.end();
    }
  }
});

// ── Daily digest state ────────────────────────────────────────────────────────
let lastDigestDate: string | null = null;

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const server  = http.createServer(app);
const wss     = new WebSocketServer({ server });
const clients = new Set<WebSocket>();
console.log('[ws] WebSocket server attached to HTTP server');

wss.on('error', (err) => {
  console.error('[ws] SERVER ERROR:', err.message);
});

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

async function broadcastPositions() {
  if (clients.size === 0) return;
  const tles = getAllSatellites();
  if (tles.length === 0) return;
  try {
    const positions = getPositionsNow(tles, DEFAULT_LAT, DEFAULT_LON, DEFAULT_ALT_M / 1000);
    const message   = JSON.stringify({ type: 'positions', satellites: positions, timestamp: Date.now() });
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  } catch (err: any) {
    console.error('[ws] positions broadcast failed:', err.message);
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

wss.on('connection', (ws, req) => {
  clients.add(ws);
  console.log('[ws] NEW CONNECTION from', req.socket.remoteAddress);
  console.log('[ws] upgrade headers:', JSON.stringify({
    host:      req.headers['host'],
    origin:    req.headers['origin'],
    upgrade:   req.headers['upgrade'],
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
  getActiveSatellites(9999).catch(err =>
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

  // Broadcast lightweight positions every 5 s (for smooth animation)
  setInterval(() => broadcastPositions(), 5_000);

  // Broadcast full satellite data every 30 s
  setInterval(() => broadcastSatellites(), 30_000);

  // Broadcast weather every 60 s
  setInterval(broadcastWeather, 60_000);

  // Daily digest at 6:00 AM UK time — check every minute
  setInterval(async () => {
    const ukTime  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/London' }));
    const hours   = ukTime.getHours();
    const minutes = ukTime.getMinutes();
    if (hours === 6 && minutes === 0) {
      const today = ukTime.toDateString();
      if (lastDigestDate !== today) {
        lastDigestDate = today;
        try {
          await sendDailyDigest();
          console.log('[digest] sent for', today);
        } catch (err: any) {
          console.error('[digest] failed:', err.message);
        }
      }
    }
  }, 60_000);

  // Keep Railway awake — ping /health every 4 min so the dyno never sleeps
  const BACKEND_URL = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://web-production-98c0d.up.railway.app';

  setInterval(async () => {
    try {
      await axios.get(`${BACKEND_URL}/health`, { timeout: 5_000 });
      console.log('[keep-alive] ping sent');
    } catch (err: any) {
      console.warn('[keep-alive] ping failed:', err.message);
    }
  }, 4 * 60 * 1_000);
});
