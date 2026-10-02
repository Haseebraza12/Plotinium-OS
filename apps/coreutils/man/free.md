---json
{
  "name": "free",
  "section": 1,
  "summary": "memory summary",
  "synopsis": "free [-h | -b | -k | -m | -g] [-s SECS] [-c COUNT] [--json]",
  "owner": "R1",
  "requirements": [
    "SYS-02",
    "MEM-01",
    "MEM-07"
  ],
  "flags": [
    {
      "short": "-h",
      "long": "--human",
      "arg": null,
      "desc": "pick a binary unit per value, one decimal (default)"
    },
    {
      "short": "-b",
      "long": "--bytes",
      "arg": null,
      "desc": "show bytes"
    },
    {
      "short": "-k",
      "long": "--kibi",
      "arg": null,
      "desc": "show KiB"
    },
    {
      "short": "-m",
      "long": "--mebi",
      "arg": null,
      "desc": "show MiB"
    },
    {
      "short": "-g",
      "long": "--gibi",
      "arg": null,
      "desc": "show GiB"
    },
    {
      "short": "-s",
      "long": "--seconds",
      "arg": "SECS",
      "desc": "repeat every SECS seconds"
    },
    {
      "short": "-c",
      "long": "--count",
      "arg": "COUNT",
      "desc": "stop after COUNT reports (with -s; default unlimited)"
    },
    {
      "short": null,
      "long": "--json",
      "arg": null,
      "desc": "print the mem.stat record as JSON"
    }
  ],
  "seeAlso": [
    "vmstat",
    "pmap",
    "swapctl",
    "top"
  ]
}
---

# NAME

free — memory summary

# SYNOPSIS

`free [-h | -b | -k | -m | -g] [-s SECS] [-c COUNT] [--json]`

# DESCRIPTION

Prints `total used free reserved pinned specul. avail` for the memory budget, then the `Swap-L` (local tier), `Swap-R` (remote tier) and `Kernel` lines. `total` is the budget, `used` the accounted bytes, `free` the budget minus committed memory, so `used + reserved + free = total`. The kernel line is reported but not charged to the budget. Values the kernel does not report are shown as `-`.

# OPTIONS

- `-h, --human` — pick a binary unit per value, one decimal (default)
- `-b, --bytes` — show bytes
- `-k, --kibi` — show KiB
- `-m, --mebi` — show MiB
- `-g, --gibi` — show GiB
- `-s, --seconds SECS` — repeat every SECS seconds
- `-c, --count COUNT` — stop after COUNT reports (with -s; default unlimited)
- `--json` — print the mem.stat record as JSON

# EXIT STATUS

0 on success; 2 on a usage error.

# ERRORS

- usage errors only

# EXAMPLES

    free
    free -m
    free -s 1 -c 5

# SEE ALSO

vmstat(1), pmap(1), swapctl(1), top(1)
