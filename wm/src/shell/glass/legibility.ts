/**
 * The adaptive-glass solver (RFC 0006 §5.2; DSN-40, DSN-41). For one glass surface it takes the
 * backdrop that sits behind it (samples of the wallpaper after the material's blur and
 * saturation), the surface's glass colour and token alpha in both schemes, and the text roles
 * drawn on it, and returns the scheme to draw in and the smallest alpha, never below the token,
 * at which every role reaches its target plus a margin over every sample.
 *
 * Following Harrison et al. (CHI 1995), legibility through a translucent layer depends on the
 * transparency level AND on what is behind it, so the alpha becomes a function of the backdrop
 * instead of a constant. WCAG 2.x contrast is the operational proxy (testable in CI); the blur
 * low-passes the backdrop, which leaves luminance as the dominant factor.
 *
 * Pure, deterministic and framework-free: it runs in the sampling worker or on the main thread.
 */
import { contrastRatio, over, type Rgb, type Rgba, withAlpha } from './colour.ts';

export type Scheme = 'light' | 'dark';

/** A colour drawn on the glass: a text role, or an indicator (the Dock's running dot). */
export interface Role {
  readonly name: string;
  /** 'text' targets 4.5:1 (7:1 under prefers-contrast: more); 'indicator' targets 3:1 (4.5:1). */
  readonly kind: 'text' | 'indicator';
  /** Extra opacity the component applies to the colour (the running dot is at 0.85). */
  readonly opacity?: number;
}

/** A scheme's colours for one surface: the glass token and each role's colour. */
export interface SchemeColours {
  /** The glass token; its alpha is the token alpha α₀, the floor's lower bound. */
  readonly glass: Rgba;
  /** Colour per role name. A role missing here is skipped. */
  readonly roles: Readonly<Record<string, Rgba>>;
  /** Backdrops that are not wallpaper but often lie behind the surface (a window's surface). */
  readonly extraBackdrops?: readonly Rgb[];
}

export interface SolveInput {
  /** Wallpaper samples behind the surface after blur and saturate (sRGB 0..255). */
  readonly samples: readonly Rgb[];
  /** The theme's scheme. */
  readonly theme: Scheme;
  readonly colours: Readonly<Record<Scheme, SchemeColours>>;
  readonly roles: readonly Role[];
  /** Only the menu bar and the Dock, which sit directly on the wallpaper, may flip. */
  readonly flippable: boolean;
  /** prefers-contrast: more: text targets 7:1 and the any-backdrop extremes are added. */
  readonly contrastMore?: boolean;
  /**
   * Reduce transparency, forced colours or no backdrop-filter: the solver is inert (DSN-41). The
   * CSS already draws an opaque surface; no flip and no floor.
   */
  readonly locked?: boolean;
  /** Added to every target (RFC: m = 0.2). */
  readonly margin?: number;
}

export interface Solution {
  readonly scheme: Scheme;
  /** The token alpha of the chosen scheme. */
  readonly tokenAlpha: number;
  /** The alpha to draw at: >= tokenAlpha; 1 when capped (the opaque surface). 0 when inert. */
  readonly alphaFloor: number;
  /** The smallest ratio achieved at `alphaFloor` over every sample and role (observability). */
  readonly minRatio: number;
  /** 0.97 was not enough, so the surface is drawn opaque. */
  readonly capped: boolean;
  /** The scheme differs from the theme. */
  readonly flipped: boolean;
}

export const MARGIN = 0.2;
export const ALPHA_CAP = 0.97;
export const ALPHA_STEP = 0.01;
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

export function targetFor(kind: Role['kind'], contrastMore: boolean): number {
  if (kind === 'text') return contrastMore ? 7 : 4.5;
  return contrastMore ? 4.5 : 3;
}

interface Prepared {
  readonly glass: Rgba;
  readonly roles: readonly { readonly colour: Rgba; readonly need: number }[];
  readonly backdrops: readonly Rgb[];
}

