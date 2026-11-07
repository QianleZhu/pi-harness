# 认识 pi-agent-core：让模型调用工具并持续工作

平时调用大模型，我们通常发送一段消息，然后等待回复。Agent 则可以在回答之前采取行动：读取文件、搜索信息、执行工具，再根据结果决定下一步。

`pi-agent-core` 做的就是把这些步骤串起来。它负责管理消息和 Agent 的运行状态，驱动模型调用、工具执行与事件通知。真正的模型请求由 `pi-ai` 提供；具体工具、安全审批和会话保存则需要应用自己实现。

## 创建一个 Agent

创建 Agent 时，先告诉它使用什么模型、有哪些工具、之前聊过什么，以及怎么调用模型：

```ts
// 创建一个具备上下文和工具的 Agent。
const agent = new Agent({
  initialState: {
    model,
    systemPrompt: "你是一个帮助用户分析项目的助手。",
    messages: [],
    tools: [readFileTool],
  },
  streamFn: models.streamSimple.bind(models),
  toolExecution: "parallel",
});
```

这里的 `model` 是模型定义，`tools` 是可以调用的工具，`streamFn` 负责发起流式模型请求。PI Harness 也采用这样的方式创建 Agent，只是传入的消息、工具和提示词由项目按当前会话组装。

接下来就可以提交任务：

```ts
// 启动 Agent，让它自行决定是否使用工具。
await agent.prompt("读取 package.json，介绍这个项目的技术栈。");
```

如果模型认为需要读文件，它会生成一次工具调用。Agent 执行工具，把结果交还模型，再让模型继续回答。这个过程可以重复多轮。

```text
用户提问 → 模型请求工具 → 执行工具 → 结果交给模型 → 回答或继续调用工具
```

## 工具是怎样接入的

工具由应用定义。下面是一个简化示例：

```ts
// 定义工具参数，让模型知道应该传入什么。
const parameters = Type.Object({
  path: Type.String({ description: "要读取的文件路径" }),
});

// 将文件读取能力提供给 Agent。
const readFileTool = {
  name: "read_file",
  label: "Read file",
  description: "读取工作区中的文本文件",
  parameters,
  executionMode: "parallel",

  // 执行前应检查路径，确保文件位于允许访问的工作区。
  async execute(_toolCallId, input, signal) {
    const content = await readWorkspaceFile(input.path, signal);

    return {
      content: [{ type: "text", text: content }],
      details: {},
    };
  },
};
```

模型看到的是工具名称、说明和参数；真正读取文件的是 `execute()`。示例中的 `readWorkspaceFile` 代表应用提供的读取函数。PI Harness 的实际工具还包含路径检查、分页和输出长度限制。

### AgentTool 类型

`pi-agent-core` 使用 `AgentTool` 接口描述一个可供 Agent 调用的工具。它约定工具需要提供哪些信息，以及执行函数如何接收参数和返回结果。具体的读文件或执行命令逻辑仍由应用编写。

PI Harness 中的 `read_file` 使用了两个类型参数。

```ts
// 第一个类型参数是工具参数的 TypeBox Schema，第二个是结果详情的类型。
AgentTool<typeof ReadFileParameters, ReadFileDetails>
```

`ReadFileParameters` 描述 `path`、`offset` 和 `limit` 等输入。核心库从 Schema 推导 `execute` 的参数类型。`ReadFileDetails` 则描述结果中 `details` 的结构，例如读取的起止行和是否截断。

| 字段 | 作用 |
| --- | --- |
| `name` | 工具的稳定名称，模型通过它指定要调用的工具。 |
| `description` | 说明工具的用途，帮助模型选择工具。 |
| `parameters` | TypeBox Schema，描述参数类型、必填项和约束。 |
| `label` | 供界面展示的名称。 |
| `executionMode` | 控制工具调用使用 `parallel` 或 `sequential` 执行模式。 |
| `execute` | 接收工具调用参数并执行实际操作。 |

`execute` 接收调用 ID、从 Schema 推导出的参数、可选的 `AbortSignal` 和可选的 `onUpdate` 回调。调用 ID 用于关联执行过程；取消信号让耗时操作能够响应中止；进度回调用于工具运行时上报中间结果。

工具成功时返回 `AgentToolResult`。其中 `content` 包含返回给模型的文本或图片，`details` 保存供应用展示和处理的结构化信息。例如 `read_file` 在 `content` 中返回文件文本，在 `details` 中记录路径、起止行和截断状态。执行失败时工具应抛出错误，让 Agent 按失败结果处理。

当前版本还提供可选的 `prepareArguments`，用于在 Schema 校验前适配原始参数，以及描述未知执行结果恢复策略的 `replay`。核心库允许省略 `executionMode` 并使用默认模式；PI Harness 的工具注册器要求每个工具明确声明执行模式。

`AgentTool` 定义了调用接口，权限策略、审批、超时和路径保护则由 PI Harness 的工具注册与执行链另外装配。工具的描述可以引导模型使用工具，实际权限仍要由执行代码检查。

工具执行前后，Agent 还提供两个钩子：

