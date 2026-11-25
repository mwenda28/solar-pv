"use client";
// Place this file at app/analyze/page.tsx  (route: /analyze)
import React, { useMemo, useState, useEffect, useRef } from "react";
import Papa, { ParseResult } from "papaparse";
import { Bar, Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";

ChartJS.register(CategoryScale, LinearScale, BarElement, PointElement, LineElement, Title, Tooltip, Legend);

/* ============================================================
   Solar performance engine
   Pure functions only (no React, no browser APIs), so the exact same
   code that runs in the page can be tested on its own.
   ============================================================ */

type EnergyMode = "daily" | "cumulative" | "power";
type DayRule = "max" | "sum" | "mean";
type DateOrder = "dmy" | "mdy";
type Confidence = "high" | "medium" | "low";

interface DailyPoint {
  date: string; // YYYY-MM-DD, wall-clock date as written in the file
  ts: number; // UTC midnight of that date, in ms
  kwh: number;
  samples: number;
  incomplete: boolean;
}

interface ImportOptions {
  mode: EnergyMode;
  unitFactor: number; // converts the file's unit to kWh (energy) or kW (power)
  dayRule: DayRule; // what to do when a date appears more than once (daily mode)
  order: DateOrder;
}

interface ImportReport {
  rowsRead: number;
  rowsUsed: number;
  badDates: number;
  badValues: number;
  negativeValues: number;
  repeatedDays: number;
  missingDays: string[];
  missingDayCount: number;
  incompleteDays: number;
  counterResets: number;
  firstDate: string;
  lastDate: string;
  notes: string[];
}

interface Thresholds {
  outageFrac: number; // a day below this share of the reference counts as no output
  spellFrac: number; // a run of days below this share is a low-output spell
  spellDays: number; // how many days in a row make a spell
  shiftFrac: number; // a sustained drop of at least this share is a level shift
  declinePerYear: number; // a yearly decline of at least this share is a declining trend
}

const DEFAULT_THRESHOLDS: Thresholds = {
  outageFrac: 0.05,
  spellFrac: 0.6,
  spellDays: 3,
  shiftFrac: 0.15,
  declinePerYear: 0.08,
};

interface SolarEvent {
  id: string;
  type: "outage" | "spell" | "shift" | "decline";
  start: string;
  end: string;
  days: number;
  confidence: Confidence;
  lossKwh: number;
  title: string;
  detail: string;
}

interface ScorePart {
  key: "availability" | "consistency" | "trend" | "design";
  label: string;
  score: number;
  weight: number;
  note: string;
}

interface AnalysisParams {
  kWp: number;
  tariff: number | null; // KSh per kWh
  designYield: number | null; // kWh per kWp per year, from the installer's design
  thresholds: Thresholds;
}

interface Analysis {
  ok: boolean;
  reason: string;
  n: number;
  firstDate: string;
  lastDate: string;
  totalKwh: number;
  meanDailyKwh: number;
  meanYield: number;
  medianYield: number;
  annualisedYield: number;
  capacityFactor: number;
  referenceYield: number;
  expectedRatio: number;
  bestDay: { date: string; kwh: number } | null;
  worstDay: { date: string; kwh: number } | null;
  dates: string[];
  yields: number[];
  ratios: number[];
  flags: ("outage" | "spell" | null)[];
  events: SolarEvent[];
  shift: { start: string; end: string; before: number; after: number; dropFrac: number; days: number; recovered: boolean } | null;
  trend: { annualFrac: number; p: number | null; weeks: number; slopePerWeek: number; intercept: number } | null;
  outageDays: number;
  spellDaysCount: number;
  uptime: number;
  loss: {
    outageKwh: number;
    shiftKwh: number;
    trendKwh: number;
    spellKwh: number;
    lowKwh: number;
    highKwh: number;
    lowKsh: number | null;
    highKsh: number | null;
    perYearLowKsh: number | null;
    perYearHighKsh: number | null;
  };
  score: number;
  level: "Healthy" | "Fair" | "Needs attention" | "Poor";
  parts: ScorePart[];
  monthly: { month: string; kwh: number; days: number }[];
  weekly: { label: string; ratio: number }[];
}

/* ---------- small helpers ---------- */

function percentile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

const DAY_MS = 86400000;

function build(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return NaN;
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  return new Date(t).getUTCMonth() === mo - 1 ? t : NaN;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Dates in a file are ambiguous ("03/04/2024"). If any first number is above
// 12 the file is day-first; if any second number is above 12 it is month-first.
// With no evidence either way, day-first is assumed, as is usual in Kenya.
function detectDateOrder(values: string[]): DateOrder {
  let firstOver12 = false;
  let secondOver12 = false;
  for (const raw of values.slice(0, 3000)) {
    const m = String(raw).trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
    if (!m) continue;
    if (Number(m[1]) > 12) firstOver12 = true;
    if (Number(m[2]) > 12) secondOver12 = true;
  }
  return secondOver12 && !firstOver12 ? "mdy" : "dmy";
}

// Returns milliseconds as if the written wall-clock time were UTC. Time zones
// are deliberately ignored: a day is the calendar day written in the file.
function parseTimestamp(raw: string, order: DateOrder = "dmy"): number {
  const s = String(raw ?? "").trim();
  if (!s) return NaN;
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  if (/^\d{13}$/.test(s)) return Number(s);
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 20000 && n < 80000) return Math.round((n - 25569) * DAY_MS);
  }
  const tail = "(?:[T\\s,]+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?";
  let m = s.match(new RegExp("^(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})" + tail));
  if (m) return build(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  m = s.match(new RegExp("^(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{4})" + tail));
  if (m) {
    const a = +m[1];
    const b = +m[2];
    const day = order === "dmy" ? a : b;
    const month = order === "dmy" ? b : a;
    return build(+m[3], month, day, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  }
  m = s.match(new RegExp("^(\\d{1,2})[\\s-]+([A-Za-z]{3,9})[\\s,-]+(\\d{4})" + tail));
  if (m) {
    const mo = MONTH_NAMES.indexOf(m[2].slice(0, 3).toLowerCase()) + 1;
    return mo > 0 ? build(+m[3], mo, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) : NaN;
  }
  m = s.match(new RegExp("^([A-Za-z]{3,9})\\s+(\\d{1,2}),?\\s+(\\d{4})" + tail));
  if (m) {
    const mo = MONTH_NAMES.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    return mo > 0 ? build(+m[3], mo, +m[2], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) : NaN;
  }
  return NaN;
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

// Reads "12.5", "1,234.5", "12,5", "12.5 kWh" and similar. Blank gives NaN.
function parseNumber(raw: string): number {
  const s = String(raw ?? "").trim();
  if (!s) return NaN;
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?/.test(s)) return parseFloat(s.replace(/,/g, ""));
  if (/^-?\d+,\d+$/.test(s)) return parseFloat(s.replace(",", "."));
  const m = s.match(/^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}

const UNIT_FACTORS: Record<string, number> = {
  kWh: 1,
  Wh: 0.001,
  MWh: 1000,
  kW: 1,
  W: 0.001,
  MW: 1000,
};

/* ---------- turning an export into one energy figure per day ---------- */

function toDailyEnergy(
  rows: string[][],
  dateIdx: number,
  valueIdx: number,
  opts: ImportOptions
): { days: DailyPoint[]; report: ImportReport } {
  const report: ImportReport = {
    rowsRead: rows.length,
    rowsUsed: 0,
    badDates: 0,
    badValues: 0,
    negativeValues: 0,
    repeatedDays: 0,
    missingDays: [],
    missingDayCount: 0,
    incompleteDays: 0,
    counterResets: 0,
    firstDate: "",
    lastDate: "",
    notes: [],
  };

  const pts: { ts: number; v: number }[] = [];
  for (const r of rows) {
    const ts = parseTimestamp(r[dateIdx], opts.order);
    if (isNaN(ts)) {
      report.badDates++;
      continue;
    }
    let v = parseNumber(r[valueIdx]);
    if (isNaN(v)) {
      report.badValues++;
      continue;
    }
    if (v < 0) {
      report.negativeValues++;
      if (opts.mode !== "power") continue; // a negative energy figure is not valid
      v = 0; // power below zero means the system was drawing, not generating
    }
    pts.push({ ts, v });
  }
  report.rowsUsed = pts.length;
  pts.sort((a, b) => a.ts - b.ts);

  const byDay = new Map<string, { ts: number; v: number }[]>();
  for (const p of pts) {
    const k = dayKey(p.ts);
    const arr = byDay.get(k);
    if (arr) arr.push(p);
    else byDay.set(k, [p]);
  }
  const keys = Array.from(byDay.keys()).sort();
  const dayTs = (k: string) => Date.parse(k + "T00:00:00Z");
  const days: DailyPoint[] = [];

  if (opts.mode === "daily") {
    for (const k of keys) {
      const list = byDay.get(k) as { ts: number; v: number }[];
      if (list.length > 1) report.repeatedDays++;
      const vals = list.map((p) => p.v);
      let v: number;
      if (opts.dayRule === "sum") v = vals.reduce((a, b) => a + b, 0);
      else if (opts.dayRule === "mean") v = vals.reduce((a, b) => a + b, 0) / vals.length;
      else v = Math.max(...vals);
      days.push({ date: k, ts: dayTs(k), kwh: v * opts.unitFactor, samples: list.length, incomplete: false });
    }
  } else if (opts.mode === "cumulative") {
    const last: { k: string; v: number }[] = keys.map((k) => {
      const list = byDay.get(k) as { ts: number; v: number }[];
      return { k, v: list[list.length - 1].v };
    });
    for (let i = 1; i < last.length; i++) {
      const gap = Math.round((dayTs(last[i].k) - dayTs(last[i - 1].k)) / DAY_MS);
      if (gap !== 1) continue; // energy across a gap can't be split fairly between days
      const diff = last[i].v - last[i - 1].v;
      if (diff < 0) {
        report.counterResets++;
        continue;
      }
      days.push({ date: last[i].k, ts: dayTs(last[i].k), kwh: diff * opts.unitFactor, samples: 1, incomplete: false });
    }
    if (report.counterResets > 0) report.notes.push(`${report.counterResets} day(s) skipped because the running total went down (counter reset).`);
  } else {
    const steps: number[] = [];
    for (const k of keys) {
      const list = byDay.get(k) as { ts: number; v: number }[];
      for (let i = 1; i < list.length; i++) {
        const d = list[i].ts - list[i - 1].ts;
        if (d > 0) steps.push(d);
      }
    }
    const step = clamp(steps.length ? median(steps) : 3600000, 60000, 6 * 3600000);
    const counts: number[] = [];
    const raw: { k: string; kwh: number; n: number }[] = [];
    for (const k of keys) {
      const list = byDay.get(k) as { ts: number; v: number }[];
      let kwh = 0;
      for (let i = 0; i < list.length; i++) {
        const next = i < list.length - 1 ? list[i + 1].ts - list[i].ts : step;
        const dt = next <= 0 ? step : Math.min(next, 3 * step);
        kwh += list[i].v * opts.unitFactor * (dt / 3600000);
      }
      raw.push({ k, kwh, n: list.length });
      counts.push(list.length);
    }
    const typical = median(counts);
    for (const r of raw) {
      const incomplete = r.n < 0.6 * typical;
      if (incomplete) report.incompleteDays++;
      days.push({ date: r.k, ts: dayTs(r.k), kwh: r.kwh, samples: r.n, incomplete });
    }
    if (report.incompleteDays > 0) report.notes.push(`${report.incompleteDays} day(s) have far fewer readings than usual and are left out of the checks.`);
  }

  if (days.length > 0) {
    report.firstDate = days[0].date;
    report.lastDate = days[days.length - 1].date;
    const have = new Set(days.map((d) => d.date));
    const missing: string[] = [];
    for (let t = days[0].ts; t <= days[days.length - 1].ts; t += DAY_MS) {
      const k = dayKey(t);
      if (!have.has(k)) missing.push(k);
    }
    report.missingDayCount = missing.length;
    report.missingDays = missing.slice(0, 60);
  }
  return { days, report };
}

/* ---------- the assessment ---------- */

function emptyAnalysis(reason: string): Analysis {
  return {
    ok: false,
    reason,
    n: 0,
    firstDate: "",
    lastDate: "",
    totalKwh: 0,
    meanDailyKwh: 0,
    meanYield: 0,
    medianYield: 0,
    annualisedYield: 0,
    capacityFactor: 0,
    referenceYield: 0,
    expectedRatio: 0,
    bestDay: null,
    worstDay: null,
    dates: [],
    yields: [],
    ratios: [],
    flags: [],
    events: [],
    shift: null,
    trend: null,
    outageDays: 0,
    spellDaysCount: 0,
    uptime: 1,
    loss: {
      outageKwh: 0,
      shiftKwh: 0,
      trendKwh: 0,
      spellKwh: 0,
      lowKwh: 0,
      highKwh: 0,
      lowKsh: null,
      highKsh: null,
      perYearLowKsh: null,
      perYearHighKsh: null,
    },
    score: 0,
    level: "Poor",
    parts: [],
    monthly: [],
    weekly: [],
  };
}

function linearFit(xs: number[], ys: number[]): { slope: number; intercept: number; r: number } | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const r = syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
  return { slope, intercept: my - slope * mx, r };
}

// Two-tailed p-value for a correlation r over n points (t-test, normal
// approximation to the t distribution is avoided: uses the exact incomplete beta).
function logGamma(x: number): number {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    y += 1;
    ser += cof[j] / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(x: number, a: number, b: number): number {
  const FPMIN = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-9) break;
  }
  return h;
}

function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(x, a, b)) / a : 1 - (bt * betacf(1 - x, b, a)) / b;
}

