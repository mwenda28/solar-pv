"use client";

// Place this file at app/page.tsx  (route: /)
//
// The project has two pages:
//   /          this page: explains the project and sends people on
//   /analyze   the solar performance assessment (the tool itself)
// Both share the same top bar and the same saved light/dark choice.

import React, { useEffect, useState } from "react";

const PAL = {
  light: { amberText: "#B45309", tealText: "#0F766E", redText: "#B91C1C", orangeText: "#C2410C", muted: "#556275", ink: "#0F172A", track: "#E2E8F0", grid: "#E8EDF3" },
  dark: { amberText: "#FBBF24", tealText: "#2DD4BF", redText: "#FCA5A5", orangeText: "#FDBA74", muted: "#97A6BD", ink: "#E7EDF7", track: "#1E2A42", grid: "#1B263B" },
};

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

// A small gauge for the preview. The real one on the assessment page is the same design.
function MiniGauge({ score, pal }: { score: number; pal: typeof PAL.light }) {
  const cx = 110;
  const cy = 112;
  const r = 78;
  const at = (pct: number, radius: number): [number, number] => {
    const ang = Math.PI * (1 - pct / 100);
    return [cx + radius * Math.cos(ang), cy - radius * Math.sin(ang)];
  };
  const arc = (from: number, to: number) => {
    const [x1, y1] = at(from, r);
    const [x2, y2] = at(to, r);
    return `M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  };
  const [nx, ny] = at(score, r - 18);
  const [sx, sy] = at(score, r);
  return (
    <svg viewBox="0 0 220 162" className="w-full max-w-[220px]" role="img" aria-label={`Example health score ${score} out of 100`}>
      <path d={arc(0, 100)} fill="none" stroke={pal.track} strokeWidth="10" />
      <path d={arc(0, 50)} fill="none" stroke="#EF4444" strokeWidth="10" opacity="0.9" />
      <path d={arc(50, 70)} fill="none" stroke="#F97316" strokeWidth="10" opacity="0.9" />
      <path d={arc(70, 85)} fill="none" stroke="#84CC16" strokeWidth="10" opacity="0.9" />
      <path d={arc(85, 100)} fill="none" stroke="#14B8A6" strokeWidth="10" opacity="0.95" />
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={pal.ink} strokeWidth="2.5" strokeLinecap="round" />
      <circle cx={cx} cy={cy} r="6" fill={pal.ink} />
      <circle cx={sx} cy={sy} r="7" fill="#FBBF24" stroke="#F59E0B" strokeWidth="2.5" />
      <text x={cx} y={cy + 36} textAnchor="middle" fontSize="30" fontWeight="600" fill={pal.orangeText} fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace">
        {score}
      </text>
    </svg>
  );
}

// Fixed example series for the preview (same every time, so the page never changes between loads).
function previewSeries(): number[] {
  const out: number[] = [];
  let seed = 7;
  const r = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 72; i++) {
    let v = 5.3 + (r() - 0.5) * 1.1;
    if (r() < 0.12) v -= 1.7 * r();
    if (i === 24 || i === 25) v = 0.05;
    if (i >= 46) v *= 0.82;
    out.push(Math.max(0, v));
  }
  return out;
}

function PreviewChart() {
  const series = previewSeries();
  const W = 460;
  const H = 150;
  const padL = 26;
  const maxV = 7;
  const x = (i: number) => padL + (i / (series.length - 1)) * (W - padL - 4);
  const y = (v: number) => H - 14 - (v / maxV) * (H - 24);
  const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const ref = 5.9;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Example chart of daily output with two days of no output and a step down">
      {[0, 2, 4, 6].map((g) => (
        <g key={g}>
          <line x1={padL} x2={W - 4} y1={y(g)} y2={y(g)} style={{ stroke: "var(--border)" }} strokeWidth="1" />
          <text x={padL - 6} y={y(g) + 4} textAnchor="end" fontSize="10" style={{ fill: "var(--muted)" }} fontFamily="ui-monospace, Menlo, monospace">
            {g}
          </text>
        </g>
      ))}
      <line x1={padL} x2={W - 4} y1={y(ref)} y2={y(ref)} stroke="#14B8A6" strokeWidth="1.6" strokeDasharray="5 4" />
      <line x1={x(46)} x2={W - 4} y1={y(ref * 0.82)} y2={y(ref * 0.82)} stroke="#EF4444" strokeWidth="1.6" strokeDasharray="3 3" />
      <polyline points={pts} fill="none" stroke="#3B82F6" strokeWidth="1.6" strokeLinejoin="round" />
      {[24, 25].map((i) => (
        <circle key={i} cx={x(i)} cy={y(series[i])} r="4" fill="#EF4444" />
      ))}
    </svg>
  );
}

export default function LandingPage() {
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
  const P = isDark ? PAL.dark : PAL.light;

  /* ---------- account form ----------
     There is no server in this project, so "creating an account" is a
     local-only convenience: it saves a name and email in this browser so the
     tool can greet the person. The page says exactly that. */
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const handleCreateAccount = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !password) return;
    localStorage.setItem("csv-explorer-user", JSON.stringify({ name: name.trim(), email: email.trim(), createdAt: new Date().toISOString() }));
    window.location.href = "/analyze";
  };

  const FIELD =
    "w-full border border-[var(--border)] bg-[var(--surface)] text-[var(--ink)] px-3 py-2 text-[14px] rounded-md focus:outline-none focus:ring-2 focus:ring-[#3B82F6]";
  const BTN_PRIMARY =
    "inline-block bg-[#F59E0B] hover:bg-[#FBBF24] text-[#0F172A] font-semibold px-5 py-2.5 rounded-md text-[15px] transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-[var(--bg)] focus:ring-[#F59E0B]";
  const BTN_SECONDARY =
    "inline-block border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface2)] text-[var(--ink)] font-medium px-5 py-2.5 rounded-md text-[15px] transition-colors focus:outline-none focus:ring-2 focus:ring-[#3B82F6]";

  const FEATURES: { color: string; title: string; body: string }[] = [
    { color: P.amberText, title: "One score you can understand", body: "A health score out of 100, split into the parts that make it up, so you can see exactly why it is high or low." },
    { color: P.redText, title: "Finds what went wrong, and when", body: "Days with no output, a sudden step down, or a slow decline, with dates and how sure each check is." },
    { color: P.tealText, title: "Puts a price on it", body: "Energy lost, in shillings using your own tariff, as an honest range and not a single made-up number." },
    { color: P.orangeText, title: "Explains it in plain language", body: "An AI on your own computer writes the summary and answers questions. If it isn't running, the app says so and uses built-in rules." },
  ];

  return (
    <main className={`min-h-screen bg-[var(--bg)] text-[var(--ink)] text-[15px] transition-colors duration-200 ${isDark ? "dark" : ""}`}>
      <style>{`
        :root { --bg:#F2F5F9; --surface:#FFFFFF; --surface2:#F7F9FC; --border:#DCE3EC; --ink:#0F172A; --muted:#556275; --blue-text:#1D4ED8; }
        .dark { --bg:#0A1020; --surface:#101828; --surface2:#152036; --border:#243149; --ink:#E7EDF7; --muted:#97A6BD; --blue-text:#93C5FD; }
      `}</style>

      <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="max-w-7xl mx-auto px-4 md:px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-5">
            <a href="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <SunMark />
              <span className="hidden sm:inline">Solar performance assessment</span>
            </a>
            <nav className="flex items-center gap-1" aria-label="Main">
              <a href="/" aria-current="page" className="px-3 py-1.5 rounded-md text-[14px] font-medium bg-[var(--surface2)] text-[var(--ink)]">
                Home
              </a>
              <a href="/analyze" className="px-3 py-1.5 rounded-md text-[14px] font-medium text-[var(--muted)] hover:text-[var(--ink)] transition-colors">
                Assessment
              </a>
            </nav>
          </div>
          <button
            onClick={toggleTheme}
            aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
            title={isDark ? "Switch to light mode" : "Switch to dark mode"}
            className="w-9 h-9 rounded-md border border-[var(--border)] hover:bg-[var(--surface2)] flex items-center justify-center text-base transition-colors"
          >
            {isDark ? "☀️" : "🌙"}
          </button>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 md:px-6">
        {/* ---------- hero ---------- */}
        <section className="grid lg:grid-cols-[1.05fr_1fr] gap-10 items-center py-12 md:py-16">
          <div>
            <h1 className="text-4xl md:text-[46px] leading-[1.1] font-semibold tracking-tight max-w-xl">Find out if your solar system is really working.</h1>
            <p className="text-[var(--muted)] mt-5 text-[17px] leading-relaxed max-w-xl">
              Upload the data exported from your inverter or monitoring app. You get a health score, the days and problems that cost you energy, an estimate of the money lost in shillings, and plain advice on what to check first.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <a href="/analyze" className={BTN_PRIMARY}>
                Continue for free
              </a>
              <button onClick={() => setShowAccountForm((s) => !s)} aria-expanded={showAccountForm} className={BTN_SECONDARY}>
                Create an account
              </button>
            </div>
            <p className="text-[var(--muted)] text-[13px] mt-4 max-w-md leading-relaxed">
              Nothing to install. Your file stays in your browser and is never uploaded. No data file handy? The tool has built-in examples.
            </p>

            {showAccountForm && (
              <form onSubmit={handleCreateAccount} className="mt-5 bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5 max-w-sm">
                <p className="font-semibold mb-1">Create an account</p>
                <p className="text-[var(--muted)] text-[13px] mb-3 leading-relaxed">
                  This project has no server. Your details are saved only in this browser so the tool can greet you by name. Nothing is sent anywhere.
                </p>
                <div className="space-y-3">
                  <input type="text" required placeholder="Name" aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} className={FIELD} />
                  <input type="email" required placeholder="Email" aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} className={FIELD} />
                  <input type="password" required minLength={6} placeholder="Password" aria-label="Password" value={password} onChange={(e) => setPassword(e.target.value)} className={FIELD} />
                </div>
                <button type="submit" className={`${BTN_PRIMARY} w-full mt-4`}>
                  Create account and continue
                </button>
              </form>
            )}
          </div>

          {/* ---------- dashboard preview ---------- */}
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 md:p-5 shadow-[0_1px_2px_rgba(15,23,42,0.05)]" aria-label="Preview of the assessment">
            <div className="flex items-center justify-between gap-3 mb-3">
              <p className="font-semibold text-[14px]">Example assessment</p>
              <span className="text-[12px] font-medium px-2 py-0.5 rounded" style={{ color: P.amberText, background: "#F59E0B1F" }}>
                synthetic data
              </span>
            </div>
            <div className="grid grid-cols-[1fr_1fr] gap-3 items-center">
              <div className="flex flex-col items-center">
                <MiniGauge score={64} pal={P} />
                <span className="text-[13px] font-semibold -mt-1" style={{ color: P.orangeText }}>
                  Needs attention
                </span>
              </div>
              <div className="space-y-2">
                {[
                  ["Days with no output", "2", P.redText],
                  ["Step down in output", "about 18%", P.orangeText],
                  ["Estimated loss", "KSh 9,000 to 11,000", P.amberText],
                ].map(([label, value, color]) => (
                  <div key={label} className="rounded-lg border border-[var(--border)] bg-[var(--surface2)] px-3 py-2">
                    <div className="text-[12px] text-[var(--muted)]">{label}</div>
                    <div className="font-mono tabular-nums text-[15px] font-semibold" style={{ color }}>
                      {value}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--surface2)] p-2">
              <PreviewChart />
            </div>
            <p className="text-[var(--muted)] text-[12px] mt-2 leading-relaxed">
              Blue: output each day. Dashed teal: the system's clear-day level. Red dots: no output. Dashed red: the lower level after a step down. Your own file gives your own results.
            </p>
          </div>
        </section>

        {/* ---------- what you get ---------- */}
        <section className="pb-12">
          <h2 className="text-[24px] md:text-[28px] font-semibold tracking-tight max-w-2xl">Monitoring apps show you the numbers. This tells you what they mean.</h2>
          <div className="mt-6 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {FEATURES.map((f) => (
              <div key={f.title} className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5">
                <h3 className="font-semibold text-[16px]" style={{ color: f.color }}>
                  {f.title}
                </h3>
                <p className="text-[var(--muted)] text-[14px] leading-relaxed mt-2">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---------- how it works ---------- */}
        <section className="pb-12">
          <h2 className="text-[24px] md:text-[28px] font-semibold tracking-tight">How it works</h2>
          <ol className="mt-6 grid md:grid-cols-3 gap-4">
            {[
              ["Export your history", "In your inverter's app or portal, download the daily or interval energy history as a CSV file."],
              ["Load it and add your system", "Choose the file, confirm the columns, then enter the installed size and your tariff."],
              ["Read the assessment", "See the score, the problems with dates, the estimated loss, and what to check first. Print it as a report."],
            ].map(([t, d], i) => (
              <li key={t} className="flex gap-4 bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5">
                <span className="font-mono shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-[13px] font-semibold" style={{ background: "#F59E0B26", color: P.amberText }}>
                  {i + 1}
                </span>
                <div>
                  <p className="font-semibold">{t}</p>
                  <p className="text-[var(--muted)] text-[14px] leading-relaxed mt-1">{d}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* ---------- honest limits + call to action ---------- */}
        <section className="pb-14 grid md:grid-cols-[1.2fr_1fr] gap-4 items-stretch">
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6">
            <h2 className="text-[18px] font-semibold">What to expect</h2>
            <ul className="mt-3 space-y-2 text-[var(--muted)] text-[14px] leading-relaxed list-disc pl-5">
              <li>Results are estimates worked out from your exported data, shown with how sure each check is.</li>
              <li>Without a sunlight sensor, cloudy days and faults can look alike, so only long low spells are reported as problems.</li>
              <li>It points you to what to check first. A qualified technician should confirm any repair.</li>
            </ul>
          </div>
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 flex flex-col justify-between gap-4">
            <p className="text-[18px] font-semibold leading-snug">Ready to check your system?</p>
            <div>
              <a href="/analyze" className={BTN_PRIMARY}>
                Check my solar system
              </a>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
