---json
{
  "name": "mkdir",
  "section": 1,
  "summary": "make directories",
  "synopsis": "mkdir [-p] [-m MODE] [-v] DIR...",
  "owner": "R2",
  "requirements": [
    "SYS-02",
    "VFS-06",
    "VFS-07",
    "VFS-08"
  ],
  "flags": [
    {
      "short": "-p",
      "long": "--parents",
      "arg": null,
      "desc": "create missing parents; no error if the directory exists"
    },
    {
      "short": "-m",
      "long": "--mode",
      "arg": "MODE",
      "desc": "octal or symbolic mode, relative to a=rwx"
    },
    {
      "short": "-v",
      "long": "--verbose",
      "arg": null,
      "desc": "report each created directory"
    }
  ],
  "seeAlso": [
    "rmdir",
    "chmod"
  ]
}
---

# NAME

mkdir — make directories

# SYNOPSIS

`mkdir [-p] [-m MODE] [-v] DIR...`

# DESCRIPTION

Creates each DIR with mode `0777 & ~umask`. With `-p` the missing components of one operand are created in one transaction (all or nothing).

# OPTIONS

- `-p, --parents` — create missing parents; no error if the directory exists
- `-m, --mode MODE` — octal or symbolic mode, relative to a=rwx
- `-v, --verbose` — report each created directory

# EXIT STATUS

0 on success; 1 if any operand failed; 2 on a usage error.

# ERRORS

- `mkdir: cannot create directory 'x': File exists` (EEXIST)
- ENOENT, EACCES, ENOTDIR, EDQUOT, ENAMETOOLONG, EINVAL (bad mode)

# EXAMPLES

    mkdir -p ~/projects/os/notes

# SEE ALSO

rmdir(1), chmod(1)
