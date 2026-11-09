# PI Harness 的 MCP 接入与工具调用

Agent 调用一个 MCP 工具时，模型看到的依然是一个普通的工具定义。它根据工具名和参数 Schema 生成 tool call，Agent 找到对应工具，经过权限检查后执行。变化发生在工具的 `execute` 里面，项目通过 MCP Client 把工具名和参数发送给 MCP Server，再把返回结果交还给 Agent。

沿着 PI Harness 的代码看，这个过程分成两段。第一段把服务器提供的工具发现出来，包装成 Agent 能调用的工具。第二段在模型真正发出 tool call 后，找到对应连接并调用服务端工具。

```text
MCP Server 提供工具定义
    ↓
daemon 连接 Server，发现并保存工具目录
    ↓
Run 开始时将 MCP 工具包装成 ToolRegistration
    ↓
Agent 使用 tool_search 按需加载工具
    ↓
模型发出 tool call，Agent 执行对应工具
    ↓
Policy 和审批 → MCP 工具的 execute
    ↓
获取或创建 MCP Client → client.callTool
    ↓
MCP Server 执行工具并返回结果
```

本文以仓库中的实现为准，代码位置可能随项目演进调整。

## MCP Client 放在哪里

PI Harness 使用 React Web 和本地 daemon。Web 提供服务器设置、授权入口和状态展示，daemon 负责真正的 MCP 连接、凭据、能力发现和工具调用。Agent Runtime 通过 daemon 注入的工具准备函数使用这些能力。

项目使用 `@modelcontextprotocol/client` 提供的 SDK。在 [client.ts](../apps/daemon/src/mcp/client.ts) 中，`createMcpClient` 创建 SDK 的 `Client`。下面摘取了构造的主要部分。

```ts
return new Client(
  { name: "pi-harness", version: "0.0.0" },
  {
    capabilities: {},
    responseCacheStore: new InMemoryResponseCacheStore({ maxEntries: 64 }),
    // 其他连接配置见项目源码
  },
);
```

每个 Client 使用独立的响应缓存，避免不同服务或账号之间误用缓存。项目在 SDK 外围管理连接生命周期、权限和凭据。

Client 还需要 transport 与服务通信。[transport 工厂](../apps/daemon/src/mcp/transports/factory.ts) 根据配置选择连接方式。

| 连接方式 | 通信过程 | 常见用途 |
| --- | --- | --- |
| stdio | 启动本地进程，通过标准输入和输出交换消息 | 本机 MCP Server |
| Streamable HTTP | 连接 HTTP endpoint | 远程 MCP Server |
| SSE | 使用 SSE transport | 使用 SSE 的兼容服务 |

HTTP 连接使用 SDK 的 `StreamableHTTPClientTransport`。项目传入 OAuth provider 和受约束的 `fetch`，处理鉴权、网络目标和超时等问题。stdio 使用项目实现的 [McpStdioTransport](../apps/daemon/src/mcp/transports/stdio.ts)，它遵循 SDK 的 transport 接口，同时控制进程启动、沙箱和输入输出。

[McpClientManager](../apps/daemon/src/mcp/client-manager.ts) 负责管理这些 Client。调用 `acquire` 时，它会根据 Session 上下文、服务器配置和凭据身份寻找可复用连接，没有合适连接才创建 Client 和 transport，再通过 SDK 的 `client.connect` 完成连接和握手。

调用方使用的是连接租约。一次工具调用结束后释放租约，Client 可以继续留在管理器中复用。配置失效或 daemon 关闭时，管理器会关闭相关连接。

## 服务端工具怎样进入项目

MCP Server 的地址只告诉项目去哪里连接。Agent 还需要知道服务端有哪些工具，以及每个工具接受什么参数。

服务器启用并建立信任后，[McpDiscovery](../apps/daemon/src/mcp/discovery.ts) 根据服务端声明的能力调用 SDK，例如通过 `listTools` 获取工具列表。服务端返回工具名称、描述和输入 Schema。项目也会发现 Resources、Resource Templates 和 Prompts，检查目录大小与条目数量，再由 [McpDiagnosticsService](../apps/daemon/src/services/mcp-diagnostics-service.ts) 保存能力目录。

