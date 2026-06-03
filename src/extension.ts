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
type SimContext = { barLen: number; tempo: number };
type SimulationFn = (
  restNotes: readonly NoteDescription[],
  elapsedSeconds: number,
  sim: SimContext,
) => NoteDescription[];

const clamp = (value: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, value));

// ---------------------------------------------------------------------------
// Physics constants — single source of truth
//
// These are read by the simulation functions below AND injected into the
// chooser window (see chooserUrl), so the in-window canvas preview animates
// with the exact same numbers as the real clip. Tune a value here and both the
// preview and the live animation move together.
// ---------------------------------------------------------------------------
const PHYSICS = {
  // Pendulum: the column swings as one rigid bob.
  //   dx = hAmp·sin θ          horizontal swing along the time axis (beats)
  //   dy = vAmp·(1 − cos θ)    pitch lifts at *both* extremes (subtle, 2× rate)
  pendulum: { periodBeats: 4, theta0: 1.0, hAmp: 1.0, vAmp: 2 },
  // Spring: pluck the column, let it overshoot and decay, re-pluck each period.
  spring: { periodBeats: 2, oscPerBeat: 1.5, damp: 1.8, ampPitch: 5, ampTime: 0.35 },
  // Orbit: each note rides a circle in (time, pitch), spread around the ring.
  orbit: { periodBeats: 3, rTime: 0.6, rPitch: 4 },
  // Wave: a sine travels across the notes by start-time (a Mexican wave).
  wave: { periodBeats: 2, ampPitch: 5 },
  // Gravity: notes fall in pitch and bounce, losing energy, then re-drop.
  gravity: { dropPitch: 9, firstFallBeats: 0.9, restitution: 0.62, restBeats: 0.8 },
} as const;

const beatsOf = (elapsedSeconds: number, tempo: number) =>
  elapsedSeconds * (tempo / 60);

// ---------------------------------------------------------------------------
// Pendulum mode (tempo-synced)
// ---------------------------------------------------------------------------
const pendulum: SimulationFn = (restNotes, elapsedSeconds, { barLen, tempo }) => {
  const p = PHYSICS.pendulum;
  const beats = beatsOf(elapsedSeconds, tempo);
  const theta = p.theta0 * Math.cos(((2 * Math.PI) / p.periodBeats) * beats);
  const dx = p.hAmp * Math.sin(theta);
  const dy = p.vAmp * (1 - Math.cos(theta));

  return restNotes.map((rest) => {
    const hi = Math.max(0, barLen - rest.duration);
    return {
      ...rest, // preserve velocity / muted / probability / etc.
      startTime: clamp(rest.startTime + dx, 0, hi),
      pitch: clamp(Math.round(rest.pitch + dy), 0, 127),
    };
  });
};

// ---------------------------------------------------------------------------
// Spring Bounce mode — damped oscillation, re-triggered every period
// ---------------------------------------------------------------------------
const springBounce: SimulationFn = (restNotes, elapsedSeconds, { barLen, tempo }) => {
  const p = PHYSICS.spring;
  const beats = beatsOf(elapsedSeconds, tempo);
  const t = beats % p.periodBeats; // beats since the last pluck
  const env = Math.exp(-p.damp * t); // amplitude decays through the pluck
  const osc = Math.cos(2 * Math.PI * p.oscPerBeat * t);
  const dx = p.ampTime * env * osc;
  const dy = p.ampPitch * env * osc;

  return restNotes.map((rest) => {
    const hi = Math.max(0, barLen - rest.duration);
    return {
      ...rest,
      startTime: clamp(rest.startTime + dx, 0, hi),
      pitch: clamp(Math.round(rest.pitch + dy), 0, 127),
    };
  });
};

// ---------------------------------------------------------------------------
// Orbit mode — each note rides a circle, spread evenly around the ring
// ---------------------------------------------------------------------------
const orbit: SimulationFn = (restNotes, elapsedSeconds, { barLen, tempo }) => {
  const p = PHYSICS.orbit;
  const beats = beatsOf(elapsedSeconds, tempo);
  const ang = (2 * Math.PI * beats) / p.periodBeats;
  const n = restNotes.length || 1;

  return restNotes.map((rest, i) => {
    const phase = (i / n) * 2 * Math.PI; // notes spread around the circle
    const dx = p.rTime * Math.cos(ang + phase);
    const dy = p.rPitch * Math.sin(ang + phase);
    const hi = Math.max(0, barLen - rest.duration);
    return {
      ...rest,
      startTime: clamp(rest.startTime + dx, 0, hi),
      pitch: clamp(Math.round(rest.pitch + dy), 0, 127),
    };
  });
};

