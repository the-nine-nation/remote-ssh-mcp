# 远程 SSH MCP 设计

> **状态**：MVP 已实现（2026-07-29）；会话语义、超时策略与 §7 wire protocol 已落地并有自动化测试。  
> **目标**：为 Agent 提供**持久化、有状态**的远程 SSH 操作能力，替代「每次 bash 里重新 `ssh`」的高 token、低稳定方案。

## 1. 背景与问题

框架默认的 bash 方案在远程场景通常是：

```text
模型 → bash("ssh user@host 'cmd'") → 输出回上下文 → 再来一次
```

痛点：

| 问题 | 表现 |
|------|------|
| Token 浪费 | 反复出现 `ssh` 前缀、banner、环境探测（`pwd` / `whoami` / 版本检查） |
| 状态丢失 | cwd、export、虚拟环境、后台副作用无法自然延续 |
| 不稳定 | 每次新建连接：超时、host key、多跳、鉴权抖动 |
| 错误放大 | 模型用更长探测命令补偿不确定性 → 更费 token |

**本 MCP 的定位**：把「远程有状态 shell」做成一等工具，而不是让模型在 bash 里拼 SSH 字符串。

## 2. 核心语义（已拍板）

### 2.1 一个 id = 一条持续远程 shell

| 规则 | 说明 |
|------|------|
| **同 id 默认续上下文** | 保留 cwd、环境变量、该 shell 内的副作用 |
| **要干净环境 → 新 open** | 新建 id，与旧 id 互不干扰 |
| **脏了靠模型 close** | 不自动「净化」会话；模型关闭旧会话再 open |
| **超时也保留会话** | 仅结束/中断**当前前台命令**；id 与 shell 仍存活 |
| **超时返回当前 log** | MCP 响应携带目前已缓冲的 stdout/stderr（截断后的 partial） |

模型心智：

```text
open(host)  →  id
run(id, cmd) → 接着上次 cwd/env 继续
超时 / 卡住 → peek 看 log，或 interrupt 中断
环境脏了   → close(id) → open(host) 拿新 id
```

### 2.2 对内两层，对外一层

实现上可以拆：

```text
Connection   底层 SSH 连接（可复用、可对模型隐藏）
Session(id)  有状态 shell（模型唯一可见的句柄）
```

**对模型只暴露 session id**，不要求理解 pool / connection 两套编号。

MVP 可采用最简单映射：

```text
1 session = 1 SSH 连接 + 1 长生命周期远程 bash
```

后续若需同 host 多会话共用连接，再在服务端做连接复用，**不改变工具 API**。

## 3. 非目标

首版明确不做：

- 完整交互式 PTY 流（vim、全屏 TUI）
- 模型侧传递密码 / 私钥内容
- 任意 port-forward / 动态隧道管理
- 自动检测并修复「脏环境」
- 替代本机 bash（本机文件与测试仍用默认 shell 工具）

## 4. 工具面

### 4.1 最小工具集

| 工具 | 作用 |
|------|------|
| `ssh_open` | 在指定 host 上新建有状态会话，返回 `id` |
| `ssh_run` | 在指定 id 上执行命令（默认续上下文） |
| `ssh_peek` | 查看当前前台命令的临时输出 / 会话是否在跑 |
| `ssh_interrupt` | 中断当前前台命令（类 Ctrl-C），**保留会话** |
| `ssh_list` | 列出存活会话（id、host、cwd、状态、空闲时间、距 idle 回收剩余时间） |
| `ssh_close` | 关闭会话并释放资源 |

### 4.2 参数草案

#### `ssh_open`

```json
{
  "host": "string  // ssh config Host 别名或已登记 profile",
  "name": "string? // 可选人类可读标签，便于 list"
}
```

返回：

```json
{
  "id": "s_a3f2",
  "host": "prod",
  "cwd": "/home/app",
  "status": "idle"
}
```

#### `ssh_run`

