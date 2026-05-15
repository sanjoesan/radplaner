import { useState, useEffect } from "react";

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const DURATION_OPTS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];

const DEFAULT_LOC: Location = { name: "Garsten, Oberösterreich, Österreich", lat: 47.9939, lon: 14.3919 };
const DETAIL_FROM_H = 6, DETAIL_TO_H = 20;

type WeightLevel = "sehr_niedrig" | "niedrig" | "mittel" | "stark" | "sehr_stark";
const WEIGHT_LEVELS: WeightLevel[] = ["sehr_niedrig", "niedrig", "mittel", "stark", "sehr_stark"];
const WEIGHT_VALUES: Record<WeightLevel, number> = { sehr_niedrig: 1, niedrig: 2, mittel: 4, stark: 8, sehr_stark: 16 };
const WEIGHT_LABELS: Record<WeightLevel, string> = { sehr_niedrig: "Sehr niedrig", niedrig: "Niedrig", mittel: "Mittel", stark: "Stark", sehr_stark: "Sehr stark" };

interface HourData {
  temp: number;
  rain: number;
  wind: number;
  uv: number;
}

interface Criteria {
  noRain: boolean;
  maxRainProb: number;
  minTemp: number;
  maxTemp: number;
  maxWind: number;
  maxUV: number;
  allowDark: boolean;
}

interface Weights {
  rain: WeightLevel;
  temp: WeightLevel;
  wind: WeightLevel;
  uv: WeightLevel;
}

interface DayConfig {
  enabled: boolean;
  from: string;
  to: string;
}

interface Location {
  name: string;
  lat: number;
  lon: number;
}

interface Suggestion {
  name: string;
  admin1: string;
  country: string;
  lat: number;
  lon: number;
}

interface SlotResult {
  start: number;
  level: "green" | "red";
  score: number;
  issues: string[];
  warnings: string[];
  tips: string[];
  stats: { avgTemp: number; maxWind: number; maxRain: number; maxUV: number };
}

interface DayResult {
  date: string;
  from: string;
  to: string;
  sun: { sunrise: string; sunset: string };
  slots: SlotResult[];
  allSlots: SlotResult[];
}

