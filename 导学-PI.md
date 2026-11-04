# PI Harness 项目导学

> 基于当前仓库与 `docs/架构设计.md`、`docs/runtime-setup.md` 整理。个人职责、线上使用情况和量化结果待本人确认；阅读时间为建议值。

## 1. 前置知识（面试高频标注）

| 知识点 | 为何需要 | 在本项目中的位置 | 高频度 |
| --- | --- | --- | --- |
| TypeScript strict、异步与取消 | 理解领域类型、超时与并发 | `packages/agent-runtime/src/run-coordinator.ts` | 高 |
| HTTP、SSE、重连和事件排序 | 理解增量输出与恢复 | `apps/daemon/src/sse/session-event-broker.ts`、`apps/web/src/features/chat/hooks/use-session-events.ts` | 高 |
| Agent Loop、工具调用与模型上下文 | 理解模型、工具与运行编排 | `packages/agent-runtime/src/run-coordinator.ts`、`packages/agent-runtime/src/context/context-pipeline.ts` | 高 |
| SQLite、追加日志与崩溃恢复 | 区分事实记录和索引 | `apps/daemon/src/storage/session-event-store.ts`、`apps/daemon/src/storage/database.ts` | 高 |
| 路径安全、进程隔离与审批 | 本地工具会产生真实副作用 | `packages/policy/src/path-policy.ts`、`packages/sandbox/README.md` | 高 |
| React、TanStack Query | 理解服务端快照与流式投影 | `apps/web/src/features/chat/hooks/use-session-events.ts` | 中 |
| 检索、向量与长期记忆 | 理解派生索引与上下文召回 | `packages/memory/src/memory-service.ts` | 中 |

## 2. 重点亮点与学习顺序（先看这个）

| 亮点标题 | 为什么重要 | 通用技术关键词 | 先看哪些文件 | 建议学习顺序 |
| --- | --- | --- | --- | --- |
| 分层编排与运行状态 | 串起用户请求、模型与工具 | 生命周期、取消、状态隔离 | `docs/架构设计.md`、`packages/agent-runtime/src/run-coordinator.ts` | 1 |
| 实时事件与恢复 | 解释断线和进程重启后如何还原 | SSE、序号、追加日志、投影 | `packages/agent-runtime/src/event-adapter.ts`、`apps/daemon/src/storage/session-event-store.ts` | 2 |
| 副作用安全治理 | 直接关系到用户文件和命令安全 | 审批、真实路径、沙箱、超时 | `packages/agent-runtime/src/run-tool-hooks.ts`、`packages/policy/src/path-policy.ts` | 3 |
| 并发任务与资源边界 | 解释子任务和冲突控制 | 执行树、预算、互斥、取消 | `packages/agent-runtime/src/sub-agent-tree.ts`、`packages/tools/src/tool-execution-guard.ts` | 4 |
| 上下文与长期记忆 | 解释长对话如何在有限窗口内运行 | 压缩、检查点、混合召回 | `packages/agent-runtime/src/context/context-pipeline.ts`、`packages/memory/src/memory-service.ts` | 5 |

## 3. 必备知识点

- [ ] 能画出浏览器、本地 daemon、运行时、工具、策略与存储之间的调用方向。
- [ ] 区分一次会话、一次运行、工具调用和子执行的身份与生命周期。
- [ ] 能解释临时事件和持久事件、严格递增序号与序号连续性的区别。
- [ ] 能说明审批、路径校验、沙箱和执行前复查各自保护什么。
- [ ] 能区分原始历史、上下文投影、长期记忆和可重建索引。
- [ ] 能说清 Windows 沙箱、macOS Computer Use 和真实模型评估的现有限制。

## 4. 推荐阅读（结合仓库）

| 主题 | 通用技术点 | 建议阅读位置 | 预计时间 | 读完能回答什么 |
| --- | --- | --- | --- | --- |
| 全局边界 | 模块化单体、本地优先 | `README.md`、`docs/架构设计.md`、`docs/runtime-setup.md` | 60 分钟 | 为什么 UI 不直接执行本地操作？ |
| 一次运行 | 状态转换、调用与取消 | `packages/agent-runtime/src/agent-manager.ts`、`packages/agent-runtime/src/run-coordinator.ts` | 90 分钟 | 多会话并发与单会话约束是什么？ |
| 流式链路 | 事件适配、客户端批量投影 | `packages/agent-runtime/src/event-adapter.ts`、`apps/daemon/src/sse/session-event-broker.ts`、`apps/web/src/features/chat/hooks/use-session-events.ts` | 90 分钟 | 断线和重复事件怎么处理？ |
| 持久化 | 追加顺序、恢复、索引 | `apps/daemon/src/storage/session-event-store.ts`、`apps/daemon/src/services/session-event-service.ts` | 90 分钟 | 末行损坏与中间行损坏如何区分？ |
| 安全与进程 | 策略、资源限制、进程回收 | `packages/agent-runtime/src/run-tool-hooks.ts`、`packages/policy/src/path-policy.ts`、`packages/tools/src/command-process-manager.ts`、`packages/sandbox/README.md` | 120 分钟 | 为什么授权通过仍要限制影响范围？ |
| 子执行 | 并发、执行树与父子关系 | `packages/agent-runtime/src/sub-agent-tree.ts`、`packages/tools/src/tool-execution-guard.ts` | 90 分钟 | 子任务如何终止和避免写入冲突？ |
| 上下文与记忆 | 预算、摘要、召回与降级 | `packages/agent-runtime/src/context/context-pipeline.ts`、`packages/memory/src/memory-service.ts`、`packages/evals/src/context-runtime-eval.ts` | 120 分钟 | 如何减少上下文同时保留事实？ |