function correlationP(r: number, n: number): number | null {
  const df = n - 2;
  if (df <= 0) return null;
  const rr = clamp(r, -0.999999, 0.999999);
  const t = rr * Math.sqrt(df / (1 - rr * rr));
  return incompleteBeta(df / (df + t * t), df / 2, 0.5);
}

function runsOf(flags: boolean[], dates: string[]): { start: number; end: number }[] {
  // runs of consecutive true values that are also consecutive calendar days
  const out: { start: number; end: number }[] = [];
  let i = 0;
  while (i < flags.length) {
    if (!flags[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < flags.length && flags[j + 1] && Date.parse(dates[j + 1]) - Date.parse(dates[j]) === DAY_MS) j++;
    out.push({ start: i, end: j });
    i = j + 1;
  }
  return out;
}

function analyseSystem(allDays: DailyPoint[], params: AnalysisParams): Analysis {
  const th = params.thresholds;
  if (!(params.kWp > 0)) return emptyAnalysis("Enter the installed system size in kWp to continue.");
  const days = allDays.filter((d) => !d.incomplete);
  if (days.length < 14) return emptyAnalysis("At least 14 days of data are needed to judge performance.");

  const kWp = params.kWp;
  const n = days.length;
  const dates = days.map((d) => d.date);
  const yields = days.map((d) => d.kwh / kWp);
  const reference = percentile(yields, 0.9);
  if (!(reference > 0)) return emptyAnalysis("The file shows no energy at all, so there is nothing to assess.");
  const ratios = yields.map((y) => y / reference);

  const outageMask = ratios.map((r) => r < th.outageFrac);
  const lowMask = ratios.map((r) => r >= th.outageFrac && r < th.spellFrac);
  const normalRatios = ratios.filter((r) => r >= th.spellFrac);
  const expectedRatio = normalRatios.length > 0 ? median(normalRatios) : 0.8;

  const events: SolarEvent[] = [];
  const flags: ("outage" | "spell" | null)[] = new Array(n).fill(null);
  let outageKwh = 0;
  let spellKwh = 0;

  // 1. no output
  runsOf(outageMask, dates).forEach((run, idx) => {
    const len = run.end - run.start + 1;
    let loss = 0;
    for (let i = run.start; i <= run.end; i++) {
      flags[i] = "outage";
      loss += kWp * Math.max(0, expectedRatio * reference - yields[i]);
    }
    outageKwh += loss;
    events.push({
      id: `outage-${idx + 1}`,
      type: "outage",
      start: dates[run.start],
      end: dates[run.end],
      days: len,
      confidence: "high",
      lossKwh: loss,
      title: len === 1 ? "No output for a day" : `No output for ${len} days in a row`,
      detail: `Output was close to zero while the system normally produces. This points to an outage, a trip, or a fault, not weather.`,
    });
  });

  // 2. several poor days in a row
  runsOf(lowMask, dates).forEach((run, idx) => {
    const len = run.end - run.start + 1;
    if (len < th.spellDays) return;
    let loss = 0;
    for (let i = run.start; i <= run.end; i++) {
      flags[i] = "spell";
      loss += kWp * Math.max(0, expectedRatio * reference - yields[i]);
    }
    const confidence: Confidence = len >= 14 ? "high" : len >= 7 ? "medium" : "low";
    events.push({
      id: `spell-${idx + 1}`,
      type: "spell",
      start: dates[run.start],
      end: dates[run.end],
      days: len,
      confidence,
      lossKwh: loss,
      title: `Low output for ${len} days in a row`,
      detail:
        confidence === "low"
          ? "A short spell like this is often just cloudy weather. Without sunlight data it cannot be told apart from a fault."
          : "A spell this long is less likely to be weather alone. Worth checking the inverter log and the panels.",
    });
  });

  // 3. a sustained step down in the clear-day level.
  // Clouds lower a typical day but clear days still happen, so the upper end
  // of the daily ratios barely moves with weather. A fault lowers that ceiling
  // for good. Comparing the ceiling before and after is therefore a far better
  // fault signal than comparing typical days, which swing with the weather.
  const CEIL = 0.8;
  const MINSEG = 28;
  let shift: Analysis["shift"] = null;
  let shiftKwh = 0;
  const usable: number[] = [];
  ratios.forEach((r, i) => {
    if (!outageMask[i]) usable.push(i);
  });
  if (usable.length >= 2 * MINSEG) {
    const rv = usable.map((i) => ratios[i]);
    let best = { k: -1, drop: 0 };
    for (let k = MINSEG; k <= rv.length - MINSEG; k++) {
      const w = Math.min(90, k, rv.length - k);
      const b0 = percentile(rv.slice(k - w, k), CEIL);
      const a0 = percentile(rv.slice(k, k + w), CEIL);
      const drop = b0 > 0 ? (b0 - a0) / b0 : 0;
      if (drop > best.drop) best = { k, drop };
    }
    if (best.k >= 0 && best.drop >= th.shiftFrac) {
      // locate the step date: best single step across the series near the candidate
      const pre: number[] = [0];
      const pre2: number[] = [0];
      rv.forEach((v) => {
        pre.push(pre[pre.length - 1] + v);
        pre2.push(pre2[pre2.length - 1] + v * v);
      });
      const total = rv.length;
      let kk = best.k;
      let bestSse = Infinity;
      const lo = Math.max(MINSEG, best.k - 45);
      const hi = Math.min(total - MINSEG, best.k + 45);
      for (let j = lo; j <= hi; j++) {
        const sL = pre[j];
        const sR = pre[total] - pre[j];
        const sse = pre2[j] - (sL * sL) / j + (pre2[total] - pre2[j]) - (sR * sR) / (total - j);
        if (sse < bestSse) {
          bestSse = sse;
          kk = j;
        }
      }
      const before = percentile(rv.slice(Math.max(0, kk - 120), kk), CEIL);
      let endPos = total; // exclusive
      let recovered = false;
      for (let j = kk + MINSEG; j <= total - 14; j++) {
        if (percentile(rv.slice(j, j + 21), CEIL) >= before * (1 - th.shiftFrac / 2)) {
          endPos = j;
          recovered = true;
          break;
        }
      }
      const after = percentile(rv.slice(kk, Math.min(endPos, kk + 120)), CEIL);
      const dropFrac = before > 0 ? (before - after) / before : 0;
      if (dropFrac >= th.shiftFrac * 0.75) {
        const startIdx = usable[kk];
        const endIdx = recovered ? usable[endPos] - 1 : n - 1;
        shift = {
          start: dates[startIdx],
          end: dates[endIdx],
          before,
          after,
          dropFrac,
          days: endIdx - startIdx + 1,
          recovered,
        };
        // If the output was lower by this share, what was lost is the actual output scaled up.
        const k2 = dropFrac / (1 - dropFrac);
        for (const i of usable) {
          if (i >= startIdx && i <= endIdx) shiftKwh += days[i].kwh * k2;
        }
        events.push({
          id: "shift-1",
          type: "shift",
          start: shift.start,
          end: shift.end,
          days: shift.days,
          confidence: dropFrac >= 2 * th.shiftFrac ? "high" : "medium",
          lossKwh: shiftKwh,
          title: `Output stepped down by about ${Math.round(dropFrac * 100)}%`,
          detail:
            (recovered
              ? "The best days fell and later came back. Something changed for a while, such as shading, dirt or part of the array going offline, and then was fixed or cleared."
              : "The best days have been lower ever since. A lasting step like this often means part of the array or an inverter input stopped working, or something now shades the panels.") +
            (n < 365 ? " With under a year of data, the change of seasons can add to or hide part of this, so treat the size as approximate." : ""),
        });
      }
    }
  }

  // 4. slow decline across the whole file, using weekly clear-day levels to cancel out weather
  let trend: Analysis["trend"] = null;
  const weekly: { label: string; ratio: number }[] = [];
  {
    const t0 = Date.parse(dates[0]);
    const buckets = new Map<number, number[]>();
    ratios.forEach((r, i) => {
      if (outageMask[i]) return;
      const w = Math.floor((Date.parse(dates[i]) - t0) / (7 * DAY_MS));
      const arr = buckets.get(w);
      if (arr) arr.push(r);
      else buckets.set(w, [r]);
    });
    const ws = Array.from(buckets.keys()).sort((a, b) => a - b);
    const xs: number[] = [];
    const ys: number[] = [];
    for (const w of ws) {
      const vals = buckets.get(w) as number[];
      if (vals.length < 5) continue;
      const m = percentile(vals, 0.75);
      xs.push(w);
      ys.push(m);
      weekly.push({ label: dayKey(t0 + w * 7 * DAY_MS), ratio: m });
    }
    if (xs.length >= 26) {
      const fit = linearFit(xs, ys);
      if (fit) {
        const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
        trend = {
          annualFrac: meanY > 0 ? (fit.slope * 52) / meanY : 0,
          p: correlationP(fit.r, xs.length),
          weeks: xs.length,
          slopePerWeek: fit.slope,
          intercept: fit.intercept,
        };
      }
    }
  }
  let trendKwh = 0;
  let trendCounted = false;
  const declining = !!trend && trend.annualFrac <= -th.declinePerYear && trend.p !== null && trend.p < 0.01;
  if (trend && declining && !shift) {
    const spanWeeks = n / 7;
    // With under about 18 months of data, the seasons themselves can look like a decline.
    const confidence: Confidence = spanWeeks >= 104 && (trend.p as number) < 0.001 ? "high" : spanWeeks >= 78 ? "medium" : "low";
    const l0 = trend.intercept;
    if (l0 > 0) {
      for (let i = 0; i < n; i++) {
        const w = (Date.parse(dates[i]) - Date.parse(dates[0])) / (7 * DAY_MS);
        const d = clamp(1 - (l0 + trend.slopePerWeek * w) / l0, 0, 0.5);
        trendKwh += days[i].kwh * (d / (1 - d));
      }
    }
    trendCounted = confidence !== "low";
    events.push({
      id: "decline-1",
      type: "decline",
      start: dates[0],
      end: dates[n - 1],
      days: n,
      confidence,
      lossKwh: trendKwh,
      title: `Output is drifting down by about ${Math.round(-trend.annualFrac * 100)}% a year`,
      detail:
        confidence === "low"
          ? `With only about ${Math.round(spanWeeks)} weeks of data, a slow fall like this can simply be the seasons changing. Export 18 months or more before acting on it.`
          : `Week by week, the best days are getting lower over about ${Math.round(spanWeeks)} weeks. Dust build-up, growing shade or ageing are common reasons, and cleaning is the cheapest thing to test first.`,
    });
  }

  // Spell days inside a level shift are already covered by the shift loss, so
  // they stay flagged on the chart but are not counted a second time.
  spellKwh = 0;
  for (let i = 0; i < n; i++) {
    if (flags[i] !== "spell") continue;
    if (shift && dates[i] >= shift.start && dates[i] <= shift.end) continue;
    spellKwh += kWp * Math.max(0, expectedRatio * reference - yields[i]);
  }

  const lowKwh = outageKwh + shiftKwh + (trendCounted ? trendKwh : 0);
  const highKwh = lowKwh + spellKwh + (trendCounted ? 0 : trendKwh);
  const tariff = params.tariff && params.tariff > 0 ? params.tariff : null;
  const yearFactor = 365 / n;

  // ----- health score -----
  const outageDays = outageMask.filter(Boolean).length;
  const spellDaysCount = flags.filter((f) => f === "spell").length;
  const seriousSpellDays = events.filter((e) => e.type === "spell" && e.confidence !== "low").reduce((a, e) => a + e.days, 0);
  const availability = clamp(100 - 400 * (outageDays / n), 0, 100);
  const consistency = clamp(100 - 250 * (seriousSpellDays / n), 0, 100);
  const dropFrac = Math.max(shift ? shift.dropFrac : 0, trendCounted && trend ? -trend.annualFrac : 0);
  const trendScore = clamp(100 - 500 * dropFrac, 0, 100);
  const totalKwh = days.reduce((a, d) => a + d.kwh, 0);
  const meanYield = yields.reduce((a, b) => a + b, 0) / n;
  const annualisedYield = meanYield * 365;

  const parts: ScorePart[] = [
    {
      key: "availability",
      label: "Running when it should",
      score: availability,
      weight: 0.3,
      note: outageDays === 0 ? "No days with zero output." : `${outageDays} day(s) with almost no output out of ${n}.`,
    },
    {
      key: "consistency",
      label: "Steady day to day",
      score: consistency,
      weight: 0.2,
      note: seriousSpellDays === 0 ? "No long spells of poor output." : `${seriousSpellDays} day(s) fell in week-long low-output spells (could be weather).`,
    },
    {
      key: "trend",
      label: "Holding its level over time",
      score: trendScore,
      weight: 0.25,
      note: dropFrac < 0.02 ? "No meaningful step down or decline." : `Output fell by about ${Math.round(dropFrac * 100)}%.`,
    },
  ];
  if (params.designYield && params.designYield > 0) {
    const ratio = annualisedYield / params.designYield;
    parts.push({
      key: "design",
      label: "Matches the installer's design",
      score: clamp(100 - 250 * Math.max(0, 0.95 - ratio), 0, 100),
      weight: 0.25,
      note: `Producing about ${Math.round(ratio * 100)}% of the designed yearly yield.`,
    });
  }
  const wsum = parts.reduce((a, p) => a + p.weight, 0);
  parts.forEach((p) => (p.weight = p.weight / wsum));
  const score = Math.round(parts.reduce((a, p) => a + p.score * p.weight, 0));
  const level: Analysis["level"] = score >= 85 ? "Healthy" : score >= 70 ? "Fair" : score >= 50 ? "Needs attention" : "Poor";

  // ----- monthly totals -----
  const monthMap = new Map<string, { kwh: number; days: number }>();
  days.forEach((d) => {
    const m = d.date.slice(0, 7);
    const cur = monthMap.get(m) ?? { kwh: 0, days: 0 };
    cur.kwh += d.kwh;
    cur.days += 1;
    monthMap.set(m, cur);
  });
  const monthly = Array.from(monthMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, v]) => ({ month, kwh: v.kwh, days: v.days }));

  let bestI = 0;
  let worstI = 0;
  days.forEach((d, i) => {
    if (d.kwh > days[bestI].kwh) bestI = i;
    if (d.kwh < days[worstI].kwh) worstI = i;
  });

  events.sort((a, b) => a.start.localeCompare(b.start));

  return {
    ok: true,
    reason: "",
    n,
    firstDate: dates[0],
    lastDate: dates[n - 1],
    totalKwh,
    meanDailyKwh: totalKwh / n,
    meanYield,
    medianYield: median(yields),
    annualisedYield,
    capacityFactor: totalKwh / (kWp * 24 * n),
    referenceYield: reference,
    expectedRatio,
    bestDay: { date: days[bestI].date, kwh: days[bestI].kwh },
    worstDay: { date: days[worstI].date, kwh: days[worstI].kwh },
    dates,
    yields,
    ratios,
    flags,
    events,
    shift,
    trend,
    outageDays,
    spellDaysCount,
    uptime: 1 - outageDays / n,
    loss: {
      outageKwh,
      shiftKwh,
      trendKwh,
      spellKwh,
      lowKwh,
      highKwh,
      lowKsh: tariff ? lowKwh * tariff : null,
      highKsh: tariff ? highKwh * tariff : null,
      perYearLowKsh: tariff ? lowKwh * tariff * yearFactor : null,
      perYearHighKsh: tariff ? highKwh * tariff * yearFactor : null,
    },
    score,
    level,
    parts,
    monthly,
    weekly,
  };
}

