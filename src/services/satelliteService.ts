import axios from 'axios';
import * as satellite from 'satellite.js';

export async function fetchStarlinkTLEs(): Promise<Array<{ name: string; tle_line1: string; tle_line2: string }>> {
  const response = await axios.get('https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=tle', {
    timeout: 30000,
    headers: { 'User-Agent': 'StarTrack/1.0', Accept: 'text/plain' }
  });
  const data = String(response.data || '');
  const lines = data.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const tles: Array<{ name: string; tle_line1: string; tle_line2: string }> = [];
  for (let i = 0; i < lines.length - 2; i += 3) {
    const name = lines[i];
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (line1 && line1.startsWith('1 ') && line2 && line2.startsWith('2 ')) {
      tles.push({ name, tle_line1: line1, tle_line2: line2 });
    }
  }
  console.log(`Fetched ${tles.length} TLEs`);
  return tles;
}

export async function getVisibleSatellites(lat: number, lon: number, altMetres: number) {
  const tles = await fetchStarlinkTLEs();
  const now = new Date();
  const observerGd = {
    latitude: satellite.degreesToRadians(lat),
    longitude: satellite.degreesToRadians(lon),
    height: altMetres / 1000
  };

  const visible: Array<{ name: string; elevation: number; azimuth: number; range: number; timestamp: string }> = [];

  for (const tle of tles) {
    try {
      const satrec = satellite.twoline2satrec(tle.tle_line1, tle.tle_line2);
      const pv = satellite.propagate(satrec, now);
      if (!pv) continue;
      const positionEci = pv.position;
      const gmst = satellite.gstime(now);
      const positionEcf = satellite.eciToEcf(positionEci, gmst);
      const look = satellite.ecfToLookAngles(observerGd, positionEcf);
      const elevDeg = satellite.radiansToDegrees(look.elevation);
      if (elevDeg > 10) {
        visible.push({
          name: tle.name,
          elevation: Math.round(elevDeg * 10) / 10,
          azimuth: Math.round(satellite.radiansToDegrees(look.azimuth) * 10) / 10,
          range: Math.round(look.rangeSat),
          timestamp: now.toISOString()
        });
      }
    } catch (e) {
      continue;
    }
  }

  return visible.sort((a, b) => b.elevation - a.elevation);
}

