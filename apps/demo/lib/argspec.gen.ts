/**
 * GENERATED from apps/demo/man/*.md front matter (the single source of flags, SHL-12) by
 * apps/demo/scripts/gen-argspec.mjs. Do not edit by hand.
 */
import type { ArgSpecTable } from '../../coreutils/lib/argspec.ts';

export const DEMO_ARGSPEC = {
  "burn": {
    "synopsis": "burn [--ms N] [--step-us S] [-t T] [--priority P] [-n N] [--exclusive] [-p SECS] [--json]",
    "summary": "CPU-bound stress program",
    "flags": [
      {
        "short": null,
        "long": "--ms",
        "arg": "N",
        "optionalArg": false,
        "desc": "stop after N ms of CPU time (default: run until killed)"
      },
      {
        "short": null,
        "long": "--step-us",
        "arg": "S",
        "optionalArg": false,
        "desc": "compute S microseconds between yield points (default 100)"
      },
      {
        "short": "-t",
        "long": "--threads",
        "arg": "T",
        "optionalArg": false,
        "desc": "run T burn processes side by side (default 1)"
      },
      {
        "short": null,
        "long": "--priority",
        "arg": "P",
        "optionalArg": false,
        "desc": "static priority 0..39; below 20 needs root or the test profile"
      },
      {
        "short": "-n",
        "long": "--nice",
        "arg": "N",
        "optionalArg": false,
        "desc": "nice value -20..19; a negative value needs root"
      },
      {
        "short": null,
        "long": "--exclusive",
        "arg": null,
        "optionalArg": false,
        "desc": "give every thread an executor of its own (root or the test profile)"
      },
      {
        "short": "-p",
        "long": "--progress",
        "arg": "SECS",
        "optionalArg": false,
        "desc": "print a progress line every SECS seconds"
      },
      {
        "short": null,
        "long": "--json",
        "arg": null,
        "optionalArg": false,
        "desc": "print the final report as one JSON object"
      }
    ]
  },
  "idx50k": {
    "synopsis": "idx50k [-s SIZE] [--seed S] [-w] [-t SECS] [-q TEXT] [PATH]",
    "summary": "write a 50 KB text file for the index freshness demo",
    "flags": [
      {
        "short": "-s",
        "long": "--size",
        "arg": "SIZE",
        "optionalArg": false,
        "desc": "file size with K or M (binary; default 50K = 51,200 bytes)"
      },
      {
        "short": null,
        "long": "--seed",
        "arg": "S",
        "optionalArg": false,
        "desc": "seed of the text and of its marker; change it to modify the file"
      },
      {
        "short": "-w",
        "long": "--wait",
        "arg": null,
        "optionalArg": false,
        "desc": "search for the file until semsearch finds it, and time it"
      },
      {
        "short": "-t",
        "long": "--timeout",
        "arg": "SECS",
        "optionalArg": false,
        "desc": "with --wait, give up after SECS seconds (default 60)"
      },
      {
        "short": "-q",
        "long": "--query",
        "arg": "TEXT",
        "optionalArg": false,
        "desc": "with --wait, search for TEXT instead of the file's marker"
      }
    ]
  },
  "lockdemo": {
    "synopsis": "lockdemo [-x | -s] [-w] [-t SECS] [--hold SECS] [-i SECS] PATH",
    "summary": "take a file lease and hold it",
    "flags": [
      {
        "short": "-x",
        "long": "--exclusive",
        "arg": null,
        "optionalArg": false,
        "desc": "take an exclusive (X) lease (default)"
      },
      {
        "short": "-s",
        "long": "--shared",
        "arg": null,
        "optionalArg": false,
        "desc": "take a shared (S) lease"
      },
      {
        "short": "-w",
        "long": "--wait",
        "arg": null,
        "optionalArg": false,
        "desc": "wait while another holder has the lease"
      },
      {
        "short": "-t",
        "long": "--timeout",
        "arg": "SECS",
        "optionalArg": false,
        "desc": "with --wait, give up after SECS seconds (1..600)"
      },
      {
        "short": null,
        "long": "--hold",
        "arg": "SECS",
        "optionalArg": false,
        "desc": "release the lease after SECS seconds (default: until interrupted)"
      },
      {
        "short": "-i",
        "long": "--interval",
        "arg": "SECS",
        "optionalArg": false,
        "desc": "print the lease status every SECS seconds; 0 = quiet (default 5)"
      }
    ]
  },
  "memhog": {
    "synopsis": "memhog --total SIZE [--procs N] [--touch random|seq] [--rate PAGES_PER_S] [--write-ratio R] [--compressible] [--hold SECS] [--seed S] [--report SECS]",
    "summary": "memory stress program with verified paging",
    "flags": [
      {
        "short": null,
        "long": "--total",
        "arg": "SIZE",
        "optionalArg": false,
        "desc": "bytes to allocate across all children, with K, M or G (binary)"
      },
      {
        "short": null,
        "long": "--procs",
        "arg": "N",
        "optionalArg": false,
        "desc": "number of child processes sharing SIZE (default 1)"
      },
      {
        "short": null,
        "long": "--touch",
        "arg": "ORDER",
        "optionalArg": false,
        "desc": "page touch order, random or seq (default random)"
      },
      {
        "short": null,
        "long": "--rate",
        "arg": "PAGES_PER_S",
        "optionalArg": false,
        "desc": "pages each child touches per second; 0 = no pause (default 50)"
      },
      {
        "short": null,
        "long": "--write-ratio",
        "arg": "R",
        "optionalArg": false,
        "desc": "fraction 0..1 of touches that rewrite the page (default 0.25)"
      },
      {
        "short": null,
        "long": "--compressible",
        "arg": null,
        "optionalArg": false,
        "desc": "fill pages with a repeating text pattern instead of noise"
      },
      {
        "short": null,
        "long": "--hold",
        "arg": "SECS",
        "optionalArg": false,
        "desc": "exit after SECS seconds of touching (default: until killed)"
      },
      {
        "short": null,
        "long": "--seed",
        "arg": "S",
        "optionalArg": false,
        "desc": "seed of the fill pattern and the touch order (default 42)"
      },
      {
        "short": null,
        "long": "--report",
        "arg": "SECS",
        "optionalArg": false,
        "desc": "print the status line every SECS seconds (default 5)"
      },
      {
        "short": null,
        "long": "--child",
        "arg": "INDEX",
        "optionalArg": false,
        "desc": "internal: run as child INDEX of a memhog parent"
      }
    ]
  },
  "mktree": {
    "synopsis": "mktree [-n N] [--seed S] [-f] [-q] [--json] [DIR]",
    "summary": "build a seeded fixture tree",
    "flags": [
      {
        "short": "-n",
        "long": "--nodes",
        "arg": "N",
        "optionalArg": false,
        "desc": "nodes in the tree, the top directory included (default 1000)"
      },
      {
        "short": null,
        "long": "--seed",
        "arg": "S",
        "optionalArg": false,
        "desc": "seed of the tree shape and file sizes (default 42)"
      },
      {
        "short": "-f",
        "long": "--force",
        "arg": null,
        "optionalArg": false,
        "desc": "remove an existing DIR first"
      },
      {
        "short": "-q",
        "long": "--quiet",
        "arg": null,
        "optionalArg": false,
        "desc": "print nothing on success"
      },
      {
        "short": null,
        "long": "--json",
        "arg": null,
        "optionalArg": false,
        "desc": "print the summary as one JSON object"
      }
    ]
  }
} as const satisfies ArgSpecTable;
