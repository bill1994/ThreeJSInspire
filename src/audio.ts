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

/** Slider travel mapped to silence: finite floor, never -Infinity. */
export const SLIDER_FLOOR_DB = -80;

/** dB of the sidechain dip on the music bus. */
export const DUCK_DB = -12;

/** Seconds the duck ramp takes down and back up. */
export const DUCK_RAMP_S = 0.25;

const BPM = 96;
const BEAT_S = 60 / BPM;
const BAR_S = BEAT_S * 4;
const CROSSFADE_S = 0.35;
const SCHEDULER_MS = 120;
const LOOKAHEAD_S = 0.4;

export type BusName = 'master' | 'music' | 'sfx' | 'ambience' | 'ui';
export type SfxKind = 'ui' | 'hit' | 'sting' | 'whoosh';
/** Gameplay-driven one-shots; the edges are detected in game.ts. */
export type PulseKind = 'stall' | 'dive' | 'cloud' | 'water' | 'line';
/** 'off' = no WebAudio at all, 'blocked' = waiting for the first user gesture, 'live' = running. */
export type AudioState = 'off' | 'blocked' | 'live';

export interface AudioHandle {
  /** 0..1 gameplay intensity; drives the vertical music layer crossfade + engine pitch. */
  setIntensity(v: number): void;
  /** 0..1 deck-chop rumble; lifts the wind hiss without touching music or engine. */
  setSeaRumble(v: number): void;
  /** Slider is 0..1 travel, mapped to gain*gain dB. Safe at 0 (true silence). */
  setBus(bus: BusName, slider01: number): void;
  /** Sidechain dip on the music bus (-12 dB / 0.25 s), independent of the slider. */
  duck(on: boolean): void;
  /** One-shot SFX with ±1 semitone pitch variation. */
  playSfx(kind: SfxKind): void;
  /** Gameplay edge one-shot: acts only while the context is live, allocates nothing. */
  pulse(kind: PulseKind): void;
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
 * rumble. The wind voice is already a 1500 Hz bandpass, so the lift lands as
 * high-frequency hiss riding over the engine — never a low wash. NaN reads calm.
 */
export function seaWindBoost(rumble01: number): number {
  const x = Number.isFinite(rumble01) ? Math.min(Math.max(rumble01, 0), 1) : 0;
  return 0.05 * x;
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
  let layerMix = 0; // 0 = calm pad, 1 = chase drums; changes only at bar boundaries
  let cloudBoost = 0; // latched by pulse('cloud'); the wind stays livelier afterwards
  let seaRumble = 0; // continuous deck-chop feed from the sim; lifts the wind hiss
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
  const noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.0), ctx.sampleRate);
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

  const track = <T extends AudioScheduledSourceNode>(src: T): T => {
    sources.add(src);
    src.onended = () => {
      sources.delete(src);
    };
    return src;
  };

  // ---- music layer 1: calm pad --------------------------------------------
  const padGain = ctx.createGain();
  padGain.gain.value = 1 - layerMix;
  padGain.connect(musicSlider);

  const padFilter = ctx.createBiquadFilter();
  padFilter.type = 'lowpass';
  padFilter.frequency.value = 620;
  padFilter.Q.value = 0.6;
  padFilter.connect(padGain);

  const padFilterLfo = ctx.createOscillator();
  padFilterLfo.frequency.value = 0.07;
  const padFilterDepth = ctx.createGain();
  padFilterDepth.gain.value = 260;
  padFilterLfo.connect(padFilterDepth);
  padFilterDepth.connect(padFilter.frequency);
  track(padFilterLfo);
  padFilterLfo.start();

  const PAD_HZ = [110, 130.81, 164.81, 220]; // A minor add9, slow and open
  for (let i = 0; i < PAD_HZ.length; i += 1) {
    const osc = ctx.createOscillator();
    osc.type = i === 0 ? 'triangle' : 'sine';
    osc.frequency.value = PAD_HZ[i];
    osc.detune.value = (i % 2 === 0 ? 1 : -1) * 5;
    const g = ctx.createGain();
    g.gain.value = i === 0 ? 0.16 : 0.08;
    osc.connect(g);
    g.connect(padFilter);
    track(osc);
    osc.start();
  }

  // ---- music layer 2: chase drums (scheduled per bar) ---------------------
  const drumsGain = ctx.createGain();
  drumsGain.gain.value = layerMix;
  drumsGain.connect(musicSlider);

  const kick = (at: number, velocity: number): void => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, at);
    osc.frequency.exponentialRampToValueAtTime(46, at + 0.16);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(0.9 * velocity, at + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.26);
    osc.connect(env);
    env.connect(drumsGain);
    track(osc);
    osc.start(at);
    osc.stop(at + 0.3);
  };

  const hat = (at: number, velocity: number): void => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6800;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(0.35 * velocity, at + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
    src.connect(hp);
    hp.connect(env);
    env.connect(drumsGain);
    track(src);
    src.start(at, 0, 0.09);
  };

  const scheduleBar = (t0: number): void => {
    if (layerMix <= 0.001) return;
    kick(t0, 1);
    kick(t0 + 2 * BEAT_S, 0.85);
    for (let i = 0; i < 8; i += 1) {
      hat(t0 + (i * BEAT_S) / 2, i % 2 === 0 ? 0.7 : 0.3);
    }
  };

  const applyLayerMix = (at: number, mix: number): void => {
    padGain.gain.cancelScheduledValues(at);
    padGain.gain.setValueAtTime(padGain.gain.value, at);
    padGain.gain.linearRampToValueAtTime(1 - mix * 0.85, at + CROSSFADE_S);
    drumsGain.gain.cancelScheduledValues(at);
    drumsGain.gain.setValueAtTime(drumsGain.gain.value, at);
    drumsGain.gain.linearRampToValueAtTime(mix, at + CROSSFADE_S);
  };

  // ---- ambience: sea + wind + engine, all noise/oscillator driven ---------
  const seaSrc = ctx.createBufferSource();
  seaSrc.buffer = noiseBuffer;
  seaSrc.loop = true;
  const seaBand = ctx.createBiquadFilter();
  seaBand.type = 'bandpass';
  seaBand.frequency.value = 520;
  seaBand.Q.value = 0.7;
  const seaGain = ctx.createGain();
  seaGain.gain.value = 0.16;
  seaSrc.connect(seaBand);
  seaBand.connect(seaGain);
  seaGain.connect(ambienceSlider);
  track(seaSrc);
  seaSrc.start();

  const windSrc = ctx.createBufferSource();
  windSrc.buffer = noiseBuffer;
  windSrc.loop = true;
  const windBand = ctx.createBiquadFilter();
  windBand.type = 'bandpass';
  windBand.frequency.value = 1500;
  windBand.Q.value = 1.2;
  const windGain = ctx.createGain();
  windGain.gain.value = 0.05;
  const windLfo = ctx.createOscillator();
  windLfo.frequency.value = 0.18;
  const windLfoDepth = ctx.createGain();
  windLfoDepth.gain.value = 450;
  windLfo.connect(windLfoDepth);
  windLfoDepth.connect(windBand.frequency);
  windSrc.connect(windBand);
  windBand.connect(windGain);
  windGain.connect(ambienceSlider);
  track(windSrc);
  track(windLfo);
  windSrc.start();
  windLfo.start();

  const engineOsc = ctx.createOscillator();
  engineOsc.type = 'sawtooth';
  engineOsc.frequency.value = 70;
  const engineSub = ctx.createOscillator();
  engineSub.type = 'sine';
  engineSub.frequency.value = 35;
  const engineFilter = ctx.createBiquadFilter();
  engineFilter.type = 'lowpass';
  engineFilter.frequency.value = 420;
  const engineGain = ctx.createGain();
  engineGain.gain.value = 0.045;
  engineOsc.connect(engineFilter);
  engineSub.connect(engineFilter);
  engineFilter.connect(engineGain);
  engineGain.connect(ambienceSlider);
  track(engineOsc);
  track(engineSub);
  engineOsc.start();
  engineSub.start();

  const applyIntensity = (v: number): void => {
    if (disposed) return;
    const at = ctx.currentTime;
    engineOsc.frequency.setTargetAtTime(58 + 96 * v, at, 0.08);
    engineSub.frequency.setTargetAtTime(29 + 44 * v, at, 0.08);
    engineFilter.frequency.setTargetAtTime(360 + 900 * v, at, 0.12);
    engineGain.gain.setTargetAtTime(0.04 + 0.05 * v, at, 0.15);
    windGain.gain.setTargetAtTime(0.04 + 0.11 * v + 0.07 * cloudBoost + seaWindBoost(seaRumble), at, 0.2);
  };

  // Duck body shared by duck() and pulse('stall') — one scheduling path, no timers.
  const applyDuck = (on: boolean): void => {
    if (disposed) return;
    const at = ctx.currentTime;
    const target = on ? gainFromDb(DUCK_DB) : 1;
    musicDuck.gain.cancelScheduledValues(at);
    musicDuck.gain.setValueAtTime(musicDuck.gain.value, at);
    musicDuck.gain.linearRampToValueAtTime(target, at + DUCK_RAMP_S);
  };

  // ---- scheduler: quantises the layer switch to the next bar --------------
  const pump = (): void => {
    if (disposed || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (nextBarTime < now) nextBarTime = now + 0.08;
    while (nextBarTime < now + LOOKAHEAD_S) {
      const target = intensity;
      // Snap the crossfade decision to the bar line, not the frame.
      layerMix += (target - layerMix) * 0.6;
      applyLayerMix(nextBarTime, layerMix);
      scheduleBar(nextBarTime);
      nextBarTime += BAR_S;
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
        applyIntensity(intensity);
        detachUnlock();
      },
      () => {
        /* still blocked; leave the listeners attached for the next gesture */
      },
    );
  };
  const unlockEvents = ['pointerdown', 'touchstart', 'keydown'] as const;
  const detachUnlock = (): void => {
    for (const evt of unlockEvents) globalThis.removeEventListener?.(evt, unlock);
  };
  for (const evt of unlockEvents) {
    globalThis.addEventListener?.(evt, unlock, { passive: true });
  }
  unlock();

  return {
    setIntensity(v: number): void {
      intensity = clamp01(v);
      applyIntensity(intensity);
    },
    setSeaRumble(v: number): void {
      seaRumble = clamp01(v);
      applyIntensity(intensity);
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
      node.gain.setTargetAtTime(gainFromDb(dbFromSlider(slider01)), ctx.currentTime, 0.03);
      if (bus === 'music') applyIntensity(intensity);
    },
    duck(on: boolean): void {
      applyDuck(on);
    },
    pulse(kind: PulseKind): void {
      if (disposed || ctx.state !== 'running') return;
      switch (kind) {
        case 'stall':
          this.playSfx('sting');
          applyDuck(true);
          break;
        case 'dive':
          this.setIntensity(1);
          break;
        case 'cloud':
          // Latched: once the aircraft has been inside a cloud the wind keeps some
          // of that energy (recovering it would need a continuous per-frame feed).
          cloudBoost = cloudWind01(1);
          applyIntensity(intensity);
          break;
        case 'water':
          // A water hit: the noise burst reads as spray. No music duck — a deck scrape
          // is a small-tier event and must not pull the mix down every frame.
          this.playSfx('whoosh');
          break;
        case 'line':
          this.playSfx('ui');
          break;
      }
    },
    playSfx(kind: SfxKind): void {
      if (disposed || ctx.state !== 'running') return;
      const at = ctx.currentTime + 0.005;
      const bus = kind === 'ui' ? uiSlider : sfxSlider;
      // ±1 semitone variation so repeated hits never machine-gun.
      const pitch = Math.pow(2, (Math.random() * 2 - 1) / 12);
      if (kind === 'ui' || kind === 'sting') {
        const base = kind === 'ui' ? 880 : 220;
        const osc = ctx.createOscillator();
        osc.type = kind === 'ui' ? 'triangle' : 'sawtooth';
        osc.frequency.setValueAtTime(base * pitch, at);
        if (kind === 'sting') {
          osc.frequency.exponentialRampToValueAtTime(base * 1.2 * pitch, at + 0.42);
        }
        const env = ctx.createGain();
        const dur = kind === 'ui' ? 0.08 : 0.5;
        env.gain.setValueAtTime(0.0001, at);
        env.gain.exponentialRampToValueAtTime(kind === 'ui' ? 0.3 : 0.22, at + 0.01);
        env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        osc.connect(env);
        env.connect(bus);
        track(osc);
        osc.start(at);
        osc.stop(at + dur + 0.02);
        return;
      }
      const src = ctx.createBufferSource();
      src.buffer = noiseBuffer;
      src.playbackRate.value = pitch;
      const filter = ctx.createBiquadFilter();
      filter.type = kind === 'whoosh' ? 'bandpass' : 'lowpass';
      filter.frequency.setValueAtTime(kind === 'whoosh' ? 900 : 1400, at);
      if (kind === 'whoosh') {
        filter.frequency.exponentialRampToValueAtTime(320, at + 0.32);
        filter.Q.value = 1.6;
      }
      const env = ctx.createGain();
      const dur = kind === 'whoosh' ? 0.34 : 0.18;
      env.gain.setValueAtTime(0.0001, at);
      env.gain.exponentialRampToValueAtTime(0.5, at + 0.008);
      env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      src.connect(filter);
      filter.connect(env);
      env.connect(bus);
      track(src);
      src.start(at, 0, dur + 0.02);
    },
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
