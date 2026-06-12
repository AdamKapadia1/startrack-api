import * as satellite from 'satellite.js';
import type { TleEntry } from './tleCache.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

interface ObsGd { latitude: number; longitude: number; height: number; }

function makeObs(lat: number, lon: number, altKm: number): ObsGd {
  return { latitude: lat * DEG, longitude: lon * DEG, height: altKm };
}

function getLook(satrec: satellite.SatRec, date: Date, obs: ObsGd) {
  try {
    const pv = satellite.propagate(satrec, date);
    if (!pv) return null;
    const pos = (pv as any).position;
    if (!pos || pos === false) return null;
    const gmst = satellite.gstime(date);
    const ecf  = satellite.eciToEcf(pos, gmst);
    const la   = satellite.ecfToLookAngles(obs, ecf);
    return {
      el:    (la.elevation as number) * RAD,
      az:    ((la.azimuth  as number) * RAD + 360) % 360,
      range: la.rangeSat as number,
    };
  } catch { return null; }
}

export interface CurrentPosition {
  satname: string; elevation: number; azimuth: number; range: number;
}

/** Propagate all TLEs to current time; return those at or above minEl degrees. */
export function getVisibleNow(
  tles: TleEntry[],
  lat: number, lon: number, altKm: number,
  minEl = 0,
): CurrentPosition[] {
  const obs = makeObs(lat, lon, altKm);
  const now = new Date();
  const out: CurrentPosition[] = [];
  for (const tle of tles) {
    try {
      const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
      const la = getLook(satrec, now, obs);
      if (la && la.el >= minEl) {
        out.push({
          satname:   tle.name,
          elevation: Math.round(la.el    * 10) / 10,
          azimuth:   Math.round(la.az    * 10) / 10,
          range:     Math.round(la.range),
        });
      }
    } catch { /* skip invalid TLE */ }
  }
  return out.sort((a, b) => b.elevation - a.elevation);
}

export interface PositionNow {
  satname:         string;
  elevation:       number;
  azimuth:         number;
  range:           number;
  dopplerShiftKHz: number | null;
}

const STARLINK_FREQ_HZ = 10.7e9;
const SPEED_OF_LIGHT   = 299_792_458;

/** Propagate all TLEs to current moment; return all with elevation > 0°. Uses cached TLEs only. */
export function getPositionsNow(
  tles:   TleEntry[],
  lat:    number,
  lon:    number,
  altKm:  number,
): PositionNow[] {
  const obs = makeObs(lat, lon, altKm);
  const t1  = new Date();
  const t2  = new Date(t1.getTime() + 1000);
  const out: PositionNow[] = [];

  for (const tle of tles) {
    try {
      const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
      const la1    = getLook(satrec, t1, obs);
      if (!la1 || la1.el < 0) continue;

      // Range-rate Doppler: (range2 - range1) km/s → Hz shift
      let dopplerKHz: number | null = null;
      const la2 = getLook(satrec, t2, obs);
      if (la2 !== null) {
        const radialVelocityMs = (la2.range - la1.range) * 1000;
        const hz = -(STARLINK_FREQ_HZ * radialVelocityMs) / SPEED_OF_LIGHT;
        dopplerKHz = Math.round(hz / 1000);
      }

      out.push({
        satname:         tle.name,
        elevation:       Math.round(la1.el    * 10) / 10,
        azimuth:         Math.round(la1.az    * 10) / 10,
        range:           Math.round(la1.range),
        dopplerShiftKHz: dopplerKHz,
      });
    } catch { /* skip invalid TLE */ }
  }

  return out.sort((a, b) => b.elevation - a.elevation);
}

export interface PredictedPass {
  satname: string; startUTC: number; maxUTC: number; endUTC: number;
  maxEl: number; startAz: number; maxAz: number; duration: number;
}

/**
 * Scan tles forward in time at stepSeconds intervals to find passes above minEl.
 * daysAhead=7, stepSeconds=60, minEl=30 gives ~10 seconds compute for 100 sats,
 * which is cached for several hours.
 */
export function predictPasses(
  tles: TleEntry[],
  lat: number, lon: number, altKm: number,
  daysAhead   = 7,
  stepSeconds = 60,
  minEl       = 30,
): PredictedPass[] {
  const obs    = makeObs(lat, lon, altKm);
  const nowMs  = Date.now();
  const endMs  = nowMs + daysAhead * 86_400_000;
  const stepMs = stepSeconds * 1000;
  const passes: PredictedPass[] = [];

  for (const tle of tles) {
    try {
      const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
      let inPass = false;
      let s0 = 0, az0 = 0, peak = 0, peakT = 0, peakAz = 0;

      for (let t = nowMs; t <= endMs; t += stepMs) {
        const la = getLook(satrec, new Date(t), obs);
        if (!la) continue;

        if (la.el >= minEl) {
          if (!inPass) {
            inPass = true;
            s0 = Math.floor(t / 1000); az0 = la.az;
            peak = la.el; peakT = s0; peakAz = la.az;
          } else if (la.el > peak) {
            peak = la.el; peakT = Math.floor(t / 1000); peakAz = la.az;
          }
        } else if (inPass) {
          inPass = false;
          const e0 = Math.floor(t / 1000);
          passes.push({
            satname: tle.name, startUTC: s0, maxUTC: peakT, endUTC: e0,
            maxEl:   Math.round(peak  * 10) / 10,
            startAz: Math.round(az0   * 10) / 10,
            maxAz:   Math.round(peakAz* 10) / 10,
            duration: e0 - s0,
          });
        }
      }
    } catch { /* skip */ }
  }

  return passes.sort((a, b) => b.maxEl - a.maxEl);
}