目录作为可重建数据存放在 SQLite。daemon 启动时会复用与当前配置版本匹配的有效目录。远程服务在配置不变的情况下新增或修改工具，需要在详情中点击「刷新状态」，让新目录在下一轮 Run 生效。

项目目前让 Agent 实际调用 MCP Tools。资源和提示词可以发现并展示，独立读取资源、调用提示词等流程还没有接入。

## 从工具目录到 Agent 工具

daemon 在 [create-server.ts](../apps/daemon/src/server/create-server.ts) 中创建 `McpToolService`，并将它的 `prepare` 方法传给 `AgentManager`。这样 Agent Runtime 能请求外部工具，MCP 的连接细节仍由 daemon 管理。

每次 Run 开始时，[RunCoordinator](../packages/agent-runtime/src/run-coordinator.ts) 调用 `prepareExternalTools`，随后把得到的注册项加入工具注册表。

```ts
externalTools = await this.prepareExternalTools?.(
  this.sessionId,
  this.workspaceRoot,
  preparationAbortController.signal,
);

this.toolRegistry.replaceExternal(externalTools?.registrations ?? []);
```

[McpToolService.prepare](../apps/daemon/src/services/mcp-tool-service.ts) 遍历已启用且可信的服务器，读取本地目录，检查工具设置和 Schema，然后将每个可用工具包装成 `ToolRegistration`。注册项包含来源、审批策略和 Agent 工具。Agent 工具又包含工具名、描述、参数和 `execute` 函数。

模型使用的名称由服务器名称和原始工具名生成，见 [tool-alias.ts](../apps/daemon/src/mcp/utils/tool-alias.ts)。名称带有 `mcp_` 前缀和哈希，用于区分不同服务器的工具。真正向服务器发请求时，项目仍使用服务端的原始工具名。

[ToolRegistry](../packages/tools/src/lib/tool-registry.ts) 接收这些注册项，并为工具加上执行保护和超时控制。到这里，MCP 工具已经有了和其他 Agent 工具一致的调用形式。

### 工具何时交给模型

项目不会在 Run 开始时把所有 MCP 工具的完整定义都交给模型。Agent 可以先调用内置的 `tool_search`，按服务名、工具名或自然语言描述检索。

例如，用户希望查看 Supabase 项目中的数据表，模型可能搜索 `Supabase 查看数据表`。项目结合词面和语义检索，选出匹配的工具。默认加载最多 8 个，单次最多 10 个，整轮向模型暴露的工具总数最多 64 个。完整 Schema 会在下一次模型请求时提供，随后模型才能按定义发出具体的工具调用。

搜索和加载只影响模型能看到哪些工具。真正执行时仍要经过 Policy 和审批。相关代码位于 [tool-search.ts](../packages/tools/src/tools/tool-search.ts) 和 [run-coordinator.ts](../packages/agent-runtime/src/run-coordinator.ts)。

## 从 tool call 到 MCP Server

模型拿到工具定义后，可以生成包含工具名和参数的 tool call。`pi-agent-core` 的 Agent 找到同名工具，执行前先调用项目挂载的 `beforeToolCall` 钩子。项目通过这条路径处理权限和审批，执行后的记录也通过相应钩子处理。

普通本地工具的 `execute` 会直接执行本地逻辑。MCP 工具的 `execute` 位于 [mcp-tool-service.ts](../apps/daemon/src/services/mcp-tool-service.ts)，它先检查参数和当前配置，再通过 Client 转发请求。下面保留了这段逻辑的主要步骤。

```ts
const normalizedArgs = normalizeArguments(args);

// 复查参数、服务器配置和工具定义
await verify(normalizedArgs, requestSignal);

// 获取匹配的 MCP Client 租约
const lease = await this.clients.acquire(context, requestSignal);

try {
  // 使用服务端原始工具名发起 MCP 工具调用
  result = await lease.client.callTool(
    {
      name: tool.name,
      arguments: normalizedArgs as Record<string, unknown>,
    },
    {
      signal: AbortSignal.any([requestSignal, lease.signal]),
      timeout: server.config.requestTimeoutMs,
    },
  );
} finally {
  lease.release();
}
```

