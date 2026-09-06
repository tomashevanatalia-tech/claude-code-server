#!/bin/bash
set -e

# ============================================================================
# VSCode Cloud IDE - Railway Entrypoint
# Handles permission fix and optional user switching
# ============================================================================

echo "╔══════════════════════════════════════════════════════════════════════╗"
echo "║           VSCode Cloud IDE - Claude Code & Node.js Ready            ║"
echo "╚══════════════════════════════════════════════════════════════════════╝"
echo ""

# ============================================================================
# CONFIGURABLE PATHS AND USER
# ============================================================================

CLAUDER_HOME="${CLAUDER_HOME:-/home/clauder}"
CLAUDER_UID="${CLAUDER_UID:-1000}"
CLAUDER_GID="${CLAUDER_GID:-1000}"

# RUN_AS_USER: Defaults to "clauder" for non-root. Set to "root" if needed.
RUN_AS_USER="${RUN_AS_USER:-clauder}"

export HOME="$CLAUDER_HOME"
export XDG_DATA_HOME="$CLAUDER_HOME/.local/share"
export XDG_CONFIG_HOME="$CLAUDER_HOME/.config"
export XDG_CACHE_HOME="$CLAUDER_HOME/.cache"
export XDG_STATE_HOME="$CLAUDER_HOME/.local/state"

# PATH: Include all possible locations for installed tools
# - ~/.local/bin: pip user installs, pipx, local scripts
# - ~/.npm-global/bin: npm global installs (non-root)
# - /usr/local/bin: system-wide installs
# - /usr/lib/node_modules/.bin: npm global installs (root/sudo)
export PATH="$CLAUDER_HOME/.local/bin:$CLAUDER_HOME/.npm-global/bin:$CLAUDER_HOME/.local/node/bin:$CLAUDER_HOME/.claude/local:$CLAUDER_HOME/node_modules/.bin:/usr/local/bin:/usr/bin:/usr/lib/node_modules/.bin:/usr/lib/code-server/lib/vscode/bin/remote-cli:$PATH"

echo "→ Initial user: $(whoami) (UID: $(id -u))"
echo "→ RUN_AS_USER: $RUN_AS_USER"
echo "→ HOME: $HOME"

# ============================================================================
# DIRECTORY CREATION AND PERMISSION FIX
# ============================================================================

