---json
{
  "name": "debug",
  "section": 1,
  "summary": "fault injection and demo delays",
  "synopsis": "debug inject OP N [--target client|server|both] | debug delay MS | debug status | debug clear",
  "owner": "R5",
  "requirements": [
    "DB-02",
    "AGT-09"
  ],
  "flags": [
    {
      "short": null,
      "long": "--target",
      "arg": "WHERE",
      "desc": "client, server or both (default both)"
    }
  ],
  "seeAlso": [
    "rm",
    "fsck"
  ]
}
---

# NAME

debug — fault injection and demo delays

# SYNOPSIS

`debug inject OP N [--target client|server|both] | debug delay MS | debug status | debug clear`

# DESCRIPTION

Root only; every use is audited. `inject` arms a one-shot fault that aborts the next OP (rm, cp, mv, rename-batch, chmod, chown) after N node operations. `delay` stretches the next agent batch transaction.

# OPTIONS

- `--target WHERE` — client, server or both (default both)

# EXIT STATUS

0 on success; 1 on failure; 2 on a usage error.

# ERRORS

- `debug: Operation not permitted` (EPERM)
- `debug: fault injection is disabled on this server` (EPERM)
- `debug: unknown operation 'x'`

# EXAMPLES

    su -c 'debug inject rm 500 --target both'

# SEE ALSO

rm(1), fsck(1)