`verify` 会检查参数是否符合 Schema，也会复查服务器上下文和工具定义指纹。用户如果在 Run 期间停用了服务器，或者工具定义已经变化，旧调用会被阻止。

`callTool` 通过当前 transport 把请求发给 MCP Server。对于 HTTP 服务，请求通过网络发送；对于 stdio 服务，消息通过本地子进程的标准输入输出传递。服务端返回后，项目在 [tool-result.ts](../apps/daemon/src/mcp/utils/tool-result.ts) 中转换结果，并移除已知连接凭据，再把结果交给 Agent。

连接中断或超时时，服务端可能已经执行了操作，只是响应没有到达。项目把这种情况视为结果未知，不自动重试，避免重复产生外部副作用。

## 审批与连接信任

连接信任、账号鉴权和工具审批分别解决不同问题。信任表示允许项目连接这份服务器配置。OAuth 或 Token 用来访问服务账号。工具审批决定某次工具调用是否允许执行。

未分类的 MCP 工具遵循全局审批策略。请求批准模式下通常需要人工批准，帮我批准模式下由独立模型复核，不确定时仍请求人工批准，完全访问模式下自动批准工具调用。用户还可以明确标记可信只读工具，或对指定范围和精确参数授予持久权限。服务端自己声明的只读 annotation 不会自动获得免审批权限。

普通审批模式下，本地 stdio 服务由 SRT 沙箱监管，远程 HTTP 和 SSE 服务经过网络规则及连接目标检查。Windows 当前无法在非完全访问模式下启动普通 stdio MCP；完全访问模式会以宿主机权限运行本地服务。远程服务自身的文件和副作用也不在本机操作系统沙箱内，仍需依靠服务信任和工具审批。

## 项目内置了哪些 MCP App

项目内置了多个插件 App 的 MCP 配置，包括 Supabase、GitHub、Notion、Google 和 Vercel。以 [Supabase 的 App 配置](../packages/tools/src/plugins/supabase/.app.json)为例，关键部分如下。

```json
{
  "mcpServer": {
    "type": "http",
    "url": "https://mcp.supabase.com/mcp"
  }
}
```

这里声明了远程 MCP endpoint。项目中的配置负责连接，实际的 Supabase MCP Server 运行在远程。用户安装插件后，需要单独开启 App，并按提示完成该服务的 OAuth 授权。

插件 App 与 Skill 各自有开关。App 提供 MCP 服务连接，Skill 提供任务相关的指导内容。插件 App 最终仍通过项目统一的 MCP Client、能力目录和工具执行链工作。

项目还提供本地 Computer Use 原生 helper，其 App 配置也接入这套 MCP 流程。该能力目前面向 macOS，并依赖系统权限和应用授权。

## 用户怎样添加自己的 MCP Server

用户可以在侧栏打开「设置 → MCP 服务器」，点击「添加服务器」。界面支持表单和 JSON 两种配置方式。保存后开启服务器，首次连接时审阅地址或命令，再选择「信任并测试连接」。如果服务器需要 OAuth 或静态凭据，按界面提示完成授权。

远程 Streamable HTTP 可以使用下面的示例。地址和令牌需要替换成服务实际提供的内容。

```json
{
  "mcpServers": {
    "my-service": {
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer <你的令牌>"
      }
    }
  }
}
```

`my-service` 是配置中的服务器 ID。服务无需静态凭据时可以省略 `headers`。远程服务如果使用 OAuth，可以在服务器启用后从界面发起授权。

本地服务可以配置 stdio。以下路径和参数仅用于说明格式。

```json
{
  "mcpServers": {
    "my-local-service": {
      "type": "stdio",
      "command": "C:\\path\\to\\mcp-server.exe",
      "args": ["--example"],
      "env": {
        "SERVICE_TOKEN": "<你的令牌>"
      }
    }
  }
}
```

`command` 指向可执行文件，`args` 是独立的参数数组。项目不会将 `command` 当作一整条 Shell 命令解析。具体参数和环境变量需要查看所接入服务的说明。

服务器配置对所有项目共用。非敏感配置保存到 SQLite，Header、环境变量和 OAuth 凭据保存到 daemon 的独立凭据存储。更多配置和故障处理见 [MCP 使用说明](../docs/mcp-usage.md)。
