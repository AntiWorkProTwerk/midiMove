import * as fs from "node:fs";
import * as path from "node:path";

// The bundle is CJS (see build.ts), so __dirname exists at runtime even though
// the TS source is typed as ESM.
declare const __dirname: string;

import {
  initialize,
  MidiClip,
  type ActivationContext,
  type Handle,
  type NoteDescription,
} from "@ableton-extensions/sdk";

// The carousel chooser window. esbuild inlines this as a string (see build.ts
// loader) so we can serve it as a `data:` URL to showModalDialog.
import chooserHtml from "./chooser.html";

type MidiClipV = MidiClip<"1.0.0">;

// ---------------------------------------------------------------------------
// Simulation abstraction
//
// A physics mode is a pure function: given the clip's "rest" note layout and
// how long the animation has been running, return the notes for this frame.
// Each entry in MODES pairs one of these with display metadata and gets a slot
// in the chooser window automatically.
// ---------------------------------------------------------------------------
// Per-frame context handed to every mode: bar length and live tempo, plus the
// user's amplitude scales and a pitch-snapping function (driven by the chooser's
// Width / Length sliders and "Snap to key" toggle).
type PathPoint = readonly [number, number]; // normalized (dx, dy) in [-1, 1]
type SimContext = {
  barLen: number;
  tempo: number;
  width: number; // time-amplitude multiplier
  height: number; // pitch-amplitude multiplier
  snap: (pitch: number) => number; // identity, or snap-to-scale
  // Draw mode only: the looping path the notes ride, how far notes are fanned
  // out along it, and the loop length in beats. Other modes ignore these.
  periodBeats: number;
  spread: number;
  path: readonly PathPoint[] | null;
};
type SimulationFn = (
  restNotes: readonly NoteDescription[],
  elapsedSeconds: number,
  sim: SimContext,
) => NoteDescription[];

// User-tunable options carried with each running animation.
type AnimOptions = {
  width: number;
  height: number;
  snapToKey: boolean;
  // Live applies at most ~8 clip edits/s while the timeline plays, so perceived
  // smoothness comes from moving LESS per frame: lower speed = smaller steps.
  speed: number;
};
const DEFAULT_OPTIONS: AnimOptions = {
  width: 1,
  height: 1,
  snapToKey: false,
  speed: 1,
};

// The full description of an animation — the unit the engine, the chooser
// window, and the shareable code all speak. `path` is present only for "path".
type AnimationSpec = {
  modeId: string;
  options: AnimOptions;
  periodBeats: number;
  path?: { points: PathPoint[]; spread: number };
};

const clamp = (value: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, value));

// Places one note: applies the per-axis amplitude scales, optional key-snap, and
// the grid clamps. Every mode funnels its (dx, dy) displacement through here, so
// Width / Length / Snap behave identically across all modes.
const place = (
  rest: NoteDescription,
  dx: number,
  dy: number,
  ctx: SimContext,
): NoteDescription => {
  const hi = Math.max(0, ctx.barLen - rest.duration);
  const pitch = ctx.snap(Math.round(rest.pitch + dy * ctx.height));
  // Quantize to a 1/192-beat grid — invisible at any zoom, but it makes
  // consecutive low-motion frames byte-identical so the identical-frame skip
  // in the engine loop can actually suppress redundant writes.
  const startTime = Math.round((rest.startTime + dx * ctx.width) * 192) / 192;
  return {
    ...rest, // preserve velocity / muted / probability / etc.
    startTime: clamp(startTime, 0, hi),
    pitch: clamp(pitch, 0, 127),
  };
};

// Snap a MIDI pitch to the nearest note of Live's current scale. `root` is a
// pitch class (0–11); `intervals` are semitone offsets from the root.
const snapToScale = (
  pitch: number,
  root: number,
  intervals: readonly number[],
): number => {
  if (intervals.length === 0) return pitch;
  const allowed = new Set(intervals.map((iv) => (((iv + root) % 12) + 12) % 12));
  for (let d = 0; d <= 6; d++) {
    if (allowed.has((((pitch - d) % 12) + 12) % 12)) return pitch - d;
    if (allowed.has((((pitch + d) % 12) + 12) % 12)) return pitch + d;
  }
  return pitch;
};