if [ "$(id -u)" = "0" ]; then
    echo ""
    echo "→ Running setup as root..."
    
    # Create directories if they don't exist
    mkdir -p "$XDG_DATA_HOME" \
             "$XDG_CONFIG_HOME" \
             "$XDG_CACHE_HOME" \
             "$XDG_STATE_HOME" \
             "$HOME/.local/bin" \
             "$HOME/.local/node" \
             "$HOME/.claude" \
             "$HOME/.gemini" \
             "$HOME/entrypoint.d" \
             "$HOME/workspace" \
             "$XDG_DATA_HOME/code-server/extensions" \
             "$XDG_CONFIG_HOME/code-server" 2>/dev/null || true

    # ========================================================================
    # PERSISTENCE BOOTSTRAP
    #
    # The Railway volume is not always mounted at $CLAUDER_HOME. When it is
    # mounted somewhere else (RAILWAY_VOLUME_MOUNT_PATH), the whole home
    # directory sits on the container's ephemeral layer and every redeploy
    # wipes it: installed extensions, CLI logins, editor settings and the
    # workspace itself. The symlink block further down assumes $CLAUDER_HOME
    # *is* the volume, so it silently protects nothing in that setup.
    #
    # Move those paths onto the volume once and link them back, so a redeploy
    # keeps them. PERSIST_ROOT overrides the location; PERSIST_DISABLE=1 turns
    # the whole thing off.
    # ========================================================================

    if [ -z "${PERSIST_DISABLE:-}" ] && [ -z "${PERSIST_ROOT:-}" ] \
       && [ -n "${RAILWAY_VOLUME_MOUNT_PATH:-}" ] \
       && [ "$RAILWAY_VOLUME_MOUNT_PATH" != "$CLAUDER_HOME" ] \
       && [ -d "$RAILWAY_VOLUME_MOUNT_PATH" ]; then
        PERSIST_ROOT="$RAILWAY_VOLUME_MOUNT_PATH/clauder-home"
    fi

    if [ -n "${PERSIST_ROOT:-}" ]; then
        echo "→ Persisting home state under $PERSIST_ROOT..."
        mkdir -p "$PERSIST_ROOT" 2>/dev/null || true

        for item in workspace .claude .codex .gemini .config .npm-global \
                    .local/bin \
                    .local/share/code-server/extensions \
                    .local/share/code-server/User \
                    .claude.json .gitconfig; do
            src="$CLAUDER_HOME/$item"
            dst="$PERSIST_ROOT/$item"

            # Already linked by an earlier boot - nothing to do.
            [ -L "$src" ] && continue

            mkdir -p "$(dirname "$dst")" 2>/dev/null || true

            # The volume wins. It only gets seeded when it has nothing yet.
            if [ ! -e "$dst" ]; then
                if [ -e "$src" ]; then
                    mv "$src" "$dst" 2>/dev/null || continue
                else
                    case "$item" in
                        *.json|*.gitconfig) continue ;;
                        *) mkdir -p "$dst" 2>/dev/null || continue ;;
                    esac
                fi
            fi

            rm -rf "$src" 2>/dev/null || true
            mkdir -p "$(dirname "$src")" 2>/dev/null || true
            ln -sfn "$dst" "$src" 2>/dev/null && echo "  ✓ $item"
        done

        chown -R "$CLAUDER_UID:$CLAUDER_GID" "$PERSIST_ROOT" 2>/dev/null || true
    fi
    
    # ========================================================================
    # SHELL PROFILE SETUP
    # ========================================================================
    
    PROFILE_FILE="$HOME/.bashrc"
    
    if [ ! -f "$PROFILE_FILE" ] || ! grep -q '.npm-global' "$PROFILE_FILE" 2>/dev/null; then
        echo "→ Setting up shell profile..."
        cat >> "$PROFILE_FILE" << 'PROFILE'

# ============================================================================
# VSCode Cloud IDE - PATH Configuration
# ============================================================================
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.local/node/bin:$HOME/.claude/local:$PATH"

# npm global prefix for non-root installs
export NPM_CONFIG_PREFIX="$HOME/.npm-global"

# Claude Code alias with --dangerously-skip-permissions
alias claude-auto='claude --dangerously-skip-permissions'
PROFILE
        
        # Create npm global directory
        mkdir -p "$HOME/.npm-global/bin" 2>/dev/null || true
        
        echo "  ✓ Shell profile configured"
    fi
    
    # Also set up .profile for login shells
    if [ ! -f "$HOME/.profile" ] || ! grep -q '.local/bin' "$HOME/.profile" 2>/dev/null; then
        cat >> "$HOME/.profile" << 'PROFILE'

# Load .bashrc for interactive shells
if [ -f "$HOME/.bashrc" ]; then
    . "$HOME/.bashrc"
fi
PROFILE
    fi
    
    # ========================================================================
    # USER SWITCHING (if RUN_AS_USER=clauder)
    # ========================================================================
    
    if [ "$RUN_AS_USER" = "clauder" ]; then
        echo "→ Fixing permissions for clauder user (UID: $CLAUDER_UID)..."
        chown -R "$CLAUDER_UID:$CLAUDER_GID" "$CLAUDER_HOME" 2>/dev/null || true
        echo "  ✓ Permissions fixed"
        
        # Check if gosu is available
        if command -v gosu &>/dev/null; then
            echo "→ Switching to clauder user via gosu..."
            exec gosu "$CLAUDER_UID:$CLAUDER_GID" "$0" "$@"
        else
            echo "  ⚠ gosu not found, staying as root"
        fi
    else
        echo "→ Staying as root (set RUN_AS_USER=clauder to switch)"
        
        # Create symlinks from /root to volume for persistence
        mkdir -p /root/.local 2>/dev/null || true
        for dir in ".local/share" ".local/bin" ".local/node" ".config" ".cache" ".claude" ".gemini"; do
            target="$CLAUDER_HOME/$dir"
            link="/root/$dir"
            if [ -d "$target" ] && [ ! -L "$link" ]; then
                rm -rf "$link" 2>/dev/null || true
                mkdir -p "$(dirname "$link")" 2>/dev/null || true
                ln -sf "$target" "$link" 2>/dev/null || true
            fi
        done
        echo "  ✓ Root directories symlinked to $CLAUDER_HOME"
    fi
