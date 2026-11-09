# 从一次文件修改看 PI Harness 的工具调用机制

让 Agent 修改一个文件，听起来只有两步。模型先读文件，再把内容改掉。等到要把这个过程交给真实用户，就会出现一连串问题。模型怎么知道有哪些工具？参数写错怎么办？两次修改撞到同一个文件怎么办？用户点击停止后，一个正在运行的命令会不会继续留在后台？

PI Harness 把这些问题分给了几个不同的模块。本文根据项目代码和当前安装的 `pi-agent-core` 实现梳理这条链。假设用户要求把 `src/app.ts` 中的标题改成 `Hello PI`，我们沿着这次任务，看每一步为什么存在。

## 模型提出请求，工具在本地干活

模型需要先读取 `src/app.ts`，才能知道标题在哪里。它能够决定请求什么操作，但读磁盘的代码运行在本地 daemon 中。

项目将 `read_file` 定义成一个符合 `pi-agent-core` 的 `AgentTool` 接口的对象。下面保留了理解流程所需的主要字段。

```ts
// 声明模型调用 read_file 时需要提供的参数。
const ReadFileParameters = Type.Object({
  path: Type.String({ minLength: 1 }),
  offset: Type.Optional(Type.Integer({ minimum: 1 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
});

// 创建读取工作空间文本文件的工具。
function createReadFileTool(context): AgentTool {
  return {
    name: "read_file",
    label: "Read file",
    description: "读取工作空间中的 UTF-8 文本，支持按行分页。",
    parameters: ReadFileParameters,
    executionMode: "parallel",

    async execute(toolCallId, input, signal) {
      // 实际实现会检查路径并读取指定范围。
    },
  };
}
```

`AgentTool` 接口由 `pi-agent-core` 提供，具体文件读取逻辑由 PI Harness 编写。项目把工具注册后放进 Agent 的 `tools` 状态，模型请求会带上可用工具的名称、描述和参数定义。模型接下来可以提出一次结构化的工具调用，指出要调用 `read_file`，参数是 `src/app.ts`。

工具结果又会回到模型的上下文中。模型看到文件内容之后，可以继续调用工具，也可以直接回答。这个模型、工具、模型之间的循环由 `pi-agent-core` 驱动，模型和 Provider 响应的适配由 `pi-ai` 负责。

代码可以从 [read-file.ts](../packages/tools/src/tools/read-file.ts)、[agent-manager.ts](../packages/agent-runtime/src/agent-manager.ts) 和 [create-agent.ts](../packages/agent-runtime/src/create-agent.ts) 顺着读下去。

## 参数正确才能进入执行流程

模型已经看到了 Schema，仍有可能输出错误的参数。例如它可能漏掉必填的 `path`，也可能把 `limit` 设置成超出范围的值。项目不能仅靠工具描述要求模型写对。

Provider 的工具调用响应先由 `pi-ai` 适配成统一的消息结构。流式模型可能分多段输出 JSON 参数，当前安装版本的部分 Provider 适配器会累积片段，并尝试解析或修复部分格式。不同 Provider 的处理细节存在差异，解析不出时也不能假设一定得到同一种语法错误。

进入 Agent Loop 后，`pi-agent-core` 会根据工具名查找当前可用工具，再调用 `pi-ai` 的 `validateToolArguments`，按照工具的 TypeBox Schema 校验参数。某些参数会经过库支持的规范化或转换，最终仍需要通过校验。

工具注册时，PI Harness 还会编译工具的参数 Schema，并检查工具名、描述、来源、超时和执行模式。这一步检查的是项目提供的工具声明，模型每次调用时的参数校验发生在 Agent Loop 中。具体注册逻辑在 [tool-registry.ts](../packages/tools/src/lib/tool-registry.ts)。

如果工具不存在或者参数校验失败，工具的 `execute` 不会运行。核心库会生成带 `isError` 的工具结果，再把结果放回对话上下文。模型通常可以看到失败原因，然后决定修正参数、换一种方式，或者向用户说明问题。项目没有保证模型一定会自行修复。

