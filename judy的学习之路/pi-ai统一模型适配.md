# pi-ai 如何统一不同厂商的模型调用

一个 Agent 应用接入多个模型时，很快会遇到协议差异。用户消息、工具定义、图片、流式输出和推理参数都需要转换，模型返回的工具调用和 Token 用量也要整理成应用能够理解的格式。

pi-ai 把这些工作集中到模型调用层。应用使用统一的模型描述、上下文和流式事件，pi-ai 根据模型所属的 Provider 选择认证方式，再把请求交给对应的 API 适配器。适配器负责构造厂商请求，并将响应转换回统一格式。

本文结合 PI Harness 中安装的 `@earendil-works/pi-ai` 0.85.1 版本，以及项目的 Provider 和 Agent 代码展开。不同版本的实现细节可能变化，文章里的代码片段为方便理解做了适当简化。

## 一次请求经过哪些部分

PI Harness 调用模型时，最终会走到 pi-ai 的 `models.streamSimple(model, context, options)`。其中 `model` 描述要调用的模型，`context` 包含消息和工具，`options` 携带超时、取消信号和推理等选项。

请求进入 pi-ai 后，先依据 `model.provider` 找到 Provider 并解析认证信息，接着由 Provider 找到对应的 API 实现。适配器将统一的消息转换为目标 API 的格式，发送请求后再把响应整理成统一的事件流。

```text
Model + Context + Options
            ↓
Models 查找 Provider 并解析认证
            ↓
Provider 选择 API 适配器
            ↓
转换消息、工具和请求参数
            ↓
调用厂商 API
            ↓
转换响应为统一消息和事件
```

这条路径里有两个容易混淆的概念。Provider 表示提供模型服务的实体及其配置，API 表示具体使用哪一种调用协议。同一个协议适配器可以供多个兼容该协议的 Provider 使用。

## 模型先被描述成统一对象

pi-ai 的 `Model` 包含模型 ID、Provider ID、API 类型和服务地址，也包含上下文窗口、最大输出、图片输入与推理能力等信息。

```ts
// 只展示便于理解的部分字段
interface Model {
  id: string;
  provider: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
}
```

应用拿到这个对象后，可以检查模型能力，而不需要为每个模型维护一套独立的判断。PI Harness 会用 `input` 检查模型是否支持图片，用上下文窗口计算输入预算，也会通过 pi-ai 提供的函数获取和调整模型支持的推理档位。

模型信息还包含费用和兼容性配置。费用字段支持根据返回的用量估算成本，估算是否准确取决于费率数据与厂商的实际计费规则。兼容性配置则用于处理同一类 API 下仍然存在的服务差异。

## Provider 和 API 如何配合

pi-ai 用 `createProvider()` 组合 Provider 的名称、地址、认证方式、模型目录和 API 实现。它提供 `Models` 来注册 Provider，并查询对应模型。

当前版本的 OpenAI Provider 使用 OpenAI Responses 适配器。DeepSeek Provider 使用 OpenAI Completions 适配器，并提供自己的服务地址、认证方式和模型目录。两个 Provider 对外都能通过相同的 `Models` 接口调用，内部仍然各自保留配置。

`Models.streamSimple()` 首先根据 `model.provider` 找到 Provider。完成认证解析后，它调用 Provider 的 `streamSimple()`。如果该 Provider 配置了多个 API 实现，`createProvider()` 会再依据 `model.api` 选择对应实现。缺少匹配实现时，请求会返回错误。

PI Harness 在 `packages/providers` 中创建 pi-ai 的 `Models`，并将支持的 Provider 注册进去。项目没有再维护一份只转发模型查询的注册表。`ProviderService` 使用这个 `Models` 查询 Provider 和模型，同时叠加项目自己的启用状态与配置检查。

项目按 Provider 分别动态导入 pi-ai 的内置实现，避免引入全部 Provider 的聚合入口。当前 daemon 启动时会加载项目支持列表中的内置 Provider，因此这里的按需导入描述的是模块选择方式，不能理解成用户首次选择某个 Provider 时才注册它。

