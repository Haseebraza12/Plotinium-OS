---json
{
  "name": "kill",
  "section": 1,
  "summary": "send a signal",
  "synopsis": "kill [-s SIGNAL | -SIGNAL | -n NUM] PID | -PGID... | kill -l [NUM | SIGNAL]",
  "owner": "R1",
  "requirements": [
    "SYS-02",
    "PROC-07",
    "AGT-09"
  ],
  "flags": [
    {
      "short": "-s",
      "long": null,
      "arg": "SIGNAL",
      "desc": "signal name, with or without SIG"
    },
    {
      "short": "-n",
      "long": null,
      "arg": "NUM",
      "desc": "signal number"
    },
    {
      "short": "-l",
      "long": null,
      "arg": null,
      "desc": "list signal names, or translate a number or exit status"
    }
  ],
  "seeAlso": [
    "ps",
    "top",
    "nice"
  ]
}
---

# NAME

kill — send a signal

# SYNOPSIS

`kill [-s SIGNAL | -SIGNAL | -n NUM] PID | -PGID...`  
`kill -l [NUM | SIGNAL]`

# DESCRIPTION

Sends SIGTERM, or the given signal, to each PID; a negative PID is a process group (`kill -- -312` or `kill -TERM -312`). `%JOB` is resolved by the shell builtin only. `kill -l` prints `1) SIGHUP  2) SIGINT  3) SIGQUIT  9) SIGKILL  13) SIGPIPE  15) SIGTERM  17) SIGCHLD  18) SIGCONT  19) SIGSTOP  20) SIGTSTP  21) SIGTTIN  22) SIGTTOU  28) SIGWINCH`; `kill -l 137` prints `KILL`. Sending to another user's process needs root; pid 1 cannot be signalled.

# OPTIONS

- `-s SIGNAL` — signal name, with or without SIG
- `-n NUM` — signal number
- `-l` — list signal names, or translate a number or exit status

# EXIT STATUS

0 on success; 1 if any target failed; 2 on an invalid signal or a usage error.

# ERRORS

- `kill: (999) - No such process` (ESRCH)
- `kill: (1) - Operation not permitted` (EPERM)
- `kill: invalid signal 'FOO'` (exit 2)

# EXAMPLES

    kill 312
    kill -9 312
    kill -TERM -312
    kill -l 137

# SEE ALSO

ps(1), top(1), nice(1)
