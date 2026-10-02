---json
{
  "name": "cp",
  "section": 1,
  "summary": "copy files and directories",
  "synopsis": "cp [-r | -R] [-n] [-f] [-p] [-v] SRC... DEST",
  "owner": "R2",
  "requirements": [
    "SYS-02",
    "VFS-06",
    "VFS-07",
    "DB-02"
  ],
  "flags": [
    {
      "short": "-r",
      "long": "--recursive",
      "arg": null,
      "desc": "copy directories recursively (symlinks copied as links)"
    },
    {
      "short": "-R",
      "long": null,
      "arg": null,
      "desc": "same as -r"
    },
    {
      "short": "-n",
      "long": "--no-clobber",
      "arg": null,
      "desc": "never overwrite an existing file"
    },
    {
      "short": "-f",
      "long": "--force",
      "arg": null,
      "desc": "replace a destination that cannot be opened for writing"
    },
    {
      "short": "-p",
      "long": "--preserve",
      "arg": null,
      "desc": "keep mode and times (and owner, for root)"
    },
    {
      "short": "-v",
      "long": "--verbose",
      "arg": null,
      "desc": "print 'a' -> 'b' for each copy"
    }
  ],
  "seeAlso": [
    "mv",
    "rm"
  ]
}
---

# NAME

cp — copy files and directories

# SYNOPSIS

`cp [-r | -R] [-n] [-f] [-p] [-v] SRC... DEST`

# DESCRIPTION

One source and a destination that is not an existing directory copies to that name; an existing directory receives the copies. Each operand is one bulk, two-phase, atomic operation (`copy` syscall).

# OPTIONS

- `-r, --recursive` — copy directories recursively (symlinks copied as links)
- `-R` — same as -r
- `-n, --no-clobber` — never overwrite an existing file
- `-f, --force` — replace a destination that cannot be opened for writing
- `-p, --preserve` — keep mode and times (and owner, for root)
- `-v, --verbose` — print 'a' -> 'b' for each copy

# EXIT STATUS

0 on success; 1 if any operand failed; 2 on a usage error.

# ERRORS

- `cp: -r not specified; omitting directory 'x'`
- `cp: cannot copy a directory, 'a', into itself, 'a/b'` (EINVAL)
- `cp: cannot copy 'x': Disk quota exceeded — nothing was copied` (EDQUOT)
- EACCES, ENOENT, ENOTDIR, EBUSY, EIO (— rolled back)

# EXAMPLES

    cp -r ~/fixtures/tree1000 /tmp/copy

# SEE ALSO

mv(1), rm(1)
