---json
{
  "name": "rmdir",
  "section": 1,
  "summary": "remove empty directories",
  "synopsis": "rmdir [-p] [-v] DIR...",
  "owner": "R2",
  "requirements": [
    "SYS-02",
    "VFS-07"
  ],
  "flags": [
    {
      "short": "-p",
      "long": "--parents",
      "arg": null,
      "desc": "also remove each parent that becomes empty"
    },
    {
      "short": "-v",
      "long": "--verbose",
      "arg": null,
      "desc": "report each removed directory"
    }
  ],
  "seeAlso": [
    "mkdir",
    "rm"
  ]
}
---

# NAME

rmdir — remove empty directories

# SYNOPSIS

`rmdir [-p] [-v] DIR...`

# DESCRIPTION

Removes each empty DIR.

# OPTIONS

- `-p, --parents` — also remove each parent that becomes empty
- `-v, --verbose` — report each removed directory

# EXIT STATUS

0 on success; 1 if any operand failed; 2 on a usage error.

# ERRORS

- `rmdir: failed to remove 'x': Directory not empty` (ENOTEMPTY)
- ENOTDIR, ENOENT, EACCES, EPERM (sticky), EBUSY

# EXAMPLES

    rmdir ~/empty

# SEE ALSO

mkdir(1), rm(1)
