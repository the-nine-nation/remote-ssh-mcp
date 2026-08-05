# Remote SSH MCP

**English** | [简体中文](./README.zh-CN.md)

A local MCP server that exposes persistent, stateful remote Bash sessions to
AI agents. Reusing the same session ID preserves the working directory,
environment variables, and shell side effects. Open a new session whenever a
clean environment is required.

Remote SSH MCP uses the system OpenSSH client instead of reimplementing SSH.
Your existing `~/.ssh/config`, known hosts, SSH agent, ProxyJump routes, and
hardware-key policies continue to work.

## Why

Running `ssh host "command"` for every remote action repeatedly reconnects,
loses shell state, reproduces banners and environment probes, and wastes model
context. Remote SSH MCP keeps one remote shell alive behind a small, explicit
tool interface:

```text
ssh_open(host) → session id
ssh_run(id, command) → same cwd and environment
ssh_peek(id) / ssh_interrupt(id) → observe or recover a stuck command
ssh_close(id) → release the shell and connection
```

## Features

- Persistent remote Bash sessions with stable IDs
- Working-directory and environment persistence within each session
- Separate `stdout` and `stderr` in tool results
- Non-blocking observation of long commands with a separate hard timeout
- Safe fail-closed behavior when shell recovery cannot be confirmed
- Head-and-tail output truncation with valid UTF-8 boundaries
- Exact SSH Host alias allowlist from `ssh_config` and explicit configuration
- `ssh_hosts` discovery with safe metadata (`hostname`, `user`, `port`, `proxy_jump`) and optional hot reload
- Session limits, idle reaping, command auditing, and a minimal safety denylist
- MCP stdio support for both legacy and current protocol handshakes
- No password, private-key text, IdentityFile paths, or arbitrary SSH option arguments

## MCP tools

| Tool | Purpose |
|---|---|
| `ssh_hosts` | List allowed Host aliases from local `ssh_config` (safe metadata only; `reload=true` re-parses) |
| `ssh_open` | Open a clean persistent shell for an allowed SSH Host alias |
| `ssh_run` | Run a non-interactive command in an existing session |
| `ssh_peek` | Inspect status and the latest N output lines; optional `wait_sec` long-polls while running |
| `ssh_interrupt` | Send Ctrl-C and wait for confirmed shell recovery |
| `ssh_list` | List sessions, cwd, state, idle countdown, and capacity |
| `ssh_close` | Clean up and close a session |

## Requirements

- Node.js 20 or newer
- An OpenSSH client
- A remote host with Bash, `base64`, `stty`, `mkdir`, `cat`, and `rm`
- A configured SSH Host alias and a known host key

The server enforces `BatchMode=yes` and `StrictHostKeyChecking=yes`. Complete
first-connection host-key confirmation and authentication setup in a normal
terminal before using the MCP server. It never opens password or confirmation
prompts.

## Install

```bash
git clone https://github.com/the-nine-nation/remote-ssh-mcp.git
cd remote-ssh-mcp
npm install
npm run build
npm test
```

Run the server directly:

```bash
node /absolute/path/to/remote-ssh-mcp/dist/index.js
```

Or, after installing it as a package, use the `remote-ssh-mcp` executable.

## MCP host configuration

Most stdio MCP hosts accept a configuration shaped like this; the outer key
may differ by host:

```json
{
  "mcpServers": {
    "remote-ssh": {
      "command": "node",
      "args": [
        "/absolute/path/to/remote-ssh-mcp/dist/index.js"
      ],
      "env": {
        "SSH_MCP_ALLOWED_HOSTS": "prod,staging"
      }
    }
  }
}
```

`SSH_MCP_ALLOWED_HOSTS` adds explicit aliases to the allowlist. By default, the
server also discovers exact `Host` aliases from `~/.ssh/config` and its
`Include` files. Patterns containing `*`, `?`, or `!` are ignored. Tool inputs
accept only safe aliases, not `user@host`, ports, or extra SSH options.

Typical agent flow:

```text
ssh_hosts()            → pick an alias
ssh_open(host=alias)   → session id
ssh_run(id, command)   → work on the remote shell
```

After editing `~/.ssh/config`, call `ssh_hosts(reload=true)` instead of
restarting the MCP server.

### Credential boundary

Authentication stays inside the local OpenSSH client. The MCP tools never
accept passwords or private-key material, and `ssh_hosts` never returns
`IdentityFile`, certificate paths, agent sockets, or `ProxyCommand`. Agents
should call `ssh_open` with a Host alias and must not read `~/.ssh` private key
files from disk.

## Configuration

The optional configuration file defaults to:

```text
~/.config/remote-ssh-mcp/config.json
```

Example:

