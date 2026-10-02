---json
{
  "name": "find",
  "section": 1,
  "summary": "search a directory tree",
  "synopsis": "find [PATH...] [EXPRESSION]",
  "owner": "R2",
  "requirements": [
    "SYS-02",
    "VFS-07"
  ],
  "flags": [],
  "seeAlso": [
    "ls",
    "tree",
    "grep"
  ]
}
---

# NAME

find — search a directory tree

# SYNOPSIS

`find [PATH...] [EXPRESSION]`

# DESCRIPTION

Walks each start PATH (default `.`) in pre-order and prints one path per line. Tests: `-name GLOB`, `-iname GLOB`, `-type f|d|l`, `-mtime [+|-]N`, `-mmin [+|-]N`, `-size [+|-]N[c|k|M|G]`, `-user NAME`, `-empty`, `-newer FILE`; options `-maxdepth N`, `-mindepth N`; operators `!`, `-not`, `-a`, `-o` and `\(` `\)`; action `-print` (default).

# OPTIONS

None.

# EXIT STATUS

0 on success; 1 if a path failed; 2 on an invalid expression.

# ERRORS

- `find: 'x': Permission denied` (continues)
- `find: 'x': No such file or directory`
- `find: invalid expression near '-mtme'`

# EXAMPLES

    find ~ -type f -name "*.pdf" -mtime -7

# SEE ALSO

ls(1), tree(1), grep(1)
