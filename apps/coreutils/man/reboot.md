---json
{
  "name": "reboot",
  "section": 1,
  "summary": "restart the OS",
  "synopsis": "reboot [--menu] [--safe] [--verbose]",
  "owner": "R5",
  "requirements": [
    "SYS-02",
    "BOOT-05",
    "BOOT-06",
    "BOOT-12"
  ],
  "flags": [
    {
      "short": null,
      "long": "--menu",
      "arg": null,
      "desc": "open the boot menu on the next boot"
    },
    {
      "short": null,
      "long": "--safe",
      "arg": null,
      "desc": "boot the next time in safe mode"
    },
    {
      "short": null,
      "long": "--verbose",
      "arg": null,
      "desc": "show the verbose boot log on the next boot"
    }
  ],
  "seeAlso": [
    "shutdown",
    "bootlog"
  ]
}
---

# NAME

reboot — restart the OS

# SYNOPSIS

`reboot [--menu] [--safe] [--verbose]`

# DESCRIPTION

Same as `shutdown -r now`, with flags for the next boot. The orderly shutdown sequence runs first: processes are stopped, dirty pages flushed, the session layout saved and the outbox flushed.

# OPTIONS

- `--menu` — open the boot menu on the next boot
- `--safe` — boot the next time in safe mode
- `--verbose` — show the verbose boot log on the next boot

# EXIT STATUS

0 when the restart was accepted; 1 on failure.

# ERRORS

- `reboot: Operation not permitted` (EPERM)
- `reboot: Resource busy` (EBUSY, already shutting down)

# EXAMPLES

    reboot
    reboot --menu

# SEE ALSO

shutdown(1), bootlog(1)
