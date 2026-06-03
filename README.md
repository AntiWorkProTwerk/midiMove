# midiMove

An [Ableton Live Extension](https://www.ableton.com/) that animates a MIDI clip's note grid **live**, moving the notes with physics in real time while the clip plays.

The first mode is a **pendulum**: the whole note column swings horizontally across the time axis and bobs slightly in pitch at the extremes, like a bob on a rod. The swing is **tempo-synced** — its period is defined in beats and scales with the project BPM.

## How it works

Live's extension API exposes no transport/play-head position, so the motion is driven by a real-time timer in the Extension Host that rewrites `clip.notes` each frame (~15 fps). Physics:

```
dx = A·sin(θ)        // horizontal swing along the time axis (beats)
dy = A·(1 − cos θ)   // slight vertical pitch bob (rises at both extremes)
```

The engine is built around a pure `SimulationFn` (`(restNotes, elapsedSeconds, ctx) => notes`), so adding new modes (spring, gravity-bounce, orbit) is just another function plus a Start command.

## Usage

1. Enable Live's **Preferences → Extensions → Developer Mode**.
2. `npm install` then `npm start` to build and launch the Extension Host.
3. Right-click a MIDI clip → **Pendulum: Start** / **Stop Animation**.

An empty clip is seeded with a centered C-E-G triad to swing. Stopping restores the original notes.

## Notes

- Not locked to Live's play head (no transport API); the grid animates whenever a mode is running, and tempo only scales the swing rate.
- Each frame is an undoable edit, so undo history grows while animating; Stop's restore is the final entry.
- Building requires the Ableton Extensions SDK (`@ableton-extensions/sdk`) and CLI, which are not redistributed here per Ableton's license.

## License

Extension code © its author. The Ableton Extensions SDK is subject to Ableton's own license and is not included in this repository.
