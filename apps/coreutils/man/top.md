---json
{
  "name": "top",
  "section": 1,
  "summary": "live process view",
  "synopsis": "top [-b] [-n N] [-d SECS] [-u USER] [-p PID[,PID...]] [-o FIELD] [--json]",
  "owner": "R1",
  "requirements": [
    "SYS-02",
    "PROC-05",
    "PROC-08",
    "MEM-07"
  ],
  "flags": [
    {
      "short": "-b",
      "long": null,
      "arg": null,
      "desc": "batch mode: plain frames separated by a blank line"
    },
    {
      "short": "-n",
      "long": null,
      "arg": "N",
      "desc": "stop after N frames"
    },
    {
      "short": "-d",
      "long": null,
      "arg": "SECS",
      "desc": "delay between frames (at least 0.5, default 1)"
    },
    {
      "short": "-u",
      "long": null,
      "arg": "USER",
      "desc": "only processes of USER"
    },
    {
      "short": "-p",
      "long": null,
      "arg": "PID",
      "desc": "only these processes (comma-separated)"
    },
    {
      "short": "-o",
      "long": null,
      "arg": "FIELD",
      "desc": "sort field: pcpu (default), rss, time, pid, pri"
    },
    {
      "short": null,
      "long": "--json",
      "arg": null,
      "desc": "print each frame as one JSON line"
    }
  ],
  "seeAlso": [
    "ps",
    "free",
    "vmstat",
    "kill",
    "renice"
  ]
}
---

# NAME

top — live process view

# SYNOPSIS

`top [-b] [-n N] [-d SECS] [-u USER] [-p PID[,PID...]] [-o FIELD] [--json]`

# DESCRIPTION

Each frame prints `top - HH:MM:SS up H:MM:SS,  N users,  load average: 1m, 5m, 15m`, the task counts by state, the memory and paging lines, then `PID USER PRI NI EP CLS STAT %CPU RES SWAP FLT EXE TIME+ COMMAND` rows sorted by `%CPU`. `%CPU` is the CPU time used in the last interval divided by the interval (the first frame uses the kernel's figure).

On a terminal without `-b`, top uses the alternate screen, hides the cursor and redraws every delay and on SIGWINCH; Ctrl-C, SIGTERM or SIGHUP restore the screen and exit.

# OPTIONS

- `-b` — batch mode: plain frames separated by a blank line
- `-n N` — stop after N frames
- `-d SECS` — delay between frames (at least 0.5, default 1)
- `-u USER` — only processes of USER
- `-p PID` — only these processes (comma-separated)
- `-o FIELD` — sort field: pcpu (default), rss, time, pid, pri
- `--json` — print each frame as one JSON line

# EXIT STATUS

0 on success; 1 if a user does not exist; 2 on a usage error.

# ERRORS

- `top: no such user 'x'`
- `top: delay must be at least 0.5 seconds` (exit 2)

# EXAMPLES

    top
    top -b -n 1 | head -n 12
    top -b -n 3 -d 0.5 -o rss

# SEE ALSO

ps(1), free(1), vmstat(1), kill(1), renice(1)
