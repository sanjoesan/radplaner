# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # start Vite dev server
npm run build        # production build to dist/
npm run type-check   # TypeScript type checking (separate from build)
npm run preview      # serve the built dist/ locally
```

There is no lint or test script.

## Architecture

**Radplaner** is a single-page React app that finds optimal road-bike training windows based on weather forecasts. It fetches data from the [Open-Meteo](https://open-meteo.com/) free API (no API key required) and is deployed to GitHub Pages at `/radplaner/`.

### All logic lives in `src/App.tsx`

The app is intentionally monolithic — one 500-line component with:

- **State:** `loc`, `crit` (weather thresholds), `days` (enabled weekdays + time windows), `results`
- **Views:** a settings form and a results list, toggled by whether `results` is set
- **Small UI helpers** defined as local components inside the file: `Toggle`, `Slider`, `Card`, `SectionTitle`

### Core algorithm

`computeResults()` calls the Open-Meteo forecast API, then iterates over every 30-minute slot in the 7-day horizon:

1. `evalSlot()` scores a single slot (0–100) against user-defined `Criteria` — min temp, max wind, max rain probability, max UV, and optional darkness exclusion.
2. Severity levels: green / yellow / orange / red.
3. Top 3 slots per day are returned.

Helper `parseHM(s: string): number` converts `"HH:MM"` strings to decimal hours throughout.

### TypeScript

Strict mode is on (`noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`). The build and type-check are separate scripts — CI runs both.

### Deployment

GitHub Actions (`.github/workflows/deploy.yml`) runs `npm ci && npm run build` on push to `main` and deploys `dist/` to GitHub Pages. Vite `base` is set to `/radplaner/`.
