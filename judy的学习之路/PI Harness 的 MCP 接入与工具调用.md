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

### 连接和租约是什么关系

连接是 Client 与 MCP Server 之间的逻辑通信关系。stdio 通过子进程的标准输入输出通信；Streamable HTTP 使用 HTTP transport，逻辑连接不意味着必须一直占用同一条 TCP 连接。

租约是 `McpClientManager` 提供的一次使用权。工具通过 `acquire` 获取租约，用其中的 `client` 发起请求，结束后调用 `release`。管理器通过租约计数跟踪 Client 是否正在使用，空闲时可以保留连接供下一次调用复用。

```text
第一次调用
  acquire → 创建或取得 Client → callTool → release
                     ↓
              管理器保留连接

后续调用
  acquire → 尝试复用 Client → callTool → release
```

复用有条件。管理器按 Session 对应的 owner、工作目录、服务器 ID、配置版本和凭据身份等信息区分连接。配置变化、连接失效、daemon 关闭或达到连接数量上限时，原连接可能被关闭，后续调用需要创建新 Client。释放租约本身通常不会关闭已经建立的连接。

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

## 协议版本、补充信息与操作续接

MCP Server 需要用户补充信息时，能否继续执行取决于工具设计、双方使用的协议版本，以及 Client 和 Host 是否实现对应的交互方式。先看协议版本如何确定，再看服务端怎样提出请求。

### 连接时怎样确定协议版本

MCP 规范使用日期作为版本标识，例如 `2025-06-18` 和 `2025-11-25`。它表示协议规范版本，不是服务器发布时间，也不是 SDK 包版本。不同规范版本对消息格式和可用能力有不同约定。

项目当前采用 2025 系列的初始化握手流程。Client 发送 `initialize`，提议协议版本并声明客户端能力；Server 返回它选定的版本和服务端能力。Client 能接受该版本时，发送 `notifications/initialized`，然后双方继续通信。无法达成一致时连接不能正常使用。具体版本由当次协商决定。[MCP 协议版本说明](https://php.sdk.modelcontextprotocol.io/protocol-versions/)

```text
Client 发送 initialize，提议版本并声明能力
    ↓
Server 返回选定版本和服务端能力
    ↓
Client 接受后发送 notifications/initialized
    ↓
双方使用协商结果通信
```

项目在 [client-manager.ts](../apps/daemon/src/mcp/client-manager.ts) 中调用 `client.connect`，握手由 SDK 处理。当前默认连接范围不包含仅支持 2026 `server/discover` 现代协议的服务器，见 [架构设计](../docs/架构设计.md)。协议定义了某项能力，还需要 Client 和 Host 实现它，用户才能完成对应的交互。

### 方式一，服务端返回普通工具结果

Server 可以让工具返回普通结果，提示缺少项目 ID、需要确认操作，或者提供一个供后续调用使用的标识。`client.callTool()` 返回时，本次工具调用已经结束。

```text
第一次 tool call → Server 返回普通结果，提示补充信息
    ↓
Agent 根据结果询问用户 → 用户回答
    ↓
Agent 按服务端工具定义发起新的 tool call
```

PI Harness 会转换工具结果并交给 Agent 继续处理。项目不会仅凭结果文字自动生成内置审批卡，也不会自动恢复已经返回的那次 MCP 调用。Agent 能否理解并继续，取决于工具结果、工具描述、当前上下文以及服务端设计。

### 方式二，2025 系列协议中的 Elicitation

支持 Elicitation 的 Server 可以在工具执行过程中，通过 `elicitation/create` 向 Client 请求用户输入。Host 负责展示问题，Client 再把答复返回 Server。双方需要支持对应的协议版本和能力。

```text
tool call 尚未返回
    ↓
Server 发起 elicitation/create
    ↓
Host 收集用户答复 → Client 返回答复
    ↓
Server 继续执行 → 返回最终工具结果
```

具体交互可以是表单，也可以引导用户前往 URL，取决于协议版本和双方支持的模式。[MCP TypeScript SDK 的 Elicitation 说明](https://ts.sdk.modelcontextprotocol.io/v2/servers/elicitation)

PI Harness 当前尚未将 Elicitation 接入可用的产品流程，因此不能依靠现有实现处理这种服务端主动发起的输入请求。限制记录在 [MCP 使用说明](../docs/mcp-usage.md) 中。

### 方式三，2026 协议中的多轮请求

2026-07-28 协议引入 Multi Round-Trip Requests，简称 MRTR。Server 可以返回协议定义的 `input_required`，附带输入请求和 `requestState`。支持该流程的 Client 收集用户答复后，带上 `inputResponses` 和原样返回的状态令牌重新发起请求。

```text
第一次请求 → Server 返回 input_required 和 requestState
    ↓
Host 收集用户输入
    ↓
第二次请求携带 inputResponses 和 requestState
    ↓
Server 继续处理 → 返回结果
```

第一次协议请求已经返回，整个工具交互仍在进行。`input_required` 是协议定义的结构，与服务端自定义的普通文本结果不同。PI Harness 当前没有接入这套现代协议交互流程。[MCP TypeScript SDK 多轮请求说明](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)

### 后续调用怎样找到之前的操作

普通结果要求用户确认时，服务端可能返回 `operationId` 并将待确认操作保存在自己的存储中。后续调用传回该标识和用户答复，即使 Client 已重新创建，也可能找到原操作。操作是否有效、账号是否匹配，以及使用哪个工具继续，都由服务端定义。

如果服务端只在某个连接的内存里保存状态，后续可能依赖同一个 MCP 会话。连接被回收、服务重启或状态过期后，原操作可能无法继续。复用 Client 可以保留仍然有效的通信关系，却不能保证服务端保留了业务状态。

PI Harness 的 Session ID 用来标识项目对话。支持有状态 Streamable HTTP 的服务可能另外使用 MCP Session ID 关联协议请求；服务自己也可能提供 `operationId` 等业务标识。这些标识的职责不同，不能互相替代。无状态 MCP 连接同样可以借助服务端保存的业务标识继续操作，前提是服务提供并支持这种约定。MRTR 的 `requestState` 则属于协议定义的续接信息，支持该协议的 Client 需要将它原样传回。

项目自己的工具审批发生在 `beforeToolCall` 阶段。需要审批时，Agent 会等待用户决定，批准后才执行 MCP 工具并发送 `callTool`。这时本次工具调用尚未结束，通常也还没有开始执行服务端工具。拒绝、超时或中止时则不会继续发送这次调用。

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
