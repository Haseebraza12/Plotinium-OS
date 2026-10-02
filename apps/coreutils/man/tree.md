---json
{
  "name": "tree",
  "section": 1,
  "summary": "show a directory tree",
  "synopsis": "tree [-a] [-d] [-L LEVEL] [--noreport] [PATH]",
  "owner": "R2",
  "requirements": [
    "SYS-02",
    "VFS-07",
    "VFS-08"
  ],
  "flags": [
    {
      "short": "-a",
      "long": null,
      "arg": null,
      "desc": "include hidden names"
    },
    {
      "short": "-d",
      "long": null,
      "arg": null,
      "desc": "list directories only"
    },
    {
      "short": "-L",
      "long": null,
      "arg": "LEVEL",
      "desc": "descend at most LEVEL directories"
    },
    {
      "short": null,
      "long": "--noreport",
      "arg": null,
      "desc": "omit the directory and file count"
    }
  ],
  "seeAlso": [
    "ls",
    "find"
  ]
}
---

# NAME

tree — show a directory tree

# SYNOPSIS

`tree [-a] [-d] [-L LEVEL] [--noreport] [PATH]`

# DESCRIPTION

Prints PATH (default `.`) and its entries drawn with `├── `, `└── ` and `│   ` in code-point order, then `N directories, M files`.

# OPTIONS

- `-a` — include hidden names
- `-d` — list directories only
- `-L LEVEL` — descend at most LEVEL directories
- `--noreport` — omit the directory and file count

# EXIT STATUS

0 on success; 1 if the root failed; 2 on a usage error.

# ERRORS

- ENOENT, ENOTDIR, EACCES on the root
- an unreadable directory is shown as `name  [error opening dir]`

# EXAMPLES

    tree -L 2 ~/projects

# SEE ALSO

ls(1), find(1)
