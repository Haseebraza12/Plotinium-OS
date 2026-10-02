// lint-as: kernel/src/core/proc/fixture.ts
// expect: no-restricted-globals
// kernel/src/core is host-independent; the host injects platform objects (ARC-01).
export function notify(): void {
  self.postMessage('tick');
}
