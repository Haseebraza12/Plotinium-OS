#!/usr/bin/env bash
# ops/provision.sh: build, harden and check the Plotinium production host (OPS-12, OPS-13).
# Spec: specs/14-devops/deployment-and-ci.md §3.12 (provisioning), §3.13 (provider order), §3.14.3
# (rebuild drill). Runbook: ops/RUNBOOK.md §1. Owner: R5 QA/DevOps. Reviewer: R1.
#
# ops/cloud-init.yaml is the single description of the host. This script only renders it, hands it
# to the provider, applies the same file on a host that has no cloud-init user data, and checks the
# result:
#
#   ops/provision.sh render   --keys team.pub [--hostname plotinium-prod]      > user-data.yaml
#   ops/provision.sh firewall [--name plotinium] [--server plotinium-prod]           (hcloud)
#   ops/provision.sh create   --keys team.pub [--name plotinium-prod] [--type cx33]
#                             [--location fsn1] [--image ubuntu-24.04] [--ssh-key NAME]
#                             [--retry-minutes 60] [--dry-run]                     (hcloud)
#   sudo ops/provision.sh host   [--keys team.pub] [--hostname plotinium-prod]      (on the VPS)
#   ops/provision.sh verify                                                         (on the VPS)
#
# `--keys` is a file of PUBLIC keys, one per line (the members' keys and the CI deploy key); the
# script refuses anything that looks like a private key. `create` and `firewall` need the hcloud
# CLI and HCLOUD_TOKEN in the environment of the member running them; the token is never written to
# the repository or to GitHub (spec §3.9). Nothing here needs or prints a secret.
#
# Firewall (spec §3.12): inbound 22/tcp, 80/tcp, 443/tcp, 443/udp and ICMP only. The Hetzner Cloud
# Firewall is authoritative because Docker-published ports bypass UFW; UFW on the host (from
# cloud-init) is defence in depth for everything Docker does not publish.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLOUD_INIT="${PLOTINIUM_CLOUD_INIT:-${HERE}/cloud-init.yaml}"
DEPLOY_USER=deploy
DEPLOY_UID=1000
COMPOSE_MIN=2.24.4
KEYS_MARKER="'@PLOTINIUM_AUTHORIZED_KEYS@'"
HOST_MARKER='@PLOTINIUM_HOSTNAME@'
KEY_RE='^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^[:cntrl:]]*)?$'
HOSTNAME_RE='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
}

die() {
  echo "provision: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required for '${cmd}' ($2)"
}

# --- keys ------------------------------------------------------------------------------------------
# Prints the valid public-key lines of a file; fails on a private key or when no key is found.
read_keys() {
  local file="$1" line n=0
  [[ -r "$file" ]] || die "cannot read the keys file ${file}"
  if grep -q 'PRIVATE KEY' "$file"; then
    die "${file} contains a private key; pass PUBLIC keys only (*.pub)"
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line// /}" || "$line" == \#* ]] && continue
    [[ "$line" =~ $KEY_RE ]] || die "not an OpenSSH public key line: ${line:0:40}..."
    printf '%s\n' "$line"
    n=$((n + 1))
  done <"$file"
  ((n > 0)) || die "${file} holds no public key"
}

# --- render ----------------------------------------------------------------------------------------
render() {
  local keys_file="" host="plotinium-prod"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --keys) keys_file="${2:?--keys needs a file}"; shift 2 ;;
      --hostname) host="${2:?--hostname needs a name}"; shift 2 ;;
      *) die "render: unknown option $1" ;;
    esac
  done
  [[ -n "$keys_file" ]] || die "render: --keys FILE is required"
  [[ "$host" =~ $HOSTNAME_RE ]] || die "render: bad hostname ${host}"
  [[ -r "$CLOUD_INIT" ]] || die "cannot read ${CLOUD_INIT}"
  local keys
  keys="$(read_keys "$keys_file")"

  local line indent key found=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == *"$KEYS_MARKER"* ]]; then
      indent="${line%%-*}"
      while IFS= read -r key; do
        printf "%s- '%s'\n" "$indent" "${key//\'/\'\'}"
      done <<<"$keys"
      found=1
    else
      printf '%s\n' "${line//$HOST_MARKER/$host}"
    fi
  done <"$CLOUD_INIT"
  ((found == 1)) || die "the keys marker is missing from ${CLOUD_INIT}"
}