```json
{
  "allowedHosts": ["prod", "staging"],
  "sshConfigPath": "~/.ssh/config",
  "sshPath": "ssh",
  "maxTimeoutSec": 1800,
  "defaultWaitSec": 10,
  "maxWaitSec": 30,
  "openTimeoutSec": 20,
  "idleTimeoutSec": 1800,
  "interruptGraceSec": 5,
  "maxSessions": 8,
  "outputMaxBytes": 32768,
  "outputHeadBytes": 4096,
  "auditLogPath": "~/.local/state/remote-ssh-mcp/audit.jsonl"
}
```

Environment variables override file settings:

| Environment variable | Purpose |
|---|---|
| `SSH_MCP_CONFIG` | Configuration file path |
| `SSH_MCP_ALLOWED_HOSTS` | Comma-separated additional Host aliases |
| `SSH_MCP_SSH_CONFIG` | SSH config path |
| `SSH_MCP_SSH_PATH` | OpenSSH executable |
| `SSH_MCP_MAX_TIMEOUT_SEC` | Maximum explicitly requested command timeout |
| `SSH_MCP_DEFAULT_WAIT_SEC` | How long `ssh_run` waits before returning `running` |
| `SSH_MCP_MAX_WAIT_SEC` | Maximum permitted `wait_sec` on `ssh_run` and `ssh_peek` |
| `SSH_MCP_OPEN_TIMEOUT_SEC` | Connection and handshake timeout |
| `SSH_MCP_IDLE_TIMEOUT_SEC` | Idle session lifetime |
| `SSH_MCP_INTERRUPT_GRACE_SEC` | Marker recovery grace period after Ctrl-C |
| `SSH_MCP_MAX_SESSIONS` | Maximum live sessions |
| `SSH_MCP_OUTPUT_MAX_BYTES` | Per-stream retained output limit |
| `SSH_MCP_OUTPUT_HEAD_BYTES` | Retained head bytes when truncating |
| `SSH_MCP_AUDIT_LOG` | JSONL audit-log path |

The audit log is created with mode `0600`. It records the session, host,
result, duration, command length, command name, and SHA-256 hash. Full command
arguments are intentionally omitted to reduce the chance of logging secrets.

## Execution semantics

- One session accepts only one foreground command at a time. Concurrent
  `ssh_run` calls return `busy` instead of being queued.
- `wait_sec` limits only how long the MCP call waits. If it expires,
  `ssh_run` returns `status: "running"` while the remote command continues.
  Do not start the command again. Poll with `ssh_peek(wait_sec=...)` so the
  call blocks until the command finishes or the wait expires; do not busy-loop
  with `wait_sec: 0`. Stop it with `ssh_interrupt`, or open another session
  for concurrent work.
- Commands have no automatic execution timeout by default. The model owns
  their lifecycle. Only an explicitly supplied `timeout_sec` creates a hard
  deadline that sends Ctrl-C.
- `ssh_peek` returns the newest 50 lines from stdout and stderr by default.
  Pass `lines` (maximum 1,000) when a different tail length is needed. Byte
  limits still apply, so a very long individual line remains bounded.
  Optional `wait_sec` (default 0, capped by `maxWaitSec`) long-polls while the
  session is running and returns immediately when idle.
- User-command stdin is `/dev/null`. Do not run `vim`, `top`, interactive
  installers, or other TUI/input-driven programs.
- A timeout sends Ctrl-C. If a complete protocol marker arrives during the
  grace period, the session returns to idle. Otherwise, the session is closed
  to prevent an unknown foreground process from corrupting the next command.
- `stdout` and `stderr` independently retain their beginning and end. Responses
  always end on valid UTF-8 boundaries.
- The built-in denylist blocks only a few obviously destructive patterns. It
  is not a complete policy engine.
- This project targets a trusted local developer environment. It is not a
  multi-tenant remote execution service.
- If the MCP host exits or its stdio/parent connection disappears, the server
  closes every tracked SSH connection, including connections still opening.
  Normal foreground processes end with their PTY; deliberately detached
  processes such as `nohup`, `setsid`, services, and containers may continue.

For example, start a `docker pull` with `wait_sec: 10` and omit
`timeout_sec`. A `running` result means the original pull remains active—not
that it should be retried. Call `ssh_peek` with the same session ID and a
positive `wait_sec` until it becomes `idle`, interrupt it explicitly, or open
another session for parallel work.

## Development

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

The test suite covers MCP stdio discovery and calls, persistent cwd/environment
state, stream separation, framing across arbitrary chunk boundaries, timeout
fail-closed behavior, shell death, allowlist discovery, output truncation, and
the safety denylist.

## Security

Please do not report security vulnerabilities through public GitHub issues.
Until a private security-advisory workflow is configured, contact the
maintainer through the email listed on their GitHub profile.

Remote commands can have irreversible side effects even when the MCP transport
works correctly. Review host permissions, use least-privilege accounts, and
keep the allowlist narrow.

## License

[MIT](./LICENSE)

The wire protocol and detailed design decisions are documented in
[远程SSH-MCP设计.md](./远程SSH-MCP设计.md).
