---json
{
  "name": "whoami",
  "section": 1,
  "summary": "effective user name",
  "synopsis": "whoami",
  "owner": "R5",
  "requirements": [
    "SYS-02"
  ],
  "flags": [],
  "seeAlso": [
    "id",
    "su"
  ]
}
---

# NAME

whoami — effective user name

# SYNOPSIS

`whoami`

# DESCRIPTION

Prints the effective user name.

# OPTIONS

None.

# EXIT STATUS

0 on success; 2 on an extra operand.

# ERRORS

- `whoami: extra operand 'x'`

# EXAMPLES

    su -c whoami

# SEE ALSO

id(1), su(1)
