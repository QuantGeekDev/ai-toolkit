FROM docker.io/runpod/pytorch@sha256:4d1721e62b56d345c83b4fd6090664be6daf9312caab5b2e76f23d8231941851

ARG TARGETARCH
ARG REQUIREMENTS_LOCK_SHA256=unknown
RUN test "${TARGETARCH:-amd64}" = "amd64"

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    AITK_BASE_IMAGE_DIGEST=docker.io/runpod/pytorch@sha256:4d1721e62b56d345c83b4fd6090664be6daf9312caab5b2e76f23d8231941851 \
    COMFYUI_COMMIT=4800e78518ebb1f2a9443ea5418edbff6c3935f9

LABEL org.opencontainers.image.title="AI Toolkit ephemeral Krea 2 Turbo ComfyUI" \
      ai.toolkit.base-image="docker.io/runpod/pytorch@sha256:4d1721e62b56d345c83b4fd6090664be6daf9312caab5b2e76f23d8231941851" \
      ai.toolkit.comfyui-commit="4800e78518ebb1f2a9443ea5418edbff6c3935f9" \
      ai.toolkit.requirements-lock-sha256="${REQUIREMENTS_LOCK_SHA256}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git openssh-server tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt
COPY comfy-requirements.lock /opt/aitk/comfy-requirements.lock
COPY requirements.lock /opt/aitk/requirements.lock
RUN git clone --filter=blob:none https://github.com/comfyanonymous/ComfyUI.git /opt/ComfyUI \
    && git -C /opt/ComfyUI checkout "${COMFYUI_COMMIT}" \
    && git -C /opt/ComfyUI remote remove origin \
    && python -m pip install --no-cache-dir -r /opt/aitk/comfy-requirements.lock \
    && python -m pip install --no-cache-dir -r /opt/aitk/requirements.lock

RUN groupadd --system aitk-workspace \
    && useradd --system --create-home --home-dir /home/aitk --shell /usr/sbin/nologin --gid aitk-workspace aitk \
    && useradd --system --home-dir /incoming --shell /usr/sbin/nologin --gid aitk-workspace aitk-upload \
    && mkdir -p /run/sshd /srv/sftp/incoming /home/aitk/.ssh /workspace/comfy \
    && chown root:root /srv/sftp \
    && chmod 0755 /srv/sftp \
    && chown aitk-upload:aitk-workspace /srv/sftp/incoming \
    && chmod 0770 /srv/sftp/incoming \
    && chown -R aitk:aitk-workspace /workspace/comfy /home/aitk

COPY sshd_config /etc/ssh/sshd_config
COPY model-manifest.json /opt/aitk/model-manifest.json
COPY scripts /opt/aitk/scripts
COPY custom_nodes/aitk_activity /opt/ComfyUI/custom_nodes/aitk_activity
COPY entrypoint.sh /opt/aitk/entrypoint.sh
RUN find /opt/aitk /opt/ComfyUI/custom_nodes/aitk_activity -type f -exec chmod 0444 {} \; \
    && chmod 0555 /opt/aitk/entrypoint.sh /opt/aitk/scripts/*.py

EXPOSE 8188 22
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/opt/aitk/entrypoint.sh"]
