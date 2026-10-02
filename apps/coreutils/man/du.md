---json
{
  "name": "du",
  "section": 1,
  "summary": "disk usage",
  "synopsis": "du [-s] [-h] [-a] [-c] [-d N] [PATH...]",
  "owner": "R2",
  "requirements": [
    "SYS-02",
    "VFS-06"
  ],
  "flags": [
    {
      "short": "-s",
      "long": "--summarize",
      "arg": null,
      "desc": "one total per operand"
    },
    {
      "short": "-h",
      "long": "--human-readable",
      "arg": null,
      "desc": "print sizes like 4.0K and 18M"
    },
    {
      "short": "-a",
      "long": "--all",
      "arg": null,
      "desc": "include files"
    },
    {
      "short": "-c",
      "long": "--total",
      "arg": null,
      "desc": "add a total line"
    },
    {
      "short": "-d",
      "long": "--max-depth",
      "arg": "N",
      "desc": "print totals at most N levels deep"
    }
  ],
  "seeAlso": [
    "df",
    "quota"
  ]
}
---

# NAME

du — disk usage

# SYNOPSIS

`du [-s] [-h] [-a] [-c] [-d N] [PATH...]`

# DESCRIPTION

Prints `<size>\t<path>` in post-order. The size is the sum of file sizes (the bytes the quota counts), in KiB rounded up unless `-h`.

# OPTIONS

- `-s, --summarize` — one total per operand
- `-h, --human-readable` — print sizes like 4.0K and 18M
- `-a, --all` — include files
- `-c, --total` — add a total line
- `-d, --max-depth N` — print totals at most N levels deep

# EXIT STATUS

0 on success; 1 if any error; 2 on a usage error.

# ERRORS

- `du: cannot read directory 'x': Permission denied` (continues)
- ENOENT

# EXAMPLES

    du -sh ~

# SEE ALSO

df(1), quota(1)
