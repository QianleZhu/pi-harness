# Dreaming 实施待办清单

> 2026-11-24 更新：敲定记忆并发、用户个性独立表、在线暂存表与双开关解耦方案；下方“记忆并发、用户个性与开关重构”按分步可测原则依次推进，每完成一步即测试并停下供人工代码阅读。
> 2026-11-22 更新：分析与整理已合并为一个带工具的 Dreaming Agent；下方历史阶段保留记录。

每个阶段先讨论技术实现，再进行编码；完成后由用户校验，通过后进入下一阶段。实施或验证完成一项后及时勾选，用户校验项在用户确认后勾选。

## 记忆并发、用户个性与开关重构（2026-11-24）

### 步骤 1：双开关解耦与「启动固定、下一次生效」语义

- [x] 彻底解耦 `useMemories` 与 `generateMemories`：支持 2×2 全部组合（仅用、仅生成、全开、全关）；`record_memory` 与 Dreaming 调度仅检查 `generateMemories`，不再绑定 `useMemories`。
- [x] `RunMemorySnapshot` 固定本次 Run 的 `useMemories`，移除 `buildContext` / `readWiki` / `readRevision` / `readSource` / `search` 在 Run 中途因关闭开关导致的拦截。
- [x] 简化 `dreaming_runs` 登记与结束逻辑：`generateMemories = true` 时发起的 Run 结束一律正常转 `pending`（取消跨开关 `dreaming_generation` 跳过逻辑）；关闭开关后不中止已启动的写入工具与 Dreaming 批次，只阻止启动下一次，重新开启后一并整理残留 `pending` Run。
- [x] 验证 2×2 开关组合、Run 中途关开关不中断、关闭暂停与重开恢复、`pnpm typecheck` 与 `pnpm check`。
- [x] 用户人工代码阅读与校验（步骤 1）。

### 步骤 2：工作区在线暂存表 `provisional_memories`、内存拼装注入与 Workspace 级空闲 Dreaming

- [x] 新增显式 SQLite migration 建立 `provisional_memories`（Append-Only，含 `workspace_id`、`session_id`、`run_id`、`content`、`applicability`、`evidence_status`、`created_at`，处理完成后物理删除）。
- [x] 改造 `MemoryRecorderService`：只向 `provisional_memories` 插入待审记录，不再写入正式 `memories` 表、不再改写磁盘 `context.md` 或 CAS 更新 `dreaming_context`。
- [x] 改造 `RunMemorySnapshot`、`DreamingReaderService` 与 `MemoryService`：按 `(workspaceId, sessionId)` 读取同 Session 已落表的待审暂存记录，在 `buildContext()` 内存中拼装独立区块（独立预算，超出按方案 A 降级关键词检索，不建向量索引），跨 Session 互相隔离。
- [x] 改造 `DreamingScheduler`：改为**整个 Workspace 无活动 Session 且所有 Session 空闲 30 分钟**才启动工作区 Dreaming。
- [x] 改造 `DreamingService`、`SqliteDreamingRepository` 与 `dreaming-tools.ts`：启动时在 `claimPendingRuns` 同事务原子认领该 Workspace 当前全部待审暂存条目（含此前失败批次遗留条目）；发布或无正式变更完成时仅物理删除本批认领记录，移除 `context.md` 3 轮冲突比对与临时区剥离逻辑。
- [x] 验证多 Session 并发写入、同 Session 落表立即可见与跨 Session 隔离、内存拼装不改 `context.md`、超预算降级检索、Workspace 级空闲调度、Dreaming 期间新写入隔离与遗留条目顺带审核、`pnpm typecheck` 与 `pnpm check`。
- [x] 用户人工代码阅读与校验（步骤 2）。

### 步骤 3：用户个性独立表拆分与 API 边界收窄

- [x] 新增显式 SQLite migration 建立独立 `user_profiles` 表，迁移原 `memories` 中 `scope = 'user' AND profile_facet IS NOT NULL` 的记录，并重建仅含跨项目全局记忆的 `global_memory_versions`。
- [x] 更新 `packages/memory` 契约与服务：拆分独立的用户个性读写契约（仅用户手动维护），全局记忆去掉 `profileFacet` 仅保留跨项目经验，daemon 记忆 API 收窄为仅管理「用户个性」和「全局记忆」（禁止通过 Web API 查看/修改 `workspace` 记忆）。
- [x] `RunMemorySnapshot` 同步快照独立用户个性并在上下文中全量注入；同步清理 `GlobalDreamingService` 中的 `profileFacet`。
- [x] 验证 migration 数据迁移兼容性、用户个性 CRUD、全局记忆与工作区记忆 API 边界隔离、快照注入、`pnpm typecheck` 与 `pnpm check`。
- [x] 用户人工代码阅读与校验（步骤 3）。

