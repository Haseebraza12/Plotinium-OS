---json
{
  "name": "cat",
  "section": 1,
  "summary": "concatenate files",
  "synopsis": "cat [-n] [-v] [FILE | -]...",
  "owner": "R2",
  "requirements": [
    "SYS-02",
    "VFS-07"
  ],
  "flags": [
    {
      "short": "-n",
      "long": "--number",
      "arg": null,
      "desc": "number output lines"
    },
    {
      "short": "-v",
      "long": "--show-nonprinting",
      "arg": null,
      "desc": "show control characters as ^X and high bytes as M-x"
    }
  ],
  "seeAlso": [
    "grep"
  ]
}
---

# NAME

cat — concatenate files

# SYNOPSIS

`cat [-n] [-v] [FILE | -]...`

# DESCRIPTION

Reads each FILE (stdin for `-` or no operand) in 64 KiB chunks and writes it to stdout.

# OPTIONS

- `-n, --number` — number output lines
- `-v, --show-nonprinting` — show control characters as ^X and high bytes as M-x

# EXIT STATUS

0 on success; 1 if any operand failed; 141 when the reader of a pipe went away.

# ERRORS

- `cat: x: Is a directory` (EISDIR)
- ENOENT, EACCES

# EXAMPLES

    cat notes.md | grep -n LRU

# SEE ALSO

grep(1)