当前安装版本还处理了模型输出被 token 上限截断的情况。即使截断后的参数碰巧能解析，核心库也会拒绝执行该回复中的工具调用，并返回错误，要求模型重新提供完整参数。

## 格式正确，路径仍要检查

`path` 是非空字符串，并不代表它就能被读取。模型可能生成 `../other-project/secret.txt`，也可能请求一个位于工作空间内、实际指向外部的符号链接。

PI Harness 为每个 Session 绑定工作空间根目录。普通文件工具执行时，会相对于这个根目录解析目标路径，检查解析结果是否越界，再检查真实路径和 daemon 的受保护目录。检查逻辑位于 [path-policy.ts](../packages/policy/src/path-policy.ts)。

这样一来，TypeBox 负责判断参数形状，项目的路径策略负责判断这次访问是否允许。两者处理的是不同的问题。即便用户批准一次文件写入，普通文件工具仍会执行工作空间路径检查。

## 修改文件前，先决定是否有权限

读取到文件后，模型可能提出 `edit_file` 调用，给出目标路径、旧文本和新文本。这个调用会改变真实文件，用户需要能够控制它什么时候执行。

`pi-agent-core` 提供 `beforeToolCall` 钩子，让应用在执行前拦截或放行工具。PI Harness 在这个钩子里接入自己的 Policy，结合工具权限、Run 模式、目标和审批设置，决定允许、拒绝或请求审批。工具没有注册策略时，项目会拒绝调用。

在 `request_approval` 模式下，工作空间文件写入通常需要人工批准。`auto_approve` 自动批准工作空间文件写入，Shell 和未分类 MCP 工具则可以交给独立审批模型复核，复核失败、不确定或超时时转人工。`full_access` 自动批准这些操作。工具具体分类和例外由 Policy 处理，Plan 模式下未确认计划前也会限制副作用操作。

需要人工审批时，Runtime 生成包含工具名、目标、摘要和风险的请求，发出事件让界面显示审批卡片，然后等待审批结果。用户批准后，项目还会复查目标。这个流程的入口在 [run-tool-hooks.ts](../packages/agent-runtime/src/run-tool-hooks.ts)。

## 等待审批时，文件可能被别人改了

Agent 读完文件到用户点击批准，中间可能过去一段时间。用户也许打开编辑器改过它，另一个 Session 也可能刚完成一次写入。Agent 如果继续使用先前看到的内容，可能覆盖新的修改。

PI Harness 为文件内容计算 SHA-256 指纹。`read_file` 执行前记录一次指纹，执行成功后再计算一次。两次不同，说明读取期间文件发生了变化，工具结果会报错。两次相同，项目就把这个版本记为当前执行分支已经读过的版本。

当 `edit_file` 或 `write_file` 准备修改已有文件时，执行前检查会再次计算文件指纹。如果当前内容和这个执行分支上次读取到的版本不同，项目会拒绝修改，让 Agent 重新读取。新建文件不存在时，不要求先读取一个不存在的文件。

这项检查由 PI Harness 实现。`pi-agent-core` 提供工具执行和钩子，具体要不要记指纹、什么时候重读，由应用决定。

## 一次回复提出多个工具怎么办

分析项目时，模型可能在一条回复中同时提出读取三个文件。`pi-agent-core` 支持一批工具调用，PI Harness 在创建 Agent 时把 `toolExecution` 设置为 `parallel`。

项目还为每个工具声明执行模式。`read_file`、`search_text` 等工具标记为 `parallel`，适合一起读取。`edit_file`、`write_file`、`run_command` 和 `stop_command` 标记为 `sequential`。

当前安装版本的核心库有一条需要记住的规则。同一批工具调用中，只要有一个工具标记为串行，整批都会按顺序执行。假设模型提出下面三次调用。

```text
read_file("a.ts")
edit_file("b.ts")
search_text("Session")
```

这一批会依次处理。即便第一次读取因为文件不存在而报错，核心库通常仍会记录错误结果并继续处理后面的调用。第二个工具仍须独立经过审批、路径与文件版本检查，因此继续处理不代表它一定会成功。

