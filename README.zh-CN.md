# Remote SSH MCP

[English](./README.md) | **简体中文**

把一条持久、有状态的远程 Bash 暴露为 6 个 MCP 工具。相同 session id 会保留
`cwd`、环境变量和 shell 副作用；需要干净环境时关闭旧 session，再新开一个。

## 已实现

- `ssh_open`：为允许的 SSH Host 别名新建持久 session
- `ssh_run`：在同一远程 Bash 中执行非交互命令
- `ssh_peek`：查看运行状态和最新 N 行输出，默认 50 行
- `ssh_interrupt`：发送 Ctrl-C；只有确认协议恢复才保留 session
- `ssh_list`：列出存活 session、cwd、idle 回收倒计时与连接水位
- `ssh_close`：清理远程临时目录并释放 SSH 连接

`ssh_run` 默认只同步等待 10 秒，到期后返回 `running`，远端命令继续执行。
默认没有执行超时，也不会自动发送 Ctrl-C；只有模型显式传入 `timeout_sec`
才会创建硬截止时间。这样 `docker pull`、构建、下载和部署不会一直占住工具调用，
其生命周期仍完全由模型管理。

实现复用本机 `ssh`，因此 `~/.ssh/config`、known_hosts、SSH agent、ProxyJump
和硬件密钥策略仍由 OpenSSH 负责。服务不接收密码、私钥文本或任意 SSH 参数。

## 环境要求

- Node.js 20+
- OpenSSH client
- 远程主机提供 Bash、`base64`、`stty`、`mkdir`、`cat`、`rm`
- 目标 Host 已写入 `~/.ssh/config`，host key 已在 known_hosts 中

服务强制 `BatchMode=yes` 和 `StrictHostKeyChecking=yes`。首次连接请先在普通终端中
完成 host key 确认与凭证配置；MCP 不会弹出密码或确认提示。

## 安装与构建

```bash
npm install
npm run build
npm test
```

启动命令：

```bash
node /absolute/path/to/remote_ssh_mcp/dist/index.js
```

## MCP 宿主配置

使用 stdio 的宿主可采用以下形状（外层配置键名依宿主而异）：

```json
{
  "mcpServers": {
    "remote-ssh": {
      "command": "node",
      "args": [
        "/absolute/path/to/remote_ssh_mcp/dist/index.js"
      ],
      "env": {
        "SSH_MCP_ALLOWED_HOSTS": "prod,staging"
      }
    }
  }
}
```

`SSH_MCP_ALLOWED_HOSTS` 是附加 allowlist。默认还会读取 `~/.ssh/config` 及其
`Include` 文件中的精确 `Host` 别名；包含 `*`、`?` 或 `!` 的模式不会进入
allowlist。工具参数只接受安全别名，不接受 `user@host`、端口或额外 SSH 选项。

## 配置

可选配置文件默认为：

```text
~/.config/remote-ssh-mcp/config.json
```

示例：

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

对应环境变量会覆盖文件：

| 环境变量 | 作用 |
|---|---|
| `SSH_MCP_CONFIG` | 配置文件路径 |
| `SSH_MCP_ALLOWED_HOSTS` | 逗号分隔的附加 Host allowlist |
| `SSH_MCP_SSH_CONFIG` | SSH config 路径 |
| `SSH_MCP_SSH_PATH` | OpenSSH 可执行文件 |
| `SSH_MCP_MAX_TIMEOUT_SEC` | 显式 `timeout_sec` 的允许上限 |
| `SSH_MCP_DEFAULT_WAIT_SEC` | `ssh_run` 返回 `running` 前的默认等待时间 |
| `SSH_MCP_MAX_WAIT_SEC` | `wait_sec` 的允许上限 |
| `SSH_MCP_OPEN_TIMEOUT_SEC` | 建连/握手超时 |
| `SSH_MCP_IDLE_TIMEOUT_SEC` | idle 自动回收时间 |
| `SSH_MCP_INTERRUPT_GRACE_SEC` | Ctrl-C 后等待 marker 的宽限期 |
| `SSH_MCP_MAX_SESSIONS` | 最大并发 session 数 |
| `SSH_MCP_OUTPUT_MAX_BYTES` | stdout、stderr 各自保留上限 |
| `SSH_MCP_OUTPUT_HEAD_BYTES` | 截断时保留的头部字节数 |
| `SSH_MCP_AUDIT_LOG` | JSONL 审计日志路径 |

审计日志权限固定为 `0600`，记录 session、host、状态、时长、命令长度、命令名和
SHA-256；不记录完整命令参数，避免凭证进入日志。

## 行为边界

- 同一 id 同时只运行一个前台命令；再次 `ssh_run` 返回 `busy`。
- `wait_sec` 到期只会让 MCP 调用返回 `running`，不会停止远端命令。不要重试
  原命令；应使用相同 id 调用 `ssh_peek` 轮询，必要时 `ssh_interrupt`，并发工作
  则另开 session。
- 默认没有执行超时，一切由模型管理。只有显式传入 `timeout_sec` 才会在到期后
  自动 Ctrl-C；`docker pull` 等长任务通常只需设置或沿用 `wait_sec: 10`。
- `ssh_peek` 的 `lines` 默认 50、最大 1000，stdout 和 stderr 分别返回最新 N 行，
  顺序仍为从旧到新；底层字节上限继续生效，防止单行日志过大。
- 用户命令的 stdin 固定为 `/dev/null`。不要运行 `vim`、`top`、交互安装器等。
- 超时会发送 Ctrl-C。宽限期内收到完整 marker，session 回到 idle；否则关闭
  session，防止未知前台进程污染下一条命令。
- stdout/stderr 分别按字节保留头部和尾部，输出时保证 UTF-8 边界完整。
- 内置 denylist 只拦截少量明显高风险命令，不是完整策略引擎。
- 这是面向本机可信开发者的工具，不是多租户远程执行服务。
- MCP 宿主退出、stdio 断开或父进程消失时，服务会回收全部已建立及正在建立的
  SSH 连接。普通前台进程会随 PTY 关闭；`nohup`、`setsid`、系统服务、容器等
  主动脱离会话的进程可能继续运行。

协议与设计决策见 [远程SSH-MCP设计.md](./远程SSH-MCP设计.md)。
