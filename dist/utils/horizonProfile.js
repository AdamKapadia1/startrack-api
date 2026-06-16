"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HORIZON_PRESETS = exports.FLAT_HORIZON = void 0;
exports.getMinElevationForAzimuth = getMinElevationForAzimuth;
exports.parseCustomHorizon = parseCustomHorizon;
// Default flat horizon — 0° everywhere (matches pre-existing behaviour).
exports.FLAT_HORIZON = {
    profile: new Array(36).fill(0),
};
// Preset profiles for common scenarios.
exports.HORIZON_PRESETS = {
    flat: exports.FLAT_HORIZON,
    suburban: { profile: new Array(36).fill(5) }, // typical houses/trees ~5°
    urban: { profile: new Array(36).fill(15) }, // city buildings ~15°
    valley: { profile: new Array(36).fill(20) }, // hills on most sides
};
function getMinElevationForAzimuth(profile, azimuth) {
    const index = Math.floor(((azimuth % 360) / 10)) % 36;
    return profile.profile[index] ?? 0;
}
// Builds a 36-bucket profile from a comma-separated list of up to 36 numbers
// (e.g. from a "horizonCustom" query param). Returns null if the input is malformed.
function parseCustomHorizon(csv) {
    const values = csv.split(',').map(v => parseFloat(v.trim()));
    if (values.length !== 36 || values.some(v => isNaN(v) || v < 0 || v > 90))
        return null;
    return { profile: values };
}
