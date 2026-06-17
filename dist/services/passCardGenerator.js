"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generatePassCard = generatePassCard;
const canvas_1 = require("canvas");
function generatePassCard(params) {
    const width = 1200;
    const height = 630;
    const canvas = (0, canvas_1.createCanvas)(width, height);
    const ctx = canvas.getContext('2d');
    // Background gradient
    const bg = ctx.createRadialGradient(600, 0, 0, 600, 315, 800);
    bg.addColorStop(0, '#0d1f3c');
    bg.addColorStop(1, '#080c14');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
    // Subtle grid lines
    ctx.strokeStyle = 'rgba(26, 45, 69, 0.4)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= width; x += 80) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
    }
    for (let y = 0; y <= height; y += 80) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    }
    // Top accent line
    const accentLine = ctx.createLinearGradient(0, 0, width, 0);
    accentLine.addColorStop(0, 'transparent');
    accentLine.addColorStop(0.3, '#00d4ff');
    accentLine.addColorStop(0.7, '#00d4ff');
    accentLine.addColorStop(1, 'transparent');
    ctx.strokeStyle = accentLine;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 4);
    ctx.lineTo(width, 4);
    ctx.stroke();
    // SATELLITE PASS ALERT label
    ctx.fillStyle = '#4a8fa8';
    ctx.font = '600 22px Arial';
    ctx.fillText('SATELLITE PASS ALERT', 80, 95);
    // Satellite name
    const nameMaxW = 700;
    let nameFontSize = 64;
    ctx.font = `bold ${nameFontSize}px monospace`;
    while (ctx.measureText(params.satelliteName).width > nameMaxW && nameFontSize > 32) {
        nameFontSize -= 4;
        ctx.font = `bold ${nameFontSize}px monospace`;
    }
    ctx.fillStyle = '#00d4ff';
    ctx.fillText(params.satelliteName, 80, 178);
    // Location
    ctx.fillStyle = '#c8dff0';
    ctx.font = '26px Arial';
    ctx.fillText(`\u{1F4CD} ${params.locationLabel}`, 80, 222);
    // Details card background
    ctx.fillStyle = 'rgba(8, 15, 26, 0.85)';
    roundRect(ctx, 80, 268, 620, 298, 8);
    ctx.fill();
    ctx.strokeStyle = '#1a2d45';
    ctx.lineWidth = 1.5;
    roundRect(ctx, 80, 268, 620, 298, 8);
    ctx.stroke();
    // Date & Time row
    ctx.fillStyle = '#4a8fa8';
    ctx.font = '18px Arial';
    ctx.fillText('DATE & TIME', 118, 318);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px monospace';
    ctx.fillText(`${params.date}  ·  ${params.time}`, 118, 354);
    // Elevation row
    ctx.fillStyle = '#4a8fa8';
    ctx.font = '18px Arial';
    ctx.fillText('MAX ELEVATION', 118, 402);
    const elColor = params.maxElevation >= 60 ? '#00ff88'
        : params.maxElevation >= 30 ? '#ffb800' : '#ff6666';
    ctx.fillStyle = elColor;
    ctx.font = 'bold 30px monospace';
    ctx.fillText(`${params.maxElevation.toFixed(1)}°  —  ${params.quality}`, 118, 436);
    // Signal score row
    if (params.signalScore !== undefined) {
        ctx.fillStyle = '#4a8fa8';
        ctx.font = '18px Arial';
        ctx.fillText('SIGNAL SCORE', 118, 484);
        const scoreColor = params.signalScore >= 70 ? '#00d4ff'
            : params.signalScore >= 50 ? '#ffb800' : '#ff6666';
        ctx.fillStyle = scoreColor;
        ctx.font = 'bold 30px monospace';
        ctx.fillText(`${params.signalScore}/100`, 118, 518);
    }
    // Right side — sky circle illustration
    const cx = 960, cy = 385, R = 180;
    // Outer ring glow
    ctx.shadowColor = '#00d4ff';
    ctx.shadowBlur = 18;
    ctx.strokeStyle = 'rgba(0,212,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // Concentric rings at 30°, 60°, 90°
    [R * (60 / 90), R * (30 / 90), R].forEach((r, i) => {
        ctx.strokeStyle = i === 2 ? 'rgba(30,58,90,0.9)' : 'rgba(30,58,90,0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
    });
    // Cross hairs
    ctx.strokeStyle = 'rgba(30,58,90,0.4)';
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    ctx.moveTo(cx - R, cy);
    ctx.lineTo(cx + R, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy - R);
    ctx.lineTo(cx, cy + R);
    ctx.stroke();
    // Compass labels
    ctx.fillStyle = '#2a4050';
    ctx.font = '13px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('N', cx, cy - R - 8);
    ctx.fillText('S', cx, cy + R + 18);
    ctx.fillText('E', cx + R + 14, cy + 4);
    ctx.fillText('W', cx - R - 14, cy + 4);
    ctx.textAlign = 'left';
    // Scatter background satellites
    const rng = seededRng(params.satelliteName.length + Math.round(params.maxElevation));
    for (let i = 0; i < 12; i++) {
        const angle = rng() * Math.PI * 2;
        const dist = rng() * R * 0.85;
        const x = cx + dist * Math.cos(angle);
        const y = cy + dist * Math.sin(angle);
        ctx.fillStyle = 'rgba(0,180,255,0.35)';
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
    }
    // Featured satellite dot — positioned by actual elevation
    const elFrac = 1 - (params.maxElevation / 90);
    const satR = elFrac * R * 0.9;
    const satAng = -Math.PI / 4; // NW-ish arc for visual interest
    const sx = cx + satR * Math.cos(satAng);
    const sy = cy + satR * Math.sin(satAng);
    // Glow ring
    ctx.shadowColor = '#00ff88';
    ctx.shadowBlur = 24;
    ctx.fillStyle = 'rgba(0,255,136,0.15)';
    ctx.beginPath();
    ctx.arc(sx, sy, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    // Dot
    ctx.fillStyle = '#00ff88';
    ctx.beginPath();
    ctx.arc(sx, sy, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(sx, sy, 9, 0, Math.PI * 2);
    ctx.stroke();
    // Elevation label next to dot
    ctx.fillStyle = '#00ff88';
    ctx.font = 'bold 14px monospace';
    ctx.fillText(`${params.maxElevation.toFixed(0)}°`, sx + 14, sy - 6);
    // Observer dot at centre
    ctx.fillStyle = '#3b82f6';
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fill();
    // Bottom footer strip
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, height - 52, width, 52);
    // Footer accent line
    ctx.strokeStyle = 'rgba(0,212,255,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - 52);
    ctx.lineTo(width, height - 52);
    ctx.stroke();
    // Footer text
    ctx.fillStyle = '#3a5a70';
    ctx.font = '20px Arial';
    ctx.fillText('startrack-delta.vercel.app', 80, height - 18);
    // StarTrack logo on right
    ctx.fillStyle = '#00d4ff';
    ctx.font = 'bold 20px monospace';
    const logoText = 'STARTRACKᴬᴵ';
    const logoW = ctx.measureText(logoText).width;
    ctx.fillText(logoText, width - 80 - logoW, height - 18);
    return canvas.toBuffer('image/png');
}
function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}
function seededRng(seed) {
    let s = seed | 0;
    return () => {
        s = (Math.imul(1664525, s) + 1013904223) | 0;
        return (s >>> 0) / 0xffffffff;
    };
}
