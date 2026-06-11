"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express = require('express');
const router = express.Router();
const { getVisibleSatellites } = require('../services/satelliteService');
router.get('/visible', async (req, res) => {
    try {
        const satellites = await getVisibleSatellites(51.7957, -0.6572, 148);
        res.json({
            location: { name: 'Tring, Hertfordshire', lat: 51.7957, lon: -0.6572 },
            count: satellites.length,
            satellites
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
module.exports = router;
