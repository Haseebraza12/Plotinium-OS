---json
{
  "name": "semsearch",
  "section": 1,
  "summary": "semantic file search",
  "synopsis": "semsearch [-k N] [-l] [--json] [--chunks] [--keyword] [--dir PATH] QUERY",
  "owner": "R4",
  "requirements": [
    "SYS-02",
    "RAG-03",
    "RAG-05",
    "RAG-06"
  ],
  "flags": [
    {
      "short": "-k",
      "long": null,
      "arg": "N",
      "desc": "number of results (default 5)"
    },
    {
      "short": "-l",
      "long": null,
      "arg": null,
      "desc": "print paths only"
    },
    {
      "short": null,
      "long": "--json",
      "arg": null,
      "desc": "print the raw result"
    },
    {
      "short": null,
      "long": "--chunks",
      "arg": null,
      "desc": "return every matching chunk, not one per file"
    },
    {
      "short": null,
      "long": "--keyword",
      "arg": null,
      "desc": "keyword search only"
    },
    {
      "short": null,
      "long": "--dir",
      "arg": "PATH",
      "desc": "search only under PATH"
    }
  ],
  "seeAlso": [
    "grep",
    "find"
  ]
}
---

# NAME

semsearch — semantic file search

# SYNOPSIS

`semsearch [-k N] [-l] [--json] [--chunks] [--keyword] [--dir PATH] QUERY`

# DESCRIPTION

Prints `path:lineStart-lineEnd  score  snippet` per result; notices go to stderr.

# OPTIONS

- `-k N` — number of results (default 5)
- `-l` — print paths only
- `--json` — print the raw result
- `--chunks` — return every matching chunk, not one per file
- `--keyword` — keyword search only
- `--dir PATH` — search only under PATH

# EXIT STATUS

0 results found; 1 none; 2 error.

# ERRORS

- as in the RAG specification

# EXAMPLES

    semsearch "how does LRU eviction work"

# SEE ALSO

grep(1), find(1)