### 步骤 4：全局跨项目记忆乐观锁增量合并与跨进程兜底

- [x] 改造 `GlobalDreamingService` 与 `global-dreaming-tools.ts`：读取阶段记录 `baseVersion`，准备提交前比较版本号；不一致时基于 `global_memory_versions` 计算精确结构化 diff（新增、修改、删除），切换工具视图至最新版本并支持覆盖/撤销已有草案，由全局 Agent 以**用户修改权威更高**原则执行增量合并后再走乐观锁提交（设有限合并轮次）。
- [x] 补齐 `publishGlobal` 向量写入（`memory_embeddings` 与 `memory_revision_embeddings`），并在主进程 `MemoryService` 写入事务内兜底跨进程 `UNIQUE` 冲突稳定映射为 `MEMORY_DUPLICATE`。
- [x] 验证后台整理期间用户新增/修改/删除全局记忆触发精确 diff 增量合并（用户为准、防复活、可撤销草案）、合并上限退回、跨进程重复写入兜底、`pnpm typecheck` 与 `pnpm check`。
- [x] 用户人工代码阅读与校验（步骤 4）。

### 步骤 5：Web 设置页双分类改造、反向冲突手动刷新与全局语义统一

- [x] 将全局记忆作用域由 `scope = 'user'` 迁移为 `scope = 'global'`（新增显式迁移 `034-global-memory-scope.sql`，同步将全局记忆逻辑删除状态由 `'suggested'` 改为 `'deleted'`、移除 `memories.profile_facet` 遗留列并重建 `global_memory_versions`），全仓同步清理语义不清之处。
- [x] 改造 Web 记忆设置页：明确拆分为「用户个性」（手动 CRUD）与「全局记忆」（跨项目经验查看与 CRUD）两类，移除工作区记忆展示、编辑入口与废弃的 `memory-scope-select.tsx`。
- [x] 实现反向并发冲突交互：编辑或删除全局记忆撞上 `MEMORY_CONFLICT` 时，保留用户当前表单输入不自动覆盖，展示清晰冲突提示并提供手动「刷新最新内容」按钮供用户自行拉取最新内容。
- [x] 验证迁移兼容性、Web 构建、类型检查、Biome 检查与冲突交互逻辑。
- [x] 用户人工代码阅读与校验（步骤 5）。

## 统一整理 Agent（历史实现）

- [x] 移除独立分析模型调用和候选解析；分析、整理由同一个 Dreaming Agent 完成。
- [x] 一个 workspace 只运行一个 Dreaming Agent，收集全部符合条件的 Run，按 Session 和启动时间依次读取。
- [x] 初始上下文只提供 Run 元数据；事件、记忆和 Wiki 通过工具按需分页读取。
- [x] 复用 `projectContext` 上下文压缩，避免长工具输出超出模型窗口。
- [x] 强制读取每个 Run；记忆草案只能引用已经读取的事件。
- [x] `record_memory` 写入第三层记忆并追加第一层临时区块；Dreaming 发布时移除临时区块。
- [x] 支持确认、修正、冲突、过时和临时记忆处理；没有变更理由时允许不更新。
- [x] 全局记忆由单一全局 Agent 串行处理；没有值得复用的经验时允许不提交。
- [x] 记忆结构尚未建立时，Dreaming 以默认脚手架启动，并根据本批原始日志搭建初始 Wiki 与记忆。
- [x] 注入上下文从 Wiki 中拆出，使用独立的上下文版本、不可变副本和发布指针；`record_memory` 只发布新上下文副本并递增版本，Dreaming 发布前重新比较版本并让 Agent 对比最新内容。
- [x] 移除 `save_memory`、`update_memory`、`delete_memory` Agent 工具，只保留 `search_memories` 与主动学习的 `record_memory`；手动记忆管理继续通过 daemon API 完成。
- [x] 验证多 Run 多 Session 单 Agent、工具分页、上下文压缩和全局记忆发布。

