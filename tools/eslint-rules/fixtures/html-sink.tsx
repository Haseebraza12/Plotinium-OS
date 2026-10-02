// lint-as: apps/files/fixture.tsx
// expect: local/no-html-sinks
// File names and AI output are rendered as text, never as HTML (AGT-06).
export function Name(props: { name: string }) {
  return <span innerHTML={props.name} />;
}
