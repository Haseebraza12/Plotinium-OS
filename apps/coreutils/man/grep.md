---json
{
  "name": "grep",
  "section": 1,
  "summary": "search text",
  "synopsis": "grep [-i] [-v] [-n] [-c] [-l] [-r] [-F] [-w] [-H | -h] [-e PATTERN]... [PATTERN] [FILE...]",
  "owner": "R2",
  "requirements": [
    "SYS-02"
  ],
  "flags": [
    {
      "short": "-i",
      "long": "--ignore-case",
      "arg": null,
      "desc": "ignore case"
    },
    {
      "short": "-v",
      "long": "--invert-match",
      "arg": null,
      "desc": "select non-matching lines"
    },
    {
      "short": "-n",
      "long": "--line-number",
      "arg": null,
      "desc": "prefix each line with its number"
    },
    {
      "short": "-c",
      "long": "--count",
      "arg": null,
      "desc": "print a count of matching lines per file"
    },
    {
      "short": "-l",
      "long": "--files-with-matches",
      "arg": null,
      "desc": "print only the names of matching files"
    },
    {
      "short": "-r",
      "long": "--recursive",
      "arg": null,
      "desc": "search directories recursively, skipping binary files"
    },
    {
      "short": "-F",
      "long": "--fixed-strings",
      "arg": null,
      "desc": "PATTERN is a fixed string"
    },
    {
      "short": "-w",
      "long": "--word-regexp",
      "arg": null,
      "desc": "match whole words only"
    },
    {
      "short": "-H",
      "long": "--with-filename",
      "arg": null,
      "desc": "always print the file name"
    },
    {
      "short": "-h",
      "long": "--no-filename",
      "arg": null,
      "desc": "never print the file name"
    },
    {
      "short": "-e",
      "long": "--regexp",
      "arg": "PATTERN",
      "desc": "use PATTERN; may be given several times"
    }
  ],
  "seeAlso": [
    "find",
    "cat"
  ]
}
---

# NAME

grep — search text

# SYNOPSIS

`grep [-i] [-v] [-n] [-c] [-l] [-r] [-F] [-w] [-H | -h] [-e PATTERN]... [PATTERN] [FILE...]`

# DESCRIPTION

Searches each FILE (stdin when none) for lines matching an ECMAScript regular expression (with the `u` flag). Output is `path:line` when several files or `-r` are used, `path:N:line` with `-n`.

# OPTIONS

- `-i, --ignore-case` — ignore case
- `-v, --invert-match` — select non-matching lines
- `-n, --line-number` — prefix each line with its number
- `-c, --count` — print a count of matching lines per file
- `-l, --files-with-matches` — print only the names of matching files
- `-r, --recursive` — search directories recursively, skipping binary files
- `-F, --fixed-strings` — PATTERN is a fixed string
- `-w, --word-regexp` — match whole words only
- `-H, --with-filename` — always print the file name
- `-h, --no-filename` — never print the file name
- `-e, --regexp PATTERN` — use PATTERN; may be given several times

# EXIT STATUS

0 if a line was selected; 1 if none; 2 on any error.

# ERRORS

- `grep: x: No such file or directory`
- `grep: invalid regular expression: …`

# EXAMPLES

    grep -rn "memory leak" ~/notes

# SEE ALSO

find(1), cat(1)
