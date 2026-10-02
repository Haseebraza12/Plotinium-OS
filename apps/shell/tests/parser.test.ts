import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AndOr, List, ParseResult, Pipeline, SimpleCommand, Word, WordPart } from '../ast.ts';
import { lex, MSG_BACKQUOTE, MSG_CMD_SUBST, MSG_GROUPS, MSG_HEREDOC } from '../lexer.ts';
import { incompleteMessage, parse } from '../parser.ts';
import { printList, printWord } from '../print.ts';

function ok(src: string): List {
  const r = parse(src);
  if (!r.ok) throw new Error(`parse failed: ${JSON.stringify(r)}`);
  return r.list;
}

/** A compact rendering of the AST: `[a b] | [c]`, `&&`, `;` and `&`. */
function shape(src: string): string {
  const cmd = (c: SimpleCommand): string =>
    `[${[
      ...c.assigns.map((a) => `${a.name}=${a.value ? printWord(a.value) : ''}`),
      ...c.words.map(printWord),
      ...c.redirs.map(
        (r) => `${r.fd}${r.op}${typeof r.target === 'number' ? r.target : printWord(r.target)}`,
      ),
    ].join(' ')}]`;
  const pl = (p: Pipeline): string => (p.negate ? '!' : '') + p.cmds.map(cmd).join('|');
  const ao = (a: AndOr): string =>
    [pl(a.first), ...a.rest.map((r) => `${r.op}${pl(r.right)}`)].join('');
  return ok(src)
    .items.map((i) => ao(i.node) + (i.background ? '&' : ';'))
    .join(' ');
}

describe('shell grammar (§3.5)', () => {
  it.each([
    ['ls', '[ls];'],
    ['ls -la ~', '[ls -la ~];'],
    ['a | b | c', '[a]|[b]|[c];'],
    ['a && b || c', '[a]&&[b]||[c];'],
    ['a; b & c', '[a]; [b]& [c];'],
    ['a | b && c | d; e', '[a]|[b]&&[c]|[d]; [e];'],
    ['make && echo ok &', '[make]&&[echo ok]&'],
    ['! grep x f', '![grep x f];'],
    ['echo a > f', '[echo a 1>f];'],
    ['cat < in >> out', '[cat 0<in 1>>out];'],
    ['ls t 2>&1', '[ls t 2>&1];'],
    ['2>err cmd', '[cmd 2>err];'],
    ['A=1 B=two cmd x', '[A=1 B=two cmd x];'],
    ['A=1', '[A=1];'],
    ['cmd A=1', '[cmd A=1];'],
    ['a\nb', '[a]; [b];'],
    ['a |\n b', '[a]|[b];'],
    ['a &&\n\n b', '[a]&&[b];'],
    ['echo x # comment', '[echo x];'],
    ['echo a#b', '[echo a#b];'],
    ['  ;', 'error'],
  ])('SHL-04 parses %j as %s', (src, want) => {
    if (want === 'error') expect(parse(src).ok).toBe(false);
    else expect(shape(src)).toBe(want);
  });

  it('SHL-04 operator precedence: pipe binds tighter than and-or, which binds tighter than semicolon and ampersand', () => {
    const list = ok('a | b && c ; d | e &');
    expect(list.items).toHaveLength(2);
    const first = list.items[0]?.node;
    expect(first?.first.cmds).toHaveLength(2);
    expect(first?.rest).toHaveLength(1);
    expect(list.items[0]?.background).toBe(false);
    expect(list.items[1]?.background).toBe(true);
    expect(list.items[1]?.node.first.cmds).toHaveLength(2);
  });

  it('SHL-04 an empty line and a comment-only line parse to an empty list', () => {
    expect(ok('').items).toEqual([]);
    expect(ok('   # just a comment').items).toEqual([]);
    expect(ok('\n\n').items).toEqual([]);
  });

  it.each([
    ['echo $(date)', MSG_CMD_SUBST, 6],
    ['echo "$(date)"', MSG_CMD_SUBST, 7],
    ['echo `date`', MSG_BACKQUOTE, 6],
    ['echo "`date`"', MSG_BACKQUOTE, 7],
    ['(cd /tmp)', MSG_GROUPS, 1],
    ['echo (x)', MSG_GROUPS, 6],
    ['{ echo; }', MSG_GROUPS, 1],
    ['cat <<EOF', MSG_HEREDOC, 5],
    ['cat <<<word', MSG_HEREDOC, 5],
    ['echo ${VAR:-x}', 'sh: ${VAR:-x}: bad substitution', 6],
  ])(
    'SHL-04 every construct in the not-supported table prints its error and runs nothing on the line: %s',
    (src, message, column) => {
      const r = parse(`true; ${src}; true`);
      expect(r).toEqual({ ok: false, kind: 'error', message, column: column + 6 });
    },
  );

  it('SHL-04 control-flow keywords are ordinary command words', () => {
    expect(shape('if true')).toBe('[if true];');
    expect(shape('for x')).toBe('[for x];');
  });

  it.each([
    ['echo "abc', '"'],
    ["echo 'abc", "'"],
    ['echo ${HOME', '}'],
    ['echo \\', '\\'],
    ['a |', undefined],
    ['a &&', undefined],
    ['a ||', undefined],
    ['a | \n', undefined],
  ])('SHL-04 %j is incomplete so the editor continues with PS2', (src, unclosed) => {
    const r = parse(src);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('incomplete');
      if (r.kind === 'incomplete') expect(r.unclosed).toBe(unclosed);
    }
  });

  it('SHL-04 a non-interactive shell reports unfinished input with the unclosed quote', () => {
    expect(incompleteMessage("'")).toBe("sh: syntax error: unexpected end of input (unclosed ')");
    expect(incompleteMessage(undefined)).toBe('sh: syntax error: unexpected end of input');
    expect(incompleteMessage('\\')).toBe('sh: syntax error: unexpected end of input');
  });

  it.each([
    [';', ';', 1],
    ['a ;; b', ';', 4],
    ['a | ; b', ';', 5],
    ['echo >', 'newline', 7],
    ['echo > | x', '|', 8],
    ['a 2>&x', 'x', 6],
    ['| a', '|', 1],
    ['a && && b', '&&', 6],
  ])('SHL-04 %j is a syntax error near %j at column %i', (src, tok, column) => {
    expect(parse(src)).toEqual({
      ok: false,
      kind: 'error',
      message: `sh: syntax error near unexpected token '${tok}' (column ${column})`,
      column,
    });
  });
});