// ---------------------------------------------------------------------------
// Physics constants — single source of truth
//
// These are read by the simulation functions below AND injected into the
// chooser window (see chooserUrl), so the in-window canvas preview animates
// with the exact same numbers as the real clip. Tune a value here and both the
// preview and the live animation move together.
// ---------------------------------------------------------------------------
const PHYSICS = {
  // Pendulum: the column swings as one rigid bob, easing at each extreme.
  //   dx = hAmp·sin θ          horizontal swing along the time axis (beats)
  //   dy = vAmp·(1 − cos θ)    pitch lifts at *both* extremes (subtle, 2× rate)
  pendulum: { periodBeats: 4, theta0: 1.0, hAmp: 1.0, vAmp: 2 },
  // Orbit: each note rides a circle in (time, pitch), spread around the ring.
  orbit: { periodBeats: 3, rTime: 0.6, rPitch: 4 },
  // Wave: a sine travels across the notes by start-time (a traveling ripple).
  wave: { periodBeats: 2, ampPitch: 5 },
  // Drift: each note wanders its own smooth noise path (flow-field feel).
  drift: { rate: 0.55, ampTime: 1.0, ampPitch: 6 },
  // Bounce: notes ricochet on straight paths, reflecting off the clip edges.
  bounce: { vTime: 0.31, vPitch: 0.23, ampTime: 1.2, ampPitch: 7 },
  // Cascade: a sweep pops each note up-and-back in turn, with overshoot.
  cascade: { sweepBeats: 2, decay: 4.5, freq: 1.2, ampPitch: 7, ampTime: 0.35 },
  // Pulse: the chord breathes, scaling out from and back to its centroid.
  pulse: { periodBeats: 2, amp: 0.7 },
  // Draw: base reach for normalized [-1,1] path coords (then × Width / Length).
  path: { ampTime: 1.6, ampPitch: 8, periodBeats: 4 },
} as const;

const beatsOf = (elapsedSeconds: number, tempo: number) =>
  elapsedSeconds * (tempo / 60);

// Smooth, deterministic pseudo-noise in ~[-1, 1] — a sum of incommensurate
// sines. Stateless, so the engine and the in-window preview stay in lock-step.
const smoothNoise = (seed: number, t: number): number =>
  (Math.sin(t * 1.1 + seed) +
    Math.sin(t * 1.7 + seed * 2.3 + 1.3) +
    Math.sin(t * 0.6 + seed * 3.7 + 2.9)) /
  3;

// Triangle wave in [-1, 1] (period 1): linear ramps with sharp reflections,
// which read as hard "bounces" off a wall.
const triWave = (u: number): number => {
  const f = u - Math.floor(u);
  return f < 0.5 ? 4 * f - 1 : 3 - 4 * f;
};

// Sample a closed path of normalized points at loop phase [0,1) with wraparound
// linear interpolation. MUST stay identical to the window's sampler so the
// preview matches the live clip.
const samplePath = (points: readonly PathPoint[], phase: number): PathPoint => {
  const n = points.length;
  if (n === 0) return [0, 0];
  if (n === 1) return points[0]!;
  const f = ((phase % 1) + 1) % 1; // wrap into [0,1)
  const t = f * n; // index space, [0, n)
  const i = Math.floor(t) % n;
  const j = (i + 1) % n;
  const frac = t - Math.floor(t);
  const a = points[i]!;
  const b = points[j]!;
  return [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac];
};

// ---------------------------------------------------------------------------
// Pendulum mode (tempo-synced)
// ---------------------------------------------------------------------------
const pendulum: SimulationFn = (restNotes, elapsedSeconds, ctx) => {
  const p = PHYSICS.pendulum;
  const beats = beatsOf(elapsedSeconds, ctx.tempo);
  const theta = p.theta0 * Math.cos(((2 * Math.PI) / p.periodBeats) * beats);
  const dx = p.hAmp * Math.sin(theta);
  const dy = p.vAmp * (1 - Math.cos(theta));
  return restNotes.map((rest) => place(rest, dx, dy, ctx));
};

// ---------------------------------------------------------------------------
// Orbit mode — each note rides a circle, spread evenly around the ring
// ---------------------------------------------------------------------------
const orbit: SimulationFn = (restNotes, elapsedSeconds, ctx) => {
  const p = PHYSICS.orbit;
  const beats = beatsOf(elapsedSeconds, ctx.tempo);
  const ang = (2 * Math.PI * beats) / p.periodBeats;
  const n = restNotes.length || 1;
  return restNotes.map((rest, i) => {
    const phase = (i / n) * 2 * Math.PI; // notes spread around the circle
    return place(rest, p.rTime * Math.cos(ang + phase), p.rPitch * Math.sin(ang + phase), ctx);
  });
};

// ---------------------------------------------------------------------------
// Drift mode — each note wanders its own smooth noise path (a flow field)
// ---------------------------------------------------------------------------
const drift: SimulationFn = (restNotes, elapsedSeconds, ctx) => {
  const p = PHYSICS.drift;
  const t = beatsOf(elapsedSeconds, ctx.tempo) * p.rate;
  return restNotes.map((rest, i) => {
    const seed = (i + 1) * 1.7;
    return place(rest, p.ampTime * smoothNoise(seed, t), p.ampPitch * smoothNoise(seed + 100, t), ctx);
  });
};

