// Number and UK-time formatting. Every timestamp from the API is UTC ISO-8601;
// everything shown to the user is Europe/London with an explicit GMT/BST label.

const TZ = "Europe/London";

const nf0 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nfK = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });

type Num = number | null | undefined;

export const fmt0 = (v: Num) => (v == null ? "–" : nf0.format(v));
export const mw = (v: Num) => (v == null ? "–" : `${nf0.format(v)} MW`);
export const signed = (v: Num) => (v == null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${nf0.format(Math.abs(v))}`);
export const signedMw = (v: Num) => (v == null ? "–" : `${signed(v)} MW`);
export const gwh = (mwh: Num) => (mwh == null ? "–" : `${nf1.format(mwh / 1000)} GWh`);
export const gwhValue = (mwh: Num) => (mwh == null ? "–" : nf1.format(mwh / 1000));
export const pct = (v: Num) => (v == null ? "–" : `${nf1.format(v * 100)}%`);
export const signedPct = (v: Num) => {
  if (v == null || !Number.isFinite(v)) return "–";
  const text = nf1.format(Math.abs(v) * 100);
  if (text === "0.0") return "0.0%"; // no sign on values that round to zero
  return `${v > 0 ? "+" : "−"}${text}%`;
};

/** Round axis ticks from 0 to just above `max` (steps of 1, 2, 2.5 or 5 × 10^n). */
export function niceTicks(max: number, target = 5): number[] {
  if (!(max > 0)) return [0];
  const raw = max / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}
export const hours = (v: Num) => (v == null ? "–" : `${nf1.format(v)} h`);
export const compactMw = (v: number) => (Math.abs(v) >= 1000 ? `${nfK.format(v / 1000)}k` : nf0.format(v));
export const gw = (v: number) => nfK.format(v / 1000);

/** "1 h 50 min", "10 min", "26 h" */
export function duration(ms: number) {
  const mins = Math.round(Math.abs(ms) / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export const between = (fromIso: string, toIso: string) => new Date(toIso).getTime() - new Date(fromIso).getTime();
export const hoursBetween = (fromIso: string, toIso: string) => between(fromIso, toIso) / 3_600_000;

/** "GMT" or "BST" for the given instant. */
export function tzName(iso: string) {
  const part = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, timeZoneName: "short" })
    .formatToParts(new Date(iso))
    .find((p) => p.type === "timeZoneName")?.value;
  return part === "GMT+1" ? "BST" : (part ?? "UK");
}

export const ukTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });

/** "Wed 14 Jan 2026, 09:20 GMT" */
export const ukDateTime = (iso: string, withYear = true) =>
  `${new Date(iso).toLocaleDateString("en-GB", {
    timeZone: TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  })}, ${ukTime(iso)} ${tzName(iso)}`;

/** "14 Jan, 07:30" (compact, for tables) */
export const ukShortDateTime = (iso: string) =>
  `${new Date(iso).toLocaleDateString("en-GB", { timeZone: TZ, day: "numeric", month: "short" })}, ${ukTime(iso)}`;

const asNoon = (isoDate: string) => new Date(`${isoDate}T12:00:00Z`);

/** "Thu 15 Jan 2026" */
export const ukDate = (isoDate: string) =>
  asNoon(isoDate).toLocaleDateString("en-GB", {
    timeZone: TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/** "15 Jan" */
export const shortDate = (isoDate: string) =>
  asNoon(isoDate).toLocaleDateString("en-GB", { timeZone: TZ, day: "numeric", month: "short" });

export const addDays = (isoDate: string, n: number) => {
  const d = asNoon(isoDate);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