```json
{
  "id": "s_a3f2",
  "command": "string",
  "timeout_sec": "number? // 无默认值；显式传入才启用自动中断",
  "wait_sec": "number? // 默认 10；本次 MCP 调用等待上限"
}
```

行为：

1. 在该 id 对应的**同一条 shell**中执行 `command`。
2. 最多同步等待 `wait_sec`；期间命令结束则直接返回最终结果。
3. `wait_sec` 到期但命令仍在运行时，返回 `status: "running"`，远端命令继续；
   模型必须用 `ssh_peek` 轮询，不能重试原命令。
4. 默认不自动中断；只有显式提供 `timeout_sec`，达到该值才中断远端命令。
5. **无论成功、失败还是超时，会话 id 默认保留**（除非 shell 已死，见 §6）。
6. 返回中始终带上**当前可得的 log**（完整或 partial）以及 `cwd` 等摘要。

#### `ssh_peek`

```json
{
  "id": "s_a3f2",
  "lines": "number? // 默认 50，最大 1000",
  "wait_sec": "number? // 默认 0；运行中最长阻塞等待，到期仍 running；不停止远端命令"
}
```

- 空闲：立即返回 `status: "idle"`，可附带 last_exit / cwd 与上一条命令的最新 N 行。
- 运行中：若 `wait_sec > 0`，阻塞到命令结束或等待到期；到期仍 `status: "running"`。
  stdout/stderr 分别返回最新 N 行，按时间从旧到新。
- 模型应优先带 `wait_sec` 长轮询，避免 `wait_sec: 0` 空转。
- `lines` 与底层字节上限同时生效，避免行数或超长单行灌爆模型上下文。

#### `ssh_interrupt`

```json
{
  "id": "s_a3f2"
}
```

- 向前台进程发中断（优先 SIGINT，必要时升级）。
- 会话保留，shell 回到可接受下一条 `run` 的状态。
- 返回 interrupt 前已缓冲的 log。
- 若无前台命令：`nothing_to_interrupt`（明确失败/空操作，不伪装成功）。

#### `ssh_list` / `ssh_close`

- `list`：无参或可选过滤；用于迷路自救与资源查看。
- `close`：结束 shell、释放连接；之后该 id 调用一律 `session_gone`。

### 4.3 工具描述中应写死的约定（影响模型行为）

1. **同一 id 默认续用 cwd 与环境变量；需要干净环境请 `ssh_close` 后重新 `ssh_open`，不要在脏会话里硬猜。**
2. **不要使用 vim / top / 全交互 TUI；长任务使用默认或较短的 `wait_sec`。
   默认没有自动超时；返回 `running` 表示原命令仍在执行，禁止重试。用
   `ssh_peek(wait_sec=...)` 长轮询（禁止 `wait_sec: 0` 空转），必要时
   `ssh_interrupt`；只有确实需要硬截止时间时才传 `timeout_sec`。**
3. **`id` 必须来自 `ssh_open` / `ssh_list` 的返回值，禁止臆造。**
4. **远程操作优先本 MCP；避免在本机 bash 里再包一层 `ssh`。**

## 5. 超时与日志策略（已拍板）

### 5.1 默认策略

| 层级 | 默认（建议） | 说明 |
|------|----------------|------|
| MCP 调用 `wait_sec` | **10s** | 到期返回 `running`，不停止命令 |
| 单次命令 `timeout_sec` | **无默认值** | 显式传入才启用自动 Ctrl-C |
| 显式 timeout 硬上限 | **30 min** | 防止参数被设成「无限」 |
| 会话 idle 回收 | **15–30 min** 无活动 | 模型忘 close 时的服务端兜底 |
| 输出截断 | stdout/stderr 各约 **8–32 KiB**：头部 ~4 KiB + 尾部其余 | 防一次响应灌爆模型上下文；保留头部是因为编译/脚本的首条报错往往在开头 |
| `ssh_peek` 行数 | **最新 50 行/流** | 可调，最大 1000 行，仍受字节上限约束 |

具体数值实现时可配置；上表为产品默认起点。