function prepare(input: SolveInput, scheme: Scheme): Prepared {
  const c = input.colours[scheme];
  const more = input.contrastMore === true;
  const margin = input.margin ?? MARGIN;
  const roles: { colour: Rgba; need: number }[] = [];
  for (const role of input.roles) {
    const colour = c.roles[role.name];
    if (colour === undefined) continue;
    const a = colour[3] * (role.opacity ?? 1);
    roles.push({ colour: withAlpha(colour, a), need: targetFor(role.kind, more) + margin });
  }
  const backdrops: Rgb[] = [...dedupe(input.samples), ...(c.extraBackdrops ?? [])];
  if (more) backdrops.push(BLACK, WHITE);
  return { glass: c.glass, roles, backdrops };
}

/** Samples quantised to 2 sRGB units and de-duplicated (a blurred wallpaper repeats a lot). */
function dedupe(samples: readonly Rgb[]): Rgb[] {
  const seen = new Set<number>();
  const out: Rgb[] = [];
  for (const s of samples) {
    const q = ((s[0] >> 1) << 14) | ((s[1] >> 1) << 7) | (s[2] >> 1);
    if (seen.has(q)) continue;
    seen.add(q);
    out.push(s);
  }
  return out;
}

/** The worst ratio (divided by its need, so 1 means "exactly on target") for one backdrop. */
function slack(p: Prepared, alpha: number, backdrop: Rgb): { slack: number; ratio: number } {
  const surface = over(withAlpha(p.glass, alpha), backdrop);
  let worst = Number.POSITIVE_INFINITY;
  let ratio = Number.POSITIVE_INFINITY;
  for (const role of p.roles) {
    const r = contrastRatio(over(role.colour, surface), surface);
    const s = r / role.need;
    if (s < worst) {
      worst = s;
      ratio = r;
    }
  }
  return { slack: worst, ratio };
}

/** The minimum ratio over every backdrop and role at `alpha`. */
function minRatioAt(p: Prepared, alpha: number): number {
  let min = Number.POSITIVE_INFINITY;
  for (const b of p.backdrops) min = Math.min(min, slack(p, alpha, b).ratio);
  return min;
}

function minSlackAt(p: Prepared, alpha: number, order: readonly Rgb[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const b of order) {
    const s = slack(p, alpha, b).slack;
    if (s < min) min = s;
    if (min < 1) return min; // early exit: the worst backdrops come first
  }
  return min;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** The smallest alpha in [α₀, cap] (0.01 steps) meeting every target, or undefined. */
function solveAlpha(p: Prepared): number | undefined {
  const a0 = p.glass[3];
  if (p.roles.length === 0 || p.backdrops.length === 0) return a0;
  // Worst backdrops first, measured at the token alpha, so a failing alpha exits early.
  const order = [...p.backdrops]
    .map((b) => ({ b, s: slack(p, a0, b).slack }))
    .sort((x, y) => x.s - y.s)
    .map((x) => x.b);
  const steps = Math.max(0, Math.round((ALPHA_CAP - a0) / ALPHA_STEP));
  for (let i = 0; i <= steps; i++) {
    const alpha = i === 0 ? a0 : Math.min(ALPHA_CAP, round2(a0 + i * ALPHA_STEP));
    if (minSlackAt(p, alpha, order) >= 1) return alpha;
  }
  return undefined;
}

export function solve(input: SolveInput): Solution {
  const theme = prepare(input, input.theme);
  if (input.locked === true) {
    return {
      scheme: input.theme,
      tokenAlpha: theme.glass[3],
      alphaFloor: 0,
      minRatio: round2(minRatioAt(theme, theme.glass[3])),
      capped: false,
      flipped: false,
    };
  }
  let scheme = input.theme;
  let chosen = theme;
  if (input.flippable) {
    const otherScheme: Scheme = input.theme === 'light' ? 'dark' : 'light';
    const other = prepare(input, otherScheme);
    // As macOS does for the menu bar: keep the theme's scheme unless the other one reads better
    // over this wallpaper at the token alpha.
    if (minRatioAt(other, other.glass[3]) > minRatioAt(theme, theme.glass[3])) {
      scheme = otherScheme;
      chosen = other;
    }
  }
  const alpha = solveAlpha(chosen);
  const capped = alpha === undefined;
  const alphaFloor = alpha ?? 1;
  return {
    scheme,
    tokenAlpha: chosen.glass[3],
    alphaFloor,
    minRatio: round2(minRatioAt(chosen, alphaFloor)),
    capped,
    flipped: scheme !== input.theme,
  };
}