// ---------------------------------------------------------------------------
// Bounce mode — notes ricochet on straight paths, reflecting off the edges
//
// Each axis is a triangle wave with its own speed, so the path precesses and
// reflects sharply, like a ball loose in a box (the "DVD logo" bounce).
// ---------------------------------------------------------------------------
const bounce: SimulationFn = (restNotes, elapsedSeconds, ctx) => {
  const p = PHYSICS.bounce;
  const beats = beatsOf(elapsedSeconds, ctx.tempo);
  return restNotes.map((rest, i) =>
    place(
      rest,
      p.ampTime * triWave(beats * p.vTime + i * 0.37),
      p.ampPitch * triWave(beats * p.vPitch + i * 0.61 + 0.25),
      ctx,
    ),
  );
};

// ---------------------------------------------------------------------------
// Wave mode — a sine travels across the notes by start-time
// ---------------------------------------------------------------------------
const wave: SimulationFn = (restNotes, elapsedSeconds, ctx) => {
  const p = PHYSICS.wave;
  const beats = beatsOf(elapsedSeconds, ctx.tempo);
  const wavelength = ctx.barLen > 0 ? ctx.barLen : 4; // one full wave across the bar
  return restNotes.map((rest) => {
    const phase =
      2 * Math.PI * (rest.startTime / wavelength - beats / p.periodBeats);
    return place(rest, 0, p.ampPitch * Math.sin(phase), ctx); // pure pitch wave
  });
};

// ---------------------------------------------------------------------------
// Cascade mode — a sweep crosses the bar, popping each note up and back in turn
//
// As the sweep line passes a note (ordered by start-time) the note kicks up in
// pitch and settles with a snappy, decaying overshoot — anticipation and
// follow-through, staggered across the notes (overlapping action).
// ---------------------------------------------------------------------------
const cascade: SimulationFn = (restNotes, elapsedSeconds, ctx) => {
  const p = PHYSICS.cascade;
  const beats = beatsOf(elapsedSeconds, ctx.tempo);
  const wavelength = ctx.barLen > 0 ? ctx.barLen : 4;
  const sweep = beats / p.sweepBeats; // advances one bar-width per sweepBeats
  return restNotes.map((rest) => {
    let d = (sweep - rest.startTime / wavelength) % 1; // time since the sweep passed
    if (d < 0) d += 1;
    const env = Math.exp(-p.decay * d); // snappy decay after the pop
    return place(
      rest,
      p.ampTime * env * Math.sin(2 * Math.PI * p.freq * d),
      p.ampPitch * env * Math.cos(2 * Math.PI * p.freq * d), // up, then overshoot
      ctx,
    );
  });
};

// ---------------------------------------------------------------------------
// Pulse mode — the chord breathes, scaling out from and back to its centroid
// ---------------------------------------------------------------------------
const pulse: SimulationFn = (restNotes, elapsedSeconds, ctx) => {
  const p = PHYSICS.pulse;
  const beats = beatsOf(elapsedSeconds, ctx.tempo);
  const s = 1 + p.amp * Math.sin((2 * Math.PI * beats) / p.periodBeats);

  const n = restNotes.length || 1;
  let cx = 0;
  let cy = 0;
  for (const r of restNotes) {
    cx += r.startTime;
    cy += r.pitch;
  }
  cx /= n;
  cy /= n;

  // Express scale-about-centroid as a displacement so Width / Length / Snap
  // apply uniformly through place().
  return restNotes.map((rest) =>
    place(rest, (rest.startTime - cx) * (s - 1), (rest.pitch - cy) * (s - 1), ctx),
  );
};

// ---------------------------------------------------------------------------
// Draw mode — notes ride a user-drawn looping path (drawn in chooser.html)
//
// The path is a closed loop of normalized [-1,1] points. At loop phase φ each
// note samples the path at φ + spread·(i/n), so `spread` fans the notes out
// into a moving train that traces the shape.
// ---------------------------------------------------------------------------
const pathSim: SimulationFn = (restNotes, elapsedSeconds, ctx) => {
  const path = ctx.path;
  if (!path || path.length < 2) return restNotes.map((rest) => ({ ...rest }));
  const a = PHYSICS.path;
  const beats = beatsOf(elapsedSeconds, ctx.tempo);
  const phase = beats / ctx.periodBeats;
  const n = restNotes.length || 1;
  return restNotes.map((rest, i) => {
    const [nx, ny] = samplePath(path, phase + ctx.spread * (i / n));
    return place(rest, nx * a.ampTime, ny * a.ampPitch, ctx);
  });
};

// ---------------------------------------------------------------------------
// Mode registry — drives both the context-menu command and the chooser window
// ---------------------------------------------------------------------------
type Mode = {
  id: string;
  name: string;
  description: string;
  sim: SimulationFn;
};

