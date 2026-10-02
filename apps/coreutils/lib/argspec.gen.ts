/**
 * GENERATED from apps/coreutils/man/*.md front matter (the single source of flags, SHL-12) by
 * apps/coreutils/scripts/gen-argspec.mjs. Do not edit by hand.
 * TODO(R3): tools/manpages.ts takes over generation in CI (shell spec §3.12).
 */
import type { ArgSpecTable } from './argspec.ts';

export const ARGSPEC = {
  "ai": {
    "synopsis": "ai [-n | --dry-run] [--json] \"INSTRUCTION\" | ai log [-n N] [--json] [--all] [TXN] | ai undo TXN | ai status",
    "summary": "agentic shell",
    "flags": [
      {
        "short": "-n",
        "long": null,
        "arg": "N",
        "optionalArg": false,
        "desc": "with log: show the last N records; before an instruction: dry run only"
      },
      {
        "short": null,
        "long": "--dry-run",
        "arg": null,
        "optionalArg": false,
        "desc": "plan and dry run, then stop without executing"
      },
      {
        "short": null,
        "long": "--json",
        "arg": null,
        "optionalArg": false,
        "desc": "machine-readable output"
      },
      {
        "short": null,
        "long": "--all",
        "arg": null,
        "optionalArg": false,
        "desc": "with log: every user's records (root only)"
      }
    ]
  },
  "bootlog": {
    "synopsis": "bootlog [--critical-path] [--services] [--list] [--boot N] [-v] [--json]",
    "summary": "boot timings",
    "flags": [
      {
        "short": null,
        "long": "--critical-path",
        "arg": null,
        "optionalArg": false,
        "desc": "print the chain of services that determined the boot time"
      },
      {
        "short": null,
        "long": "--services",
        "arg": null,
        "optionalArg": false,
        "desc": "print one row per service"
      },
      {
        "short": null,
        "long": "--list",
        "arg": null,
        "optionalArg": false,
        "desc": "list the stored boots"
      },
      {
        "short": null,
        "long": "--boot",
        "arg": "N",
        "optionalArg": false,
        "desc": "select a boot (current or previous)"
      },
      {
        "short": "-v",
        "long": "--verbose",
        "arg": null,
        "optionalArg": false,
        "desc": "print the verbose log lines"
      },
      {
        "short": null,
        "long": "--json",
        "arg": null,
        "optionalArg": false,
        "desc": "print the raw record"
      }
    ]
  },
  "cat": {
    "synopsis": "cat [-n] [-v] [FILE | -]...",
    "summary": "concatenate files",
    "flags": [
      {
        "short": "-n",
        "long": "--number",
        "arg": null,
        "optionalArg": false,
        "desc": "number output lines"
      },
      {
        "short": "-v",
        "long": "--show-nonprinting",
        "arg": null,
        "optionalArg": false,
        "desc": "show control characters as ^X and high bytes as M-x"
      }
    ]
  },
  "chmod": {
    "synopsis": "chmod [-R] [-v] [-c] MODE FILE...",
    "summary": "change mode",
    "flags": [
      {
        "short": "-R",
        "long": "--recursive",
        "arg": null,
        "optionalArg": false,
        "desc": "change files and directories recursively in one transaction"
      },
      {
        "short": "-v",
        "long": "--verbose",
        "arg": null,
        "optionalArg": false,
        "desc": "report every file"
      },
      {
        "short": "-c",
        "long": "--changes",
        "arg": null,
        "optionalArg": false,
        "desc": "report only changes"
      }
    ]
  },
  "chown": {
    "synopsis": "chown [-R] [-v] [-c] OWNER[:GROUP] FILE...",
    "summary": "change owner and group",
    "flags": [
      {
        "short": "-R",
        "long": "--recursive",
        "arg": null,
        "optionalArg": false,
        "desc": "change files and directories recursively in one transaction"
      },
      {
        "short": "-v",
        "long": "--verbose",
        "arg": null,
        "optionalArg": false,
        "desc": "report every file"
      },
      {
        "short": "-c",
        "long": "--changes",
        "arg": null,
        "optionalArg": false,
        "desc": "report only changes"
      }
    ]
  },
  "cp": {
    "synopsis": "cp [-r | -R] [-n] [-f] [-p] [-v] SRC... DEST",
    "summary": "copy files and directories",
    "flags": [
      {
        "short": "-r",
        "long": "--recursive",
        "arg": null,
        "optionalArg": false,
        "desc": "copy directories recursively (symlinks copied as links)"
      },
      {
        "short": "-R",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "same as -r"
      },
      {
        "short": "-n",
        "long": "--no-clobber",
        "arg": null,
        "optionalArg": false,
        "desc": "never overwrite an existing file"
      },
      {
        "short": "-f",
        "long": "--force",
        "arg": null,
        "optionalArg": false,
        "desc": "replace a destination that cannot be opened for writing"
      },
      {
        "short": "-p",
        "long": "--preserve",
        "arg": null,
        "optionalArg": false,
        "desc": "keep mode and times (and owner, for root)"
      },
      {
        "short": "-v",
        "long": "--verbose",
        "arg": null,
        "optionalArg": false,
        "desc": "print 'a' -> 'b' for each copy"
      }
    ]
  },
  "debug": {
    "synopsis": "debug inject OP N [--target client|server|both] | debug delay MS | debug status | debug clear",
    "summary": "fault injection and demo delays",
    "flags": [
      {
        "short": null,
        "long": "--target",
        "arg": "WHERE",
        "optionalArg": false,
        "desc": "client, server or both (default both)"
      }
    ]
  },
  "df": {
    "synopsis": "df [-h] [-i] [PATH]",
    "summary": "usage and quota of the file system",
    "flags": [
      {
        "short": "-h",
        "long": "--human-readable",
        "arg": null,
        "optionalArg": false,
        "desc": "print sizes like 18M and 1.9G"
      },
      {
        "short": "-i",
        "long": "--inodes",
        "arg": null,
        "optionalArg": false,
        "desc": "show the inode quota instead of bytes"
      }
    ]
  },
  "du": {
    "synopsis": "du [-s] [-h] [-a] [-c] [-d N] [PATH...]",
    "summary": "disk usage",
    "flags": [
      {
        "short": "-s",
        "long": "--summarize",
        "arg": null,
        "optionalArg": false,
        "desc": "one total per operand"
      },
      {
        "short": "-h",
        "long": "--human-readable",
        "arg": null,
        "optionalArg": false,
        "desc": "print sizes like 4.0K and 18M"
      },
      {
        "short": "-a",
        "long": "--all",
        "arg": null,
        "optionalArg": false,
        "desc": "include files"
      },
      {
        "short": "-c",
        "long": "--total",
        "arg": null,
        "optionalArg": false,
        "desc": "add a total line"
      },
      {
        "short": "-d",
        "long": "--max-depth",
        "arg": "N",
        "optionalArg": false,
        "desc": "print totals at most N levels deep"
      }
    ]
  },
  "echo": {
    "synopsis": "echo [-n] [-e] [ARG...]",
    "summary": "print arguments",
    "flags": [
      {
        "short": "-n",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "do not print the trailing newline"
      },
      {
        "short": "-e",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "interpret \\n \\t \\\\ \\a \\e and \\0NNN escapes"
      }
    ]
  },
  "find": {
    "synopsis": "find [PATH...] [EXPRESSION]",
    "summary": "search a directory tree",
    "flags": []
  },
  "free": {
    "synopsis": "free [-h | -b | -k | -m | -g] [-s SECS] [-c COUNT] [--json]",
    "summary": "memory summary",
    "flags": [
      {
        "short": "-h",
        "long": "--human",
        "arg": null,
        "optionalArg": false,
        "desc": "pick a binary unit per value, one decimal (default)"
      },
      {
        "short": "-b",
        "long": "--bytes",
        "arg": null,
        "optionalArg": false,
        "desc": "show bytes"
      },
      {
        "short": "-k",
        "long": "--kibi",
        "arg": null,
        "optionalArg": false,
        "desc": "show KiB"
      },
      {
        "short": "-m",
        "long": "--mebi",
        "arg": null,
        "optionalArg": false,
        "desc": "show MiB"
      },
      {
        "short": "-g",
        "long": "--gibi",
        "arg": null,
        "optionalArg": false,
        "desc": "show GiB"
      },
      {
        "short": "-s",
        "long": "--seconds",
        "arg": "SECS",
        "optionalArg": false,
        "desc": "repeat every SECS seconds"
      },
      {
        "short": "-c",
        "long": "--count",
        "arg": "COUNT",
        "optionalArg": false,
        "desc": "stop after COUNT reports (with -s; default unlimited)"
      },
      {
        "short": null,
        "long": "--json",
        "arg": null,
        "optionalArg": false,
        "desc": "print the mem.stat record as JSON"
      }
    ]
  },
  "fsck": {
    "synopsis": "fsck [-n | -y] [--checksum] [--server] [PATH]",
    "summary": "check and repair the file system",
    "flags": [
      {
        "short": "-n",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "check only (default)"
      },
      {
        "short": "-y",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "repair in one transaction (root only)"
      },
      {
        "short": null,
        "long": "--checksum",
        "arg": null,
        "optionalArg": false,
        "desc": "print the deterministic tree checksum"
      },
      {
        "short": null,
        "long": "--server",
        "arg": null,
        "optionalArg": false,
        "desc": "run the server-side integrity probes (root, online)"
      }
    ]
  },
  "grep": {
    "synopsis": "grep [-i] [-v] [-n] [-c] [-l] [-r] [-F] [-w] [-H | -h] [-e PATTERN]... [PATTERN] [FILE...]",
    "summary": "search text",
    "flags": [
      {
        "short": "-i",
        "long": "--ignore-case",
        "arg": null,
        "optionalArg": false,
        "desc": "ignore case"
      },
      {
        "short": "-v",
        "long": "--invert-match",
        "arg": null,
        "optionalArg": false,
        "desc": "select non-matching lines"
      },
      {
        "short": "-n",
        "long": "--line-number",
        "arg": null,
        "optionalArg": false,
        "desc": "prefix each line with its number"
      },
      {
        "short": "-c",
        "long": "--count",
        "arg": null,
        "optionalArg": false,
        "desc": "print a count of matching lines per file"
      },
      {
        "short": "-l",
        "long": "--files-with-matches",
        "arg": null,
        "optionalArg": false,
        "desc": "print only the names of matching files"
      },
      {
        "short": "-r",
        "long": "--recursive",
        "arg": null,
        "optionalArg": false,
        "desc": "search directories recursively, skipping binary files"
      },
      {
        "short": "-F",
        "long": "--fixed-strings",
        "arg": null,
        "optionalArg": false,
        "desc": "PATTERN is a fixed string"
      },
      {
        "short": "-w",
        "long": "--word-regexp",
        "arg": null,
        "optionalArg": false,
        "desc": "match whole words only"
      },
      {
        "short": "-H",
        "long": "--with-filename",
        "arg": null,
        "optionalArg": false,
        "desc": "always print the file name"
      },
      {
        "short": "-h",
        "long": "--no-filename",
        "arg": null,
        "optionalArg": false,
        "desc": "never print the file name"
      },
      {
        "short": "-e",
        "long": "--regexp",
        "arg": "PATTERN",
        "optionalArg": false,
        "desc": "use PATTERN; may be given several times"
      }
    ]
  },
  "help": {
    "synopsis": "help [NAME]",
    "summary": "shell help",
    "flags": []
  },
  "id": {
    "synopsis": "id [-u | -g | -G] [-n] [USER]",
    "summary": "user and group identity",
    "flags": [
      {
        "short": "-u",
        "long": "--user",
        "arg": null,
        "optionalArg": false,
        "desc": "print only the user id"
      },
      {
        "short": "-g",
        "long": "--group",
        "arg": null,
        "optionalArg": false,
        "desc": "print only the group id"
      },
      {
        "short": "-G",
        "long": "--groups",
        "arg": null,
        "optionalArg": false,
        "desc": "print all group ids"
      },
      {
        "short": "-n",
        "long": "--name",
        "arg": null,
        "optionalArg": false,
        "desc": "print names instead of numbers"
      }
    ]
  },
  "kill": {
    "synopsis": "kill [-s SIGNAL | -SIGNAL | -n NUM] PID | -PGID... | kill -l [NUM | SIGNAL]",
    "summary": "send a signal",
    "flags": [
      {
        "short": "-s",
        "long": null,
        "arg": "SIGNAL",
        "optionalArg": false,
        "desc": "signal name, with or without SIG"
      },
      {
        "short": "-n",
        "long": null,
        "arg": "NUM",
        "optionalArg": false,
        "desc": "signal number"
      },
      {
        "short": "-l",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "list signal names, or translate a number or exit status"
      }
    ]
  },
  "ln": {
    "synopsis": "ln [-s] [-f] [-v] TARGET... LINK",
    "summary": "make links",
    "flags": [
      {
        "short": "-s",
        "long": "--symbolic",
        "arg": null,
        "optionalArg": false,
        "desc": "make a symbolic link (may dangle)"
      },
      {
        "short": "-f",
        "long": "--force",
        "arg": null,
        "optionalArg": false,
        "desc": "replace an existing LINK in one batch"
      },
      {
        "short": "-v",
        "long": "--verbose",
        "arg": null,
        "optionalArg": false,
        "desc": "print 'LINK' -> 'TARGET'"
      }
    ]
  },
  "ls": {
    "synopsis": "ls [-a] [-l] [-h] [-d] [-R] [-1] [-i] [-t] [-r] [--color[=WHEN]] [PATH...]",
    "summary": "list directory contents",
    "flags": [
      {
        "short": "-a",
        "long": "--all",
        "arg": null,
        "optionalArg": false,
        "desc": "include names that begin with ., and the entries . and .."
      },
      {
        "short": "-l",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "long listing: mode, links, owner, group, size, mtime"
      },
      {
        "short": "-h",
        "long": "--human-readable",
        "arg": null,
        "optionalArg": false,
        "desc": "with -l, print sizes like 4.0K and 18M"
      },
      {
        "short": "-d",
        "long": "--directory",
        "arg": null,
        "optionalArg": false,
        "desc": "list directories themselves, not their contents"
      },
      {
        "short": "-R",
        "long": "--recursive",
        "arg": null,
        "optionalArg": false,
        "desc": "list subdirectories recursively"
      },
      {
        "short": "-1",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "one name per line"
      },
      {
        "short": "-i",
        "long": "--inode",
        "arg": null,
        "optionalArg": false,
        "desc": "print the first 8 hex digits of the inode id"
      },
      {
        "short": "-t",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "sort by modification time, newest first"
      },
      {
        "short": "-r",
        "long": "--reverse",
        "arg": null,
        "optionalArg": false,
        "desc": "reverse the sort order"
      },
      {
        "short": null,
        "long": "--color",
        "arg": "WHEN",
        "optionalArg": true,
        "desc": "colour output on a terminal: auto (default) or never"
      }
    ]
  },
  "lsof": {
    "synopsis": "lsof [-p PID] [-u USER] [PATH]",
    "summary": "open files and leases",
    "flags": [
      {
        "short": "-p",
        "long": null,
        "arg": "PID",
        "optionalArg": false,
        "desc": "only descriptors of PID"
      },
      {
        "short": "-u",
        "long": null,
        "arg": "USER",
        "optionalArg": false,
        "desc": "only descriptors of USER"
      }
    ]
  },
  "man": {
    "synopsis": "man [SECTION] NAME | man -k KEYWORD | man -f NAME",
    "summary": "manual pages",
    "flags": [
      {
        "short": "-k",
        "long": "--apropos",
        "arg": null,
        "optionalArg": false,
        "desc": "search names and summaries for KEYWORD"
      },
      {
        "short": "-f",
        "long": "--whatis",
        "arg": null,
        "optionalArg": false,
        "desc": "print the one-line summary of NAME"
      }
    ]
  },
  "mkdir": {
    "synopsis": "mkdir [-p] [-m MODE] [-v] DIR...",
    "summary": "make directories",
    "flags": [
      {
        "short": "-p",
        "long": "--parents",
        "arg": null,
        "optionalArg": false,
        "desc": "create missing parents; no error if the directory exists"
      },
      {
        "short": "-m",
        "long": "--mode",
        "arg": "MODE",
        "optionalArg": false,
        "desc": "octal or symbolic mode, relative to a=rwx"
      },
      {
        "short": "-v",
        "long": "--verbose",
        "arg": null,
        "optionalArg": false,
        "desc": "report each created directory"
      }
    ]
  },
  "mv": {
    "synopsis": "mv [-n] [-f] [-v] SRC... DEST",
    "summary": "move or rename",
    "flags": [
      {
        "short": "-n",
        "long": "--no-clobber",
        "arg": null,
        "optionalArg": false,
        "desc": "never overwrite an existing destination"
      },
      {
        "short": "-f",
        "long": "--force",
        "arg": null,
        "optionalArg": false,
        "desc": "overwrite without error (default behaviour)"
      },
      {
        "short": "-v",
        "long": "--verbose",
        "arg": null,
        "optionalArg": false,
        "desc": "print renamed 'a' -> 'b'"
      }
    ]
  },
  "nice": {
    "synopsis": "nice [-n N] [COMMAND [ARG...]]",
    "summary": "run with changed niceness",
    "flags": [
      {
        "short": "-n",
        "long": "--adjustment",
        "arg": "N",
        "optionalArg": false,
        "desc": "add N to the niceness (default 10)"
      }
    ]
  },
  "pmap": {
    "synopsis": "pmap [-x] [--json] PID",
    "summary": "page table of a process",
    "flags": [
      {
        "short": "-x",
        "long": "--extended",
        "arg": null,
        "optionalArg": false,
        "desc": "add the generation, full SHA-256, pin reasons and swap key"
      },
      {
        "short": null,
        "long": "--json",
        "arg": null,
        "optionalArg": false,
        "desc": "print the process record and its pages as JSON"
      }
    ]
  },
  "predict": {
    "synopsis": "predict [-n N] [--why] [--json] [--latency [APP]] [--eval]",
    "summary": "show predictions",
    "flags": [
      {
        "short": "-n",
        "long": null,
        "arg": "N",
        "optionalArg": false,
        "desc": "number of predictions (default 3, max 10)"
      },
      {
        "short": "-k",
        "long": null,
        "arg": "N",
        "optionalArg": false,
        "desc": "same as -n"
      },
      {
        "short": null,
        "long": "--why",
        "arg": null,
        "optionalArg": false,
        "desc": "per-component probabilities for each prediction"
      },
      {
        "short": null,
        "long": "--explain",
        "arg": null,
        "optionalArg": false,
        "desc": "same as --why"
      },
      {
        "short": null,
        "long": "--json",
        "arg": null,
        "optionalArg": false,
        "desc": "print the predictor record as JSON"
      },
      {
        "short": null,
        "long": "--latency",
        "arg": null,
        "optionalArg": false,
        "desc": "launch latency with and without pre-fetch (optionally for APP)"
      },
      {
        "short": null,
        "long": "--eval",
        "arg": null,
        "optionalArg": false,
        "desc": "prequential top-1 and top-3 of the model, MFU and MRU"
      }
    ]
  },
  "ps": {
    "synopsis": "ps [-e | -A] [-f] [-l] [-u USER[,USER...]] [-p PID[,PID...]] [-t TTY] [-o FIELD[,FIELD...]] [--sort [-]FIELD] [--no-headers] [--json]",
    "summary": "process status",
    "flags": [
      {
        "short": "-e",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "select every process"
      },
      {
        "short": "-A",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "same as -e"
      },
      {
        "short": "-f",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "full format: ids, PRI NI CLS STAT %CPU RSS SWAP TTY TIME COMMAND"
      },
      {
        "short": "-l",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "long format: adds EP (effective priority) and WCHAN (what it waits on)"
      },
      {
        "short": "-u",
        "long": null,
        "arg": "USER",
        "optionalArg": false,
        "desc": "select the processes of these users (comma-separated)"
      },
      {
        "short": "-p",
        "long": null,
        "arg": "PID",
        "optionalArg": false,
        "desc": "select processes by comma-separated pid list"
      },
      {
        "short": "-t",
        "long": null,
        "arg": "TTY",
        "optionalArg": false,
        "desc": "select the processes whose terminal is TTY (tty1, or 1)"
      },
      {
        "short": "-o",
        "long": null,
        "arg": "FIELD",
        "optionalArg": false,
        "desc": "user-defined format, comma-separated fields"
      },
      {
        "short": null,
        "long": "--sort",
        "arg": "FIELD",
        "optionalArg": false,
        "desc": "sort by FIELD; a leading - sorts descending"
      },
      {
        "short": null,
        "long": "--no-headers",
        "arg": null,
        "optionalArg": false,
        "desc": "do not print the header line"
      },
      {
        "short": null,
        "long": "--json",
        "arg": null,
        "optionalArg": false,
        "desc": "print the selected rows as JSON"
      }
    ]
  },
  "pwd": {
    "synopsis": "pwd [-L | -P]",
    "summary": "print working directory",
    "flags": [
      {
        "short": "-L",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "print $PWD if it names the current directory"
      },
      {
        "short": "-P",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "print the kernel's getcwd path (default)"
      }
    ]
  },
  "quota": {
    "synopsis": "quota [-h] [-u USER]",
    "summary": "show quotas",
    "flags": [
      {
        "short": "-h",
        "long": "--human-readable",
        "arg": null,
        "optionalArg": false,
        "desc": "print sizes like 18.2M"
      },
      {
        "short": "-u",
        "long": "--user",
        "arg": "USER",
        "optionalArg": false,
        "desc": "show USER's quota (root only)"
      }
    ]
  },
  "reboot": {
    "synopsis": "reboot [--menu] [--safe] [--verbose]",
    "summary": "restart the OS",
    "flags": [
      {
        "short": null,
        "long": "--menu",
        "arg": null,
        "optionalArg": false,
        "desc": "open the boot menu on the next boot"
      },
      {
        "short": null,
        "long": "--safe",
        "arg": null,
        "optionalArg": false,
        "desc": "boot the next time in safe mode"
      },
      {
        "short": null,
        "long": "--verbose",
        "arg": null,
        "optionalArg": false,
        "desc": "show the verbose boot log on the next boot"
      }
    ]
  },
  "renice": {
    "synopsis": "renice [-n] N [-p] PID... | renice [-n] N -g PGID... | renice [-n] N -u USER...",
    "summary": "change the niceness of running processes",
    "flags": [
      {
        "short": "-n",
        "long": "--priority",
        "arg": "N",
        "optionalArg": false,
        "desc": "the new absolute nice value"
      },
      {
        "short": "-p",
        "long": "--pid",
        "arg": null,
        "optionalArg": false,
        "desc": "operands are process ids (default)"
      },
      {
        "short": "-g",
        "long": "--pgrp",
        "arg": null,
        "optionalArg": false,
        "desc": "operands are process group ids"
      },
      {
        "short": "-u",
        "long": "--user",
        "arg": null,
        "optionalArg": false,
        "desc": "operands are user names or ids"
      }
    ]
  },
  "rm": {
    "synopsis": "rm [-r | -R] [-f] [-d] [-v] PATH...",
    "summary": "remove files and directories",
    "flags": [
      {
        "short": "-r",
        "long": "--recursive",
        "arg": null,
        "optionalArg": false,
        "desc": "remove directories and their contents (one bulk transaction)"
      },
      {
        "short": "-R",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "same as -r"
      },
      {
        "short": "-f",
        "long": "--force",
        "arg": null,
        "optionalArg": false,
        "desc": "ignore missing operands and never report ENOENT"
      },
      {
        "short": "-d",
        "long": "--dir",
        "arg": null,
        "optionalArg": false,
        "desc": "remove empty directories"
      },
      {
        "short": "-v",
        "long": "--verbose",
        "arg": null,
        "optionalArg": false,
        "desc": "report each removal"
      }
    ]
  },
  "rmdir": {
    "synopsis": "rmdir [-p] [-v] DIR...",
    "summary": "remove empty directories",
    "flags": [
      {
        "short": "-p",
        "long": "--parents",
        "arg": null,
        "optionalArg": false,
        "desc": "also remove each parent that becomes empty"
      },
      {
        "short": "-v",
        "long": "--verbose",
        "arg": null,
        "optionalArg": false,
        "desc": "report each removed directory"
      }
    ]
  },
  "semsearch": {
    "synopsis": "semsearch [-k N] [-l] [--json] [--chunks] [--keyword] [--dir PATH] QUERY",
    "summary": "semantic file search",
    "flags": [
      {
        "short": "-k",
        "long": null,
        "arg": "N",
        "optionalArg": false,
        "desc": "number of results (default 5)"
      },
      {
        "short": "-l",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "print paths only"
      },
      {
        "short": null,
        "long": "--json",
        "arg": null,
        "optionalArg": false,
        "desc": "print the raw result"
      },
      {
        "short": null,
        "long": "--chunks",
        "arg": null,
        "optionalArg": false,
        "desc": "return every matching chunk, not one per file"
      },
      {
        "short": null,
        "long": "--keyword",
        "arg": null,
        "optionalArg": false,
        "desc": "keyword search only"
      },
      {
        "short": null,
        "long": "--dir",
        "arg": "PATH",
        "optionalArg": false,
        "desc": "search only under PATH"
      }
    ]
  },
  "shutdown": {
    "synopsis": "shutdown [-h | -r] [now | +MIN | HH:MM] [MESSAGE] | shutdown -c",
    "summary": "stop or restart the OS",
    "flags": [
      {
        "short": "-h",
        "long": "--halt",
        "arg": null,
        "optionalArg": false,
        "desc": "halt (default)"
      },
      {
        "short": "-r",
        "long": "--reboot",
        "arg": null,
        "optionalArg": false,
        "desc": "restart"
      },
      {
        "short": "-c",
        "long": "--cancel",
        "arg": null,
        "optionalArg": false,
        "desc": "cancel a scheduled shutdown"
      }
    ]
  },
  "stat": {
    "synopsis": "stat [-L] [-t] FILE...",
    "summary": "show inode metadata",
    "flags": [
      {
        "short": "-L",
        "long": "--dereference",
        "arg": null,
        "optionalArg": false,
        "desc": "follow symbolic links"
      },
      {
        "short": "-t",
        "long": "--terse",
        "arg": null,
        "optionalArg": false,
        "desc": "one terse line per file"
      }
    ]
  },
  "su": {
    "synopsis": "su [-] [-l] [-c COMMAND] [USER]",
    "summary": "run a shell as another user",
    "flags": [
      {
        "short": "-l",
        "long": "--login",
        "arg": null,
        "optionalArg": false,
        "desc": "start a login shell (also written -)"
      },
      {
        "short": "-c",
        "long": "--command",
        "arg": "COMMAND",
        "optionalArg": false,
        "desc": "run COMMAND and return"
      }
    ]
  },
  "svcctl": {
    "synopsis": "svcctl status [NAME] | svcctl graph | svcctl verify | svcctl retry NAME | svcctl start|stop|restart NAME | svcctl require NAME DEP... [--force] | svcctl unrequire NAME DEP... | svcctl restore-defaults",
    "summary": "service control",
    "flags": [
      {
        "short": null,
        "long": "--force",
        "arg": null,
        "optionalArg": false,
        "desc": "with require: write the manifest even if it creates a cycle"
      }
    ]
  },
  "swapctl": {
    "synopsis": "swapctl [status] | swapctl tier auto|local|remote | swapctl --tier auto|local|remote | swapctl drop-local [PID] | swapctl checkpoint PID | swapctl bench [--size SIZE] [--tier local|remote] [-n N]",
    "summary": "swap tiers",
    "flags": [
      {
        "short": null,
        "long": "--tier",
        "arg": "TIER",
        "optionalArg": false,
        "desc": "tier policy to set, or the tier to benchmark"
      },
      {
        "short": null,
        "long": "--size",
        "arg": "SIZE",
        "optionalArg": false,
        "desc": "bench page size, for example 5M (default 5M)"
      },
      {
        "short": "-n",
        "long": null,
        "arg": "N",
        "optionalArg": false,
        "desc": "bench page count (default 20)"
      }
    ]
  },
  "top": {
    "synopsis": "top [-b] [-n N] [-d SECS] [-u USER] [-p PID[,PID...]] [-o FIELD] [--json]",
    "summary": "live process view",
    "flags": [
      {
        "short": "-b",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "batch mode: plain frames separated by a blank line"
      },
      {
        "short": "-n",
        "long": null,
        "arg": "N",
        "optionalArg": false,
        "desc": "stop after N frames"
      },
      {
        "short": "-d",
        "long": null,
        "arg": "SECS",
        "optionalArg": false,
        "desc": "delay between frames (at least 0.5, default 1)"
      },
      {
        "short": "-u",
        "long": null,
        "arg": "USER",
        "optionalArg": false,
        "desc": "only processes of USER"
      },
      {
        "short": "-p",
        "long": null,
        "arg": "PID",
        "optionalArg": false,
        "desc": "only these processes (comma-separated)"
      },
      {
        "short": "-o",
        "long": null,
        "arg": "FIELD",
        "optionalArg": false,
        "desc": "sort field: pcpu (default), rss, time, pid, pri"
      },
      {
        "short": null,
        "long": "--json",
        "arg": null,
        "optionalArg": false,
        "desc": "print each frame as one JSON line"
      }
    ]
  },
  "touch": {
    "synopsis": "touch [-c] [-a] [-m] [-d DATE] FILE...",
    "summary": "create files or set times",
    "flags": [
      {
        "short": "-c",
        "long": "--no-create",
        "arg": null,
        "optionalArg": false,
        "desc": "do not create missing files"
      },
      {
        "short": "-a",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "change the access time only"
      },
      {
        "short": "-m",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "change the modification time only"
      },
      {
        "short": "-d",
        "long": "--date",
        "arg": "DATE",
        "optionalArg": false,
        "desc": "use DATE (YYYY-MM-DD[THH:MM[:SS]]) instead of now"
      }
    ]
  },
  "tree": {
    "synopsis": "tree [-a] [-d] [-L LEVEL] [--noreport] [PATH]",
    "summary": "show a directory tree",
    "flags": [
      {
        "short": "-a",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "include hidden names"
      },
      {
        "short": "-d",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "list directories only"
      },
      {
        "short": "-L",
        "long": null,
        "arg": "LEVEL",
        "optionalArg": false,
        "desc": "descend at most LEVEL directories"
      },
      {
        "short": null,
        "long": "--noreport",
        "arg": null,
        "optionalArg": false,
        "desc": "omit the directory and file count"
      }
    ]
  },
  "uname": {
    "synopsis": "uname [-a] [-s] [-r] [-v] [-m]",
    "summary": "system identity",
    "flags": [
      {
        "short": "-a",
        "long": "--all",
        "arg": null,
        "optionalArg": false,
        "desc": "print the full identity line"
      },
      {
        "short": "-s",
        "long": "--kernel-name",
        "arg": null,
        "optionalArg": false,
        "desc": "print the system name (default)"
      },
      {
        "short": "-r",
        "long": "--kernel-release",
        "arg": null,
        "optionalArg": false,
        "desc": "print the kernel release"
      },
      {
        "short": "-v",
        "long": "--kernel-version",
        "arg": null,
        "optionalArg": false,
        "desc": "print the build date"
      },
      {
        "short": "-m",
        "long": "--machine",
        "arg": null,
        "optionalArg": false,
        "desc": "print the browser and core count"
      }
    ]
  },
  "uptime": {
    "synopsis": "uptime [-p] [-s]",
    "summary": "time since boot and load",
    "flags": [
      {
        "short": "-p",
        "long": "--pretty",
        "arg": null,
        "optionalArg": false,
        "desc": "print up 12 minutes"
      },
      {
        "short": "-s",
        "long": "--since",
        "arg": null,
        "optionalArg": false,
        "desc": "print the boot time"
      }
    ]
  },
  "vmstat": {
    "synopsis": "vmstat [-w] [--json] [DELAY [COUNT]] [-p [PID...]]",
    "summary": "paging and scheduler statistics",
    "flags": [
      {
        "short": "-p",
        "long": null,
        "arg": null,
        "optionalArg": false,
        "desc": "per-process rows (MEM-07) for every process, or the PIDs that follow"
      },
      {
        "short": "-w",
        "long": "--wide",
        "arg": null,
        "optionalArg": false,
        "desc": "wide columns"
      },
      {
        "short": null,
        "long": "--json",
        "arg": null,
        "optionalArg": false,
        "desc": "print each sample as one JSON line"
      }
    ]
  },
  "whoami": {
    "synopsis": "whoami",
    "summary": "effective user name",
    "flags": []
  }
} as const satisfies ArgSpecTable;
