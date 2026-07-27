#!/usr/bin/env bash
set -Eeuo pipefail
umask 0027

if [[ "${AITK_CAPABILITY_MODE:-0}" == "1" ]]; then
  exec python /opt/aitk/scripts/capability_probe.py
fi

required=(AITK_WORKSPACE_ID AITK_CONTROLLER_TOKEN AITK_BROWSER_SIGNING_KEY AITK_EXPIRES_AT AITK_IMAGE_DIGEST AITK_MODEL_MANIFEST_SHA256 PUBLIC_KEY RUNPOD_POD_ID RUNPOD_API_KEY)
for key in "${required[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    echo "Required workspace environment is incomplete: ${key}" >&2
    exit 78
  fi
done

if [[ ! "${PUBLIC_KEY}" =~ ^ssh-ed25519[[:space:]] ]]; then
  echo "PUBLIC_KEY must be an Ed25519 public key." >&2
  exit 78
fi

ssh-keygen -A
install -o root -g root -m 0755 -d /home/aitk/.ssh
printf '%s\n' "${PUBLIC_KEY}" > /home/aitk/.ssh/authorized_keys
chown root:root /home/aitk/.ssh/authorized_keys
chmod 0600 /home/aitk/.ssh/authorized_keys
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256 | awk '{print $2}' > /run/aitk-ssh-fingerprint
chmod 0444 /run/aitk-ssh-fingerprint

install -o aitk -g aitk-workspace -m 0770 -d /run/aitk /workspace/comfy /workspace/comfy/output
/usr/sbin/sshd

runuser -u aitk --preserve-environment -- python /opt/aitk/scripts/bootstrap.py &
bootstrap_pid=$!

terminate_children() {
  kill -TERM "${bootstrap_pid}" 2>/dev/null || true
  /usr/sbin/sshd -t >/dev/null 2>&1 || true
}
trap terminate_children TERM INT

exec runuser -u aitk --preserve-environment -- python /opt/aitk/scripts/sidecar.py
