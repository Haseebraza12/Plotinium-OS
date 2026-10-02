---json
{
  "name": "pmap",
  "section": 1,
  "summary": "page table of a process",
  "synopsis": "pmap [-x] [--json] PID",
  "owner": "R1",
  "requirements": [
    "SYS-02",
    "MEM-02",
    "MEM-03",
    "MEM-07"
  ],
  "flags": [
    {
      "short": "-x",
      "long": "--extended",
      "arg": null,
      "desc": "add the generation, full SHA-256, pin reasons and swap key"
    },
    {
      "short": null,
      "long": "--json",
      "arg": null,
      "desc": "print the process record and its pages as JSON"
    }
  ],
  "seeAlso": [
    "vmstat",
    "free",
    "ps"
  ]
}
---

# NAME

pmap — page table of a process

# SYNOPSIS

`pmap [-x] [--json] PID`

# DESCRIPTION

The first line is `PID:   COMMAND   (user, STATE, exec eN, soft limit S)`. Then one row per page: `PAGE KIND LABEL SIZE LOCATION COPIES FLAGS AGE SHA256`, where LOCATION is `RESIDENT`, `LOCAL_SWAP`, `REMOTE_SWAP` or `BACKED`, FLAGS are `D` dirty, `P` pinned, `X` speculative, `W` I/O in progress, and AGE is the time since the last access. The total line sums the pages by location and repeats the fault count, hit ratio and bytes paged in and out. Only the owner of the process or root may read its page table.

# OPTIONS

- `-x, --extended` — add the generation, full SHA-256, pin reasons and swap key
- `--json` — print the process record and its pages as JSON

# EXIT STATUS

0 on success; 1 on failure; 2 on a usage error.

# ERRORS

- `pmap: 999: No such process` (ESRCH)
- `pmap: 23: Permission denied` (EACCES, another user's process)

# EXAMPLES

    pmap $$
    pmap -x 412

# SEE ALSO

vmstat(1), free(1), ps(1)
