/**
 * src/audio.ts — WebAudio mixer + procedural adaptive music. No sample files ship:
 * every sound here is synthesised from oscillators and generated noise buffers.
 *
 * Graph:
 *   Music   -> musicSlider -> musicDuck -> \
 *   SFX     -> sfxSlider   -------------> \
 *   Ambience-> ambienceSlider ----------> masterSlider -> limiter -> destination
 *   UI      -> uiSlider    -------------> /
 *
 * Ducking rides a dedicated `musicDuck` node *after* the user's music slider, so a
 * sidechain dip can never overwrite the player's Music slider value.
 *
 * Node-importable: no AudioContext is constructed until `initAudio()` runs, so
 * `dbFromSlider()` is unit-testable in plain node.
 */

import { createFlightCues, type FlightCue } from './audio-cues';
import { createFlightScore, SCORE_BAR_SECONDS } from './audio-score';

/** Slider travel mapped to silence: finite floor, never -Infinity. */
export const SLIDER_FLOOR_DB = -80;

/** dB of the sidechain dip on the music bus. */
export const DUCK_DB = -12;

/** Seconds the duck ramp takes down and back up. */
export const DUCK_RAMP_S = 0.25;

const SCHEDULER_MS = 120;
const LOOKAHEAD_S = 0.4;

export type TrackAudioSource = (source: AudioScheduledSourceNode, ...owned: AudioNode[]) => void;
export type BusName = 'master' | 'music' | 'sfx' | 'ambience' | 'ui';
export type SfxKind = 'ui' | 'hit' | 'sting' | 'whoosh';
/** Gameplay-driven one-shots; the edges are detected in game.ts. */
export type PulseKind = 'stall' | 'stallWarn' | 'dive' | 'cloud' | 'water' | 'line';
const PULSE_CUES: Record<PulseKind, FlightCue> = {
  stall: 'sting', stallWarn: 'warning', dive: 'dive', cloud: 'cloud', water: 'splash', line: 'ui',
};
const CUE_DUCK: Partial<Record<FlightCue, { db: number; hold: number }>> = {
  sting: { db: DUCK_DB, hold: 0.43 },
  warning: { db: -7, hold: 0.29 },
  whoosh: { db: -4, hold: 0.25 },
};
/** 'off' = no WebAudio at all, 'blocked' = waiting for the first user gesture, 'live' = running. */
export type AudioState = 'off' | 'blocked' | 'live';

export interface AudioHandle {
  /** 0..1 gameplay intensity, read on the next musical bar. */
  setIntensity(v: number): void;
  /** 0..1 deck chop, shared by the sea bed and wind. */
  setSeaRumble(v: number): void;
  /** Continuous proximity to the cloud around the listener. */
  setCloudLevel(v: number): void;
  /**
   * P1-1 Q4: 0..1 looped water voice (skim level x speed). Fades in/out over
   * 0.2 s via setTargetAtTime, so chopping across the 0.5 skim edge never pops.
   */
  setWaterLevel(v: number): void;
  /**
   * Engine and blade speed, from the same throttle used by the prop animation.
   */
  setPropHum(v: number): void;
  /** Slider is 0..1 travel, mapped to gain*gain dB. Safe at 0 (true silence). */
  setBus(bus: BusName, slider01: number): void;
  /** Sidechain dip on the music bus (-12 dB / 0.25 s), independent of the slider. */
  duck(on: boolean): void;
  /** Play a short UI or flight sound. */
  playSfx(kind: SfxKind): void;
  /** Gameplay edge. Water contacts carry the impact severity from the simulation. */
  pulse(kind: PulseKind, strength?: number): void;
  /** Context state, for the HUD badge. */
  state(): AudioState;
  dispose(): void;
}

/**
 * Slider travel (0..1) to bus gain in dB. Squaring the slider first spreads the
 * audible change over the whole travel; a raw linear-amplitude slider wastes most
 * of its range, and feeding the slider value straight to dB does nothing audible.
 */