function rangeText(lo: number, hi: number): string {
  const a = Math.round(lo);
  const b = Math.round(hi);
  return a === b ? a.toLocaleString() : `${a.toLocaleString()} to ${b.toLocaleString()}`;
}

/* ---------- recommendations, written as plain rules ---------- */

interface Recommendation {
  title: string;
  why: string;
  checks: string[];
}

function buildRecommendations(a: Analysis): Recommendation[] {
  if (!a.ok) return [];
  const out: Recommendation[] = [];
  const has = (t: SolarEvent["type"]) => a.events.filter((e) => e.type === t);

  const outages = has("outage");
  if (outages.length > 0) {
    const days = outages.reduce((s, e) => s + e.days, 0);
    out.push({
      title: "Find out why the system produced nothing",
      why: `${days} day(s) across ${outages.length} period(s) show almost no output.`,
      checks: [
        "Check the inverter's error or event log for those dates.",
        "Ask whether there was a grid outage or a shutdown for maintenance on those dates.",
        "Check breakers, fuses and the isolator are on, and that the display shows normal operation.",
      ],
    });
  }
  const shift = a.shift;
  if (shift) {
    out.push({
      title: shift.recovered ? "Work out what changed, and keep it from coming back" : "Inspect for a part of the array that stopped working",
      why: `Typical output fell by about ${Math.round(shift.dropFrac * 100)}% from ${shift.start}${shift.recovered ? ` to ${shift.end}` : " and has not recovered"}.`,
      checks: [
        "Look at each string's voltage and current in the inverter, if it shows them. One weak string stands out.",
        "Check for new shade, such as a tree that grew, a new building or a water tank.",
        "Look for loose or burnt connectors, damaged cables and broken panels.",
        "If the dates match a cleaning, a repair or an inverter update, that is probably the cause.",
      ],
    });
  }
  const decline = has("decline");
  if (decline.length > 0 && !shift) {
    out.push({
      title: "Test the cheapest explanation first: clean the panels",
      why: "Output is slowly falling week after week.",
      checks: [
        "Clean the panels with clean water and a soft brush, then compare the next two weeks of output.",
        "Check for growing shade across the day, especially early morning and late afternoon.",
        "If cleaning does not help, ask the installer to test the panels and connections.",
      ],
    });
  }
  const spells = has("spell").filter((e) => e.confidence !== "low");
  if (spells.length > 0) {
    out.push({
      title: "Check the long low-output spells against the weather",
      why: `${spells.length} spell(s) of a week or more at well below normal output.`,
      checks: [
        "Compare those dates with local weather. A long run of heavy cloud explains it.",
        "If the weather was clear, treat them like the outages above and check the inverter log.",
      ],
    });
  }
  const design = a.parts.find((p) => p.key === "design");
  if (design && design.score < 70) {
    out.push({
      title: "Ask the installer why yield is below the design figure",
      why: design.note,
      checks: [
        "Share this report and the design document, and ask for an explanation or a site visit.",
        "Check the panel angle, direction and any shade that was not in the design.",
      ],
    });
  }
  if (out.length === 0) {
    out.push({
      title: "Keep watching, nothing needs fixing now",
      why: "No outages, steps or declines were found in this data.",
      checks: [
        "Export the data again every month or two and re-run this check.",
        "Clean the panels on a regular schedule, and note the dates so the effect is visible next time.",
      ],
    });
  }
  return out;
}

/* ---------- plain-text briefing without any AI ---------- */

function ruleBriefing(a: Analysis, kWp: number): string {
  if (!a.ok) return a.reason;
  const money = a.loss.lowKsh !== null && a.loss.highKsh !== null;
  const what = `This is a ${kWp} kWp system with ${a.n} days of data, from ${a.firstDate} to ${a.lastDate}. It produced ${Math.round(a.totalKwh).toLocaleString()} kWh, about ${a.meanYield.toFixed(1)} kWh per kWp per day.`;
  const issues = a.events.filter((e) => e.confidence !== "low");
  const dips = a.events.length - issues.length;
  const found = issues.length
    ? `The checks found ${issues.length} issue(s). ${issues
        .slice(0, 3)
        .map((e) => `${e.title} (${e.start}${e.end !== e.start ? " to " + e.end : ""})`)
        .join("; ")}.`
    : "The checks found no outages, no sustained step down and no clear declining trend.";
  const dipNote = dips > 0 ? ` ${dips} short dip(s) in output looked like ordinary weather.` : "";
  const differ = Math.round(a.loss.lowKwh) !== Math.round(a.loss.highKwh);
  const lost =
    a.loss.highKwh > 1
      ? ` Estimated energy lost: ${rangeText(a.loss.lowKwh, a.loss.highKwh)} kWh${
          money ? `, worth about KSh ${rangeText(a.loss.lowKsh as number, a.loss.highKsh as number)}` : ""
        }.${differ ? " The lower figure counts clear faults only, and the higher one also counts long low-output spells that might be weather." : ""}`
      : "";
  const next = buildRecommendations(a)[0];
  return `What this system is:\n${what}\n\nHealth score:\n${a.score} out of 100 (${a.level}). ${found}${dipNote}${lost}\n\nWhat to do first:\n${next.title}. ${next.checks[0]}`;
}

/* ---------- synthetic data with known faults (for testing and the sample button) ---------- */

interface SampleFault {
  type: "outage" | "shift" | "decline";
  start: string;
  end: string;
  note: string;
}

