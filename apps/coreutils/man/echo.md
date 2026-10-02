---json
{
  "name": "echo",
  "section": 1,
  "summary": "print arguments",
  "synopsis": "echo [-n] [-e] [ARG...]",
  "owner": "R3",
  "requirements": [
    "SYS-02"
  ],
  "flags": [
    {
      "short": "-n",
      "long": null,
      "arg": null,
      "desc": "do not print the trailing newline"
    },
    {
      "short": "-e",
      "long": null,
      "arg": null,
      "desc": "interpret \\n \\t \\\\ \\a \\e and \\0NNN escapes"
    }
  ],
  "seeAlso": [
    "cat"
  ]
}
---

# NAME

echo — print arguments

# SYNOPSIS

`echo [-n] [-e] [ARG...]`

# DESCRIPTION

Prints the arguments joined by single spaces, then a newline.

# OPTIONS

- `-n` — do not print the trailing newline
- `-e` — interpret \n \t \\ \a \e and \0NNN escapes

# EXIT STATUS

0 on success; 1 on a write error.

# ERRORS

- `echo: write error: Bad file descriptor` (EBADF)

# EXAMPLES

    echo "home is $HOME" > where.txt

# SEE ALSO

cat(1)
