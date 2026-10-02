---json
{
  "name": "shutdown",
  "section": 1,
  "summary": "stop or restart the OS",
  "synopsis": "shutdown [-h | -r] [now | +MIN | HH:MM] [MESSAGE] | shutdown -c",
  "owner": "R5",
  "requirements": [
    "SYS-02",
    "BOOT-12"
  ],
  "flags": [
    {
      "short": "-h",
      "long": "--halt",
      "arg": null,
      "desc": "halt (default)"
    },
    {
      "short": "-r",
      "long": "--reboot",
      "arg": null,
      "desc": "restart"
    },
    {
      "short": "-c",
      "long": "--cancel",
      "arg": null,
      "desc": "cancel a scheduled shutdown"
    }
  ],
  "seeAlso": [
    "reboot"
  ]
}
---

# NAME

shutdown — stop or restart the OS

# SYNOPSIS

`shutdown [-h | -r] [now | +MIN | HH:MM] [MESSAGE] | shutdown -c`

# DESCRIPTION

Stops or restarts Plotinium now, after MIN minutes, or at HH:MM, running the orderly shutdown sequence.

# OPTIONS

- `-h, --halt` — halt (default)
- `-r, --reboot` — restart
- `-c, --cancel` — cancel a scheduled shutdown

# EXIT STATUS

0 on success; 1 on failure; 2 on a usage error.

# ERRORS

- `shutdown: Operation not permitted` (EPERM)

# EXAMPLES

    shutdown -r now

# SEE ALSO

reboot(1)