const MODES: readonly Mode[] = [
  {
    id: "pendulum",
    name: "Pendulum",
    description:
      "Swings the whole note column across the time axis like a bob on a rod, with a slight pitch lift at the extremes. Tempo-synced.",
    sim: pendulum,
  },
  {
    id: "orbit",
    name: "Orbit",
    description:
      "Sends each note around a small circle in time and pitch. The notes are spread around the ring, so the chord rotates.",
    sim: orbit,
  },
  {
    id: "wave",
    name: "Wave",
    description:
      "A sine travels across the notes by start-time, so each note bobs in pitch a step behind the last — a traveling ripple.",
    sim: wave,
  },
  {
    id: "drift",
    name: "Drift",
    description:
      "Each note wanders on its own smooth noise path, so the chord meanders organically through time and pitch, like leaves drifting on water.",
    sim: drift,
  },
  {
    id: "bounce",
    name: "Bounce",
    description:
      "The notes ricochet around the clip on straight diagonal paths, reflecting sharply off the time and pitch edges like balls loose in a box.",
    sim: bounce,
  },
  {
    id: "cascade",
    name: "Cascade",
    description:
      "A sweep crosses the bar and pops each note up and back in turn, with a snappy overshoot — a rolling wave of jumps down the row.",
    sim: cascade,
  },
  {
    id: "pulse",
    name: "Pulse",
    description:
      "The chord breathes: it scales out from and back toward its center, the notes spreading apart and squeezing together.",
    sim: pulse,
  },
  {
    id: "path",
    name: "Draw",
    description:
      "Trace your own looping motion path; the notes ride it each bar. Use Spread to fan the notes out along the path.",
    sim: pathSim,
  },
];

const modeById = (id: string): Mode | undefined =>
  MODES.find((m) => m.id === id);

// ---------------------------------------------------------------------------
// Animation engine
// ---------------------------------------------------------------------------
// ~10 fps. Measured on a playing timeline: Live accepts note-writes instantly
// (fire-and-forget, <1 ms) but applies/redraws them on its busy main thread.
// At ~15 writes/s the edits outpace Live and the visual lag GROWS over time;
// ~8 writes/s was fully stable but chunky. 100 ms splits the difference —
// if lag creeps back during long playback, raise this toward 125.
const FRAME_MS = 100;
const MAX_INTERVAL_MS = 250; // worst-case backoff (~4 fps) when Live is congested
const MAX_RUN_SECONDS = 300; // safety cap so a forgotten animation can't run forever
const DEBUG_STATS: boolean = false; // log frame-loop stats every 10 s to the host console

type Animation = {
  clip: MidiClipV;
  rest: NoteDescription[]; // original snapshot, never overwritten
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  sim: SimulationFn;
  spec: AnimationSpec; // mode + options + period + optional drawn path
  barLen: number;
  lastKey: string; // signature of the last-written frame (skip identical writes)
  interval: number; // adaptive ms between frames (FRAME_MS … MAX_INTERVAL_MS)
  simClockMs: number; // clamped animation clock — advances ≤ 2×interval per tick
  lastTickAt: number;
  paused: boolean; // frozen mid-motion (notes stay put; Stop restores instead)
  pausedAt: number;
  arm: () => void; // (re)schedule the next tick — used by resume
};

// A compact signature of a frame's notes. Identical frames are not re-written,
// which avoids flooding Live with redundant full-clip rewrites — a big cause of
// choppiness while a clip is playing.
const noteSignature = (notes: readonly NoteDescription[]): string =>
  notes.map((n) => `${n.pitch}:${Math.round(n.startTime * 1000)}`).join(",");

// Keyed by clip instance — the SDK guarantees the same Live object always
// resolves to the same instance, so this reliably tracks per-clip state.
const active = new Map<MidiClipV, Animation>();

// Assigned in activate(); let the frame loop read the live tempo and scale.
let getTempo: () => number = () => 120;
let getScale: () => { root: number; intervals: number[] } = () => ({
  root: 0,
  intervals: [],
});

// Per-mode preset lists, edited entirely inside the chooser window (its only
// host channel closes the dialog, so saves stay local there for zero blinking)
// and posted back with every action. Persisted to storageDirectory when Live
// provides one (installed extensions); otherwise they live for the host session.
let presetStore: Record<string, unknown> = {};
let presetIdxStore: Record<string, unknown> = {}; // selected preset per mode
let customModes: unknown[] = []; // user-named "preset modes" shown in the carousel
let presetsFile: string | null = null;

function persistUserData(): void {
  if (!presetsFile) return;
  try {
    fs.writeFile(
      presetsFile,
      JSON.stringify({
        presets: presetStore,
        idx: presetIdxStore,
        custom: customModes,
      }),
      (err) => {
        if (err) console.warn("midiMove: failed to save presets", err);
      },
    );
  } catch (err) {
    console.warn("midiMove: failed to save presets", err);
  }
}

