// lint-as: ui/src/primitives/fixture.tsx
// expect: local/no-static-jsx-style
// Solid compiles an all-literal style into a style="…" attribute, which the CSP drops (UI-147).
export function Box() {
  return <div style={{ display: 'flex', gap: '4px' }} />;
}
