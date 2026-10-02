---json
{
  "name": "burn",
  "section": 1,
  "summary": "CPU-bound stress program",
  "synopsis": "burn [--ms N] [--step-us S] [-t T] [--priority P] [-n N] [--exclusive] [-p SECS] [--json]",
  "owner": "R1",
  "requirements": [
    "PROC-03",
    "PROC-04",
    "PROC-05",
    "KPS-14"
  ],
  "flags": [
    {
      "short": null,
      "long": "--ms",
      "arg": "N",
      "desc": "stop after N ms of CPU time (default: run until killed)"
    },
    {
      "short": null,
      "long": "--step-us",
      "arg": "S",
      "desc": "compute S microseconds between yield points (default 100)"
    },
    {
      "short": "-t",
      "long": "--threads",
      "arg": "T",
      "desc": "run T burn processes side by side (default 1)"
    },
    {
      "short": null,
      "long": "--priority",
      "arg": "P",
      "desc": "static priority 0..39; below 20 needs root or the test profile"
    },
    {
      "short": "-n",
      "long": "--nice",
      "arg": "N",
      "desc": "nice value -20..19; a negative value needs root"
    },
    {
      "short": null,
      "long": "--exclusive",
      "arg": null,
      "desc": "give every thread an executor of its own (root or the test profile)"
    },
    {
      "short": "-p",
      "long": "--progress",
      "arg": "SECS",
      "desc": "print a progress line every SECS seconds"
    },
    {
      "short": null,
      "long": "--json",
      "arg": null,
      "desc": "print the final report as one JSON object"
    }
  ],
  "seeAlso": [
    "top",
    "ps",
    "nice",
    "renice",
    "kill",
    "memhog"
  ]
}
---

# NAME

burn — CPU-bound stress program

# SYNOPSIS

`burn [--ms N] [--step-us S] [-t T] [--priority P] [-n N] [--exclusive] [-p SECS] [--json]`

# DESCRIPTION

A real, checkpointable, CPU-bound process for the scheduler demonstrations (P3 gate step 1, PROC-04 starvation test, PROC-05 frame gate, Demo Day item 4: `burn --ms 120000 &` three times, then `top`). It computes in steps of S microseconds of CPU time and does `yield ctx.tick` between steps, so the scheduler can pre-empt it at every quantum. The CPU time counted is the time spent inside its own steps, so time spent waiting in the ready queue is not counted.

Its state is `{remainingMs, iterations, cpuMs, maxStepUs}`: after a page-out, a migration or a session restore it continues where it stopped. At the end it prints `burn: <iterations> iterations, <cpu ms> ms CPU, max step <us> us`.

With `-t T` (T ≥ 2) or `--exclusive`, burn spawns T child burn processes (each with `-t 1`, so each prints its own final line) in its process group, waits for them and prints `burn: T threads done, exit status 0 0 0`; signals it catches are passed on to the threads. `--exclusive` asks for `spawn({exclusive: true})`; when the kernel refuses it, burn prints a warning and runs the threads on shared executors.

`--priority` and `--nice` are applied with `setpriority` before the first step. SIGUSR1 prints a progress line at once; SIGINT, SIGTERM and SIGHUP end the run early with the final line, and the exit status is 128 + the signal number. A step longer than 500 µs (STEP_MAX_US) is a deliberate overrun, for the watchdog and exclusive-placement demonstrations.

# OPTIONS

- `--ms N` — stop after N ms of CPU time (default: run until killed)
- `--step-us S` — compute S microseconds between yield points (default 100)
- `-t, --threads T` — run T burn processes side by side (default 1)
- `--priority P` — static priority 0..39; below 20 needs root or the test profile
- `-n, --nice N` — nice value -20..19; a negative value needs root
- `--exclusive` — give every thread an executor of its own (root or the test profile)
- `-p, --progress SECS` — print a progress line every SECS seconds
- `--json` — print the final report as one JSON object

# EXIT STATUS

0 when the CPU time ran out; 128 + n when ended by caught signal n (130 for SIGINT, 143 for SIGTERM); 1 when a priority could not be set or a thread could not be spawned; 2 on a usage error.

# ERRORS

- `burn: cannot set priority: Permission denied` (`--priority` below 20 or a negative `--nice` without root)
- `burn: cannot spawn thread: Resource temporarily unavailable`
- `burn: warning: exclusive placement refused (Invalid argument); threads share executors`

# EXAMPLES

    burn --ms 120000 &
    burn --ms 60000 -t 3 -p 10
    nice -n 15 burn --ms 60000 &
    burn --priority 39 --ms 60000 --json

# SEE ALSO

top(1), ps(1), nice(1), renice(1), kill(1), memhog(1)
