# Claude Code Server

![Claude Code Server Logo](https://raw.githubusercontent.com/sphinxcode/claude-code-server/refs/heads/main/public/claude-code-server-logo.png)

**Browser-based VS Code with Claude Code and Google Antigravity pre-installed**

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/claude-code-server)

![Mobile Mockup](https://raw.githubusercontent.com/sphinxcode/claude-code-server/refs/heads/main/public/iphone_mockup.png)

Deploy a full VS Code development environment in the cloud with Claude Code CLI ready to go. Access it from any browser, on any device. Code with AI assistance anywhere.

---

## Features

- **Claude Code CLI Pre-installed** – Start AI-assisted coding immediately with `claude` or `claude-auto` (YOLO mode)
- **Google Antigravity Embedded** – Use the official Antigravity agent, plans, subagents, and inline diffs from a dedicated sidebar
- **Browser-Based VS Code** – Full IDE experience accessible from any device
- **Persistent Storage** – Your extensions, agent sign-ins, settings, and projects survive redeploys
- **Non-Root Security** – Runs as the `clauder` user with optional sudo access
- **One-Click Deploy** – Deploy to Railway in 60 seconds

---

## Quick Start

### Deploy to Railway

Click the button above, or:

1. Go to [Railway Templates](https://railway.com/templates)
2. Search for "Claude Code Server"
3. Click **Deploy** and set your `PASSWORD`
4. Attach a volume to `/home/clauder`
5. Open the generated domain in your browser

### First Login

1. Enter the password you set
2. Open the Antigravity icon in the Activity Bar and sign in with your Google account
3. In Antigravity settings, review the interaction-data preference before opening private code
4. Open the terminal in VS Code and run `claude` to use Claude Code

Antigravity runs its `agy --hub` backend inside the same cloud container as
code-server. Its binary, authentication, conversations, and customizations are
stored under the persistent `~/.gemini` directory. The extension is pinned to a
reviewed release, is restored from the image on every boot, and does not
replace code-server's Open VSX marketplace. A checked compatibility patch makes
the extension honor the container's fixed internal hub port without modifying
the user's JSONC editor settings. Other Antigravity extension versions are
moved to a bounded three-copy quarantine under `/tmp` so an unreviewed update
cannot silently take precedence over the pinned build. The quarantine is
discarded when the container is replaced; authentication and conversation data
under the persistent `~/.gemini` directory are unaffected.

The container reserves internal port `38000` for Antigravity and places its UI
behind code-server's authenticated `/web/38000/` route. The image publishes
only the outer IDE port; Railway routes that single port and does not publish
the hub port. A small compatibility proxy preserves Antigravity's root-relative
assets and WebSocket calls so the official VS Code webview renders inside the
cloud IDE without a separate public endpoint for the agent backend. The hub
answers loopback callers only, so the proxy hands its traffic to an internal
relay that rewrites the `Host` header on that last hop; code-server still sees
the browser's real `Host` and `Origin`, which its authenticated proxy routes
check against each other. The pinned
extension's loopback target is checked in CI, and the cloud compatibility test
confirmed that its downloaded `agy` hub listens on `127.0.0.1`.

The proxy intentionally removes `PORT` only from the code-server child process so
integrated-terminal apps do not accidentally collide with Railway's IDE entry
listener. `CLOUD_IDE_EXTERNAL_PORT` contains that entry port for diagnostics;
apps opened from the IDE should choose their own port and use the authenticated
`/web/<port>/` forwarding route.

> Google documents the extension for Visual Studio Code, not code-server. This
> image validates the official VSIX and runs it as a server-side workspace
> extension, but authentication and webview compatibility should be checked
> after each Antigravity or code-server upgrade. The compatibility layer mounts
> worker and service-worker entry URLs, but cannot rewrite root-absolute network
> calls made inside an isolated worker; an upgraded UI that introduces those
> calls needs an additional compatibility check before its version is pinned.

> Do not connect Antigravity MCP servers directly to production databases.
> Prefer scoped GitHub and observability integrations, and keep credentials out
> of workspace-level `.agents/mcp_config.json` files.

---

## Configuration

### Required Variables

| Variable   | Description                    |
| ---------- | ------------------------------ |
| `PASSWORD` | Login password for the web IDE |

### Optional Variables

| Variable       | Default                         | Description                           |
| -------------- | ------------------------------- | ------------------------------------- |
| `CLAUDER_HOME` | `/home/clauder`                 | Volume mount path                     |
| `RUN_AS_USER`  | `clauder`                       | Set to `root` if you need root access |
| `APP_NAME`     | `Claude Code Server`            | Login page title                      |
| `WELCOME_TEXT` | `Welcome to Claude Code Server` | Login page message                    |

### Volume Configuration

> ⚠️ **CRITICAL**: Without a volume, ALL data is lost on every redeploy!

| Setting        | Value            |
| -------------- | ---------------- |
| **Mount Path** | `/home/clauder`  |
| **Size**       | 5GB+ recommended |

---

## Built With

- [code-server](https://github.com/coder/code-server) – VS Code in the browser
- [Claude Code CLI](https://claude.ai/code) – AI coding assistant by Anthropic
- [Google Antigravity](https://antigravity.google/docs/ide/extensions/vscode/) – agentic IDE extension and cloud agent harness

---

## License

MIT
