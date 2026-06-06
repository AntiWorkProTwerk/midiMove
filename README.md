# midiMove

Animates a MIDI clip's notes in real time — swing, orbit, ripple, drift, bounce, cascade, pulse, or a motion path you draw yourself — synced to the project tempo.

## Download

[Download midiMove-1.0.1.ablx](https://github.com/AntiWorkProTwerk/midiMove/releases/latest/download/midiMove-1.0.1.ablx)

## Use

1. Open Live's **Settings → Extensions** and drag the `.ablx` onto it.
2. Right-click a MIDI clip → **midiMove: Browse animations…**.
3. Flip through the modes (or trace your own loop in **Draw**), tweak the controls, and hit **Apply** — the clip's notes start moving live; **Stop animation** puts them back.

## Controls

Eight modes — Pendulum, Orbit, Wave, Drift, Bounce, Cascade, Pulse and a freehand **Draw** pad — rewrite the clip's notes each frame, tempo-synced. The `midiMove ▸` right-click items switch modes instantly without the window.

| Control | What it does |
|---------|--------------|
| **Width (time)** | Scales how far notes travel along the time axis; higher swings wider. |
| **Length (pitch)** | Scales how far notes travel in pitch; higher reaches further up and down. |
| **Snap to key** | Quantizes the animated pitches to Live's current key/scale. |
| **Spread** (Draw) | Fans the notes out along the drawn path — 0 rides together, 1 spaces them evenly. |
| **Loop** (Draw) | How many beats one trip around the drawn path takes. |
| **Share code** | **Export** copies an `mm1:` code of the current animation; **Import** pastes one in to load it. |

## Build from source

```bash
npm install
npm run package   # → midiMove-1.0.1.ablx
```
