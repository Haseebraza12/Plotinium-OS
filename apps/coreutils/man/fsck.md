---json
{
  "name": "fsck",
  "section": 1,
  "summary": "check and repair the file system",
  "synopsis": "fsck [-n | -y] [--checksum] [--server] [PATH]",
  "owner": "R2",
  "requirements": [
    "SYS-02",
    "VFS-11",
    "DB-02"
  ],
  "flags": [
    {
      "short": "-n",
      "long": null,
      "arg": null,
      "desc": "check only (default)"
    },
    {
      "short": "-y",
      "long": null,
      "arg": null,
      "desc": "repair in one transaction (root only)"
    },
    {
      "short": null,
      "long": "--checksum",
      "arg": null,
      "desc": "print the deterministic tree checksum"
    },
    {
      "short": null,
      "long": "--server",
      "arg": null,
      "desc": "run the server-side integrity probes (root, online)"
    }
  ],
  "seeAlso": [
    "df"
  ]
}
---

# NAME

fsck — check and repair the file system

# SYNOPSIS

`fsck [-n | -y] [--checksum] [--server] [PATH]`

# DESCRIPTION

Checks reachability, link counts, directory cycles, dangling entries and quota totals under PATH (default `/`).

# OPTIONS

- `-n` — check only (default)
- `-y` — repair in one transaction (root only)
- `--checksum` — print the deterministic tree checksum
- `--server` — run the server-side integrity probes (root, online)

# EXIT STATUS

0 clean or repaired; 1 problems left; 2 usage or error.

# ERRORS

- `fsck: repair requires root` (EPERM)
- `fsck: --server needs a connection` (EAGAIN)

# EXAMPLES

    fsck --checksum ~/fixtures/tree1000

# SEE ALSO

df(1)
