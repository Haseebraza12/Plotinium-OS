---json
{
  "name": "swapctl",
  "section": 1,
  "summary": "swap tiers",
  "synopsis": "swapctl [status] | swapctl tier auto|local|remote | swapctl --tier auto|local|remote | swapctl drop-local [PID] | swapctl checkpoint PID | swapctl bench [--size SIZE] [--tier local|remote] [-n N]",
  "owner": "R1",
  "requirements": [
    "MEM-03",
    "MEM-04",
    "MEM-05"
  ],
  "flags": [
    {
      "short": null,
      "long": "--tier",
      "arg": "TIER",
      "desc": "tier policy to set, or the tier to benchmark"
    },
    {
      "short": null,
      "long": "--size",
      "arg": "SIZE",
      "desc": "bench page size, for example 5M (default 5M)"
    },
    {
      "short": "-n",
      "long": null,
      "arg": "N",
      "desc": "bench page count (default 20)"
    }
  ],
  "seeAlso": [
    "free",
    "vmstat",
    "pmap"
  ]
}
---

# NAME

swapctl — swap tiers

# SYNOPSIS

`swapctl [status]`  
`swapctl tier auto|local|remote`  
`swapctl --tier auto|local|remote`  
`swapctl drop-local [PID]`  
`swapctl checkpoint PID`  
`swapctl bench [--size SIZE] [--tier local|remote] [-n N]`

# DESCRIPTION

`status` (the default) prints the tier policy, the device and both tiers. `tier` sets the policy: `auto` writes behind to the server while online, `local` disables uploads, `remote` keeps pages only on the server once acknowledged. `drop-local` drops local copies that have an acknowledged remote copy. `checkpoint` checkpoints a process now. `bench` pages N incompressible pages of SIZE out and in and prints `MEM-05 local p95 41 ms (≤ 300 ms) PASS`, or the remote equivalent (≤ 2 s).

# OPTIONS

- `--tier TIER` — tier policy to set, or the tier to benchmark
- `--size SIZE` — bench page size, for example 5M (default 5M)
- `-n N` — bench page count (default 20)

# EXIT STATUS

0 on success (bench: the budget passed); 1 on failure or a failed bench; 2 on a usage error.

# ERRORS

- `swapctl: remote tier needs a connection` (EAGAIN)
- `swapctl: Permission denied` (EACCES, guests)

# EXAMPLES

    swapctl
    swapctl tier remote
    swapctl bench --tier remote

# SEE ALSO

free(1), vmstat(1), pmap(1)
