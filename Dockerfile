# ============================================================================
# Claude Code Server - Browser-based VS Code with AI Coding Assistants
# https://github.com/sphinxcode/claude-code-server
# ============================================================================

FROM codercom/code-server:4.134.0

USER root

# ============================================================================
# SYSTEM DEPENDENCIES
# Install gosu, Node.js 22, Python/uv, and essential tools
# Cache bust: 2026-08-26-v8
# ============================================================================

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        gosu \
        nodejs \
        python3 \
        python3-pip \
        python3-venv \
        pipx \
        git \
        curl \
        wget \
        unzip \
        jq \
        htop \
        vim \
        nano \
        ripgrep \
    && pip3 install --break-system-packages uv \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# ============================================================================
# PERSISTENCE CONFIGURATION
# Default to /home/clauder for new deployments
# ============================================================================

ENV HOME=/home/clauder
ENV USER=clauder

# XDG Base Directory Specification
ENV XDG_DATA_HOME=/home/clauder/.local/share
ENV XDG_CONFIG_HOME=/home/clauder/.config
ENV XDG_CACHE_HOME=/home/clauder/.cache
ENV XDG_STATE_HOME=/home/clauder/.local/state

# PATH: Volume paths FIRST (user installs), image paths LAST (fallbacks)
ENV PATH="/home/clauder/.local/bin:/home/clauder/.local/node/bin:/home/clauder/.claude/local:/home/clauder/node_modules/.bin:/usr/local/bin:/usr/bin:/usr/lib/code-server/lib/vscode/bin/remote-cli:${PATH}"

# Custom startup scripts directory
ENV ENTRYPOINTD=/home/clauder/entrypoint.d

# ============================================================================
# USER SETUP
# Create clauder user (UID 1000) with passwordless sudo
# - Stays non-root for Claude YOLO mode compatibility
# - Can use sudo for package installs (apt, npm -g, pip, etc.)
# ============================================================================

# Install sudo if not present, then configure user
RUN apt-get update && apt-get install -y sudo \
    && rm -rf /var/lib/apt/lists/* \
    && (groupadd -g 1000 clauder 2>/dev/null || true) \
    && (useradd -m -s /bin/bash -u 1000 -g 1000 clauder 2>/dev/null || usermod -l clauder -d /home/clauder -m coder 2>/dev/null || true) \
    && (groupmod -n clauder coder 2>/dev/null || true) \
    && mkdir -p /etc/sudoers.d \
    && echo "clauder ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/clauder \
    && chmod 0440 /etc/sudoers.d/clauder \
    && chown root:root /etc/sudoers.d/clauder

# ============================================================================
# DIRECTORY SETUP
# ============================================================================

RUN mkdir -p \
    /home/clauder/.local/share \
    /home/clauder/.config \
    /home/clauder/.cache \
    /home/clauder/.local/state \
    /home/clauder/.local/bin \
    /home/clauder/.local/node \
    /home/clauder/.claude \
    /home/clauder/.gemini \
    /home/clauder/entrypoint.d \
    /home/clauder/workspace \
    && chown -R 1000:1000 /home/clauder

# Copy our custom entrypoint (replaces base image's entrypoint)
COPY railway-entrypoint.sh /usr/bin/railway-entrypoint.sh
COPY antigravity-proxy.js /usr/local/lib/antigravity-proxy.js
COPY ci/patch-antigravity-extension.sh /usr/local/lib/patch-antigravity-extension.sh
COPY ci/sync-antigravity-extension.sh /usr/local/lib/sync-antigravity-extension.sh
COPY ci/reconcile-antigravity-metadata.js /usr/local/lib/reconcile-antigravity-metadata.js
RUN chmod +x \
    /usr/bin/railway-entrypoint.sh \
    /usr/local/lib/antigravity-proxy.js \
    /usr/local/lib/patch-antigravity-extension.sh \
    /usr/local/lib/sync-antigravity-extension.sh \
    /usr/local/lib/reconcile-antigravity-metadata.js

# ============================================================================
# CLAUDE CODE CLI INSTALLATION
# Install globally via npm - this is the official package
# ============================================================================

RUN npm install -g @anthropic-ai/claude-code \
    && echo "Claude CLI installed: $(claude --version 2>/dev/null || echo 'checking...')"

# ============================================================================
# GOOGLE ANTIGRAVITY IDE EXTENSION
# Run the official workspace extension and its `agy --hub` backend inside the
# cloud container. Pin both the release and digest: Marketplace `latest` must
# never change a production image without review.
# ============================================================================

ARG ANTIGRAVITY_EXTENSION_VERSION=1.2.0
ARG ANTIGRAVITY_EXTENSION_SHA256=43b6001a2e0ec5510ad8fb2faac7c0e755199e7f2b879ba76d717e9aecf323d3
ENV ANTIGRAVITY_EXTENSION_VERSION=${ANTIGRAVITY_EXTENSION_VERSION}
ENV ANTIGRAVITY_SERVER_PORT=38000

RUN mkdir -p /opt/antigravity \
    && antigravity_vsix="/opt/antigravity/google-antigravity-${ANTIGRAVITY_EXTENSION_VERSION}.vsix" \
    && curl --compressed --fail --silent --show-error --location --retry 3 \
        "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/Google/vsextensions/google-antigravity/${ANTIGRAVITY_EXTENSION_VERSION}/vspackage" \
        --output "$antigravity_vsix" \
    && echo "${ANTIGRAVITY_EXTENSION_SHA256}  ${antigravity_vsix}" | sha256sum --check --strict \
    && code-server \
        --extensions-dir "$XDG_DATA_HOME/code-server/extensions" \
        --install-extension "$antigravity_vsix" \
        --force \
    && /usr/local/lib/patch-antigravity-extension.sh \
        "$XDG_DATA_HOME/code-server/extensions/google.google-antigravity-${ANTIGRAVITY_EXTENSION_VERSION}" \
        "$ANTIGRAVITY_SERVER_PORT" \
    && chown -R 1000:1000 /home/clauder

# ============================================================================
# RUNTIME
# Stay as root - entrypoint handles user switching based on RUN_AS_USER
# ============================================================================

WORKDIR /home/clauder/workspace
EXPOSE 8080

# Use our entrypoint which calls code-server directly
ENTRYPOINT ["/usr/bin/railway-entrypoint.sh"]
