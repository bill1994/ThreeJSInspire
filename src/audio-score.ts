/** An original eight-bar flying waltz for plucked strings and a soft reed. */
import type { TrackAudioSource } from './audio';

const BEAT = 60 / 90;
export const SCORE_BAR_SECONDS = 3 * BEAT;

type LeadNote = readonly [beat: number, midi: number, beats: number];
interface Bar {
  bass: number;
  strings: readonly [number, number, number];
  lead: readonly LeadNote[];
}

// Dmaj9 · Bm7 · Gmaj7 · A7 · D/F# · Bm7 · Em7 · A7
const PHRASE: readonly Bar[] = [
  { bass: 50, strings: [57, 64, 66], lead: [[0.5, 69, 0.8], [1.5, 73, 0.42], [2, 74, 0.88]] },
  { bass: 47, strings: [54, 57, 62], lead: [[0, 71, 1.35], [1.5, 66, 0.94]] },
  { bass: 43, strings: [54, 59, 62], lead: [[0.5, 67, 0.65], [1.5, 69, 0.42], [2, 71, 0.9]] },
  { bass: 45, strings: [55, 61, 64], lead: [[0, 69, 0.74], [1, 64, 1.4]] },
  { bass: 54, strings: [57, 62, 66], lead: [[0.5, 66, 0.43], [1, 69, 0.85], [2, 74, 0.88]] },
  { bass: 47, strings: [54, 57, 62], lead: [[0, 76, 1.34], [1.5, 74, 0.43], [2, 71, 0.78]] },
  { bass: 52, strings: [55, 59, 62], lead: [[0, 67, 1.36], [1.5, 66, 0.42], [2, 64, 0.8]] },
  { bass: 45, strings: [55, 61, 64], lead: [[0, 61, 0.84], [1, 64, 1.1]] },
];

const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

export function createFlightScore(ctx: BaseAudioContext, bus: AudioNode, track: TrackAudioSource) {
  const strings = ctx.createStereoPanner();
  strings.pan.value = -0.24;
  strings.connect(bus);
  const reed = ctx.createStereoPanner();
  reed.pan.value = 0.16;
  reed.connect(bus);

  // A single quiet reflection gives the two instruments a shared space.
  const room = ctx.createDelay(0.2);
  room.delayTime.value = 0.093;
  const warmth = ctx.createBiquadFilter();
  warmth.type = 'lowpass';
  warmth.frequency.value = 1650;
  const returnGain = ctx.createGain();
  returnGain.gain.value = 0.13;
  strings.connect(room);
  reed.connect(room);
  room.connect(warmth).connect(returnGain).connect(bus);

  const stringPartials = new Float32Array([0, 1, 0.58, 0.29, 0.14, 0.09, 0.045, 0.025]);
  const reedPartials = new Float32Array([0, 1, 0.13, 0.32, 0.045, 0.09, 0.025]);
  const nylon = ctx.createPeriodicWave(new Float32Array(stringPartials.length), stringPartials);
  const reedWave = ctx.createPeriodicWave(new Float32Array(reedPartials.length), reedPartials);

  const pluck = (at: number, midi: number, level: number, ring: number): void => {
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(nylon);
    osc.frequency.value = hz(midi);
    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.Q.value = 0.55;
    body.frequency.setValueAtTime(2600, at);
    body.frequency.exponentialRampToValueAtTime(540, at + ring * 0.7);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(level, at + 0.009);
    env.gain.exponentialRampToValueAtTime(level * 0.26, at + ring * 0.34);
    env.gain.exponentialRampToValueAtTime(0.0001, at + ring);
    osc.connect(body).connect(env).connect(strings);
    track(osc, body, env);
    osc.start(at);
    osc.stop(at + ring + 0.01);
  };

  const playReed = (at: number, midi: number, duration: number, level: number): void => {
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(reedWave);
    osc.frequency.value = hz(midi);
    osc.detune.setValueAtTime(-9, at);
    osc.detune.setTargetAtTime(0, at + 0.025, 0.035);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(level, at + 0.085);
    env.gain.linearRampToValueAtTime(level * 0.76, at + duration * 0.76);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration + 0.07);
    osc.connect(env).connect(reed);
    track(osc, env);
    osc.start(at);
    osc.stop(at + duration + 0.08);
  };

  let barNumber = 0;
  return (at: number, intensity: number): void => {
    const barIndex = barNumber % PHRASE.length;
    const reprise = barNumber >= PHRASE.length;
    const bar = PHRASE[barIndex];
    barNumber = (barNumber + 1) % (PHRASE.length * 2);
    const lift = Math.max(0, (intensity - 0.36) / 0.64);
    const [low, mid, high] = bar.strings;
    pluck(at, bar.bass, 0.23, 1.15);
    pluck(at + BEAT + 0.009, low, 0.12, 0.85);
    pluck(at + BEAT + 0.036, mid, 0.095, 0.70);
    pluck(at + BEAT * 2 + 0.014, high, 0.13, 0.91);
    if (lift > 0.02) {
      pluck(at + BEAT * 1.52, high, 0.12 * lift, 0.48);
      pluck(at + BEAT * 2.52, mid, 0.14 * lift, 0.48);
    }
    // On the second pass the strings carry the opening and the final cadence.
    if (reprise && (barIndex < 2 || barIndex === 7)) return;
    for (const [beat, midi, beats] of bar.lead) {
      playReed(at + beat * BEAT, midi, beats * BEAT, 0.136 - 0.035 * lift);
    }
  };
}
