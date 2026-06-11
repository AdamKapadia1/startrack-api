import * as satellite from 'satellite.js';

const STARLINK_FREQ_HZ   = 10.7e9;     // Ku-band downlink ~10.7 GHz
const SPEED_OF_LIGHT_MS  = 299_792_458; // m/s

export interface DopplerResult {
  dopplerShiftHz:  number;
  dopplerShiftKHz: number;
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
