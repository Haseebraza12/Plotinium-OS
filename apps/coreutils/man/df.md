---json
{
  "name": "df",
  "section": 1,
  "summary": "usage and quota of the file system",
  "synopsis": "df [-h] [-i] [PATH]",
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
      "desc": "print sizes like 18M and 1.9G"
    },
    {
      "short": "-i",
      "long": "--inodes",
      "arg": null,
      "desc": "show the inode quota instead of bytes"
    }
  ],
  "seeAlso": [
    "du",
    "quota"
  ]
}
---

# NAME

df — usage and quota of the file system

# SYNOPSIS

`df [-h] [-i] [PATH]`

# DESCRIPTION

Row 1 is the caller's quota (`plotinium (quota)`, or `plotinium (quota, offline)` from the local mirror); row 2 is this device's browser storage.

# OPTIONS

- `-h, --human-readable` — print sizes like 18M and 1.9G
- `-i, --inodes` — show the inode quota instead of bytes

# EXIT STATUS

0 on success; 1 on failure; 2 on a usage error.

# ERRORS

- ENOENT for PATH

# EXAMPLES

    df -h

# SEE ALSO

du(1), quota(1)
