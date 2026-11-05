import { matchForm } from './text.js';

/**
 * Period resolution in the business time zone (Asia/Tashkent, UTC+5, no DST). Intervals are [from, to_exclusive) in
 * LOCAL dates; SQL uses the matching UTC instants. «Kecha» = previous full local day; «o‘tgan hafta» = previous
 * Monday–Sunday; «oxirgi 7 kun» = today and the six days before, up to now. A date without a year = the year already
 * chosen in this conversation, else the nearest past occurrence (the full date is always shown back).
 */
export const TZ = 'Asia/Tashkent';
const OFFSET_MIN = 5 * 60;

export interface Period { from: string; to: string; label: string; kind: string; partial_today: boolean; future: boolean; startUtc?: string; endUtc?: string }

const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
/** Local calendar date (as a UTC-midnight Date) of an instant. */
export function localDay(now: Date): Date {
  const t = new Date(now.getTime() + OFFSET_MIN * 60_000);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
/** UTC instant where a local date starts: 2026-10-25 → 2026-10-24T19:00:00Z. */
export function localStartUtc(date: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) - OFFSET_MIN * 60_000);
}

const MONTHS: [RegExp, number][] = [
  [/^yanv|^yan$|^январ/, 1], [/^fev/, 2], [/^mart|^mar$/, 3], [/^apr/, 4], [/^may/, 5], [/^iyun|^iun/, 6], [/^iyul|^iul/, 7],
  [/^avg/, 8], [/^sent|^sen$/, 9], [/^okt/, 10], [/^noy/, 11], [/^dek/, 12],
];
const UZ_MONTH = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];
export const human = (date: string) => { const [y, m, d] = date.split('-').map(Number) as [number, number, number]; return `${d}-${UZ_MONTH[m - 1]} ${y}`; };

function monthOf(word: string): number | null {
  for (const [re, n] of MONTHS) if (re.test(word)) return n;
  return null;
}

function mk(from: Date, to: Date, label: string, kind: string, today: Date): Period {
  return { from: ymd(from), to: ymd(to), label, kind, partial_today: to.getTime() > today.getTime(), future: from.getTime() > today.getTime() };
}

/** Returns null when the text names no period (the caller then uses its own default). */
export function resolvePeriod(text: string, now: Date, ctxYear?: number | null): Period | null {
  const t = matchForm(text);
  const today = localDay(now);
  const tomorrow = addDays(today, 1);
  if (/\bbugun|segodnya/.test(t)) return mk(today, tomorrow, `Bugun (${human(ymd(today))}, hozirgacha)`, 'today', today);
  if (/\bkecha|vchera/.test(t)) { const y = addDays(today, -1); return mk(y, today, `Kecha (${human(ymd(y))})`, 'yesterday', today); }
  const dow = (today.getUTCDay() + 6) % 7; // Monday = 0
  const monday = addDays(today, -dow);
  if (/otgan hafta|proshl\w* nedel/.test(t)) return mk(addDays(monday, -7), monday, `O‘tgan hafta (${human(ymd(addDays(monday, -7)))} — ${human(ymd(addDays(monday, -1)))})`, 'last_week', today);
  if (/(bu|shu|joriy) hafta/.test(t)) return mk(monday, tomorrow, `Shu hafta (${human(ymd(monday))} dan hozirgacha)`, 'this_week', today);
  const lastN = /(oxirgi|oxirigi|songgi)\s+(\d{1,3})\s*kun/.exec(t) ?? (/(oxirgi|oxirigi|songgi) hafta/.test(t) ? [null, null, '7'] : /(oxirgi|oxirigi|songgi) (bir )?oy/.test(t) ? [null, null, '30'] : null);
  if (lastN) { const n = Math.min(366, Math.max(1, Number(lastN[2]))); const f = addDays(today, -(n - 1)); return mk(f, tomorrow, `Oxirgi ${n} kun (${human(ymd(f))} — bugun)`, `last_${n}d`, today); }
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  if (/otgan oy|proshl\w* mesyats/.test(t)) { const pm = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)); return mk(pm, monthStart, `O‘tgan oy (${UZ_MONTH[pm.getUTCMonth()]} ${pm.getUTCFullYear()})`, 'last_month', today); }
  if (/(bu|shu|joriy) oy/.test(t)) return mk(monthStart, tomorrow, `Shu oy (${UZ_MONTH[today.getUTCMonth()]}, hozirgacha)`, 'this_month', today);
  // ISO / dotted dates
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(t) ?? (() => { const m = /\b(\d{1,2})\.(\d{1,2})\.(20\d{2})\b/.exec(t); return m ? [m[0], m[3], m[2], m[1]] : null; })();
  if (iso) { const d = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))); if (!Number.isNaN(d.getTime())) return mk(d, addDays(d, 1), human(ymd(d)), 'day', today); }
  // «25 oktabr», «25-oktabr 2025», «oktabr 25»
  const dm = /\b(\d{1,2})\s*-?\s*([a-z]{3,})\b(?:\s*(20\d{2}))?/.exec(t);
  const md = dm && monthOf(dm[2]!) ? dm : null;
  if (md) {
    const day = Number(md[1]); const mon = monthOf(md[2]!)!;
    let year = md[3] ? Number(md[3]) : ctxYear ?? today.getUTCFullYear();
    let d = new Date(Date.UTC(year, mon - 1, day));
    if (!md[3] && !ctxYear && d.getTime() > today.getTime()) { year -= 1; d = new Date(Date.UTC(year, mon - 1, day)); }
    if (d.getUTCDate() === day) return mk(d, addDays(d, 1), human(ymd(d)), 'day', today);
  }
  // Month alone: «oktabrda», «oktabr oyida»
  for (const w of t.split(' ')) {
    const mon = monthOf(w);
    if (mon && /^[a-z]{3,}$/.test(w) && w.length >= 4) {
      let year = ctxYear ?? today.getUTCFullYear();
      if (!ctxYear && new Date(Date.UTC(year, mon - 1, 1)).getTime() > today.getTime()) year -= 1;
      const f = new Date(Date.UTC(year, mon - 1, 1)); const e = new Date(Date.UTC(year, mon, 1));
      return mk(f, e.getTime() > tomorrow.getTime() ? tomorrow : e, `${UZ_MONTH[mon - 1]} ${year}`, 'month', today);
    }
  }
  if (/otgan yil|proshl\w* god/.test(t)) { const y = today.getUTCFullYear() - 1; return mk(new Date(Date.UTC(y, 0, 1)), new Date(Date.UTC(y + 1, 0, 1)), `${y}-yil`, 'year', today); }
  const yr = /\b(20\d{2})\s*-?\s*yil/.exec(t);
  if (yr) { const y = Number(yr[1]); const e = new Date(Date.UTC(y + 1, 0, 1)); return mk(new Date(Date.UTC(y, 0, 1)), e.getTime() > tomorrow.getTime() ? tomorrow : e, `${y}-yil`, 'year', today); }
  if (/(bu|shu|joriy) yil|yil davomida|shu yili/.test(t)) { const y = today.getUTCFullYear(); return mk(new Date(Date.UTC(y, 0, 1)), tomorrow, `${y}-yil (hozirgacha)`, 'year', today); }
  return null;
}

