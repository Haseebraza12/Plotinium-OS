---json
{
  "name": "man",
  "section": 1,
  "summary": "manual pages",
  "synopsis": "man [SECTION] NAME | man -k KEYWORD | man -f NAME",
  "owner": "R3",
  "requirements": [
    "SYS-02",
    "SHL-12"
  ],
  "flags": [
    {
      "short": "-k",
      "long": "--apropos",
      "arg": null,
      "desc": "search names and summaries for KEYWORD"
    },
    {
      "short": "-f",
      "long": "--whatis",
      "arg": null,
      "desc": "print the one-line summary of NAME"
    }
  ],
  "seeAlso": [
    "help"
  ]
}
---

# NAME

man — manual pages

# SYNOPSIS

`man [SECTION] NAME | man -k KEYWORD | man -f NAME`

# DESCRIPTION

Renders the manual page of NAME from `/usr/share/man`.

# OPTIONS

- `-k, --apropos` — search names and summaries for KEYWORD
- `-f, --whatis` — print the one-line summary of NAME

# EXIT STATUS

0 on success; 1 when there is no entry; 2 on a usage error.

# ERRORS

- `man: no manual entry for foo`

# EXAMPLES

    man 2 unlink
    man -k file

# SEE ALSO

help(1)
