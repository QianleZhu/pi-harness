# 本机执行与 MCP 沙箱

`@pi-harness/sandbox` 提供 SRT 进程与网络隔离，由 daemon 接入命令和 MCP 执行链。

非完全访问模式下，`run_command` 和 macOS、Linux 的普通 stdio MCP 使用 Catalog 锁定版本的 Anthropic Sandbox Runtime（SRT），沿用它的文件系统、网络、凭据代理与平台隔离能力。SRT 初始化或配置失败时拒绝启动。只有 `run_command` 非零退出且 SRT 明确报告 violation 时，才展示原因并允许用户逐次批准原命令在宿主机重跑。

每次隔离命令和每个隔离 stdio MCP Client 拥有独立 worker、网络代理、HOME 和临时目录。文件读写规则由 SRT 执行：workspace、运行程序目录与明确加载的资源可读，`workspace_write` 下的 workspace 可写，`read_only` 只允许临时目录写入，daemon 私有目录保持受保护。真实用户 HOME 和 workspace 同级目录被加入拒绝读取规则，只有明确允许的 workspace、程序及资源路径可以例外读取。

隔离的 stdio MCP 通过 worker 转发 JSON-RPC 管道。完全访问和原生 Windows 直接在宿主机启动普通 stdio MCP。内置 Computer Use MCP 的原生 helper 在所有模式下都由宿主机启动，依赖 macOS 系统权限和工具授权。`computer_exec` 的受限 JavaScript 子进程在非完全访问模式下使用单独的 SRT 只读且禁止联网配置。

HTTP、SSE 和 OAuth 没有本机子进程，保留 URL、DNS 固定、私网访问选项、重定向、凭据目标和流量上限校验；HTTP、SSE 在完全访问下忽略沙箱域名规则，OAuth 仍使用该规则。远端服务器自身的文件系统和副作用不属于本机沙箱，工具调用仍由 MCP 连接信任及当前审批策略约束。

宿主机重跑不实现第二套操作系统隔离：它只保留固定 workspace cwd、环境变量白名单、超时、输出限制和中止。完全访问直接在宿主机执行，不进入此提升流程；其他模式下，会话授权和命令前缀不能自动批准这次提升。批准前会说明 SRT violation 和首次沙箱执行已经产生的可追踪文件变化数量；最终文件变化以首次执行前的 workspace 快照为基准统一统计。用户拒绝、宿主命令失败或普通沙箱命令失败时，已经产生的可追踪文件变化仍进入 Session 事件，不提供事务回滚。

## 命令生命周期

Agent 的 `run_command` 已通过 `CommandProcessManager` 使用长驻进程接口。默认等待 10 秒（可设为 250ms–30 秒）；命令仍运行时返回 `processId`，随后通过 `wait_command` 读取状态、`stop_command` 停止进程树。进程总超时默认 4 小时，最长 24 小时；每个 Session 最多 8 个活动任务、100 个保留记录。运行中输出保留尾部 1 MiB，工具和状态快照展示尾部 64 KiB，并标记截断。

后台命令继续受 watchdog、总超时、明确停止和 daemon 关闭管理；后台返回只表示进程仍在运行，成功以最终 `completed` 和退出码 0 为准。文件变化在进程结束时以启动前快照统一统计；扫描有数量、文本大小和时间预算，缺失快照或超出预算会标记统计可能不完整。`command.started` / `command.exited` 持久化，`command.updated` 只用于实时 SSE；daemon 重启会把未结束的记录恢复为 `daemon_stopped`。

## 原生 Windows

安装项目依赖后，在仓库根目录运行一次以下命令，并批准 Windows 的管理员提示。命令使用项目锁定的 SRT，准备专用本地账户和网络过滤规则，并保留该账户原有的宿主用户目录读取边界。

```powershell
node packages/sandbox/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js windows-install --skip-profile-grant
```

