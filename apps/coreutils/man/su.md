---json
{
  "name": "su",
  "section": 1,
  "summary": "run a shell as another user",
  "synopsis": "su [-] [-l] [-c COMMAND] [USER]",
  "owner": "R5",
  "requirements": [
    "SYS-02",
    "OFF-03",
    "AGT-04"
  ],
  "flags": [
    {
      "short": "-l",
      "long": "--login",
      "arg": null,
      "desc": "start a login shell (also written -)"
    },
    {
      "short": "-c",
      "long": "--command",
      "arg": "COMMAND",
      "desc": "run COMMAND and return"
    }
  ],
  "seeAlso": [
    "whoami",
    "id"
  ]
}
---

# NAME

su — run a shell as another user

# SYNOPSIS

`su [-] [-l] [-c COMMAND] [USER]`

# DESCRIPTION

Asks for the password of USER (default root) in the secure prompt, which never passes through the shell or the terminal, then runs a shell with that user's credentials. The grant expires after 15 minutes idle.

# OPTIONS

- `-l, --login` — start a login shell (also written -)
- `-c, --command COMMAND` — run COMMAND and return

# EXIT STATUS

the shell's status; 1 on failure; 2 on a usage error.

# ERRORS

- `su: must be run from a terminal` (ENOTTY)
- `su: Authentication failure` (EACCES)
- `su: authentication cancelled` (ECANCELED)
- `su: authentication unavailable offline` (EAGAIN)
- `su: user bob2 does not exist` (EINVAL)

# EXAMPLES

    su -c 'fsck -y'

# SEE ALSO

whoami(1), id(1)
