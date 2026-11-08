/**
 * src/sky-preetham.ts — the Preetham sky-radiance MATH from three r186's SkyMesh,
 * as a testable pure function plus a TSL twin.
 *
 * Source: `node_modules/three/examples/jsm/objects/SkyMesh.js` lines 156–278. The
 * vertex-stage vSunE/vBetaR/vBetaM precompute is re-done per call from the sun
 * uniform (negligible cost) so the JS port and the TSL graph share one formula tree
 * and one constant table — the two MUST stay transcription-identical, same contract
 * as `horizon.ts`.
 *
 * Deliberately STRIPPED from the source:
 * - the fbm cloud block (SkyMesh.js 280–379) — we have our own clouds;
 * - the `sundisc` term (SkyMesh.js 275) — the disc is a DIRECT term added outside
 *   the energy field (`skyColorTsl` v2), because vSunE is identically 0 below sun
 *   elevation −2.31° and a disc inside E would be multiplied into nothing at the
 *   transition keys.
 *
 * Kept VERBATIM:
 * - the earth-shadow hack (cutoffAngle / steepness / EE);
 * - the ×0.04 exposure factor (`(Lin + L0) × 0.04`);
 * - the blue-bottom constant `vec3(0.0, 0.0003, 0.00075)` (SkyMesh.js 278). It is
 *   added AFTER the 0.04 and does NOT cancel in the reference ratio (same function,
 *   same inputs → numerator = denominator → ratio exactly 1); at non-reference keys
 *   the dark-region (P < 0.05) blue channel ratio carries a known 1%–15% bias from
 *   it — accepted, do NOT "fix" by removing the constant.
 *
 * Pure module: no THREE import; `tsl` is passed in by the caller (module-graph.test.ts
 * forbids src-root static imports of three/webgpu|tsl).
 */
import type { PreethamParams, Vec3 } from './sky-track';

export type { PreethamParams };

// ---- shared constant table (SkyMesh.js 156–278, verbatim) ----------------------------

const E = 2.718281828459045;
const PI = 3.141592653589793;

/** wavelength of used primaries, according to preetham (pre-calculated TotalRayleigh). */
const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];

/** pi * pow((2*pi)/lambda, v-2) * K for the Mie primaries. */
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];

/** earth shadow hack. */
const CUTOFF_ANGLE = 1.6110731556870734;
const STEEPNESS = 1.5;
const EE = 1000.0;

const RAYLEIGH_ZENITH_LENGTH = 8.4e3;
const MIE_ZENITH_LENGTH = 1.25e3;
const THREE_OVER_SIXTEENPI = 0.05968310365946075; // 3.0 / (16.0 * pi)
const ONE_OVER_FOURPI = 0.07957747154594767; // 1.0 / (4.0 * pi)

/** SkyMesh.js 278's blue-bottom constant — kept, see module docblock. */
const BLUE_BOTTOM = [0.0, 0.0003, 0.00075];

const clamp01 = (x: number): number => Math.min(Math.max(x, 0), 1);

// ---- JS reference implementation ------------------------------------------------------

/** Sun intensity factor EE·max(0, 1 − e^(−(cutoff − acos(clamp(sun.y))))/steepness). Identically 0 below sun elevation ≈ −2.31°. */
function sunIntensityF(sunYNorm: number): number {
  const zenithAngleCos = Math.min(Math.max(sunYNorm, -1), 1);
  const exponent = -((CUTOFF_ANGLE - Math.acos(zenithAngleCos)) / STEEPNESS);
  return EE * Math.max(0, 1 - Math.pow(E, exponent));
}

/**
 * Preetham radiance for one view direction — faithful port of SkyMesh.js 156–278
 * minus the sundisc term, output `(Lin + L0) × 0.04 + BLUE_BOTTOM`.
 */
export function preethamRadianceJs(dir: Vec3, sun: Vec3, p: PreethamParams): Vec3 {
  // vertex-stage precompute, redone per call (SkyMesh.js 167–217)
  const sunLen = Math.hypot(sun[0], sun[1], sun[2]) || 1;
  const sunY = sun[1] / sunLen;
  const sunX = sun[0] / sunLen;
  const sunZ = sun[2] / sunLen;
  const vSunE = sunIntensityF(sunY);
  // sun fade uses the RAW sun y (SkyMesh.js 220 uses this.sunPosition.y, un-normalized)
  const sunfade = 1 - clamp01(1 - Math.exp(sun[1] / 450000.0));
  const rayleighCoefficient = p.rayleigh - 1.0 * (1.0 - sunfade);
  const vBetaR = TOTAL_RAYLEIGH.map((v) => v * rayleighCoefficient);
  const c = 0.2 * p.turbidity * 10e-18;
  const vBetaM = MIE_CONST.map((v) => 0.434 * c * v * p.mieCoefficient);

  // fragment-stage radiance (SkyMesh.js 246–278)
  const dirLen = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const dy = dir[1] / dirLen;
  // upper clamp is defensive (normalized y can round to 1+ε and acos would NaN);
  // matches the source's `max(0.0, direction.y)` intent
  const zenithAngle = Math.acos(Math.min(Math.max(dy, 0), 1));
  const inverse =
    1 / (Math.cos(zenithAngle) + 0.15 * Math.pow(93.885 - ((zenithAngle * 180) / PI), -1.253));
  const sR = RAYLEIGH_ZENITH_LENGTH * inverse;
  const sM = MIE_ZENITH_LENGTH * inverse;
  const cosTheta = (dir[0] / dirLen) * sunX + dy * sunY + (dir[2] / dirLen) * sunZ;

  const cc = cosTheta * 0.5 + 0.5;
  const rPhase = THREE_OVER_SIXTEENPI * (1 + cc * cc);
  const g2 = p.mieDirectionalG * p.mieDirectionalG;
  const inv = 1 / Math.pow(1 - 2 * p.mieDirectionalG * cosTheta + g2, 1.5);
  const mPhase = ONE_OVER_FOURPI * (1 - g2) * inv;

  const out = [0, 1, 2].map((i) => {
    const Fex = Math.exp(-(vBetaR[i] * sR + vBetaM[i] * sM));
    const common = vSunE * ((vBetaR[i] * rPhase + vBetaM[i] * mPhase) / (vBetaR[i] + vBetaM[i]));
    let lin = Math.pow(common * (1 - Fex), 1.5);
    // Lin *= mix(vec3(1), pow(common*Fex, 1/2), clamp(pow(1-sunY, 5), 0, 1))
    const mixT = clamp01(Math.pow(1 - sunY, 5));
    lin *= (1 - mixT) * 1 + mixT * Math.pow(common * Fex, 1 / 2);
    const L0 = 0.1 * Fex; // nightsky
    return (lin + L0) * 0.04 + BLUE_BOTTOM[i];
  });
  const [r, g, b] = out;
  return [r, g, b];
}