在普通审批模式下，`run_command` 通过 Windows SRT worker 执行，本机一次运行一个隔离命令。Windows 的读取以专用账户的 NTFS 权限为基线。普通 stdio MCP 以 daemon 的 Windows 用户身份启动，可以和 SRT 命令同时运行，工具调用继续遵循当前审批策略。

Windows SRT 的写受限令牌限制使用 Schannel 的 HTTPS 客户端，例如系统自带的 `curl.exe` 和 PowerShell 的 Web 请求命令。x64 与 ARM64 的 SRT helper 随依赖分发。受监管命令使用 `spawnSandboxedProcess`，独立的一次性 `runSandboxedCommand` 验证入口用于 Linux 和 macOS。

Windows 用户也可使用 [WSL 2 运行说明](../../docs/runtime-setup.md#windows-上使用-wsl-2-运行沙箱) 中的 Linux 后端。

## 网络许可

可在应用设置的“沙箱”菜单中维护 Profile 与联网规则，也可在 daemon 数据目录（SQLite 所在目录）保存 `sandbox-policy.json`：

```json
{
  "profile": "workspace_write",
  "allowedDomains": ["registry.npmjs.org:443", "github.com", "*.githubusercontent.com"],
  "deniedDomains": ["169.254.169.254", "*:22"]
}
```

允许规则直接放行，拒绝规则优先。`allowedDomains` 为空时允许所有未被拒绝的目标；非空时，`run_command` 访问其他 host:port 可请求临时审批，普通 MCP 只连接允许列表中的目标。规则支持域名、IP 和端口；allow 不接受全局 `*`，需要允许全部时保持为空；deny 可用 `*` 或 `*:port`。`profile` 可选 `read_only` 或 `workspace_write`，策略文件缺失时默认 `workspace_write` 且允许/拒绝列表均为空；格式错误会阻止隔离启动。

这些 SRT 文件及域名规则适用于隔离进程，HTTP/SSE MCP 在非完全访问模式下也使用域名规则。内置文件工具在所有模式下执行 workspace 真实路径和 daemon 受保护目录检查。MCP OAuth 始终使用联网规则。

## Shell 凭据代理

可在 daemon 数据目录创建权限为 0600 的 `sandbox-credentials.json`：

```json
{
  "credentials": [
    {
      "name": "GITHUB_TOKEN",
      "value": "真实 Token",
      "injectHosts": ["api.github.com"]
    }
  ]
}
```

`injectHosts` 使用 SRT 支持的无端口主机规则；`allowedDomains` 非空时必须覆盖这些目标，为空时由沙箱边界把凭据目标交给 SRT 注册，但不会把凭据发送到其他主机。命令读取该变量时只能得到随机哨兵值；SRT TLS 代理仅向指定目标发送请求时替换真实值。该文件不进入 Web、SQLite、Session JSONL 或日志。

隔离 stdio MCP 的环境变量凭据通过 SRT 哨兵传入，联网范围由沙箱域名策略约束。宿主机 stdio MCP 的凭据直接传入子进程环境。MCP 环境变量凭据没有逐变量 `injectHosts` 配置。

## 验证

在 macOS、Linux 或 WSL 2 中，可在仓库根目录使用 Node.js 24 执行一次性沙箱验收：

```sh
node --import ./apps/daemon/node_modules/tsx/dist/loader.mjs packages/sandbox/scripts/verify-sandbox.mts
pnpm --filter @pi-harness/sandbox --filter @pi-harness/policy typecheck
```

验证脚本只使用临时目录和本机临时 HTTP 服务，覆盖一次性沙箱 API 的 workspace 读写、越界和符号链接阻断、凭据保护、策略原子写入、代理许可与直连阻断、进程组清理、超时、中止、输出上限、并发与退出码。它不等同于受监管后台命令、真实 stdio MCP 或各平台的完整验收。

实现依赖：[Anthropic Sandbox Runtime](https://github.com/anthropics/sandbox-runtime)。
