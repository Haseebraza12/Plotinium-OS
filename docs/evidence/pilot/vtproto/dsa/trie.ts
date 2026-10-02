// Toy trie for tooling measurement only (the team writes the real one in dsa/trie).
type Node = { c: Map<string, Node>; end: boolean };
export class Trie {
  root: Node = { c: new Map(), end: false }; size = 0;
  insert(w: string) { let n = this.root; for (const ch of w) { let m = n.c.get(ch); if (!m) { m = { c: new Map(), end: false }; n.c.set(ch, m); } n = m; } if (!n.end) { n.end = true; this.size++; } }
  complete(p: string, k = 10): string[] { let n = this.root; for (const ch of p) { const m = n.c.get(ch); if (!m) return []; n = m; }
    const out: string[] = []; const st: [Node, string][] = [[n, p]];
    while (st.length && out.length < k) { const [x, s] = st.pop()!; if (x.end) out.push(s); for (const [ch, y] of x.c) st.push([y, s + ch]); } return out; }
}
