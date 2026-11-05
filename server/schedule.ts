import type { Settings } from './types.js';

export type Schedule = Pick<Settings, 'checkEveryHours' | 'checkStartTime' | 'checkTimezone'>;
export function validTimezone(zone: string) { try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; } }
export function scheduleSignature(config: Schedule) { return JSON.stringify([config.checkEveryHours, config.checkStartTime, config.checkTimezone]); }

// Work in civil clock time, then resolve each slot to an instant. Choosing the
// earliest matching instant runs repeated DST times once; no match skips gaps.
export function nextScheduledCheck(config: Schedule, after = Date.now()): number {
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: config.checkTimezone, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const civil = (instant: number) => {
    const p = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, Number(part.value)]));
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  };
  const local = new Date(civil(after));
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const [hour, minute] = config.checkStartTime.split(':').map(Number);
  const candidates: number[] = [];
  for (let day = -1; day <= 3; day++) {
    const anchor = midnight + day * 86400_000 + (hour * 60 + minute) * 60_000;
    const offsets = new Set([-36, -12, 0, 12, 36].map(h => { const sample = anchor + h * 3600_000; return civil(sample) - sample; }));
    for (let h = 0; h < 24; h += config.checkEveryHours) {
      const wall = anchor + h * 3600_000;
      const matches = [...offsets].map(offset => wall - offset).filter(instant => civil(instant) === wall);
      const instant = Math.min(...matches);
      if (Number.isFinite(instant) && instant > after) candidates.push(instant);
    }
  }
  if (!candidates.length) throw new Error('Could not calculate the next scheduled check.');
  return Math.min(...candidates);
}
