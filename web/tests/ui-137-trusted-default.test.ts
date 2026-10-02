import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY_NAME, installDefaultPolicy, templateHtml } from '../src/trusted-default.ts';

describe('UI-137 the narrow Trusted Types default policy', () => {
  it('UI-137 inert template markup (Solid templates, SVG, data attributes) passes unchanged', () => {
    for (const html of [
      '<div>',
      '<section role=dialog aria-modal=false><div class=a><!> </div></section>',
      '<button type=button data-testid=dock-item aria-label="Open Files"><svg viewBox="0 0 24 24"><path d="M1 1h2"></path><linearGradient id=g></linearGradient></svg></button>',
      '<p>Metadata: 42 · one = two</p>',
      '<a href=/docs/help.html>Help</a>',
    ])
      expect(templateHtml(html)).toBe(html);
  });

  it('UI-137 script, frames, handlers and dangerous URLs are refused (still reported)', () => {
    for (const html of [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<svg><animate onbegin="alert(1)"/></svg>',
      '<iframe srcdoc="<p>x</p>"></iframe>',
      '<a href="javascript:alert(1)">x</a>',
      "<a href='  JavaScript:alert(1)'>x</a>",
      '<object data=x></object>',
      '<embed src=x>',
      '<base href=//evil.test/>',
      '<meta http-equiv=refresh content=0>',
      '<form><button formaction=//evil.test>x</button></form>',
      '<a href=data:text/html,x>x</a>',
    ])
      expect(() => templateHtml(html)).toThrow(TypeError);
  });

  it('UI-137 installs one default policy, and never replaces an existing one', () => {
    const created: string[] = [];
    const tt = {
      defaultPolicy: null as unknown,
      createPolicy(name: string, rules: { createHTML: (s: string) => string }) {
        created.push(name);
        const p = { name, createHTML: rules.createHTML };
        if (name === 'default') tt.defaultPolicy = p;
        return p;
      },
    };
    expect(installDefaultPolicy({ trustedTypes: tt })).toBe(true);
    expect(created).toEqual([DEFAULT_POLICY_NAME]);
    expect(installDefaultPolicy({ trustedTypes: tt })).toBe(false);
    expect(created).toEqual([DEFAULT_POLICY_NAME]);
    // Without Trusted Types (Firefox before 2025, Node) nothing happens.
    expect(installDefaultPolicy({})).toBe(false);
    // A refused name (an allow-list without `default`) keeps the old behaviour.
    expect(
      installDefaultPolicy({
        trustedTypes: {
          createPolicy: () => {
            throw new TypeError('refused');
          },
        },
      }),
    ).toBe(false);
  });
});