export function dbFromSlider(s01: number): number {
  if (!Number.isFinite(s01)) return SLIDER_FLOOR_DB;
  const s = Math.min(Math.max(s01, 0), 1);
  if (s <= 0) return SLIDER_FLOOR_DB;
  const gain = s * s;
  return Math.max(20 * Math.log10(gain), SLIDER_FLOOR_DB);
}

/**
 * The music bus gain while a duck is active: the player's slider value PLUS the duck
 * offset, clamped to the floor and to unity. Deliberately a pure function of both —
 * the duck must never write back into the slider node, only sit on top of it.
 */
export function busGainDb(slider01: number, duckDb: number): number {
  const base = dbFromSlider(slider01);
  if (!Number.isFinite(duckDb)) return base;
  return Math.min(Math.max(base + duckDb, SLIDER_FLOOR_DB), 0);
}

/**
 * Duck envelope depth (dB, negative) after `tSinceOn` seconds of a ramp lasting
 * `rampS`: linear down, then held while the duck stays on. NaN reads as no duck.
 */
export function duckGain(tSinceOn: number, rampS: number): number {
  if (!Number.isFinite(tSinceOn) || !Number.isFinite(rampS) || rampS <= 0 || tSinceOn < 0) return 0;
  const t = Math.min(tSinceOn / rampS, 1);
  return t === 0 ? 0 : DUCK_DB * t;
}

/**
 * Wind-noise mix inside clouds: 0.35 baseline up to 1.0 at full immersion, so the
 * cloud passage only ever pushes the wind up, never mixes it away. NaN reads calm.
 */
export function cloudWind01(inCloud01: number): number {
  const x = Number.isFinite(inCloud01) ? Math.min(Math.max(inCloud01, 0), 1) : 0;
  return 0.35 + (1 - 0.35) * x;
}

/**
 * Wind-noise lift from the deck chop: 0 on a calm deck up to +0.05 at full
 * rumble. NaN reads calm.
 */
export function seaWindBoost(rumble01: number): number {
  const x = Number.isFinite(rumble01) ? Math.min(Math.max(rumble01, 0), 1) : 0;
  return 0.05 * x;
}

/**
 * P1-1 Q4: looped water-hiss gain for a skim level. 0 below the skim gate,
 * up to 0.25 hot foam at full skim x full speed, over the slower sea wash.
 */
export function splashGain01(level01: number): number {
  const x = Number.isFinite(level01) ? Math.min(Math.max(level01, 0), 1) : 0;
  return 0.25 * x;
}

/**
 * P1-2: blade-tip whine pitch follows the throttle (which is speed01 — the
 * sim is arcade, speed IS throttle). 220 Hz idle hum rising to a 400 Hz whine
 * at full chat. This partial sits above the lower exhaust and shaft pulses.
 */
export function propHumHz(throttle01: number): number {
  const x = Number.isFinite(throttle01) ? Math.min(Math.max(throttle01, 0), 1) : 0;
  return 220 + 180 * x;
}

function gainFromDb(db: number): number {
  return Math.pow(10, db / 20);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(Math.max(v, 0), 1);
}

function createContext(): AudioContext | null {
  try {
    const g = globalThis as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctor = g.AudioContext ?? g.webkitAudioContext;
    if (!Ctor) return null;
    return new Ctor({ latencyHint: 'interactive' });
  } catch {
    return null;
  }
}

/** No-op handle used when the platform has no WebAudio at all. */
function silentHandle(): AudioHandle {
  return {
    setIntensity(): void {},
    setSeaRumble(): void {},
    setCloudLevel(): void {},
    setWaterLevel(): void {},
    setPropHum(): void {},
    setBus(): void {},
    duck(): void {},
    playSfx(): void {},
    pulse(): void {},
    state(): AudioState {
      return 'off';
    },
    dispose(): void {},
  };
}

