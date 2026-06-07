# midiMove

Moves the notes of a MIDI clip around in real time while Live runs. Pick one of the built-in motions (pendulum, orbit, wave, drift, bounce, cascade, pulse) or draw your own path, and the notes follow it in sync with the project tempo.

## Download

[Download midiMove-1.2.0.ablx](https://github.com/AntiWorkProTwerk/midiMove/releases/latest/download/midiMove-1.2.0.ablx)

## Use

1. Open Live's **Settings > Extensions** and drag the `.ablx` onto it.
2. Right-click a MIDI clip and pick **midiMove: Browse animations…**.
3. Flip through the modes, tweak the sliders, hit **Apply**. The notes start moving. **Stop animation** puts them back where they were.

The `midiMove ▸` entries in the same right-click menu switch modes directly, no window needed.

## Controls

| Control | What it does |
|---------|--------------|
| **Width (time)** | How far notes travel left and right. |
| **Length (pitch)** | How far notes travel up and down. |
| **Speed** | Motion rate. Lower settings move less per update, which looks smoother while the timeline is playing. |
| **Snap to key** | Keeps the animated pitches inside Live's current key. |
| **Spread** (Draw) | Spaces the notes out along the drawn path. At 0 they all ride together. |
| **Loop** (Draw) | How many beats one lap of the drawn path takes. |
| **Pause** | Freezes the notes wherever they happen to be. Press again to resume. |
| **Undo** | Steps back through what you applied, and restores the original notes at the end. Live's own undo is no help here because every animation frame counts as an edit. |
| **Presets** | The floppy icon saves the current settings for the selected mode, the trash deletes the shown one, and the arrows page through them. Loading a preset only moves the sliders; the clip changes when you Apply. |
| **Preset modes** | The plus in the header saves the whole setup under a name of your own. It shows up in the carousel after the built-ins, and the header trash removes it. |
| **Share code** | Export copies a short `mm1:` code for the current animation. Send it to someone and they can Import it to get the same animation. |

## Build from source

```bash
npm install
npm run package   # produces midiMove-1.2.0.ablx
```
