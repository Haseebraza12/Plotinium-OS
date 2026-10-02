---json
{
  "name": "vmstat",
  "section": 1,
  "summary": "paging and scheduler statistics",
  "synopsis": "vmstat [-w] [--json] [DELAY [COUNT]] [-p [PID...]]",
  "owner": "R1",
  "requirements": [
    "SYS-02",
    "MEM-05",
    "MEM-06",
    "MEM-07"
  ],
  "flags": [
    {
      "short": "-p",
      "long": null,
      "arg": null,
      "desc": "per-process rows (MEM-07) for every process, or the PIDs that follow"
    },
    {
      "short": "-w",
      "long": "--wide",
      "arg": null,
      "desc": "wide columns"
    },
    {
      "short": null,
      "long": "--json",
      "arg": null,
      "desc": "print each sample as one JSON line"
    }
  ],
  "seeAlso": [
    "free",
    "pmap",
    "top",
    "swapctl"
  ]
}
---

# NAME

vmstat — paging and scheduler statistics

# SYNOPSIS

`vmstat [-w] [--json] [DELAY [COUNT]] [-p [PID...]]`

# DESCRIPTION

System mode prints `r b s used free rsv pin flt hit% pi po si so ro us ke id`: READY + RUNNING, BLOCKED and SUSPENDED processes; memory in MiB as in `free`; major faults per second; the hit ratio; pages and KiB per second paged in and out; user and kernel CPU. The first line covers the time since boot, each later line one DELAY. Values the kernel does not report are shown as `-`.

`-p` prints `PID USER RES SWAP-L SWAP-R WS FLT HIT% IN OUT LAST-IN COMMAND` per process, cumulative since the process started, or per interval with DELAY.

# OPTIONS

- `-p` — per-process rows (MEM-07) for every process, or the PIDs that follow
- `-w, --wide` — wide columns
- `--json` — print each sample as one JSON line

# EXIT STATUS

0 on success; 2 on a usage error.

# ERRORS

- usage errors only

# EXAMPLES

    vmstat
    vmstat 1 5
    vmstat -p
    vmstat 2 -p 412

# SEE ALSO

free(1), pmap(1), top(1), swapctl(1)
