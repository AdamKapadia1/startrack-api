"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NTFY_SUBSCRIBE_URL = void 0;
exports.setAlertConfig = setAlertConfig;
exports.getAlertConfig = getAlertConfig;
exports.checkAndNotify = checkAndNotify;
exports.getPassRecommendation = getPassRecommendation;
exports.sendDailyDigest = sendDailyDigest;
exports.analyzeHistoricalPatterns = analyzeHistoricalPatterns;
const axios_1 = __importDefault(require("axios"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const supabase_js_1 = require("@supabase/supabase-js");
const tleCache_js_1 = require("../utils/tleCache.js");
const passPredictor_js_1 = require("../utils/passPredictor.js");
const DEFAULT_OBS = { lat: 51.7957, lon: -0.6572, alt: 148 };
const MIN_PASS_EL = 30;
const NTFY_TOPIC = 'startrack-tring-alerts';
const NTFY_URL = `https://ntfy.sh/${NTFY_TOPIC}`;
const APP_URL = 'https://startrackv1-ui.vercel.app';
const DEFAULT_ALERT_CONFIG = {
    minElevation: 60,
    alertMinutesBefore: 10,
    enabled: true,
};
let alertConfig = { ...DEFAULT_ALERT_CONFIG };
const CONFIG_PATH = node_path_1.default.resolve(process.cwd(), 'data', 'alertSettings.json');
function loadAlertConfig() {
    try {
        const text = node_fs_1.default.readFileSync(CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(text);
        alertConfig = { ...DEFAULT_ALERT_CONFIG, ...parsed };
        console.log('[passAgent] alert config loaded:', alertConfig);
    }
    catch { /* use defaults on first run */ }
}
function persistAlertConfig() {
    try {
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(CONFIG_PATH), { recursive: true });
        node_fs_1.default.writeFileSync(CONFIG_PATH, JSON.stringify(alertConfig, null, 2), 'utf8');
    }
    catch (err) {
        console.error('[passAgent] failed to persist config:', err.message);
    }
}
loadAlertConfig();
function setAlertConfig(cfg) {
    alertConfig = { ...alertConfig, ...cfg };
    persistAlertConfig();
    return { ...alertConfig };
}
function getAlertConfig() {
    return { ...alertConfig };
}
function obsKey(obs) {
    return `${obs.lat.toFixed(4)},${obs.lon.toFixed(4)},${obs.alt}`;
}
// ── Helpers ───────────────────────────────────────────────────────────────────
function utcToLocal(utc) {
    return new Date(utc * 1000).toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/London',
    });
}
function utcToDate(utc) {
    return new Date(utc * 1000).toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'Europe/London',
    });
}
// Returns Unix seconds for London midnight on today+daysOffset, correctly handling BST/GMT.
// Uses sv-SE locale (YYYY-MM-DD) to avoid V8's ambiguous MM/DD/YYYY parsing of en-GB strings.
function londonDayStartSecs(daysOffset = 0) {
    const d = new Date(Date.now() + daysOffset * 86400000);
    const ymd = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/London' }).format(d); // "2026-06-12"
    const [y, m, day] = ymd.split('-').map(Number);
    const utcMidnightMs = Date.UTC(y, m - 1, day);
    // Ask London what hour UTC-midnight appears as (0 = GMT, 1 = BST)
    const londonHourAtUtcMidnight = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23' })
        .format(new Date(utcMidnightMs)));
    // London midnight = UTC midnight minus that offset
    return Math.floor((utcMidnightMs - londonHourAtUtcMidnight * 3600000) / 1000);
}
function groupPassesByDay(passes) {
    const nowSec = Math.floor(Date.now() / 1000);
    const todayStart = londonDayStartSecs(0);
    const tomorrowStart = londonDayStartSecs(1);
    const dayAfterStart = londonDayStartSecs(2);
    const weekEnd = londonDayStartSecs(7);
    const future = passes.filter(p => p.startUTC > nowSec);
    return {
        today: future.filter(p => p.startUTC >= todayStart && p.startUTC < tomorrowStart),
        tomorrow: future.filter(p => p.startUTC >= tomorrowStart && p.startUTC < dayAfterStart),
        thisWeek: future.filter(p => p.startUTC >= dayAfterStart && p.startUTC < weekEnd),
    };
}
// ── Pass cache (6-hour TTL, keyed by location, computed locally via SGP4) ────
const _passesCacheMap = new Map();
const PASSES_TTL_S = 6 * 60 * 60;
async function getAllStarlinkPasses(obs = DEFAULT_OBS) {
    const key = obsKey(obs);
    const now = Math.floor(Date.now() / 1000);
    const cached = _passesCacheMap.get(key);
    if (cached && (now - cached.fetchedAt) < PASSES_TTL_S)
        return cached.data;
    // Ensure TLE cache is warm, then sample evenly for orbital plane diversity
    await (0, tleCache_js_1.getActiveSatellites)(1);
    const allTles = (0, tleCache_js_1.getAllSatellites)();
    const stride = Math.max(1, Math.floor(allTles.length / 200));
    const tles = allTles.filter((_, i) => i % stride === 0);
    const altKm = obs.alt / 1000;
    console.log(`[passAgent] TLEs loaded: ${allTles.length}, sampled: ${tles.length} (stride ${stride})`);
    // 2-min step; cached 6 hours so first-request compute cost is acceptable
    const raw = (0, passPredictor_js_1.predictPasses)(tles, obs.lat, obs.lon, altKm, 7, 120, MIN_PASS_EL);
    // Convert PredictedPass → Pass (shapes are compatible; just assert type)
    const sorted = raw.sort((a, b) => b.maxEl - a.maxEl);
    // Only cache non-empty results; if 0 passes found, return without caching so next request retries
    if (sorted.length > 0) {
        _passesCacheMap.set(key, { data: sorted, fetchedAt: now });
    }
    console.log(`[passAgent] SGP4 computed ${sorted.length} passes for ${key} (7-day window, ${tles.length} sats)`);
    return sorted;
}
// ── ntfy.sh push notification ─────────────────────────────────────────────────
function passScore(maxEl) {
    return Math.round(40 + (maxEl / 90) * 60);
}
function qualityLabel(score) {
    if (score >= 85)
        return 'Excellent';
    if (score >= 70)
        return 'Good';
    if (score >= 50)
        return 'Fair';
    return 'Poor';
}
async function sendNtfy(pass, minutesAway) {
    const score = passScore(pass.maxEl);
    const quality = qualityLabel(score);
    const timeStr = utcToLocal(pass.startUTC);
    const durationM = Math.round((pass.duration ?? 600) / 60);
    const title = `StarTrack — Pass in ${minutesAway} minute${minutesAway === 1 ? '' : 's'}`;
    const body = `${pass.satname} reaches ${Math.round(pass.maxEl)}° at ${timeStr} BST. Signal score: ${score}/100. Duration: ~${durationM}m. Quality: ${quality}`;
    const priority = quality === 'Excellent' ? 'high' : 'default';
    const tags = quality === 'Excellent' ? 'satellite,starlink' : 'satellite';
    await axios_1.default.post(NTFY_URL, body, {
        headers: {
            'Title': title,
            'Priority': priority,
            'Tags': tags,
            'Click': APP_URL,
            'Content-Type': 'text/plain',
        },
        timeout: 10000,
    });
}
// ── Alert tracking (cleared every 24 h to allow re-alerting) ─────────────────
const notifiedPasses = new Set();
setInterval(() => {
    notifiedPasses.clear();
    console.log('[notifications] daily alert-tracking sets cleared');
}, 24 * 60 * 60 * 1000);
// ── Public: alert on imminent high-elevation passes ───────────────────────────
async function checkAndNotify() {
    if (!alertConfig.enabled)
        return { checked: 0, alerted: 0, alerts: [] };
    const passes = await getAllStarlinkPasses(DEFAULT_OBS);
    const now = Math.floor(Date.now() / 1000);
    const windowSecs = alertConfig.alertMinutesBefore * 60;
    const reminderSecs = 2 * 60;
    const alerts = [];
    for (const pass of passes) {
        if (pass.maxEl < alertConfig.minElevation)
            continue;
        if (pass.startUTC <= now)
            continue;
        const secsAway = pass.startUTC - now;
        const minutesAway = Math.max(1, Math.round(secsAway / 60));
        const initKey = `${pass.startUTC}`;
        const reminderKey = `${pass.startUTC}-r`;
        // Initial alert
        if (secsAway <= windowSecs && !notifiedPasses.has(initKey)) {
            notifiedPasses.add(initKey);
            try {
                await sendNtfy(pass, minutesAway);
                console.log(`[ntfy] initial alert: ${pass.satname} in ${minutesAway}min`);
            }
            catch (err) {
                console.error('[ntfy] push failed:', err.message);
            }
            alerts.push({ satname: pass.satname, maxEl: pass.maxEl, minutesAway, startUTC: pass.startUTC });
        }
        // 2-minute reminder (only after initial alert was already sent)
        if (secsAway <= reminderSecs &&
            notifiedPasses.has(initKey) &&
            !notifiedPasses.has(reminderKey)) {
            notifiedPasses.add(reminderKey);
            try {
                await sendNtfy(pass, minutesAway);
                console.log(`[ntfy] 2-min reminder: ${pass.satname}`);
            }
            catch (err) {
                console.error('[ntfy] reminder push failed:', err.message);
            }
            alerts.push({ satname: pass.satname, maxEl: pass.maxEl, minutesAway, startUTC: pass.startUTC });
        }
    }
    return { checked: passes.length, alerted: alerts.length, alerts };
}
async function getPassRecommendation(obs = DEFAULT_OBS, locationName = 'Tring, Hertfordshire', currentSatellites = []) {
    const allPasses = await getAllStarlinkPasses(obs);
    const now = Math.floor(Date.now() / 1000);
    const future = allPasses.filter(p => p.startUTC > now);
    const { today, tomorrow, thisWeek } = groupPassesByDay(future);
    const topPasses = future.slice(0, 10);
    const bestPass = future.length > 0
        ? future.reduce((best, p) => p.maxEl > best.maxEl ? p : best, future[0])
        : null;
    if (!topPasses.length) {
        // N2YO rate-limited or no passes — fall back to currently visible satellites
        if (currentSatellites.length > 0) {
            const satList = currentSatellites.slice(0, 5).map(s => {
                const d = s.dopplerShiftKHz != null
                    ? `, Doppler ${s.dopplerShiftKHz > 0 ? '+' : ''}${s.dopplerShiftKHz.toFixed(1)} kHz`
                    : '';
                return `${s.satname}: elevation ${s.elevation}°, azimuth ${s.azimuth}°, range ${s.range} km${d}`;
            }).join('\n');
            const bstFallbackNow = new Date().toLocaleString('en-GB', {
                timeZone: 'Europe/London', weekday: 'long', year: 'numeric',
                month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
            });
            const client = new sdk_1.default();
            const stream = client.messages.stream({
                model: 'claude-opus-4-8',
                max_tokens: 300,
                thinking: { type: 'adaptive' },
                messages: [{
                        role: 'user',
                        content: `You are a satellite connectivity assistant. Current date and time in UK (BST): ${bstFallbackNow}\n\nScheduled pass data is temporarily being computed. However, there are currently ${currentSatellites.length} Starlink satellites visible overhead from ${locationName}:\n\n${satList}\n\nWrite 2–3 sentences assessing current connectivity based on what is overhead right now. Focus on the highest-elevation satellite. Mention that scheduled pass data will be available shortly.`,
                    }],
            });
            const response = await stream.finalMessage();
            let recommendation = '';
            for (const block of response.content) {
                if (block.type === 'text') {
                    recommendation = block.text;
                    break;
                }
            }
            return {
                recommendation,
                satname: currentSatellites[0].satname,
                topPasses: [],
                today,
                tomorrow,
                thisWeek,
                bestPass: null,
            };
        }
        return {
            recommendation: `No Starlink passes found in the next 7 days over ${locationName}. N2YO pass data may be temporarily rate-limited — check back in a few minutes.`,
            satname: 'Starlink',
            topPasses: [],
            today,
            tomorrow,
            thisWeek,
            bestPass: null,
        };
    }
    const bstNow = new Date().toLocaleString('en-GB', {
        timeZone: 'Europe/London',
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
    const passDescriptions = topPasses
        .slice(0, 5)
        .map((p, i) => {
        const start = utcToLocal(p.startUTC);
        const peak = utcToLocal(p.maxUTC);
        const date = utcToDate(p.startUTC);
        return `Pass ${i + 1}: ${p.satname}, ${date} at ${start} BST, peaks ${peak} BST at ${p.maxEl.toFixed(1)}°, duration ${p.duration}s`;
    })
        .join('\n');
    const bestDesc = bestPass
        ? `Best pass of the week: ${bestPass.satname} on ${utcToDate(bestPass.startUTC)} at ${utcToLocal(bestPass.startUTC)} BST, peaking at ${bestPass.maxEl.toFixed(1)}°`
        : '';
    const client = new sdk_1.default();
    const stream = client.messages.stream({
        model: 'claude-opus-4-8',
        max_tokens: 300,
        thinking: { type: 'adaptive' },
        messages: [
            {
                role: 'user',
                content: `You are a satellite connectivity assistant tracking Starlink satellites over ${locationName}.\n\nCurrent date and time in UK (BST): ${bstNow}\n\nHere are the top upcoming passes over the next 7 days (all times in BST/Europe/London):\n\n${passDescriptions}\n\n${bestDesc}\n\nWrite a 2–3 sentence plain-English recommendation. Identify the single best connectivity window of the entire week — name the satellite, date, time in BST, and peak elevation. Mention what it is ideal for (video calls, IoT sync, etc.). Always refer to dates relative to today.`,
            },
        ],
    });
    const response = await stream.finalMessage();
    let recommendation = '';
    for (const block of response.content) {
        if (block.type === 'text') {
            recommendation = block.text;
            break;
        }
    }
    return {
        recommendation,
        satname: topPasses[0].satname,
        topPasses,
        today,
        tomorrow,
        thisWeek,
        bestPass,
    };
}
exports.NTFY_SUBSCRIBE_URL = NTFY_URL;
async function sendDailyDigest() {
    const now = Math.floor(Date.now() / 1000);
    const in24h = now + 24 * 60 * 60;
    const allPasses = await getAllStarlinkPasses(DEFAULT_OBS);
    const next24h = allPasses.filter(p => p.startUTC >= now && p.startUTC <= in24h);
    // Try ≥60° first, fall back to ≥40° if fewer than 3 qualify
    let top = next24h
        .filter(p => p.maxEl >= 60)
        .sort((a, b) => passScore(b.maxEl) - passScore(a.maxEl))
        .slice(0, 3);
    if (top.length < 3) {
        top = next24h
            .filter(p => p.maxEl >= 40)
            .sort((a, b) => passScore(b.maxEl) - passScore(a.maxEl))
            .slice(0, 3);
    }
    const dateStr = new Date().toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', timeZone: 'Europe/London',
    });
    const title = `☀️ StarTrack Daily Digest — ${dateStr}`;
    const lines = top.map((p, i) => {
        const quality = qualityLabel(passScore(p.maxEl));
        return `${i + 1}. ${p.satname} at ${utcToLocal(p.startUTC)} — ${Math.round(p.maxEl)}° (${quality})`;
    });
    const body = top.length > 0
        ? `Today's best connectivity windows:\n\n${lines.join('\n')}\n\nPlan your video calls and large transfers around these times.`
        : "No high-quality passes predicted for today. Signal conditions may be limited.";
    await axios_1.default.post(NTFY_URL, body, {
        headers: {
            'Title': title,
            'Priority': 'default',
            'Tags': 'sunrise,satellite',
            'Click': APP_URL,
            'Content-Type': 'text/plain',
        },
        timeout: 10000,
    });
    console.log(`[digest] sent: ${top.length} passes`);
    return { title, body, passCount: top.length, sent: true };
}
// ── Historical pattern analysis ───────────────────────────────────────────────
function _getSupabase() {
    const url = process.env.SUPABASE_URL ?? '';
    const key = process.env.SUPABASE_ANON_KEY ?? '';
    if (!url || !key)
        return null;
    return (0, supabase_js_1.createClient)(url, key);
}
function _fmtHour(h) {
    if (h === 0)
        return '12am';
    if (h === 12)
        return '12pm';
    return h < 12 ? `${h}am` : `${h - 12}pm`;
}
async function analyzeHistoricalPatterns() {
    const supabase = _getSupabase();
    if (!supabase) {
        console.warn('[patterns] Supabase not configured — missing env vars');
        return { available: false, message: 'Database not configured.', dataPoints: 0 };
    }
    // Log total row count for debugging
    const { count: totalCount } = await supabase
        .from('pass_predictions')
        .select('*', { count: 'exact', head: true });
    console.log('[patterns] total rows in pass_predictions:', totalCount);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
        .from('pass_predictions')
        .select('computed_at, signal_score, max_elevation')
        .gte('computed_at', sevenDaysAgo)
        .order('computed_at', { ascending: true });
    console.log('[patterns] 7-day query returned:', data?.length ?? 0, 'rows, error:', error?.message ?? 'none');
    if (error) {
        console.error('[patterns] Supabase query failed:', error.message, error);
        return { available: false, message: 'Could not query history.', dataPoints: 0 };
    }
    const rows = (data ?? []).filter(r => typeof r.signal_score === 'number');
    if (rows.length < 50) {
        return {
            available: false,
            message: 'Not enough historical data yet. Check back after a few more days of tracking.',
            dataPoints: rows.length,
        };
    }
    // Group scores by hour of day in Europe/London timezone
    const buckets = new Map();
    for (const row of rows) {
        const h = parseInt(new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23',
        }).format(new Date(row.computed_at)), 10);
        if (!buckets.has(h))
            buckets.set(h, []);
        buckets.get(h).push(row.signal_score);
    }
    const hourlyScores = Array.from({ length: 24 }, (_, h) => {
        const s = buckets.get(h) ?? [];
        return {
            hour: h,
            avgScore: s.length > 0 ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : 0,
        };
    });
    const ranked = [...hourlyScores].filter(x => x.avgScore > 0).sort((a, b) => b.avgScore - a.avgScore);
    const bestHours = ranked.slice(0, 3);
    const worstHours = ranked.slice(-3).reverse();
    // Overall trend: first half vs second half of collected data
    const half = Math.floor(rows.length / 2);
    const avgFirst = Math.round(rows.slice(0, half).reduce((a, r) => a + r.signal_score, 0) / half);
    const avgSecond = Math.round(rows.slice(half).reduce((a, r) => a + r.signal_score, 0) / (rows.length - half));
    const diff = avgSecond - avgFirst;
    const trendWord = diff > 3 ? 'improving' : diff < -3 ? 'declining' : 'stable';
    const trend = `${trendWord} (${avgFirst} → ${avgSecond})`;
    const bestStr = bestHours.map(b => `  ${_fmtHour(b.hour)}: ${b.avgScore}/100`).join('\n');
    const worstStr = worstHours.map(w => `  ${_fmtHour(w.hour)}: ${w.avgScore}/100`).join('\n');
    const prompt = `Based on 7 days of signal score data for Tring, Hertfordshire:

Best hours (average score):
${bestStr}

Worst hours (average score):
${worstStr}

Overall trend: ${trendWord} (first half avg: ${avgFirst}, second half avg: ${avgSecond})

Write a 2-3 sentence insight for the user about when they get the best connectivity, in a friendly, specific tone. Mention actual times. Example style: 'Your best connectivity is consistently between 10pm and 2am, likely due to favourable orbital geometry during those hours. Avoid scheduling important calls between 2pm-4pm when signal tends to be weakest.'`;
    const client = new sdk_1.default();
    const stream = client.messages.stream({
        model: 'claude-opus-4-8',
        max_tokens: 220,
        thinking: { type: 'adaptive' },
        messages: [{ role: 'user', content: prompt }],
    });
    const resp = await stream.finalMessage();
    let insight = '';
    for (const block of resp.content) {
        if (block.type === 'text') {
            insight = block.text;
            break;
        }
    }
    return { available: true, insight, bestHours, worstHours, trend, hourlyScores };
}