/**
 * The per-channel energy ratio the sky v2 multiplies into the DUSK term only:
 * `clamp(P(dir, sun, p) / P(dir, refSun, refP), 0, 2)`. Division-by-zero and NaN
 * collapse to 0 (a direction the reference cannot light should not brighten).
 */
export function energyRatioJs(
  dir: Vec3,
  sun: Vec3,
  p: PreethamParams,
  refSun: Vec3,
  refP: PreethamParams,
): Vec3 {
  const num = preethamRadianceJs(dir, sun, p);
  const den = preethamRadianceJs(dir, refSun, refP);
  const out = [0, 1, 2].map((i) => {
    const n = num[i];
    const d = den[i];
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
    return Math.min(Math.max(n / d, 0), 2);
  });
  const [r, g, b] = out;
  return [r, g, b];
}

// ---- TSL twin (same formula tree, same constant table) --------------------------------

export interface PreethamUniforms {
  turbidity: unknown;
  rayleigh: unknown;
  mieCoefficient: unknown;
  mieDirectionalG: unknown;
}

/**
 * TSL version of `preethamRadianceJs` — transcription of the SAME tree with the
 * caller-provided `tsl` namespace and four `uniform()` parameter nodes (the track
 * writes their `.value` per frame; no recompilation).
 */
export function preethamRadianceTsl(
  tsl: any,
  dirNode: any,
  sunDirNode: any,
  paramsU: PreethamUniforms,
): any {
  const { float, vec3, normalize, clamp, max, pow, exp, acos, cos, dot, mix } = tsl;

  // vertex-stage precompute
  const sunDirection = normalize(sunDirNode);
  const vSunE = float(EE).mul(
    max(
      0.0,
      float(1.0).sub(
        pow(float(E), float(CUTOFF_ANGLE).sub(acos(clamp(sunDirection.y, -1, 1))).div(STEEPNESS).negate()),
      ),
    ),
  );
  const sunfade = float(1.0).sub(clamp(float(1.0).sub(exp(sunDirNode.y.div(450000.0))), 0, 1));
  const rayleighCoefficient = float(paramsU.rayleigh).sub(float(1.0).mul(float(1.0).sub(sunfade)));
  const vBetaR = vec3(...TOTAL_RAYLEIGH).mul(rayleighCoefficient);
  const c = float(0.2).mul(float(paramsU.turbidity)).mul(10e-18);
  const vBetaM = vec3(...MIE_CONST).mul(float(0.434)).mul(c).mul(float(paramsU.mieCoefficient));

  // fragment-stage radiance
  const direction = normalize(dirNode);
  const zenithAngle = acos(max(0.0, direction.y));
  const inverse = float(1.0).div(
    cos(zenithAngle).add(float(0.15).mul(pow(float(93.885).sub(zenithAngle.mul(180.0).div(PI)), -1.253))),
  );
  const sR = float(RAYLEIGH_ZENITH_LENGTH).mul(inverse);
  const sM = float(MIE_ZENITH_LENGTH).mul(inverse);
  const Fex = exp(vBetaR.mul(sR).add(vBetaM.mul(sM)).negate());

  const cosTheta = dot(direction, sunDirection);
  const cc = cosTheta.mul(0.5).add(0.5);
  const rPhase = float(THREE_OVER_SIXTEENPI).mul(float(1.0).add(pow(cc, 2.0)));
  const g2 = pow(float(paramsU.mieDirectionalG), 2.0);
  const inv = float(1.0).div(
    pow(float(1.0).sub(float(2.0).mul(float(paramsU.mieDirectionalG)).mul(cosTheta)).add(g2), 1.5),
  );
  const mPhase = float(ONE_OVER_FOURPI).mul(float(1.0).sub(g2)).mul(inv);

  const common = vSunE.mul(vBetaR.mul(rPhase).add(vBetaM.mul(mPhase)).div(vBetaR.add(vBetaM)));
  let Lin = pow(common.mul(float(1.0).sub(Fex)), vec3(1.5));
  Lin = Lin.mul(
    mix(
      vec3(1.0),
      pow(common.mul(Fex), vec3(1.0 / 2.0)),
      clamp(pow(float(1.0).sub(sunDirection.y), 5.0), 0.0, 1.0),
    ),
  );
  const L0 = vec3(0.1).mul(Fex); // nightsky

  return Lin.add(L0).mul(0.04).add(vec3(...BLUE_BOTTOM));
}
