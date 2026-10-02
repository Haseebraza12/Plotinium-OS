---json
{
  "name": "mktree",
  "section": 1,
  "summary": "build a seeded fixture tree",
  "synopsis": "mktree [-n N] [--seed S] [-f] [-q] [--json] [DIR]",
  "owner": "R2",
  "requirements": [
    "DB-02",
    "VFS-07"
  ],
  "flags": [
    {
      "short": "-n",
      "long": "--nodes",
      "arg": "N",
      "desc": "nodes in the tree, the top directory included (default 1000)"
    },
    {
      "short": null,
      "long": "--seed",
      "arg": "S",
      "desc": "seed of the tree shape and file sizes (default 42)"
    },
    {
      "short": "-f",
      "long": "--force",
      "arg": null,
      "desc": "remove an existing DIR first"
    },
    {
      "short": "-q",
      "long": "--quiet",
      "arg": null,
      "desc": "print nothing on success"
    },
    {
      "short": null,
      "long": "--json",
      "arg": null,
      "desc": "print the summary as one JSON object"
    }
  ],
  "seeAlso": [
    "tree",
    "fsck",
    "rm",
    "cp",
    "du"
  ]
}
---

# NAME

mktree — build a seeded fixture tree

# SYNOPSIS

`mktree [-n N] [--seed S] [-f] [-q] [--json] [DIR]`

# DESCRIPTION

Builds the fixture tree of the fault-injection demonstrations (DB-02, Demo Day item 6: `fsck --checksum ~/fixtures/tree1000`, then `rm -r ~/fixtures/tree1000` with an injected fault) through ordinary system calls: one `mkdir` per directory and one `writeFile` per file, in creation order. DIR defaults to `~/fixtures/tree1000` (or `~/fixtures/treeN` with `-n N`); its parent directories are created when missing.

The shape is the one of `tests/fixtures/trees.ts`: the top directory, a spine of 7 nested directories `s1`…`s7` (depth ≥ 6), then directories `d<n>` (about one in five) and files `f<n>.txt` of 0 to 4,096 bytes attached under random existing directories, drawn from mulberry32 with the seed. Directories get mode 755 and files 644 (before the umask); a file's content is its path relative to the fixture root, repeated. With the default seed and 1,000 nodes the tree is node-for-node the `tree1000` that the server seed and the fault-injection oracle use, so client and server checksums are comparable.

On a terminal a progress counter is shown on stderr. At the end mktree prints `mktree: created DIR: 1,000 nodes (N directories, M files, B bytes), depth D, manifest sha256:… in T s`. The manifest digest is the SHA-256 of one line `<type> <mode> <size> <path>` per node, so two seedings can be compared without reading the files back.

# OPTIONS

- `-n, --nodes N` — nodes in the tree, the top directory included (default 1000)
- `--seed S` — seed of the tree shape and file sizes (default 42)
- `-f, --force` — remove an existing DIR first
- `-q, --quiet` — print nothing on success
- `--json` — print the summary as one JSON object

# EXIT STATUS

0 when every node was created; 1 when DIR exists (without `-f`) or a system call failed; 2 on a usage error.

# ERRORS

- `mktree: cannot create '/home/alice/fixtures/tree1000': File exists (use -f to replace it)`
- `mktree: cannot create '/home/alice/fixtures/tree1000/s1/f12.txt': Disk quota exceeded (412 of 1,000 nodes created)`

# EXAMPLES

    mktree
    mktree -f ~/fixtures/tree1000
    mktree -n 500 --seed 7 /tmp/tree500

# SEE ALSO

tree(1), fsck(1), rm(1), cp(1), du(1)
