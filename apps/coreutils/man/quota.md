---json
{
  "name": "quota",
  "section": 1,
  "summary": "show quotas",
  "synopsis": "quota [-h] [-u USER]",
  "owner": "R2",
  "requirements": [
    "SYS-02",
    "VFS-06"
  ],
  "flags": [
    {
      "short": "-h",
      "long": "--human-readable",
      "arg": null,
      "desc": "print sizes like 18.2M"
    },
    {
      "short": "-u",
      "long": "--user",
      "arg": "USER",
      "desc": "show USER's quota (root only)"
    }
  ],
  "seeAlso": [
    "df",
    "du"
  ]
}
---

# NAME

quota — show quotas

# SYNOPSIS

`quota [-h] [-u USER]`

# DESCRIPTION

Prints the bytes and inodes used against the quota and where the numbers came from (server or local mirror).

# OPTIONS

- `-h, --human-readable` — print sizes like 18.2M
- `-u, --user USER` — show USER's quota (root only)

# EXIT STATUS

0 on success; 1 on failure; 2 on a usage error.

# ERRORS

- `quota: permission denied for other users` (EPERM)
- `quota: no such user 'bob2'`

# EXAMPLES

    quota -h

# SEE ALSO

df(1), du(1)
