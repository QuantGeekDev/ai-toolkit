ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG AITK_GIT_COMMIT
ARG AITK_GIT_REMOTE
ARG AITK_DEPENDENCY_LOCK_SHA256
LABEL org.opencontainers.image.source="${AITK_GIT_REMOTE}" \
      org.opencontainers.image.revision="${AITK_GIT_COMMIT}" \
      ai.toolkit.dependency-lock-sha256="${AITK_DEPENDENCY_LOCK_SHA256}"

ENV PYTHONUNBUFFERED=1 \
    PYTHONIOENCODING=utf-8 \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    AITK_TOOLKIT_ROOT=/opt/ai-toolkit \
    AITK_RUNPOD_VOLUME_ROOT=/runpod-volume/aitk \
    AITK_REQUIRE_H100=1 \
    AITK_SOURCE_COMMIT=${AITK_GIT_COMMIT} \
    AITK_DEPENDENCY_LOCK_SHA256=${AITK_DEPENDENCY_LOCK_SHA256}

WORKDIR /opt/ai-toolkit
COPY requirements.txt requirements_base.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY . /opt/ai-toolkit
RUN python -m pip install --no-cache-dir -r remote/runpod/requirements.txt

WORKDIR /opt/ai-toolkit/remote/runpod
CMD ["python", "-u", "handler.py"]
