# wm/src/boot-ui

Framework-free and inlined into `index.html`: the boot screen (name, logo, version, truthful progress driven by real work), the boot menu (hold Esc, `reboot --menu`, or the Settings flag), verbose mode, the kernel panic screen and the recovery console. No framework imports (ESLint-enforced).

- **Primary owner:** R3 WM/UI (visuals) and R5 QA/DevOps (orchestration)
- **Secondary reviewer:** each reviews the other
- **Spec:** [specs/02-boot/boot-and-services.md](../../../specs/02-boot/boot-and-services.md), [specs/00-product/identity-and-branding.md](../../../specs/00-product/identity-and-branding.md)
- **Requirement IDs:** BOOT-01, BOOT-02, BOOT-04, BOOT-05, BOOT-06, BOOT-08, BOOT-13
