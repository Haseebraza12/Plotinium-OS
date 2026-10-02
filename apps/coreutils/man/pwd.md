---json
{
  "name": "pwd",
  "section": 1,
  "summary": "print working directory",
  "synopsis": "pwd [-L | -P]",
  "owner": "R2",
  "requirements": [
    "SYS-02"
  ],
  "flags": [
    {
      "short": "-L",
      "long": null,
      "arg": null,
      "desc": "print $PWD if it names the current directory"
    },
    {
      "short": "-P",
      "long": null,
      "arg": null,
      "desc": "print the kernel's getcwd path (default)"
    }
  ],
  "seeAlso": [
    "cd"
  ]
}
---

# NAME

pwd — print working directory

# SYNOPSIS

`pwd [-L | -P]`

# DESCRIPTION

Prints the absolute path of the working directory. `-P` (default) prints the first reachable path of the working directory inode; `-L` prints `$PWD` when it names the same directory.

# OPTIONS

- `-L` — print $PWD if it names the current directory
- `-P` — print the kernel's getcwd path (default)

# EXIT STATUS

0 on success; 1 if the working directory was deleted; 2 on a usage error.

# ERRORS

- `pwd: cannot determine current directory: No such file or directory`

# EXAMPLES

    pwd

# SEE ALSO

cd(1)