## 第一阶段：契约与数据基础

- [x] 在 `packages/memory` 定义需要的记忆版本、来源等领域类型，保持领域层不依赖 SQLite、JSONL 或 HTTP。
- [x] 使用显式 migration 建立四张表：
  - `memory_revisions`：按记忆 ID 和版本号保存 Dreaming 版本、正文、适用条件、证据状态和创建时间。
  - `memory_revision_sources`：关联记忆版本与来源 Session、Run、事件 ID 和序号；删除 Session 时移除对应来源，保留记忆及其他来源。
  - `dreaming_wiki`：按工作区保存当前发布的 Wiki 目录指针。
  - `dreaming_runs`：保存 Run 的归属、开始时的开启代次、状态、候选和时间；候选与状态保存在同一条记录中。
- [x] 在现有设置存储中持久化 Dreaming 开启代次，保证与开关变化一致；Run 开始和结束时的代次与开关状态用于判断资格。
- [x] 实现阶段所需的 daemon repository 读写，保留现有记忆操作和检索行为；手动修改暂不写入历史版本。
- [x] 在隔离数据库中验证迁移、版本和多来源、Session 删除后的来源处理、Wiki 指针及 Run 状态读写，并校验现有记忆操作和检索。
- [x] 用户校验第一阶段。

当前没有 Session，Dreaming 生效前的 Run 不回溯、不补处理。不建立开启区间、候选或整理批次专用表。

### 四层记忆存储

| 层级             | 内容                          | 存储位置                                                  |
| ---------------- | ----------------------------- | --------------------------------------------------------- |
| 注入上下文       | 核心摘要和导航入口            | 当前发布目录的 `context.md`                               |
| 主题 Wiki 与导航 | 主题结论、适用条件和导航      | 当前发布目录的 `index.md` 和主题 Markdown 文件            |
| 长期记忆摘要     | 当前摘要、Dreaming 版本及来源 | `memories`、`memory_revisions`、`memory_revision_sources` |
| 会话事件         | 原始对话、Run 和工具事件      | `sessions/<sessionId>.jsonl`                              |

Wiki 位于 daemon 数据目录的 `dreaming/<workspaceId>/<directoryId>/`，`dreaming_wiki` 指向当前发布目录。Wiki 引用记忆 ID 和版本，来源关联定位 Session JSONL 中的事件。

## 第二阶段：单 Run 整理链路

- [x] 通过内部入口指定工作区、Session 和 Run，固定事件范围并读取 JSONL 文本事件及 Run 终止状态。
- [x] 每个 Run 调用模型一次，提取摘要、适用条件、证据描述和来源事件 ID；候选为空时直接结束。
- [x] 用 TypeBox 和业务规则校验候选。模型仅输出 `eventId`；程序从本次输入事件中查找并补充 `eventSeq`，拒绝不属于输入范围的来源。
- [x] 装配整理 Agent 专用工具，读取当前工作区记忆、来源和 Wiki，并按文件编辑本批草案；Session 事件读取仅限本批候选或已有记忆来源引用的事件。
- [x] 修改摘要时新建版本，保留原版本及来源；新增来源时也新建版本，旧版本及来源保持不变。手动修改流程暂不扩展。
- [x] 校验草案实际使用的版本与引用；更新当前记忆时在事务内检查其版本未变化，历史引用只检查存在及工作区归属。
- [x] 校验完整 Wiki 草案：主题合计不超过 40,000 字符、导航不超过 4,000 字符、注入上下文不超过 2,000 字符。
- [x] 事务外完成模型调用、草案、必要索引准备和新 Wiki 目录写入；在同一 SQLite 事务中更新记忆、版本、来源、索引、Wiki 指针及 Run 状态。
- [x] 验证无候选、分析失败、整理失败、版本冲突和提交失败等路径，确保未发布草案不生效。
- [x] 用户校验第二阶段。

## 第三阶段：独立 Dreaming Worker、调度与生命周期

主 daemon 保留现有会话、Session JSONL 追加、记忆 API 和主 Agent 职责。独立 Worker 仅读取会话并执行 Dreaming 的提取、整理和发布，daemon 通过进程间通信管理 Worker 生命周期并协调必要状态。

