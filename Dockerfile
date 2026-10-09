# Standard: Node 22 harness + Python kernel venv with Prime Agent's runtime.
# Every input is pinned: the base image by digest, Python packages by sha256
# (docker/requirements.txt), prime-agent-runtime by full git commit, npm
# packages by package-lock.json integrity hashes. Debian packages come from
# the base image's bookworm sources; the installed versions are recorded in
# /opt/standard/manifest/ and checked below where they matter.

ARG BASE_IMAGE=node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# ---- builder: kernel venv and node_modules ----------------------------------
FROM ${BASE_IMAGE} AS builder

ARG PRIME_AGENT_COMMIT=afe8d14c4526cf492c4ab17f8eb3e150d329fe8b

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1

# Build prime-agent-runtime's wheel from the pinned commit with a hashed,
# pinned hatchling. The build venv stays in this stage.
COPY docker/build-requirements.txt /tmp/build-requirements.txt
RUN python3 -m venv /tmp/build-venv \
    && /tmp/build-venv/bin/pip install --require-hashes --no-deps -r /tmp/build-requirements.txt \
    && git clone --filter=blob:none --no-checkout https://github.com/PrimeIntellect-ai/prime-agent /tmp/prime-agent \
    && git -C /tmp/prime-agent checkout --quiet "${PRIME_AGENT_COMMIT}" \
    && test "$(git -C /tmp/prime-agent rev-parse HEAD)" = "${PRIME_AGENT_COMMIT}" \
    && /tmp/build-venv/bin/pip wheel --no-deps --no-build-isolation \
      --wheel-dir /tmp/wheels /tmp/prime-agent/prime-agent-runtime

# The runtime venv: hashed dependencies, then the wheel built above.
COPY docker/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/standard/venv \
    && /opt/standard/venv/bin/pip install --require-hashes --no-deps -r /tmp/requirements.txt \
    && /opt/standard/venv/bin/pip install --no-deps --no-index /tmp/wheels/prime_agent_runtime-*.whl \
    && /opt/standard/venv/bin/pip check

WORKDIR /opt/standard
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- runtime ----------------------------------------------------------------
FROM ${BASE_IMAGE}

ARG PRIME_AGENT_COMMIT=afe8d14c4526cf492c4ab17f8eb3e150d329fe8b

LABEL org.opencontainers.image.source="https://github.com/standard-co/harness" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.description="Standard: RLM and Python execution inside Pi Durable" \
      co.standard.prime-agent-commit="${PRIME_AGENT_COMMIT}"

# python3 only: the venv's interpreter is the system one at /usr/bin/python3.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/standard/venv /opt/standard/venv
COPY --from=builder /opt/standard/node_modules /opt/standard/node_modules
COPY package.json package-lock.json LICENSE README.md /opt/standard/
COPY bin /opt/standard/bin
COPY src /opt/standard/src

ENV STANDARD_PYTHON=/opt/standard/venv/bin/python \
    PYTHONDONTWRITEBYTECODE=1

# Build-time checks: fail the build if any pinned piece drifts.
RUN python3 --version 2>&1 | grep -E "^Python 3\.11\." \
    && node --version | grep -E "^v22\." \
    && "${STANDARD_PYTHON}" -c "import rlm, dill; assert dill.__version__ == '0.4.1', dill.__version__" \
    && echo '{"type":"shutdown"}' | "${STANDARD_PYTHON}" -m rlm.repl | grep -F '"event":"ready","protocol":3' \
    && { node --experimental-strip-types /opt/standard/bin/standard.ts 2>&1 || true; } | grep -F "usage: standard run"

# A plain-text record of what is inside, for review.
RUN mkdir -p /opt/standard/manifest \
    && echo "prime-agent-runtime ${PRIME_AGENT_COMMIT}" > /opt/standard/manifest/prime-agent.txt \
    && "${STANDARD_PYTHON}" -m pip freeze --all > /opt/standard/manifest/python.txt \
    && dpkg-query -W -f '${Package} ${Version}\n' > /opt/standard/manifest/debian.txt \
    && node --version > /opt/standard/manifest/node.txt

# Non-root user with a writable /work. State defaults to /work/.standard;
# mount a volume there to keep it.
RUN useradd --create-home --uid 10001 --user-group standard \
    && mkdir -p /work/.standard \
    && chown -R standard:standard /work

USER standard
WORKDIR /work
ENTRYPOINT ["node", "--experimental-strip-types", "/opt/standard/bin/standard.ts"]
