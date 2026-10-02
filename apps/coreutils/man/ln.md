---json
{
  "name": "ln",
  "section": 1,
  "summary": "make links",
  "synopsis": "ln [-s] [-f] [-v] TARGET... LINK",
  "owner": "R2",
  "requirements": [
    "SYS-02",
    "VFS-05",
    "VFS-07"
  ],
  "flags": [
    {
      "short": "-s",
      "long": "--symbolic",
      "arg": null,
      "desc": "make a symbolic link (may dangle)"
    },
    {
      "short": "-f",
      "long": "--force",
      "arg": null,
      "desc": "replace an existing LINK in one batch"
    },
    {
      "short": "-v",
      "long": "--verbose",
      "arg": null,
      "desc": "print 'LINK' -> 'TARGET'"
    }
  ],
  "seeAlso": [
    "stat",
    "ls"
  ]
}
---

# NAME

ln — make links

# SYNOPSIS

`ln [-s] [-f] [-v] TARGET... LINK`

# DESCRIPTION

With `-s` stores TARGET as the text of a symbolic link. Without `-s` a hard link is made where the file system supports it; otherwise `ln: hard links are not supported; use ln -s`.

# OPTIONS

- `-s, --symbolic` — make a symbolic link (may dangle)
- `-f, --force` — replace an existing LINK in one batch
- `-v, --verbose` — print 'LINK' -> 'TARGET'

# EXIT STATUS

0 on success; 1 on failure; 2 on a usage error.

# ERRORS

- EEXIST, ENOENT (parent), EACCES, EPERM (hard link to a directory), ENAMETOOLONG, ENOSYS

# EXAMPLES

    ln -s ~/notes/today.md today

# SEE ALSO

stat(1), ls(1)