interface SampleOptions {
  kWp: number;
  days: number;
  start: string; // YYYY-MM-DD
  seed: number;
  faults: boolean;
  format: "daily" | "cumulative" | "power";
  seasonal?: number; // yearly swing in output, as a share (default 0.05)
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateSample(o: SampleOptions): { csv: string; truth: SampleFault[]; dailyKwh: number[]; dates: string[] } {
  const rand = rng(o.seed);
  const gauss = () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const t0 = Date.parse(o.start + "T00:00:00Z");
  const dates: string[] = [];
  for (let i = 0; i < o.days; i++) dates.push(dayKey(t0 + i * DAY_MS));

  const clearYield = 5.6; // synthetic clear-day yield, kWh per kWp
  let z = 0;
  const truth: SampleFault[] = [];
  const mult: number[] = new Array(o.days).fill(1);
  if (o.faults) {
    const outageA = Math.floor(o.days * 0.22);
    const outageB = Math.floor(o.days * 0.6);
    const shiftAt = Math.floor(o.days * 0.68);
    const soilStart = Math.floor(o.days * 0.1);
    for (let i = outageA; i < outageA + 3; i++) mult[i] = 0.01;
    truth.push({ type: "outage", start: dates[outageA], end: dates[outageA + 2], note: "3 days with no output" });
    mult[outageB] = 0.01;
    truth.push({ type: "outage", start: dates[outageB], end: dates[outageB], note: "1 day with no output" });
    for (let i = shiftAt; i < o.days; i++) mult[i] *= 0.82;
    truth.push({ type: "shift", start: dates[shiftAt], end: dates[o.days - 1], note: "output permanently 18% lower" });
    for (let i = soilStart; i < Math.min(o.days, soilStart + 40); i++) mult[i] *= 1 - 0.0015 * (i - soilStart);
    truth.push({ type: "decline", start: dates[soilStart], end: dates[Math.min(o.days, soilStart + 40) - 1], note: "gradual dirt build-up, about 6% over 40 days, then cleaned" });
  }
  const daily: number[] = [];
  for (let i = 0; i < o.days; i++) {
    z = 0.7 * z + Math.sqrt(1 - 0.49) * gauss();
    const clearness = clamp(0.82 + 0.14 * z, 0.18, 1);
    const seasonal = 1 + (o.seasonal ?? 0.05) * Math.sin((2 * Math.PI * i) / 365);
    const noise = 1 + 0.015 * gauss();
    daily.push(Math.max(0, o.kWp * clearYield * clearness * seasonal * noise * mult[i]));
  }

  const lines: string[] = [];
  if (o.format === "daily") {
    lines.push("Date,Daily Energy (kWh)");
    dates.forEach((d, i) => lines.push(`${d},${daily[i].toFixed(2)}`));
  } else if (o.format === "cumulative") {
    lines.push("Date,Total Energy (kWh)");
    let total = 1250;
    dates.forEach((d, i) => {
      total += daily[i];
      lines.push(`${d},${total.toFixed(2)}`);
    });
  } else {
    lines.push("Time,Power (kW)");
    dates.forEach((d, i) => {
      const slots: number[] = [];
      for (let h = 6; h < 18; h += 0.5) {
        const x = (h - 6) / 12;
        slots.push(Math.pow(Math.sin(Math.PI * x), 1.4));
      }
      const sum = slots.reduce((a, b) => a + b, 0);
      const scale = daily[i] / (sum * 0.5);
      slots.forEach((s, k) => {
        const h = 6 + k * 0.5;
        const hh = String(Math.floor(h)).padStart(2, "0");
        const mm = h % 1 === 0 ? "00" : "30";
        lines.push(`${d} ${hh}:${mm},${(s * scale).toFixed(3)}`);
      });
    });
  }
  return { csv: lines.join("\n"), truth, dailyKwh: daily, dates };
}

/* ---------- reading an export: finding the header row and guessing the columns ---------- */

function findHeaderRow(all: string[][]): number {
  for (let i = 0; i < Math.min(all.length, 25); i++) {
    const filled = (all[i] ?? []).map((c) => String(c ?? "").trim()).filter(Boolean);
    if (filled.length < 2) continue;
    const numeric = filled.filter((c) => /^-?[\d.,]+$/.test(c)).length;
    if (numeric / filled.length < 0.5) return i;
  }
  return 0;
}

interface Mapping {
  dateCol: number;
  valueCol: number;
  mode: EnergyMode;
  unit: string;
  dayRule: DayRule;
  order: DateOrder;
}

function guessMapping(headers: string[], rows: string[][]): Mapping {
  const sample = rows.slice(0, 400);
  const colVals = (i: number) => sample.map((r) => String(r[i] ?? "").trim()).filter((v) => v !== "");
  const dateRe = /date|time|day|period|stamp/i;

  let dateCol = -1;
  let bestDate = 0;
  headers.forEach((h, i) => {
    const vals = colVals(i);
    if (vals.length === 0) return;
    const parsed = vals.filter((v) => !/^\d{1,6}(\.\d+)?$/.test(v) && !isNaN(parseTimestamp(v, "dmy"))).length / vals.length;
    const named = dateRe.test(h) ? 0.2 : 0;
    const score = parsed >= 0.8 ? parsed + named : 0;
    if (score > bestDate) {
      bestDate = score;
      dateCol = i;
    }
  });
  if (dateCol === -1) {
    const i = headers.findIndex((h) => dateRe.test(h));
    dateCol = i;
  }

  let valueCol = -1;
  let bestVal = -Infinity;
  headers.forEach((h, i) => {
    if (i === dateCol) return;
    const vals = colVals(i);
    if (vals.length === 0) return;
    const numeric = vals.filter((v) => !isNaN(parseNumber(v))).length / vals.length;
    if (numeric < 0.8) return;
    let score = 0;
    if (/energy|yield|kwh|generat|product|output|e[_ ]?day|today|daily/i.test(h)) score += 3;
    if (/power|pac|ppv|\bkw\b|\(w\)|\[w\]/i.test(h)) score += 2;
    if (/total|lifetime|cumul/i.test(h)) score += 1;
    if (/volt|curr|amp|temp|freq|status|state|irradi|radiat|soc|battery|grid|load|consum|id\b/i.test(h)) score -= 4;
    if (score > bestVal) {
      bestVal = score;
      valueCol = i;
    }
  });

  const name = valueCol >= 0 ? headers[valueCol] : "";
  let mode: EnergyMode = "daily";
  if (/total|lifetime|cumul|accumul/i.test(name)) mode = "cumulative";
  else if (/\bpower\b|\bpac\b|\bppv\b|\bkw\b|\(w\)|\(kw\)|\[w\]|\[kw\]|\(mw\)/i.test(name) && !/kwh|energy|yield/i.test(name)) mode = "power";

  let unit = mode === "power" ? "kW" : "kWh";
  if (mode === "power") {
    if (/\bmw\b|\(mw\)/i.test(name)) unit = "MW";
    else if (/\(w\)|\[w\]|\bw\b/i.test(name) && !/kw/i.test(name)) unit = "W";
  } else {
    if (/mwh/i.test(name)) unit = "MWh";
    else if (/\bwh\b|\(wh\)/i.test(name)) unit = "Wh";
  }
  const order = detectDateOrder(dateCol >= 0 ? rows.map((r) => String(r[dateCol] ?? "")) : []);
  return { dateCol, valueCol, mode, unit, dayRule: "max", order };
}

/* ---------- facts and plain answers (used by the AI prompts and by the rule-based fallback) ---------- */

function buildFacts(a: Analysis, kWp: number, tariff: number | null): string {
  if (!a.ok) return a.reason;
  const L: string[] = [];
  L.push(`System size: ${kWp} kWp. Period: ${a.firstDate} to ${a.lastDate} (${a.n} days with data).`);
  L.push(`Total energy: ${Math.round(a.totalKwh)} kWh. Average ${a.meanDailyKwh.toFixed(1)} kWh per day, ${a.meanYield.toFixed(2)} kWh per kWp per day.`);
  L.push(`Clear-day level (reference): ${a.referenceYield.toFixed(2)} kWh per kWp per day.`);
  L.push(`Health score: ${a.score} out of 100 (${a.level}). Parts: ${a.parts.map((p) => `${p.label} ${Math.round(p.score)}`).join("; ")}.`);
  L.push(`Days with almost no output: ${a.outageDays}. Uptime: ${(a.uptime * 100).toFixed(1)}%.`);
  const issues = a.events.filter((e) => e.confidence !== "low");
  L.push(
    issues.length
      ? "Findings:\n" + issues.map((e) => `- ${e.title} (${e.start}${e.end !== e.start ? " to " + e.end : ""}), confidence ${e.confidence}, about ${Math.round(e.lossKwh)} kWh lost.`).join("\n")
      : "Findings: no outages, no sustained step down and no clear declining trend."
  );
  const dips = a.events.length - issues.length;
  if (dips > 0) L.push(`${dips} short low-output dip(s) that look like ordinary weather.`);
  L.push(
    `Estimated energy lost: ${rangeText(a.loss.lowKwh, a.loss.highKwh)} kWh` +
      (tariff && a.loss.lowKsh !== null && a.loss.highKsh !== null ? `, about KSh ${rangeText(a.loss.lowKsh, a.loss.highKsh)} at KSh ${tariff} per kWh.` : ".")
  );
  return L.join("\n");
}

function answerSolar(q: string, a: Analysis, kWp: number, tariff: number | null): string | null {
  if (!a.ok) return null;
  const t = ` ${q.toLowerCase().replace(/[^a-z0-9 ]+/g, " ")} `;
  const has = (re: RegExp) => re.test(t);
  const issues = a.events.filter((e) => e.confidence !== "low");
  const kwh = (v: number) => Math.round(v).toLocaleString();

  if (has(/\b(health|score|rating|how healthy|how good)\b/)) {
    const weakest = [...a.parts].sort((x, y) => x.score - y.score)[0];
    return `The health score is ${a.score} out of 100 (${a.level}). The weakest part is "${weakest.label}" at ${Math.round(weakest.score)}: ${weakest.note}`;
  }
  if (has(/\b(lost|loss|losing|wasted|waste|money|ksh|shilling|shillings|cost|costing)\b/)) {
    if (a.loss.highKwh < 1) return "No meaningful loss was found in this data.";
    const money = a.loss.lowKsh !== null && a.loss.highKsh !== null ? `, worth about KSh ${rangeText(a.loss.lowKsh, a.loss.highKsh)}` : " (enter your tariff to see this in shillings)";
    const differ = Math.round(a.loss.lowKwh) !== Math.round(a.loss.highKwh);
    return `Estimated loss: ${rangeText(a.loss.lowKwh, a.loss.highKwh)} kWh over ${a.n} days${money}.${differ ? " The lower figure counts clear faults only. The higher one also counts long low-output spells that might just be weather." : ""}`;
  }
  if (has(/\b(outage|outages|no output|zero|offline|stopped|shut|down time|downtime|uptime|availability)\b/)) {
    const o = a.events.filter((e) => e.type === "outage");
    if (o.length === 0) return `No day had almost-zero output. Uptime was ${(a.uptime * 100).toFixed(1)}%.`;
    return `${a.outageDays} day(s) had almost no output: ${o.map((e) => (e.start === e.end ? e.start : `${e.start} to ${e.end}`)).join("; ")}. Uptime was ${(a.uptime * 100).toFixed(1)}%.`;
  }
  if (has(/\b(problem|problems|issue|issues|fault|faults|wrong|found|findings|detect|detected)\b/)) {
    if (issues.length === 0) return "No outages, no sustained step down and no clear decline were found. Short dips in output looked like weather.";
    return `Found ${issues.length} issue(s): ` + issues.map((e) => `${e.title} (${e.start}${e.end !== e.start ? " to " + e.end : ""})`).join("; ") + ".";
  }
  if (has(/\b(decline|declining|degrade|degradation|trend|worse|worsening|dropping|drop|step)\b/)) {
    if (a.shift) return `Yes. The best days stepped down by about ${Math.round(a.shift.dropFrac * 100)}% from ${a.shift.start}${a.shift.recovered ? ` to ${a.shift.end}, then recovered` : " and have not recovered"}.`;
    if (a.trend) return `No clear sustained drop was found. The weekly trend works out to about ${(a.trend.annualFrac * 100).toFixed(1)}% a year, which ${a.events.some((e) => e.type === "decline") ? "was flagged." : "is within normal variation for this much data."}`;
    return "There is not enough data to judge a trend.";
  }
  if (has(/\b(best|highest|most|biggest)\b/) && has(/\bday\b/)) return a.bestDay ? `The best day was ${a.bestDay.date} with ${a.bestDay.kwh.toFixed(1)} kWh.` : null;
  if (has(/\b(worst|lowest|least|smallest)\b/) && has(/\bday\b/)) return a.worstDay ? `The lowest day was ${a.worstDay.date} with ${a.worstDay.kwh.toFixed(1)} kWh.` : null;
  if (has(/\bmonth\b|\bmonthly\b/)) {
    const full = a.monthly.filter((m) => m.days >= 20);
    const list = full.length >= 2 ? full : a.monthly;
    const best = [...list].sort((x, y) => y.kwh / y.days - x.kwh / x.days)[0];
    const low = [...list].sort((x, y) => x.kwh / x.days - y.kwh / y.days)[0];
    return `Per day, the strongest month was ${best.month} (${(best.kwh / best.days).toFixed(1)} kWh a day) and the weakest was ${low.month} (${(low.kwh / low.days).toFixed(1)} kWh a day).`;
  }
  if (has(/\b(total|altogether|produced|generated|generation|production)\b/) || has(/\bhow much energy\b/)) return `The system produced ${kwh(a.totalKwh)} kWh over ${a.n} days, from ${a.firstDate} to ${a.lastDate}.`;
  if (has(/\b(average|typical|daily|per day|yield|specific)\b/)) return `On average it produced ${a.meanDailyKwh.toFixed(1)} kWh a day, which is ${a.meanYield.toFixed(2)} kWh per kWp per day. Over a year that comes to about ${Math.round(a.annualisedYield)} kWh per kWp.`;
  if (has(/\b(capacity factor)\b/)) return `The capacity factor was ${(a.capacityFactor * 100).toFixed(1)}%.`;
  if (has(/\b(clean|cleaning|maintenance|recommend|should|fix|next|first|advice|do about)\b/)) {
    const r = buildRecommendations(a)[0];
    return `${r.title}. ${r.why} Start with: ${r.checks[0]}`;
  }
  if (has(/\b(summary|summarise|summarize|overview|tell me about|describe)\b/)) return ruleBriefing(a, kWp);
  return null;
}

/* ============================================================
   Page: design system
   Cool slate neutrals, sun-amber for actions, blue and teal for data,
   red and orange only for faults. Figures are monospaced and tabular so
   columns of numbers line up.
   ============================================================ */

const PAL = {
  light: {
    amber: "#F59E0B", amberText: "#B45309",
    teal: "#14B8A6", tealText: "#0F766E",
    blue: "#3B82F6", blueText: "#1D4ED8",
    red: "#EF4444", redText: "#B91C1C",
    orange: "#F97316", orangeText: "#C2410C",
    grid: "#E8EDF3", ink: "#0F172A", muted: "#556275", track: "#E2E8F0",
  },
  dark: {
    amber: "#F59E0B", amberText: "#FBBF24",
    teal: "#14B8A6", tealText: "#2DD4BF",
    blue: "#60A5FA", blueText: "#93C5FD",
    red: "#F87171", redText: "#FCA5A5",
    orange: "#FB923C", orangeText: "#FDBA74",
    grid: "#1B263B", ink: "#E7EDF7", muted: "#97A6BD", track: "#1E2A42",
  },
};

const BTN_PRIMARY =
  "bg-[#F59E0B] hover:bg-[#FBBF24] text-[#0F172A] font-semibold px-4 py-2 rounded-md text-[14px] transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-[var(--surface)] focus:ring-[#F59E0B] disabled:opacity-50 disabled:cursor-not-allowed";
const BTN_SECONDARY =
  "border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface2)] text-[var(--ink)] font-medium px-4 py-2 rounded-md text-[14px] transition-colors focus:outline-none focus:ring-2 focus:ring-[#3B82F6] disabled:opacity-50 disabled:cursor-not-allowed";
const FIELD =
  "w-full border border-[var(--border)] bg-[var(--surface)] text-[var(--ink)] px-3 py-2 text-[14px] rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-[#3B82F6] hover:border-[var(--muted)]";
const LABEL = "flex flex-col gap-1 text-[13px] font-medium text-[var(--muted)]";
const TABLE_WRAP = "overflow-x-auto rounded-lg border border-[var(--border)]";
const TH = "bg-[var(--surface2)] text-[var(--muted)] text-left text-[12.5px] font-semibold px-3 py-2 border-b border-[var(--border)] whitespace-nowrap";
const TD = "px-3 py-2 text-[14px] border-b border-[var(--border)] align-top";
const NUM = "font-mono tabular-nums";

function SunMark({ size = 22 }: { size?: number }) {
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    return { x1: 12 + Math.cos(a) * 7.5, y1: 12 + Math.sin(a) * 7.5, x2: 12 + Math.cos(a) * 10.5, y2: 12 + Math.sin(a) * 10.5 };
  });
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {rays.map((r, i) => (
        <line key={i} x1={r.x1} y1={r.y1} x2={r.x2} y2={r.y2} stroke="#F59E0B" strokeWidth="2" strokeLinecap="round" />
      ))}
      <circle cx="12" cy="12" r="5" fill="#F59E0B" />
    </svg>
  );
}

