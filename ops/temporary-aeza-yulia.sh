#!/usr/bin/env bash
set -euo pipefail
PASS_HASH="${1:?password hash required}"
ARCH="/root/deleted-user-archive/$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$ARCH"
chmod 700 /root/deleted-user-archive "$ARCH"

for u in alena elena; do
  if id "$u" >/dev/null 2>&1; then
    pkill -u "$u" 2>/dev/null || true
    if [ -d "/home/$u" ]; then
      tar -C /home -czf "$ARCH/${u}-home.tgz" "$u"
      chmod 600 "$ARCH/${u}-home.tgz"
    fi
    userdel "$u"
    rm -rf "/home/$u"
    echo "$u|DELETED"
  else
    echo "$u|ALREADY_ABSENT"
  fi
done

if [ -f /root/users.txt ]; then
  sed -i -E '/^(alena|elena):/d' /root/users.txt
  chmod 600 /root/users.txt
fi

if ! id yulia >/dev/null 2>&1; then
  useradd -m -s /bin/bash -k /etc/skel yulia
fi
usermod -p "$PASS_HASH" yulia
passwd -u yulia >/dev/null 2>&1 || true
faillock --user yulia --reset 2>/dev/null || true

mkdir -p /home/yulia/Desktop /home/yulia/Documents /home/yulia/Downloads /home/yulia/thinclient_drives
printf 'startxfce4\n' > /home/yulia/.xsession
if [ -f /home/natalia/.xsessionrc ]; then cp -f /home/natalia/.xsessionrc /home/yulia/.xsessionrc; fi
if [ -d /etc/skel/.config ]; then cp -a /etc/skel/.config /home/yulia/; fi
if [ -f /usr/share/applications/google-chrome.desktop ]; then cp -f /usr/share/applications/google-chrome.desktop /home/yulia/Desktop/; fi
chown -R yulia:yulia /home/yulia
chmod 700 /home/yulia
chmod 644 /home/yulia/.xsession
[ ! -f /home/yulia/.xsessionrc ] || chmod 644 /home/yulia/.xsessionrc

for u in alena elena yulia; do
  if id "$u" >/dev/null 2>&1; then echo "$u|PRESENT"; else echo "$u|ABSENT"; fi
done
id yulia
passwd -S yulia
systemctl is-enabled xrdp || true
systemctl is-active xrdp
ss -ltn | grep ':3389' || true
echo "ARCHIVE=$ARCH"
