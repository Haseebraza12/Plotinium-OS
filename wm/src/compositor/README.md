# wm/src/compositor

Framework-free and the SOLE writer of window geometry and z-index: window registry (hash map), focus, z-order renumbered 1..n, drag and resize with pointer capture, `translate3d` writes batched per `requestAnimationFrame`, snapping, and a title-bar double-click that maximises. It accepts commands only from the kernel port and pushes only coarse events into Solid. No Solid imports (ESLint-enforced).

- **Primary owner:** R3 WM / UI Subsystem Lead
- **Secondary reviewer:** R1 Kernel
- **Spec:** [specs/05-wm/window-manager.md](../../../specs/05-wm/window-manager.md)
- **Requirement IDs:** WM-01, WM-02, WM-03, WM-04, WM-05, WM-06
