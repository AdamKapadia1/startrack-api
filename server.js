require('dotenv').config();
const express = require('express');
const axios = require('axios');
const satellite = require('satellite.js');
const app = express();
app.use(express.json());
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/satellites/visible', async (req, res) => {
  try {
    const r = await axios.get('https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle', { timeout: 30000, headers: { 'User-Agent': 'StarTrack/1.0' } });
    const lines = r.data.split('
').map(l => l.trim()).filter(l => l.length > 0);
    const tles = [];
    for (let i = 0; i < lines.length - 2; i += 3) {
      if (lines[i+1] && lines[i+1].startsWith('1 ') && lines[i+2] && lines[i+2].startsWith('2 ')) {
        tles.push({ name: lines[i], line1: lines[i+1], line2: lines[i+2] });
      }
    }
    const now = new Date();
    const obs = { latitude: satellite.degreesToRadians(51.7957), longitude: satellite.degreesToRadians(-0.6572), height: 0.148 };
    const visible = [];
    for (const tle of tles) {
      try       try       try       try  ite.twoline2satrec(tle.line1, tle.lin      try       try       try       try ate      try       try          try       try    eo      try       try       try       try  ite.twoline2satrec(sa      try       try       try       try  ite.twoline2iToEcf(pv.position, gmst);
        const look = satellite.ecfToLookAngles(obs, ecf);
        const elev = satellite.radiansToDegrees(look.elevation);
        if (elev > 10) visible.push({ name: tle.name, elevation: Math.round(elev*10)/10, azimuth: Math.round(satellite.radiansToDegrees(look.azimuth)*10)/10, range_km: Math.round(look.rangeSat) });
      } catch(e) {}
    }
    visible.sort((a,b) => b.elevation - a.elevation);
    res.json({ location: 'Tring, Hertfordshire', count: visible.length, satellites: visible });
  } catch(err) { res.status(500).json({ error: err.message }); }
});
app.listen(3001, () => console.log('StarTrack API listening on port 3001'));
