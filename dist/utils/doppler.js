"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateDoppler = calculateDoppler;
const satellite = __importStar(require("satellite.js"));
const STARLINK_FREQ_HZ = 10.7e9; // Ku-band downlink ~10.7 GHz
const SPEED_OF_LIGHT_MS = 299792458; // m/s
function calculateDoppler(obsLat, obsLon, obsAltKm, line1, line2) {
    try {
        const satrec = satellite.twoline2satrec(line1, line2);
        const t1 = new Date();
        const t2 = new Date(t1.getTime() + 1000);
        const pv1 = satellite.propagate(satrec, t1);
        const pv2 = satellite.propagate(satrec, t2);
        if (!pv1 || !pv2)
            return null;
        const pos1 = pv1.position;
        const pos2 = pv2.position;
        if (!pos1 || pos1 === false || !pos2 || pos2 === false)
            return null;
        const gmst1 = satellite.gstime(t1);
        const gmst2 = satellite.gstime(t2);
        const ecf1 = satellite.eciToEcf(pos1, gmst1);
        const ecf2 = satellite.eciToEcf(pos2, gmst2);
        const obsGd = {
            latitude: satellite.degreesToRadians(obsLat),
            longitude: satellite.degreesToRadians(obsLon),
            height: obsAltKm,
        };
        const look1 = satellite.ecfToLookAngles(obsGd, ecf1);
        const look2 = satellite.ecfToLookAngles(obsGd, ecf2);
        // range delta over 1 s = radial velocity in km/s → convert to m/s
        const radialVelocityMs = (look2.rangeSat - look1.rangeSat) * 1000;
        // approaching (negative radial delta) → positive Doppler (blueshift / higher freq)
        const dopplerShiftHz = -(STARLINK_FREQ_HZ * radialVelocityMs) / SPEED_OF_LIGHT_MS;
        const dopplerShiftKHz = Math.round(dopplerShiftHz / 1000);
        return { dopplerShiftHz: Math.round(dopplerShiftHz), dopplerShiftKHz };
    }
    catch {
        return null;
    }
}
