import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import cors from 'cors';
import axios from 'axios';
import { getPassRecommendation, checkAndNotify } from './agents/passAgent.js';

dotenv.config();

const OBS_LAT = 51.7957;
const OBS_LON = -0.6572;
const OBS_ALT_KM = 0.148;
const R_EARTH_KM = 6371.0;

function toRad(deg: number) { return deg * Math.PI / 180; }
function toDeg(rad: number) { return rad * 180 / Math.PI; }

function lookAngles(obsLat: number, obsLon: number, obsAltKm: number, satLat: number, satLon: number, satAltKm: number) {
  const latO = toRad(obsLat), lonO = toRad(obsLon);
  const latS = toRad(satLat), lonS = toRad(satLon);
  const rO = R_EARTH_KM + obsAltKm;
  const rS = R_EARTH_KM + satAltKm;

  // Observer and satellite in ECEF
  const ox = rO * Math.cos(latO) * Math.cos(lonO);
  const oy = rO * Math.cos(latO) * Math.sin(lonO);
  const oz = rO * Math.sin(latO);
  const sx = rS * Math.cos(latS) * Math.cos(lonS);
  const sy = rS * Math.cos(latS) * Math.sin(lonS);
  const sz = rS * Math.sin(latS);

  // Range vector in ECEF
  const dx = sx - ox, dy = sy - oy, dz = sz - oz;
  const range = Math.sqrt(dx * dx + dy * dy + dz * dz);

  // Rotate into local South-East-Up frame at observer
  const sinLat = Math.sin(latO), cosLat = Math.cos(latO);
  const sinLon = Math.sin(lonO), cosLon = Math.cos(lonO);
  const south  = -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz;
  const east   = -sinLon * dx + cosLon * dy;
  const up     =  cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz;

  const elevation = toDeg(Math.asin(up / range));
  const azimuth   = (toDeg(Math.atan2(east, -south)) + 360) % 360;
  return { elevation, azimuth, range };
}

const app = express();
app.use(cors({
  origin: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

app.get('/api/satellites/visible', async (_req: Request, res: Response) => {
  const N2YO_KEY = process.env.N2YO_API_KEY ?? 'GMVRQ4-MY5LN2-UZUBTB-5RSS';
  const aboveUrl = (cat: number) =>
    `https://api.n2yo.com/rest/v1/satellite/above/${OBS_LAT}/${OBS_LON}/148/10/${cat}/&apiKey=${N2YO_KEY}`;

  try {
    const [starlinkRes, onewebRes] = await Promise.allSettled([
      axios.get(aboveUrl(52), { timeout: 30000 }),  // Starlink
      axios.get(aboveUrl(53), { timeout: 30000 }),  // OneWeb
    ]);

    const rawSats: any[] = [];
    for (const r of [starlinkRes, onewebRes]) {
      if (r.status === 'fulfilled') rawSats.push(...(r.value.data.above ?? []));
    }

    // Deduplicate by name, compute look-angles, sort by elevation desc.
    const seen = new Set<string>();
    const satellites = rawSats
      .filter(sat => { if (seen.has(sat.satname)) return false; seen.add(sat.satname); return true; })
      .map(sat => {
        const { elevation, azimuth, range } = lookAngles(
          OBS_LAT, OBS_LON, OBS_ALT_KM,
          sat.satlat, sat.satlng, sat.satalt
        );
        return {
          satname:   sat.satname,
          elevation: Math.round(elevation * 10) / 10,
          azimuth:   Math.round(azimuth * 10) / 10,
          range:     Math.round(range),
        };
      })
      .sort((a, b) => b.elevation - a.elevation);

    res.json({
      location: { name: 'Tring, Hertfordshire', lat: OBS_LAT, lon: OBS_LON },
      count: satellites.length,
      satellites,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/recommendation', async (_req: Request, res: Response) => {
  try {
    const result = await getPassRecommendation();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/notifications/check', async (_req: Request, res: Response) => {
  try {
    const result = await checkAndNotify();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT ?? 3001;

app.listen(PORT, () => {
  console.log(`StarTrack API listening on port ${PORT}`);
  setInterval(async () => {
    try {
      const { alerted } = await checkAndNotify();
      if (alerted > 0) console.log(`[notifications] sent ${alerted} alert(s)`);
    } catch (err: any) {
      console.error('[notifications] check failed:', err.message);
    }
  }, 60_000);
});
