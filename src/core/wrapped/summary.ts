/** Pure helpers behind Wrapped's numbers (unit tested in wrapped.test.ts). */

export type Streak = { days: number; start: string; end: string };

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

/** Longest run of consecutive "YYYY-MM-DD" days. Input order and duplicates don't matter. */
export function longestStreak(dates: Iterable<string>): Streak | null {
  const days = [...new Set(dates)].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (days.length === 0) return null;
  let best: Streak = { days: 1, start: days[0]!, end: days[0]! };
  let runStart = days[0]!;
  let runLength = 1;
  for (let i = 1; i < days.length; i++) {
    if (dayNumber(days[i]!) - dayNumber(days[i - 1]!) === 1) {
      runLength += 1;
    } else {
      runStart = days[i]!;
      runLength = 1;
    }
    if (runLength > best.days) best = { days: runLength, start: runStart, end: days[i]! };
  }
  return best;
}

/** Totals per calendar month (index 0 = January) from per-day rows. */
export function monthlyTotals(rows: Iterable<{ date: string; value: number }>): number[] {
  const months = new Array(12).fill(0) as number[];
  for (const row of rows) {
    const month = Number(row.date.slice(5, 7)) - 1;
    if (month >= 0 && month < 12) months[month]! += row.value;
  }
  return months;
}

/** Totals per weekday, Monday first (index 0 = Monday, 6 = Sunday), from per-day rows (UTC dates). */
export function weekdayTotals(rows: Iterable<{ date: string; value: number }>): number[] {
  const days = new Array(7).fill(0) as number[];
  for (const row of rows) {
    const weekday = new Date(`${row.date}T00:00:00Z`).getUTCDay();
    if (Number.isNaN(weekday)) continue;
    days[(weekday + 6) % 7]! += row.value;
  }
  return days;
}

/** The biggest single day, earliest first on a tie. */
export function busiestDay(rows: Iterable<{ date: string; value: number }>): { date: string; value: number } | null {
  let best: { date: string; value: number } | null = null;
  for (const row of rows) {
    if (row.value <= 0) continue;
    if (!best || row.value > best.value || (row.value === best.value && row.date < best.date)) best = { date: row.date, value: row.value };
  }
  return best;
}

/**
 * "Top X%" among everyone with any messages that year: 1 + people strictly ahead, over everyone,
 * rounded up to a whole percent (never 0). Null when the pool is too small to say anything.
 */
export function topPercent(allTotals: readonly number[], mine: number, minPool = 5): number | null {
  if (mine <= 0 || allTotals.length < minPool) return null;
  let ahead = 0;
  for (const value of allTotals) if (value > mine) ahead += 1;
  return Math.max(1, Math.ceil(((ahead + 1) / allTotals.length) * 100));
}

/** Share of a total as a whole percent (0 when there's no total). */
export function sharePercent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

/**
 * The year as one character per day ("0" to "4"), 1 January first: 0 is no messages, 1 to 4 are
 * quartiles of the person's own active days. Drawn as the year grid on the Messages slide.
 */
export function yearHeatmap(year: number, rows: Iterable<{ date: string; value: number }>): string {
  const start = Date.UTC(year, 0, 1);
  const days = Math.round((Date.UTC(year + 1, 0, 1) - start) / DAY_MS);
  const values = new Array(days).fill(0) as number[];
  for (const row of rows) {
    const index = Math.round((Date.parse(`${row.date}T00:00:00Z`) - start) / DAY_MS);
    if (index >= 0 && index < days) values[index]! += row.value;
  }
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return "0".repeat(days);
  const cut = (q: number) => sorted[Math.floor(q * (sorted.length - 1))]!;
  const [q1, q2, q3] = [cut(0.25), cut(0.5), cut(0.75)];
  return values.map((v) => (v <= 0 ? "0" : v <= q1 ? "1" : v <= q2 ? "2" : v <= q3 ? "3" : "4")).join("");
}

/** The Monday-to-Sunday week (UTC) with the most activity: its Monday and total. */
export function busiestWeek(rows: Iterable<{ date: string; value: number }>): { start: string; value: number } | null {
  const weeks = new Map<number, number>();
  for (const row of rows) {
    if (row.value <= 0) continue;
    const day = dayNumber(row.date);
    const weekday = (new Date(`${row.date}T00:00:00Z`).getUTCDay() + 6) % 7;
    const monday = day - weekday;
    weeks.set(monday, (weeks.get(monday) ?? 0) + row.value);
  }
  let best: { start: number; value: number } | null = null;
  for (const [start, value] of weeks) if (!best || value > best.value || (value === best.value && start < best.start)) best = { start, value };
  return best ? { start: new Date(best.start * DAY_MS).toISOString().slice(0, 10), value: best.value } : null;
}

