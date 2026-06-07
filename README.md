# midiMove

Animates a MIDI clip's notes in real time — swing, orbit, ripple, drift, bounce, cascade, pulse, or a motion path you draw yourself — synced to the project tempo.

## Download

[Download midiMove-1.2.0.ablx](https://github.com/AntiWorkProTwerk/midiMove/releases/latest/download/midiMove-1.2.0.ablx)

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
| **Speed** | Motion rate; lower moves less per update and looks smoother while the timeline plays. |
| **Snap to key** | Quantizes the animated pitches to Live's current key/scale. |
| **Spread** (Draw) | Fans the notes out along the drawn path — 0 rides together, 1 spaces them evenly. |
| **Loop** (Draw) | How many beats one trip around the drawn path takes. |
| **Pause** | Freezes the notes exactly where they are (Stop snaps them back to rest); press again to resume. |
| **Undo** | Steps back through the applied animations; when none is left it restores the original notes. (Live's own Ctrl+Z can't help here — every animation frame is an edit.) |
| **Presets 💾 🗑 ◀ n/N ▶** | The floppy saves the current settings as a preset for the selected mode, the trash deletes the shown one, and the arrows flip through them — the controls slide into place but nothing touches the clip until **Apply**. |
| **➕ / 🗑 (header)** | ➕ saves the current setup as a **named preset mode** that lives in the carousel after the built-ins; the header trash deletes custom ones. |
| **Share code** | **Export** copies an `mm1:` code of the current animation; **Import** pastes one in to load it. |

## Build from source

```bash
npm install
npm run package   # → midiMove-1.2.0.ablx
```
