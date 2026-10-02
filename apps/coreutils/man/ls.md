---json
{
  "name": "ls",
  "section": 1,
  "summary": "list directory contents",
  "synopsis": "ls [-a] [-l] [-h] [-d] [-R] [-1] [-i] [-t] [-r] [--color[=WHEN]] [PATH...]",
  "owner": "R2",
  "requirements": [
    "SYS-02",
    "VFS-02",
    "VFS-05",
    "VFS-07"
  ],
  "flags": [
    {
      "short": "-a",
      "long": "--all",
      "arg": null,
      "desc": "include names that begin with ., and the entries . and .."
    },
    {
      "short": "-l",
      "long": null,
      "arg": null,
      "desc": "long listing: mode, links, owner, group, size, mtime"
    },
    {
      "short": "-h",
      "long": "--human-readable",
      "arg": null,
      "desc": "with -l, print sizes like 4.0K and 18M"
    },
    {
      "short": "-d",
      "long": "--directory",
      "arg": null,
      "desc": "list directories themselves, not their contents"
    },
    {
      "short": "-R",
      "long": "--recursive",
      "arg": null,
      "desc": "list subdirectories recursively"
    },
    {
      "short": "-1",
      "long": null,
      "arg": null,
      "desc": "one name per line"
    },
    {
      "short": "-i",
      "long": "--inode",
      "arg": null,
      "desc": "print the first 8 hex digits of the inode id"
    },
    {
      "short": "-t",
      "long": null,
      "arg": null,
      "desc": "sort by modification time, newest first"
    },
    {
      "short": "-r",
      "long": "--reverse",
      "arg": null,
      "desc": "reverse the sort order"
    },
    {
      "short": null,
      "long": "--color",
      "arg": "WHEN",
      "desc": "colour output on a terminal: auto (default) or never"
    }
  ],
  "seeAlso": [
    "stat",
    "find",
    "tree"
  ]
}
---

# NAME

ls — list directory contents

# SYNOPSIS

`ls [-a] [-l] [-h] [-d] [-R] [-1] [-i] [-t] [-r] [--color[=WHEN]] [PATH...]`

# DESCRIPTION

Lists each PATH (default `.`). Names are sorted in code-point order. On a terminal the short format is laid out in columns sized to `$COLUMNS`, directories get a trailing `/` and symlinks `@`. The long format is `<mode> <nlink> <owner> <group> <size> <YYYY-MM-DD HH:MM> <name>[ -> <target>]`. There is no `total` line. With several operands each directory is headed `path:`.

# OPTIONS

- `-a, --all` — include names that begin with ., and the entries . and ..
- `-l` — long listing: mode, links, owner, group, size, mtime
- `-h, --human-readable` — with -l, print sizes like 4.0K and 18M
- `-d, --directory` — list directories themselves, not their contents
- `-R, --recursive` — list subdirectories recursively
- `-1` — one name per line
- `-i, --inode` — print the first 8 hex digits of the inode id
- `-t` — sort by modification time, newest first
- `-r, --reverse` — reverse the sort order
- `--color WHEN` — colour output on a terminal: auto (default) or never

# EXIT STATUS

0 on success; 1 if any operand failed; 2 on a usage error.

# ERRORS

- `ls: cannot access 'x': No such file or directory` (ENOENT)
- `ls: cannot open directory 'x': Permission denied` (EACCES)
- ELOOP, ENOTDIR

# EXAMPLES

    ls -la ~
    ls -lt /tmp

# SEE ALSO

stat(1), find(1), tree(1)