// The most recently applied settings, so the instant menu items and a reopened
// chooser inherit the last Width / Length / Snap (and drawn path) the user chose.
let lastOptions: AnimOptions = DEFAULT_OPTIONS;
let lastPath: { points: PathPoint[]; spread: number } | null = null;
let lastPeriodBeats = 0; // 0 → default to the clip's bar length

// Build a spec for `modeId` from the last-used settings (used by the menu items
// and as the chooser's starting point).
const specForMode = (modeId: string): AnimationSpec => {
  const spec: AnimationSpec = {
    modeId,
    options: lastOptions,
    periodBeats: lastPeriodBeats,
  };
  if (modeId === "path" && lastPath) {
    spec.path = { points: lastPath.points, spread: lastPath.spread };
  }
  return spec;
};

const barLengthOf = (clip: MidiClipV) =>
  clip.duration > 0 ? clip.duration : 4;

// A clip with no notes still gets something to move: a centered C-E-G triad.
const seedNotes = (barLen: number): NoteDescription[] => {
  const startTime = Math.max(0, barLen / 2 - 0.25);
  return [60, 64, 67].map((pitch) => ({
    pitch,
    startTime,
    duration: 0.5,
    velocity: 100,
  }));
};

// Per-clip stack of previously applied specs. Live's own Ctrl+Z is useless here
// (every animation frame is an undoable edit and the SDK can't suppress that),
// so midiMove keeps its own apply-level history: Undo steps back through the
// applied animations and finally restores the original notes.
const history = new Map<MidiClipV, AnimationSpec[]>();

function stopAnimation(clip: MidiClipV, restore: boolean): void {
  const anim = active.get(clip);
  if (!anim) return; // nothing running for this clip
  clearTimeout(anim.timer);
  active.delete(clip);
  history.delete(clip); // stop = back to baseline; the apply chain resets
  if (restore) {
    try {
      anim.clip.notes = anim.rest; // final write returns the grid to rest
    } catch (err) {
      console.warn("midiMove: failed to restore notes on stop", err);
    }
  }
}

// Apply with history: remembers the spec that was running so Undo can return
// to it. Use this (not startAnimation) for every user-initiated apply.
function applyAnimation(clip: MidiClipV, spec: AnimationSpec): void {
  const running = active.get(clip);
  if (running && JSON.stringify(running.spec) !== JSON.stringify(spec)) {
    const stack = history.get(clip) ?? [];
    stack.push(running.spec);
    if (stack.length > 20) stack.shift();
    history.set(clip, stack);
  }
  startAnimation(clip, spec);
}

function undoAnimation(clip: MidiClipV): void {
  const prev = history.get(clip)?.pop();
  if (prev) startAnimation(clip, prev);
  else stopAnimation(clip, true); // nothing earlier → restore the original notes
}

// Freeze the animation in place (the notes stay at their current animated
// positions); toggling again resumes from the exact same phase.
function togglePause(clip: MidiClipV): void {
  const anim = active.get(clip);
  if (!anim) return;
  if (anim.paused) {
    anim.paused = false;
    anim.startedAt += Date.now() - anim.pausedAt; // pause doesn't eat the run cap
    anim.arm();
  } else {
    clearTimeout(anim.timer);
    anim.paused = true;
    anim.pausedAt = Date.now();
  }
}