# --- firewall (Hetzner Cloud) --------------------------------------------------------------------------
firewall_rules_json() {
  cat <<'JSON'
[
  { "direction": "in", "protocol": "tcp", "port": "22", "source_ips": ["0.0.0.0/0", "::/0"], "description": "ssh (deploy user, keys only)" },
  { "direction": "in", "protocol": "tcp", "port": "80", "source_ips": ["0.0.0.0/0", "::/0"], "description": "http (ACME, redirect to https)" },
  { "direction": "in", "protocol": "tcp", "port": "443", "source_ips": ["0.0.0.0/0", "::/0"], "description": "https" },
  { "direction": "in", "protocol": "udp", "port": "443", "source_ips": ["0.0.0.0/0", "::/0"], "description": "http/3 (quic)" },
  { "direction": "in", "protocol": "icmp", "source_ips": ["0.0.0.0/0", "::/0"], "description": "icmp" }
]
JSON
}

ensure_firewall() {
  local name="$1" rules
  need hcloud "https://github.com/hetznercloud/cli"
  [[ -n "${HCLOUD_TOKEN:-}" ]] || die "HCLOUD_TOKEN is not set (keep it in your shell, never in the repository)"
  rules="$(mktemp)"
  firewall_rules_json >"$rules"
  if ! hcloud firewall describe "$name" >/dev/null 2>&1; then
    hcloud firewall create --name "$name" --label project=plotinium >/dev/null
    echo "provision: created firewall ${name}" >&2
  fi
  hcloud firewall replace-rules "$name" --rules-file "$rules" >/dev/null
  rm -f "$rules"
  echo "provision: firewall ${name}: in 22/tcp 80/tcp 443/tcp 443/udp icmp; everything else dropped" >&2
}

firewall() {
  local name="plotinium" server=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --name) name="${2:?}"; shift 2 ;;
      --server) server="${2:?}"; shift 2 ;;
      *) die "firewall: unknown option $1" ;;
    esac
  done
  ensure_firewall "$name"
  if [[ -n "$server" ]]; then
    hcloud firewall apply-to-resource "$name" --type server --server "$server" >/dev/null ||
      echo "provision: firewall ${name} is probably already applied to ${server}" >&2
  fi
}

