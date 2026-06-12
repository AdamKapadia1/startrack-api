export interface SignalInput {
  elevation:  number; // degrees 0-90
  cloudCover: number; // percent 0-100
  windSpeed:  number; // m/s
  visibility: number; // metres
  range:      number; // km
  count?:     number; // satellites visible (optional, for count bonus)
}

export interface ScoreBreakdown {
  elevation:  number; // 0-40
  cloud:      number; // 0-20
  visibility: number; // 0-15
  wind:       number; // 0-10
  range:      number; // 0-5
}

export interface SignalScore {
  total:     number;
  breakdown: ScoreBreakdown;
}

export function scoreSignal(input: SignalInput): SignalScore {
  // Elevation: 40 pts max — full marks at 85°+, linear from 0°
  const elevScore = Math.max(0, Math.min(40, (input.elevation / 85) * 40));

  // Cloud cover: 20 pts max — 0%=20, 100%=0
  const cloudScore = Math.max(0, (1 - input.cloudCover / 100) * 20);

  // Visibility: 15 pts max — 10 km+ = 15, scales linearly
  const visScore = Math.min(15, (Math.min(input.visibility, 10_000) / 10_000) * 15);

  // Wind speed: 10 pts max — 0 m/s=10, 20+ m/s=0
  const windScore = Math.max(0, (1 - Math.min(input.windSpeed, 20) / 20) * 10);

  // Range: 5 pts max — 400 km=5, 1000 km+=0
  const rangeScore = Math.max(0, Math.min(5, ((1000 - Math.max(input.range, 400)) / 600) * 5));

  // Satellite count bonus: 0, 5, or 10 pts
  const count      = input.count ?? 0;
  const countBonus = count > 50 ? 10 : count > 10 ? 5 : 0;

  const breakdown: ScoreBreakdown = {
    elevation:  Math.round(elevScore  * 10) / 10,
    cloud:      Math.round(cloudScore * 10) / 10,
    visibility: Math.round(visScore   * 10) / 10,
    wind:       Math.round(windScore  * 10) / 10,
    range:      Math.round(rangeScore * 10) / 10,
  };

  let total = Math.round(elevScore + cloudScore + visScore + windScore + rangeScore + countBonus);

  // Heavy overcast cap: if cloud cover > 80% the score can't exceed 70
  if (input.cloudCover > 80) total = Math.min(total, 70);

  return { total: Math.min(100, total), breakdown };
}
