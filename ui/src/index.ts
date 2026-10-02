// @plotinium/ui: presentational SolidJS components for Plotinium's glass UI.
// Owner: R3 (WM/UI). Normative look and motion: specs/05-wm/visual-language-macos.md.
//
// Styles are not imported here, so importing a component never injects global CSS. An app entry
// loads, once and in this order:
//   import '@plotinium/ui/tokens.css';   // colour, material, type, shape, motion tokens (inlined for boot)
//   import '@plotinium/ui/motion.css';   // keyframes and pl-anim-* classes used by overlays and windows
//   import '@plotinium/ui/src/tokens/fonts.css'; // self-hosted Inter 4 (opsz) and JetBrains Mono, both variable (D15)
// Components receive all data through props and emit intents through callbacks (SYS-01).
export const UI_PACKAGE = '@plotinium/ui';

export * from './icons/index.tsx';
export * from './primitives/index.ts';
export * from './shell/index.ts';
export * from './overlays/index.ts';
export * from './login/index.ts';
