# RunSync

**Treadmill speed × watch data, in one file.**

RunSync is a phone-friendly web app (PWA). It merges the speed log from
[QZ / qdomyos-zwift](https://github.com/cagnulein/qdomyos-zwift) into the run file from your watch.
You keep the watch's heart rate, cadence, running dynamics and training effect, and get the
treadmill's real speed, pace and distance. Built for the Amazfit T-Rex 3. It works with any watch
that exports FIT, TCX or GPX.

**Live app:** https://najwanhamidi.github.io/RunSync/ (add it to your home screen to install it)

Everything runs in the browser. Files are never uploaded.

## What it does

| | |
|---|---|
| **Inputs** | Watch file (`.fit` `.tcx` `.gpx` `.csv`) + treadmill file (QZ `.fit`, or `.tcx` `.gpx` `.csv`). The treadmill file is optional: you can use a manual plan, or the watch's own pace scaled to your actual distance. |
| **Alignment** | Matches the two files by clock time, so it doesn't matter if QZ and the watch were started a few seconds apart. If the clocks disagree (e.g. a time-zone mismatch) it falls back to whole-quarter-hour shifts, then watch laps, then the cadence pattern. You can fine-tune by ±1 s / ±10 s against a chart. |
| **Startup trim** | QZ often reports ~0.8 km/h for about 2 s before the set speed takes hold. Anything below a threshold (default 3 km/h), plus any ramp-up, is removed. The file starts when the intended speed is set. |
| **Actual distance** | Enter the real distance. If the data is short, seconds are added at the end at the last speed, with HR and cadence carried over from the final real seconds. Nothing earlier changes. If the data is long, the end is cut where the distance is reached. You can also choose to scale all speeds proportionally. |
| **Step length** | Optionally recalculates step length and vertical ratio from treadmill speed ÷ cadence. The watch's own figures come from its inaccurate pace. |
| **Run type & laps** | Detects intervals (warm up / reps / recoveries / cool down), pyramid, fartlek, progression, tempo, and easy or long runs (1 km splits). Laps can also be every N km, the watch's own laps, or one lap. You can edit them: change type, rename, change a lap's length, split, merge. |
| **Planner** | Build workouts without any files: steps by time, distance or "until end", nested repeat blocks, speed or pace input, totals, a profile chart, and lap and km split tables. Save plans, use templates, import/export JSON, or use a plan as the speed source for a watch-only sync. |
| **Export** | **FIT**: a lossless edit of the watch FIT that keeps every original message and developer field. You also get **TCX**, **GPX** (a virtual straight track, since a treadmill run has no GPS), per-second **CSV** and **laps CSV**. You can choose which device the file reports (default Amazfit T-Rex 3; Garmin models and others are available). |

## Hosting on GitHub Pages

1. Repo → **Settings → Pages**
2. *Build and deployment*: **Deploy from a branch**, branch `main`, folder `/ (root)`
3. Open `https://<user>.github.io/RunSync/`

There's no build step. It's plain HTML, CSS and ES modules.

## Development

```bash
npm run serve                       # http://localhost:8080
node test/sample.test.js watch.fit qz.fit 12.2 test/out   # end-to-end on real files
node test/detect.test.js            # run-type detection on synthetic workouts
```

| File | Purpose |
|---|---|
| `js/fit.js` | Byte-preserving FIT decoder/encoder (CRC, developer fields, compressed timestamps) |
| `js/formats.js` | TCX / GPX / CSV readers and writers |
| `js/engine.js` | Alignment, trim, speed transfer, distance fix, segmentation, run-type detection, laps |
| `js/export.js` | Builds the merged FIT; device list |
| `js/plan.js` | Planner model and templates |
| `js/app.js` | UI |
| `sw.js` | Offline cache. **Bump `CACHE` when you change files** so installed apps update. |
