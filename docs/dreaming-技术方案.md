# Dreaming 技术方案

## 目标

Dreaming 在 daemon 管理的独立 Worker 进程中，由一个带工具的 Agent 统一审计工作区已结束的 Run。Agent 按需读取原始日志、当前注入上下文、Wiki 和记忆摘要，修正矛盾、冲突和过时内容，并维护工作区的四层正式记忆结构。

主 Agent 在工作过程中可通过 `record_memory` 记录当前工作区的临时记忆到独立的在线暂存表 `provisional_memories`。Dreaming 后续用原始日志佐证这些暂存记录，决定提拔为正式记忆或拒绝。工作区整理 Agent 可提出跨项目候选，由单独的全局 Agent 串行处理；两者均可不产生变更。

用户个性与跨项目全局记忆拆分为两类独立业务：用户个性使用独立表，仅由用户在 Web UI 手动输入、更新与删除；全局记忆只记录跨项目内容，由 Web UI 与全局整理 Agent 共同维护；工作区正式记忆（L1/L2/L3）仅由 Dreaming Worker 独占写入，Web UI 不查看或修改工作区记忆。

## 记忆分层

```text
注入上下文：Dreaming 发布的正式 context.md + Run 启动时内存拼装的同 Session 待审暂存区块
        ↓ 按需读取
主题 Wiki：跨记忆的归纳、适用条件和主题关联
        ↓ 引用
长期记忆摘要：当前版本、历史版本及来源
        ↓ 引用
Session JSONL：原始对话、工具调用和结果
```

注入上下文和 Wiki 分开存储与版本化：上下文是独立版本副本，Wiki 是 `index.md` 与主题文件的目录版本；在线暂存笔记独立存放在 SQLite 的 `provisional_memories` 表中。

| 层次 | 内容 | 存储与职责 |
| --- | --- | --- |
| 会话事件 | 已持久化的对话及执行记录 | Session JSONL 是原始事实来源 |
| 记忆摘要 | 可跨 Session 复用的项目事实、决策、经验和教训 | SQLite `memories`、`memory_revisions`、`memory_revision_sources`（工作区正式记忆仅由 Dreaming 写入） |
| Wiki 与导航 | 对摘要的主题组织和综合结论 | daemon 数据目录按 workspace 保存 Markdown 文件，可由摘要重新整理 |
| 注入上下文 | 从 Wiki 提取的核心摘要和导航 | 独立的 `dreaming_context` 指针与 `dreaming_context_versions` 版本，内容保存为纯正式 Markdown 副本，仅由 Dreaming 写入 |
| 在线暂存笔记 | Run 过程中主动记录、尚未审计的临时工作区记忆 | SQLite `provisional_memories`（Append-Only，绑定 `workspace_id`、`session_id`、`run_id`，审核完成后物理删除） |

`record_memory` 只向 `provisional_memories` 追加一条待审记录，不写入正式 `memories` 表，也不修改磁盘上的 `context.md` 或 Wiki。同一 Session 的后续 Run 在启动拍快照时，只要暂存记录已落表就立即可见，并在内存中拼装进发给主 Agent 的上下文（独立小预算，超出预算按关键词降级检索，不建向量索引）；不同 Session 之间的未审计暂存记录在 Dreaming 前互相隔离。

Dreaming 启动时原子认领本工作区当前所有待审暂存记录（包含本批 Run 以及此前失败批次遗留的待审条目）；审计后在发布或完成事务中仅物理删除本批认领的暂存记录。Dreaming 运行期间新会话写入的暂存记录不在认领集合内，互不冲突并留待下一轮 Dreaming 审核。

## 系统职责

- `packages/memory` 定义记忆版本、来源、Wiki 和整理所需的领域类型与操作；不直接读取 JSONL、SQL 或 HTTP。
- 主 daemon 继续负责会话事件、Session JSONL 追加、HTTP/SSE、主 Agent、记忆 API 和用户显式记忆操作，并管理 Dreaming Worker 生命周期。
- 独立 Dreaming Worker 负责读取已持久化事件、运行统一整理 Agent、维护记忆与 Wiki、发布版本，以及 Dreaming 调度。Worker 使用独立 SQLite 连接。
- 模型凭据由主 daemon 统一管理，Worker 不独立写入凭据文件。
- `agent-runtime` 将 Wiki 核心摘要和导航装配到主 Agent 上下文，并提供按需读取入口；Dreaming Agent 复用其上下文压缩机制 `projectContext`。
- Web 复用现有设置体系，提供 Dreaming Provider 和模型配置，不新增 Wiki 浏览、审核或运行控制页面。
- Provider 和模型通过现有 pi-ai 模型与认证能力解析；Embedding 继续使用本地模型和现有混合检索。