## 消息和工具先用统一格式表达

pi-ai 的 `Context` 包含可选的 System Prompt、消息列表和工具列表。消息主要分为用户消息、助手消息和工具结果。内容块可以表示文本、图片、思考内容或工具调用。

一次工具调用在统一消息中的关系大致如下。

```text
user           用户要求读取文件
assistant      模型发出 read_file 工具调用
toolResult     工具返回内容，并用 toolCallId 关联调用
assistant      模型根据工具结果继续回答
```

调用不同厂商时，上层继续使用这些统一消息。具体适配器再把消息角色、内容块和工具参数转换成目标 API 接受的结构。例如 OpenAI Completions 和 Anthropic Messages 分别有自己的消息与工具转换函数。

工具参数通过 schema 描述。模型调用时，适配器将工具定义映射到厂商格式；模型返回工具调用时，适配器再把工具名称、调用 ID 和参数转回 pi-ai 的内容块。

工具真正执行仍需要上层负责。PI Harness 使用 `pi-agent-core` 的 `Agent` 执行模型与工具之间的循环，并通过工具钩子接入权限、审批和审计。模型提出写文件请求后，项目仍会执行自己的策略和路径检查。

## 历史消息怎样适配新模型

用户在同一个会话里切换模型时，历史消息也要发给新模型。pi-ai 在发送前运行 `transformMessages()`，处理跨模型或跨 Provider 时容易出现的问题。

不同 API 对工具调用 ID 有不同的格式要求。转换函数可以规范化 ID，并同步修改关联工具结果中的 ID，让调用和结果继续对应。

思考内容也有自己的限制。一些签名或隐藏内容只适用于原来的模型。切换模型时，pi-ai 会根据内容类型和来源决定保留、转换或丢弃，避免把原模型的专有数据当成新模型可用的签名。

历史里如果存在没有结果的工具调用，转换函数可以补入带错误状态的合成结果，以满足目标 API 对消息顺序的要求。对于不支持图片的模型，pi-ai 也有将图片替换为文本占位的处理。

PI Harness 在新输入进入模型前会检查图片能力，对于不支持图片的模型明确拒绝图片输入。这个项目规则与 pi-ai 对历史消息的转换发生在不同位置。

## 兼容同一种 API，也会遇到细节差异

多个服务可能采用 OpenAI Completions 风格的接口，但对推理参数或工具调用的支持仍有差异。pi-ai 的协议适配器会结合模型信息和兼容性设置构造请求。

以推理功能为例，有些服务使用 `enable_thinking`，有些接受 `reasoning_effort`，还有服务使用嵌套的 `reasoning` 对象。上层提供统一的推理档位后，适配器会按目标服务和模型所支持的格式映射。

统一接口让调用方少写许多协议分支，但不会让所有模型拥有相同能力。应用仍需要查看模型元数据，并处理目标服务不支持某项功能的情况。

PI Harness 也有自己的模型请求偏好设置。项目通过请求 payload 钩子，为支持相应参数的 API 设置输出详细程度或推理摘要。代码只对匹配的 API 类型应用这些设置。

## 不同厂商的流式响应如何统一

厂商返回的流式事件各有格式。pi-ai 的适配器读取原始响应后，向上层输出统一的 `AssistantMessageEvent`。

```text
start
text_start / text_delta / text_end
thinking_start / thinking_delta / thinking_end
toolcall_start / toolcall_delta / toolcall_end
done 或 error
```

这样，处理文本增量的代码可以监听 `text_delta`，不必再区分消息来自哪个厂商。思考内容和工具调用也有各自的增量事件。完整响应被整理为 `AssistantMessage`，其中保留内容块、模型信息、用量和结束原因。

工具参数可能以不完整的 JSON 片段陆续到达。适配器会累积片段，并尝试解析当前已有的内容，让上层能够展示正在生成的参数。生成中的参数仍可能变化，工具执行需要等待完整调用并经过校验。

