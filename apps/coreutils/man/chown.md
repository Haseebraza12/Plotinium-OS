---json
{
  "name": "chown",
  "section": 1,
  "summary": "change owner and group",
  "synopsis": "chown [-R] [-v] [-c] OWNER[:GROUP] FILE...",
  "owner": "R2",
  "requirements": [
    "SYS-02",
    "VFS-04",
    "VFS-06",
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
    "chmod",
    "id"
  ]
}
---

# NAME

chown — change owner and group

# SYNOPSIS

`chown [-R] [-v] [-c] OWNER[:GROUP] FILE...`

# DESCRIPTION

Root only. OWNER and GROUP are names or numeric ids; `:GROUP` changes only the group. Quota usage moves to the new owner in the same transaction.

# OPTIONS

- `-R, --recursive` — change files and directories recursively in one transaction
- `-v, --verbose` — report every file
- `-c, --changes` — report only changes

# EXIT STATUS

0 on success; 1 on failure; 2 on a usage error.

# ERRORS

- `chown: changing ownership of 'x': Operation not permitted` (EPERM)
- `chown: invalid user: 'bob2'` (EINVAL)
- ENOENT, EDQUOT, EBUSY, EIO

# EXAMPLES

    su -c 'chown -R bob:team /home/shared/plan.md'

# SEE ALSO

chmod(1), id(1)
