import { test, expect } from 'vitest';
import fc from 'fast-check';
import { Trie } from './trie';
test('property: every inserted word is completable from each of its prefixes', () => {
  fc.assert(fc.property(fc.uniqueArray(fc.string({ unit: fc.constantFrom('a','b','c','/','.'), minLength: 1, maxLength: 12 }), { maxLength: 200 }), (words) => {
    const t = new Trie(); words.forEach(w => t.insert(w));
    for (const w of words) for (let i = 1; i <= w.length; i++) expect(t.complete(w.slice(0, i), Infinity)).toContain(w);
    expect(t.size).toBe(words.length);
  }), { seed: 42, numRuns: 200 });
});