// ---------------------------------------------------------------------------
// Wave mode — a sine travels across the notes by start-time
// ---------------------------------------------------------------------------
const wave: SimulationFn = (restNotes, elapsedSeconds, { barLen, tempo }) => {
  const p = PHYSICS.wave;
  const beats = beatsOf(elapsedSeconds, tempo);
  const wavelength = barLen > 0 ? barLen : 4; // one full wave across the bar

  return restNotes.map((rest) => {
    const phase =
      2 * Math.PI * (rest.startTime / wavelength - beats / p.periodBeats);
    const dy = p.ampPitch * Math.sin(phase);
    return {
      ...rest, // start-time untouched: a pure pitch wave
      pitch: clamp(Math.round(rest.pitch + dy), 0, 127),
    };
  });
};

// ---------------------------------------------------------------------------
// Gravity Drop mode — bouncing-ball pitch trajectory, looped
//
// A ball dropped from `dropPitch` semitones bounces with `restitution` energy
// retained per impact until it settles, rests briefly, then re-drops. The
// derived cycle constants only depend on PHYSICS.gravity, so they're computed
// once here (and re-derived identically in the preview).
// ---------------------------------------------------------------------------
const G = PHYSICS.gravity;
const G_ACCEL = (2 * G.dropPitch) / (G.firstFallBeats * G.firstFallBeats);
// Active phase = first fall + sum of all bounce arcs (geometric series).
const GRAV_ACTIVE =
  G.firstFallBeats * (1 + (2 * G.restitution) / (1 - G.restitution));
const GRAV_CYCLE = GRAV_ACTIVE + G.restBeats;

// Height above the floor, in semitones, at `t` beats into one cycle.
const bounceHeight = (t: number): number => {
  if (t >= GRAV_ACTIVE) return 0; // settled, waiting to re-drop
  if (t <= G.firstFallBeats) {
    return Math.max(0, G.dropPitch - 0.5 * G_ACCEL * t * t);
  }
  let v = G_ACCEL * G.firstFallBeats * G.restitution; // rebound after 1st impact
  let rem = t - G.firstFallBeats;
  for (let k = 0; k < 20; k++) {
    const air = (2 * v) / G_ACCEL; // time for this up-and-down arc
    if (rem <= air) return Math.max(0, v * rem - 0.5 * G_ACCEL * rem * rem);
    rem -= air;
    v *= G.restitution;
    if (v < 1e-3) return 0;
  }
  return 0;
};

const gravityDrop: SimulationFn = (restNotes, elapsedSeconds, { tempo }) => {
  const beats = beatsOf(elapsedSeconds, tempo);
  const height = bounceHeight(beats % GRAV_CYCLE);
  const dy = height - G.dropPitch; // rests at top (dy 0), drops to −dropPitch

  return restNotes.map((rest) => ({
    ...rest,
    pitch: clamp(Math.round(rest.pitch + dy), 0, 127),
  }));
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
    id: "spring",
    name: "Spring Bounce",
    description:
      "Plucks the column and lets it overshoot and settle with damped-spring physics, re-triggering every couple of beats.",
    sim: springBounce,
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
      "A sine wave travels across the notes by start-time, so each note bobs in pitch a step behind the last — a Mexican wave.",
    sim: wave,
  },
  {
    id: "gravity",
    name: "Gravity Drop",
    description:
      "Drops the notes in pitch under gravity; they bounce at the bottom, losing energy each bounce, then the cycle restarts.",
    sim: gravityDrop,
  },
];

const modeById = (id: string): Mode | undefined =>
  MODES.find((m) => m.id === id);

// ---------------------------------------------------------------------------
// Animation engine
// ---------------------------------------------------------------------------
const FRAME_MS = 66; // ~15 fps: smooth, keeps undo-history growth bounded
const MAX_RUN_SECONDS = 300; // safety cap so a forgotten animation can't run forever

type Animation = {
  clip: MidiClipV;
  rest: NoteDescription[]; // original snapshot, never overwritten
  startedAt: number;
  timer: ReturnType<typeof setInterval>;
  sim: SimulationFn;
  modeId: string;
  barLen: number;
};

// Keyed by clip instance — the SDK guarantees the same Live object always
// resolves to the same instance, so this reliably tracks per-clip state.
const active = new Map<MidiClipV, Animation>();

// Assigned in activate(); lets the frame loop read the live tempo each tick.
let getTempo: () => number = () => 120;

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

