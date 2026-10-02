---json
{
  "name": "ps",
  "section": 1,
  "summary": "process status",
  "synopsis": "ps [-e | -A] [-f] [-l] [-u USER[,USER...]] [-p PID[,PID...]] [-t TTY] [-o FIELD[,FIELD...]] [--sort [-]FIELD] [--no-headers] [--json]",
  "owner": "R1",
  "requirements": [
    "SYS-02",
    "PROC-06",
    "PROC-08",
    "RAG-01",
    "AGT-09",
    "PRE-06"
  ],
  "flags": [
    {
      "short": "-e",
      "long": null,
      "arg": null,
      "desc": "select every process"
    },
    {
      "short": "-A",
      "long": null,
      "arg": null,
      "desc": "same as -e"
    },
    {
      "short": "-f",
      "long": null,
      "arg": null,
      "desc": "full format: ids, PRI NI CLS STAT %CPU RSS SWAP TTY TIME COMMAND"
    },
    {
      "short": "-l",
      "long": null,
      "arg": null,
      "desc": "long format: adds EP (effective priority) and WCHAN (what it waits on)"
    },
    {
      "short": "-u",
      "long": null,
      "arg": "USER",
      "desc": "select the processes of these users (comma-separated)"
    },
    {
      "short": "-p",
      "long": null,
      "arg": "PID",
      "desc": "select processes by comma-separated pid list"
    },
    {
      "short": "-t",
      "long": null,
      "arg": "TTY",
      "desc": "select the processes whose terminal is TTY (tty1, or 1)"
    },
    {
      "short": "-o",
      "long": null,
      "arg": "FIELD",
      "desc": "user-defined format, comma-separated fields"
    },
    {
      "short": null,
      "long": "--sort",
      "arg": "FIELD",
      "desc": "sort by FIELD; a leading - sorts descending"
    },
    {
      "short": null,
      "long": "--no-headers",
      "arg": null,
      "desc": "do not print the header line"
    },
    {
      "short": null,
      "long": "--json",
      "arg": null,
      "desc": "print the selected rows as JSON"
    }
  ],
  "seeAlso": [
    "top",
    "kill",
    "renice",
    "pmap"
  ]
}
---

# NAME

ps — process status

# SYNOPSIS

`ps [-e | -A] [-f] [-l] [-u USER[,USER...]] [-p PID[,PID...]] [-t TTY] [-o FIELD[,FIELD...]] [--sort [-]FIELD] [--no-headers] [--json]`

# DESCRIPTION

With no selection option, lists the caller's processes on the caller's terminal. Rows come from `proc.list` and are sorted by pid unless `--sort` is given. Default columns: `PID TTY STAT TIME COMMAND`.

Fields for `-o` and `--sort`: `pid ppid pgid sid uid user pri ni eprio cls state stat wchan pcpu time etime stime rss swap flt hit exe ovr tty comm args exit`. Aliases: `cmd` and `command` for `args`, `ep` and `epri` for `eprio`, `acct` for `rss`, `s` for `stat`.

`PRI` is `clamp(priority + nice, 0, 39)`; `EP` the effective priority with aging; `CLS` the band of the base priority (`int` 0-9, `nor` 10-29, `bkg` 30-39) or `kth`/`spc` for kernel threads and special workers. `STAT` is `NEW RDY RUN BLK STP SUS ZMB` followed by the flags `+` foreground group, `s` session leader, `<` boosted, `N` nice above 0, `X` exclusive executor, `!` over the soft limit, `P` pinned. `TIME` is CPU time as `M:SS.cc`; sizes use one decimal and binary units (`82.2K`, `2.1M`, `0B`).

# OPTIONS

- `-e` — select every process
- `-A` — same as -e
- `-f` — full format: ids, PRI NI CLS STAT %CPU RSS SWAP TTY TIME COMMAND
- `-l` — long format: adds EP (effective priority) and WCHAN (what it waits on)
- `-u USER` — select the processes of these users (comma-separated)
- `-p PID` — select processes by comma-separated pid list
- `-t TTY` — select the processes whose terminal is TTY (tty1, or 1)
- `-o FIELD` — user-defined format, comma-separated fields
- `--sort FIELD` — sort by FIELD; a leading - sorts descending
- `--no-headers` — do not print the header line
- `--json` — print the selected rows as JSON

# EXIT STATUS

0 on success; 1 if a user does not exist; 2 on an unknown field or a usage error.

# ERRORS

- `ps: unknown field 'foo'` (exit 2)
- `ps: no such user 'x'` (exit 1)

# EXAMPLES

    ps
    ps -ef --sort=-pcpu
    ps -e -o pid,stat,cmd
    ps -el | grep ai.

# SEE ALSO

top(1), kill(1), renice(1), pmap(1)