Dreaming 不创建顶层会话，不将 Pi 原始事件暴露给 Web。后台提示词及协议标记放在所属模块的 `prompts` 目录。

主 Agent 生成的会话事件继续由主 daemon 串行追加 JSONL。Worker 仅读取已持久化事件，不成为会话写入的必要条件。daemon 关闭时中止后台调用，恢复仍以 JSONL 和 SQLite 为准。

## 开关与模型配置

`useMemories`（使用记忆）和 `generateMemories`（生成记忆）两个开关完全独立，按 2×2 组合生效：

- **仅开 `useMemories`**：正常注入与检索当前已有记忆结构（用户个性、全局记忆、工作区四层与同 Session 暂存）；禁用对话中的记忆写入工具（包括 Agent 主动调用和用户对话要求调用）与新的 Dreaming 调度。
- **仅开 `generateMemories`**：不注入任何记忆上下文，不使用记忆读取/检索工具；正常允许记忆写入工具与后台 Dreaming（Dreaming 整理自身可读取已有记忆和 Wiki 以完成比对与更新）。
- **两个都开**：读取、写入与整理全部执行。
- **两个都关**：读取、写入与整理全部不执行。

所有开关变更遵循**“不影响正在进行的操作，只对下一次生效”**：

- Run 启动拍 `RunMemorySnapshot` 时固定本次 Run 的 `useMemories`，运行中途关闭开关不中断本次 Run 已开始的上下文组装与记忆读取，新状态在下一次 Run 生效。
- 已进入执行的记忆写入工具调用完整写完；下一次调用按新 `generateMemories` 状态判定。
- 已启动的工作区 Dreaming 批次与全局 Dreaming 批次继续执行完毕并正常发布；关闭开关后不再启动新的整理批次。
- `generateMemories = true` 时发起的 Run 正常登记进 `dreaming_runs`，结束时一律转为 `pending`（即使中途关闭了开关，也不再因跨开关边界将其跳过）；关闭期间已有 `pending` Run 保持待处理，等重新开启 `generateMemories` 后随空闲条件一并整理。

Dreaming 使用独立的 Provider 和模型，分析与整理共用。模型未配置、Provider 不可用或凭据缺失时，不启动整理，符合条件的 Run 保持待处理；模型调用开始后失败或超时，该批 Run 记为失败，不重试。

Dreaming 执行期间拒绝修改或清除专用模型，以及会触发 Provider 配置刷新的操作，并向用户提示。

## 触发与调度

处理单位是已结束的顶层 Run。成功、失败和中止的 Run 都可整理；失败和中止的上下文必须保留原有状态。

定时扫描 `generateMemories = true` 时的待处理 Run。触发条件为**整个 Workspace 不存在任何活动 Session，且该 Workspace 下所有 Session 的最后一次持久化事件距今均已空闲至少 30 分钟**。满足条件后，按 workspace 收集该工作区的全部 `pending` Run，并在同一 `BEGIN IMMEDIATE` 事务中原子认领这些 Run 以及该工作区当前所有 `status = 'pending'` 的 `provisional_memories`（含此前失败批次遗留的待审条目），交给同一个 Dreaming Agent；Run 按 `session_id`、开始时间排序，依次处理每个 Session 内的 Run。同一 workspace 同时只有一个 Dreaming Agent，不同 workspace 最多两个并发。

Run 结束、记忆开关变化和整理任务结束不触发立即扫描；下一次定时检查在上次检查完成后等待固定间隔。整理执行期间拒绝修改或清除专用模型，并拒绝会触发 Provider 配置刷新的操作。

调度记录区分待整理、整理中、已完成、失败和跳过，并关联 workspace、Session 与 Run。整理成功后清除本批 Run 记录中的旧候选字段并关闭本批认领的暂存记录状态；整理失败时不提交草案，本批 Run 标记失败且不重试，本批认领的暂存记录保持 `pending` 留待下次正常 Dreaming 顺带审核。

