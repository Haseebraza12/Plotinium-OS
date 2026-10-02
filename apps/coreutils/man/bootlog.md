---json
{
  "name": "bootlog",
  "section": 1,
  "summary": "boot timings",
  "synopsis": "bootlog [--critical-path] [--services] [--list] [--boot N] [-v] [--json]",
  "owner": "R5",
  "requirements": [
    "SYS-02",
    "BOOT-03",
    "BOOT-11"
  ],
  "flags": [
    {
      "short": null,
      "long": "--critical-path",
      "arg": null,
      "desc": "print the chain of services that determined the boot time"
    },
    {
      "short": null,
      "long": "--services",
      "arg": null,
      "desc": "print one row per service"
    },
    {
      "short": null,
      "long": "--list",
      "arg": null,
      "desc": "list the stored boots"
    },
    {
      "short": null,
      "long": "--boot",
      "arg": "N",
      "desc": "select a boot (current or previous)"
    },
    {
      "short": "-v",
      "long": "--verbose",
      "arg": null,
      "desc": "print the verbose log lines"
    },
    {
      "short": null,
      "long": "--json",
      "arg": null,
      "desc": "print the raw record"
    }
  ],
  "seeAlso": [
    "svcctl",
    "uptime"
  ]
}
---

# NAME

bootlog — boot timings

# SYNOPSIS

`bootlog [--critical-path] [--services] [--list] [--boot N] [-v] [--json]`

# DESCRIPTION

Prints the last boot's summary and timings.

# OPTIONS

- `--critical-path` — print the chain of services that determined the boot time
- `--services` — print one row per service
- `--list` — list the stored boots
- `--boot N` — select a boot (current or previous)
- `-v, --verbose` — print the verbose log lines
- `--json` — print the raw record

# EXIT STATUS

0 on success; 1 on an unknown boot; 2 on a usage error.

# ERRORS

- `bootlog: no boot #99`

# EXAMPLES

    bootlog --critical-path

# SEE ALSO

svcctl(1), uptime(1)
