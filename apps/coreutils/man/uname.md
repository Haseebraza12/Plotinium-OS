---json
{
  "name": "uname",
  "section": 1,
  "summary": "system identity",
  "synopsis": "uname [-a] [-s] [-r] [-v] [-m]",
  "owner": "R1",
  "requirements": [
    "SYS-02",
    "PLT-ID-07"
  ],
  "flags": [
    {
      "short": "-a",
      "long": "--all",
      "arg": null,
      "desc": "print the full identity line"
    },
    {
      "short": "-s",
      "long": "--kernel-name",
      "arg": null,
      "desc": "print the system name (default)"
    },
    {
      "short": "-r",
      "long": "--kernel-release",
      "arg": null,
      "desc": "print the kernel release"
    },
    {
      "short": "-v",
      "long": "--kernel-version",
      "arg": null,
      "desc": "print the build date"
    },
    {
      "short": "-m",
      "long": "--machine",
      "arg": null,
      "desc": "print the browser and core count"
    }
  ],
  "seeAlso": [
    "id"
  ]
}
---

# NAME

uname — system identity

# SYNOPSIS

`uname [-a] [-s] [-r] [-v] [-m]`

# DESCRIPTION

Prints the system identity. `-a` prints `Plotinium 0.3.0 (kernel 0.3.0-a1f93c2, built 2026-11-02) · Chrome 154 · 8 cores · uid=1001(alice)`.

# OPTIONS

- `-a, --all` — print the full identity line
- `-s, --kernel-name` — print the system name (default)
- `-r, --kernel-release` — print the kernel release
- `-v, --kernel-version` — print the build date
- `-m, --machine` — print the browser and core count

# EXIT STATUS

0 on success; 2 on an invalid option.

# ERRORS

- `uname: invalid option -- 'x'`

# EXAMPLES

    uname -a

# SEE ALSO

id(1)
