---json
{
  "name": "idx50k",
  "section": 1,
  "summary": "write a 50 KB text file for the index freshness demo",
  "synopsis": "idx50k [-s SIZE] [--seed S] [-w] [-t SECS] [-q TEXT] [PATH]",
  "owner": "R4",
  "requirements": [
    "RAG-02",
    "RAG-06"
  ],
  "flags": [
    {
      "short": "-s",
      "long": "--size",
      "arg": "SIZE",
      "desc": "file size with K or M (binary; default 50K = 51,200 bytes)"
    },
    {
      "short": null,
      "long": "--seed",
      "arg": "S",
      "desc": "seed of the text and of its marker; change it to modify the file"
    },
    {
      "short": "-w",
      "long": "--wait",
      "arg": null,
      "desc": "search for the file until semsearch finds it, and time it"
    },
    {
      "short": "-t",
      "long": "--timeout",
      "arg": "SECS",
      "desc": "with --wait, give up after SECS seconds (default 60)"
    },
    {
      "short": "-q",
      "long": "--query",
      "arg": "TEXT",
      "desc": "with --wait, search for TEXT instead of the file's marker"
    }
  ],
  "seeAlso": [
    "semsearch",
    "ai",
    "mv",
    "rm"
  ]
}
---

# NAME

idx50k — write a 50 KB text file for the index freshness demo

# SYNOPSIS

`idx50k [-s SIZE] [--seed S] [-w] [-t SECS] [-q TEXT] [PATH]`

# DESCRIPTION

Writes the file of the RAG-02 freshness demonstration: a Markdown text of exactly SIZE bytes (default 50K, 51,200 bytes) in one `writeFile` call. PATH defaults to `~/idx50k.md`. The text is field notes on the migration of Arctic terns, generated from the seed so that the same seed always gives the same bytes. It carries a marker, a made-up word such as `quorvelline-7c1d` that appears nowhere else, in its first and last paragraphs.

It prints the size, the file's version and the write time (`idx50k: wrote 51,200 bytes to /home/alice/idx50k.md (version 1) at 14:03:12.418; marker quorvelline-7c1d`). Run it again with another `--seed` to modify the file (new text, new marker); rename and delete it with `mv` and `rm`.

With `--wait` it then runs `semsearch` for the marker (or for `--query TEXT`) once per second until a result is the file itself (compared by inode), and prints the time since the write: `idx50k: found by semsearch after 12.4 s (mode semantic, score 0.83; RAG-02 budget 30 s: met)`. When the model is unavailable semsearch falls back to keyword search (RAG-06); the mode is printed.

# OPTIONS

- `-s, --size SIZE` — file size with K or M (binary; default 50K = 51,200 bytes)
- `--seed S` — seed of the text and of its marker; change it to modify the file
- `-w, --wait` — search for the file until semsearch finds it, and time it
- `-t, --timeout SECS` — with --wait, give up after SECS seconds (default 60)
- `-q, --query TEXT` — with --wait, search for TEXT instead of the file's marker

# EXIT STATUS

0 when the file was written (and, with `--wait`, found); 1 when the write failed or the file was not found before the timeout; 2 on a usage error.

# ERRORS

- `idx50k: cannot write '/home/alice/idx50k.md': Disk quota exceeded`
- `idx50k: not found by semsearch after 60 s (RAG-02 budget 30 s: missed)`
- `idx50k: semsearch unavailable: AI service unavailable`

# EXAMPLES

    idx50k --wait
    idx50k --seed 2 --wait ~/idx50k.md
    idx50k -s 100K ~/notes/big.md

# SEE ALSO

semsearch(1), ai(1), mv(1), rm(1)