function startAnimation(clip: MidiClipV, spec: AnimationSpec): void {
  const barLen = barLengthOf(clip);
  const sim = (modeById(spec.modeId) ?? MODES[0]!).sim;

  // Restarting an already-running clip reuses the ORIGINAL snapshot so we never
  // bake a mid-animation frame in as the new rest position — even when the user
  // switches modes or tweaks options from the chooser.
  const existing = active.get(clip);
  let rest: NoteDescription[];
  if (existing) {
    clearTimeout(existing.timer);
    active.delete(clip);
    rest = existing.rest;
  } else {
    const current = clip.notes;
    rest =
      current.length > 0 ? current.map((n) => ({ ...n })) : seedNotes(barLen);
  }

  const startedAt = Date.now();
  let anim: Animation;

  // Temporary instrumentation — one summary line every ~10 s to the host log.
  let stWrites = 0;
  let stSkips = 0;
  let stCostSum = 0;
  let stCostMax = 0;
  let stLastLog = startedAt;

  // Frame loop, scheduled FROM COMPLETION: the next tick is queued only after
  // this frame's (possibly blocking) clip write returns, so the gap between
  // write-end and the next write-start is always ≥ `interval` — Live is never
  // flooded with queued note-sets, no matter how slow it is during playback.
  const tick = (): void => {
    if (active.get(clip) !== anim) return; // stopped or replaced
    if (anim.paused) return; // frozen — resume re-arms via anim.arm()
    const tickStart = Date.now();
    if ((tickStart - anim.startedAt) / 1000 >= MAX_RUN_SECONDS) {
      stopAnimation(clip, true);
      return;
    }

    // Clamped animation clock: a stalled frame advances the motion by at most
    // two intervals, so congestion slows the animation smoothly instead of
    // teleporting the notes to wherever wall-clock says they should be.
    anim.simClockMs += Math.min(tickStart - anim.lastTickAt, 2 * anim.interval);
    anim.lastTickAt = tickStart;
    const elapsed = anim.simClockMs / 1000;

    const s = anim.spec;
    const o = s.options;
    const scaleInfo = o.snapToKey ? getScale() : null;
    const snap = scaleInfo
      ? (pitch: number) => snapToScale(pitch, scaleInfo.root, scaleInfo.intervals)
      : (pitch: number) => pitch;

    try {
      const ctx: SimContext = {
        barLen: anim.barLen,
        tempo: getTempo(),
        width: o.width,
        height: o.height,
        snap,
        periodBeats: s.periodBeats > 0 ? s.periodBeats : anim.barLen,
        spread: s.path ? s.path.spread : 0,
        path: s.path ? s.path.points : null,
      };
      // `speed` scales the animation clock: at the fixed ~8 fps apply rate,
      // slower motion = smaller per-frame jumps = visibly smoother.
      const notes = anim.sim(anim.rest, elapsed * o.speed, ctx);
      const key = noteSignature(notes);
      if (key !== anim.lastKey) {
        anim.clip.notes = notes; // only write when the frame actually changed
        anim.lastKey = key;
        stWrites++;
      } else {
        stSkips++;
      }
    } catch (err) {
      // Clip/track was probably deleted mid-animation — stop without trying to
      // write back to a dead object.
      console.warn("midiMove: frame write failed, auto-stopping", err);
      stopAnimation(clip, false);
      return;
    }

    // Adaptive throttle: ease the interval toward 2× the measured frame cost.
    // When Live applies writes instantly this sits at FRAME_MS (~15 fps); when
    // Live is busy playing, the loop backs off so every write lands cleanly.
    const cost = Date.now() - tickStart;
    stCostSum += cost;
    if (cost > stCostMax) stCostMax = cost;
    const target = clamp(2 * cost, FRAME_MS, MAX_INTERVAL_MS);
    anim.interval += (target - anim.interval) * 0.3;

    if (DEBUG_STATS) {
      const nowEnd = Date.now();
      if (nowEnd - stLastLog >= 10_000) {
        const secs = (nowEnd - stLastLog) / 1000;
        const frames = stWrites + stSkips;
        console.log(
          `midiMove stats: ${(stWrites / secs).toFixed(1)} writes/s, ` +
            `${stSkips}/${frames} skipped, cost avg ${(stCostSum / Math.max(1, frames)).toFixed(1)}ms ` +
            `max ${stCostMax}ms, interval ${anim.interval.toFixed(0)}ms`,
        );
        stWrites = stSkips = stCostSum = stCostMax = 0;
        stLastLog = nowEnd;
      }
    }

    anim.timer = setTimeout(tick, anim.interval);
  };

  anim = {
    clip,
    rest,
    startedAt,
    timer: setTimeout(tick, FRAME_MS),
    sim,
    spec,
    barLen,
    lastKey: "",
    interval: FRAME_MS,
    simClockMs: 0,
    lastTickAt: startedAt,
    paused: false,
    pausedAt: 0,
    arm: () => {
      anim.lastTickAt = Date.now(); // no clock jump after a long pause
      anim.timer = setTimeout(tick, anim.interval);
    },
  };
  active.set(clip, anim);
}

// ---------------------------------------------------------------------------
// Chooser window
//
// Builds a data: URL from the inlined HTML, injecting the mode list (names +
// descriptions) and the shared PHYSICS constants so the in-window preview is
// driven by the same numbers as the engine. The window posts back a JSON
// `{ action, modeId }` via showModalDialog's close_and_send protocol.
// ---------------------------------------------------------------------------
// Real clip state injected into the window so the preview mirrors the actual
// MIDI: the clip's notes (start, pitch, duration), bar length, the live project
// tempo, and — when an animation is running — its exact clock, so the preview
// plays in phase with the clip.
type PreviewView = {
  tempo: number;
  barLen: number;
  clockMs: number;
  paused: boolean;
  rest: [number, number, number][];
} | null;

