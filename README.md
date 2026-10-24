# RunSync

**Treadmill speed × watch data, in one file.**

RunSync is a phone-friendly web app (PWA). It merges the speed log from
[QZ / qdomyos-zwift](https://github.com/cagnulein/qdomyos-zwift) into the run file from your watch.
You keep the watch's heart rate, cadence, running dynamics and training effect, and get the
treadmill's real speed, pace and distance. Built for the Amazfit T-Rex 3. It works with any watch
that exports FIT, TCX or GPX.

**Live app:** https://najwanhamidi.github.io/RunSync/ (phone; add it to your home screen to install it)
**Desktop version:** https://najwanhamidi.github.io/RunSync/desktop.html (two-pane layout, keyboard shortcuts; installs as a desktop app from Chrome or Edge)

Earlier versions are kept on the [`backup-v1`](../../tree/backup-v1), [`backup-v2`](../../tree/backup-v2) and [`backup-v3`](../../tree/backup-v3) branches.

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
| **Sensor-delay correction** | The watch reports some metrics late. On the T-Rex 3, cadence and stance time arrive about 7 s after the stride really changes; vertical oscillation is on time. RunSync measures each channel's delay from every clear speed-up, using the fastest channel as the reference, and shifts the late channels back. Heart rate is never shifted, because its lag is physiological. |
| **Belt ramp (optional)** | QZ logs the commanded speed instantly, but a real belt needs a few seconds (≈1 km/h per second). Modelling the ramp removes unrealistic step lengths around speed changes. On the sample run this went from 86 s (v3) to 21 s with delay correction alone, and to 0 s with the ramp as well. |
| **Edit as a set** | When a structured workout is detected, one box changes every lap of a kind. **Make all exact** fixes detection jitter (2:59 / 1:01, 3:01 / 0:59…) so every rep and recovery is exactly 3:00 / 1:00 and later laps shift to follow. It covers all rep lengths, all recovery lengths, the number of reps, names (`Rep #`) and types. Later laps move along and the cool down takes up the difference. You can also shift every boundary ±1 s or snap boundaries onto the treadmill's speed changes. Single-lap editing is still in the table. Everything can be edited **by time or by distance** (e.g. every rep 0.75 km, measured along the synced treadmill distance). |
| **Re-analyze workout** | A workout check that updates as you edit. It shows what the workout now reads as, whether lap boundaries sit on speed changes, any speed change hidden inside a lap (one-tap split), laps mixing speeds, consistency per kind of lap, whether cadence follows speed, unrealistic step lengths, and the total distance. |
| **Desktop** | `desktop.html`: settings on the left, results on the right, laps and km splits side by side, a chart read-out on hover, and drop both files anywhere (it works out which is which). Shortcuts: ←/→ nudge the alignment (Shift = 10 s), E edits laps, Ctrl/⌘+S saves the FIT, 1/2/3 switch tabs. |
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
node test/laps.test.js              # set-wide lap editing
node test/sync.test.js              # sensor delay, belt ramp, distance editing, re-analysis
```

| File | Purpose |
|---|---|
| `js/fit.js` | Byte-preserving FIT decoder/encoder (CRC, developer fields, compressed timestamps) |
| `js/formats.js` | TCX / GPX / CSV readers and writers |
| `js/engine.js` | Alignment, trim, speed transfer, distance fix, segmentation, run-type detection, laps |
| `js/export.js` | Builds the merged FIT; device list |
| `js/plan.js` | Planner model and templates |
| `js/laps.js` | Lap editing: set-wide length / name / type, rep count, shift, snap |
| `js/app.js` | UI |
| `sw.js` | Offline cache. **Bump `CACHE` when you change files** so installed apps update. |
