import * as satellite from 'satellite.js';

const STARLINK_FREQ_HZ   = 10.7e9;     // Ku-band downlink ~10.7 GHz
const SPEED_OF_LIGHT_MS  = 299_792_458; // m/s
const FALLBACK_SPEED_KM_S = 7.5;        // generic LEO average, used only if propagation fails

export interface DopplerResult {
  dopplerShiftHz:  number;
  dopplerShiftKHz: number;
}

// True orbital speed for this specific satellite, from its SGP4 velocity vector (km/s, ECI frame)
export function calculateOrbitalSpeed(satrec: satellite.SatRec, date: Date): number {
  try {
    const pv = satellite.propagate(satrec, date);
    const velocity = (pv as any).velocity;
    if (!velocity || velocity === false) return FALLBACK_SPEED_KM_S;
    return Math.sqrt(velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2);
  } catch {
    return FALLBACK_SPEED_KM_S;
  }
}

export function calculateOrbitalSpeedFromTle(line1: string, line2: string, date: Date = new Date()): number {
  try {
    const satrec = satellite.twoline2satrec(line1, line2);
    return calculateOrbitalSpeed(satrec, date);
  } catch {
    return FALLBACK_SPEED_KM_S;
  }
}

export function calculateDoppler(
  obsLat:   number,
  obsLon:   number,
  obsAltKm: number,
  line1:    string,
  line2:    string,
): DopplerResult | null {
  try {
    const satrec = satellite.twoline2satrec(line1, line2);
    const t1 = new Date();
    const t2 = new Date(t1.getTime() + 1000);

    const pv1 = satellite.propagate(satrec, t1);
    const pv2 = satellite.propagate(satrec, t2);

    if (!pv1 || !pv2) return null;
    const pos1 = (pv1 as any).position;
    const pos2 = (pv2 as any).position;
    if (!pos1 || pos1 === false || !pos2 || pos2 === false) return null;

    const gmst1 = satellite.gstime(t1);
    const gmst2 = satellite.gstime(t2);

    const ecf1 = satellite.eciToEcf(pos1, gmst1);
    const ecf2 = satellite.eciToEcf(pos2, gmst2);

    const obsGd = {
      latitude:  satellite.degreesToRadians(obsLat),
      longitude: satellite.degreesToRadians(obsLon),
      height:    obsAltKm,
    };

    const look1 = satellite.ecfToLookAngles(obsGd, ecf1);
    const look2 = satellite.ecfToLookAngles(obsGd, ecf2);

    // range delta over 1 s = radial velocity in km/s → convert to m/s
    const radialVelocityMs = (look2.rangeSat - look1.rangeSat) * 1000;

    // approaching (negative radial delta) → positive Doppler (blueshift / higher freq)
    const dopplerShiftHz  = -(STARLINK_FREQ_HZ * radialVelocityMs) / SPEED_OF_LIGHT_MS;
    const dopplerShiftKHz = Math.round(dopplerShiftHz / 1000);

    return { dopplerShiftHz: Math.round(dopplerShiftHz), dopplerShiftKHz };
  } catch {
    return null;
  }
}