function stopAnimation(clip: MidiClipV, restore: boolean): void {
  const anim = active.get(clip);
  if (!anim) return; // nothing running for this clip
  clearInterval(anim.timer);
  active.delete(clip);
  if (restore) {
    try {
      anim.clip.notes = anim.rest; // final write returns the grid to rest
    } catch (err) {
      console.warn("midiMove: failed to restore notes on stop", err);
    }
  }
}

function startAnimation(clip: MidiClipV, mode: Mode): void {
  const barLen = barLengthOf(clip);

  // Restarting an already-running clip reuses the ORIGINAL snapshot so we never
  // bake a mid-animation frame in as the new rest position — even when the user
  // switches modes from the chooser.
  const existing = active.get(clip);
  let rest: NoteDescription[];
  if (existing) {
    clearInterval(existing.timer);
    active.delete(clip);
    rest = existing.rest;
  } else {
    const current = clip.notes;
    rest =
      current.length > 0 ? current.map((n) => ({ ...n })) : seedNotes(barLen);
  }

  const startedAt = Date.now();
  const timer = setInterval(() => {
    const anim = active.get(clip);
    if (!anim) {
      clearInterval(timer);
      return;
    }
    const elapsed = (Date.now() - anim.startedAt) / 1000;
    if (elapsed >= MAX_RUN_SECONDS) {
      stopAnimation(clip, true);
      return;
    }
    try {
      anim.clip.notes = anim.sim(anim.rest, elapsed, {
        barLen: anim.barLen,
        tempo: getTempo(),
      });
    } catch (err) {
      // Clip/track was probably deleted mid-animation — stop without trying
      // to write back to a dead object.
      console.warn("midiMove: frame write failed, auto-stopping", err);
      stopAnimation(clip, false);
    }
  }, FRAME_MS);

  active.set(clip, {
    clip,
    rest,
    startedAt,
    timer,
    sim: mode.sim,
    modeId: mode.id,
    barLen,
  });
}

// ---------------------------------------------------------------------------
// Chooser window
//
// Builds a data: URL from the inlined HTML, injecting the mode list (names +
// descriptions) and the shared PHYSICS constants so the in-window preview is
// driven by the same numbers as the engine. The window posts back a JSON
// `{ action, modeId }` via showModalDialog's close_and_send protocol.
// ---------------------------------------------------------------------------
const chooserUrl = (activeModeId: string | null): string => {
  const config = {
    modes: MODES.map(({ id, name, description }) => ({ id, name, description })),
    physics: PHYSICS,
    activeModeId,
  };
  // Use a replacer function so `$` in the JSON isn't treated as a special
  // replacement pattern.
  const html = chooserHtml.replace("__MIDIMOVE_CONFIG__", () =>
    JSON.stringify(config),
  );
  return `data:text/html,${encodeURIComponent(html)}`;
};

type ChooserChoice = { action?: string; modeId?: string };

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
export function activate(activation: ActivationContext) {
  const ctx = initialize(activation, "1.0.0");
  getTempo = () => ctx.application.song.tempo;

  const resolveClip = (args: unknown): MidiClipV | null => {
    try {
      return ctx.getObjectFromHandle(args as Handle, MidiClip);
    } catch (err) {
      console.warn("midiMove: could not resolve MidiClip", err);
      return null;
    }
  };

  // Open the carousel. showModalDialog is one-shot (it closes when the window
  // posts a result), so to keep the window open across applies we re-open it
  // after each Apply/Stop. Only "close" (or a dismissed dialog) ends the loop.
  ctx.commands.registerCommand("midiMove.chooser", (args: unknown) =>
    (async () => {
      const clip = resolveClip(args);
      if (!clip) return;

      for (;;) {
        const running = active.get(clip);
        let result: string;
        try {
          result = await ctx.ui.showModalDialog(
            chooserUrl(running ? running.modeId : null),
            360,
            500,
          );
        } catch (err) {
          console.warn("midiMove: chooser dialog failed", err);
          return;
        }

        let choice: ChooserChoice;
        try {
          choice = JSON.parse(result);
        } catch {
          return; // dialog dismissed without a usable result → end loop
        }

        if (choice.action === "apply" && choice.modeId) {
          const mode = modeById(choice.modeId);
          if (mode) startAnimation(clip, mode);
          // re-open so the user can keep auditioning
        } else if (choice.action === "stop") {
          stopAnimation(clip, true);
          // re-open: the clip is back at rest, pick another
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

  ctx.ui.registerContextMenuAction(
    "MidiClip",
    "midiMove: Animate…",
    "midiMove.chooser",
  );
  ctx.ui.registerContextMenuAction(
    "MidiClip",
    "midiMove: Stop Animation",
    "midiMove.stop",
  );
}
