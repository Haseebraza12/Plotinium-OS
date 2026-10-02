/**
 * @plotinium/wm: the window manager on the main thread (window-manager.md).
 *
 *   '@plotinium/wm'             the framework-free compositor (the default entry; no Solid)
 *   '@plotinium/wm/compositor'  the same compositor surface
 *   '@plotinium/wm/shell'       the Solid desktop shell: mountDesktop(root, env), DesktopEnv
 *
 * The package root stays framework-free so boot-critical code (web's kernel link) can import the
 * compositor without pulling Solid; the shell is its own entry, loaded with the desktop chunk.
 */
export * from './compositor/index.ts';
