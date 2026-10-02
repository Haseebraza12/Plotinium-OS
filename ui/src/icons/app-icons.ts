import type { SvgIconDef, SvgNode } from './svg-tree.ts';

/**
 * Plotinium's own rounded-square app icons (52-unit grid, radius 12), taken from the dock in
 * docs/design/stitch/desktop-dark. Each is a gradient squircle with a gloss layer and one bold
 * glyph, so the silhouette still reads at 16 px.
 */

const gloss: SvgNode = [
  'linearGradient',
  { id: '$gloss', x1: '0', y1: '0', x2: '0', y2: '1' },
  [
    ['stop', { offset: '0', 'stop-color': '#fff', 'stop-opacity': '.35' }],
    ['stop', { offset: '.5', 'stop-color': '#fff', 'stop-opacity': '0' }],
  ],
];

function vertical(top: string, bottom: string): SvgNode {
  return [
    'linearGradient',
    { id: '$bg', x1: '0', y1: '0', x2: '0', y2: '1' },
    [
      ['stop', { offset: '0', 'stop-color': top }],
      ['stop', { offset: '1', 'stop-color': bottom }],
    ],
  ];
}

const tile: SvgNode = ['rect', { width: 52, height: 52, rx: 12, fill: 'url(#$bg)' }];
const glossTile: SvgNode = ['rect', { width: 52, height: 52, rx: 12, fill: 'url(#$gloss)' }];

function appIcon(
  name: string,
  top: string,
  bottom: string,
  glyph: readonly SvgNode[],
  withGloss = true,
): SvgIconDef {
  return {
    name,
    viewBox: '0 0 52 52',
    children: [
      ['defs', {}, [vertical(top, bottom), gloss]],
      tile,
      ...(withGloss ? [glossTile] : []),
      ...glyph,
    ],
  };
}

export const filesIcon = appIcon('files', '#7C95FF', '#4B3FD6', [
  [
    'path',
    {
      d: 'M12 18a3 3 0 0 1 3-3h7l3 3h12a3 3 0 0 1 3 3v13a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3Z',
      fill: '#fff',
      'fill-opacity': '.95',
    },
  ],
  ['path', { d: 'M12 23h28', stroke: '#6C79F5', 'stroke-width': '1.6' }],
]);

export const terminalIcon = appIcon(
  'terminal',
  '#2B2B33',
  '#0C0C10',
  [
    [
      'rect',
      {
        x: '.5',
        y: '.5',
        width: 51,
        height: 51,
        rx: 11.5,
        fill: 'none',
        stroke: '#fff',
        'stroke-opacity': '.14',
      },
    ],
    [
      'path',
      {
        d: 'm15 19 7 6-7 6',
        fill: 'none',
        stroke: '#C9C8FF',
        'stroke-width': '3',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      },
    ],
    ['path', { d: 'M25 33h11', stroke: '#7CE38B', 'stroke-width': '3', 'stroke-linecap': 'round' }],
  ],
  false,
);

export const editorIcon = appIcon(
  'editor',
  '#FFFFFF',
  '#DAD7FF',
  [
    [
      'path',
      {
        d: 'M14 18h14M14 24h10M14 30h8',
        stroke: '#A6A3F0',
        'stroke-width': '2.4',
        'stroke-linecap': 'round',
      },
    ],
    ['path', { d: 'M37 13.5 40.5 17 28 29.5l-4.8 1.3 1.3-4.8Z', fill: '#5E5CE6' }],
    ['path', { d: 'm35 15.5 3.5 3.5', stroke: '#fff', 'stroke-width': '1.4' }],
  ],
  false,
);

export const taskManagerIcon = appIcon('task-manager', '#2FE0C4', '#0B8B86', [
  [
    'path',
    {
      d: 'M10 28h7l4-10 6 18 5-12 3 4h7',
      fill: 'none',
      stroke: '#fff',
      'stroke-width': '3',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
  ],
]);

export const settingsIcon = appIcon('settings', '#9A9AA6', '#46464F', [
  [
    'circle',
    {
      cx: 26,
      cy: 26,
      r: 11,
      fill: 'none',
      stroke: '#fff',
      'stroke-width': '5',
      'stroke-dasharray': '4.3 4.34',
    },
  ],
  ['circle', { cx: 26, cy: 26, r: 8.5, fill: '#fff' }],
  ['circle', { cx: 26, cy: 26, r: 3.6, fill: '#5A5A64' }],
]);

export const searchIcon = appIcon('search', '#8F8DFF', '#4527C9', [
  ['circle', { cx: 23, cy: 24, r: 8.5, fill: 'none', stroke: '#fff', 'stroke-width': '3.2' }],
  [
    'path',
    { d: 'm29.5 30.5 7 7', stroke: '#fff', 'stroke-width': '3.6', 'stroke-linecap': 'round' },
  ],
  [
    'path',
    {
      d: 'M37 11.5c.5 2.3 1.2 3 3.5 3.5-2.3.5-3 1.2-3.5 3.5-.5-2.3-1.2-3-3.5-3.5 2.3-.5 3-1.2 3.5-3.5Z',
      fill: '#fff',
    },
  ],
]);

export const trashIcon: SvgIconDef = {
  name: 'trash',
  viewBox: '0 0 52 52',
  children: [
    ['rect', { width: 52, height: 52, rx: 12, fill: '#8E8EA0', 'fill-opacity': '.28' }],
    [
      'rect',
      {
        x: '.5',
        y: '.5',
        width: 51,
        height: 51,
        rx: 11.5,
        fill: 'none',
        stroke: '#fff',
        'stroke-opacity': '.3',
      },
    ],
    [
      'path',
      {
        d: 'M16 18h20M33 18v16a3 3 0 0 1-3 3h-8a3 3 0 0 1-3-3V18M21.5 18v-2.5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2V18M23.5 23v9M28.5 23v9',
        fill: 'none',
        stroke: '#fff',
        'stroke-opacity': '.95',
        'stroke-width': '2.2',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      },
    ],
  ],
};

/** A full trash can: the same bin with a crumpled sheet above the rim. */
export const trashFullIcon: SvgIconDef = {
  name: 'trash-full',
  viewBox: '0 0 52 52',
  children: [
    ...trashIcon.children,
    ['path', { d: 'M20 16.5l3-4 4 2 3-3 2 5', fill: '#fff', 'fill-opacity': '.85' }],
  ],
};
