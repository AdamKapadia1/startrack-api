"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scoreSignal = scoreSignal;
function scoreSignal(input) {
    // Elevation: 50 pts max — linear from 10°=0 to 90°=50
    const elevScore = Math.max(0, Math.min(50, ((input.elevation - 10) / 80) * 50));
    // Cloud cover: 20 pts max — 0%=20, 100%=0
    const cloudScore = Math.max(0, (1 - input.cloudCover / 100) * 20);
    // Visibility: 15 pts max — 10 km+ = 15, scales linearly down
    const visScore = Math.min(15, (Math.min(input.visibility, 10000) / 10000) * 15);
    // Wind speed: 10 pts max — 0 m/s=10, 20+ m/s=0
    const windScore = Math.max(0, (1 - Math.min(input.windSpeed, 20) / 20) * 10);
    // Range: 5 pts max — 400 km=5, 1000 km+=0
    const rangeScore = Math.max(0, Math.min(5, ((1000 - Math.max(input.range, 400)) / 600) * 5));
    const breakdown = {
        elevation: Math.round(elevScore * 10) / 10,
        cloud: Math.round(cloudScore * 10) / 10,
        visibility: Math.round(visScore * 10) / 10,
        wind: Math.round(windScore * 10) / 10,
        range: Math.round(rangeScore * 10) / 10,
    };
    const total = Math.min(100, Math.round(elevScore + cloudScore + visScore + windScore + rangeScore));
    return { total, breakdown };
}
