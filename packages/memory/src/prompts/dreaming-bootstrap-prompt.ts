// 记忆结构尚未建立时，指示整理 Agent 从原始日志搭建初始 Wiki 和上下文。
export const DREAMING_BOOTSTRAP_PROMPT = `The workspace has no usable published memory structure yet: the injected context and index.md are empty scaffolding, not prior knowledge.
Build the initial structure from the raw run logs:
- Read every run in the batch and draft durable workspace memories with supporting event ids.
- Write the injected context with write_context as a concise core summary that navigates to index.md.
- Write index.md with write_wiki listing every topic file you create.
- Create topic files only when they organize related memories, and cite each memory with [memory:ID@REVISION].
Do not copy transient progress, secrets or unverified assumptions into memory. If the logs contain no durable knowledge, keep the empty scaffolding and finish without drafting memories.`;
