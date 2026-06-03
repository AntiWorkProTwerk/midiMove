# midiMove

An [Ableton Live Extension](https://www.ableton.com/) that animates a MIDI clip's note grid **live**, moving the notes with physics in real time while the clip plays.

Five physics modes ship today, picked from a carousel window:

- **Pendulum** — the whole note column swings across the time axis and bobs slightly in pitch at the extremes, like a bob on a rod (tempo-synced).
- **Spring Bounce** — the column is plucked and overshoots, settling with damped-spring physics, re-triggered every couple of beats.
- **Orbit** — each note rides a small circle in (time, pitch), spread around the ring so the chord rotates.
- **Wave** — a sine travels across the notes by start-time, so each note bobs in pitch a step behind the last (a Mexican wave).
- **Gravity Drop** — notes fall in pitch under gravity and bounce at the bottom, losing energy each bounce, then re-drop.

## How it works

Live's extension API exposes no transport/play-head position, so the motion is driven by a real-time timer in the Extension Host that rewrites `clip.notes` each frame (~15 fps). Physics:

```
dx = A·sin(θ)        // horizontal swing along the time axis (beats)
dy = A·(1 − cos θ)   // slight vertical pitch bob (rises at both extremes)
```

The engine is built around a pure `SimulationFn` (`(restNotes, elapsedSeconds, ctx) => notes`). Each mode is one such function plus a metadata entry in the `MODES` registry — that registry drives both the animation and the chooser window automatically, so adding a mode is a single edit.

The **chooser** is an HTML carousel shown via `ui.showModalDialog`. Because the dialog is modal (it can't preview on the real clip behind it), each mode renders an animated `<canvas>` preview *inside the window*. The shared `PHYSICS` constants block is the single source of truth: it's injected into the window so the preview and the live clip animate with identical numbers.

## Usage

1. Enable Live's **Preferences → Extensions → Developer Mode**.
2. `npm install` then `npm start` to build and launch the Extension Host.
3. Right-click a MIDI clip → **midiMove: Animate…** to open the carousel. Flip with **◀ / ▶** (or arrow keys), watch the preview, then **Apply** (Enter). The window stays open across applies — keep auditioning modes, then **Close** (Esc). **midiMove: Stop Animation** — or the window's **Stop** — restores the clip.

> The window re-opens itself after each Apply because Live's `showModalDialog` is one-shot; that's what lets it "stay open" while still messaging the host.

An empty clip is seeded with a centered C-E-G triad to animate. Stopping restores the original notes.

## Notes

- Not locked to Live's play head (no transport API); the grid animates whenever a mode is running, and tempo only scales the swing rate.
- Each frame is an undoable edit, so undo history grows while animating; Stop's restore is the final entry.
- Building requires the Ableton Extensions SDK (`@ableton-extensions/sdk`) and CLI, which are not redistributed here per Ableton's license.

## License

Extension code © its author. The Ableton Extensions SDK is subject to Ableton's own license and is not included in this repository.
