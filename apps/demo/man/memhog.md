---json
{
  "name": "memhog",
  "section": 1,
  "summary": "memory stress program with verified paging",
  "synopsis": "memhog --total SIZE [--procs N] [--touch random|seq] [--rate PAGES_PER_S] [--write-ratio R] [--compressible] [--hold SECS] [--seed S] [--report SECS]",
  "owner": "R1",
  "requirements": [
    "MEM-03",
    "MEM-06",
    "MEM-07",
    "KMM-14"
  ],
  "flags": [
    {
      "short": null,
      "long": "--total",
      "arg": "SIZE",
      "desc": "bytes to allocate across all children, with K, M or G (binary)"
    },
    {
      "short": null,
      "long": "--procs",
      "arg": "N",
      "desc": "number of child processes sharing SIZE (default 1)"
    },
    {
      "short": null,
      "long": "--touch",
      "arg": "ORDER",
      "desc": "page touch order, random or seq (default random)"
    },
    {
      "short": null,
      "long": "--rate",
      "arg": "PAGES_PER_S",
      "desc": "pages each child touches per second; 0 = no pause (default 50)"
    },
    {
      "short": null,
      "long": "--write-ratio",
      "arg": "R",
      "desc": "fraction 0..1 of touches that rewrite the page (default 0.25)"
    },
    {
      "short": null,
      "long": "--compressible",
      "arg": null,
      "desc": "fill pages with a repeating text pattern instead of noise"
    },
    {
      "short": null,
      "long": "--hold",
      "arg": "SECS",
      "desc": "exit after SECS seconds of touching (default: until killed)"
    },
    {
      "short": null,
      "long": "--seed",
      "arg": "S",
      "desc": "seed of the fill pattern and the touch order (default 42)"
    },
    {
      "short": null,
      "long": "--report",
      "arg": "SECS",
      "desc": "print the status line every SECS seconds (default 5)"
    },
    {
      "short": null,
      "long": "--child",
      "arg": "INDEX",
      "desc": "internal: run as child INDEX of a memhog parent"
    }
  ],
  "seeAlso": [
    "free",
    "vmstat",
    "pmap",
    "swapctl",
    "top",
    "burn"
  ]
}
---

# NAME

memhog — memory stress program with verified paging

# SYNOPSIS

`memhog --total SIZE [--procs N] [--touch random|seq] [--rate PAGES_PER_S] [--write-ratio R] [--compressible] [--hold SECS] [--seed S] [--report SECS]`

# DESCRIPTION

The workload of the MEM-06 test and of Demo Day item 5 (`memhog --total 512M --procs 8`, twice the default 256 MiB budget). The parent spawns N children; each allocates SIZE / N bytes in 256 KiB pages, one page per call to `ctx.mem.alloc({kind: 'chunk'})` (or `mem.alloc` where the executor has no page API yet). Every byte is therefore reserved before it exists, and a child waits (BLOCKED on `mem`) while reclaim frees space, so accounted memory never goes over the budget.

Each page is filled with a deterministic pattern computed from the seed, the child, the page and the page's write generation, and the child keeps a 64-bit checksum of every page in its state. It then touches its pages in random or sequential order at PAGES_PER_S pages per second. A read touch recomputes the page's checksum and compares it with the recorded one; a write touch (a fraction R of touches) fills the page again with the next generation, which dirties it. A page that was paged out and faulted back in must therefore come back byte-identical, and any difference is reported at once. After a whole-process page-in, a migration or a session restore, a child checks every page before it continues and prints `memhog: child C (pid P) restored after page-in: 256/256 pages verified byte-identical`.

Every SECS seconds and at exit the parent prints `memhog: 8 procs, 512.0M allocated, budget 256.0M, committed 254.9M, faults 1832 (41/s), max blocked 380 ms, max over budget 0 ms`. `allocated` is the resident plus swapped bytes of the children, `faults` their major faults. Values the kernel does not report yet are printed as `-`. Children keep only a small state, so they are checkpointable. SIGINT, SIGTERM or SIGHUP stop the children, which free their pages, and the parent prints the final line.

# OPTIONS

- `--total SIZE` — bytes to allocate across all children, with K, M or G (binary)
- `--procs N` — number of child processes sharing SIZE (default 1)
- `--touch ORDER` — page touch order, random or seq (default random)
- `--rate PAGES_PER_S` — pages each child touches per second; 0 = no pause (default 50)
- `--write-ratio R` — fraction 0..1 of touches that rewrite the page (default 0.25)
- `--compressible` — fill pages with a repeating text pattern instead of noise
- `--hold SECS` — exit after SECS seconds of touching (default: until killed)
- `--seed S` — seed of the fill pattern and the touch order (default 42)
- `--report SECS` — print the status line every SECS seconds (default 5)
- `--child INDEX` — internal: run as child INDEX of a memhog parent

# EXIT STATUS

0 when every child ended normally; 3 when a child found a page whose checksum changed; 1 when a child could not allocate or spawn; 128 + n when stopped by signal n; 2 on a usage error.

# ERRORS

- `memhog: child 3 (pid 612): page 17 changed after page-in: checksum 1f2e…, expected 9a0b…`
- `memhog: child 3 (pid 612): cannot allocate 256.0K: Invalid argument (exceeds-budget)`
- `memhog: cannot spawn child 5: Resource temporarily unavailable (thrashing)`

# EXAMPLES

    memhog --total 512M --procs 8
    memhog --total 256M --procs 4 --hold 60
    memhog --total 64M --touch seq --rate 0 --write-ratio 0

# SEE ALSO

free(1), vmstat(1), pmap(1), swapctl(1), top(1), burn(1)