daemon 停止时取消运行中的后台调用；重启后尚未开始的 Run 继续等待调度，中断的整理批次标记失败，不重新执行。

## 统一整理 Agent

一个 workspace 一次只运行一个 Dreaming Agent。Agent 的初始输入只包含本批 Run 的元数据：

```json
{
  "workspaceId": "...",
  "runs": [
    { "runId": "...", "sessionId": "...", "startedAt": 0, "finishedAt": 0 }
  ]
}
```

初始输入不包含完整事件、全部记忆或完整 Wiki，避免一次性压入上下文。

工作区还没有可用记忆结构（缺少上下文版本或 `index.md`）时，Agent 以默认脚手架启动，并按追加的引导提示从本批原始日志搭建初始结构：先用 `draft_memory` 建立有事件来源的记忆，再用 `write_context` 写注入上下文、用 `write_wiki` 写 `index.md` 和主题文件。脚手架视为空结构而不是既有知识；即使没有记忆变更，只要初始结构是本次新建的，也会发布新的上下文和 Wiki 版本。日志中没有值得保留的知识时，保持空脚手架并正常完成。

### 工具与按需读取

- `list_runs`：重新列出本批 Run，供上下文压缩后核对。
- `read_run`：按 `offset` / `limit` 分页读取某个 Run 的事件；单页有字符预算，返回 `nextOffset`，读完为 `null`。
- `read_event`：读取候选或记忆来源引用的单个事件；单条事件超过预算时截断。
- `list_memories`：分页浏览 workspace 记忆。
- `search_memories`：按关键词与向量混合检索记忆。
- `read_memory`：读取记忆、版本和来源。
- `read_wiki`：读取 `index.md` 或主题；不传文件名时列出文件。
- `read_context`：读取当前注入上下文草案。
- `draft_memory`：用已读取的事件 ID 起草记忆变更。
- `propose_global_memory`：提交跨项目候选。
- `write_wiki`：写入 `index.md` 或主题草案。
- `write_context`：替换注入上下文草案。

写入工具只更新本批草案，不直接修改正式记录。

### 强制约束

- Agent 必须读取本批每个 Run；未读取的 Run 会使本批失败。
- `draft_memory` / `propose_global_memory` 只能引用已经通过 `read_run` 或 `read_event` 读取的事件。
- 事件 ID 必须属于本批 Run、当前 workspace，或已读取记忆的来源。
- 工具调用最多 200 次；超过上限按批次失败处理。

### 上下文压缩

Dreaming Agent 设置 `transformContext = projectContext(...)`，复用主 Agent 和子 Agent 的上下文压缩机制：

- 达到模型输入预算的 80% 时生成 checkpoint；
- checkpoint 替代旧消息进入后续模型请求，但不删除原始消息；
- 保留本批 Run 列表作为任务契约；
- 生成失败时使用确定性 fallback；仍超过窗口时明确失败。

### 审计与修正

Agent 对照当前记忆、Wiki、注入上下文和 Run 日志，处理以下关系：

| 判断 | 处理 |
| --- | --- |
| 确认 | 补充本次 Run 来源，必要时升级证据状态，不轻易改内容 |
| 修正 | 生成新记忆版本，保留旧版本和来源 |
| 冲突 | 保留双方及条件，标记 `conflicted`，在 Wiki 中说明 |
| 过时 | 标记 `superseded` 或更新适用条件，不删除历史 |
| 临时记忆 | 根据日志判断是否值得保留；支持则写入正式记忆，不支持则拒绝 |
| 无关 | 不修改已有摘要 |

没有足够的变更理由时，Agent 可以选择不调用 `draft_memory`；没有值得跨项目复用的经验时，可以不调用 `propose_global_memory`。无变更完成是正常结果。

整理主题时，Agent 按需读取相关主题，只为有实际意义的关系添加 `[主题名称](主题文件.md)` 链接；没有关系时不强制链接。

### 发布

Agent 完成后：

