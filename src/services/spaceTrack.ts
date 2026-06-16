import axios from 'axios';

const SPACETRACK_BASE = 'https://www.space-track.org';
const MIN_REQUEST_GAP_MS = 2_000;

let sessionCookie: string | null = null;
let lastRequestTime = 0;

async function authenticate(): Promise<string> {
  const response = await axios.post(
    `${SPACETRACK_BASE}/ajaxauth/login`,
    new URLSearchParams({
      identity: process.env.SPACETRACK_USERNAME ?? '',
      password: process.env.SPACETRACK_PASSWORD ?? '',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
  );

  const rawCookie = response.headers['set-cookie']?.[0];
  if (!rawCookie) throw new Error('Space-Track authentication failed: no session cookie returned');
  // Strip cookie attributes (path, secure, etc.) — only the name=value pair is needed.
  return rawCookie.split(';')[0];
}

async function rateLimitedRequest(url: string): Promise<any> {
  const now     = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_REQUEST_GAP_MS) {
    await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_GAP_MS - elapsed));
  }
  lastRequestTime = Date.now();

  if (!sessionCookie) {
    sessionCookie = await authenticate();
  }

  try {
    const response = await axios.get(url, { headers: { Cookie: sessionCookie } });
    return response.data;
  } catch (err: any) {
    if (err.response?.status === 401) {
      sessionCookie = await authenticate();
      const retryResponse = await axios.get(url, { headers: { Cookie: sessionCookie } });
      return retryResponse.data;
    }
    throw err;
  }
}

export async function fetchSpaceTrackTLE(noradId: string): Promise<{ line1: string; line2: string } | null> {
  try {
    const url  = `${SPACETRACK_BASE}/basicspacedata/query/class/gp/NORAD_CAT_ID/${noradId}/orderby/EPOCH%20desc/limit/1/format/json`;
    const data = await rateLimitedRequest(url);

    if (!data || data.length === 0) return null;

    const sat = data[0];
    return { line1: sat.TLE_LINE1, line2: sat.TLE_LINE2 };
  } catch (err: any) {
    console.error('[spacetrack] fetch failed:', err.message);
    return null;
  }
}

// TLE epoch (cols 19-32, e.g. "24001.50000000") → ms since epoch.
function epochToMs(line1: string): number {
  const epochStr  = line1.substring(18, 32).trim();
  const yr2       = parseInt(epochStr.substring(0, 2), 10);
  const dayOfYear = parseFloat(epochStr.substring(2));
  const fullYear  = yr2 >= 57 ? 1900 + yr2 : 2000 + yr2;
  return Date.UTC(fullYear, 0, 1) + (dayOfYear - 1) * 86_400_000;
}

export async function validateAgainstSpaceTrack(noradId: string, celestrakTle: { line1: string; line2: string }): Promise<{
  matches: boolean;
  epochDifferenceHours: number;
  spaceTrackTle: { line1: string; line2: string } | null;
}> {
  const spaceTrackTle = await fetchSpaceTrackTLE(noradId);

  if (!spaceTrackTle) {
    return { matches: false, epochDifferenceHours: -1, spaceTrackTle: null };
  }

  const celestrakEpochMs  = epochToMs(celestrakTle.line1);
  const spaceTrackEpochMs = epochToMs(spaceTrackTle.line1);
  const epochDifferenceHours = Math.abs(celestrakEpochMs - spaceTrackEpochMs) / 3_600_000;

  return {
    matches: epochDifferenceHours < 0.01, // same epoch to within ~36s of rounding error
    epochDifferenceHours: parseFloat(epochDifferenceHours.toFixed(2)),
    spaceTrackTle,
  };
}
