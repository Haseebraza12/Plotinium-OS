---json
{
  "name": "stat",
  "section": 1,
  "summary": "show inode metadata",
  "synopsis": "stat [-L] [-t] FILE...",
  "owner": "R2",
  "requirements": [
    "SYS-02",
    "VFS-05",
    "VFS-07",
    "VFS-10"
  ],
  "flags": [
    {
      "short": "-L",
      "long": "--dereference",
      "arg": null,
      "desc": "follow symbolic links"
    },
    {
      "short": "-t",
      "long": "--terse",
      "arg": null,
      "desc": "one terse line per file"
    }
  ],
  "seeAlso": [
    "ls",
    "chmod",
    "chown"
  ]
}
---

# NAME

stat — show inode metadata

# SYNOPSIS

`stat [-L] [-t] FILE...`

# DESCRIPTION

Prints `File`, `Type`, `Size`, `Links`, `Inode`, `Version`, `Sync`, the access mode, owner and group, and the access, modify and change times with milliseconds and the UTC offset. A symlink shows `File: name -> target` and `Type: symbolic link` unless `-L` is given.

`-t` prints `NAME SIZE MODE UID GID INODE LINKS ATIME MTIME CTIME VERSION TYPE` on one line: the mode in octal, times in epoch milliseconds and the type as `f`, `d` or `l`.

# OPTIONS

- `-L, --dereference` — follow symbolic links
- `-t, --terse` — one terse line per file

# EXIT STATUS

0 on success; 1 if any file failed; 2 on a usage error.

# ERRORS

- `stat: cannot stat 'x': No such file or directory` (ENOENT)
- EACCES
- ELOOP (with -L)

# EXAMPLES

    stat notes.md
    stat -L today
    stat -t notes.md

# SEE ALSO

ls(1), chmod(1), chown(1)