function AppBar({ current, isDark, onToggle, userName }: { current: "home" | "solar"; isDark: boolean; onToggle: () => void; userName: string | null }) {
  const link = (href: string, label: string, key: string) => (
    <a
      href={href}
      aria-current={current === key ? "page" : undefined}
      className={`px-3 py-1.5 rounded-md text-[14px] font-medium transition-colors ${
        current === key ? "bg-[var(--surface2)] text-[var(--ink)]" : "text-[var(--muted)] hover:text-[var(--ink)]"
      }`}
    >
      {label}
    </a>
  );
  return (
    <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--surface)] print:hidden">
      <div className="max-w-7xl mx-auto px-4 md:px-6 h-14 flex items-center justify-between gap-4">
        <div className="flex items-center gap-5">
          <a href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <SunMark />
            <span className="hidden sm:inline">Solar performance assessment</span>
          </a>
          <nav className="flex items-center gap-1" aria-label="Main">
            {link("/", "Home", "home")}
            {link("/analyze", "Assessment", "solar")}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {userName && <span className="text-[13px] text-[var(--muted)] hidden md:inline">Saved on this device for {userName}</span>}
          <button
            onClick={onToggle}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
            title={isDark ? "Switch to light mode" : "Switch to dark mode"}
            className="w-9 h-9 rounded-md border border-[var(--border)] hover:bg-[var(--surface2)] flex items-center justify-center text-base transition-colors"
          >
            {isDark ? "☀️" : "🌙"}
          </button>
        </div>
      </div>
    </header>
  );
}