这一批处理完之后，结果才进入下一轮模型请求。模型看到错误后再提出的调用属于新一轮，而不是插入刚才那一批。Run 的取消信号触发时，串行循环会停止继续处理后面的调用。

全是并行工具时，当前核心库会先逐个准备调用，再并发执行准备通过的工具。准备阶段包含参数校验和调用前钩子，所以等待审批等准备工作也可能影响后续调用何时开始。并行调用结束事件按实际完成情况产生，结果消息按原调用顺序汇总。

## 核心库能并行，为什么还要自己限制数量

模型一次提出很多读取和搜索调用时，全部立刻运行可能占用过多资源。PI Harness 希望在保留并行能力的同时，限制单个执行保护器里的活动工具数量。

项目没有改写 `pi-agent-core` 的调度器。它在注册工具时，先通过 `ToolExecutionGuard.guard()` 包装原始工具，再把包装后的工具交给 Agent。工具的名字、描述和参数定义继续保留，`execute` 则换成项目的包装函数。

```ts
// 包装工具的执行函数，让所有调用先经过项目的保护逻辑。
return {
  ...tool,
  execute: (toolCallId, params, signal, onUpdate) =>
    this.execute(tool.name, timeoutMs, signal, executionKey, async (executionSignal) => {
      // 真正执行前再次检查目标状态。
      await beforeExecute?.(toolCallId, params, executionSignal);
      const result = await tool.execute(toolCallId, params, executionSignal, onUpdate);
      // 工具成功返回后更新相关状态。
      await afterExecute?.(toolCallId, params, executionSignal);
      return result;
    }),
};
```

代码经过简化，实际实现见 [tool-execution-guard.ts](../packages/tools/src/tool-execution-guard.ts)。`pi-agent-core` 仍然调用 `tool.execute()`，调用到的已经是包装函数。这个函数先请求执行名额，最后才调用原始的 `tool.execute()`。

当前代码把 `MAX_PARALLEL_TOOL_CALLS` 设为 4。每个 Guard 实例维护活动调用计数和等待队列。四个名额用完后，后来的调用等待；某个调用结束后，在 `finally` 中释放名额并唤醒下一个等待者。等待时收到取消信号的调用会退出队列。

这个数字的作用范围是 Guard 实例，不能把它理解成整个 daemon 所有 Session 加起来最多运行四个工具。等待同文件队列的调用已经取得并发名额，等待期间也会占用该实例的一个名额。

## 多个 Session 写同一个文件

同一批工具的串行调度，只能约束一个 Agent 当前这一批调用。不同 Session 仍然可以并发工作，它们可能同时尝试写同一个文件。

PI Harness 在 Guard 内维护一个静态 `fileTails` Map。对 `edit_file` 和 `write_file`，项目解析并校验目标路径，用它作为队列 key。不同执行中对同一个 key 的写入会排在同一条 Promise 链上，前一个结束后，下一个才能进入实际执行。不同文件有各自的队列。

```text
Session A 修改 app.ts  ──先执行
Session B 修改 app.ts  ──等待 A
Session C 修改 style.css ──独立处理
```

共享的静态 Map 让同一进程内的不同 Guard 实例能够协调同路径文件写入。取消排队中的调用时，代码仍维护队列的先后关系，避免后面的写入越过尚未结束的前一个操作。

排队结束后，`beforeExecute` 会重新评估目标并比较文件指纹。假如 Session A 已经修改文件，Session B 拿着旧版本排到队首，B 会被要求重新读取。队列和版本检查配合，分别处理同时写入与基于旧内容写入的问题。

## 工具失败后，结果怎样回到模型

工具可能在参数校验、审批或实际执行时失败。例如 `edit_file` 要求 `oldText` 在文件中唯一匹配。如果找不到，或者匹配到多处，工具会抛出错误。这个设计避免在不明确的位置直接替换文本，具体实现见 [edit-file.ts](../packages/tools/src/tools/edit-file.ts)。

`pi-agent-core` 捕获准备或执行过程中的异常，生成带 `isError` 的工具结果，保留工具名和调用 ID。PI Harness 再把工具结束事件适配成自己的 `tool.completed` 或 `tool.failed`，供界面和事件记录使用。

