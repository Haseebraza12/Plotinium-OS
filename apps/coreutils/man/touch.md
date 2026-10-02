---json
{
  "name": "touch",
  "section": 1,
  "summary": "create files or set times",
  "synopsis": "touch [-c] [-a] [-m] [-d DATE] FILE...",
  "owner": "R2",
  "requirements": [
    "SYS-02",
    "VFS-06",
    "VFS-07"
  ],
  "flags": [
    {
      "short": "-c",
      "long": "--no-create",
      "arg": null,
      "desc": "do not create missing files"
    },
    {
      "short": "-a",
      "long": null,
      "arg": null,
      "desc": "change the access time only"
    },
    {
      "short": "-m",
      "long": null,
      "arg": null,
      "desc": "change the modification time only"
    },
    {
      "short": "-d",
      "long": "--date",
      "arg": "DATE",
      "desc": "use DATE (YYYY-MM-DD[THH:MM[:SS]]) instead of now"
    }
  ],
  "seeAlso": [
    "stat"
  ]
}
---

# NAME

touch — create files or set times

# SYNOPSIS

`touch [-c] [-a] [-m] [-d DATE] FILE...`

# DESCRIPTION

A missing FILE is created empty with mode `0666 & ~umask`; an existing file or directory gets new times.

# OPTIONS

- `-c, --no-create` — do not create missing files
- `-a` — change the access time only
- `-m` — change the modification time only
- `-d, --date DATE` — use DATE (YYYY-MM-DD[THH:MM[:SS]]) instead of now

# EXIT STATUS

0 on success; 1 if any operand failed; 2 on a usage error.

# ERRORS

- EACCES, ENOENT (parent), ENOTDIR, EDQUOT, EINVAL (bad date)

# EXAMPLES

    touch notes.md

# SEE ALSO

stat(1)