describe('lexer word syntax (§3.5)', () => {
  function parts(src: string): WordPart[] {
    const cmd = ok(src).items[0]?.node.first.cmds[0];
    return cmd?.words[1]?.parts ?? [];
  }

  it('SHL-05 single quotes keep everything literal, including $ and backslash', () => {
    expect(parts("x '$HOME \\n'")).toEqual([{ t: 'lit', v: '$HOME \\n', quoted: true }]);
  });

  it('SHL-05 double quotes expand parameters and honour only the listed escapes', () => {
    expect(parts('x "a $B ${C} \\$ \\" \\\\ \\x"')).toEqual([
      { t: 'lit', v: 'a ', quoted: true },
      { t: 'param', name: 'B', braced: false, quoted: true },
      { t: 'lit', v: ' ', quoted: true },
      { t: 'param', name: 'C', braced: true, quoted: true },
      { t: 'lit', v: ' $ " \\ \\x', quoted: true },
    ]);
  });

  it('SHL-05 an empty quoted string is one empty literal and a lone $ is literal', () => {
    expect(parts("x ''")).toEqual([{ t: 'lit', v: '', quoted: true }]);
    expect(parts('x ""')).toEqual([{ t: 'lit', v: '', quoted: true }]);
    expect(parts('x a$')).toEqual([{ t: 'lit', v: 'a$', quoted: false }]);
    expect(parts('x $-')).toEqual([{ t: 'lit', v: '$-', quoted: false }]);
  });

  it('SHL-05 special parameters and single-digit positionals are recognised', () => {
    const names = ['?', '$', '!', '#', '@', '0', '1'].map(
      (n) => (parts(`x $${n}`)[0] as { name?: string } | undefined)?.name,
    );
    expect(names).toEqual(['?', '$', '!', '#', '@', '0', '1']);
    expect(parts('x $12')).toEqual([
      { t: 'param', name: '1', braced: false, quoted: false },
      { t: 'lit', v: '2', quoted: false },
    ]);
  });

  it('SHL-05 backslash escapes quote the next character and a backslash-newline disappears', () => {
    expect(parts('x a\\ b')).toEqual([
      { t: 'lit', v: 'a', quoted: false },
      { t: 'lit', v: ' ', quoted: true },
      { t: 'lit', v: 'b', quoted: false },
    ]);
    expect(shape('echo a\\\nb')).toBe('[echo ab];');
  });

  it('SHL-05 glob characters are glob parts only when unquoted', () => {
    expect(parts('x *.t?[a-c]')).toEqual([
      { t: 'glob', v: '*' },
      { t: 'lit', v: '.t', quoted: false },
      { t: 'glob', v: '?' },
      { t: 'glob', v: '[a-c]' },
    ]);
    expect(parts('x "*"')).toEqual([{ t: 'lit', v: '*', quoted: true }]);
    expect(parts('x a[b')).toEqual([{ t: 'lit', v: 'a[b', quoted: false }]);
  });

  it('SHL-05 a tilde is special at the start of a word and after = in an assignment only', () => {
    expect(parts('x ~/a')).toEqual([
      { t: 'tilde', user: null },
      { t: 'lit', v: '/a', quoted: false },
    ]);
    expect(parts('x ~bob')).toEqual([{ t: 'tilde', user: 'bob' }]);
    expect(parts('x a~')).toEqual([{ t: 'lit', v: 'a~', quoted: false }]);
    expect(parts('x "~"')).toEqual([{ t: 'lit', v: '~', quoted: true }]);
    expect(parts('x ~b!c')).toEqual([{ t: 'lit', v: '~b!c', quoted: false }]);
    const assign = ok('P=~/x').items[0]?.node.first.cmds[0]?.assigns[0];
    expect(assign?.value?.parts[0]).toEqual({ t: 'tilde', user: null });
    expect(parts('x P=~/x')).toEqual([
      { t: 'lit', v: 'P=', quoted: false },
      { t: 'lit', v: '~', quoted: false },
      { t: 'lit', v: '/x', quoted: false },
    ]);
  });

  it('SHL-04 IO_NUMBER is a single digit directly before a redirection operator', () => {
    const r = lex('echo 2>f a2>g 2 >h');
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.tokens.map((t) => t.k)).toEqual([
        'word',
        'io',
        'op',
        'word',
        'word',
        'op',
        'word',
        'word',
        'op',
        'word',
      ]);
  });

  it('SHL-04 >& needs a single-digit descriptor', () => {
    expect(shape('cmd >&2')).toBe('[cmd 1>&2];');
    expect(parse('cmd >&file').ok).toBe(false);
  });

  it('SHL-04 spans point back into the source for job texts and errors', () => {
    const src = 'sleep 100 && echo done &';
    const node = ok(src).items[0]?.node;
    expect(node && src.slice(node.span.start, node.span.end)).toBe('sleep 100 && echo done');
  });
});

