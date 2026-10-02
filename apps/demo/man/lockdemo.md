---json
{
  "name": "lockdemo",
  "section": 1,
  "summary": "take a file lease and hold it",
  "synopsis": "lockdemo [-x | -s] [-w] [-t SECS] [--hold SECS] [-i SECS] PATH",
  "owner": "R2",
  "requirements": [
    "VFS-09",
    "PROC-07"
  ],
  "flags": [
    {
      "short": "-x",
      "long": "--exclusive",
      "arg": null,
      "desc": "take an exclusive (X) lease (default)"
    },
    {
      "short": "-s",
      "long": "--shared",
      "arg": null,
      "desc": "take a shared (S) lease"
    },
    {
      "short": "-w",
      "long": "--wait",
      "arg": null,
      "desc": "wait while another holder has the lease"
    },
    {
      "short": "-t",
      "long": "--timeout",
      "arg": "SECS",
      "desc": "with --wait, give up after SECS seconds (1..600)"
    },
    {
      "short": null,
      "long": "--hold",
      "arg": "SECS",
      "desc": "release the lease after SECS seconds (default: until interrupted)"
    },
    {
      "short": "-i",
      "long": "--interval",
      "arg": "SECS",
      "desc": "print the lease status every SECS seconds; 0 = quiet (default 5)"
    }
  ],
  "seeAlso": [
    "lsof",
    "kill",
    "cat"
  ]
}
---

# NAME

lockdemo — take a file lease and hold it

# SYNOPSIS

`lockdemo [-x | -s] [-w] [-t SECS] [--hold SECS] [-i SECS] PATH`

# DESCRIPTION

The terminal side of the two-user contention demonstration (VFS-09, Demo Day item 7). It takes a lease on PATH with `lock.acquire` and holds it; the kernel renews the lease with its heartbeat (every TTL / 3) for as long as the process lives. Run it as alice in one Chrome profile and as bob with `--wait` in the other: bob's lockdemo prints who holds the lease and waits. When alice's renderer is ended from Chrome's Task Manager the heartbeat stops, and bob acquires the lease within the TTL (15 s in the demo profile). `lsof PATH` shows the holder and the countdown meanwhile.

When the lease is granted lockdemo prints `lockdemo: acquired X lease on PATH (fence 7, scope server, expires in 15 s)`, then a status line every `--interval` seconds with the time held, the current expiry and the number of queued waiters. SIGINT, SIGTERM or SIGHUP, or the end of `--hold`, releases the lease with `lock.release` and prints `lockdemo: released X lease on PATH after 30 s`. If the process is killed instead, the kernel releases its leases when it exits (PROC-07).

Without `--wait`, a lease held by someone else is reported at once: `lockdemo: PATH is locked by alice@lab-pc-3 (X, expires in 12 s)`.

# OPTIONS

- `-x, --exclusive` — take an exclusive (X) lease (default)
- `-s, --shared` — take a shared (S) lease
- `-w, --wait` — wait while another holder has the lease
- `-t, --timeout SECS` — with --wait, give up after SECS seconds (1..600)
- `--hold SECS` — release the lease after SECS seconds (default: until interrupted)
- `-i, --interval SECS` — print the lease status every SECS seconds; 0 = quiet (default 5)

# EXIT STATUS

0 when the lease was held for `--hold` seconds and released; 1 when the lease is busy (without `--wait`), the wait timed out or a call failed; 128 + n when ended by signal n; 2 on a usage error.

# ERRORS

- `lockdemo: /home/shared/plan.md is locked by alice@lab-pc-3 (X, expires in 12 s)`
- `lockdemo: timed out after 20 s waiting for an X lease on /home/shared/plan.md`
- `lockdemo: cannot lock '/home/shared/plan.md': Permission denied`

# EXAMPLES

    lockdemo /home/shared/plan.md
    lockdemo --wait --timeout 60 /home/shared/plan.md
    lockdemo -s --hold 30 -i 0 ~/notes.md

# SEE ALSO

lsof(1), kill(1), cat(1)