function parseHM(s: string): number {
  const t = s.includes("T") ? s.split("T")[1] : s;
  const [h, m] = t.substring(0, 5).split(":").map(Number);
  return h + m / 60;
}
function fmtHour(dh: number): string {
  const h = Math.floor(dh), m = Math.round((dh - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function fmtDate(ds: string): string {
  return new Date(ds + "T12:00").toLocaleDateString("de-AT", { weekday: "long", day: "numeric", month: "long" });
}
function fmtSun(iso: string | undefined): string {
  if (!iso) return "--:--";
  const t = iso.includes("T") ? iso.split("T")[1] : iso;
  return t.substring(0, 5);
}

function evalSlot({ hours, crit, weights, sunriseH, sunsetH, startH, durH }: {
  hours: HourData[];
  crit: Criteria;
  weights: Weights;
  sunriseH: number | null;
  sunsetH: number | null;
  startH: number;
  durH: number;
}): Omit<SlotResult, "start"> {
  const blocked = new Set<string>(), warns = new Set<string>();
  if (!crit.allowDark && sunriseH !== null && sunsetH !== null) {
    if (startH < sunriseH - 0.05) blocked.add(`Vor Sonnenaufgang (${fmtHour(sunriseH)})`);
    if (startH + durH > sunsetH + 0.05) blocked.add(`Nach Sonnenuntergang (${fmtHour(sunsetH)})`);
  }
  const avgTemp = hours.reduce((s, h) => s + h.temp, 0) / hours.length;
  const maxWind = Math.max(...hours.map(h => h.wind));
  const maxRain = Math.max(...hours.map(h => h.rain));
  const maxUV = Math.max(...hours.map(h => h.uv));
  if (avgTemp < crit.minTemp) blocked.add(`Zu kalt (Ø${avgTemp.toFixed(1)}°C)`);
  if (avgTemp > crit.maxTemp) blocked.add(`Zu heiß (Ø${avgTemp.toFixed(1)}°C)`);
  if (maxWind > crit.maxWind) blocked.add(`Zu windig (${maxWind.toFixed(0)} km/h)`);
  if (crit.noRain && maxRain > crit.maxRainProb) blocked.add(`Regen ${maxRain}%`);
  if (maxUV > crit.maxUV) warns.add(`UV-Index ${maxUV.toFixed(0)}`);
  const level: SlotResult["level"] = blocked.size > 0 ? "red" : "green";

  const rainScore = Math.max(1 - maxRain / 100, 0);
  const tempFalloff = Math.max((crit.maxTemp - crit.minTemp) / 2, 1);
  const tempMiss = avgTemp < crit.minTemp ? crit.minTemp - avgTemp : avgTemp > crit.maxTemp ? avgTemp - crit.maxTemp : 0;
  const tempScore = Math.max(1 - tempMiss / tempFalloff, 0);
  const windScore = Math.max(1 - maxWind / Math.max(crit.maxWind * 2, 40), 0);
  const uvScore = Math.max(1 - maxUV / Math.max(crit.maxUV * 2, 11), 0);
  const wr = WEIGHT_VALUES[weights.rain], wt = WEIGHT_VALUES[weights.temp], ww = WEIGHT_VALUES[weights.wind], wu = WEIGHT_VALUES[weights.uv];
  const wsum = wr + wt + ww + wu || 1;
  const score = Math.round(((rainScore * wr + tempScore * wt + windScore * ww + uvScore * wu) / wsum) * 100);

  const tips: string[] = [];
  const cold: string[] = [];
  if (avgTemp < 18) cold.push("Schlauchschal");
  if (avgTemp < 15) cold.push("Mütze");
  if (avgTemp < 11) cold.push("Handschuhe");
  if (cold.length) tips.push(`🧣 ${cold.join(", ")}`);
  if (avgTemp > 28) tips.push("💧 Viel trinken, ggf. früher fahren");
  else if (avgTemp > 24) tips.push("💧 Genug Wasser mitnehmen");
  if (maxRain >= 30) tips.push("🧥 Regenjacke einpacken");
  else if (maxRain >= 15) tips.push("☔ Regen möglich – Jacke griffbereit");
  if (maxWind >= 30) tips.push("🌬️ Windjacke, mit Gegenwind rechnen");
  else if (maxWind >= 20) tips.push("🌬️ Windjacke kann helfen");
  if (maxUV >= 7) tips.push("🧴 Sonnencreme & Sonnenbrille");
  else if (maxUV >= 5) tips.push("🧴 Sonnencreme nicht vergessen");

  return { level, score, issues: [...blocked], warnings: [...warns], tips, stats: { avgTemp, maxWind, maxRain, maxUV } };
}

interface WeatherData {
  hourly: {
    time: string[];
    temperature_2m: number[];
    precipitation_probability: number[];
    windspeed_10m: number[];
    uv_index: number[];
  };
  daily: {
    time: string[];
    sunrise: string[];
    sunset: string[];
  };
}

function computeResults(data: WeatherData, days: Record<string, DayConfig>, durH: number, crit: Criteria, weights: Weights): DayResult[] {
  const { hourly, daily } = data;
  const byHour: Record<string, HourData> = {};
  hourly.time.forEach((t, i) => {
    byHour[t] = {
      temp: hourly.temperature_2m[i] ?? 15,
      rain: hourly.precipitation_probability[i] ?? 0,
      wind: hourly.windspeed_10m[i] ?? 0,
      uv: hourly.uv_index[i] ?? 0,
    };
  });
  const sunMap: Record<string, { sunrise?: string; sunset?: string }> = {};
  (daily.time || []).forEach((d, i) => { sunMap[d] = { sunrise: daily.sunrise?.[i], sunset: daily.sunset?.[i] }; });

  return Object.entries(days).filter(([, c]) => c.enabled).map(([dayKey, cfg]) => {
    const sun = sunMap[dayKey] || {};
    const sunriseH = sun.sunrise ? parseHM(sun.sunrise) : null;
    const sunsetH = sun.sunset ? parseHM(sun.sunset) : null;
    const fromH = parseHM(cfg.from), toH = parseHM(cfg.to);
    const scanFromH = Math.min(DETAIL_FROM_H, fromH);
    const scanToH = Math.max(DETAIL_TO_H, toH);
    const allSlots: SlotResult[] = [];
    for (let sH = scanFromH; sH + durH <= scanToH + 0.01; sH += 0.5) {
      const hours: HourData[] = [];
      for (let dh = 0; dh < Math.ceil(durH); dh++) {
        const tk = `${dayKey}T${String(Math.floor(sH) + dh).padStart(2, "0")}:00`;
        if (byHour[tk]) hours.push(byHour[tk]);
      }
      if (!hours.length) continue;
      const ev = evalSlot({ hours, crit, weights, sunriseH, sunsetH, startH: sH, durH });
      allSlots.push({ start: sH, ...ev });
    }
    allSlots.sort((a, b) => a.start - b.start);
    const inWindow = allSlots.filter(s => s.start >= fromH - 0.01 && s.start + durH <= toH + 0.01);
    const kept: SlotResult[] = [];
    const tryAdd = (pool: SlotResult[]) => {
      for (const s of pool) {
        if (kept.length >= 3) break;
        if (!kept.some(ks => Math.abs(ks.start - s.start) < 1)) kept.push(s);
      }
    };
    tryAdd(inWindow.filter(s => s.level === "green").sort((a, b) => b.score - a.score));
    if (kept.length < 3) {
      tryAdd(inWindow.filter(s => s.level === "red").sort((a, b) => b.score - a.score));
    }
    kept.sort((a, b) => b.score - a.score);
    return { date: dayKey, from: cfg.from, to: cfg.to, sun: { sunrise: fmtSun(sun.sunrise), sunset: fmtSun(sun.sunset) }, slots: kept, allSlots };
  });
}

const LVLS = {
  green: { bg: "bg-green-50 dark:bg-green-900/20", border: "border-green-400 dark:border-green-700", dot: "bg-green-500", badge: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300", label: "Geeignet" },
  red:   { bg: "bg-red-50 dark:bg-red-900/20",     border: "border-red-300 dark:border-red-800",     dot: "bg-red-400",   badge: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",       label: "Nicht empfohlen" },
};

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${on ? "bg-blue-500" : "bg-gray-300 dark:bg-slate-600"}`}>
      <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all duration-200 ${on ? "left-6" : "left-1"}`} />
    </button>
  );
}

function Slider({ label, min, max, step, value, onChange }: {
  label: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between">
        <span className="text-sm text-gray-600 dark:text-slate-300">{label}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)} className="w-full accent-blue-500" />
      <div className="flex justify-between text-xs text-gray-400 dark:text-slate-500"><span>{min}</span><span>{max}</span></div>
    </div>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-gray-100 dark:border-slate-700 p-4 ${className}`}>{children}</div>;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 mb-3">{children}</h2>;
}

function WeightSelector({ label, value, onChange }: { label: string; value: WeightLevel; onChange: (v: WeightLevel) => void }) {
  return (
    <div>
      <div className="text-sm font-medium text-gray-700 dark:text-slate-200 mb-1.5">{label}</div>
      <div className="flex gap-1">
        {WEIGHT_LEVELS.map(lv => (
          <button key={lv} onClick={() => onChange(lv)}
            className={`flex-1 px-1 py-1.5 rounded-lg text-[11px] font-medium transition-all border ${value === lv ? "bg-blue-500 text-white border-blue-500 shadow-sm" : "bg-white dark:bg-slate-700 text-gray-500 dark:text-slate-300 border-gray-200 dark:border-slate-600 hover:border-blue-300"}`}>
            {WEIGHT_LABELS[lv]}
          </button>
        ))}
      </div>
    </div>
  );
}

function PixelCyclist() {
  const tire = "#64748b";
  const spoke = "#cbd5e1";
  const hub = "#1e293b";
  const frame = "#facc15";
  const frameDark = "#ca8a04";
  const jersey = "#ef4444";
  const jerseyDark = "#b91c1c";
  const skin = "#fcd5b5";
  const helmet = "#2563eb";
  const helmetDark = "#1e40af";
  const shorts = "#334155";
  const shoe = "#0f172a";
  const bar = "#94a3b8";
  return (
    <svg viewBox="0 0 36 24" shapeRendering="crispEdges" className="mx-auto w-52 h-auto block drop-shadow-md" xmlns="http://www.w3.org/2000/svg">
      {/* === FRAME (drawn first, under rider) === */}
      {/* top tube */}
      <rect x="11" y="13" width="17" height="1" fill={frame} />
      {/* down tube (handlebars → bottom bracket) */}
      <rect x="9"  y="14" width="1" height="1" fill={frame} />
      <rect x="10" y="15" width="1" height="1" fill={frame} />
      <rect x="11" y="16" width="2" height="1" fill={frame} />
      <rect x="13" y="17" width="2" height="1" fill={frame} />
      <rect x="15" y="18" width="2" height="1" fill={frame} />
      {/* chain stay → rear hub */}
      <rect x="17" y="18" width="11" height="1" fill={frame} />
      {/* seat tube */}
      <rect x="27" y="14" width="1" height="4" fill={frame} />
      <rect x="28" y="14" width="1" height="4" fill={frameDark} />
      {/* fork */}
      <rect x="7"  y="14" width="1" height="5" fill={frame} />
      <rect x="6"  y="14" width="1" height="5" fill={frameDark} />
      {/* handlebars + stem */}
      <rect x="5"  y="12" width="3" height="1" fill={bar} />
      <rect x="7"  y="13" width="1" height="2" fill={bar} />
      <rect x="5"  y="13" width="1" height="3" fill={bar} />
      {/* saddle */}
      <rect x="26" y="12" width="4" height="1" fill={hub} />
      <rect x="27" y="13" width="2" height="1" fill={hub} />

      {/* === RIDER === */}
      {/* helmet */}
      <rect x="22" y="3" width="6" height="1" fill={helmetDark} />
      <rect x="21" y="4" width="8" height="1" fill={helmet} />
      <rect x="21" y="5" width="8" height="1" fill={helmet} />
      <rect x="20" y="5" width="1" height="1" fill={helmetDark} />
      {/* face */}
      <rect x="22" y="6" width="6" height="1" fill={skin} />
      <rect x="27" y="7" width="2" height="1" fill={skin} />
      {/* neck */}
      <rect x="24" y="7" width="2" height="1" fill={skin} />
      {/* torso bent forward */}
      <rect x="14" y="8" width="13" height="1" fill={jersey} />
      <rect x="12" y="9" width="15" height="1" fill={jersey} />
      <rect x="11" y="10" width="16" height="1" fill={jersey} />
      <rect x="11" y="11" width="16" height="1" fill={jerseyDark} />
      {/* arm reaching forward & down to bars */}
      <rect x="10" y="10" width="1" height="1" fill={skin} />
      <rect x="9"  y="11" width="2" height="1" fill={skin} />
      <rect x="8"  y="12" width="2" height="1" fill={skin} />
      <rect x="7"  y="11" width="1" height="2" fill={skin} />
      {/* shorts */}
      <rect x="22" y="12" width="6" height="2" fill={shorts} />
      <rect x="23" y="14" width="5" height="1" fill={shorts} />
      {/* back leg (extended, pedal down) */}
      <rect x="25" y="15" width="2" height="3" fill={shorts} />
      <rect x="25" y="18" width="2" height="1" fill={skin} />
      <rect x="24" y="19" width="4" height="1" fill={shoe} />
      {/* front leg (raised) */}
      <rect x="21" y="15" width="2" height="2" fill={shorts} />
      <rect x="20" y="17" width="3" height="1" fill={shorts} />
      <rect x="19" y="18" width="2" height="1" fill={skin} />
      <rect x="17" y="19" width="4" height="1" fill={shoe} />

      {/* === FRONT WHEEL === */}
      <rect x="3"  y="16" width="3" height="1" fill={tire} />
      <rect x="8"  y="16" width="3" height="1" fill={tire} />
      <rect x="2"  y="17" width="2" height="1" fill={tire} />
      <rect x="10" y="17" width="2" height="1" fill={tire} />
      <rect x="1"  y="18" width="1" height="2" fill={tire} />
      <rect x="12" y="18" width="1" height="2" fill={tire} />
      <rect x="2"  y="20" width="2" height="1" fill={tire} />
      <rect x="10" y="20" width="2" height="1" fill={tire} />
      <rect x="3"  y="21" width="3" height="1" fill={tire} />
      <rect x="8"  y="21" width="3" height="1" fill={tire} />
      {/* spokes */}
      <rect x="2"  y="19" width="10" height="1" fill={spoke} />
      <rect x="6"  y="17" width="2" height="5" fill={spoke} />
      <rect x="6"  y="19" width="2" height="1" fill={hub} />

      {/* === REAR WHEEL === */}
      <rect x="21" y="16" width="3" height="1" fill={tire} />
      <rect x="26" y="16" width="3" height="1" fill={tire} />
      <rect x="20" y="17" width="2" height="1" fill={tire} />
      <rect x="28" y="17" width="2" height="1" fill={tire} />
      <rect x="19" y="18" width="1" height="2" fill={tire} />
      <rect x="30" y="18" width="1" height="2" fill={tire} />
      <rect x="20" y="20" width="2" height="1" fill={tire} />
      <rect x="28" y="20" width="2" height="1" fill={tire} />
      <rect x="21" y="21" width="3" height="1" fill={tire} />
      <rect x="26" y="21" width="3" height="1" fill={tire} />
      {/* spokes */}
      <rect x="20" y="19" width="10" height="1" fill={spoke} />
      <rect x="24" y="17" width="2" height="5" fill={spoke} />
      <rect x="24" y="19" width="2" height="1" fill={hub} />
    </svg>
  );
}

function ThemeToggle({ dark, onToggle }: { dark: boolean; onToggle: () => void }) {
  return (
    <button onClick={onToggle} aria-label="Theme umschalten"
      className="fixed top-3 right-3 z-30 w-10 h-10 rounded-full bg-white/80 dark:bg-slate-800/80 border border-gray-200 dark:border-slate-700 backdrop-blur text-lg shadow-sm hover:scale-105 transition-transform">
      {dark ? "☀️" : "🌙"}
    </button>
  );
}

function SlotCard({ s, dur }: { s: SlotResult; dur: number }) {
  const lv = LVLS[s.level];
  return (
    <div className={`rounded-xl border p-3 ${lv.bg} ${lv.border}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${lv.dot}`} />
          <span className="font-bold text-gray-800 dark:text-slate-100">{fmtHour(s.start)} – {fmtHour(s.start + dur)} Uhr</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-white/70 dark:bg-slate-800/70 text-gray-700 dark:text-slate-200 border border-gray-200 dark:border-slate-600">{s.score}</span>
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${lv.badge}`}>{lv.label}</span>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-x-1 text-xs text-gray-600 dark:text-slate-300">
        <span>🌡️ {s.stats.avgTemp.toFixed(1)}°C</span>
        <span>💨 {s.stats.maxWind.toFixed(0)} km/h</span>
        <span>🌧️ {s.stats.maxRain}%</span>
        <span>☀️ UV {s.stats.maxUV.toFixed(0)}</span>
      </div>
      {s.issues.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {s.issues.map((x, j) => <span key={j} className="text-xs bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300 px-1.5 py-0.5 rounded-md">⚠ {x}</span>)}
        </div>
      )}
      {s.warnings.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {s.warnings.map((x, j) => <span key={j} className="text-xs bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-300 px-1.5 py-0.5 rounded-md">⚠ {x}</span>)}
        </div>
      )}
      {s.tips.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {s.tips.map((x, j) => <span key={j} className="text-xs bg-blue-50 text-blue-700 border border-blue-100 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800 px-1.5 py-0.5 rounded-md">{x}</span>)}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [loc, setLoc] = useState<Location | null>(DEFAULT_LOC);
  const [locQ, setLocQ] = useState(DEFAULT_LOC.name);
  const [sugg, setSugg] = useState<Suggestion[]>([]);
  const [dur, setDur] = useState(1.5);
  const [crit, setCrit] = useState<Criteria>({ noRain: true, maxRainProb: 20, minTemp: 15, maxTemp: 30, maxWind: 20, maxUV: 9, allowDark: false });
  const [weights, setWeights] = useState<Weights>({ rain: "sehr_stark", temp: "stark", wind: "mittel", uv: "sehr_niedrig" });
  const [days, setDays] = useState<Record<string, DayConfig>>(() => {
    const obj: Record<string, DayConfig> = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(); d.setDate(d.getDate() + i);
      const k = d.toISOString().split("T")[0];
      const isWeekend = d.getDay() === 0 || d.getDay() === 6;
      obj[k] = { enabled: true, from: isWeekend ? "07:00" : "16:00", to: isWeekend ? "19:00" : "20:00" };
    }
    return obj;
  });
  const [results, setResults] = useState<DayResult[] | null>(null);
  const [selectedDay, setSelectedDay] = useState<DayResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [geoLoading, setGeoLoading] = useState(false);
  const [dark, setDark] = useState(() => typeof document !== "undefined" && document.documentElement.classList.contains("dark"));

  const toggleDark = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("theme", next ? "dark" : "light"); } catch { /* ignore */ }
  };

  useEffect(() => {
    if (locQ.length < 2) { setSugg([]); return; }
    const t = setTimeout(async () => {
      setGeoLoading(true);
      try {
        const r = await fetch(`${GEO_URL}?name=${encodeURIComponent(locQ)}&count=5&language=de&format=json`);
        const d = await r.json();
        const mapped: Suggestion[] = (d.results || []).map((s: { name: string; admin1?: string; country?: string; latitude: number; longitude: number }) => ({
          name: s.name,
          admin1: s.admin1 || "",
          country: s.country || "",
          lat: s.latitude,
          lon: s.longitude,
        }));
        setSugg(mapped);
      } catch { setSugg([]); }
      setGeoLoading(false);
    }, 500);
    return () => clearTimeout(t);
  }, [locQ]);

  const compute = async () => {
    if (!loc) { setErr("Bitte einen Ort auswählen"); return; }
    const lat = parseFloat(String(loc.lat)), lon = parseFloat(String(loc.lon));
    if (isNaN(lat) || isNaN(lon)) { setErr("Ungültige Koordinaten – bitte Ort erneut auswählen"); return; }
    setLoading(true); setErr("");
    try {
      const params = new URLSearchParams({
        latitude: String(lat),
        longitude: String(lon),
        hourly: "temperature_2m,precipitation_probability,windspeed_10m,uv_index",
        daily: "sunrise,sunset",
        timezone: "auto",
        forecast_days: "7",
      });
      const r = await fetch(`${WEATHER_URL}?${params}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const weatherData: WeatherData = await r.json();
      setResults(computeResults(weatherData, days, dur, crit, weights));
    } catch (e) {
      setErr(`Fehler: ${e instanceof Error ? e.message : "Unbekannter Fehler"}`);
    }
    setLoading(false);
  };

  const upd = <K extends keyof Criteria>(k: K, v: Criteria[K]) => setCrit(c => ({ ...c, [k]: v }));

  if (selectedDay) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 p-4 max-w-lg mx-auto">
        <ThemeToggle dark={dark} onToggle={toggleDark} />
        <div className="flex items-center gap-3 mb-5">
          <button onClick={() => setSelectedDay(null)} className="text-blue-600 dark:text-blue-400 text-sm font-medium hover:underline flex-shrink-0">← Ergebnisse</button>
          <div>
            <h1 className="text-lg font-bold text-gray-800 dark:text-slate-100">{fmtDate(selectedDay.date)}</h1>
            <p className="text-xs text-gray-500 dark:text-slate-400">{selectedDay.from} – {selectedDay.to} · {dur}h Slots · 🌅 {selectedDay.sun.sunrise} 🌇 {selectedDay.sun.sunset}</p>
          </div>
        </div>
        <div className="space-y-2">
          {selectedDay.allSlots.map((s, i) => <SlotCard key={i} s={s} dur={dur} />)}
        </div>
        <p className="text-center text-xs text-gray-400 dark:text-slate-500 mt-4 mb-6">Wetterdaten: open-meteo.com</p>
      </div>
    );
  }

  if (results) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 p-4 max-w-lg mx-auto">
        <ThemeToggle dark={dark} onToggle={toggleDark} />
        <div className="flex items-center gap-3 mb-5">
          <button onClick={() => setResults(null)} className="text-blue-600 dark:text-blue-400 text-sm font-medium hover:underline flex-shrink-0">← Einstellungen</button>
          <div>
            <h1 className="text-lg font-bold text-gray-800 dark:text-slate-100">Trainingsvorschläge</h1>
            <p className="text-xs text-gray-500 dark:text-slate-400">{loc?.name} · {dur}h Training</p>
          </div>
        </div>

        <div className="flex gap-2 flex-wrap mb-4">
          {Object.entries(LVLS).map(([k, v]) => (
            <span key={k} className={`text-xs px-2.5 py-1 rounded-full font-medium ${v.badge}`}>
              <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${v.dot}`} />{v.label}
            </span>
          ))}
        </div>

        {results.map(day => (
          <Card key={day.date} className="mb-4">
            <button className="flex justify-between items-start mb-3 w-full text-left hover:opacity-70 transition-opacity" onClick={() => setSelectedDay(day)}>
              <h3 className="font-semibold text-gray-800 dark:text-slate-100 text-sm">{fmtDate(day.date)}</h3>
              <div className="flex items-start gap-2 flex-shrink-0 ml-2">
                <div className="text-xs text-gray-400 dark:text-slate-500 text-right">
                  🌅 {day.sun.sunrise}<br />🌇 {day.sun.sunset}
                </div>
                <span className="text-gray-300 dark:text-slate-600 text-sm mt-0.5">›</span>
              </div>
            </button>
            {day.slots.length === 0
              ? <p className="text-sm text-gray-400 dark:text-slate-500 italic text-center py-3">Keine Zeitfenster in diesem Bereich verfügbar</p>
              : <div className="space-y-2">
                {day.slots.map((s, i) => <SlotCard key={i} s={s} dur={dur} />)}
              </div>
            }
          </Card>
        ))}
        <p className="text-center text-xs text-gray-400 dark:text-slate-500 mt-1 mb-6">Wetterdaten: open-meteo.com</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 p-4 max-w-lg mx-auto">
      <ThemeToggle dark={dark} onToggle={toggleDark} />
      <div className="text-center mb-6 pt-2">
        <PixelCyclist />
        <h1 className="text-2xl font-bold text-gray-800 dark:text-slate-100 mt-3">Rennrad-Trainingsplaner</h1>
        <p className="text-gray-400 dark:text-slate-500 text-sm mt-1">Optimale Trainingszeiten nach Wetter & Ort</p>
      </div>

      <Card className="mb-4">
        <SectionTitle>📍 Standort</SectionTitle>
        <div className="relative">
          <input type="text" value={locQ} placeholder="Stadt oder Ort eingeben..."
            onChange={e => { setLocQ(e.target.value); setLoc(null); if (!e.target.value) setSugg([]); }}
            className="w-full border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-800 dark:text-slate-100 placeholder:text-gray-400 dark:placeholder:text-slate-500 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300" />
          {geoLoading && <div className="mt-1.5 text-xs text-blue-500 dark:text-blue-400">Suche...</div>}
          {loc && <div className="mt-1.5 text-xs text-green-600 dark:text-green-400 font-medium">✓ {loc.name}</div>}
          {sugg.length > 0 && !loc && (
            <div className="absolute z-20 w-full bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-600 rounded-xl shadow-xl mt-1 overflow-hidden">
              {sugg.map((s, i) => (
                <button key={i} className="w-full text-left px-3 py-2.5 hover:bg-blue-50 dark:hover:bg-slate-700 text-sm text-gray-700 dark:text-slate-200 transition-colors border-b border-gray-50 dark:border-slate-700 last:border-0"
                  onClick={() => {
                    const name = `${s.name}${s.admin1 ? ", " + s.admin1 : ""}, ${s.country}`;
                    setLoc({ name, lat: s.lat, lon: s.lon });
                    setSugg([]);
                    setLocQ(name);
                  }}>
                  <span className="font-medium">{s.name}</span>
                  <span className="text-gray-400 dark:text-slate-500">{s.admin1 ? ` · ${s.admin1}` : ""} · {s.country}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </Card>

      <Card className="mb-4">
        <SectionTitle>⏱️ Trainingsdauer</SectionTitle>
        <div className="flex flex-wrap gap-2">
          {DURATION_OPTS.map(d => (
            <button key={d} onClick={() => setDur(d)}
              className={`px-3.5 py-1.5 rounded-full text-sm font-semibold transition-all border ${dur === d ? "bg-blue-500 text-white border-blue-500 shadow-sm" : "bg-white dark:bg-slate-700 text-gray-600 dark:text-slate-300 border-gray-200 dark:border-slate-600 hover:border-blue-300"}`}>
              {d}h
            </button>
          ))}
        </div>
      </Card>

      <Card className="mb-4">
        <SectionTitle>📅 Verfügbare Tage & Zeitfenster</SectionTitle>
        <div className="space-y-2">
          {Object.entries(days).map(([k, cfg]) => {
            const d = new Date(k + "T12:00");
            const label = d.toLocaleDateString("de-AT", { weekday: "short", day: "numeric", month: "short" });
            return (
              <div key={k} className={`px-2.5 py-2 rounded-xl transition-all ${cfg.enabled ? "bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800" : "bg-gray-50 dark:bg-slate-700/50 border border-gray-100 dark:border-slate-700 opacity-50"}`}>
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={cfg.enabled} onChange={() => setDays(p => ({ ...p, [k]: { ...p[k], enabled: !p[k].enabled } }))} className="w-4 h-4 accent-blue-500 flex-shrink-0" />
                  <span className="text-sm font-medium text-gray-700 dark:text-slate-200">{label}</span>
                </div>
                {cfg.enabled && (
                  <div className="flex items-center gap-1.5 mt-1.5 pl-6">
                    <input type="time" value={cfg.from} onChange={e => setDays(p => ({ ...p, [k]: { ...p[k], from: e.target.value } }))}
                      className="flex-1 min-w-0 border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-800 dark:text-slate-100 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
                    <span className="text-gray-300 dark:text-slate-500 text-xs flex-shrink-0">–</span>
                    <input type="time" value={cfg.to} onChange={e => setDays(p => ({ ...p, [k]: { ...p[k], to: e.target.value } }))}
                      className="flex-1 min-w-0 border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-800 dark:text-slate-100 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <Card className="mb-4">
        <SectionTitle>⚙️ Bedingungen & Ausschlusskriterien</SectionTitle>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-gray-700 dark:text-slate-200">🌙 Bei Dunkelheit fahren erlaubt</div>
              <div className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">Sonnenauf- und -untergang berücksichtigen</div>
            </div>
            <Toggle on={crit.allowDark} onChange={v => upd("allowDark", v)} />
          </div>

          <div className="h-px bg-gray-100 dark:bg-slate-700" />

          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-gray-700 dark:text-slate-200">🌧️ Kein Regen</div>
              <div className="text-xs text-gray-400 dark:text-slate-500 mt-0.5">Regenwahrscheinlichkeit als Ausschlusskriterium</div>
            </div>
            <Toggle on={crit.noRain} onChange={v => upd("noRain", v)} />
          </div>
          {crit.noRain && (
            <Slider label={`Max. Regenwahrscheinlichkeit: ${crit.maxRainProb}%`} min={5} max={80} step={5} value={crit.maxRainProb} onChange={v => upd("maxRainProb", v)} />
          )}

          <div className="h-px bg-gray-100 dark:bg-slate-700" />

          <div>
            <div className="text-sm font-medium text-gray-700 dark:text-slate-200 mb-3">🌡️ Temperatur</div>
            <div className="space-y-3">
              <Slider label={`Mindesttemperatur: ${crit.minTemp}°C`} min={-5} max={20} step={1} value={crit.minTemp} onChange={v => upd("minTemp", v)} />
              <Slider label={`Maximaltemperatur: ${crit.maxTemp}°C`} min={20} max={45} step={1} value={crit.maxTemp} onChange={v => upd("maxTemp", v)} />
            </div>
          </div>

          <div className="h-px bg-gray-100 dark:bg-slate-700" />

          <Slider label={`💨 Max. Wind: ${crit.maxWind} km/h`} min={10} max={80} step={5} value={crit.maxWind} onChange={v => upd("maxWind", v)} />

          <div className="h-px bg-gray-100 dark:bg-slate-700" />

          <Slider label={`☀️ Max. UV-Index: ${crit.maxUV}`} min={3} max={11} step={1} value={crit.maxUV} onChange={v => upd("maxUV", v)} />
        </div>
      </Card>

      <Card className="mb-4">
        <SectionTitle>⚖️ Gewichtung für Score</SectionTitle>
        <div className="space-y-3">
          <WeightSelector label="🌧️ Regen" value={weights.rain} onChange={v => setWeights(w => ({ ...w, rain: v }))} />
          <WeightSelector label="🌡️ Temperatur" value={weights.temp} onChange={v => setWeights(w => ({ ...w, temp: v }))} />
          <WeightSelector label="💨 Wind" value={weights.wind} onChange={v => setWeights(w => ({ ...w, wind: v }))} />
          <WeightSelector label="☀️ UV-Index" value={weights.uv} onChange={v => setWeights(w => ({ ...w, uv: v }))} />
        </div>
      </Card>

      {err && <div className="text-red-600 dark:text-red-400 text-sm text-center mb-3 p-2.5 bg-red-50 dark:bg-red-900/30 rounded-xl border border-red-100 dark:border-red-800">{err}</div>}

      <button onClick={compute} disabled={loading}
        className="w-full bg-blue-600 hover:bg-blue-700 active:scale-[0.98] text-white font-bold py-3.5 rounded-2xl shadow-lg shadow-blue-200 dark:shadow-blue-900/30 transition-all disabled:opacity-50 text-base mb-4">
        {loading ? "⏳ Wetterdaten werden geladen..." : "🔍 Trainingszeiten berechnen"}
      </button>

      <p className="text-center text-xs text-gray-400 dark:text-slate-500 pb-6">Wetterdaten: open-meteo.com · Kostenlos, kein API-Key</p>
    </div>
  );
}