const chooserUrl = (spec: AnimationSpec | null, view: PreviewView): string => {
  const options = spec ? spec.options : lastOptions;
  const draw = (spec && spec.path) || lastPath; // restore the last/running path
  const config = {
    modes: MODES.map(({ id, name, description }) => ({ id, name, description })),
    physics: PHYSICS,
    activeModeId: spec ? spec.modeId : null,
    options, // initial Width / Length / Snap for the sliders
    scale: getScale(), // current key, so the preview can snap pitches too
    path: draw ? draw.points : null, // restore the draw pad
    spread: draw ? draw.spread : 0,
    periodBeats: spec && spec.periodBeats > 0 ? spec.periodBeats : lastPeriodBeats,
    view,
    presets: presetStore, // per-mode preset lists for the ◀ n/N ▶ flipper
    presetIdx: presetIdxStore, // remembered pager position per mode
    customModes, // user-named preset modes, appended to the carousel
  };
  // Use a replacer function so `$` in the JSON isn't treated as a special
  // replacement pattern.
  const html = chooserHtml.replace("__MIDIMOVE_CONFIG__", () =>
    JSON.stringify(config),
  );
  return `data:text/html,${encodeURIComponent(html)}`;
};

type ChooserChoice = {
  action?: string;
  modeId?: string;
  width?: number;
  height?: number;
  snapToKey?: boolean;
  speed?: number;
  path?: number[][];
  spread?: number;
  periodBeats?: number;
  presets?: Record<string, unknown>;
  presetIdx?: Record<string, unknown>;
  customModes?: unknown[];
};

// Read the window's slider/toggle values into validated options.
const optionsFromChoice = (c: ChooserChoice): AnimOptions => ({
  width: typeof c.width === "number" ? clamp(c.width, 0.1, 4) : 1,
  height: typeof c.height === "number" ? clamp(c.height, 0.1, 4) : 1,
  snapToKey: c.snapToKey === true,
  speed:
    typeof c.speed === "number"
      ? clamp(c.speed, 0.1, 2)
      : DEFAULT_OPTIONS.speed,
});