```ts
// 工具执行前检查权限，必要时等待用户审批。
agent.beforeToolCall = async (context, signal) => {
  return await checkToolPermission(context, signal);
};

// 工具执行后记录结果和审计信息。
agent.afterToolCall = async (context) => {
  await recordToolExecution(context);
};
```

这两个检查函数同样由应用实现。PI Harness 利用这些钩子接入自己的权限和审批机制。

## 通过事件观察执行过程

Agent 会在运行、生成消息和执行工具时发出事件。订阅后，应用可以展示正在生成的内容或工具状态：

```ts
// 订阅 Agent 事件，并在不再需要时取消订阅。
const unsubscribe = agent.subscribe((event) => {
  if (event.type === "message_update") {
    console.log("消息正在更新", event.assistantMessageEvent);
  }

  if (event.type === "tool_execution_start") {
    console.log("开始执行工具", event.toolName);
  }
});
```

PI Harness 会把这些事件转换成自己的事件格式，再推送给 Web 界面。事件结束并不总意味着所有收尾工作已经完成：异步监听器执行完毕后，Agent 才真正空闲。

## 六个常用控制方法

这几个方法都由 `Agent` 实例提供，PI Harness 也都有直接使用。

| 方法 | 用途 |
| --- | --- |
| `prompt()` | 提交消息并开始运行。 |
| `continue()` | 从已有上下文或可消费的队列消息继续运行。 |
| `abort()` | 发出中止信号。 |
| `steer()` | 排队一条调整方向的消息。 |
| `followUp()` | 排队一条当前任务完成后继续处理的消息。 |
| `waitForIdle()` | 等待当前运行和相关收尾工作完成。 |

例如，你可以在 Agent 工作时追加任务：

```ts
// 在当前任务结束后，再处理一条补充要求。
agent.followUp({
  role: "user",
  content: "完成后再总结一下风险。",
  timestamp: Date.now(),
});
```

`steer()` 和 `followUp()` 都是入队，但消费时机不同。转向消息会在循环的适当时机优先处理；后续消息等 Agent 原本要停止时才处理。单独调用 `steer()` 不会强行中止正在执行的请求。PI Harness 为了更快响应转向，会先暂存消息并调用 `abort()`，等当前执行结束后再调用 `steer()` 和 `continue()`。

关闭 Agent 时，可以先请求停止，再等待它完成收尾：

```ts
// 请求中止并等待 Agent 空闲，然后清理订阅。
agent.abort();
await agent.waitForIdle();
unsubscribe();
```

## 这些方法内部做了什么

以项目使用的 0.85.1 版本为例，下面是根据源码整理的简化代码，用来说明实现思路。

`prompt()` 会检查 Agent 是否已在运行，规范化输入，然后启动 Agent Loop：

```js
// 根据输入启动一轮 Agent 运行。
async prompt(input, images) {
  if (this.activeRun) throw new Error("Agent 正在运行");

  const messages = this.normalizePromptInput(input, images);
  await this.runPromptMessages(messages);
}
```

`steer()` 和 `followUp()` 的核心都只是把消息放入各自的队列，真正的消费发生在 Agent Loop 中：

```js
// 把转向消息放入队列。
steer(message) {
  this.steeringQueue.enqueue(message);
}

// 把后续任务放入队列。
followUp(message) {
  this.followUpQueue.enqueue(message);
}
```

`abort()` 使用 `AbortController` 发出取消信号；`waitForIdle()` 等待当前运行的 Promise：

```js
// 请求中止当前运行。
abort() {
  this.activeRun?.abortController.abort();
}

// 等待当前运行彻底结束。
waitForIdle() {
  return this.activeRun?.promise ?? Promise.resolve();
}
```

`continue()` 会先检查当前状态和已有消息。对于末尾是助手消息的情况，0.85.1 会先尝试取出排队的转向或后续消息；如果没有可处理的消息，则不能直接从助手消息继续。

## Agent Loop 的核心思路

Agent Loop 的实际实现还要处理错误、事件顺序、取消和并发工具。去掉这些细节后，可以这样理解：

```js
// 持续处理模型回复、工具调用和排队消息。
while (还有任务) {
  // 先把需要转向的消息加入上下文。
  加入转向消息();

  // 请求模型并等待它给出回复或工具调用。
  const 回复 = await 请求模型();

  if (回复包含工具调用) {
    // 工具结果进入上下文，供下一轮模型调用使用。
    const 结果 = await 执行工具(回复.工具调用);
    加入上下文(结果);
    continue;
  }

  // 没有更多工具调用时，再检查是否有后续任务。
  if (有后续消息()) continue;
  break;
}
```

这段是帮助理解的伪代码。实际运行前，Agent 还允许应用通过 `transformContext` 调整发给模型的消息。PI Harness 用它接入上下文裁剪和压缩，避免长对话超出模型窗口，同时保留原始会话记录。

`pi-agent-core` 提供了 Agent 运转的基本机制，PI Harness 在此之上补上工具、安全和产品交互，最终形成可在本地工作的完整 Agent。
