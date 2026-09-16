#!/usr/bin/env bash
set -euo pipefail
read -r PW
[ -n "$PW" ]
printf 'yulia:%s\n' "$PW" | chpasswd
faillock --user yulia --reset 2>/dev/null || true
passwd -S yulia
if command -v pamtester >/dev/null 2>&1; then
  if printf '%s\n' "$PW" | pamtester xrdp-sesman yulia authenticate >/dev/null 2>&1; then
    echo PAM_AUTH_OK
  else
    echo PAM_AUTH_FAIL
    exit 21
  fi
fi
systemctl is-active xrdp
ss -ltn | grep ':3389' >/dev/null && echo XRDP_3389_LISTENING
echo PASSWORD_CHANGED_OK
