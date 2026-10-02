---json
{
  "name": "help",
  "section": 1,
  "summary": "shell help",
  "synopsis": "help [NAME]",
  "owner": "R3",
  "requirements": [
    "SYS-02",
    "WM-07"
  ],
  "flags": [],
  "seeAlso": [
    "man"
  ]
}
---

# NAME

help — shell help

# SYNOPSIS

`help [NAME]`

# DESCRIPTION

Prints the banner, the builtins and command groups, the syntax summary and the keys. `help NAME` prints a builtin's synopsis, or points to `man NAME` for programs.

# OPTIONS

None.

# EXIT STATUS

0 on success; 1 for an unknown NAME.

# ERRORS

- `help: no help topics match 'x'`

# EXAMPLES

    help cd

# SEE ALSO

man(1)