成功调用才会被项目记作成功工具证据。对于成功返回的文件变化，`afterToolCall` 会提取 `before`、`after` 和 Diff，先暂存；等对应的工具结束事件发出后，再产生 `file.changed`。相关事件通过项目的事件链处理，Session JSONL 保存需要恢复和审计的事实。

工具失败不保证没有产生副作用。命令执行到一半时可能已经修改了文件，随后才报错或超时。项目会记录可追踪的变化，但不承诺自动回滚所有部分副作用。也没有一个对所有失败统一生效的自动重试机制。

## 超时和停止怎么传到工具里

用户点击停止后，PI Harness 会调用当前 Agent 的 `abort()`。当前安装版本的 `pi-agent-core` 在活动执行开始时创建 `AbortController`，`abort()` 调用控制器的 `abort()` 方法，Agent Loop 将对应的 `AbortSignal` 传给工具。

`AbortController` 和 `AbortSignal` 是 JavaScript 标准取消接口，项目运行在 Node.js 中。它们提供协作式通知，收到信号的代码需要自行检查，或者把信号传给支持取消的 API。

项目包装器又为每个工具创建超时信号，并用 `AbortSignal.any()` 把 Run 取消和工具超时合并。普通工具通常有 30 秒的包装超时，文档工具和部分网络工具使用 60 秒。计时从进入包装器开始，等待执行名额和等待文件队列的时间也包含在内。

`read_file` 将 signal 传给文件读取流，`web_search` 将 signal 传给 `fetch`。自己的等待队列则监听 `abort`，取消时移除等待者并退出。包装器根据触发来源报告 `TOOL_ABORTED` 或 `TOOL_TIMEOUT`。如果底层操作完全忽略 signal，发出通知本身无法强行停止任意 JavaScript 代码。

Shell 命令需要额外处理，因为它启动了独立进程。`run_command` 将执行交给 `CommandProcessManager`，并在 signal 中止时请求停止进程。停止 Run 时，项目也会让管理器回收该 Run 下仍在运行的受监管命令。

命令有三个容易混淆的时间。`run_command` 默认等待约 10 秒，命令仍运行时返回 `processId`；包装器本身为这次工具调用设置 610 秒超时；进程还有独立的总生存时间，默认 4 小时，最长可配置到 24 小时。返回 `processId` 只表示进程还在运行，后续要通过 `wait_command` 查看状态和退出码。

## 一次修改经过的完整路径

回到开头修改标题的任务，整个流程可以按下面的顺序读。

```text
用户请求修改标题
    ↓
模型请求 read_file
    ↓
核心库查找工具，调用 pi-ai 校验参数
    ↓
项目检查工作空间路径，包装器取得执行名额
    ↓
项目读取文件并记录版本，结果回到模型
    ↓
模型请求 edit_file
    ↓
核心库校验参数，进入 beforeToolCall
    ↓
项目 Policy 判断权限，必要时等待用户审批
    ↓
包装器取得名额，同目标文件写入排队
    ↓
项目复查目标和文件版本
    ↓
原始工具修改文件并生成 Diff
    ↓
项目记录工具结果与文件变化
    ↓
结果回到模型，模型继续工作或答复
```

`pi-agent-core` 管理 Agent Loop，识别工具调用、调度批次、调用工具并产生事件，也提供参数准备、前后钩子和取消信号的接入点。`pi-ai` 负责模型与 Provider 适配，并提供工具参数校验能力。PI Harness 则实现具体工具，把工作空间、安全策略、审批、执行保护和持久化接到这条流程上。

## 代码参考

- [项目工具注册](../packages/tools/src/workspace-tool-registry.ts)
- [工具包装和并发保护](../packages/tools/src/tool-execution-guard.ts)
- [工具执行前后检查](../packages/agent-runtime/src/run-tool-hooks.ts)
- [工作空间路径策略](../packages/policy/src/path-policy.ts)
- [命令工具和进程管理](../packages/tools/src/tools/run-command.ts)
- [事件适配](../packages/agent-runtime/src/event-adapter.ts)
- [架构设计](../docs/架构设计.md)