export function todayPeriod(now: Date): Period {
  const today = localDay(now);
  return mk(today, addDays(today, 1), `Bugun (${human(ymd(today))}, hozirgacha)`, 'today', today);
}
export function lastDays(now: Date, n: number): Period {
  const today = localDay(now); const f = addDays(today, -(n - 1));
  return mk(f, addDays(today, 1), `Oxirgi ${n} kun (${human(ymd(f))} — bugun)`, `last_${n}d`, today);
}
/** Validate an explicit (tool-call) period: from < to, at most 366 days. */
export function explicitPeriod(from: string, to: string, now: Date): Period | null {
  const f = localStartUtc(from), e = localStartUtc(to);
  if (Number.isNaN(f.getTime()) || Number.isNaN(e.getTime()) || e <= f || e.getTime() - f.getTime() > 366 * 86_400_000) return null;
  const today = localDay(now);
  const last = new Date(Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10))) - 86_400_000);
  const label = from === ymd(last) ? human(from) : `${human(from)} — ${human(ymd(last))}`;
  return mk(new Date(Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)))), new Date(last.getTime() + 86_400_000), label, 'custom', today);
}

/**
 * Baseline for «solishtir»: the period of equal length right before. When the current period is still running, only the
 * same elapsed part of the previous one is used (half of today is never compared with all of yesterday).
 */
export function previousPeriod(p: Period, now: Date): Period {
  const start = localStartUtc(p.from).getTime();
  const end = localStartUtc(p.to).getTime();
  const len = end - start;
  const pStart = new Date(start - len);
  const elapsed = p.partial_today ? Math.max(0, Math.min(len, now.getTime() - start)) : len;
  const pEnd = new Date(pStart.getTime() + elapsed);
  const from = ymd(new Date(pStart.getTime() + OFFSET_MIN * 60_000));
  const to = ymd(new Date(start + OFFSET_MIN * 60_000));
  const days = Math.round(len / 86_400_000);
  const label = days === 1 ? human(from) : `${human(from)} — ${human(ymd(new Date(start + OFFSET_MIN * 60_000 - 86_400_000)))}`;
  return { from, to, label: p.partial_today ? `${label} (xuddi shu vaqtgacha)` : label, kind: 'previous', partial_today: false, future: false, startUtc: pStart.toISOString(), endUtc: pEnd.toISOString() };
}