`wait_sec` 与 `timeout_sec` 必须分离。前者解决 MCP 宿主在 `docker pull`、构建、
下载或部署期间一直等待的问题；后者是模型主动选择的安全截止时间，不默认启用。
若 `ssh_run` 返回 `running`，同一 session 仍是 busy 状态，模型应带 `wait_sec` 长轮询
`ssh_peek`；需要并发操作时另开 session。

MCP 宿主退出、stdio 断开或父进程消失时，服务端必须关闭全部已建立和正在建立的
SSH 连接。普通前台进程随 PTY 关闭；明确使用 `nohup`、`setsid`、服务管理器或
容器脱离会话的工作负载不承诺随 SSH 一起终止。

### 5.2 超时后行为（关键）

```text
ssh_run 达到 timeout_sec
  → 中断当前前台命令（与 interrupt 同路径，或等价）
  → 会话 id 与 shell 仍然保留（cwd/env 仍在）
  → MCP 返回 status = "timeout"
  → 响应 body 携带当前已缓冲的 log（partial stdout/stderr）
  → 附带 cwd、duration_ms、truncated 等元数据
```

**超时 ≠ 关闭会话。**  
超时只表示「这一轮命令没在时限内结束」；模型拿到当前 log 后可：

- 继续 `ssh_run` 做后续命令（超时已自动 interrupt，会话稳定处于 `idle`）；
- 或 `ssh_close` + `ssh_open` 开干净会话（怀疑远程有中断残留时）。

（「超时仅通知、命令继续跑」的变体不在 MVP 内，见 §10.2 background job。）

### 5.3 MVP 选定变体

为降低状态机复杂度，**MVP 采用**：

> **超时 = 自动 interrupt 当前前台命令 + 保留 session + 返回当前 log。**

这样超时返回后，会话稳定处于 `idle`，模型可直接下一条 `run`，无需再猜是否仍在跑。

若后续需要「超时只通知、命令继续在后台跑」，可再增加显式 `background` / job API；**不作为首版默认**。

### 5.4 返回形状（统一）

成功：

```json
{
  "id": "s_a3f2",
  "status": "ok",
  "exit_code": 0,
  "stdout": "...",
  "stderr": "...",
  "truncated": false,
  "cwd": "/var/log",
  "duration_ms": 1204
}
```

超时：

```json
{
  "id": "s_a3f2",
  "status": "timeout",
  "exit_code": null,
  "stdout": "...当前已捕获 log...",
  "stderr": "...",
  "truncated": true,
  "cwd": "/var/log",
  "duration_ms": 90000,
  "interrupted": true,
  "message": "command exceeded timeout_sec; interrupted; session kept; remote side effects may remain (lock files, partial writes) — verify before retrying"
}
```

中断（`ssh_interrupt` 或等价）：

```json
{
  "id": "s_a3f2",
  "status": "interrupted",
  "stdout": "...",
  "stderr": "...",
  "truncated": true,
  "cwd": "/var/log",
  "interrupted": true
}
```

命令失败（非零退出，但会话仍在）：

```json
{
  "id": "s_a3f2",
  "status": "command_failed",
  "exit_code": 1,
  "stdout": "...",
  "stderr": "...",
  "cwd": "/var/log"
}
```

会话失效：

```json
{
  "id": "s_a3f2",
  "status": "session_gone",
  "message": "unknown or closed session; call ssh_open again"
}
```

**原则：凡是与「跑命令」相关的响应，优先带上当前 log + `cwd`，减少模型额外探测。**

## 6. 会话生命周期与状态机

### 6.1 状态

```text
closed ──open──► idle ──run──► running
                   ▲              │
                   │              ├─ 命令结束 ──► idle
                   │              ├─ timeout   ──► idle（已 interrupt，带 partial log）
                   │              └─ interrupt ──► idle（带 partial log）
                   │
                   └── close / idle 超时 / shell 死亡 ──► closed
```