# --- create (Hetzner Cloud, with the restock retry loop of spec §3.13) ------------------------------------
create() {
  local keys_file="" name="plotinium-prod" type="cx33" location="fsn1" image="ubuntu-24.04"
  local ssh_key="" retry_minutes=60 dry_run=0 fw="plotinium"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --keys) keys_file="${2:?}"; shift 2 ;;
      --name) name="${2:?}"; shift 2 ;;
      --type) type="${2:?}"; shift 2 ;;
      --location) location="${2:?}"; shift 2 ;;
      --image) image="${2:?}"; shift 2 ;;
      --ssh-key) ssh_key="${2:?}"; shift 2 ;;
      --firewall) fw="${2:?}"; shift 2 ;;
      --retry-minutes) retry_minutes="${2:?}"; shift 2 ;;
      --dry-run) dry_run=1; shift ;;
      *) die "create: unknown option $1" ;;
    esac
  done
  [[ -n "$keys_file" ]] || die "create: --keys FILE is required"
  [[ "$name" =~ $HOSTNAME_RE ]] || die "create: bad server name ${name}"
  [[ "$retry_minutes" =~ ^[0-9]+$ ]] || die "create: --retry-minutes must be a number"

  user_data="$(mktemp --suffix=.yaml)"
  trap 'rm -f "$user_data"' EXIT
  render --keys "$keys_file" --hostname "$name" >"$user_data"
  if command -v cloud-init >/dev/null 2>&1; then
    cloud-init schema --config-file "$user_data" >/dev/null 2>&1 || die "rendered user data fails the cloud-init schema"
  fi

  local args=(server create --name "$name" --type "$type" --image "$image" --location "$location"
    --user-data-from-file "$user_data" --firewall "$fw" --label project=plotinium)
  [[ -n "$ssh_key" ]] && args+=(--ssh-key "$ssh_key")
  if ((dry_run)); then
    echo "provision: dry run: hcloud ${args[*]}" >&2
    cat "$user_data"
    return 0
  fi

  ensure_firewall "$fw"
  local deadline=$(($(date +%s) + retry_minutes * 60)) out attempt=0
  while :; do
    attempt=$((attempt + 1))
    if out="$(hcloud "${args[@]}" 2>&1)"; then
      echo "$out" >&2
      break
    fi
    if grep -qiE 'unavailable|not available|resource_limit' <<<"$out" && (($(date +%s) < deadline)); then
      echo "provision: attempt ${attempt}: ${type} not orderable in ${location} yet; retrying in 10 s" >&2
      sleep 10
      continue
    fi
    echo "$out" >&2
    die "could not create ${name} (after ${attempt} attempts). Spec §3.13: after 72 h without a CX33, order OVHcloud VPS-2 and run 'sudo ops/provision.sh host' there."
  done
  echo "provision: ${name} created. Add these DNS records (RUNBOOK §2):" >&2
  echo "  A    <domain>  $(hcloud server ip "$name")" >&2
  echo "  AAAA <domain>  $(hcloud server ip -6 "$name" 2>/dev/null || echo '(no IPv6)')" >&2
}

# --- host: apply ops/cloud-init.yaml on a machine without cloud-init user data (OVH, rebuilds) ---------
host() {
  local keys_file="" host_name=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --keys) keys_file="${2:?}"; shift 2 ;;
      --hostname) host_name="${2:?}"; shift 2 ;;
      *) die "host: unknown option $1" ;;
    esac
  done
  [[ "$(id -u)" -eq 0 ]] || die "host must run as root (sudo ops/provision.sh host ...)"
  [[ -r "$CLOUD_INIT" ]] || die "cannot read ${CLOUD_INIT}"
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == ubuntu ]] || echo "provision: warning: tested on Ubuntu 24.04 only (this is ${PRETTY_NAME:-unknown})" >&2
  export DEBIAN_FRONTEND=noninteractive

  apt-get update -q
  apt-get install -yq python3 python3-yaml

  # 1. Hostname and time zone.
  if [[ -n "$host_name" ]]; then
    [[ "$host_name" =~ $HOSTNAME_RE ]] || die "bad hostname ${host_name}"
    hostnamectl set-hostname "$host_name"
  fi
  timedatectl set-timezone UTC || true

  # 2. The deploy user: uid 1000 (the container's node uid) when it is free.
  if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
    if getent passwd "$DEPLOY_UID" >/dev/null; then
      useradd -m -s /bin/bash -c 'Plotinium deploy' "$DEPLOY_USER"
      echo "provision: warning: uid ${DEPLOY_UID} is taken by $(getent passwd "$DEPLOY_UID" | cut -d: -f1);" \
        "secret files mounted into containers must be chown ${DEPLOY_UID}:${DEPLOY_UID} by root (RUNBOOK §3)" >&2
    else
      useradd -m -u "$DEPLOY_UID" -s /bin/bash -c 'Plotinium deploy' "$DEPLOY_USER"
    fi
  fi
  passwd -l "$DEPLOY_USER" >/dev/null
  local home ak
  home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
  ak="${home}/.ssh/authorized_keys"
  install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 "${home}/.ssh"
  touch "$ak"
  if [[ -n "$keys_file" ]]; then
    local keys key
    keys="$(read_keys "$keys_file")"
    while IFS= read -r key; do
      grep -qxF "$key" "$ak" || printf '%s\n' "$key" >>"$ak"
    done <<<"$keys"
  fi
  chown "$DEPLOY_USER:$DEPLOY_USER" "$ak"
  chmod 0600 "$ak"
  # Never lock everyone out: the sshd settings below allow only `deploy`, with keys.
  grep -qE '^(ssh-|ecdsa-|sk-)' "$ak" ||
    die "${ak} has no key; rerun with --keys team.pub before hardening sshd"

  # 3. Packages, files and commands exactly as cloud-init would apply them.
  local plan
  plan="$(mktemp)"
  python3 - "$CLOUD_INIT" "$plan" <<'PY'
