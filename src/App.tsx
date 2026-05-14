import { useState, useEffect } from "react";

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const DURATION_OPTS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];

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
  level: "green" | "yellow" | "orange" | "red";
  score: number;
  issues: string[];
  warnings: string[];
  notes: string[];
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

function evalSlot({ hours, crit, sunriseH, sunsetH, startH, durH }: {
  hours: HourData[];
  crit: Criteria;
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
  if (avgTemp < crit.minTemp) blocked.add(`Zu kalt (Ø${avgTemp.toFixed(0)}°C)`);
  if (avgTemp > crit.maxTemp) blocked.add(`Zu heiß (Ø${avgTemp.toFixed(0)}°C)`);
  if (maxWind > crit.maxWind) blocked.add(`Zu windig (${maxWind.toFixed(0)} km/h)`);
  if (crit.noRain && maxRain > crit.maxRainProb) blocked.add(`Regen ${maxRain}%`);
  if (maxUV > crit.maxUV) warns.add(`UV-Index ${maxUV.toFixed(0)}`);
  const isBlocked = blocked.size > 0;
  let score = 100;
  if (!isBlocked) {
    if (avgTemp < 15) score -= (15 - avgTemp) * 2.5;
    if (avgTemp > 25) score -= (avgTemp - 25) * 2.5;
    if (maxWind > 15) score -= (maxWind - 15) * 1.5;
    if (maxRain > 10) score -= (maxRain - 10) * 0.7;
    if (maxUV > 5) score -= (maxUV - 5) * 3;
    score = Math.max(0, Math.min(100, score));
  } else score = 0;
  const level: SlotResult["level"] = isBlocked ? "red" : score >= 70 ? "green" : score >= 40 ? "yellow" : "orange";
  const notes: string[] = [];
  if (!isBlocked) {
    if (maxRain <= 10) notes.push("Kaum Regen");
    if (avgTemp >= 15 && avgTemp <= 22) notes.push("Ideale Temp.");
    if (maxWind <= 15) notes.push("Wenig Wind");
    if (maxUV <= 3) notes.push("Geringer UV");
  }
  return { level, score: Math.round(score), issues: [...blocked], warnings: [...warns], notes, stats: { avgTemp, maxWind, maxRain, maxUV } };
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

function computeResults(data: WeatherData, days: Record<string, DayConfig>, durH: number, crit: Criteria): DayResult[] {
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
    const allSlots: SlotResult[] = [];
    for (let sH = fromH; sH + durH <= toH + 0.01; sH += 0.5) {
      const hours: HourData[] = [];
      for (let dh = 0; dh < Math.ceil(durH); dh++) {
        const tk = `${dayKey}T${String(Math.floor(sH) + dh).padStart(2, "0")}:00`;
        if (byHour[tk]) hours.push(byHour[tk]);
      }
      if (!hours.length) continue;
      const ev = evalSlot({ hours, crit, sunriseH, sunsetH, startH: sH, durH });
      allSlots.push({ start: sH, ...ev });
    }
    allSlots.sort((a, b) => b.score - a.score);
    const kept: SlotResult[] = [];
    for (const s of allSlots) {
      if (!kept.some(ks => Math.abs(ks.start - s.start) < 1)) { kept.push(s); if (kept.length >= 3) break; }
    }
    return { date: dayKey, from: cfg.from, to: cfg.to, sun: { sunrise: fmtSun(sun.sunrise), sunset: fmtSun(sun.sunset) }, slots: kept, allSlots: [...allSlots].sort((a, b) => a.start - b.start) };
  });
}

const LVLS = {
  green:  { bg: "bg-green-50",  border: "border-green-400",  dot: "bg-green-500",  badge: "bg-green-100 text-green-700",   label: "Ideal" },
  yellow: { bg: "bg-yellow-50", border: "border-yellow-400", dot: "bg-yellow-400", badge: "bg-yellow-100 text-yellow-700", label: "Akzeptabel" },
  orange: { bg: "bg-orange-50", border: "border-orange-400", dot: "bg-orange-400", badge: "bg-orange-100 text-orange-700", label: "Grenzwertig" },
  red:    { bg: "bg-red-50",    border: "border-red-300",    dot: "bg-red-400",    badge: "bg-red-100 text-red-700",       label: "Nicht empfohlen" },
};

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${on ? "bg-blue-500" : "bg-gray-300"}`}>
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
        <span className="text-sm text-gray-600">{label}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)} className="w-full accent-blue-500" />
      <div className="flex justify-between text-xs text-gray-400"><span>{min}</span><span>{max}</span></div>
    </div>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-white rounded-2xl shadow-sm border border-gray-100 p-4 ${className}`}>{children}</div>;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">{children}</h2>;
}

