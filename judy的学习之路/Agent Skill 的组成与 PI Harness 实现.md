# Agent Skill 的组成与 PI Harness 实现

让 Agent 完成一项任务时，我们经常需要反复补充相同的要求。比如编写实验报告时，需要告诉它先看模板、保留原始数据、按照指定结构组织内容。如果每次都重新描述，要求容易遗漏，也不方便在不同会话中复用。

Skill 提供了一种保存这类任务知识的方式。[Anthropic 对 Agent Skills 的介绍](https://www.anthropic.com/research/equipping-agents-for-the-real-world-with-agent-skills)将它描述为一个包含指令、脚本和资源的目录，Agent 可以发现这些内容，并在需要时加载。下面先看 Skill 的组成，再结合 PI Harness 的代码说明它怎样被创建、发现和使用。

## 一个 Skill 由什么组成

最简单的 Skill 是一个包含 `SKILL.md` 的目录。随着任务变复杂，还可以在目录中加入参考文档、脚本和模板。

```text
report-writing/
├── SKILL.md
├── references/
│   └── format.md
├── scripts/
│   └── check_report.py
└── assets/
    └── template.docx
```

`SKILL.md` 开头是 YAML frontmatter，其中的 `name` 和 `description` 描述 Skill 的名称与适用场景。后面的 Markdown 正文存放具体指令。下面是一个简化例子。

```markdown
---
name: report-writing
description: 编写和整理实验报告，在需要组织实验步骤、结果和分析时使用。
---

# 实验报告编写

先阅读用户提供的实验要求、数据和模板。
按照模板组织报告，保留原始数据，不编造实验结果。
需要了解格式要求时，读取 references/format.md。
```

这几部分分别承担不同的工作。`name` 用于标识 Skill，`description` 帮助 Agent 判断当前任务是否适合使用它。正文说明具体做法，附带的参考文件则保存只有部分任务才需要的细节。脚本可以处理适合用程序完成的操作，模板和其他素材也可以放在 Skill 目录中。

Anthropic 把这种组织方式称为渐进式披露。Agent 先看到名称和描述，选中 Skill 后再读取正文，遇到具体需要时继续读取参考文件。以 Anthropic 文章里的 PDF Skill 为例，表单填写说明可以单独放在文件里，只有处理表单时才读取。这样既能保留完整资料，也能控制当前任务占用的上下文。

Skill 包含脚本，并不意味着脚本会自动运行。Agent 仍然需要使用执行工具，运行环境和权限规则也仍然有效。来自不熟悉来源的 Skill 可能包含有风险的指令或脚本，安装和使用前应检查来源及附带内容。

## PI Harness 如何组织 Skill

PI Harness 自己实现了 Skill 的发现、校验、读取和创建，主要逻辑在 [`SkillRegistry`](../packages/tools/src/skill-registry.ts)。Skill 分为系统、项目和全局三种来源。

**系统 Skill** 由项目代码内置，目前有 `skill-creator` 和 `skill-installer`。它们对工作区可用，属于只读定义。“系统”表示来源于 PI Harness 内置代码，与操作系统版本或 Skill 版本号无关。

**项目 Skill** 跟随当前工作区。Registry 按顺序检查工作区下的 `.agents/skills` 和 `.claude/skills`。这适合保存某个项目专属的规范，例如项目的前端开发约定。

**全局 Skill** 可以供不同工作区使用。它包括 daemon 数据目录下的独立 Skill、用户目录下的 `.agents/skills` 和 `.claude/skills`，也包括已安装并启用的插件 Skill。默认数据目录是 `~/.pi-harness`；本仓库的开发配置使用 `D:\pi-harness\.pi-harness`。数据库路径配置会影响 daemon 的数据根目录，具体配置可以查看 [运行环境说明](../docs/runtime-setup.md)。

## Agent 怎么看到 Skill

每次 Run 开始前，Runtime 会通过 Registry 发现当前工作区可用的 Skill，再把去重后的 **ID 和 description** 放进 System Prompt。实现分别位于 [工作区上下文加载](../packages/agent-runtime/src/context/workspace-agent-context.ts) 和 [提示词构造](../packages/agent-runtime/src/prompts/workspace-context-prompt.ts)。

模型看到的清单形式大致如下，具体内容取决于当前工作区及已启用的 Skill。

```text
<available_skills>
- system:skill-creator: Create a new project or global Skill...
- project:report-writing: 编写和整理实验报告...
- global:code-review: Review code for...
</available_skills>
```

当前实现会注入发现结果中全部可用 Skill 的摘要，而不是只挑选一部分。这里的摘要并不包含完整正文。Agent 根据用户意图和描述决定是否使用某个 Skill，再调用 `load_skill` 读取正文。

用户也可以在消息中显式写 `$report-writing`，或通过输入器的“+ → Skills”选择。Runtime 会查找对应 Skill，把正文展开到发给模型的消息中。同一条消息重复引用同一个 Skill，只会展开一次。具体实现见 [显式 Skill 展开](../packages/agent-runtime/src/utils/skill-context.ts)。

PI Harness 为 Agent 提供了几个 Skill 工具。

| 工具 | 用途 |
| --- | --- |
| `find_skill` | 按名称和描述搜索，可限定来源范围 |
| `get_skill` | 查看元数据和资源清单，不加载正文 |
| `load_skill` | 加载正文，或按需读取 Skill 内的资源 |
| `skill_creator` | 创建新的项目或全局 Skill |

`find_skill` 用于辅助查询，并不意味着还有一批 Skill 摘要因为数量限制而没有注入。正文和附带资源才是按需加载的内容。Skill 的指令最终依赖模型遵循，描述写得清楚，可以帮助模型做出更合适的选择，但无法保证每次都选对。

## 如何配置一个 Skill

以当前工作区为例，可以在下面的位置创建一个目录和 `SKILL.md`。

```text
D:\pi-harness\.agents\skills\report-writing\SKILL.md
```

文件可以使用前面的实验报告示例。PI Harness 要求目录名与 frontmatter 的 `name` 一致，名称使用小写字母、数字和连字符。`name`、`description` 和正文都需要填写。解析器还支持 `license`、`compatibility`、`metadata`、`allowed-tools` 等可选字段，以及项目扩展字段 `type`，具体校验见 [Skill 文档解析](../packages/tools/src/utils/skill-document.ts)。

Skill 的参考文件可以放在 `references`，脚本可以放在 `scripts`。正文应写明什么时候需要这些资源，让 Agent 按任务读取。PI Harness 会对资源读取做路径和大小检查。若脚本需要执行，仍须通过现有命令工具及其权限机制。

在设置的技能页可以查看和管理系统 Skill、独立全局 Skill 和项目 Skill，插件提供的 Skill 在插件市场管理。Skill 停用后不会进入 Agent 的常规可用清单。新 Run 会重新发现 Skill，如果没有看到刚创建的项目 Skill，可以检查工作区是否正确、目录名和 `name` 是否一致、frontmatter 是否有效，以及 Skill 是否启用。格式无效的 Skill 会在发现时被跳过。

## 创建 Skill 后会保存在哪里

如果用户让 Agent 创建 Skill，内置 `skill-creator` 的指导默认选择当前项目。假设工作区是 `D:\pi-harness`，创建 `report-writing` 后，目标文件位于下面的路径。

```text
D:\pi-harness\.agents\skills\report-writing\SKILL.md
```

用户明确要求全局 Skill 时，创建工具会写入 daemon 数据根目录下的 `skills` 目录。在本仓库默认开发配置下，对应路径如下。

```text
D:\pi-harness\.pi-harness\skills\report-writing\SKILL.md
```

如果 daemon 使用默认正式运行配置，则全局位置是 `~/.pi-harness/skills/report-writing/SKILL.md`。实际位置由 daemon 配置决定，不能仅凭工作区路径判断。

负责创建的工具是 `skill_creator`。它接收名称、描述、正文和目标范围，创建目录与最小的 `SKILL.md`，并经过写入权限策略。工具只创建新 Skill，不覆盖现有目标，代码见 [skill-creator.ts](../packages/tools/src/skills/skill-creator.ts)。需要更多参考文件或脚本时，仍需通过适当的文件工具处理，并遵守工作区和审批规则。

## 同名 Skill 的优先级

常规发现时，Registry 按系统、项目、全局的顺序处理同名 Skill。同一个范围内也有顺序。

```text
系统 Skill
  ↓
项目 Skill
  1. <workspace>/.agents/skills
  2. <workspace>/.claude/skills
  ↓
全局 Skill
  1. 已安装并启用的插件 Skill
  2. <daemon 数据目录>/skills
  3. ~/.agents/skills
  4. ~/.claude/skills
```

Registry 用名称记录已经处理过的 Skill，后面遇到同名项便跳过。例如，项目 `.agents/skills` 和 daemon 全局目录都存在 `report-writing` 时，常规清单只保留项目版本。消息中的 `$report-writing` 也会从这个清单选择项目版本。

停用优先级更高的独立 Skill 后，低优先级同名 Skill 不会自动顶上来。例如项目版 `report-writing` 被停用时，同名全局版不会因此自动出现在常规清单中。`get_skill` 和 `load_skill` 可以指定 `scope`，将查询限定在 `project` 或 `global` 等范围内；同一范围内仍按各目录的顺序查找。

如果创建了一个与系统内置 `skill-creator` 同名的项目 Skill，它在常规发现时会被系统版本遮住。系统优先级最高，含义就是优先使用代码内置定义。

## 创建时如何处理重名

创建时的检查范围比运行时去重范围更窄。`skill_creator` 只检查本次要创建的**目标目录**，并用独占写入保护文件，不会先检查所有来源是否有同名 Skill。

| 已有内容 | 创建目标 | 结果 |
| --- | --- | --- |
| 项目的 `.agents/skills/report-writing` | 同一个项目目录 | 返回 `SKILL_ALREADY_EXISTS`，不会覆盖 |
| daemon 全局目录下的 `report-writing` | 同一个全局目录 | 返回重名错误，不会覆盖 |
| 只有全局 `report-writing` | 项目的 `.agents/skills` | 可以创建，常规发现时项目版优先 |
| 项目的 `.claude/skills` 有同名项 | 项目的 `.agents/skills` | 可以创建，常规发现时 `.agents` 版本优先 |
| 系统内置 Skill 同名 | 项目目标目录 | 目标不存在时可能创建成功，但常规发现时系统版本优先 |

因此，创建前可以先搜索是否已有合适的 Skill，再决定复用、换名，还是有意创建一个项目版本。不过 `find_skill` 基于发现结果，无法保证列出所有被高优先级同名项遮住的文件。如果需要彻底检查重名，还要查看各来源目录和插件注册情况。

## Skill 和工具权限是什么关系

Skill 可以告诉 Agent 怎样完成任务，但 Agent 调用文件、Shell 或 MCP 工具时，仍要经过工具参数校验、Policy 和相应审批。项目对 Skill 资源也执行路径边界检查。

`SKILL.md` 可以声明 `allowed-tools`。普通加载正文不会授予这些工具权限。Agent 需要调用 `load_skill` 并设置 `approveTools: true`，才会申请声明工具在当前 Run 的预授权。`full_access` 可以自动批准，其他模式需要用户确认。预授权仍受路径保护、计划模式等检查约束；Skill 内容或启用状态发生变化时，授权会失效。完整规则见 [项目架构设计](../docs/架构设计.md)。

## Agent 能否自己安装 Skill

Agent 可以通过内置的 `skill_creator` 创建 Skill。安装已有 Skill 则有另一条明确的入口。在设置页选择“新增技能 → 安装”，填写 GitHub 地址和可选 Skill 名称，daemon 会在临时目录通过固定版本的 Skills CLI 获取和校验内容，再复制到全局 Skill 目录。同名目标不会被覆盖。

项目虽然内置了 `skill-installer`，但它是一份安装指导，当前注册的 Agent 工具中没有专门的 `install_skill`。因此不能因为 Agent 看到了这份系统 Skill，就认为它已经拥有直接调用受控安装流程的工具。安装可以通过设置界面完成；如果尝试其他方式，仍受现有文件、Shell 和审批边界约束。安装实现见 [workspace-service.ts](../apps/daemon/src/services/workspace-service.ts)。

## 参考资料

- [Anthropic 对 Agent Skills 的介绍](https://www.anthropic.com/research/equipping-agents-for-the-real-world-with-agent-skills)
- [PI Harness 架构设计](../docs/架构设计.md)
- [PI Harness 运行环境说明](../docs/runtime-setup.md)