fi

# ============================================================================
# RUNNING AS FINAL USER
# ============================================================================

echo ""
echo "→ Running as: $(whoami) (UID: $(id -u))"

# ============================================================================
# FIRST RUN SETUP
# ============================================================================

FIRST_RUN_MARKER="$XDG_DATA_HOME/.vscode-cloud-initialized"

if [ ! -f "$FIRST_RUN_MARKER" ]; then
    echo "→ First run detected - initializing..."

    if [ ! -f "$HOME/workspace/README.md" ]; then
        cat > "$HOME/workspace/README.md" << 'WELCOME'
# Welcome to VSCode Cloud IDE

Your cloud development environment is ready!

## Features

- **Claude Code CLI** - Pre-installed and ready to use
- **Node.js 20 LTS** - Pre-installed and ready to use
- **Persistent Extensions** - Install once, keep forever
- **Full Terminal** - npm, git, and more

## Quick Start

```bash
# Start Claude Code (with auto-accept for automation)
claude --dangerously-skip-permissions

# Or use the alias
claude-auto

# Interactive mode
claude
```

You'll need to authenticate with your Anthropic API key on first use.

## Configuration

Set these environment variables in Railway:

- `RUN_AS_USER=clauder` - Run as non-root user (recommended for Claude)
- `RUN_AS_USER=root` - Stay as root

Happy coding! 🚀
WELCOME
    fi

    touch "$FIRST_RUN_MARKER" 2>/dev/null || true
    echo "  ✓ Initialization complete"
fi

