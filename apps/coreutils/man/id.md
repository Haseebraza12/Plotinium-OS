---json
{
  "name": "id",
  "section": 1,
  "summary": "user and group identity",
  "synopsis": "id [-u | -g | -G] [-n] [USER]",
  "owner": "R5",
  "requirements": [
    "SYS-02"
  ],
  "flags": [
    {
      "short": "-u",
      "long": "--user",
      "arg": null,
      "desc": "print only the user id"
    },
    {
      "short": "-g",
      "long": "--group",
      "arg": null,
      "desc": "print only the group id"
    },
    {
      "short": "-G",
      "long": "--groups",
      "arg": null,
      "desc": "print all group ids"
    },
    {
      "short": "-n",
      "long": "--name",
      "arg": null,
      "desc": "print names instead of numbers"
    }
  ],
  "seeAlso": [
    "whoami",
    "su"
  ]
}
---

# NAME

id — user and group identity

# SYNOPSIS

`id [-u | -g | -G] [-n] [USER]`

# DESCRIPTION

Prints `uid=1001(alice) gid=1001(alice) groups=1001(alice),100(users)` for the caller or USER.

# OPTIONS

- `-u, --user` — print only the user id
- `-g, --group` — print only the group id
- `-G, --groups` — print all group ids
- `-n, --name` — print names instead of numbers

# EXIT STATUS

0 on success; 1 on an unknown user; 2 on a usage error.

# ERRORS

- `id: 'bob2': no such user`

# EXAMPLES

    id -Gn

# SEE ALSO

whoami(1), su(1)
