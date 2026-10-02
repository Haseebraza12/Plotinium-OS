// @ts-check
/**
 * Geometry of the Plotinium mark ("Bohr P", docs/design/logo/DECISION.md), shared by the
 * identity-kit builder (build-identity.mjs) and used once to write the path data in
 * ui/src/icons/atom-logo.ts. Every number here was chosen by hand; this file only turns them
 * into exact arc end points, so the drawings stay true circles with round ends.
 *
 * The mark, on a 24-unit grid:
 *   - the shell: a ring (outer radius 7.5, width 3) around (12, 9), open around the electron;
 *   - the stem: a 3-unit bar from the shell's left side down to y = 22.5, round at both ends
 *     (the top end hides under the shell); shell plus stem read as a "P";
 *   - the nucleus: a solid disc (r 2.8) at the shell's centre;
 *   - the electron: a disc (r 2) on the shell's centre line at 1:30 (-45 deg), in the shell's gap,
 *     with 1.25 units of clear space to each round end of the shell.
 *
 * Coordinates are y-down (SVG); angles are degrees, 0 = 3 o'clock, -90 = 12 o'clock.
 */

import { pathToFileURL } from 'node:url';

/** Rounds to 3 decimals and prints without a trailing zero or a negative zero. */
export const n = (/** @type {number} */ v) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

const rad = (/** @type {number} */ d) => (d * Math.PI) / 180;

/** @returns {[number, number]} */
const at = (
  /** @type {number} */ cx,
  /** @type {number} */ cy,
  /** @type {number} */ r,
  /** @type {number} */ a,
) => [cx + r * Math.cos(rad(a)), cy + r * Math.sin(rad(a))];

/**
 * @typedef {object} MarkSpec
 * @property {number} cx shell centre x
 * @property {number} cy shell centre y
 * @property {number} ro shell outer radius
 * @property {number} sw shell and stem width
 * @property {number} nr nucleus radius
 * @property {number} ea electron angle (deg)
 * @property {number} er electron radius
 * @property {number} clear clear space between the electron and each shell end
 * @property {number} bottom lowest point of the stem (its round end included)
 */

/** The master mark: 24-unit grid, edges on multiples of 1.5 (whole pixels at 16, 32 and 48 px). */
export const MASTER = /** @type {MarkSpec} */ ({
  cx: 12,
  cy: 9,
  ro: 7.5,
  sw: 3,
  nr: 2.8,
  ea: -45,
  er: 2,
  clear: 1.25,
  bottom: 22.5,
});

/** Hinted for 20 px (and 40, 60 ...): edges on multiples of 1.2 units (whole pixels at 20 px). */
export const HINT_20 = /** @type {MarkSpec} */ ({
  cx: 12,
  cy: 8.4,
  ro: 7.2,
  sw: 2.4,
  nr: 2.7,
  ea: -45,
  er: 1.95,
  clear: 1.2,
  bottom: 22.8,
});

/** Hinted for 24 px (and 72, 120 ...): the master moved half a unit onto whole pixels. */
export const HINT_24 = /** @type {MarkSpec} */ ({ ...MASTER, cx: 12.5, cy: 8.5, bottom: 22 });

/** The favicon: its own 16-unit grid, one unit per pixel at 16 px. */
export const FAVICON_16 = /** @type {MarkSpec} */ ({
  cx: 8,
  cy: 6,
  ro: 5,
  sw: 2,
  nr: 1.75,
  ea: -45,
  er: 1.3,
  clear: 1,
  bottom: 15,
});

/**
 * @param {MarkSpec} s
 * @returns {{ shell: string, stem: string, nucleus: { cx: string, cy: string, r: string },
 *   electron: { cx: string, cy: string, r: string }, gapDeg: number }}
 */
export function mark(s) {
  const ri = s.ro - s.sw;
  const rc = s.ro - s.sw / 2;
  const h = s.sw / 2;
  // Half the gap (deg): the chord from the electron's centre to a shell end's cap centre equals
  // cap radius + electron radius + clear space.
  const g = (2 * Math.asin((h + s.er + s.clear) / (2 * rc)) * 180) / Math.PI;
  const a1 = s.ea + g; // shell starts just clockwise of the electron ...
  const a2 = s.ea - g + 360; // ... and runs clockwise all the way round to just before it
  const [o1x, o1y] = at(s.cx, s.cy, s.ro, a1);
  const [o2x, o2y] = at(s.cx, s.cy, s.ro, a2);
  const [i2x, i2y] = at(s.cx, s.cy, ri, a2);
  const [i1x, i1y] = at(s.cx, s.cy, ri, a1);
  const large = 360 - 2 * g > 180 ? 1 : 0;
  const shell =
    `M${n(o1x)} ${n(o1y)}` +
    `A${n(s.ro)} ${n(s.ro)} 0 ${large} 1 ${n(o2x)} ${n(o2y)}` +
    `A${n(h)} ${n(h)} 0 0 1 ${n(i2x)} ${n(i2y)}` +
    `A${n(ri)} ${n(ri)} 0 ${large} 0 ${n(i1x)} ${n(i1y)}` +
    `A${n(h)} ${n(h)} 0 0 1 ${n(o1x)} ${n(o1y)}Z`;
  const x1 = s.cx - s.ro;
  const x2 = x1 + s.sw;
  const top = s.cy;
  const stem =
    `M${n(x1)} ${n(top)}V${n(s.bottom - h)}` +
    `A${n(h)} ${n(h)} 0 0 0 ${n(x2)} ${n(s.bottom - h)}` +
    `V${n(top)}A${n(h)} ${n(h)} 0 0 0 ${n(x1)} ${n(top)}Z`;
  const [ex, ey] = at(s.cx, s.cy, rc, s.ea);
  return {
    shell,
    stem,
    nucleus: { cx: n(s.cx), cy: n(s.cy), r: n(s.nr) },
    electron: { cx: n(ex), cy: n(ey), r: n(s.er) },
    gapDeg: 2 * g,
  };
}

// `node docs/design/logo/mark-geometry.mjs` prints the path data for atom-logo.ts.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [name, spec] of Object.entries({ MASTER, HINT_20, HINT_24, FAVICON_16 })) {
    console.log(name, JSON.stringify(mark(spec), null, 2));
  }
}