import grp, os, pwd, shlex, sys, yaml
src, plan = sys.argv[1], sys.argv[2]
with open(src, encoding="utf-8") as fh:
    cfg = yaml.safe_load(fh)
for f in cfg.get("write_files", []):
    path = f["path"]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as out:
        out.write(f.get("content", ""))
    user, _, group = f.get("owner", "root:root").partition(":")
    os.chown(path, pwd.getpwnam(user).pw_uid, grp.getgrnam(group or user).gr_gid)
    os.chmod(path, int(f.get("permissions", "0644"), 8))
    print(f"provision: wrote {path}", file=sys.stderr)
with open(plan, "w", encoding="utf-8") as out:
    out.write("PACKAGES " + " ".join(cfg.get("packages", [])) + "\n")
    for cmd in cfg.get("runcmd", []):
        line = cmd if isinstance(cmd, str) else shlex.join(str(a) for a in cmd)
        out.write("RUNCMD " + line + "\n")
PY
  local packages
  read -r -a packages < <(sed -n 's/^PACKAGES //p' "$plan")
  apt-get install -yq "${packages[@]}"

  # 4. Swap (cloud-init's `swap:` module).
  if ! swapon --show=NAME --noheadings | grep -q .; then
    fallocate -l 2G /swapfile
    chmod 0600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  fi

  # 5. runcmd, in order.
  local line
  while IFS= read -r line; do
    [[ "$line" == RUNCMD\ * ]] || continue
    echo "provision: + ${line#RUNCMD }" >&2
    sh -c "${line#RUNCMD }"
  done <"$plan"
  rm -f "$plan"
  echo "provision: host configured; run 'ops/provision.sh verify', then RUNBOOK §1.4" >&2
}

# --- verify: the provisioning checklist (rebuild drill evidence) -----------------------------------------
fails=0
report() { # report STATUS LABEL
  printf '%-5s %s\n' "$1" "$2"
  [[ "$1" == FAIL ]] && fails=$((fails + 1))
  return 0
}
check() { # check LABEL COMMAND...: PASS when the command succeeds
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then report PASS "$label"; else report FAIL "$label"; fi
}
version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }
in_group() { id -nG "$1" 2>/dev/null | tr ' ' '\n' | grep -qxE "$2"; }
not() { ! "$@"; }