// Build a full AnimationSpec from a posted "apply" choice.
const specFromChoice = (c: ChooserChoice): AnimationSpec => {
  const spec: AnimationSpec = {
    modeId: c.modeId ?? "pendulum",
    options: optionsFromChoice(c),
    periodBeats:
      typeof c.periodBeats === "number" && c.periodBeats > 0 ? c.periodBeats : 0,
  };
  if (c.modeId === "path" && Array.isArray(c.path)) {
    const points = c.path
      .filter((pt) => Array.isArray(pt) && pt.length === 2)
      .map((pt) => [clamp(pt[0]!, -1, 1), clamp(pt[1]!, -1, 1)] as PathPoint);
    if (points.length >= 2) {
      spec.path = {
        points,
        spread: typeof c.spread === "number" ? clamp(c.spread, 0, 1) : 0,
      };
    }
  }
  return spec;
};

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
export function activate(activation: ActivationContext) {
  const ctx = initialize(activation, "1.0.0");
  getTempo = () => ctx.application.song.tempo;
  getScale = () => ({
    root: ctx.application.song.rootNote,
    intervals: ctx.application.song.scaleIntervals,
  });

  // Persist presets/custom modes to Live's storage directory when provided
  // (installed extensions). In dev runs it's undefined, so fall back to a
  // presets.json next to the extension — otherwise every host restart (which
  // dev does constantly) silently wipes everything the user saved.
  const storageDir = ctx.environment.storageDirectory;
  const presetsDir = storageDir || path.resolve(__dirname, "..");
  presetsFile = path.join(presetsDir, "presets.json");
  console.log(`midiMove: presets persisted at ${presetsFile}`);
  try {
    const loaded: unknown = JSON.parse(fs.readFileSync(presetsFile, "utf8"));
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
      const obj = loaded as { presets?: unknown; idx?: unknown; custom?: unknown };
      if (obj.presets && typeof obj.presets === "object") {
        presetStore = obj.presets as Record<string, unknown>;
      }
      if (obj.idx && typeof obj.idx === "object" && !Array.isArray(obj.idx)) {
        presetIdxStore = obj.idx as Record<string, unknown>;
      }
      if (Array.isArray(obj.custom)) customModes = obj.custom;
    }
  } catch {
    // no presets saved yet
  }

  const resolveClip = (args: unknown): MidiClipV | null => {
    try {
      return ctx.getObjectFromHandle(args as Handle, MidiClip);
    } catch (err) {
      console.warn("midiMove: could not resolve MidiClip", err);
      return null;
    }
  };

  // Browse window. showModalDialog is one-shot — it closes when the window
  // posts a result — so to make the window REAPPEAR after Apply we re-open it
  // in a loop. Only "close" (or a dismissed dialog) ends it.
  // Caveat: Live re-centers every new dialog (no position arg in the API, and
  // WebView2 blocks window.moveTo), so each reopen snaps back to screen-center.
  ctx.commands.registerCommand("midiMove.chooser", (args: unknown) =>
    (async () => {
      const clip = resolveClip(args);
      if (!clip) return;

      for (;;) {
        const running = active.get(clip);

        // Mirror the real clip in the preview: actual notes, bar length, the
        // live tempo, and the running animation's clock (phase-locked).
        let view: PreviewView = null;
        try {
          const barLen = running ? running.barLen : barLengthOf(clip);
          const rest = running
            ? running.rest
            : ((): NoteDescription[] => {
                const cur = clip.notes;
                return cur.length > 0 ? cur : seedNotes(barLen);
              })();
          view = {
            tempo: getTempo(),
            barLen,
            clockMs: running ? running.simClockMs : 0,
            paused: running ? running.paused : false,
            rest: rest
              .slice(0, 32) // plenty for a 312px preview
              .map((n) => [n.startTime, n.pitch, n.duration]),
          };
        } catch (err) {
          console.warn("midiMove: could not snapshot clip for preview", err);
        }

        let result: string;
        try {
          result = await ctx.ui.showModalDialog(
            chooserUrl(running ? running.spec : null, view),
            360,
            500, // as short as the layout allows — the dialog is always screen-
            // centered (no position API), so less height = higher bottom edge
            // = less of the clip editor covered.
          );
        } catch (err) {
          console.warn("midiMove: chooser dialog failed", err);
          return;
        }

        let choice: ChooserChoice;
        try {
          choice = JSON.parse(result);
        } catch {
          return; // dialog dismissed → done
        }

        // The window posts its (locally edited) preset lists and custom modes
        // with every action; persist whatever came back.
        let dirty = false;
        if (
          choice.presets &&
          typeof choice.presets === "object" &&
          !Array.isArray(choice.presets)
        ) {
          presetStore = choice.presets;
          dirty = true;
        }
        if (
          choice.presetIdx &&
          typeof choice.presetIdx === "object" &&
          !Array.isArray(choice.presetIdx)
        ) {
          presetIdxStore = choice.presetIdx;
          dirty = true;
        }
        if (Array.isArray(choice.customModes)) {
          customModes = choice.customModes.slice(0, 50);
          dirty = true;
        }
        if (dirty) persistUserData();

        if (choice.action === "apply" && choice.modeId) {
          const spec = specFromChoice(choice);
          lastOptions = spec.options;
          lastPeriodBeats = spec.periodBeats;
          if (spec.path) lastPath = spec.path;
          applyAnimation(clip, spec);
          // loop: reopen so the user can keep auditioning
        } else if (choice.action === "undo") {
          undoAnimation(clip);
          // loop: reopen showing the restored state
        } else if (choice.action === "pause") {
          togglePause(clip);
          // loop: reopen with the frozen (or resumed) state
        } else if (choice.action === "stop") {
          stopAnimation(clip, true);
          // loop: reopen
        } else {
          return; // "close" / unknown → done
        }
      }
    })(),
  );

  ctx.commands.registerCommand("midiMove.stop", (args: unknown) => {
    const clip = resolveClip(args);
    if (clip) stopAnimation(clip, true);
  });

  ctx.commands.registerCommand("midiMove.undo", (args: unknown) => {
    const clip = resolveClip(args);
    if (clip) undoAnimation(clip);
  });

  ctx.commands.registerCommand("midiMove.pause", (args: unknown) => {
    const clip = resolveClip(args);
    if (clip) togglePause(clip);
  });

  // Instant, windowless switching: one menu item per mode that retargets the
  // live clip immediately. No modal means nothing to re-center or blink — this
  // is the smooth way to keep changing the animation while it runs. Switching
  // reuses the original rest snapshot (see startAnimation), so chaining modes
  // never bakes in a mid-animation frame.
  ctx.ui.registerContextMenuAction(
    "MidiClip",
    "midiMove: Browse animations…",
    "midiMove.chooser",
  );
  for (const mode of MODES) {
    ctx.commands.registerCommand(`midiMove.mode.${mode.id}`, (args: unknown) => {
      const clip = resolveClip(args);
      if (clip) applyAnimation(clip, specForMode(mode.id));
    });
    ctx.ui.registerContextMenuAction(
      "MidiClip",
      `midiMove ▸ ${mode.name}`,
      `midiMove.mode.${mode.id}`,
    );
  }
  ctx.ui.registerContextMenuAction(
    "MidiClip",
    "midiMove: Pause / resume",
    "midiMove.pause",
  );
  ctx.ui.registerContextMenuAction(
    "MidiClip",
    "midiMove: Undo apply",
    "midiMove.undo",
  );
  ctx.ui.registerContextMenuAction(
    "MidiClip",
    "midiMove: Stop animation",
    "midiMove.stop",
  );
}
