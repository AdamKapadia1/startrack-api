const express = require('express');
const router = express.Router();
const { getVisibleSatellites } = require('../services/satelliteService');

router.get('/visible', async (req: any, res: any) => {
  try {
    const satellites = await getVisibleSatellites(51.7957, -0.6572, 148);
    res.json({
      location: { name: 'Tring, Hertfordshire', lat: 51.7957, lon: -0.6572 },
      count: satellites.length,
      satellites
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