// ---------------------------------------------------------------------------------------------
// parse → print → parse
// ---------------------------------------------------------------------------------------------

const safeText = fc.string({
  unit: fc.constantFrom('a', 'b', 'x', '1', '.', '-', '/', '_'),
  minLength: 1,
  maxLength: 5,
});
const quotedText = fc.string({
  unit: fc.constantFrom('a', ' ', '$', '*', '|', ';', '"', "'", '\\', '~'),
  maxLength: 5,
});
const name = fc.constantFrom('A', 'HOME', 'x_1', '?', '@', '1');

const partArb: fc.Arbitrary<WordPart> = fc.oneof(
  safeText.map((v) => ({ t: 'lit' as const, v, quoted: false })),
  quotedText.map((v) => ({ t: 'lit' as const, v, quoted: true })),
  fc
    .record({ name, braced: fc.boolean(), quoted: fc.boolean() })
    .map((p) => ({ t: 'param' as const, ...p })),
  fc.constantFrom('*', '?', '[a-c]').map((v) => ({ t: 'glob' as const, v })),
);
const span = { start: 0, end: 0 };
const wordArb: fc.Arbitrary<Word> = fc
  .tuple(
    fc.string({ unit: fc.constantFrom('w', 'o', 'r', 'd'), minLength: 1, maxLength: 3 }),
    fc.array(partArb, { maxLength: 3 }),
  )
  .map(([head, rest]) => ({
    parts: [{ t: 'lit' as const, v: head, quoted: false }, ...rest],
    span,
  }));
const cmdArb: fc.Arbitrary<SimpleCommand> = fc
  .record({
    words: fc.array(wordArb, { minLength: 1, maxLength: 3 }),
    redir: fc.option(fc.tuple(fc.constantFrom('>', '>>', '<'), wordArb)),
  })
  .map(({ words, redir }) => ({
    kind: 'cmd' as const,
    assigns: [],
    words,
    redirs:
      redir === null
        ? []
        : [{ fd: redir[0] === '<' ? 0 : 1, op: redir[0], target: redir[1], span }],
    span,
  }));
const pipelineArb: fc.Arbitrary<Pipeline> = fc
  .record({ negate: fc.boolean(), cmds: fc.array(cmdArb, { minLength: 1, maxLength: 3 }) })
  .map((p) => ({ kind: 'pipeline' as const, ...p, span }));
const andOrArb: fc.Arbitrary<AndOr> = fc
  .record({
    first: pipelineArb,
    rest: fc.array(
      fc.record({ op: fc.constantFrom('&&' as const, '||' as const), right: pipelineArb }),
      { maxLength: 2 },
    ),
  })
  .map((a) => ({ kind: 'andor' as const, ...a, span }));
const listArb: fc.Arbitrary<List> = fc
  .array(fc.record({ node: andOrArb, background: fc.boolean() }), { minLength: 1, maxLength: 3 })
  .map((items) => ({ kind: 'list' as const, items }));

function stripSpans(r: ParseResult): unknown {
  return JSON.parse(JSON.stringify(r, (k, v: unknown) => (k === 'span' ? undefined : v)));
}

describe('round trip', () => {
  it('SHL-04 parse then print then parse is the identity for 10,000 random valid programs', () => {
    fc.assert(
      fc.property(listArb, (list) => {
        const first = parse(printList(list));
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        const second = parse(printList(first.list));
        expect(stripSpans(second)).toEqual(stripSpans(first));
      }),
      { numRuns: 10_000 },
    );
  }, 60_000);
});