/** Longest run of days with no activity between two active days, and the day they came back. */
export function longestGap(dates: Iterable<string>): { days: number; comeback: string } | null {
  const days = [...new Set(dates)].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  let best: { days: number; comeback: string } | null = null;
  for (let i = 1; i < days.length; i++) {
    const gap = dayNumber(days[i]!) - dayNumber(days[i - 1]!) - 1;
    if (gap > 0 && (!best || gap > best.days)) best = { days: gap, comeback: days[i]! };
  }
  return best;
}

/** Share of activity on Saturdays and Sundays, as a whole percent. */
export function weekendShare(rows: Iterable<{ date: string; value: number }>): number {
  let weekend = 0;
  let total = 0;
  for (const row of rows) {
    const weekday = new Date(`${row.date}T00:00:00Z`).getUTCDay();
    total += row.value;
    if (weekday === 0 || weekday === 6) weekend += row.value;
  }
  return sharePercent(weekend, total);
}

/** The quietest month that still had some activity, between the first and last active months. */
export function quietestMonth(months: readonly number[]): { month: number; value: number } | null {
  const active = months.map((value, month) => ({ month, value })).filter((m) => m.value > 0);
  if (active.length < 2) return null;
  return active.reduce((low, m) => (m.value < low.value ? m : low));
}

export type ArchetypeInput = {
  messages: number;
  activeDays: number;
  voiceHours: number;
  nightShare: number; // 0-1, share of messages between 23:00 and 04:59 UTC-ish
  servers: number;
  cards: number;
  musicPlays: number;
  emoji: number;
  community: number; // quizzes + giveaways + starboard + suggestions + invites
  longestStreak: number;
  topShare: number; // % of messages in the home server
};

export type Archetype = { key: string; label: string; line: string };

const ARCHETYPES: Record<string, Omit<Archetype, "key">> = {
  voice: { label: "The Voice of the Server", line: "Why type it when you can say it. Your servers know your voice better than your handwriting." },
  night: { label: "The Night Shift", line: "When everyone else logs off, you settle in. The quiet hours are yours." },
  collector: { label: "The Collector", line: "Cards, badges, a full Hangar. If it can be collected, you've probably got two." },
  dj: { label: "The Resident DJ", line: "The queue was rarely empty when you were around. Good taste, mostly." },
  socialite: { label: "The Socialite", line: "Server to server, never in one place for long, welcome in all of them." },
  regular: { label: "The Regular", line: "Day in, day out. The kind of presence a server is built around." },
  local: { label: "The Local Legend", line: "One server, total commitment. They'd notice if you were gone." },
  joiner: { label: "The Joiner-Inner", line: "Quizzes, giveaways, starboards. If something was happening, you were in it." },
  expressive: { label: "The Emoji Poet", line: "Why use a sentence when one small picture says it better." },
  quiet: { label: "The Quiet Achiever", line: "Not the loudest in the room, but always there when it counts." },
};

/** An overall "Dreamliner personality" from the mix of what someone did. Scores each style
 *  relative to a typical year and picks the strongest; quiet years get The Quiet Achiever. */
export function pickArchetype(input: ArchetypeInput): Archetype {
  const scores: Array<[string, number]> = [
    ["voice", input.voiceHours / 20 + (input.voiceHours * 60 > input.messages ? 0.5 : 0)],
    ["night", input.messages >= 200 ? input.nightShare * 3.2 : 0],
    ["collector", input.cards / 40],
    ["dj", input.musicPlays / 60],
    ["socialite", input.servers >= 4 ? input.servers / 5 : 0],
    ["regular", input.activeDays / 90 + input.longestStreak / 40],
    ["local", input.messages >= 500 && input.topShare >= 85 ? 1.05 : 0],
    ["joiner", input.community / 10],
    ["expressive", input.messages > 0 ? (input.emoji / Math.max(1, input.messages)) * 4 : 0],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  const [key, score] = scores[0]!;
  const chosen = score >= 0.8 ? key : "quiet";
  return { key: chosen, ...ARCHETYPES[chosen]! };
}

/** "Your year in three words", built from the numbers (never from message content). */
export function yearInWords(input: ArchetypeInput): string[] {
  const words: Array<[string, number]> = [
    ["Chatty", input.messages / 3000],
    ["Loyal", input.topShare >= 70 ? input.topShare / 80 : 0],
    ["Consistent", input.longestStreak / 21],
    ["Nocturnal", input.nightShare * 3],
    ["Talkative", input.voiceHours / 15],
    ["Curious", input.servers / 6],
    ["Collected", input.cards / 30],
    ["Musical", input.musicPlays / 40],
    ["Expressive", input.messages > 0 ? (input.emoji / input.messages) * 5 : 0],
    ["Sociable", input.community / 8],
    ["Present", input.activeDays / 80],
  ];
  const picked = words.filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w);
  for (const filler of ["Steady", "Kind", "Here"]) if (picked.length < 3 && !picked.includes(filler)) picked.push(filler);
  return picked;
}
