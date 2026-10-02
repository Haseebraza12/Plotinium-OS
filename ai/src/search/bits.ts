/** A bitset over dense indexes (`fileIdx`, segment rows), stored as 32-bit words. */
export type Bitset = Uint32Array;

export function bitsetFor(n: number): Bitset {
  return new Uint32Array(Math.max(1, Math.ceil(n / 32)));
}

export function hasBit(bits: Bitset, i: number): boolean {
  return i >= 0 && (((bits[i >>> 5] ?? 0) >>> (i & 31)) & 1) === 1;
}

export function setBit(bits: Bitset, i: number): void {
  const w = i >>> 5;
  bits[w] = ((bits[w] ?? 0) | (1 << (i & 31))) >>> 0;
}

export function clearBit(bits: Bitset, i: number): void {
  const w = i >>> 5;
  bits[w] = ((bits[w] ?? 0) & ~(1 << (i & 31))) >>> 0;
}

export function countBits(bits: Bitset): number {
  let n = 0;
  for (const word of bits) {
    let x = word;
    while (x !== 0) {
      x &= x - 1;
      n++;
    }
  }
  return n;
}