function SlotCard({ s, dur }: { s: SlotResult; dur: number }) {
  const lv = LVLS[s.level];
  return (
    <div className={`rounded-xl border p-3 ${lv.bg} ${lv.border}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${lv.dot}`} />
          <span className="font-bold text-gray-800">{fmtHour(s.start)} – {fmtHour(s.start + dur)} Uhr</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${lv.badge}`}>{lv.label}</span>
          {s.score > 0 && <span className="text-xs text-gray-400">{s.score}%</span>}
        </div>
      </div>
      <div className="grid grid-cols-4 gap-x-1 text-xs text-gray-600">
        <span>🌡️ {s.stats.avgTemp.toFixed(0)}°C</span>
        <span>💨 {s.stats.maxWind.toFixed(0)} km/h</span>
        <span>🌧️ {s.stats.maxRain}%</span>
        <span>☀️ UV {s.stats.maxUV.toFixed(0)}</span>
      </div>
      {s.issues.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {s.issues.map((x, j) => <span key={j} className="text-xs bg-red-100 text-red-600 px-1.5 py-0.5 rounded-md">⚠ {x}</span>)}
        </div>
      )}
      {s.warnings.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {s.warnings.map((x, j) => <span key={j} className="text-xs bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded-md">⚠ {x}</span>)}
        </div>
      )}
      {s.notes.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {s.notes.map((x, j) => <span key={j} className="text-xs bg-green-100 text-green-600 px-1.5 py-0.5 rounded-md">✓ {x}</span>)}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [loc, setLoc] = useState<Location | null>(null);
  const [locQ, setLocQ] = useState("");
  const [sugg, setSugg] = useState<Suggestion[]>([]);
  const [dur, setDur] = useState(1.5);
  const [crit, setCrit] = useState<Criteria>({ noRain: true, maxRainProb: 20, minTemp: 15, maxTemp: 36, maxWind: 20, maxUV: 9, allowDark: false });
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
      setResults(computeResults(weatherData, days, dur, crit));
    } catch (e) {
      setErr(`Fehler: ${e instanceof Error ? e.message : "Unbekannter Fehler"}`);
    }
    setLoading(false);
  };

  const upd = <K extends keyof Criteria>(k: K, v: Criteria[K]) => setCrit(c => ({ ...c, [k]: v }));

  if (selectedDay) {
    return (
      <div className="min-h-screen bg-slate-50 p-4 max-w-lg mx-auto">
        <div className="flex items-center gap-3 mb-5">
          <button onClick={() => setSelectedDay(null)} className="text-blue-600 text-sm font-medium hover:underline flex-shrink-0">← Ergebnisse</button>
          <div>
            <h1 className="text-lg font-bold text-gray-800">{fmtDate(selectedDay.date)}</h1>
            <p className="text-xs text-gray-500">{selectedDay.from} – {selectedDay.to} · {dur}h Slots · 🌅 {selectedDay.sun.sunrise} 🌇 {selectedDay.sun.sunset}</p>
          </div>
        </div>
        <div className="space-y-2">
          {selectedDay.allSlots.map((s, i) => <SlotCard key={i} s={s} dur={dur} />)}
        </div>
        <p className="text-center text-xs text-gray-400 mt-4 mb-6">Wetterdaten: open-meteo.com</p>
      </div>
    );
  }

  if (results) {
    return (
      <div className="min-h-screen bg-slate-50 p-4 max-w-lg mx-auto">
        <div className="flex items-center gap-3 mb-5">
          <button onClick={() => setResults(null)} className="text-blue-600 text-sm font-medium hover:underline flex-shrink-0">← Einstellungen</button>
          <div>
            <h1 className="text-lg font-bold text-gray-800">Trainingsvorschläge</h1>
            <p className="text-xs text-gray-500">{loc?.name} · {dur}h Training</p>
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
              <h3 className="font-semibold text-gray-800 text-sm">{fmtDate(day.date)}</h3>
              <div className="flex items-start gap-2 flex-shrink-0 ml-2">
                <div className="text-xs text-gray-400 text-right">
                  🌅 {day.sun.sunrise}<br />🌇 {day.sun.sunset}
                </div>
                <span className="text-gray-300 text-sm mt-0.5">›</span>
              </div>
            </button>
            {day.slots.length === 0
              ? <p className="text-sm text-gray-400 italic text-center py-3">Keine Zeitfenster in diesem Bereich verfügbar</p>
              : <div className="space-y-2">
                {day.slots.map((s, i) => <SlotCard key={i} s={s} dur={dur} />)}
              </div>
            }
          </Card>
        ))}
        <p className="text-center text-xs text-gray-400 mt-1 mb-6">Wetterdaten: open-meteo.com</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 max-w-lg mx-auto">
      <div className="text-center mb-6 pt-2">
        <div className="text-4xl mb-2">🚴‍♂️</div>
        <h1 className="text-2xl font-bold text-gray-800">Rennrad-Trainingsplaner</h1>
        <p className="text-gray-400 text-sm mt-1">Optimale Trainingszeiten nach Wetter & Ort</p>
      </div>

      <Card className="mb-4">
        <SectionTitle>📍 Standort</SectionTitle>
        <div className="relative">
          <input type="text" value={locQ} placeholder="Stadt oder Ort eingeben..."
            onChange={e => { setLocQ(e.target.value); setLoc(null); if (!e.target.value) setSugg([]); }}
            className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300" />
          {geoLoading && <div className="mt-1.5 text-xs text-blue-500">Suche...</div>}
          {loc && <div className="mt-1.5 text-xs text-green-600 font-medium">✓ {loc.name}</div>}
          {sugg.length > 0 && !loc && (
            <div className="absolute z-20 w-full bg-white border border-gray-200 rounded-xl shadow-xl mt-1 overflow-hidden">
              {sugg.map((s, i) => (
                <button key={i} className="w-full text-left px-3 py-2.5 hover:bg-blue-50 text-sm transition-colors border-b border-gray-50 last:border-0"
                  onClick={() => {
                    const name = `${s.name}${s.admin1 ? ", " + s.admin1 : ""}, ${s.country}`;
                    setLoc({ name, lat: s.lat, lon: s.lon });
                    setSugg([]);
                    setLocQ(name);
                  }}>
                  <span className="font-medium">{s.name}</span>
                  <span className="text-gray-400">{s.admin1 ? ` · ${s.admin1}` : ""} · {s.country}</span>
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
              className={`px-3.5 py-1.5 rounded-full text-sm font-semibold transition-all border ${dur === d ? "bg-blue-500 text-white border-blue-500 shadow-sm" : "bg-white text-gray-600 border-gray-200 hover:border-blue-300"}`}>
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
              <div key={k} className={`px-2.5 py-2 rounded-xl transition-all ${cfg.enabled ? "bg-blue-50 border border-blue-100" : "bg-gray-50 border border-gray-100 opacity-50"}`}>
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={cfg.enabled} onChange={() => setDays(p => ({ ...p, [k]: { ...p[k], enabled: !p[k].enabled } }))} className="w-4 h-4 accent-blue-500 flex-shrink-0" />
                  <span className="text-sm font-medium text-gray-700">{label}</span>
                </div>
                {cfg.enabled && (
                  <div className="flex items-center gap-1.5 mt-1.5 pl-6">
                    <input type="time" value={cfg.from} onChange={e => setDays(p => ({ ...p, [k]: { ...p[k], from: e.target.value } }))}
                      className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300 bg-white" />
                    <span className="text-gray-300 text-xs flex-shrink-0">–</span>
                    <input type="time" value={cfg.to} onChange={e => setDays(p => ({ ...p, [k]: { ...p[k], to: e.target.value } }))}
                      className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300 bg-white" />
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
              <div className="text-sm font-medium text-gray-700">🌙 Bei Dunkelheit fahren erlaubt</div>
              <div className="text-xs text-gray-400 mt-0.5">Sonnenauf- und -untergang berücksichtigen</div>
            </div>
            <Toggle on={crit.allowDark} onChange={v => upd("allowDark", v)} />
          </div>

          <div className="h-px bg-gray-100" />

          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-gray-700">🌧️ Kein Regen</div>
              <div className="text-xs text-gray-400 mt-0.5">Regenwahrscheinlichkeit als Ausschlusskriterium</div>
            </div>
            <Toggle on={crit.noRain} onChange={v => upd("noRain", v)} />
          </div>
          {crit.noRain && (
            <Slider label={`Max. Regenwahrscheinlichkeit: ${crit.maxRainProb}%`} min={5} max={80} step={5} value={crit.maxRainProb} onChange={v => upd("maxRainProb", v)} />
          )}

          <div className="h-px bg-gray-100" />

          <div>
            <div className="text-sm font-medium text-gray-700 mb-3">🌡️ Temperatur</div>
            <div className="space-y-3">
              <Slider label={`Mindesttemperatur: ${crit.minTemp}°C`} min={-5} max={20} step={1} value={crit.minTemp} onChange={v => upd("minTemp", v)} />
              <Slider label={`Maximaltemperatur: ${crit.maxTemp}°C`} min={20} max={45} step={1} value={crit.maxTemp} onChange={v => upd("maxTemp", v)} />
            </div>
          </div>

          <div className="h-px bg-gray-100" />

          <Slider label={`💨 Max. Wind: ${crit.maxWind} km/h`} min={10} max={80} step={5} value={crit.maxWind} onChange={v => upd("maxWind", v)} />

          <div className="h-px bg-gray-100" />

          <Slider label={`☀️ Max. UV-Index: ${crit.maxUV}`} min={3} max={11} step={1} value={crit.maxUV} onChange={v => upd("maxUV", v)} />
        </div>
      </Card>

      {err && <div className="text-red-600 text-sm text-center mb-3 p-2.5 bg-red-50 rounded-xl border border-red-100">{err}</div>}

      <button onClick={compute} disabled={loading}
        className="w-full bg-blue-600 hover:bg-blue-700 active:scale-[0.98] text-white font-bold py-3.5 rounded-2xl shadow-lg shadow-blue-200 transition-all disabled:opacity-50 text-base mb-4">
        {loading ? "⏳ Wetterdaten werden geladen..." : "🔍 Trainingszeiten berechnen"}
      </button>

      <p className="text-center text-xs text-gray-400 pb-6">Wetterdaten: open-meteo.com · Kostenlos, kein API-Key</p>
    </div>
  );
}
