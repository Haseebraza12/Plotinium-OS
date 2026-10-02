/**
 * Reduced-motion check for components that must skip an exit animation outright (the CSS
 * guards in motion.css already collapse the animation itself). Honours the OS setting and the
 * Settings override `:root[data-motion="reduce"]` (DSN-05).
 */
export function prefersReducedMotion(doc: Document): boolean {
  if (doc.documentElement.dataset.motion === 'reduce') return true;
  const view = doc.defaultView;
  if (view === null || typeof view.matchMedia !== 'function') return false;
  return view.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
