import { render, screen } from '@solidjs/testing-library';
import { describe, expect, it } from 'vitest';

import { atomLogo, atomLogo20, atomLogo24 } from './atom-logo.ts';
import { AppIcon, AtomLogo, atomLogoFor, ICON_DEFS, rawIcon, type IconId } from './index.tsx';

const ids = Object.keys(ICON_DEFS) as IconId[];

describe('UI-icons', () => {
  it('PLT-ID-06 UI-icons ship the atom mark and every app icon', () => {
    expect(ids).toEqual(
      expect.arrayContaining([
        'atom',
        'files',
        'terminal',
        'editor',
        'task-manager',
        'settings',
        'search',
        'trash',
      ]),
    );
  });

  it('UI-icons raw SVG strings are standalone documents at the requested size', () => {
    for (const id of ids) {
      const svg = rawIcon(id, 16);
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"')).toBe(
        true,
      );
      expect(svg).not.toContain('$');
      expect(
        new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('parsererror'),
      ).toBeNull();
    }
    expect(rawIcon('atom', 256)).toContain('width="256"');
  });

  it('UI-icons labelled icons are images; unlabelled ones are hidden from assistive tech', () => {
    render(() => (
      <>
        <AtomLogo size={32} label="Plotinium" />
        <AppIcon app="terminal" size={52} />
      </>
    ));
    expect(screen.getByRole('img', { name: 'Plotinium' })).toBeTruthy();
    const svgs = document.querySelectorAll('svg');
    expect(svgs[1]?.getAttribute('aria-hidden')).toBe('true');
  });

  it('UI-icons carry no style attributes, so the mark keeps its colours under the CSP', () => {
    for (const id of ids) expect(rawIcon(id, 32)).not.toContain('style=');
    const { container } = render(() => <AtomLogo size={32} class="extra" />);
    const svg = container.querySelector('svg');
    expect(svg?.querySelectorAll('[style]')).toHaveLength(0);
    expect(svg?.getAttribute('class')).toContain('extra');
    expect(svg?.querySelector('.pl-logo-shell')?.getAttribute('fill')).toBe('#B3B1FF');
    expect(svg?.querySelector('.pl-logo-core')).not.toBeNull();
  });

  it('PLT-ID-03 UI-icons the mark is four filled shapes with no hairline: 3-unit shell and stem (2 px at 16 px)', () => {
    for (const def of [atomLogo, atomLogo20, atomLogo24]) {
      const parts = def.children.map((n) => n[1]['class']);
      expect(parts).toEqual(['pl-logo-stem', 'pl-logo-shell', 'pl-logo-core', 'pl-logo-electron']);
      // Fills only: a page rule that thins strokes (or a missing stroke width) cannot touch it.
      for (const node of def.children) expect(node[1]['stroke']).toBeUndefined();
    }
    const [stem, shell, core, electron] = atomLogo.children;
    // Stem: x 4.5 to 7.5; shell: outer radius 7.5, inner 4.5, round ends of radius 1.5.
    expect(stem?.[1]['d']).toBe('M4.5 9V21A1.5 1.5 0 0 0 7.5 21V9A1.5 1.5 0 0 0 4.5 9Z');
    const radii = [...String(shell?.[1]['d']).matchAll(/A([\d.]+) /gu)].map((m) => Number(m[1]));
    expect(radii).toEqual([7.5, 1.5, 4.5, 1.5]);
    expect(Number(core?.[1]['r'])).toBeGreaterThanOrEqual(2.25);
    expect(Number(electron?.[1]['r'])).toBeGreaterThanOrEqual(1.5);
    // The electron sits on the shell's centre line (radius 6 about the nucleus) at 1:30.
    const dx = Number(electron?.[1]['cx']) - Number(core?.[1]['cx']);
    const dy = Number(electron?.[1]['cy']) - Number(core?.[1]['cy']);
    expect(Math.hypot(dx, dy)).toBeCloseTo(6, 2);
    expect((Math.atan2(dy, dx) * 180) / Math.PI).toBeCloseTo(-45, 1);
  });

  it('PLT-ID-03 UI-icons AtomLogo uses the drawing hinted for its pixel size', () => {
    expect(atomLogoFor(16)).toBe(atomLogo);
    expect(atomLogoFor(17)).toBe(atomLogo);
    expect(atomLogoFor(32)).toBe(atomLogo);
    expect(atomLogoFor(20)).toBe(atomLogo20);
    expect(atomLogoFor(40)).toBe(atomLogo20);
    expect(atomLogoFor(24)).toBe(atomLogo24);
    expect(atomLogoFor(72)).toBe(atomLogo24);
    const { container } = render(() => (
      <>
        <AtomLogo size={20} />
        <AtomLogo size={24} />
        <AtomLogo size={16} />
      </>
    ));
    const stems = [...container.querySelectorAll('.pl-logo-stem')].map((p) => p.getAttribute('d'));
    expect(stems.map((d) => d?.split('V')[0])).toEqual(['M4.8 8.4', 'M5 8.5', 'M4.5 9']);
    expect(rawIcon('atom', 20)).toContain('M4.8 8.4V');
  });

  it('UI-icons gradient ids are unique per instance', () => {
    const { container } = render(() => (
      <>
        <AppIcon app="files" />
        <AppIcon app="files" />
      </>
    ));
    const gradientIds = [...container.querySelectorAll('linearGradient')].map((g) => g.id);
    expect(gradientIds.length).toBe(4);
    expect(new Set(gradientIds).size).toBe(4);
    for (const rect of container.querySelectorAll('rect[fill^="url(#"]')) {
      const ref = /url\(#(.+)\)/u.exec(rect.getAttribute('fill') ?? '')?.[1] ?? '';
      expect(gradientIds).toContain(ref);
    }
  });
});
