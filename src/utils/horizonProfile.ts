export interface HorizonProfile {
  // Minimum elevation angle visible at each compass direction, in degrees.
  // Index 0 = North, 9 = East, 18 = South, 27 = West (one entry per 10° of azimuth).
  profile: number[]; // 36 values
}

// Default flat horizon — 0° everywhere (matches pre-existing behaviour).
export const FLAT_HORIZON: HorizonProfile = {
  profile: new Array(36).fill(0),
};

// Preset profiles for common scenarios.
export const HORIZON_PRESETS: Record<string, HorizonProfile> = {
  flat:     FLAT_HORIZON,
  suburban: { profile: new Array(36).fill(5) },  // typical houses/trees ~5°
  urban:    { profile: new Array(36).fill(15) }, // city buildings ~15°
  valley:   { profile: new Array(36).fill(20) }, // hills on most sides
};

export function getMinElevationForAzimuth(profile: HorizonProfile, azimuth: number): number {
  const index = Math.floor(((azimuth % 360) / 10)) % 36;
  return profile.profile[index] ?? 0;
}

// Builds a 36-bucket profile from a comma-separated list of up to 36 numbers
// (e.g. from a "horizonCustom" query param). Returns null if the input is malformed.
export function parseCustomHorizon(csv: string): HorizonProfile | null {
  const values = csv.split(',').map(v => parseFloat(v.trim()));
  if (values.length !== 36 || values.some(v => isNaN(v) || v < 0 || v > 90)) return null;
  return { profile: values };
}
