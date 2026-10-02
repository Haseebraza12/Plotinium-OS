---json
{
  "name": "predict",
  "section": 1,
  "summary": "show predictions",
  "synopsis": "predict [-n N] [--why] [--json] [--latency [APP]] [--eval]",
  "owner": "R4",
  "requirements": [
    "SYS-02",
    "PRE-03",
    "PRE-06"
  ],
  "flags": [
    {
      "short": "-n",
      "long": null,
      "arg": "N",
      "desc": "number of predictions (default 3, max 10)"
    },
    {
      "short": "-k",
      "long": null,
      "arg": "N",
      "desc": "same as -n"
    },
    {
      "short": null,
      "long": "--why",
      "arg": null,
      "desc": "per-component probabilities for each prediction"
    },
    {
      "short": null,
      "long": "--explain",
      "arg": null,
      "desc": "same as --why"
    },
    {
      "short": null,
      "long": "--json",
      "arg": null,
      "desc": "print the predictor record as JSON"
    },
    {
      "short": null,
      "long": "--latency",
      "arg": null,
      "desc": "launch latency with and without pre-fetch (optionally for APP)"
    },
    {
      "short": null,
      "long": "--eval",
      "arg": null,
      "desc": "prequential top-1 and top-3 of the model, MFU and MRU"
    }
  ],
  "seeAlso": [
    "ps",
    "top"
  ]
}
---

# NAME

predict — show predictions

# SYNOPSIS

`predict [-n N] [--why] [--json] [--latency [APP]] [--eval]`

# DESCRIPTION

Prints the model line (`MODEL  markov-2 (witten-bell) · 612 launches · updated 10:12`) and the top predictions as `rank  app  confidence  reason`. Below 50 launches the predictor ranks by use only (`MODEL  MFU fallback (37 of 50 launches)`) and the status is 1.

# OPTIONS

- `-n N` — number of predictions (default 3, max 10)
- `-k N` — same as -n
- `--why` — per-component probabilities for each prediction
- `--explain` — same as --why
- `--json` — print the predictor record as JSON
- `--latency` — launch latency with and without pre-fetch (optionally for APP)
- `--eval` — prequential top-1 and top-3 of the model, MFU and MRU

# EXIT STATUS

0 predictions shown; 1 cold start (MFU ranking shown); 2 error or usage error.

# ERRORS

- `predict: predictor not running` (exit 2; the AI-off build has no predict)

# EXAMPLES

    predict
    predict -n 5 --why
    predict --latency

# SEE ALSO

ps(1), top(1)
