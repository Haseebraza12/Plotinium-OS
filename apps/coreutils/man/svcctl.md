---json
{
  "name": "svcctl",
  "section": 1,
  "summary": "service control",
  "synopsis": "svcctl status [NAME] | svcctl graph | svcctl verify | svcctl retry NAME | svcctl start|stop|restart NAME | svcctl require NAME DEP... [--force] | svcctl unrequire NAME DEP... | svcctl restore-defaults",
  "owner": "R5",
  "requirements": [
    "BOOT-03",
    "BOOT-04",
    "BOOT-07"
  ],
  "flags": [
    {
      "short": null,
      "long": "--force",
      "arg": null,
      "desc": "with require: write the manifest even if it creates a cycle"
    }
  ],
  "seeAlso": [
    "bootlog",
    "reboot"
  ]
}
---

# NAME

svcctl — service control

# SYNOPSIS

`svcctl status [NAME]`  
`svcctl graph`  
`svcctl verify`  
`svcctl retry NAME`  
`svcctl start|stop|restart NAME`  
`svcctl require NAME DEP... [--force]`  
`svcctl unrequire NAME DEP...`  
`svcctl restore-defaults`

# DESCRIPTION

`status` prints `SERVICE LEVEL CRIT STATE ATTEMPTS NEXT RETRY PID` rows. `graph` and `verify` print the levels of the service DAG as the next boot would build it, or the cycle. `retry` is allowed to any non-guest user; `start`, `stop`, `restart`, `require`, `unrequire` and `restore-defaults` need root. `require` and `unrequire` edit `/system/services/NAME.json` with an `expectedVersion` write and take effect at the next boot; a change that creates a dependency cycle is refused unless `--force` is given, so an examiner can still create one deliberately (BOOT-04).

# OPTIONS

- `--force` — with require: write the manifest even if it creates a cycle

# EXIT STATUS

0 on success; 1 on failure; 2 on a usage error.

# ERRORS

- `svcctl: unknown service 'x'` (ENOENT)
- `svcctl: Operation not permitted` (EPERM)
- `svcctl: stopping a critical service is not allowed` (EPERM)

# EXAMPLES

    svcctl status
    su -c 'svcctl require sync lockd --force' && reboot

# SEE ALSO

bootlog(1), reboot(1)