| 状态 | 含义 |
|------|------|
| `idle` | 可接受 `run` |
| `running` | 前台有命令；可 `peek` / `interrupt` |
| `closed` | id 失效 |

### 6.2 并发

- **同一 id：串行。** 若 `running` 时再次 `run`，返回 `busy`（或排队；MVP 建议直接 `busy`，让模型 peek/interrupt）。
- **不同 id：可并行**（受服务端总连接数上限约束）。

### 6.3 死亡与重连

- Shell/连接意外断开：该 id 标记 `closed` / `session_gone`，**不假装还活着**。
- 模型应 `ssh_open` 新 id。
- 可选后续：同 host 透明重连并恢复「新 shell」（上下文已丢，必须让模型知道 `recreated: true`）。首版可不做透明重连。

### 6.4 脏会话策略

| 策略 | 首版 |
|------|------|
| 自动检测 env 是否脏 | 不做 |
| 自动 reset | 不做 |
| 信任模型 `close` + `open` | **是** |
| 服务端兜底 | `list` 可见；每次响应带 `cwd`；idle 自动回收 |

## 7. 远程执行协议（wire protocol，已拍板）

目标：同 id 上多次 `run` 共享同一 bash 进程。以下为**协议级约定**，不是建议；实现必须逐项满足。

### 7.1 传输：每 session = 1 连接 + 1 PTY channel

- `open` 建立 1 条 SSH 连接、1 个 session channel，**请求 PTY** 并启动长生命周期 shell。MVP 通过本机 OpenSSH 启动 `bash --noprofile --norc`，避免 profile 修改协议所依赖的 shell/stty 行为；用户需要的环境应由显式命令设置并在同 id 内延续。
- **必须用 PTY 的原因**：中断路径（§7.5）依赖远程 PTY line discipline 把 `\x03` 转成对前台进程组的 SIGINT；无 PTY 时 OpenSSH 服务端基本忽略 channel signal，且非交互 bash 无 job control，无法可靠中断「整条前台管道」。
- PTY 不代表支持交互式 TUI（§3 非目标不变）：开 channel 后立即下发 `stty -echo -onlcr` 抑制回显与控制字符噪声，模型侧仍按「非交互批处理」使用。
- 注意：PTY 下远程侧 stdout/stderr **合流**，分流靠 §7.3 的 stderr 落盘方案，不依赖 SSH extended-data。
- 1 session = 1 连接（§2.2），同 host 多 session 时注意 sshd `MaxSessions` / `MaxStartups` 水位；`ssh_list` 应暴露服务端当前连接数。

### 7.2 open 握手：先冲刷，再返回

`open` 下发 shell 后，立即发送一轮空命令 + marker（§7.3 格式），**读到该 marker 才认为会话就绪**；此前的 MOTD / profile 输出全部丢弃。随后返回 `id` 与初始 `cwd`。

### 7.3 run 帧格式（每轮命令）

每轮 `run` 生成**随机 token**（至少 16 字节随机 hex）。用户命令必须先做
shell-safe 单引号编码，再由当前长生命周期 bash 的 `builtin eval` 执行；不得把原始命令
直接拼进 `{ <user command>; }`，否则命令末尾的注释、反斜杠或未闭合语法可能吞掉协议尾帧。
写入 shell 的字节流概念上为：

```bash
builtin eval -- '<shell-safe user command>' </dev/null 2>'<session-private stderr file>'
__sshmcp_rc_<token>=$?
builtin printf '\n__SSHMCP_EXIT:%s:<token>:%s__\n' "$__sshmcp_rc_<token>" \
  "$(builtin pwd | base64 | tr -d '\r\n')"
builtin printf '__SSHMCP_ERR_BEGIN:<token>__\n'
command cat -- '<session-private stderr file>'
command rm -f -- '<session-private stderr file>'
builtin printf '\n__SSHMCP_ERR_END:<token>__\n'
```

约定：

