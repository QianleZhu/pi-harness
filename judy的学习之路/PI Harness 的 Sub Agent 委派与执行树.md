# PI Harness 的 Sub Agent 委派与执行树

让 PI Harness 改一个页面时，查组件入口和查后端响应可以同时做。主 Agent 可以把两项调查分别委派出去，自己先梳理用户要改的行为，等方案依赖调查结论时再取结果。这种分工发生在同一次 Run 里。用户留在原来的对话中，由主 Agent 汇总发现并继续完成任务。

PI Harness 复用 pi-agent-core 的 Agent 来运行这些子任务，在本地 daemon 里用一棵 `SubAgentTree` 管理它们。理解这棵树，可以从主 Agent 拿到第一个 `executionId` 开始。

## 委派之后，主 Agent 可以继续做什么

主 Agent 调用 `spawn_agent` 时，要给出任务名 `name`、任务说明 `task` 和角色 `agentType`。子任务启动后，工具返回 `executionId`，主 Agent 可以继续处理不依赖该结果的工作。

子 Agent 有自己的消息历史和上下文，父对话以及父 Agent 已经读过的工具输出都需要通过委派说明传递必要部分。以前面的页面调查为例，只写“查一下前端”很难约束范围。写明“从会话列表页面追踪到 daemon 接口，返回关键文件、调用顺序和缓存行为”，子 Agent 就有了明确的调查目标和交付内容。子任务产生的阅读记录留在自己的上下文里，父 Agent 拿到的是最终结果。模型默认沿用根 Run 的配置，委派时也可以通过 `modelId` 选同一 Provider 下的其他模型。

角色决定子任务能用哪些工具。查代码和文档可以交给 `explorer`，它的工作工具是只读的。需要改文件或运行命令时，可以委派 `worker`，它使用父级可提供的工作工具，继续遵守工作区的权限和审批规则。计划模式尚未确认时，只允许委派 `explorer`。父子共用同一工作区，内置文件工具会串行处理同路径写入，并在落笔前检查文件是否已变化。

子任务运行起来后，主 Agent 还有两种干预方式。用 `send_agent_message` 补充要求时，`follow_up` 把消息排到后续轮，`steer` 打断当前轮，让子 Agent 调整方向。如果整项调查已经没有必要，`stop_agent` 会取消该子任务及其后代，等收尾后返回终态。这些工具和 `wait_agents` 都按执行 ID 操作调用方的直接子任务。

## 用 wait_agents 分批拿结果

如果页面方案需要前后端两项结论，主 Agent 可以把两个 ID 放进 `executionIds`，并用 `returnOn: "all"` 等它们都结束。如果有一项结果就能先推进，用 `returnOn: "any"` 即可。两种方式都返回 `results` 和 `running`，前者是返回时已结束的指定任务，后者是仍在执行的指定任务 ID。

假设前端调查 A 先结束，后端调查 B 还在跑。对 A 和 B 调用 `any`，会拿到 A 的结果，`running` 里只剩 B。这时如果原样再传 A 和 B，因为 A 已经满足返回条件，工具会立即返回，A 的结果仍在。如果想等下一批，就把上一次的 `running` 交给下一次调用。若两项在工具返回前都已结束，`any` 也会一次返回两项。

这里的“结束”包括成功、失败和中止。读结果时要看每一项的 `status`。成功项的 `resultSummary` 来自子 Agent 最终回复的文本，最多 4,000 字符。失败或中止项会给出错误码。子任务失败后，其他分支可以继续运行，由父 Agent 根据手头结果决定后续动作。

一次 `wait_agents` 调用最多等 31 分钟。等待超时只结束这次工具调用，子任务仍按自己的计时和状态运行。需要终止子任务时，父 Agent 可以调用 `stop_agent`。

## 子任务结束后，结果为什么还能取到

启用了子 Agent 的 Run 在启动时会创建一棵空树。真正收到委派时，树先检查角色、深度和并发名额，再准备一个独立的 Agent，把它按 `executionId` 登记到 `executions`。主 Agent 的直属任务挂在 `rootChildren`，子 Agent 再委派的任务挂在对应执行记录的 `children`。这样，按 ID 可以直接取到记录，按父子关系也能递归停止一个分支。

创建本身也可能并发，所以树会先预留名额，并跟踪正在准备的委派。同一父级发出的相同委派，如果已有任务正在创建或运行，可以复用已有执行。当前每个 Agent 最多有 3 个活动的直接子任务，整棵树最多往下两层，daemon 跨会话最多同时运行 8 个子 Agent。每个子执行还有 30 分钟的运行时限。

每条执行记录都保有一个 `completion`，它表示子执行何时收尾。任务结束时，运行时先提交终态事件，再把状态和终态数据写回内存记录，随后释放计时器、订阅和并发名额。记录本身保留到根 Run 清理，所以 `wait_agents` 可以在运行时等待 `completion`，也可以在结束后直接读到结果。它返回结果时会设置 `delivered`，这一步只记录父 Agent 已经领过，后续显式等待仍能读到同一份结果。

## 主 Agent 没有调用 wait_agents 时

到了根 Run 的收尾阶段，`RunCoordinator` 会调用树的 `join()`，等直属子任务结束，再把尚未交付的结果作为内部消息交给主 Agent。主 Agent 会继续跑一轮处理这些结果。如果这一轮又创建了新子任务，树会继续收束。子 Agent 结束前也用同样的方式收束自己的直属任务，所以根任务只需等自己的直接子任务，就能涵盖后代的正常收尾。

用户停止根 Run 时，取消会沿整棵树传下去，运行时等待子执行退出。Run 清理后，`RunCoordinator` 清空对树的引用，下一次 Run 会创建自己的树。

会话详情和 Trace 还能看到已经结束的子任务，因为关键事件和完整回复写在同一份 Session JSONL 里，实时活动则走 SSE。主对话展示任务状态，点开详情可以看独立过程。父 Agent 在 `wait_agents` 中拿到的短摘要，与用户在详情中看到的完整回复，来自同一次执行的不同记录。daemon 重启时，中断的执行会被标记为中止，已保存的历史仍可查看。

## 源码阅读顺序

1. 从 [委派工具定义](../packages/tools/src/tools/sub-agent.ts#L86) 和 [AgentManager 的工具接线](../packages/agent-runtime/src/agent-manager.ts#L275) 看模型的工具调用如何交给运行时。
2. 顺着 [RunCoordinator 创建执行树](../packages/agent-runtime/src/run-coordinator.ts#L896) 读到 [SubAgentTree 的创建与登记](../packages/agent-runtime/src/sub-agent-tree.ts#L251)。
3. 对照 [子执行终态](../packages/agent-runtime/src/sub-agent-tree.ts#L724)、[显式等待](../packages/agent-runtime/src/sub-agent-tree.ts#L798) 和 [自动收尾](../packages/agent-runtime/src/sub-agent-tree.ts#L877)，看结果何时可读、何时会自动交付。
4. 从 [会话事件提交](../apps/daemon/src/services/session-event-service.ts#L181) 跟到 [对话里的子任务投影](../apps/web/src/features/chat/utils/session-messages.ts#L731)，看同一条子执行如何出现在用户界面里。

设计文档见 [Sub Agent 核心设计](../docs/Sub-Agent核心设计.md) 和 [对话中的 Sub Agent](../docs/对话Sub-Agent设计.md)。