流式事件中的 `partial` 是持续更新的响应对象，读取它时要留意它代表当前累积状态，而不是每个事件时刻的独立快照。

## 结束状态和用量也有统一表示

厂商对生成结束的命名不同，pi-ai 将它们映射到统一的结束原因。常见结果包括正常结束 `stop`、输出达到限制 `length`、请求工具 `toolUse`、出错 `error` 和中止 `aborted`。

用量信息也会整理为输入、输出、缓存读取和缓存写入等字段。适配器可以结合模型费率计算费用。各厂商提供的用量细节存在差异，缺少的字段不能凭统一类型推断出真实数值。

PI Harness 根据这些结果记录和展示用量。项目的自定义 Provider 模型当前将费率设为零，因此自定义模型的费用展示不能视为实际账单。

## 认证和自定义 Provider

pi-ai 提供认证解析与 `CredentialStore` 接口。模型请求到达具体 API 适配器前，`Models` 会根据 Provider 配置、凭据存储和调用选项解析认证信息。

PI Harness 的 daemon 实现了文件型 `CredentialStore`，用于保存 API Key 和 OAuth 凭据。Provider 的非敏感配置放在 SQLite，凭据单独保存。Web 获取认证状态和脱敏信息，模型凭据留在 daemon。

对于用户配置的兼容端点，项目使用 pi-ai 的 `createProvider()`，并选择现有的协议实现。当前自定义 Provider 支持 OpenAI Completions、OpenAI Responses 和 Anthropic Messages。daemon 校验配置后，将模型定义和服务地址注册到同一个 `Models` 中。

自定义模型当前标记为文本输入，且不开放任意兼容参数或请求头配置。接入一个兼容端点时，需要按项目支持的范围配置，不能假定厂商提供的每个扩展字段都已暴露。

## pi-ai 与 Agent 应用的边界

PI Harness 的 `ProviderService` 在启动 Run 时检查 Provider、模型和认证，随后返回 pi-ai 的 `Model` 与绑定后的 `models.streamSimple`。项目把这两者交给 `pi-agent-core` 的 `Agent`。

Agent 负责对话和工具执行循环，项目的 `RunCoordinator` 则处理上下文投影、工具审批和事件订阅。收到 pi-ai 与 Agent 产生的事件后，项目会把它们转换成自己的 `HarnessEvent`。Web 接收项目定义的 SSE 事件，完整消息和恢复所需事件写入 Session JSONL。

因此，pi-ai 给项目提供了统一的模型请求和响应接口。会话管理、工具权限、上下文压缩与持久化仍由应用按自己的需求实现。

## 代码阅读入口

- [PI Harness 的 Models 创建入口](../packages/providers/src/create-models.ts)
- [内置 Provider 加载列表](../packages/providers/src/load-built-in-provider.ts)
- [Provider 配置、认证与模型解析](../apps/daemon/src/services/provider-service.ts)
- [Agent 创建与流函数注入](../packages/agent-runtime/src/create-agent.ts)
- [Run 编排与请求记录](../packages/agent-runtime/src/run-coordinator.ts)
- [Agent 事件到项目事件的转换](../packages/agent-runtime/src/event-adapter.ts)
- [pi-ai 安装包说明](../node_modules/.pnpm/@earendil-works+pi-ai@0.85.1_ws@8.21.2_zod@4.4.3/node_modules/@earendil-works/pi-ai/README.md)
- [pi-ai 的 Models 和 Provider 实现](../node_modules/.pnpm/@earendil-works+pi-ai@0.85.1_ws@8.21.2_zod@4.4.3/node_modules/@earendil-works/pi-ai/dist/models.js)
- [pi-ai 的历史消息转换](../node_modules/.pnpm/@earendil-works+pi-ai@0.85.1_ws@8.21.2_zod@4.4.3/node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js)
