# Plotinium: examiner card

**Plotinium v1.0.0** · an AI-native, local-first web operating system · LGU BSCS capstone, Fall 2026
Print this page (two copies). It contains **no password**: write the ones you are given by hand.

## 1. Where

|                 |                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------- |
| **Production**  | `https://______________________________`                                                 |
| **Local stack** | **http://localhost:4717** (use `localhost`, not a LAN IP: the OS needs a secure context) |
| **Browser**     | Google Chrome stable. Other browsers get an "unsupported browser" screen that says why.  |

## 2. Start it: three commands

```sh
git clone https://github.com/<org>/plotinium.git
cd plotinium
docker compose up -d --wait
```

Then open **http://localhost:4717** in Chrome.

| Need                                                     | Command                                                                       |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Local passwords (generated at first start, printed once) | `docker compose logs app \| grep -A 12 "FIRST-START CREDENTIALS"`             |
| Port 4717 is taken                                       | `PLOTINIUM_PORT=4718 docker compose up -d --wait`, then http://localhost:4718 |
| Something did not start                                  | `docker compose logs app` (it names the failing step)                         |
| Stop                                                     | `docker compose down`                                                         |
| Start again from nothing (**deletes local data**)        | `docker compose down -v`                                                      |

Prerequisites: Docker Engine or Docker Desktop with Compose 2.24 or newer (amd64 or arm64), about 1.5 GB of free RAM and 2 GB of disk.

## 3. Accounts

| Where       | Account                                      | Password                               |
| ----------- | -------------------------------------------- | -------------------------------------- |
| Production  | `examiner1`                                  | ______________________                 |
| Production  | `examiner2`                                  | ______________________                 |
| Production  | `examiner3`                                  | ______________________                 |
| Production  | `demo`                                       | ______________________                 |
| Local stack | `demo`, `alice`, `bob`; `root` via `su` only | from `docker compose logs app` (above) |

Production passwords come in a sealed envelope at the start and are changed after the defence. They are never written in the repository (spec §18).

## 4. What to try (we suggest; you type)

| Check                                        | Commands (in a Terminal, or as shown)                                                                                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verbose cold boot                            | first load of http://localhost:4717: **hold V** (or Esc → _Verbose boot_); later: `reboot --menu`                                                                                                                                     |
| Boot timings                                 | `bootlog` · `bootlog --critical-path`                                                                                                                                                                                                 |
| Offline boot                                 | wait for the **Offline-ready** badge → DevTools → Network → _Offline_ (local stack: `docker compose stop app web`) → `reboot` → `ls -la ~`, `cat`, Files, Editor, Task Manager, Settings → reconnect (`docker compose start app web`) |
| Semantic search                              | `semsearch "<your question>"` in profile A (alice), then in profile B (bob); the Files search box                                                                                                                                     |
| Agent                                        | `ai "<your instruction>"`: **Enter = No** (the default), `y` = Yes · `ai log`                                                                                                                                                         |
| Pre-fetch                                    | `predict` → wait 2 s → open the top app → `predict --latency` · `ps -e` · Task Manager → _Predictions_                                                                                                                                |
| CPU load + drag                              | `burn --ms 120000 &` (3 times) · `top` · `framemeter on` · drag and resize 10 windows                                                                                                                                                 |
| 2x memory                                    | `memhog --total 512M --procs 8` · `free` · `vmstat 1` · Task Manager → _Memory_ · click a minimised window                                                                                                                            |
| Fault-injected delete (**local stack only**) | `su -c 'debug inject rm 500 --target server'` (choose any N) · `fsck --checksum ~/fixtures/tree1000` · `rm -r ~/fixtures/tree1000` · `fsck ~/fixtures/tree1000` · `quota` · `su -c 'fsck --server'`                                   |
| Two users, one file                          | profiles A and B: `edit /home/shared/plan.md` · in B: `lsof /home/shared/plan.md` · end A's tab in Chrome's Task Manager (Shift+Esc)                                                                                                  |
| Help                                         | `help` · `man <command>` · `man -k <word>` · `uname -a`                                                                                                                                                                               |

## 5. If something goes wrong

| You see                                     | It means / do this                                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai: agent unavailable … — nothing was run` | no model is reachable from this instance (the local stack has no API key by design); nothing was changed. Use the production URL for the agent. |
| Search results labelled as keyword matches  | the semantic model is still loading; the same query a few seconds later uses it                                                                 |
| "This page is not Plotinium"                | another app used this port before; open a fresh Chrome profile                                                                                  |
| A kernel panic that names a cycle           | a service manifest has a cycle (BOOT-04); press **R** for the recovery console, then **M** to restore the default manifests                     |
| The file stays "Locked by alice"            | the lease expires by its time-to-live; `lsof` shows the countdown (15 s)                                                                        |
