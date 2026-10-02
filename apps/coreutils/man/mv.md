---json
{
  "name": "mv",
  "section": 1,
  "summary": "move or rename",
  "synopsis": "mv [-n] [-f] [-v] SRC... DEST",
  "owner": "R2",
  "requirements": [
    "SYS-02",
    "VFS-07",
    "DB-02",
    "DB-03"
  ],
  "flags": [
    {
      "short": "-n",
      "long": "--no-clobber",
      "arg": null,
      "desc": "never overwrite an existing destination"
    },
    {
      "short": "-f",
      "long": "--force",
      "arg": null,
      "desc": "overwrite without error (default behaviour)"
    },
    {
      "short": "-v",
      "long": "--verbose",
      "arg": null,
      "desc": "print renamed 'a' -> 'b'"
    }
  ],
  "seeAlso": [
    "cp",
    "rm"
  ]
}
---

# NAME

mv — move or rename

# SYNOPSIS

`mv [-n] [-f] [-v] SRC... DEST`

# DESCRIPTION

Each operand is one `rename`. An existing file destination is replaced; an existing directory destination receives the sources.

# OPTIONS

- `-n, --no-clobber` — never overwrite an existing destination
- `-f, --force` — overwrite without error (default behaviour)
- `-v, --verbose` — print renamed 'a' -> 'b'

# EXIT STATUS

0 on success; 1 if any operand failed; 2 on a usage error.

# ERRORS

- `mv: cannot move 'a' to a subdirectory of itself, 'a/b'` (EINVAL)
- `mv: cannot overwrite directory 'x' with non-directory` (EISDIR)
- ENOTEMPTY, ENOTDIR, EACCES, EPERM, EBUSY, EXDEV, EIO

# EXAMPLES

    mv draft.md ~/reports/final.md

# SEE ALSO

cp(1), rm(1)