## 5. 自学提醒

若某文件或原理看不懂，请继续追问 AI；本技能负责给学习路径与题目，不提供逐行讲解。

## 6. 项目技术定位

**AI 工程与全栈交叉**：浏览器负责交互，本地服务负责 Agent 编排、工具安全与持久化，覆盖模型集成、后端可靠性和前端流式状态。

## 7. 核心原理解析

1. **运行编排**：问题 → 一次模型对话可能跨越工具和多轮执行；机制 → 每个会话的主运行协调器管理生命周期并接入模型循环；落点 → `packages/agent-runtime/src/agent-manager.ts` 与 `packages/agent-runtime/src/run-coordinator.ts`。
2. **实时与恢复**：问题 → 高频增量和完整历史对存储需求不同；机制 → 项目事件经 SSE 实时推送，影响恢复的事件按序追加，客户端使用快照和序号恢复；落点 → `packages/agent-runtime/src/event-adapter.ts`、`apps/daemon/src/storage/session-event-store.ts`。
3. **副作用保护**：问题 → 模型可能请求写文件或执行命令；机制 → 策略和审批决定是否允许，路径约束及隔离限制操作范围，执行前复查目标；落点 → `packages/agent-runtime/src/run-tool-hooks.ts`、`packages/policy/src/path-policy.ts`。
4. **子执行协作**：问题 → 并行工作可能越权、超预算或冲突；机制 → 子执行挂在根运行下，继承工具边界，设置预算并对同目标写入互斥；落点 → `packages/agent-runtime/src/sub-agent-tree.ts`、`packages/tools/src/tool-execution-guard.ts`。
5. **上下文预算**：问题 → 长对话超过模型窗口；机制 → 对工具结果裁剪并生成检查点投影，原始会话记录仍保留；落点 → `packages/agent-runtime/src/context/context-pipeline.ts`。

## 8. 关键设计决策

| 备选 | 取舍 | 风险 | 验证 |
| --- | --- | --- | --- |
| 浏览器直接操作本机 vs 本地 daemon | daemon 集中执行与凭据管理，浏览器通过 HTTP/SSE 通信 | 本地接口仍需防跨站访问 | 检查 Host、Origin、自定义请求头及跨来源拒绝行为 |
| 完整历史存 SQLite vs JSONL 事实源加 SQLite 索引 | 会话事件顺序追加，结构化数据放 SQLite | 两者无法组成单一原子事务，索引可能落后 | 注入索引失败、重启和损坏末行，核验事实记录与重建 |
| 保存每个增量 vs 只保存关键事件 | 实时增量不写日志，完成消息保存完整内容 | 断线瞬间的未完成增量不能从持久化日志完整恢复 | 模拟断网和运行完成，比较快照与最终消息 |
| 只审批 vs 审批加隔离 | 策略和隔离承担不同边界 | 平台支持差异及完全访问模式风险 | 按平台和权限模式核对实际行为，参考 `packages/sandbox/README.md` |
| 保留全部上下文 vs 投影压缩 | 在预算内提供工作上下文，保留原日志 | 摘要可能遗漏纠正、失败和约束 | 用已有评估场景比较压缩前后的关键信息 |

## 9. 量化与验证（含待测，建议）

- **待测：流式交互**。建议记录事件速率、前端刷新次数和输入响应耗时，比较批量刷新前后；不要把源码中的刷新间隔当作用户延迟实测值。
- **待测：恢复正确性**。建议覆盖重连、重启、不完整末行、中间行损坏、索引更新失败，核对消息顺序和终态；保留复现步骤与结果。
- **待测：安全边界**。建议在隔离测试工作区检查符号链接越界、目标变化、拒绝审批、超时和取消；分别记录权限模式与操作系统。
- **待测：上下文质量**。建议运行仓库既有确定性评估，再用经授权的真实模型评估关键事实保留率；真实模型调用可能产生费用。
- **待补：个人证据**。请补充本人负责的文件或 PR、操作录屏、日志、用户反馈和任何实际指标；没有证据时只描述仓库机制。