1. **`</dev/null` 强制隔离 stdin**：用户命令若读 stdin（`read` / `cat` / 安装脚本提问），不会吃掉后续 marker 帧——这是协议正确性的前提，同时把「交互式 stdin」在协议层锁死（与 §3 一致）。
2. **stderr 落盘分流**：命令 stderr 重定向到临时文件，marker 之后用 `ERR_BEGIN/END` 帧带回；marker 之前的流即 stdout。由此支撑 §5.4 的 stdout/stderr 分离字段。
3. **token 每轮随机、匹配行首锚定**：防用户输出中碰巧出现 marker 字符串导致误切。
4. **exit code 与 cwd 由 marker 行携带**：退出码必须在用户命令返回后立即保存；
   `cwd` 取命令结束后的 `pwd` 并固定使用 base64 编码（服务端不做客户端侧 `cd`
   追踪）。解码失败时回退为「不上报 cwd」，不得让整轮命令失败。
5. **临时文件隔离**：每个 session 在握手时创建权限为 `0700` 的私有临时目录，
   stderr 文件只放在该目录内；关闭会话时清理。不得直接使用可预测且可被符号链接抢占的
   `/tmp/.sshmcp.<token>.err`。

### 7.4 shell 死亡检测

- 用户命令中的 `exit` / `exec` / `kill $$` 会终止 shell 本体，marker 永远不会到达。
- 服务端必须监听 channel 的 **EOF / exit-status**：等 marker 期间收到任一 → 该 id 置 `shell_dead`（§11），返回已缓冲 partial log，**不假装活着**。
- 死亡与「命令仍在跑」仅靠超时无法区分，因此禁止「等不到 marker 就静默重发」。

### 7.5 中断路径（timeout 与 ssh_interrupt 共用）

1. 向 channel 写入 `\x03`（Ctrl-C），远程 PTY 将其转为对前台进程组的 SIGINT。
2. 宽限（建议 3–5s）内读到 marker 帧 → 正常收尾，返回 `interrupted` / `timeout` + partial log。
3. 宽限内未收尾：可选升级——在同一条 SSH 连接上另开 exec channel 对该会话前台进程组补 `SIGTERM` / `SIGKILL`。MVP 若不实现升级，必须关闭该 session 并返回 partial log + `session_gone: true`；**不得在前台进程是否存活未知时把会话标成 `idle`**。
4. 仅在读到本轮完整 marker 后丢弃残缺控制帧并回到 `idle`；否则按上一条关闭会话。

### 7.6 噪声与编码

- `stty -echo` 之后残余的 ANSI 颜色码尽力过滤；不保证逐字节干净，模型侧不应依赖输出逐字节稳定。
- 服务端内部缓冲按字节截断，输出给模型前保证 UTF-8 边界完整。

**禁止**用「每次 `ssh host 'cmd'`」实现 `run`，否则无法续上下文。

## 8. Host 与安全边界

| 项 | 要求 |
|----|------|
| Host 来源 | 仅 `~/.ssh/config` 别名和/或 MCP 配置 allowlist |
| 凭证 | 仅使用本机 agent / 已配置 key；工具参数禁止传私钥或密码 |
| 审计 | 记录 id、host、command 摘要、时间、exit/timeout（路径可配置） |
| 危险命令 | 首版不做复杂策略引擎；最小 denylist 见下行，随 MVP 落地 |
| 默认假设 | MCP 跑在开发者本机，连接自有机器；多租户/不可信 agent 不在首版范围 |
| Prompt injection | Agent 读取不可信内容（网页 / issue / 日志）后触发的 `ssh_run` 可能携带注入命令；宿主侧建议对高风险命令人工确认，服务端 denylist（`rm -rf /`、`shutdown`、`iptables` 等）优先于其他 §10.2 安全项落地 |

与本仓库 `local-worker` 的「窄接口、强鉴权」不同：本 MCP 面向**本机 Agent 运维/开发**，能力更宽，依赖 host allowlist 与本机信任边界。

## 9. 与默认 bash 的分工