- [x] 建立独立 Worker 进程及可取消的进程间通信，接入 daemon 启动、异常退出、关闭和恢复。
- [x] Worker 读取已持久化的 Session JSONL，主 daemon 继续负责会话事件的顺序追加、索引更新和 SSE。
- [x] 保留主 daemon 的记忆设置、显式记忆操作、混合检索和主 Agent 上下文装配。
- [x] 将 Dreaming 调度、模型调用、整理 Agent、向量计算、Wiki 及发布事务迁入 Worker。
- [x] daemon 统一管理模型凭据，Worker 通过进程间通信使用凭据，避免多进程独立写入凭据文件。
- [x] 验证 Worker 与 daemon 并行、Session 写入顺序、现有记忆 API、凭据协调、异常退出与重启恢复。

- [x] 从 Run 生命周期登记开启代次，结束时检查开关与代次；只处理同一开启代次内开始并结束的顶层 Run，成功、失败及中止均可分析。
- [x] 对有待处理 Run 的 Session 读取 JSONL，以最后一条完整持久化事件时间判断 30 分钟空闲；启动前确认没有活动 Run。不使用 `sessions.updated_at` 代替事件时间。
- [x] （历史）实现同一 Session 按 Run 顺序、不同 Session 最多两个并发分析、每工作区最多一个整理 Agent、每次整理最多两个 Run；现由“统一整理 Agent”取代。
- [x] 通过定时扫描收集符合空闲条件的 Run 并按开始顺序放入等待队列；执行前复查 Session 活动和记忆开关，不符合条件的 Run 保持待处理并等待下次扫描。
- [x] 移除 Run 结束、记忆开关变化和后台任务结束时的立即扫描；定时检查在上一次检查结束并等待间隔后启动，名额释放时只继续消费已有队列。
- [x] Dreaming 执行期间拒绝会触发 Provider 配置刷新的操作并向用户提示；异步配置变化在后续检查确认任务结束后刷新。
- [x] 关闭学习后不启动新分析，已开始工作及后续整理继续；daemon 关闭时中止后台调用。
- [x] 重启后继续等待未开始的工作，将中断的分析与整理标记失败，清理未发布的目录和对应候选。
- [x] 验证调度、关闭与重新开启、重启及失败状态。
- [x] 用户校验第三阶段。

## 第四阶段：模型设置与主 Agent 接入

- [x] 在现有模型设置中提供 Dreaming 专用 Provider 和模型，分析与整理共用，默认未配置；复用 daemon 模型解析与凭据能力。
- [x] 模型未配置、Provider 不可用或凭据缺失时不启动分析，符合条件的 Run 保持待处理；调用开始后失败或超时则标记失败，不重试。
- [x] 主 Run 加载当前工作区的 `context.md`，保留按需记忆检索；关闭 `useMemories` 时不注入或读取长期记忆。
- [x] 提供按需读取 Wiki、记忆版本与会话来源的只读工具，将派生内容视为不可信上下文。
- [x] 移除自动 `learn_memory` 工具及提示词；保留用户明确要求的保存、修改和删除操作及现有审批规则（后续已改为只保留 `record_memory` 与 `search_memories`，见“统一整理 Agent”）。
- [x] 验证模型设置、上下文注入、只读访问和现有显式记忆操作。
- [x] 用户校验第四阶段。

## Run 记忆版本快照

- [x] 每次 Dreaming 发布保留 Wiki 和注入上下文版本，恢复时只清理未发布的草案。
- [x] 内容、适用条件、证据状态或来源变化时创建新的记忆版本，重复来源不递增版本。
- [x] 每个主 Run 固定 Wiki 与可见记忆版本，按固定版本进行上下文注入、Wiki 读取和按需混合检索。
- [x] 验证 Dreaming 发布前后 Run 的导航、记忆、来源及检索一致性。
- [ ] 用户校验 Run 记忆版本快照。

## 整理与模型设置修正

- [x] 整理 Agent 未修改记忆或 Wiki 时正常完成本批 Run，不生成 Wiki 版本。
- [x] Dreaming 执行期间拒绝修改或清除专用模型，并提示用户。
- [x] 验证无变更整理和模型设置拦截。

## 主 Run 上下文调整

- [x] 移除 Run 启动时基于用户提问的自动记忆检索，保留 Wiki 上下文注入与按需检索工具。

## 第五阶段：暂不实施

端到端效果评估以及最终架构、运行配置文档同步暂不实施，待后续另行讨论。
