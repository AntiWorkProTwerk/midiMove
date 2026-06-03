import {
  initialize,
  MidiClip,
  type ActivationContext,
  type Handle,
  type NoteDescription,
} from "@ableton-extensions/sdk";

type MidiClipV = MidiClip<"1.0.0">;

// ---------------------------------------------------------------------------
// Simulation abstraction
//
// A physics mode is a pure function: given the clip's "rest" note layout and
// how long the animation has been running, return the notes for this frame.
// Pendulum is the first mode; future modes (spring, gravity-bounce, orbit)
// just implement this signature and get their own Start command wired up.
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
// Pendulum mode (tempo-synced)
//
// The whole note column swings as one rigid bob. The swing period is defined
// in beats and converted to seconds via the song tempo, so it scales with BPM.
//   dx = A·sin(θ)        horizontal displacement along the time axis (beats)
//   dy = A·(1 - cos θ)   vertical rise in pitch; the bob lifts at *both*
//                        extremes, so the pitch wobble stays subtle and runs
//                        at twice the horizontal frequency.
// ---------------------------------------------------------------------------
const PENDULUM = {
  PERIOD_BEATS: 4, // one full left→right→left swing per 4/4 bar
  THETA0_RAD: 1.0, // ~57° rest-to-extreme amplitude
  H_AMPLITUDE_BEATS: 1.0, // dominant horizontal swing (beats)
  V_AMPLITUDE_PITCH: 2, // slight vertical bob (semitones)
} as const;

const pendulum: SimulationFn = (
  restNotes,
  elapsedSeconds,
  { barLen, tempo },
) => {
  const beats = elapsedSeconds * (tempo / 60);
  const omega = (2 * Math.PI) / PENDULUM.PERIOD_BEATS;
  const theta = PENDULUM.THETA0_RAD * Math.cos(omega * beats);
  const dx = PENDULUM.H_AMPLITUDE_BEATS * Math.sin(theta);
  const dy = PENDULUM.V_AMPLITUDE_PITCH * (1 - Math.cos(theta));

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
  barLen: number;
};

// Keyed by clip instance — the SDK guarantees the same Live object always
// resolves to the same instance, so this reliably tracks per-clip state.
const active = new Map<MidiClipV, Animation>();

// Assigned in activate(); lets the frame loop read the live tempo each tick.
let getTempo: () => number = () => 120;

const barLengthOf = (clip: MidiClipV) =>
  clip.duration > 0 ? clip.duration : 4;

// A clip with no notes still gets something to swing: a centered C-E-G triad.
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

function startAnimation(clip: MidiClipV, sim: SimulationFn): void {
  const barLen = barLengthOf(clip);

  // Restarting an already-running clip reuses the ORIGINAL snapshot so we never
  // bake a mid-swing frame in as the new rest position.
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

  active.set(clip, { clip, rest, startedAt, timer, sim, barLen });
}

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

  ctx.commands.registerCommand("midiMove.pendulum.start", (args: unknown) => {
    const clip = resolveClip(args);
    if (clip) startAnimation(clip, pendulum);
  });

  ctx.commands.registerCommand("midiMove.stop", (args: unknown) => {
    const clip = resolveClip(args);
    if (clip) stopAnimation(clip, true);
  });

  ctx.ui.registerContextMenuAction(
    "MidiClip",
    "Pendulum: Start",
    "midiMove.pendulum.start",
  );
  ctx.ui.registerContextMenuAction(
    "MidiClip",
    "Stop Animation",
    "midiMove.stop",
  );
}