1. 分别校验上下文预算与导航，以及 Wiki 文件名、预算、导航和 `[memory:ID@REVISION]` 引用；
2. 准备记忆 embedding，失败时退化为关键词召回；
3. 写入新的 Wiki 目录和新的上下文目录；
4. 在一个 SQLite 事务中更新记忆、版本、来源、索引、上下文指针、Wiki 指针、Run 状态，并物理删除本批认领的 `provisional_memories`。

没有记忆、上下文、Wiki 或暂存记录变化时不创建新版本。如果本批仅清理了暂存记录而未改变正式记忆、上下文或 Wiki，则只更新 Run 状态并删除本批暂存记录，不创建新版本。

由于工作区正式 L1/L2/L3 仅由 Dreaming Worker 单写者维护，且在线 `record_memory` 只追加写入 `provisional_memories`，Dreaming 运行期间新进入会话的写入与本次发布完全隔离，不再需要发布前的上下文版本比对循环与临时区块剥离逻辑。

## 全局记忆 Agent

工作区整理 Agent 可以调用 `propose_global_memory` 提出跨项目候选（仅限跨项目通用经验，不涉及用户个性）。候选进入 Worker 内存队列，由一个全局 Agent 串行分批处理。

全局 Agent：

- 复用 Dreaming 模型与 `generateMemories` 开关（不受 `useMemories` 耦合），并使用同一套上下文压缩机制；
- 通过 `inspect_global_memories` 分页比较当前跨项目全局记忆、版本和来源；
- 通过 `draft_global_memory` / 撤销草案工具创建、修改、覆盖或撤销本批草案；
- 冲突或修正时更新已有记忆，不重复创建；
- 没有值得变更的候选时不调用写入工具。

全局发布使用 `global_memory_versions` 保存跨项目全局记忆的不可变副本（与独立表 `user_profiles` 完全解耦）。整理开始时记录 `baseVersion`；准备写入时再次比较最新版本号：若版本未变则直接原子提交；若期间用户在 Web UI 修改了全局记忆导致版本变化，则计算 `baseVersion → latestVersion` 的精确结构化 diff（新增、修改、删除），切换工具视图至最新版本并由全局 Agent 与当前草案进行**增量合并**（用户修改权威更高，冲突内容以用户为准，用户已删除内容不复活），随后再以最新版本号执行乐观锁提交。

## 存储与提交

SQLite 表：

- `user_profiles`：用户个性独立表，仅由用户在 Web UI 手动维护，不参与 Dreaming 与 `global_memory_versions`；
- `provisional_memories`：工作区在线暂存表（Append-Only，按 `workspace_id`、`session_id`、`run_id`、`status` 管理）；
- `memories`：当前长期记忆（`scope = 'global'` 仅保存跨项目全局记忆，`scope = 'workspace'` 仅由 Dreaming 维护；全局删除使用 `status = 'deleted'` 逻辑保留历史快照引用）；
- `memory_revisions`：按记忆 ID 和版本保存正文、适用条件与证据状态；
- `memory_revision_sources`：关联记忆版本与 Session、Run、事件 ID 和序号；
- `dreaming_wiki`：workspace 当前发布 Wiki 目录指针；
- `dreaming_wiki_versions`：已发布 Wiki 目录及版本；
- `dreaming_context`：workspace 当前发布上下文目录指针；
- `dreaming_context_versions`：已发布上下文目录及版本；
- `dreaming_runs`：Run 归属、状态和时间；
- `global_memory_versions`：跨项目全局记忆发布副本。

版本语义：

- 新建记忆从 revision 1 开始；
- 已有记忆内容、适用条件、证据状态或来源变化时 revision + 1；
- 一次 Dreaming 发布中，每个受影响的记忆最多 +1；
- 未变化的记忆 revision 不变；
- 每次实际发布创建一个新的 Wiki 目录，`dreaming_wiki_versions.version` + 1；
- 每次上下文实际变化创建一个新的上下文副本，`dreaming_context_versions.version` + 1。

发布事务失败时旧目录和旧版本继续生效，新目录作为未发布草案清理。旧版本目录和记忆版本保持不变。

Wiki 存放在 daemon 数据目录的 `dreaming/<workspaceId>/<directoryId>/` 下，上下文副本存放在 `dreaming/<workspaceId>/contexts/<directoryId>/context.md`，均不写入用户 workspace。主 Agent 在每个 Run 启动时分别固定上下文版本、Wiki 版本和可见记忆版本；后台发布不改变正在运行的 Run。

