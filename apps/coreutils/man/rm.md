---json
{
  "name": "rm",
  "section": 1,
  "summary": "remove files and directories",
  "synopsis": "rm [-r | -R] [-f] [-d] [-v] PATH...",
  "owner": "R2",
  "requirements": [
    "SYS-02",
    "VFS-07",
    "DB-02"
  ],
  "flags": [
    {
      "short": "-r",
      "long": "--recursive",
      "arg": null,
      "desc": "remove directories and their contents (one bulk transaction)"
    },
    {
      "short": "-R",
      "long": null,
      "arg": null,
      "desc": "same as -r"
    },
    {
      "short": "-f",
      "long": "--force",
      "arg": null,
      "desc": "ignore missing operands and never report ENOENT"
    },
    {
      "short": "-d",
      "long": "--dir",
      "arg": null,
      "desc": "remove empty directories"
    },
    {
      "short": "-v",
      "long": "--verbose",
      "arg": null,
      "desc": "report each removal"
    }
  ],
  "seeAlso": [
    "rmdir",
    "mv"
  ]
}
---

# NAME

rm — remove files and directories

# SYNOPSIS

`rm [-r | -R] [-f] [-d] [-v] PATH...`

# DESCRIPTION

A file is unlinked; a directory needs `-r` or `-d`. `rm -r` is one bulk operation that waits for the server result while online. `rm` always refuses `/`, `.` and `..`.

# OPTIONS

- `-r, --recursive` — remove directories and their contents (one bulk transaction)
- `-R` — same as -r
- `-f, --force` — ignore missing operands and never report ENOENT
- `-d, --dir` — remove empty directories
- `-v, --verbose` — report each removal

# EXIT STATUS

0 on success; 1 if any operand failed; 2 on a usage error.

# ERRORS

- `rm: cannot remove 'x': Is a directory`
- `rm: cannot remove 'x': Permission denied`
- `rm: it is dangerous to operate recursively on '/'`
- `rm: refusing to remove '.' or '..' directory: skipping '..'`
- EIO (— rolled back), EBUSY (locked by …)

# EXAMPLES

    rm -r ~/old-drafts

# SEE ALSO

rmdir(1), mv(1)
