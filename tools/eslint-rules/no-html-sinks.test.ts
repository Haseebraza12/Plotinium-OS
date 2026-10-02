import { describe, expect, it } from 'vitest';

import { lintWithRule } from './test-utils.ts';

const RULE = 'no-html-sinks';
const ID = `local/${RULE}`;

function reported(code: string, repoPath = 'apps/files/test-snippet.ts'): number {
  return lintWithRule(RULE, code, repoPath).filter((message) => message.ruleId === ID).length;
}

describe('local/no-html-sinks', () => {
  it('AGT-06 reports innerHTML, outerHTML and srcdoc assignments', () => {
    const code = `declare const el: HTMLElement; declare const frame: HTMLIFrameElement; declare const name: string;
      el.innerHTML = name; el['outerHTML'] = name; frame.srcdoc = name;`;
    expect(reported(code)).toBe(3);
  });

  it('AGT-06 reports HTML-parsing methods and document.write', () => {
    const code = `declare const el: HTMLElement; declare const range: Range; declare const s: string;
      el.insertAdjacentHTML('beforeend', s);
      range.createContextualFragment(s);
      document.write(s);
      window.document.writeln(s);`;
    expect(reported(code)).toBe(4);
  });

  it('AGT-06 reports event-handler and srcdoc attributes set from code', () => {
    const code = `declare const el: HTMLElement; declare const s: string;
      el.setAttribute('onclick', s); el.setAttribute('srcdoc', s); el.setAttribute('title', s);`;
    expect(reported(code)).toBe(2);
  });

  it('AGT-06 reports eval, Function and string timers', () => {
    const code = `declare const s: string;
      eval(s); new Function(s); Function(s); setTimeout('alert(1)', 0); window.setInterval(\`x\`, 5);`;
    expect(reported(code)).toBe(5);
  });

  it('AGT-06 reports innerHTML-style JSX props, including prop:innerHTML', () => {
    const code = `declare const s: string;
      export const a = <div innerHTML={s} />;
      export const b = <div prop:innerHTML={s} />;
      export const c = <div dangerouslySetInnerHTML={{ __html: s }} />;`;
    expect(reported(code, 'apps/files/test-snippet.tsx')).toBe(3);
  });

  it('AGT-06 accepts text rendering, stream writes and function timers', () => {
    const code = `declare const el: HTMLElement; declare const s: string;
      declare const stream: { write(chunk: string): void };
      el.textContent = s; stream.write(s); setTimeout(() => { el.textContent = s; }, 0);`;
    expect(reported(code)).toBe(0);
  });
});
