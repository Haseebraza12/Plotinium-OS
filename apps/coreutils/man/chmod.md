---json
{
  "name": "chmod",
  "section": 1,
  "summary": "change mode",
  "synopsis": "chmod [-R] [-v] [-c] MODE FILE...",
  "owner": "R2",
  "requirements": [
    "SYS-02",
    "VFS-04",
    "VFS-07",
    "DB-02"
  ],
  "flags": [
    {
      "short": "-R",
      "long": "--recursive",
      "arg": null,
      "desc": "change files and directories recursively in one transaction"
    },
    {
      "short": "-v",
      "long": "--verbose",
      "arg": null,
      "desc": "report every file"
    },
    {
      "short": "-c",
      "long": "--changes",
      "arg": null,
      "desc": "report only changes"
    }
  ],
  "seeAlso": [
    "chown",
    "ls"
  ]
}
---

# NAME

chmod — change mode

# SYNOPSIS

`chmod [-R] [-v] [-c] MODE FILE...`

# DESCRIPTION

MODE is octal (up to four digits, the first `0` or `1` for sticky) or symbolic `[ugoa]*[+-=][rwxXt]*` clauses separated by commas. Setuid and setgid are not supported.

# OPTIONS

- `-R, --recursive` — change files and directories recursively in one transaction
- `-v, --verbose` — report every file
- `-c, --changes` — report only changes

# EXIT STATUS

0 on success; 1 on failure or an invalid mode; 2 on a usage error.

# ERRORS

- `chmod: changing permissions of 'x': Operation not permitted` (EPERM)
- `chmod: invalid mode: 'u+z'` (EINVAL)
- ENOENT, EACCES, EBUSY, EIO (— rolled back)

# EXAMPLES

    chmod -R o-w ~/reports
    chmod 600 secret.txt

# SEE ALSO

chown(1), ls(1)