本地 embedding 不可用时沿用关键词召回退化行为。索引作为可重建派生数据维护。

用户删除 Session 时保留记忆和 Wiki，移除指向该 Session 的来源关联，其他来源不受影响。

## 容量与读取

| 内容 | 上限 |
| --- | ---: |
| 单个 workspace 的主题 Wiki 合计 | 40,000 字符 |
| 单个 workspace 的导航 | 4,000 字符 |
| 每次注入的核心摘要和导航 | 2,000 字符 |
| 单个 Run 事件读取页 | 12,000 字符 |
| 单条事件读取 | 12,000 字符 |
| 记忆草案正文 | 500 字符 |
| 记忆适用条件 | 500 字符 |
| Dreaming 工具调用 | 200 次 |
| Dreaming 运行时间 | 20 分钟 |

预算按字符计算，不依赖具体模型的 tokenizer。超过预算时整批失败或跳过对应追加，不提交超限草案。

## 失败、停止与可观测性

- 无变更：Run 完成，不创建新版本。
- Agent 调用失败、超时或未读取全部 Run：本批 Run 标记失败，不重试。
- 校验失败、提交失败或写入失败：草案不生效，本批 Run 标记失败，不重试；其他批次继续。
- 工具调用超限：本批失败。
- daemon 重启：未开始的工作继续等待；中断的整理标记失败；已提交批次保持完成。
- 关闭学习：已开始批次继续至成功或失败，不再启动新批次。

后台任务使用有界超时和 `AbortSignal`，daemon 关闭时中止调用。内部日志记录 workspace、Session、Run、阶段和安全错误码，不记录凭据、环境变量或会话正文。

## 实施状态

已实现：

- 四层记忆存储、版本、来源和 Wiki 发布版本；
- 注入上下文独立存储，拥有自己的版本、不可变副本和发布指针；
- `record_memory` 写入第三层并发布新的上下文副本，不修改 Wiki；
- 一个 workspace 一个 Dreaming Agent，按需分页读取 Run、记忆、上下文和 Wiki；
- 复用 `projectContext` 上下文压缩；
- 记忆确认、修正、冲突、过时和临时条目处理；
- 发布前移除临时区块，新版本不包含临时记忆；
- 发布前比较上下文版本，必要时让 Agent 对比最新内容后继续；
- 全局记忆 Agent 与全局发布版本；
- 独立 Worker、30 分钟空闲触发、失败和重启恢复。

## 验证

开发过程中使用已有会话和隔离数据验证：

- Run 结束状态、开启区间和 30 分钟空闲条件是否正确；
- 一个 workspace 的多个 Session、多个 Run 是否由同一个 Agent 依次处理；
- `read_run` 分页、事件读取限制和未读事件拒绝是否生效；
- 上下文压缩是否在长工具输出下生成 checkpoint 并继续运行；
- 记忆确认、修正、冲突、过时和临时条目是否生成正确版本；
- 新版本是否移除临时区块，旧版本是否保持原样；
- Wiki 预算、引用和发布指针是否正确；
- 全局候选是否由单一全局 Agent 处理，无变更时是否保持现状；
- 关闭记忆使用后是否不注入或读取记忆。

链路完成后选择少量代表性真实任务，对照不使用长期记忆、使用 Dreaming 整理前的记忆、使用整理后的记忆三种情况。各组保持请求、模型和可用环境一致。

## 参考资料

- [Dreaming 初始方案](./dreaming-初始方案.md)
- [全局记忆设计](./全局记忆设计.md)
- [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory)
- [Dreaming with a dynamic workflow](https://platform.claude.com/cookbook/managed-agents-cma-dreaming-with-a-dynamic-workflow)

## 第一版暂不处理

- Wiki、导航和运行状态的浏览、审核、手动重试或控制页面；
- 单个超长 Run 的分段处理之外的更细粒度事件摘要；
- 图片、PDF 页面等非文本内容的分析；
- Dreaming 与用户同时修改记忆的专门协调流程；
- 失败任务的自动或手动重试；
- 历史 Wiki 和记忆版本的清理策略；
- 完整导航与注入上下文之间的具体内容分配策略。
