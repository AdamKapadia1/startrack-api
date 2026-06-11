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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchStarlinkTLEs = fetchStarlinkTLEs;
exports.getVisibleSatellites = getVisibleSatellites;
const axios_1 = __importDefault(require("axios"));
const satellite = __importStar(require("satellite.js"));
async function fetchStarlinkTLEs() {
    const response = await axios_1.default.get('https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=tle', {
        timeout: 30000,
        headers: { 'User-Agent': 'StarTrack/1.0', Accept: 'text/plain' }
    });
    const data = String(response.data || '');
    const lines = data.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    const tles = [];
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
async function getVisibleSatellites(lat, lon, altMetres) {
    const tles = await fetchStarlinkTLEs();
    const now = new Date();
    const observerGd = {
        latitude: satellite.degreesToRadians(lat),
        longitude: satellite.degreesToRadians(lon),
        height: altMetres / 1000
    };
    const visible = [];
    for (const tle of tles) {
        try {
            const satrec = satellite.twoline2satrec(tle.tle_line1, tle.tle_line2);
            const pv = satellite.propagate(satrec, now);
            if (!pv)
                continue;
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
        }
        catch (e) {
            continue;
        }
    }
    return visible.sort((a, b) => b.elevation - a.elevation);
}