verify() {
  local root=0
  [[ "$(id -u)" -eq 0 ]] && root=1
  fails=0

  # Docker and Compose.
  if command -v docker >/dev/null 2>&1; then
    local cv
    cv="$(docker compose version --short 2>/dev/null || echo 0)"
    cv="${cv#v}"
    check "docker compose ${cv} >= ${COMPOSE_MIN}" version_ge "$cv" "$COMPOSE_MIN"
    check "docker live-restore on" test "$(docker info --format '{{.LiveRestoreEnabled}}' 2>/dev/null)" = true
    check "docker log driver local" test "$(docker info --format '{{.LoggingDriver}}' 2>/dev/null)" = local
  else
    report FAIL "docker is installed"
  fi

  # The deploy user.
  if id "$DEPLOY_USER" >/dev/null 2>&1; then
    check "user ${DEPLOY_USER} has uid ${DEPLOY_UID} (container secret ownership)" test "$(id -u "$DEPLOY_USER")" = "$DEPLOY_UID"
    check "${DEPLOY_USER} is in group docker" in_group "$DEPLOY_USER" docker
    check "${DEPLOY_USER} has no sudo" not in_group "$DEPLOY_USER" 'sudo|admin|wheel'
    if ((root)); then
      check "${DEPLOY_USER} has no usable password" sh -c "passwd -S '${DEPLOY_USER}' | awk '{exit !(\$2 == \"L\" || \$2 == \"LK\" || \$2 == \"NP\")}'"
    else
      report SKIP "password lock (needs root)"
    fi
  else
    report FAIL "user ${DEPLOY_USER} exists"
  fi

  # SSH.
  if ((root)); then
    local sshd
    sshd="$(sshd -T 2>/dev/null || true)"
    check "sshd PermitRootLogin no" grep -qx 'permitrootlogin no' <<<"$sshd"
    check "sshd PasswordAuthentication no" grep -qx 'passwordauthentication no' <<<"$sshd"
    check "sshd AllowUsers ${DEPLOY_USER}" grep -qx "allowusers ${DEPLOY_USER}" <<<"$sshd"
    check "sshd MaxStartups 10:30:60" grep -qx 'maxstartups 10:30:60' <<<"$sshd"
  else
    check "sshd drop-in present" test -r /etc/ssh/sshd_config.d/10-plotinium.conf
    report SKIP "effective sshd settings (needs root: sudo ops/provision.sh verify)"
  fi

  # Kernel.
  check "tcp congestion control bbr" test "$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null)" = bbr
  check "default qdisc fq" test "$(sysctl -n net.core.default_qdisc 2>/dev/null)" = fq
  check "tcp_slow_start_after_idle 0" test "$(sysctl -n net.ipv4.tcp_slow_start_after_idle 2>/dev/null)" = 0
  check "vm.swappiness 10" test "$(sysctl -n vm.swappiness 2>/dev/null)" = 10
  check "swap active" test -n "$(swapon --show=NAME --noheadings 2>/dev/null)"

  # Host firewall (the Hetzner Cloud Firewall is checked from outside, RUNBOOK §1.5).
  if ((root)); then
    local ufw rule
    ufw="$(ufw status 2>/dev/null || true)"
    check "ufw active" grep -q '^Status: active' <<<"$ufw"
    for rule in 22/tcp 80/tcp 443/tcp 443/udp; do
      check "ufw allows ${rule}" grep -qE "^${rule} +ALLOW" <<<"$ufw"
    done
    check "ufw has no other allow rule" test "$(grep -cE ' ALLOW ' <<<"$ufw")" -le 8
  else
    report SKIP "ufw rules (needs root)"
  fi

  # Unattended upgrades.
  local aptcfg
  aptcfg="$(apt-config dump 2>/dev/null || true)"
  check "unattended-upgrades enabled" systemctl is-enabled unattended-upgrades
  check "unattended upgrades scheduled daily" grep -q 'APT::Periodic::Unattended-Upgrade "1"' <<<"$aptcfg"
  check "no automatic reboot" grep -q 'Unattended-Upgrade::Automatic-Reboot "false"' <<<"$aptcfg"

  # Directories and timers.
  local d
  for d in /srv/plotinium /srv/plotinium/secrets /srv/plotinium/state /var/backups/plotinium; do
    check "${d} owned by ${DEPLOY_USER}" test "$(stat -c %U "$d" 2>/dev/null)" = "$DEPLOY_USER"
  done
  check "/srv/plotinium/secrets mode 0700" test "$(stat -c %a /srv/plotinium/secrets 2>/dev/null)" = 700
  check "plotinium-backup.timer enabled" systemctl is-enabled plotinium-backup.timer
  check "plotinium-prune.timer enabled" systemctl is-enabled plotinium-prune.timer

  echo
  if ((fails == 0)); then
    echo "provision: verify: all checks passed"
  else
    echo "provision: verify: ${fails} check(s) failed"
    return 1
  fi
}

cmd="${1:-help}"
[[ $# -gt 0 ]] && shift
case "$cmd" in
  render) render "$@" ;;
  firewall) firewall "$@" ;;
  create) create "$@" ;;
  host) host "$@" ;;
  verify) verify "$@" ;;
  help | -h | --help) usage ;;
  *) usage >&2; exit 64 ;;
esac