# Resolve and canonicalize all three listening ports before patching the
# extension. Keeping them distinct prevents the public proxy, code-server and
# the Antigravity hub from ever binding or routing to one another by mistake.
canonical_port() {
    local name="$1"
    local value="$2"
    local fallback="$3"
    local minimum="$4"

    case "$value" in
        ""|*[!0-9]*|??????*)
            echo "  ⚠ Invalid $name; using $fallback" >&2
            value="$fallback"
            ;;
    esac
    value=$((10#$value))
    if [ "$value" -lt "$minimum" ] || [ "$value" -gt 65535 ]; then
        echo "  ⚠ Invalid $name; using $fallback" >&2
        value="$fallback"
    fi
    printf '%s' "$value"
}

PORT="$(canonical_port PORT "${PORT:-8080}" 8080 1024)"
ANTIGRAVITY_SERVER_PORT="$(canonical_port ANTIGRAVITY_SERVER_PORT "${ANTIGRAVITY_SERVER_PORT:-38000}" 38000 1024)"
CODE_SERVER_INTERNAL_PORT="$(canonical_port CODE_SERVER_INTERNAL_PORT "${CODE_SERVER_INTERNAL_PORT:-8081}" 8081 1024)"

if [ "$CODE_SERVER_INTERNAL_PORT" = "$PORT" ] || [ "$CODE_SERVER_INTERNAL_PORT" = "$ANTIGRAVITY_SERVER_PORT" ]; then
    for candidate in 8081 8082 8083; do
        if [ "$candidate" != "$PORT" ] && [ "$candidate" != "$ANTIGRAVITY_SERVER_PORT" ]; then
            echo "  ⚠ CODE_SERVER_INTERNAL_PORT collides with a reserved port; using $candidate"
            CODE_SERVER_INTERNAL_PORT="$candidate"
            break
        fi
    done
fi
if [ "$ANTIGRAVITY_SERVER_PORT" = "$PORT" ] || [ "$ANTIGRAVITY_SERVER_PORT" = "$CODE_SERVER_INTERNAL_PORT" ]; then
    for candidate in 38000 38001 38002; do
        if [ "$candidate" != "$PORT" ] && [ "$candidate" != "$CODE_SERVER_INTERNAL_PORT" ]; then
            echo "  ⚠ ANTIGRAVITY_SERVER_PORT collides with a reserved port; using $candidate"
            ANTIGRAVITY_SERVER_PORT="$candidate"
            break
        fi
    done
fi
export PORT CODE_SERVER_INTERNAL_PORT ANTIGRAVITY_SERVER_PORT

# Reinstall the reviewed VSIX from the immutable image on every boot. This
# makes image upgrades reach an existing extensions volume and prevents a
# Marketplace update from silently replacing the pinned release. The narrow
# compatibility patch selects the stable internal port without touching the
# user's JSONC settings file.
if [ -z "${ANTIGRAVITY_EXTENSION_VERSION:-}" ]; then
    echo "  ⚠ Antigravity extension version is missing; the base IDE will still start"
else
    if ! /usr/local/lib/sync-antigravity-extension.sh \
         "$XDG_DATA_HOME/code-server/extensions" \
         "/opt/antigravity/google-antigravity-$ANTIGRAVITY_EXTENSION_VERSION.vsix" \
         "$ANTIGRAVITY_EXTENSION_VERSION" \
         "$ANTIGRAVITY_SERVER_PORT" \
         /usr/local/lib/patch-antigravity-extension.sh \
         /tmp/antigravity-extension-quarantine; then
        echo "  ⚠ Antigravity extension restore failed; the base IDE will still start"
    fi
fi

# ============================================================================
# ENVIRONMENT VERIFICATION
# ============================================================================

echo ""
echo "Environment:"

# Node.js - show source
if [ -x "$CLAUDER_HOME/.local/node/bin/node" ]; then
    echo "  → Node.js: $(node --version 2>/dev/null) [volume]"
else
    echo "  → Node.js: $(node --version 2>/dev/null || echo 'not found') [image]"
fi

# npm
echo "  → npm: $(npm --version 2>/dev/null || echo 'not found')"

# git
echo "  → git: $(git --version 2>/dev/null | cut -d' ' -f3 || echo 'not found')"

# Claude Code - show source
if [ -x "$CLAUDER_HOME/.local/bin/claude" ]; then
    echo "  → claude: $(claude --version 2>/dev/null || echo 'installed') [volume ~/.local/bin]"
elif [ -x "$CLAUDER_HOME/.claude/local/claude" ]; then
    echo "  → claude: $(claude --version 2>/dev/null || echo 'installed') [volume ~/.claude/local]"
elif command -v claude &>/dev/null; then
    echo "  → claude: $(claude --version 2>/dev/null || echo 'installed') [image]"
else
    echo "  → claude: not installed"
fi

# Extensions count
if [ -d "$XDG_DATA_HOME/code-server/extensions" ]; then
    EXT_COUNT=$(find "$XDG_DATA_HOME/code-server/extensions" -maxdepth 1 -type d 2>/dev/null | wc -l)
    EXT_COUNT=$((EXT_COUNT - 1))
    if [ $EXT_COUNT -gt 0 ]; then
        echo "  → Extensions: $EXT_COUNT installed"
    fi
fi

# ============================================================================
# CUSTOM STARTUP SCRIPTS
# ============================================================================

if [ -d "$HOME/entrypoint.d" ]; then
    for script in "$HOME/entrypoint.d"/*.sh; do
        if [ -f "$script" ] && [ -x "$script" ]; then
            echo ""
            echo "Running: $(basename "$script")"
            "$script" || echo "  ⚠ Script exited with code $?"
        fi
    done
fi

# ============================================================================
# START CODE-SERVER
# ============================================================================

# Branding customization
APP_NAME="${APP_NAME:-Claude Code Server}"
WELCOME_TEXT="${WELCOME_TEXT:-Welcome to Claude Code Server}"

echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo "Starting $APP_NAME as $(whoami)..."
echo "════════════════════════════════════════════════════════════════════════"
echo ""

exec dumb-init /usr/bin/node /usr/local/lib/antigravity-proxy.js \
    /usr/bin/code-server \
    --bind-addr "127.0.0.1:$CODE_SERVER_INTERNAL_PORT" \
    --app-name "$APP_NAME" \
    --welcome-text "$WELCOME_TEXT" \
    "$CLAUDER_HOME/workspace"
