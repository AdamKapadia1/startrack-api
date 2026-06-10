import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import notifier from 'node-notifier';

const N2YO_URL =
  'https://api.n2yo.com/rest/v1/satellite/radiopasses/25544/51.7957/-0.6572/148/1/40/&apiKey=GMVRQ4-MY5LN2-UZUBTB-5RSS';

export interface Pass {
  startUTC: number;
  maxUTC: number;
  endUTC: number;
  maxEl: number;
  startAz: number;
  maxAz: number;
  duration: number;
}

export interface PassRecommendation {
  recommendation: string;
  satname: string;
  topPasses: Pass[];
}

function utcToLocal(utc: number): string {
  return new Date(utc * 1000).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/London',
  });
}

// Tracks passes we've already notified about (keyed by startUTC) to avoid duplicates.
const notifiedPasses = new Set<number>();

export interface NotificationAlert {
  satname: string;
  maxEl: number;
  minutesAway: number;
  startUTC: number;
}

export interface NotificationCheckResult {
  checked: number;
  alerted: number;
  alerts: NotificationAlert[];
}

export async function checkAndNotify(): Promise<NotificationCheckResult> {
  const { data } = await axios.get(N2YO_URL, { timeout: 30000 });
  const satname: string = data.info?.satname ?? 'ISS';
  const passes: Pass[] = data.passes ?? [];
  const now = Math.floor(Date.now() / 1000);
  const windowEnd = now + 10 * 60;
  const alerts: NotificationAlert[] = [];

  for (const pass of passes) {
    if (
      pass.maxEl >= 60 &&
      pass.startUTC > now &&
      pass.startUTC <= windowEnd &&
      !notifiedPasses.has(pass.startUTC)
    ) {
      notifiedPasses.add(pass.startUTC);
      const minutesAway = Math.max(1, Math.round((pass.startUTC - now) / 60));
      const message = `StarTrack Alert: ${satname} passes at ${Math.round(pass.maxEl)} degrees in ${minutesAway} minutes. Good connectivity window.`;
      notifier.notify({ title: 'StarTrack', message, sound: true });
      alerts.push({ satname, maxEl: pass.maxEl, minutesAway, startUTC: pass.startUTC });
    }
  }

  return { checked: passes.length, alerted: alerts.length, alerts };
}

export async function getPassRecommendation(): Promise<PassRecommendation> {
  const { data } = await axios.get(N2YO_URL, { timeout: 30000 });

  const allPasses: Pass[] = data.passes ?? [];
  const topPasses = allPasses.slice(0, 5);

  const passDescriptions = topPasses
    .map((p, i) => {
      const start    = utcToLocal(p.startUTC);
      const peak     = utcToLocal(p.maxUTC);
      const duration = p.duration ?? (p.endUTC - p.startUTC);
      return `Pass ${i + 1}: starts ${start}, peak at ${peak} with max elevation ${p.maxEl}°, duration ${duration}s`;
    })
    .join('\n');

  const client = new Anthropic();

  const stream = client.messages.stream({
    model: 'claude-opus-4-8',
    max_tokens: 256,
    thinking: { type: 'adaptive' },
    messages: [
      {
        role: 'user',
        content: `You are a satellite connectivity advisor. Here are the next ISS/Starlink passes over Tring, UK:\n\n${passDescriptions}\n\nWrite a single, plain-English recommendation (2–3 sentences) identifying the best connectivity window and what it's ideal for. Be specific about the time and elevation.`,
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

  return { recommendation, satname: data.info?.satname ?? 'ISS', topPasses };
}