function Card({ title, subtitle, action, children }: { title?: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5 md:p-6 mb-5 shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
      {(title || action) && (
        <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
          <div>
            {title && <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>}
            {subtitle && <p className="text-[var(--muted)] text-[14px] mt-0.5 max-w-2xl leading-relaxed">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

function Kpi({ label, value, note, color }: { label: string; value: string; note?: string; color: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-4 py-3">
      <div className="text-[13px] text-[var(--muted)]">{label}</div>
      <div className={`${NUM} text-[22px] font-semibold mt-0.5 leading-tight`} style={{ color }}>
        {value}
      </div>
      {note && <div className="text-[13px] text-[var(--muted)] mt-1 leading-snug">{note}</div>}
    </div>
  );
}

function Callout({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg px-4 py-3 text-[14px] leading-relaxed max-w-3xl" style={{ background: `${color}14`, border: `1px solid ${color}44` }}>
      {children}
    </div>
  );
}

function Explain({ children, label = "What does this mean?" }: { children: React.ReactNode; label?: string }) {
  return (
    <details className="mt-4 text-[14px] group">
      <summary className="cursor-pointer text-[var(--blue-text)] font-medium select-none inline-flex items-center gap-1.5">
        <span className="transition-transform duration-200 group-open:rotate-90">▸</span>
        {label}
      </summary>
      <div className="mt-2 leading-relaxed space-y-2 max-w-2xl border-l-2 border-[var(--border)] pl-4 ml-1 text-[var(--muted)]">{children}</div>
    </details>
  );
}

// The memorable element: an instrument-style gauge. The needle ends in a small
// sun, and the colour bands match the score labels used in the text.
function Gauge({ score, level, pal }: { score: number; level: string; pal: typeof PAL.light }) {
  const cx = 150;
  const cy = 146;
  const r = 104;
  const at = (pct: number, radius: number): [number, number] => {
    const ang = Math.PI * (1 - pct / 100);
    return [cx + radius * Math.cos(ang), cy - radius * Math.sin(ang)];
  };
  const arc = (from: number, to: number) => {
    const [x1, y1] = at(from, r);
    const [x2, y2] = at(to, r);
    return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  };
  const s = Math.min(100, Math.max(0, score));
  const [nx, ny] = at(s, r - 22);
  const [sx, sy] = at(s, r);
  const bandColor = s >= 85 ? pal.tealText : s >= 70 ? pal.tealText : s >= 50 ? pal.amberText : pal.redText;
  const ticks = Array.from({ length: 11 }, (_, i) => i * 10);
  return (
    <svg viewBox="0 0 300 200" className="w-full max-w-[320px]" role="img" aria-label={`Health score ${score} out of 100, ${level}`}>
      <path d={arc(0, 100)} fill="none" stroke={pal.track} strokeWidth="12" />
      <path d={arc(0, 50)} fill="none" stroke={pal.red} strokeWidth="12" opacity="0.9" />
      <path d={arc(50, 70)} fill="none" stroke={pal.orange} strokeWidth="12" opacity="0.9" />
      <path d={arc(70, 85)} fill="none" stroke="#84CC16" strokeWidth="12" opacity="0.9" />
      <path d={arc(85, 100)} fill="none" stroke={pal.teal} strokeWidth="12" opacity="0.95" />
      {ticks.map((t) => {
        const [x1, y1] = at(t, r + 10);
        const [x2, y2] = at(t, r + (t % 50 === 0 ? 18 : 14));
        return <line key={t} x1={x1} y1={y1} x2={x2} y2={y2} stroke={pal.muted} strokeWidth="1.2" opacity="0.7" />;
      })}
      {[0, 50, 100].map((t) => {
        const [x, y] = at(t, r + 30);
        return (
          <text key={t} x={x} y={y + 4} textAnchor="middle" fontSize="11" fill={pal.muted} fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">
            {t}
          </text>
        );
      })}
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={pal.ink} strokeWidth="3" strokeLinecap="round" />
      <circle cx={cx} cy={cy} r="7" fill={pal.ink} />
      <circle cx={sx} cy={sy} r="8" fill="#FBBF24" stroke="#F59E0B" strokeWidth="2.5" />
      <text x={cx} y={cy + 42} textAnchor="middle" fontSize="40" fontWeight="600" fill={bandColor} fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">
        {score}
      </text>
    </svg>
  );
}

type Source = "ai" | "rules";
type AiText = { text: string; status: "loading" | "done"; source?: Source };

const OLLAMA_TIMEOUT_MS = 120000;

export default function SolarPage() {
  /* ---------- theme, shared with the other pages ---------- */
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const saved = localStorage.getItem("csv-explorer-theme");
    if (saved === "dark" || saved === "light") setIsDark(saved === "dark");
    else if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) setIsDark(true);
  }, []);
  const toggleTheme = () =>
    setIsDark((prev) => {
      localStorage.setItem("csv-explorer-theme", !prev ? "dark" : "light");
      return !prev;
    });

  const [userName, setUserName] = useState<string | null>(null);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("csv-explorer-user");
      if (saved) setUserName(JSON.parse(saved).name ?? null);
    } catch {
      /* no saved name */
    }
  }, []);

  /* ---------- the uploaded file and how to read it ---------- */
  const [table, setTable] = useState<{ headers: string[]; rows: string[][] } | null>(null);
  const [fileName, setFileName] = useState("");
  const [isSample, setIsSample] = useState(false);
  const [parseError, setParseError] = useState("");
  const [dateCol, setDateCol] = useState("-1");
  const [valueCol, setValueCol] = useState("-1");
  const [mode, setMode] = useState<EnergyMode>("daily");
  const [unit, setUnit] = useState("kWh");
  const [dayRule, setDayRule] = useState<DayRule>("max");
  const [order, setOrder] = useState<DateOrder>("dmy");

  /* ---------- the system ---------- */
  const [kWpText, setKWpText] = useState("");
  const [tariffText, setTariffText] = useState("");
  const [designText, setDesignText] = useState("");
  const [thr, setThr] = useState<Thresholds>(DEFAULT_THRESHOLDS);

  const ingest = (all: string[][], name: string, sample: boolean) => {
    const hi = findHeaderRow(all);
    const headers = (all[hi] ?? []).map((h) => String(h ?? "").trim());
    const rows = all.slice(hi + 1).filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
    if (rows.length < 5 || headers.length < 2) {
      setParseError("That file has too few rows or columns to analyse. Export the daily or interval history from your inverter portal and try again.");
      return;
    }
    const g = guessMapping(headers, rows);
    setParseError("");
    setTable({ headers, rows });
    setFileName(name);
    setIsSample(sample);
    setDateCol(String(g.dateCol));
    setValueCol(String(g.valueCol));
    setMode(g.mode);
    setUnit(g.unit);
    setDayRule(g.dayRule);
    setOrder(g.order);
    setBriefing(null);
    setExplains({});
    setAnswer("");
    setAnswerSource("");
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      skipEmptyLines: true,
      complete: (res: ParseResult<string[]>) => ingest(res.data as string[][], file.name, false),
      error: (err: Error) => setParseError(`Could not read that file: ${err.message}`),
    });
    e.target.value = "";
  };

  const loadSample = (faults: boolean) => {
    const s = generateSample({ kWp: 20, days: 365, start: "2024-01-01", seed: faults ? 11 : 12, faults, format: "daily" });
    Papa.parse(s.csv, {
      skipEmptyLines: true,
      complete: (res: ParseResult<string[]>) => {
        ingest(res.data as string[][], faults ? "sample-with-problems.csv" : "sample-healthy.csv", true);
        setKWpText("20");
        setTariffText("22");
        setDesignText("");
      },
    });
  };

  const changeMode = (m: EnergyMode) => {
    setMode(m);
    const energy = ["kWh", "Wh", "MWh"];
    if (m === "power" && energy.includes(unit)) setUnit("kW");
    if (m !== "power" && !energy.includes(unit)) setUnit("kWh");
  };

  /* ---------- the analysis ---------- */
  const dateIdx = Number(dateCol);
  const valueIdx = Number(valueCol);
  const kWp = parseFloat(kWpText);
  const tariff = parseFloat(tariffText);
  const designYield = parseFloat(designText);

  const imported = useMemo(() => {
    if (!table || dateIdx < 0 || valueIdx < 0) return null;
    return toDailyEnergy(table.rows, dateIdx, valueIdx, { mode, unitFactor: UNIT_FACTORS[unit] ?? 1, dayRule, order });
  }, [table, dateIdx, valueIdx, mode, unit, dayRule, order]);

  const analysis = useMemo<Analysis | null>(() => {
    if (!imported) return null;
    return analyseSystem(imported.days, {
      kWp: isFinite(kWp) ? kWp : 0,
      tariff: isFinite(tariff) && tariff > 0 ? tariff : null,
      designYield: isFinite(designYield) && designYield > 0 ? designYield : null,
      thresholds: thr,
    });
  }, [imported, kWp, tariff, designYield, thr]);

  const a: Analysis | null = analysis && analysis.ok ? analysis : null;
  const tariffVal = isFinite(tariff) && tariff > 0 ? tariff : null;
  const recs = useMemo(() => (a ? buildRecommendations(a) : []), [a]);
  const issues = a ? a.events.filter((e) => e.confidence !== "low") : [];
  const dips = a ? a.events.filter((e) => e.confidence === "low") : [];

  /* ---------- charts, coloured for the current theme ---------- */
  const P = isDark ? PAL.dark : PAL.light;
  const axis = (title: string, extra: any = {}): any => ({
    ticks: { color: P.muted, maxTicksLimit: 10 },
    grid: { color: P.grid },
    border: { color: P.grid },
    title: { display: true, text: title, color: P.muted },
    ...extra,
  });
  const chartPlugins = (title: string, legend: boolean): any => ({
    legend: { display: legend, labels: { color: P.muted, boxWidth: 12 } },
    title: { display: true, text: title, color: P.ink, font: { size: 13, weight: "600" } },
  });
  const dailyChart: any = useMemo(() => {
    if (!a) return null;
    const shiftPoints = a.dates.map((d) => (a.shift && d >= a.shift.start && d <= a.shift.end ? a.referenceYield * (1 - a.shift.dropFrac) : null));
    return {
      labels: a.dates,
      datasets: [
        { label: "Energy per kWp each day", data: a.yields, borderColor: P.blue, backgroundColor: P.blue, pointRadius: 0, borderWidth: 1.5 },
        { label: "Clear-day level", data: a.dates.map(() => a.referenceYield), borderColor: P.teal, borderDash: [6, 4], pointRadius: 0, borderWidth: 2 },
        ...(a.shift
          ? [{ label: "Clear-day level after the step", data: shiftPoints, borderColor: P.red, borderDash: [3, 3], pointRadius: 0, borderWidth: 2, spanGaps: false }]
          : []),
        { label: "No output", data: a.yields.map((y, i) => (a.flags[i] === "outage" ? y : null)), showLine: false, pointRadius: 5, backgroundColor: P.red, borderColor: P.red },
        { label: "Low-output spell", data: a.yields.map((y, i) => (a.flags[i] === "spell" ? y : null)), showLine: false, pointRadius: 3.5, backgroundColor: P.orange, borderColor: P.orange },
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, isDark]);
  const dailyOptions: any = {
    responsive: true,
    plugins: chartPlugins("Energy produced each day, per kWp installed", true),
    scales: { x: axis("Date"), y: axis("kWh per kWp", { beginAtZero: true }) },
  };
  const monthlyChart: any = useMemo(() => {
    if (!a) return null;
    return {
      labels: a.monthly.map((m) => (m.days < 25 ? `${m.month} (${m.days} d)` : m.month)),
      datasets: [{ label: "Energy (kWh)", data: a.monthly.map((m) => Math.round(m.kwh)), backgroundColor: P.blue }],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, isDark]);
  const monthlyOptions: any = {
    responsive: true,
    plugins: chartPlugins("Energy produced each month (partial months show their number of days)", false),
    scales: { x: axis("Month"), y: axis("kWh", { beginAtZero: true }) },
  };

  /* ---------- the local AI, with a labelled fallback ---------- */
  const callOllama = async (prompt: string, onChunk?: (soFar: string) => void): Promise<string> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
    try {
      const res = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ model: "llama3.1", prompt, stream: !!onChunk }),
      });
      if (!res.ok) throw new Error(`Ollama returned status ${res.status}`);
      if (!onChunk || !res.body) {
        const data = await res.json();
        return ((data.response as string) || "").trim();
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = "";
      let buffer = "";
      const consume = (line: string) => {
        if (!line.trim()) return;
        try {
          const obj = JSON.parse(line);
          if (obj.response) {
            full += obj.response;
            onChunk(full);
          }
        } catch {
          /* a JSON object split across two chunks completes on the next read */
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        lines.forEach(consume);
      }
      if (buffer.trim()) consume(buffer);
      return full.trim();
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const facts = a ? buildFacts(a, kWp, tariffVal) : "";

  // 1. briefing, written once when a readable file first produces results
  const [briefing, setBriefing] = useState<AiText | null>(null);
  const briefingStarted = useRef<Set<string>>(new Set());
  const briefKey = table ? `${fileName}|${table.rows.length}|${dateCol}|${valueCol}|${mode}` : "";

  const generateBriefing = async () => {
    if (!a) return;
    setBriefing({ text: "", status: "loading" });
    const prompt = `You are a friendly solar technician explaining a system check to the owner, who is not technical.

Facts, already calculated and correct:
${facts}

Write a short briefing with exactly these three parts, each starting with its label on its own line:
What this system is: one or two plain sentences.
Health: two or three sentences about the score and what was found. Say clearly if the evidence is weak or could just be weather.
What to do first: one sentence.
Use everyday words. Use only the facts above and do not invent any numbers or causes you are not told about.`;
    try {
      const text = await callOllama(prompt, (soFar) => setBriefing({ text: soFar, status: "loading", source: "ai" }));
      setBriefing(text ? { text, status: "done", source: "ai" } : { text: ruleBriefing(a, kWp), status: "done", source: "rules" });
    } catch {
      // The local AI wasn't available: use the built-in rules, and say so on screen.
      setBriefing({ text: ruleBriefing(a, kWp), status: "done", source: "rules" });
    }
  };

  useEffect(() => {
    if (a && briefKey && !briefingStarted.current.has(briefKey)) {
      briefingStarted.current.add(briefKey);
      generateBriefing();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [briefKey, !!a]);

  // 2. "explain this" buttons
  const [explains, setExplains] = useState<Record<string, AiText>>({});
  const explain = async (key: string, topic: string, extra: string, fallback: string) => {
    setExplains((p) => ({ ...p, [key]: { text: "", status: "loading" } }));
    const prompt = `You are a solar technician explaining one result to a system owner with no technical training.

Topic: ${topic}
Facts, already calculated and correct:
${facts}
${extra}

In 2 to 4 short sentences, explain what this means and what the owner should do. Use only the facts above. Do not invent numbers. If the evidence is weak, say so.`;
    try {
      const text = await callOllama(prompt, (soFar) => setExplains((p) => ({ ...p, [key]: { text: soFar, status: "loading", source: "ai" } })));
      setExplains((p) => ({ ...p, [key]: text ? { text, status: "done", source: "ai" } : { text: fallback, status: "done", source: "rules" } }));
    } catch {
      setExplains((p) => ({ ...p, [key]: { text: fallback, status: "done", source: "rules" } }));
    }
  };
  const renderExplain = (key: string, topic: string, extra: string, fallback: string) => {
    const s = explains[key];
    return (
      <div className="mt-4 print:hidden">
        <button onClick={() => explain(key, topic, extra, fallback)} disabled={s?.status === "loading"} className={BTN_SECONDARY}>
          {s?.status === "loading" ? "Explaining…" : s ? "✨ Explain again" : "✨ Explain this with AI"}
        </button>
        {s && s.text && (
          <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-4 py-3 max-w-3xl leading-relaxed whitespace-pre-wrap text-[14px]">
            {s.text}
            {s.source && (
              <span className="block text-[var(--muted)] text-[13px] mt-2">
                {s.source === "rules" ? "Written by the app's built-in rules, not an AI model (the local AI wasn't available)." : "Written by the local AI model."}
              </span>
            )}
          </div>
        )}
      </div>
    );
  };

  // 3. ask a question
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [answerSource, setAnswerSource] = useState<Source | "">("");
  const [isAsking, setIsAsking] = useState(false);
  const handleAsk = async () => {
    if (!a || !question.trim() || isAsking) return;
    setIsAsking(true);
    setAnswer("");
    setAnswerSource("");
    const prompt = `You are a solar technician answering a system owner's question.

Facts, already calculated and correct:
${facts}

Question: ${question}

Answer in plain, simple language using only the facts above. If the facts do not contain what is asked, say so and stop. Do not guess numbers.`;
    try {
      const text = await callOllama(prompt, (soFar) => setAnswer(soFar));
      if (!text) setAnswer("No answer came back.");
      else setAnswerSource("ai");
    } catch {
      const fallback = answerSolar(question, a, kWp, tariffVal);
      if (fallback) {
        setAnswer(fallback);
        setAnswerSource("rules");
      } else {
        setAnswer(
          "The local AI wasn't available, and the built-in rules couldn't match that question. Try asking about the health score, energy lost, outages, the trend, the best or worst day, or what to do first."
        );
      }
    } finally {
      setIsAsking(false);
    }
  };

  const money = (v: number | null) => (v === null ? null : `KSh ${Math.round(v).toLocaleString()}`);
  const moneyRange = a && a.loss.lowKsh !== null && a.loss.highKsh !== null ? `KSh ${rangeText(a.loss.lowKsh, a.loss.highKsh)}` : null;

  const headline = a
    ? a.loss.highKwh < 1
      ? "Your system is producing as it should."
      : `Your system lost an estimated ${rangeText(a.loss.lowKwh, a.loss.highKwh)} kWh${moneyRange ? `, about ${moneyRange}` : ""}.`
    : "";

  /* ============================================================ */

  const chip = (text: string, color: string) => (
    <span className="inline-block px-2 py-0.5 rounded text-[12px] font-medium whitespace-nowrap" style={{ color, background: `${color}1F` }}>
      {text}
    </span>
  );
  const eventColor = (t: SolarEvent["type"]) => (t === "outage" ? P.red : t === "shift" ? P.orange : t === "decline" ? P.blue : P.muted);
  const eventText = (t: SolarEvent["type"]) => (t === "outage" ? P.redText : t === "shift" ? P.orangeText : t === "decline" ? P.blueText : P.muted);
  const levelColor = a ? (a.score >= 70 ? P.tealText : a.score >= 50 ? P.amberText : P.redText) : P.muted;

  return (
    <main className={`min-h-screen bg-[var(--bg)] text-[var(--ink)] text-[15px] transition-colors duration-200 print:bg-white ${isDark ? "dark" : ""}`}>
      <style>{`
        :root { --bg:#F2F5F9; --surface:#FFFFFF; --surface2:#F7F9FC; --border:#DCE3EC; --ink:#0F172A; --muted:#556275; --blue-text:#1D4ED8; }
        .dark { --bg:#0A1020; --surface:#101828; --surface2:#152036; --border:#243149; --ink:#E7EDF7; --muted:#97A6BD; --blue-text:#93C5FD; }
        @media print { @page { margin: 1.5cm; } body { background: white; } }
      `}</style>

      <AppBar current="solar" isDark={isDark} onToggle={toggleTheme} userName={userName} />

      <div className="max-w-7xl mx-auto px-4 md:px-6 py-6 print:p-0 print:max-w-none">
        <div className="flex items-end justify-between gap-4 flex-wrap mb-6 print:hidden">
          <div>
            <h1 className="text-[26px] font-semibold tracking-tight">Solar performance assessment</h1>
            <p className="text-[var(--muted)] text-[14px] mt-1 max-w-2xl leading-relaxed">
              Load the history exported from your inverter or monitoring app. The system checks it, finds outages, step-downs and slow decline, prices the loss, and says what to check first.
            </p>
          </div>
          {a && (
            <button onClick={() => window.print()} className={BTN_PRIMARY}>
              Download assessment report
            </button>
          )}
        </div>

        <div className="grid lg:grid-cols-[340px_minmax(0,1fr)] gap-6 items-start">
          {/* ---------- inputs ---------- */}
          <aside className="print:hidden lg:sticky lg:top-[72px] lg:max-h-[calc(100vh-88px)] lg:overflow-y-auto lg:pr-1">
            <Card title="Data" subtitle="A daily or interval history as a CSV file.">
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={handleFile}
                aria-label="Choose a CSV file"
                className="block w-full text-[13px] text-[var(--muted)] file:mr-3 file:rounded-md file:border-0 file:bg-[#F59E0B] file:text-[#0F172A] file:font-semibold file:px-3 file:py-1.5 file:cursor-pointer border border-[var(--border)] rounded-md p-1.5 bg-[var(--surface)]"
              />
              <p className="text-[var(--muted)] text-[13px] mt-3">No file handy? Try an example:</p>
              <div className="flex flex-wrap gap-2 mt-2">
                <button onClick={() => loadSample(true)} className={BTN_SECONDARY}>
                  System with problems
                </button>
                <button onClick={() => loadSample(false)} className={BTN_SECONDARY}>
                  Healthy system
                </button>
              </div>
              {isSample && (
                <div className="mt-3">
                  <Callout color={P.amber}>This is synthetic example data generated by the app, with problems added on known dates. It shows how the checks work and is not a real system.</Callout>
                </div>
              )}
              {parseError && (
                <div className="mt-3">
                  <Callout color={P.red}>{parseError}</Callout>
                </div>
              )}
              {!table && !parseError && <p className="text-[var(--muted)] text-[13px] mt-3 leading-relaxed">Nothing loaded yet. Your file stays in this browser and is never uploaded anywhere.</p>}
            </Card>

            {table && (
              <Card title="Your system" subtitle="Size lets days be compared fairly. The tariff turns lost energy into shillings.">
                <div className="space-y-3">
                  <label className={LABEL}>
                    Installed size (kWp)
                    <input type="number" min="0" step="any" inputMode="decimal" value={kWpText} onChange={(e) => setKWpText(e.target.value)} placeholder="for example 10" className={FIELD} />
                  </label>
                  <label className={LABEL}>
                    Your tariff (KSh per kWh)
                    <input type="number" min="0" step="any" inputMode="decimal" value={tariffText} onChange={(e) => setTariffText(e.target.value)} placeholder="from your bill" className={FIELD} />
                  </label>
                  <label className={LABEL}>
                    Designed yearly yield (optional)
                    <input type="number" min="0" step="any" inputMode="decimal" value={designText} onChange={(e) => setDesignText(e.target.value)} placeholder="kWh per kWp per year" className={FIELD} />
                  </label>
                </div>
                <p className="text-[var(--muted)] text-[13px] mt-3 leading-relaxed">The designed yield is on the installer's quotation, if they gave one. It lets the check say whether the system produces what it was sold to produce.</p>
                <details className="mt-3 text-[14px]">
                  <summary className="cursor-pointer text-[var(--blue-text)] font-medium select-none">Adjust how sensitive the checks are</summary>
                  <div className="space-y-3 mt-3">
                    {(
                      [
                        ["outageFrac", "Counts as no output below (share of normal)", 0.01, 0.2],
                        ["spellFrac", "Counts as a low spell below (share of normal)", 0.3, 0.9],
                        ["spellDays", "Days in a row for a low spell", 2, 21],
                        ["shiftFrac", "Counts as a step down at (share lost)", 0.05, 0.5],
                        ["declinePerYear", "Counts as a decline at (share lost per year)", 0.02, 0.4],
                      ] as [keyof Thresholds, string, number, number][]
                    ).map(([k, label, lo, hi]) => (
                      <label key={k} className={LABEL}>
                        {label}
                        <input
                          type="number"
                          min={lo}
                          max={hi}
                          step={k === "spellDays" ? 1 : 0.01}
                          value={thr[k]}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            if (isFinite(v)) setThr({ ...thr, [k]: Math.min(hi, Math.max(lo, v)) });
                          }}
                          className={FIELD}
                        />
                      </label>
                    ))}
                    <button onClick={() => setThr(DEFAULT_THRESHOLDS)} className="text-[var(--blue-text)] underline underline-offset-2 text-[13px]">
                      Back to the defaults
                    </button>
                  </div>
                </details>
              </Card>
            )}
            {table && (
              <Card>
                <details open={dateIdx < 0 || valueIdx < 0}>
                  <summary className="cursor-pointer select-none">
                    <span className="font-semibold text-[17px] tracking-tight">Reading the file</span>
                    <span className="block text-[var(--muted)] text-[13px] mt-0.5 leading-relaxed">
                      {fileName} has {table.rows.length.toLocaleString()} rows. Read as {dateIdx >= 0 ? table.headers[dateIdx] : "no date column yet"} and{" "}
                      {valueIdx >= 0 ? table.headers[valueIdx] : "no value column yet"}, {mode === "daily" ? "energy for each day" : mode === "cumulative" ? "a running total" : "power readings"} in {unit}. Click to change.
                    </span>
                  </summary>
                  <div className="mt-4">
                    <div className="space-y-3">
                  <label className={LABEL}>
                    Date or time column
                    <select value={dateCol} onChange={(e) => setDateCol(e.target.value)} className={FIELD}>
                      <option value="-1">Choose…</option>
                      {table.headers.map((h, i) => (
                        <option key={i} value={i}>
                          {h || `Column ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={LABEL}>
                    Energy or power column
                    <select value={valueCol} onChange={(e) => setValueCol(e.target.value)} className={FIELD}>
                      <option value="-1">Choose…</option>
                      {table.headers.map((h, i) => (
                        <option key={i} value={i}>
                          {h || `Column ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={LABEL}>
                    What the numbers are
                    <select value={mode} onChange={(e) => changeMode(e.target.value as EnergyMode)} className={FIELD}>
                      <option value="daily">Energy for each day</option>
                      <option value="cumulative">A running total that keeps growing</option>
                      <option value="power">Power readings through the day</option>
                    </select>
                  </label>
                  <label className={LABEL}>
                    Unit
                    <select value={unit} onChange={(e) => setUnit(e.target.value)} className={FIELD}>
                      {(mode === "power" ? ["kW", "W", "MW"] : ["kWh", "Wh", "MWh"]).map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={LABEL}>
                    Dates are written as
                    <select value={order} onChange={(e) => setOrder(e.target.value as DateOrder)} className={FIELD}>
                      <option value="dmy">Day first (15/03/2024)</option>
                      <option value="mdy">Month first (03/15/2024)</option>
                    </select>
                  </label>
                  {mode === "daily" && (
                    <label className={LABEL}>
                      If a date appears more than once
                      <select value={dayRule} onChange={(e) => setDayRule(e.target.value as DayRule)} className={FIELD}>
                        <option value="max">Use the largest value (an "energy today" figure)</option>
                        <option value="sum">Add them up (several inverters)</option>
                        <option value="mean">Use the average</option>
                      </select>
                    </label>
                  )}
                </div>
                  </div>
                </details>
              </Card>
            )}
          </aside>

          {/* ---------- results ---------- */}
          <div className="min-w-0">
            {!table && (
              <Card title="How it works">
                <ol className="space-y-4 max-w-2xl">
                  {[
                    ["Export your history", "In your inverter's app or portal, download the daily or interval energy history as a CSV file."],
                    ["Load it and add your system", "Choose the file, confirm the columns, then enter the installed size and your tariff."],
                    ["Read the assessment", "You get a health score, the problems found with dates, an estimate of the loss in shillings, and what to check first."],
                  ].map(([t, d], i) => (
                    <li key={t} className="flex gap-4">
                      <span className={`${NUM} shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-[13px] font-semibold`} style={{ background: `${P.amber}26`, color: P.amberText }}>
                        {i + 1}
                      </span>
                      <div>
                        <p className="font-semibold">{t}</p>
                        <p className="text-[var(--muted)] text-[14px] leading-relaxed mt-0.5">{d}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </Card>
            )}

            {table && analysis && !analysis.ok && (
              <Card>
                <Callout color={P.amber}>{analysis.reason}</Callout>
              </Card>
            )}

            {a && imported && (
              <>
                <div className="print:hidden">
                  <Card title="Your solar health score">
                    <div className="grid md:grid-cols-[300px_minmax(0,1fr)] gap-6 items-center">
                      <div className="flex flex-col items-center">
                        <Gauge score={a.score} level={a.level} pal={P} />
                        <span className="mt-1 text-[15px] font-semibold" style={{ color: levelColor }}>
                          {a.level}
                        </span>
                      </div>
                      <div>
                        <p className="text-[20px] font-semibold leading-snug tracking-tight max-w-xl">{headline}</p>
                        <p className="text-[var(--muted)] text-[14px] mt-1.5 max-w-xl leading-relaxed">
                          Based on <span className={NUM}>{a.n}</span> days from <span className={NUM}>{a.firstDate}</span> to <span className={NUM}>{a.lastDate}</span>.
                          {a.loss.highKwh >= 1 && !tariffVal && " Enter your tariff to see this in shillings."}
                        </p>
                        <div className="grid grid-cols-2 gap-3 mt-4">
                          <Kpi label="Energy produced" value={`${Math.round(a.totalKwh).toLocaleString()} kWh`} note={`${a.meanDailyKwh.toFixed(1)} kWh a day on average`} color={P.blueText} />
                          <Kpi label="kWh per kWp per day" value={a.meanYield.toFixed(2)} note="Output per unit of installed size" color={P.tealText} />
                          <Kpi label="Days running" value={`${(a.uptime * 100).toFixed(1)}%`} note={`${a.outageDays} day(s) with almost no output`} color={a.outageDays === 0 ? P.tealText : P.redText} />
                          <Kpi
                            label="Estimated energy lost"
                            value={a.loss.highKwh < 1 ? "None found" : `${rangeText(a.loss.lowKwh, a.loss.highKwh)} kWh`}
                            note={moneyRange ?? "Add your tariff for shillings"}
                            color={a.loss.highKwh < 1 ? P.tealText : P.orangeText}
                          />
                        </div>
                      </div>
                    </div>

                    <div className={`${TABLE_WRAP} mt-6`}>
                      <table className="min-w-full">
                        <thead>
                          <tr>
                            <th className={TH}>What was checked</th>
                            <th className={TH}>Score</th>
                            <th className={TH}>Weight</th>
                            <th className={TH}>Why</th>
                          </tr>
                        </thead>
                        <tbody>
                          {a.parts.map((p) => (
                            <tr key={p.key}>
                              <td className={`${TD} font-medium`}>{p.label}</td>
                              <td className={`${TD} ${NUM}`}>{Math.round(p.score)}</td>
                              <td className={`${TD} ${NUM}`}>{Math.round(p.weight * 100)}%</td>
                              <td className={`${TD} text-[var(--muted)]`}>{p.note}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {renderExplain(
                      "score",
                      "The solar health score and what is pulling it down",
                      "",
                      `The score is ${a.score} out of 100 (${a.level}). ${[...a.parts].sort((x, y) => x.score - y.score)[0].label} is the weakest part: ${[...a.parts].sort((x, y) => x.score - y.score)[0].note}`
                    )}
                    <Explain>
                      <p>The score is a weighted mix of the parts in the table. Every part is worked out from your own data and the rules are visible, so you can see exactly why it is high or low.</p>
                      <p>It is a screening tool, not a certificate. A low score tells you where to look first, and a technician should confirm anything that needs repair.</p>
                    </Explain>
                  </Card>

                  <Card title="Output over time" subtitle="Each day compared with the system's own best days.">
                    {dailyChart && <Line data={dailyChart} options={dailyOptions} />}
                    <p className="text-[var(--muted)] text-[13px] mt-3 max-w-2xl leading-relaxed">
                      The blue line is each day. The dashed teal line is the clear-day level. Red dots are days with almost no output, and orange dots are days in a long low spell.
                    </p>
                    {monthlyChart && (
                      <div className="mt-8">
                        <Bar data={monthlyChart} options={monthlyOptions} />
                      </div>
                    )}
                  </Card>

                  <Card title="What the checks found" subtitle="Problems first. Short dips that look like ordinary weather are kept apart so they don't raise false alarms.">
                    {issues.length === 0 ? (
                      <p className="leading-relaxed max-w-2xl">No outages, no sustained step down and no clear decline were found in this data.</p>
                    ) : (
                      <ul className="space-y-3 max-w-3xl">
                        {issues.map((e) => (
                          <li key={e.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-4 py-3">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                              <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: eventColor(e.type) }} aria-hidden="true" />
                              <span className="font-semibold">{e.title}</span>
                              <span className={`${NUM} text-[13px] text-[var(--muted)]`}>
                                {e.start}
                                {e.end !== e.start ? ` to ${e.end}` : ""}
                              </span>
                              {chip(e.confidence === "high" ? "high confidence" : "medium confidence", e.confidence === "high" ? P.tealText : P.amberText)}
                            </div>
                            <p className="text-[14px] mt-1.5 leading-relaxed text-[var(--muted)]">{e.detail}</p>
                            <p className="text-[13px] mt-1" style={{ color: eventText(e.type) }}>
                              About <span className={NUM}>{Math.round(e.lossKwh).toLocaleString()}</span> kWh lost
                              {tariffVal ? `, roughly KSh ${Math.round(e.lossKwh * tariffVal).toLocaleString()}` : ""}.
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                    {dips.length > 0 && (
                      <details className="mt-4 text-[14px]">
                        <summary className="cursor-pointer text-[var(--blue-text)] font-medium select-none">
                          {dips.length} short dip{dips.length === 1 ? "" : "s"} that look like weather
                        </summary>
                        <ul className="mt-2 space-y-1 max-w-3xl text-[var(--muted)]">
                          {dips.map((e) => (
                            <li key={e.id}>
                              {e.title}: <span className={NUM}>{e.start}</span>
                              {e.end !== e.start ? ` to ${e.end}` : ""}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {renderExplain(
                      "findings",
                      "What the checks found and how serious it is",
                      issues.length ? `Findings in detail:\n${issues.map((e) => `- ${e.title}: ${e.detail}`).join("\n")}` : "",
                      issues.length ? issues.map((e) => `${e.title}. ${e.detail}`).join(" ") : "Nothing needs fixing in this data. Keep exporting and re-checking every month or two."
                    )}
                    <Explain label="How are these found?">
                      <p>Each day is compared with the system's own clear-day level, the output reached on its best days. Cloudy days sit below that level, but a fault lowers it for good.</p>
                      <p>
                        <strong>No output</strong> means a day below {Math.round(thr.outageFrac * 100)}% of the clear-day level. <strong>A step down</strong> means the best days became at least {Math.round(thr.shiftFrac * 100)}% lower and stayed there.{" "}
                        <strong>A low spell</strong> means {thr.spellDays} or more days in a row below {Math.round(thr.spellFrac * 100)}%. Without a sunlight sensor a spell cannot be told apart from cloud, so only week-long spells count as problems.
                      </p>
                    </Explain>
                  </Card>

                  <Card title="What it cost you" subtitle="Estimates. The lower figure counts clear faults only. The higher figure also counts long low-output spells that might be weather.">
                    <div className={TABLE_WRAP}>
                      <table className="min-w-full">
                        <thead>
                          <tr>
                            <th className={TH}>Cause</th>
                            <th className={`${TH} text-right`}>Energy lost (kWh)</th>
                            <th className={`${TH} text-right`}>Worth (KSh)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(
                            [
                              ["Days with no output", a.loss.outageKwh],
                              ["Step down in output", a.loss.shiftKwh],
                              ["Slow decline", a.events.some((e) => e.type === "decline" && e.confidence !== "low") ? a.loss.trendKwh : 0],
                              ["Long low-output spells (may be weather)", a.loss.spellKwh],
                            ] as [string, number][]
                          ).map(([label, v]) => (
                            <tr key={label}>
                              <td className={TD}>{label}</td>
                              <td className={`${TD} ${NUM} text-right`}>{Math.round(v).toLocaleString()}</td>
                              <td className={`${TD} ${NUM} text-right`}>{tariffVal ? money(v * tariffVal) : "Enter tariff"}</td>
                            </tr>
                          ))}
                          <tr>
                            <td className={`${TD} font-semibold`}>Estimated total</td>
                            <td className={`${TD} ${NUM} text-right font-semibold`}>{rangeText(a.loss.lowKwh, a.loss.highKwh)}</td>
                            <td className={`${TD} ${NUM} text-right font-semibold`}>{moneyRange ?? "Enter tariff"}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    {a.loss.perYearHighKsh !== null && a.loss.perYearLowKsh !== null && a.loss.highKwh >= 1 && (
                      <div className="mt-4">
                        <Callout color={P.amber}>If these problems continued all year, that would be roughly KSh {rangeText(a.loss.perYearLowKsh, a.loss.perYearHighKsh)} a year.</Callout>
                      </div>
                    )}
                    {renderExplain(
                      "loss",
                      "How much energy and money was lost, and why the figure is a range",
                      "",
                      a.loss.highKwh < 1
                        ? "No meaningful loss was found in this data."
                        : `About ${rangeText(a.loss.lowKwh, a.loss.highKwh)} kWh was lost${moneyRange ? `, worth ${moneyRange}` : ""}. The lower figure counts clear faults only, and the higher one also counts long low spells that might just be weather.`
                    )}
                    <Explain label="How is this worked out?">
                      <p>For days with no output, the loss is what a normal day would have produced. For a step down, it is the output scaled up by the share that was lost. Long low spells are compared with a normal day.</p>
                      <p>Estimates get less reliable with under a year of data, because the seasons change output too. Treat the figures as a guide for deciding whether to investigate, not as an invoice.</p>
                    </Explain>
                  </Card>

                  <Card title="What to do next" subtitle="In order, starting with the cheapest and most likely check.">
                    <ol className="space-y-4 max-w-3xl list-decimal pl-5">
                      {recs.map((r, i) => (
                        <li key={i} className="leading-relaxed">
                          <p className="font-semibold">{r.title}</p>
                          <p className="text-[var(--muted)] text-[14px]">{r.why}</p>
                          <ul className="list-disc pl-5 mt-1 space-y-0.5 text-[14px]">
                            {r.checks.map((c, j) => (
                              <li key={j}>{c}</li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ol>
                    <p className="text-[var(--muted)] text-[13px] mt-4 max-w-2xl leading-relaxed">These are things to check, not diagnoses. Have a qualified technician look at anything electrical.</p>
                  </Card>

                  <Card title={briefing?.source === "rules" ? "Quick briefing" : "AI briefing"} subtitle="Written when the file was read, from figures the app calculated.">
                    {!briefing || (briefing.status === "loading" && !briefing.text) ? (
                      <p className="text-[var(--muted)] text-[14px]">Writing the briefing… the first words can take a little while on a local model.</p>
                    ) : (
                      <>
                        <p className="whitespace-pre-wrap leading-relaxed max-w-3xl">{briefing.text}</p>
                        {briefing.status === "done" && (
                          <p className="text-[var(--muted)] text-[13px] mt-3 max-w-3xl">
                            {briefing.source === "rules"
                              ? 'Written by the app\'s built-in rules. The local AI model wasn\'t available, so no AI was involved here. Press "Try the AI again" once Ollama is running.'
                              : "Written by the local AI model, from figures the app calculated."}
                          </p>
                        )}
                      </>
                    )}
                    <div className="mt-4">
                      <button onClick={generateBriefing} disabled={briefing?.status === "loading"} className={BTN_SECONDARY}>
                        {briefing?.status === "loading" ? "Writing…" : briefing?.source === "rules" ? "Try the AI again" : "Write it again"}
                      </button>
                    </div>

                    <div className="mt-6 border-t border-[var(--border)] pt-5">
                      <h3 className="font-semibold mb-2">Ask about your system</h3>
                      <div className="flex gap-2 flex-wrap">
                        <input
                          type="text"
                          value={question}
                          onChange={(e) => setQuestion(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && handleAsk()}
                          placeholder="How much money did I lose?"
                          aria-label="Your question"
                          className={`${FIELD} flex-1 min-w-[220px] w-auto`}
                        />
                        <button onClick={handleAsk} disabled={isAsking || !question.trim()} className={BTN_PRIMARY}>
                          {isAsking ? "Thinking…" : "Ask"}
                        </button>
                      </div>
                      {answer && (
                        <div className="mt-4 max-w-3xl">
                          <p className="whitespace-pre-wrap leading-relaxed">{answer}</p>
                          {answerSource && (
                            <p className="text-[var(--muted)] text-[13px] mt-2">
                              {answerSource === "rules" ? "Answered by the app's built-in rules, not an AI model (the local AI wasn't available)." : "Answered by the local AI model."}
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </Card>

                  <div className="grid md:grid-cols-2 gap-5">
                    <Card title="Data checks" subtitle="What was done to your file before judging it.">
                      <div className="grid grid-cols-2 gap-3">
                        <Kpi label="Rows read" value={imported.report.rowsRead.toLocaleString()} color={P.blueText} />
                        <Kpi label="Days analysed" value={String(a.n)} color={P.tealText} />
                        <Kpi label="Days missing" value={String(imported.report.missingDayCount)} color={imported.report.missingDayCount ? P.amberText : P.tealText} />
                        <Kpi label="Rows skipped" value={String(imported.report.badDates + imported.report.badValues)} color={imported.report.badDates + imported.report.badValues ? P.redText : P.tealText} />
                      </div>
                      {(imported.report.notes.length > 0 || imported.report.missingDayCount > 0 || imported.report.negativeValues > 0 || imported.report.repeatedDays > 0) && (
                        <ul className="list-disc pl-5 mt-4 space-y-1 text-[14px]">
                          {imported.report.missingDayCount > 0 && (
                            <li>
                              {imported.report.missingDayCount} day(s) had no data
                              {imported.report.missingDays.length > 0 ? `, for example ${imported.report.missingDays.slice(0, 3).join(", ")}` : ""}. They are left out, not counted as zero.
                            </li>
                          )}
                          {imported.report.repeatedDays > 0 && <li>{imported.report.repeatedDays} date(s) appeared more than once and were combined using your chosen rule.</li>}
                          {imported.report.negativeValues > 0 && <li>{imported.report.negativeValues} negative value(s) were found{mode === "power" ? " and treated as zero generation" : " and skipped"}.</li>}
                          {imported.report.notes.map((n, i) => (
                            <li key={i}>{n}</li>
                          ))}
                        </ul>
                      )}
                    </Card>
                    <Card title="Limits of this check">
                      <ul className="list-disc pl-5 space-y-2 leading-relaxed text-[14px]">
                        <li>Without a sunlight sensor, cloud and faults can look alike. The app uses the system's own best days as the yardstick, and only reports long spells as problems.</li>
                        <li>With under a year of data, the change of seasons can add to or hide a step down or decline.</li>
                        <li>Energy lost is an estimate with a range, not a guarantee or a claim for compensation.</li>
                        <li>It cannot see inside the system. Ask a qualified technician to confirm any repair.</li>
                      </ul>
                    </Card>
                  </div>
                </div>

                {/* ---------- printable report ---------- */}
                <div className="hidden print:block text-black">
                  <h1 className="text-2xl font-bold mb-1">Solar performance assessment</h1>
                  <p className="text-sm text-gray-600 mb-4">
                    {fileName} — {kWp} kWp — generated {new Date().toLocaleDateString()}
                    {isSample ? " — SYNTHETIC EXAMPLE DATA" : ""}
                  </p>
                  <h2 className="text-lg font-semibold mt-3 mb-1">Result</h2>
                  <p className="text-sm mb-2">
                    Health score {a.score} out of 100 ({a.level}). {headline} Period: {a.firstDate} to {a.lastDate} ({a.n} days).
                  </p>
                  {briefing?.status === "done" && (
                    <>
                      <h2 className="text-lg font-semibold mt-3 mb-1">{briefing.source === "rules" ? "Summary" : "AI summary"}</h2>
                      <p className="text-sm mb-1 whitespace-pre-wrap">{briefing.text}</p>
                      <p className="text-xs text-gray-500 mb-2">{briefing.source === "rules" ? "Written by the app's built-in rules." : "Written by a local AI model from figures calculated by this tool."}</p>
                    </>
                  )}
                  <h2 className="text-lg font-semibold mt-3 mb-1">Score breakdown</h2>
                  <table className="w-full text-sm border-collapse mb-2">
                    <tbody>
                      {a.parts.map((p) => (
                        <tr key={p.key} className="border-b border-gray-300">
                          <td className="py-1 pr-2">{p.label}</td>
                          <td className="py-1 pr-2 text-right">{Math.round(p.score)}</td>
                          <td className="py-1">{p.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <h2 className="text-lg font-semibold mt-3 mb-1">Findings</h2>
                  {issues.length === 0 ? (
                    <p className="text-sm mb-2">No outages, step down or clear decline found.</p>
                  ) : (
                    <ul className="text-sm list-disc pl-5 space-y-1 mb-2">
                      {issues.map((e) => (
                        <li key={e.id}>
                          {e.title} ({e.start}
                          {e.end !== e.start ? ` to ${e.end}` : ""}), {e.confidence} confidence, about {Math.round(e.lossKwh).toLocaleString()} kWh.
                        </li>
                      ))}
                    </ul>
                  )}
                  <h2 className="text-lg font-semibold mt-3 mb-1">Estimated loss</h2>
                  <p className="text-sm mb-2">{a.loss.highKwh < 1 ? "None found." : `${rangeText(a.loss.lowKwh, a.loss.highKwh)} kWh${moneyRange ? `, ${moneyRange} at KSh ${tariffVal} per kWh` : ""}.`}</p>
                  <h2 className="text-lg font-semibold mt-3 mb-1">Recommended checks</h2>
                  <ol className="text-sm list-decimal pl-5 space-y-1 mb-2">
                    {recs.map((r, i) => (
                      <li key={i}>
                        {r.title}. {r.checks[0]}
                      </li>
                    ))}
                  </ol>
                  <p className="text-xs text-gray-500 mt-4">
                    Estimates are based on the exported data only. Without a sunlight sensor, cloud and faults can look alike, and under a year of data the seasons can affect results. This report is a screening aid and does not replace inspection by a qualified technician.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
