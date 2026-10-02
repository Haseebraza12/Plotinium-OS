/**
 * The text of idx50k's file: Markdown field notes on the migration of Arctic terns, generated from
 * a seed (mulberry32), ASCII only, of an exact byte size, with a unique marker word in its first
 * and last paragraphs. The same seed always gives the same bytes; another seed gives other text and
 * another marker (a "modify" in the RAG-02 demonstration).
 */
import { mulberry32 } from './pattern.ts';
import type { Rng } from './pattern.ts';

const SYLLABLES = [
  'quor',
  'vel',
  'line',
  'tras',
  'zan',
  'mir',
  'obe',
  'thu',
  'dra',
  'sen',
  'pho',
  'ryx',
  'cal',
  'ind',
  'ome',
];

const PLACES = [
  'Svalbard',
  'east Greenland',
  'the Westfjords of Iceland',
  'the Faroe Islands',
  'Shetland',
  'the Wadden Sea',
  'the Farne Islands',
  'the coast of Namibia',
  'the Weddell Sea',
  'Tierra del Fuego',
  'the Azores',
  'Nova Scotia',
];
const SEAS = [
  'the Norwegian Sea',
  'the North Atlantic',
  'the Benguela current',
  'the Southern Ocean',
  'the Drake Passage',
  'the Canary current',
];
const DIRECTIONS = ['north', 'south', 'south-west', 'south-east', 'north-east', 'west'];
const WEATHER = [
  'low cloud',
  'a clear sky',
  'drizzle',
  'fog banks',
  'a steady tailwind',
  'squalls from the west',
];
const PREY = ['sand eels', 'krill swarms', 'juvenile herring', 'capelin', 'small squid'];
const STATES = [
  'in breeding plumage',
  'moulting its primaries',
  'carrying a geolocator',
  'feeding a fledgling',
];

function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new RangeError('pick from an empty list');
  return item;
}

function int(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** A made-up word that occurs nowhere else, e.g. `quorvelline-7c1d`. */
export function markerOf(seed: number): string {
  const rng = mulberry32((seed ^ 0x5bd1e995) >>> 0);
  const word = [0, 1, 2].map(() => pick(rng, SYLLABLES)).join('');
  const hex = Math.floor(rng() * 0x10000)
    .toString(16)
    .padStart(4, '0');
  return `${word}-${hex}`;
}

function sentence(rng: Rng, day: number): string {
  switch (int(rng, 0, 5)) {
    case 0:
      return `On day ${String(day)} the colony near ${pick(rng, PLACES)} counted ${String(int(rng, 40, 900))} terns heading ${pick(rng, DIRECTIONS)} over ${pick(rng, SEAS)}.`;
    case 1:
      return `Wind from the ${pick(rng, DIRECTIONS)} at ${String(int(rng, 4, 38))} knots slowed the flocks, and the observers logged ${String(int(rng, 12, 240))} feeding dives before noon.`;
    case 2:
      return `Juveniles kept close to the adults and rested on drifting ice when the swell rose above ${String(int(rng, 1, 6))} metres.`;
    case 3:
      return `A ringed bird first marked at ${pick(rng, PLACES)} was seen again ${String(int(rng, 2, 29))} years after banding, still ${pick(rng, STATES)}.`;
    case 4:
      return `The team noted ${pick(rng, PREY)} near the surface and ${pick(rng, WEATHER)} over ${pick(rng, SEAS)}.`;
    default:
      return `Geolocator data put the day's flight at ${String(int(rng, 180, 720))} kilometres, most of it within sight of ${pick(rng, PLACES)}.`;
  }
}

/** Exactly `size` bytes (≥ 1,024) of ASCII Markdown for `seed`, marker in the first and last paragraph. */
export function idxText(size: number, seed: number): string {
  const marker = markerOf(seed);
  const head = `# Field notes: Arctic tern migration, season ${String(seed)}\n\nReference marker: ${marker}. These notes follow one flyway from the breeding grounds to the Antarctic pack ice.\n\n`;
  const tail = `\nEnd of season ${String(seed)}. Reference marker: ${marker}.\n`;
  const room = size - head.length - tail.length;
  if (room < 1)
    throw new RangeError(
      `idx50k text needs at least ${String(head.length + tail.length + 1)} bytes`,
    );
  const rng = mulberry32(seed);
  const parts: string[] = [];
  let length = 0;
  let day = 1;
  while (length < room) {
    const heading = `## Day ${String(day)}\n\n`;
    const body = Array.from({ length: int(rng, 3, 6) }, () => sentence(rng, day)).join(' ');
    const chunk = `${heading}${body}\n\n`;
    parts.push(chunk);
    length += chunk.length;
    day++;
  }
  // Cut to the exact size and end the body with a newline, so the tail starts on its own line.
  const body = `${parts.join('').slice(0, room - 1)}\n`;
  return `${head}${body}${tail}`;
}