| 场景 | 使用 |
|------|------|
| 本机文件、测试、构建 | 默认 bash |
| 远程部署、查日志、服务操作、远程调试 | SSH MCP |
| 禁止 | 在 bash 中再包 `ssh ...` 重复造连接（除非 MCP 不可用） |

## 10. MVP 范围与后续

### 10.1 MVP（验证 token / 稳定性收益）

- [x] 语义：同 id 续上下文；新 open 新环境  
- [x] 超时保留会话 + 返回当前 log  
- [x] 协议：§7 wire protocol（PTY + `\x03` 中断、marker 帧、stdin 隔离、stderr 分流、死亡检测）  
- [x] `ssh_open` / `ssh_run` / `ssh_peek` / `ssh_interrupt` / `ssh_list` / `ssh_close`  
- [x] 输出截断、`cwd` 回传、统一 status  
- [x] idle 回收、同 id 串行  
- [x] host allowlist / ssh config  
- [x] stdio MCP（兼容 2025-era 与 2026-07-28 协议握手）  

### 10.2 后续可选

- 同 host 连接复用（多 session 共享 connection）
- `ssh_read_file` / `ssh_write_file` / SFTP 上传下载
- 显式 background job + poll（超时后命令继续跑的模式）
- ProxyJump / 跳板一等支持
- 命令 denylist、工作目录 jail
- 会话命名与更丰富的 `ssh_info`（env 摘要）

## 11. 错误码（建议）

| status / code | 含义 |
|---------------|------|
| `ok` | 命令成功结束 |
| `command_failed` | 非零 exit，会话仍在 |
| `timeout` | 超过 timeout，已 interrupt；通常保留会话，若中断宽限期内无法恢复则关闭并显式标记，body 为当前 log |
| `interrupted` | 主动中断；通常保留会话，若中断宽限期内无法恢复则关闭并显式标记 |
| `busy` | 该 id 仍有前台命令 |
| `session_gone` | id 不存在或已 close |
| `host_not_allowed` | host 不在白名单 |
| `connect_failed` | 建连/鉴权失败 |
| `shell_dead` | 远程 shell 意外退出 |
| `nothing_to_interrupt` | interrupt 时无前台命令 |

## 12. 设计小结

```text
┌─────────────────────────────────────────────────────────┐
│  模型侧                                                  │
│  open → id → run / peek / interrupt → close（脏了重开）   │
└───────────────────────────┬─────────────────────────────┘
                            │  MCP tools
                            ▼
┌─────────────────────────────────────────────────────────┐
│  SSH MCP 服务端                                          │
│  Session(id) = 有状态远程 bash                           │
│  默认 timeout；超时 → interrupt + 保留 id + 返回当前 log │
│  idle 回收；list 可见；响应带 cwd                        │
└───────────────────────────┬─────────────────────────────┘
                            │  SSH
                            ▼
                      远程机器 shell
```

**一句话产品约定：**

> **一个 id 就是一条持续的远程 shell；同 id 默认续上下文；超时也保留会话并返回当前 log；要干净环境就 close 再 open。**

---

## 修订记录

| 日期 | 说明 |
|------|------|
| 2026-07-27 | 初稿：有状态 session、超时保留 + 返回当前 log、peek/interrupt、脏会话由模型 close |
| 2026-07-27 | 二稿：§7 升级为 wire protocol（PTY + `\x03` 中断、stdin 隔离、stderr 落盘分流、open 握手冲刷、shell 死亡检测、每轮随机 token、cwd 由 marker 携带）；超时响应带副作用提示；截断改头+尾；`ssh_list` 增加回收倒计时与连接水位；§8 补 prompt injection 边界 |
| 2026-07-29 | 实现前审查：原始命令改为 shell-safe `eval` 帧；退出码立即保存；cwd 固定 base64；stderr 改 session 私有目录；中断未恢复时关闭 session，禁止误报 idle |
| 2026-07-29 | MVP：TypeScript MCP server + 持久 OpenSSH 子进程；6 工具、allowlist、审计、denylist、idle 回收、头尾截断与自动化协议测试落地 |