export function initAudio(): AudioHandle {
  const ctx = createContext();
  if (!ctx) return silentHandle();

  const sources = new Set<AudioScheduledSourceNode>();
  let disposed = false;
  let intensity = 0;
  let layerMix = 0;
  let throttle = 0;
  let cloud = 0;
  let seaRumble = 0;
  let nextBarTime = 0;
  let schedulerId: ReturnType<typeof setInterval> | null = null;

  // ---- master chain: slider -> limiter -> destination ----------------------
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  limiter.connect(ctx.destination);

  const master = ctx.createGain();
  master.gain.value = 0.9 * 0.9;
  master.connect(limiter);

  const musicSlider = ctx.createGain();
  const sfxSlider = ctx.createGain();
  const ambienceSlider = ctx.createGain();
  const uiSlider = ctx.createGain();
  const musicDuck = ctx.createGain();

  musicSlider.gain.value = 0.7 * 0.7;
  sfxSlider.gain.value = 0.8 * 0.8;
  ambienceSlider.gain.value = 0.6 * 0.6;
  uiSlider.gain.value = 0.7 * 0.7;
  musicDuck.gain.value = 1;

  musicSlider.connect(musicDuck);
  musicDuck.connect(master);
  sfxSlider.connect(master);
  ambienceSlider.connect(master);
  uiSlider.connect(master);

  // ---- shared noise buffer (generated once, no asset files) ---------------
  const noiseBuffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 3.7), ctx.sampleRate);
  {
    const data = noiseBuffer.getChannelData(0);
    let seed = 0x9e3779b9;
    for (let i = 0; i < data.length; i += 1) {
      // xorshift32: deterministic-ish noise, cheaper than Math.random per sample
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      data[i] = ((seed >>> 0) / 0xffffffff) * 2 - 1;
    }
  }

  const track: TrackAudioSource = (src, ...owned) => {
    sources.add(src);
    src.onended = () => {
      sources.delete(src);
      src.disconnect();
      for (const node of owned) node.disconnect();
    };
  };
  const scheduleBar = createFlightScore(ctx, musicSlider, track);
  const playCue = createFlightCues(ctx, noiseBuffer, sfxSlider, uiSlider, track);

  // Each bed samples a different stretch and speed of the shared noise.
  const noiseBed = (
    type: BiquadFilterType, frequency: number, q: number, level: number,
    rate: number, offset: number, pan: number,
  ) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    src.playbackRate.value = rate;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = level;
    const stereo = ctx.createStereoPanner();
    stereo.pan.value = pan;
    src.connect(filter).connect(gain).connect(stereo).connect(ambienceSlider);
    track(src, filter, gain, stereo);
    src.start(0, offset);
    return { filter, gain: gain.gain };
  };
  const sea = noiseBed('lowpass', 540, 0.62, 0.11, 0.77, 0.13, -0.18);
  const wind = noiseBed('bandpass', 1050, 0.78, 0.09, 1.03, 1.42, 0.12);
  const spray = noiseBed('bandpass', 2550, 0.66, 0, 1.19, 2.58, -0.10);
  const windLfo = ctx.createOscillator();
  windLfo.frequency.value = 0.17;
  const windDepth = ctx.createGain();
  windDepth.gain.value = 120;
  windLfo.connect(windDepth).connect(wind.filter.frequency);
  track(windLfo, windDepth);
  windLfo.start();

  // Unequal exhaust harmonics and a slower shaft beat give the propeller a
  // pulse that remains audible on small speakers. All three pitches track RPM.
  const exhaust = ctx.createOscillator();
  const harmonics = new Float32Array([0, 0.88, 0.48, 0.22, 0.39, 0.14, 0.20, 0.08, 0.12, 0.065, 0.08]);
  exhaust.setPeriodicWave(ctx.createPeriodicWave(new Float32Array(harmonics.length), harmonics));
  exhaust.frequency.value = propHumHz(0) / 5;
  const engineFilter = ctx.createBiquadFilter();
  engineFilter.type = 'lowpass';
  engineFilter.frequency.value = 440;
  engineFilter.Q.value = 0.65;
  const engineGain = ctx.createGain();
  engineGain.gain.value = 0.22;
  exhaust.connect(engineFilter).connect(engineGain).connect(ambienceSlider);
  const exhaustAir = ctx.createBufferSource();
  exhaustAir.buffer = noiseBuffer;
  exhaustAir.loop = true;
  exhaustAir.playbackRate.value = 0.89;
  const exhaustBand = ctx.createBiquadFilter();
  exhaustBand.type = 'bandpass';
  exhaustBand.frequency.value = 520;
  exhaustBand.Q.value = 0.92;
  exhaustAir.connect(exhaustBand).connect(engineGain);
  const shaft = ctx.createOscillator();
  shaft.frequency.value = 11;
  const throb = ctx.createGain();
  throb.gain.value = 0.052;
  shaft.connect(throb).connect(engineGain.gain);
  const blade = ctx.createOscillator();
  blade.type = 'triangle';
  blade.frequency.value = propHumHz(0);
  const bladeGain = ctx.createGain();
  bladeGain.gain.value = 0.012;
  blade.connect(bladeGain).connect(ambienceSlider);
  // Slow fluctuations in the exhaust perturb the pitch of the whole assembly
  // together. This also gives a held cruise speed some mechanical movement.
  const flutter = ctx.createBiquadFilter();
  flutter.type = 'lowpass';
  flutter.frequency.value = 7;
  flutter.Q.value = 0.6;
  const cents = ctx.createGain();
  cents.gain.value = 560;
  exhaustAir.connect(flutter).connect(cents);
  cents.connect(exhaust.detune);
  cents.connect(shaft.detune);
  cents.connect(blade.detune);
  track(exhaust, engineFilter, engineGain);
  track(exhaustAir, exhaustBand, flutter, cents);
  track(shaft, throb);
  track(blade, bladeGain);
  exhaust.start();
  exhaustAir.start(0, 0.85);
  shaft.start();
  blade.start();

  const updateWind = (): void => {
    const at = ctx.currentTime;
    // Inside a cloud the rush gets thicker and loses its bright edge.
    const colour = (1050 + 1500 * throttle) * (1 - 0.56 * cloud);
    const level = 0.09 + 0.31 * throttle + 0.46 * (cloudWind01(cloud) - cloudWind01(0)) + seaWindBoost(seaRumble);
    wind.filter.frequency.setTargetAtTime(colour, at, 0.20);
    wind.gain.setTargetAtTime(level, at, 0.20);
  };

  let duckHeld = false;
  let cueEndsAt = 0;
  let cueDb = 0;
  const setDuck = (db: number, hold?: number): void => {
    const at = ctx.currentTime;
    const gain = musicDuck.gain;
    // setTarget begins at the value the preceding envelope has actually reached.
    gain.cancelScheduledValues(at);
    gain.setTargetAtTime(gainFromDb(db), at, DUCK_RAMP_S / 4);
    if (hold !== undefined) {
      gain.setTargetAtTime(1, at + hold, DUCK_RAMP_S / 3);
      cueEndsAt = at + hold;
      cueDb = db;
    }
  };

  const sound = (cue: FlightCue, strength = 1): void => {
    if (disposed || ctx.state !== 'running' || !playCue(cue, clamp01(strength))) return;
    // Schedule the return on the audio clock, including an aborted stall warning.
    const dip = CUE_DUCK[cue];
    if (dip && !duckHeld && (ctx.currentTime >= cueEndsAt || dip.db <= cueDb)) setDuck(dip.db, dip.hold);
  };

  const pump = (): void => {
    if (disposed || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (nextBarTime < now) nextBarTime = now + 0.08;
    while (nextBarTime < now + LOOKAHEAD_S) {
      layerMix += (intensity - layerMix) * 0.6;
      scheduleBar(nextBarTime, layerMix);
      nextBarTime += SCORE_BAR_SECONDS;
    }
  };

  schedulerId = setInterval(pump, SCHEDULER_MS);
  nextBarTime = ctx.currentTime + 0.1;

  // ---- first-gesture unlock: resume without ever console.error()ing -------
  const unlock = (): void => {
    if (disposed) return;
    if (ctx.state === 'running') {
      detachUnlock();
      return;
    }
    void ctx.resume().then(
      () => {
        if (!disposed && ctx.state === 'running') detachUnlock();
      },
      () => {
        /* still blocked; leave the listeners attached for the next gesture */
      },
    );
  };
  // A touch can acquire activation on release. Capture also sees gestures
  // on mixer controls which stop propagation before they reach the canvas.
  const unlockEvents = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const;
  const detachUnlock = (): void => {
    for (const evt of unlockEvents) globalThis.removeEventListener?.(evt, unlock, true);
  };
  for (const evt of unlockEvents) {
    globalThis.addEventListener?.(evt, unlock, { capture: true, passive: true });
  }
  unlock();

  return {
    setIntensity(v: number): void {
      intensity = clamp01(v);
    },
    setSeaRumble(v: number): void {
      if (disposed) return;
      seaRumble = clamp01(v);
      sea.gain.setTargetAtTime(0.11 + 0.38 * seaRumble, ctx.currentTime, 0.22);
      sea.filter.frequency.setTargetAtTime(540 + 360 * seaRumble, ctx.currentTime, 0.22);
      updateWind();
    },
    setCloudLevel(v: number): void {
      if (disposed) return;
      cloud = clamp01(v);
      updateWind();
    },
    setWaterLevel(v: number): void {
      if (disposed) return;
      // 0.2 s fades both ways (spec §Q4): crossing the 0.5 skim edge never pops.
      spray.gain.setTargetAtTime(splashGain01(v), ctx.currentTime, 0.2);
    },
    setPropHum(v: number): void {
      if (disposed) return;
      throttle = clamp01(v);
      const at = ctx.currentTime;
      const bladeHz = propHumHz(throttle);
      exhaust.frequency.setTargetAtTime(bladeHz / 5, at, 0.23);
      shaft.frequency.setTargetAtTime(bladeHz / 20, at, 0.23);
      blade.frequency.setTargetAtTime(bladeHz, at, 0.23);
      engineFilter.frequency.setTargetAtTime(440 + 770 * throttle, at, 0.23);
      exhaustBand.frequency.setTargetAtTime(520 + 520 * throttle, at, 0.23);
      engineGain.gain.setTargetAtTime(0.22 + 0.16 * throttle, at, 0.18);
      bladeGain.gain.setTargetAtTime(0.012 + 0.019 * throttle, at, 0.18);
      updateWind();
    },
    setBus(bus: BusName, slider01: number): void {
      if (disposed) return;
      const node =
        bus === 'master'
          ? master
          : bus === 'music'
            ? musicSlider
            : bus === 'sfx'
              ? sfxSlider
              : bus === 'ambience'
                ? ambienceSlider
                : uiSlider;
      // Store the user value on the slider node itself; the duck node is separate,
      // so a dip never clobbers this.
      const value = clamp01(slider01);
      node.gain.setTargetAtTime(value === 0 ? 0 : gainFromDb(dbFromSlider(value)), ctx.currentTime, 0.03);
    },
    duck(on: boolean): void {
      if (disposed) return;
      duckHeld = on;
      cueEndsAt = 0;
      setDuck(on ? DUCK_DB : 0);
    },
    pulse(kind: PulseKind, strength = 1): void {
      sound(PULSE_CUES[kind], strength);
    },
    playSfx: sound,
    state(): AudioState {
      if (disposed) return 'off';
      return ctx.state === 'running' ? 'live' : 'blocked';
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      detachUnlock();
      if (schedulerId !== null) {
        clearInterval(schedulerId);
        schedulerId = null;
      }
      for (const src of sources) {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
      }
      sources.clear();
      for (const node of [master, musicSlider, sfxSlider, ambienceSlider, uiSlider, musicDuck, limiter]) {
        try {
          node.disconnect();
        } catch {
          /* already disconnected */
        }
      }
      void ctx.close().catch(() => undefined);
    },
  };
}
