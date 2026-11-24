import { randomUUID } from "node:crypto";
import {
  type CreateMemoryInput,
  type CreateUserProfileInput,
  MemoryErrorCode,
  type MemoryErrorCode as MemoryErrorCodeValue,
  type MemoryRecord,
  MemoryScope,
  type MemoryScope as MemoryScopeValue,
  type MemorySettings,
  type MemorySourceType,
  type MemoryState,
  MemorySourceType as SourceType,
  type UpdateMemoryInput,
  type UpdateMemorySettingsInput,
  type UpdateUserProfileInput,
  type UserProfile,
  UserProfileFacet,
  type UserProfileItem,
} from "./contract.js";
import type { ProvisionalMemory, RecordedMemory, RecordMemoryInput } from "./dreaming.js";
import { buildMemoryContextPrompt } from "./prompts/memory-context-prompt.js";
import {
  formatProvisionalMemoriesContext,
  searchOverflowProvisionalMemories,
} from "./utils/provisional-context.js";

export class MemoryError extends Error {
  public constructor(
    public readonly code: MemoryErrorCodeValue,
    message: string,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}

export interface StoredMemoryInput extends MemoryRecord {
  normalizedContent: string;
}

export interface StoredUserProfileInput extends UserProfileItem {
  normalizedContent: string;
}

export interface UserProfileRepository {
  create(item: StoredUserProfileInput): void;
  delete(profileId: string): boolean;
  find(profileId: string): UserProfileItem | null;
  findDuplicate(normalizedContent: string, excludeId?: string): UserProfileItem | null;
  list(): readonly UserProfileItem[];
  update(item: StoredUserProfileInput): boolean;
}

export interface MemoryEmbedding {
  dimensions: number;
  modelId: string;
  values: readonly number[];
}

export interface StoredMemoryEmbedding extends MemoryEmbedding {
  memoryId: string;
  memoryRevision: number;
  updatedAt: number;
}

export interface VisibleMemoryEmbedding {
  memory: MemoryRecord;
  values: readonly number[];
}

export interface MemoryEmbedder {
  readonly modelId: string;
  embed(
    purpose: "document" | "query",
    inputs: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly (readonly number[])[]>;
}

export interface MemoryRepository {
  create(memory: StoredMemoryInput, embedding: MemoryEmbedding | null): void;
  delete(memoryId: string, expectedRevision: number): boolean;
  find(memoryId: string): MemoryRecord | null;
  findDuplicate(
    normalizedContent: string,
    scope: MemoryScopeValue,
    workspaceId: string | null,
    excludeId?: string,
  ): MemoryRecord | null;
  getSettings(): MemorySettings;
  hasWorkspace(workspaceId: string): boolean;
  list(): readonly MemoryRecord[];
  isEmbeddingIndexCurrent(modelId: string): boolean;
  listVisibleEmbeddings(workspaceId: string, modelId: string): readonly VisibleMemoryEmbedding[];
  replaceEmbeddingIndex(
    modelId: string,
    embeddings: readonly StoredMemoryEmbedding[],
    updatedAt: number,
  ): void;
  searchKeywordVisible(query: string, workspaceId: string, limit: number): readonly MemoryRecord[];
  searchKeywordSnapshot(
    query: string,
    workspaceId: string,
    versions: ReadonlyMap<string, number>,
    limit: number,
    globalMemories?: readonly MemoryRecord[],
  ): readonly MemoryRecord[];
  listSnapshotEmbeddings(
    workspaceId: string,
    versions: ReadonlyMap<string, number>,
    modelId: string,
    globalMemories?: readonly MemoryRecord[],
  ): readonly VisibleMemoryEmbedding[];
  update(
    memory: StoredMemoryInput,
    expectedRevision: number,
    embedding?: MemoryEmbedding | null,
  ): boolean;
  updateSettings(settings: MemorySettings, updatedAt: number): void;
}

// Run 固定开关、用户个性、上下文、Wiki 版本、每条可见记忆版本以及本 Session 待审暂存记录。
export interface RunMemorySnapshot {
  workspaceId: string;
  sessionId?: string;
  settings?: MemorySettings;
  contextDirectoryId: string | null;
  contextVersion: number | null;
  wikiDirectoryId: string | null;
  wikiVersion: number | null;
  versions: ReadonlyMap<string, number>;
  globalVersion?: number;
  globalMemories?: readonly MemoryRecord[];
  workspaceMemories?: readonly MemoryRecord[];
  provisionalMemories?: readonly ProvisionalMemory[];
  userProfiles?: readonly UserProfileItem[];
}

// 主 Agent 读取已发布的 Dreaming 内容，具体存储由 daemon 提供。
export interface DreamingReader {
  captureSnapshot(workspaceId: string, sessionId?: string): RunMemorySnapshot;
  readContext(workspaceId: string, snapshot?: RunMemorySnapshot): Promise<string | null>;
  readGlobalContext(snapshot?: RunMemorySnapshot): string | null;
  readUserProfileContext(snapshot?: RunMemorySnapshot): string | null;
  readWiki(
    workspaceId: string,
    name: string,
    signal?: AbortSignal,
    snapshot?: RunMemorySnapshot,
  ): Promise<string | null>;
  readRevision(
    workspaceId: string,
    memoryId: string,
    revision: number,
    snapshot?: RunMemorySnapshot,
  ): unknown;
  readSource(
    workspaceId: string,
    memoryId: string,
    revision: number,
    sessionId: string,
    eventId: string,
    signal?: AbortSignal,
    snapshot?: RunMemorySnapshot,
  ): Promise<unknown>;
}

// 主 Agent 在工作过程中写入第三层记忆摘要，并同步追加第一层临时入口。
export interface MemoryRecorder {
  record(input: RecordMemoryInput, signal?: AbortSignal): Promise<RecordedMemory>;
}

export interface MemoryRuntime {
  captureSnapshot(workspaceId: string, sessionId?: string): RunMemorySnapshot | null;
  buildContext(
    workspaceId: string,
    signal?: AbortSignal,
    snapshot?: RunMemorySnapshot | null,
  ): Promise<string>;
  readWiki(
    workspaceId: string,
    name: string,
    signal?: AbortSignal,
    snapshot?: RunMemorySnapshot | null,
  ): Promise<string | null>;
  readRevision(
    workspaceId: string,
    memoryId: string,
    revision: number,
    snapshot?: RunMemorySnapshot | null,
  ): unknown;
  readSource(
    workspaceId: string,
    memoryId: string,
    revision: number,
    sessionId: string,
    eventId: string,
    signal?: AbortSignal,
    snapshot?: RunMemorySnapshot | null,
  ): Promise<unknown>;
  recordMemory(input: RecordMemoryInput, signal?: AbortSignal): Promise<RecordedMemory>;
  getSettings(): MemorySettings;
  search(
    query: string,
    workspaceId: string,
    limit?: number,
    signal?: AbortSignal,
    snapshot?: RunMemorySnapshot | null,
  ): Promise<readonly MemoryRecord[]>;
}

const DEFAULT_SETTINGS = { generateMemories: true, useMemories: true } as const;
const HYBRID_CANDIDATE_MULTIPLIER = 4;
const HYBRID_RRF_K = 60;
// Keep lexical hits ahead of semantic-only candidates within the public 50-result limit.
const KEYWORD_WEIGHT = 1.1;
const MAX_SEMANTIC_SCORE_DROP = 0.03;
const MIN_HYBRID_CANDIDATES = 40;
const PROFILE_FACETS = Object.values(UserProfileFacet);
const SEMANTIC_WEIGHT = 0.6;

function normalizeContent(content: string): { content: string; normalized: string } {
  const trimmed = content.trim().replaceAll(/\s+/g, " ");
  if (!trimmed || trimmed.length > 500) {
    throw new MemoryError(MemoryErrorCode.INVALID, "记忆内容长度必须为 1 到 500 个字符");
  }
  return { content: trimmed, normalized: trimmed.toLocaleLowerCase() };
}

export function buildUserProfile(items: readonly UserProfileItem[]): UserProfile {
  return {
    sections: PROFILE_FACETS.map((facet) => ({
      facet,
      items: items.filter((item) => item.facet === facet),
    })),
    updatedAt: items.reduce<number | null>(
      (latest, item) => (latest === null ? item.updatedAt : Math.max(latest, item.updatedAt)),
      null,
    ),
  };
}

export class MemoryService implements MemoryRuntime {
  private mutationTail = Promise.resolve();

  public constructor(
    private readonly repository: MemoryRepository,
    private readonly embedder: MemoryEmbedder,
    private readonly dreaming?: DreamingReader,
    private readonly recorder?: MemoryRecorder,
    private readonly userProfiles?: UserProfileRepository,
  ) {}

  // 为主 Run 固定开关状态、用户个性、记忆、Wiki 发布版本及本 Session 的待审暂存记录；运行中途切换开关不影响本次 Run。
  public captureSnapshot(workspaceId: string, sessionId?: string): RunMemorySnapshot | null {
    const settings = this.repository.getSettings();
    if (!settings.useMemories || !this.dreaming)
      return {
        workspaceId,
        ...(sessionId ? { sessionId } : {}),
        settings,
        contextDirectoryId: null,
        contextVersion: null,
        wikiDirectoryId: null,
        wikiVersion: null,
        versions: new Map(),
        globalMemories: [],
        workspaceMemories: [],
        provisionalMemories: [],
        userProfiles: [],
      };
    return {
      ...this.dreaming.captureSnapshot(workspaceId, sessionId),
      settings,
    };
  }

  private canUseMemories(snapshot?: RunMemorySnapshot | null): boolean {
    return snapshot?.settings
      ? snapshot.settings.useMemories
      : this.repository.getSettings().useMemories;
  }

  // 关闭记忆使用时不读取已发布的 Wiki 或来源；已有 Run 按启动时固定的开关继续执行。
  public async readWiki(
    workspaceId: string,
    name: string,
    signal?: AbortSignal,
    snapshot?: RunMemorySnapshot | null,
  ): Promise<string | null> {
    if (!this.canUseMemories(snapshot) || !this.dreaming) return null;
    return this.dreaming.readWiki(workspaceId, name, signal, snapshot ?? undefined);
  }

  // 只读取当前工作区允许访问的记忆版本。
  public readRevision(
    workspaceId: string,
    memoryId: string,
    revision: number,
    snapshot?: RunMemorySnapshot | null,
  ): unknown {
    if (!this.canUseMemories(snapshot) || !this.dreaming) return null;
    return this.dreaming.readRevision(workspaceId, memoryId, revision, snapshot ?? undefined);
  }

  // 只读取记忆版本引用的会话事件。
  public async readSource(
    workspaceId: string,
    memoryId: string,
    revision: number,
    sessionId: string,
    eventId: string,
    signal?: AbortSignal,
    snapshot?: RunMemorySnapshot | null,
  ): Promise<unknown> {
    if (!this.canUseMemories(snapshot) || !this.dreaming) return null;
    return this.dreaming.readSource(
      workspaceId,
      memoryId,
      revision,
      sessionId,
      eventId,
      signal,
      snapshot ?? undefined,
    );
  }

  // 主 Agent 仅在开启生成记忆时写入；在进入写入队列前同步校验开关，避免中断已发起的写入。
  public async recordMemory(
    input: RecordMemoryInput,
    signal?: AbortSignal,
  ): Promise<RecordedMemory> {
    this.assertLearningEnabled();
    if (!this.recorder)
      throw new MemoryError(MemoryErrorCode.INVALID, "当前运行未配置记忆写入能力");
    const recorder = this.recorder;
    return this.withMutation(() => recorder.record(input, signal));
  }

  private assertLearningEnabled(): void {
    const settings = this.repository.getSettings();
    if (!settings.generateMemories)
      throw new MemoryError(MemoryErrorCode.LEARNING_DISABLED, "已关闭生成记忆");
  }

  // Web 设置页只查看跨项目全局记忆和独立用户个性，不暴露工作区记忆。
  public getState(): MemoryState {
    const globalMemories = this.repository
      .list()
      .filter((memory) => memory.scope === MemoryScope.GLOBAL);
    const profiles = this.userProfiles?.list() ?? [];
    return {
      memories: globalMemories,
      profile: buildUserProfile(profiles),
      settings: this.repository.getSettings(),
    };
  }

  public getSettings(): MemorySettings {
    return this.repository.getSettings();
  }

  // 用户个性仅通过独立表同步维护，不涉及全局记忆版本或 Dreaming 并发。
  public listUserProfiles(): readonly UserProfileItem[] {
    return this.userProfiles?.list() ?? [];
  }

  public createUserProfile(input: CreateUserProfileInput): UserProfileItem {
    if (!this.userProfiles)
      throw new MemoryError(MemoryErrorCode.INVALID, "当前运行未配置用户个性存储");
    const content = normalizeContent(input.content);
    if (this.userProfiles.findDuplicate(content.normalized)) {
      throw new MemoryError(MemoryErrorCode.DUPLICATE, "已有相同的用户个性记录");
    }
    const now = Date.now();
    const item: StoredUserProfileInput = {
      id: randomUUID(),
      facet: input.facet,
      content: content.content,
      normalizedContent: content.normalized,
      createdAt: now,
      updatedAt: now,
    };
    this.userProfiles.create(item);
    return {
      id: item.id,
      facet: item.facet,
      content: item.content,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  public updateUserProfile(profileId: string, input: UpdateUserProfileInput): UserProfileItem {
    if (!this.userProfiles)
      throw new MemoryError(MemoryErrorCode.INVALID, "当前运行未配置用户个性存储");
    const current = this.userProfiles.find(profileId);
    if (!current) throw new MemoryError(MemoryErrorCode.NOT_FOUND, "用户个性记录不存在");
    const content = normalizeContent(input.content ?? current.content);
    const facet = input.facet ?? current.facet;
    if (this.userProfiles.findDuplicate(content.normalized, profileId)) {
      throw new MemoryError(MemoryErrorCode.DUPLICATE, "已有相同的用户个性记录");
    }
    const updated: StoredUserProfileInput = {
      ...current,
      content: content.content,
      normalizedContent: content.normalized,
      facet,
      updatedAt: Date.now(),
    };
    if (!this.userProfiles.update(updated)) {
      throw new MemoryError(MemoryErrorCode.NOT_FOUND, "用户个性记录不存在");
    }
    return {
      id: updated.id,
      facet: updated.facet,
      content: updated.content,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  public deleteUserProfile(profileId: string): void {
    if (!this.userProfiles)
      throw new MemoryError(MemoryErrorCode.INVALID, "当前运行未配置用户个性存储");
    if (!this.userProfiles.delete(profileId)) {
      throw new MemoryError(MemoryErrorCode.NOT_FOUND, "用户个性记录不存在");
    }
  }

  // Web API 手动创建的记忆固定为跨项目全局记忆（scope='global'）。
  public createManual(input: CreateMemoryInput, signal?: AbortSignal): Promise<MemoryRecord> {
    return this.withMutation(() =>
      this.create(
        {
          content: input.content,
          scope: MemoryScope.GLOBAL,
          sourceSessionId: null,
          sourceType: SourceType.MANUAL,
          workspaceId: null,
        },
        signal,
      ),
    );
  }

  public update(
    memoryId: string,
    input: UpdateMemoryInput,
    signal?: AbortSignal,
  ): Promise<MemoryRecord> {
    return this.withMutation(() => this.updateUnlocked(memoryId, input, signal));
  }

  private async updateUnlocked(
    memoryId: string,
    input: UpdateMemoryInput,
    signal?: AbortSignal,
  ): Promise<MemoryRecord> {
    const current = this.repository.find(memoryId);
    if (!current) throw new MemoryError(MemoryErrorCode.NOT_FOUND, "记忆不存在");
    if (current.scope !== MemoryScope.GLOBAL) {
      throw new MemoryError(
        MemoryErrorCode.INVALID,
        "工作区记忆仅由 Dreaming 自动维护，不支持手动修改",
      );
    }
    if (current.revision !== input.expectedRevision) {
      throw new MemoryError(MemoryErrorCode.CONFLICT, "记忆已发生变化，请刷新后重试");
    }
    const content = normalizeContent(input.content);
    const duplicate = this.repository.findDuplicate(
      content.normalized,
      MemoryScope.GLOBAL,
      null,
      memoryId,
    );
    if (duplicate) throw new MemoryError(MemoryErrorCode.DUPLICATE, "已有相同的全局记忆");
    const updated: StoredMemoryInput = {
      ...current,
      content: content.content,
      normalizedContent: content.normalized,
      revision: current.revision + 1,
      scope: MemoryScope.GLOBAL,
      updatedAt: Date.now(),
      workspaceId: null,
    };
    const embedding =
      updated.content === current.content
        ? undefined
        : await this.tryEmbedMemory(updated.content, signal);
    if (!this.repository.update(updated, input.expectedRevision, embedding)) {
      throw new MemoryError(MemoryErrorCode.CONFLICT, "记忆已发生变化，请刷新后重试");
    }
    return updated;
  }

  public updateContent(
    memoryId: string,
    content: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<MemoryRecord> {
    return this.update(memoryId, { content, expectedRevision }, signal);
  }

  public delete(memoryId: string, expectedRevision: number): Promise<void> {
    return this.withMutation(() => this.deleteUnlocked(memoryId, expectedRevision));
  }

  private deleteUnlocked(memoryId: string, expectedRevision: number): void {
    const current = this.repository.find(memoryId);
    if (!current) throw new MemoryError(MemoryErrorCode.NOT_FOUND, "记忆不存在");
    if (current.scope !== MemoryScope.GLOBAL) {
      throw new MemoryError(
        MemoryErrorCode.INVALID,
        "工作区记忆仅由 Dreaming 自动维护，不支持手动删除",
      );
    }
    if (
      current.revision !== expectedRevision ||
      !this.repository.delete(memoryId, expectedRevision)
    ) {
      throw new MemoryError(MemoryErrorCode.CONFLICT, "记忆已发生变化，请刷新后重试");
    }
  }

  // 开关更新是同步 SQLite 事务，不排入慢速写入队列，避免阻塞正在执行的记忆写入或嵌入计算。
  public async updateSettings(input: UpdateMemorySettingsInput): Promise<MemorySettings> {
    const settings = { ...this.repository.getSettings(), ...input };
    this.repository.updateSettings(settings, Date.now());
    return settings;
  }

  public async search(
    query: string,
    workspaceId: string,
    limit = 20,
    signal?: AbortSignal,
    snapshot?: RunMemorySnapshot | null,
  ): Promise<readonly MemoryRecord[]> {
    return this.searchInternal(query, workspaceId, limit, signal, true, snapshot);
  }

  // 已启动的 Dreaming 整理在学习关闭后仍可读取工作区记忆。
  public async searchForDreaming(
    query: string,
    workspaceId: string,
    limit = 20,
    signal?: AbortSignal,
  ): Promise<readonly MemoryRecord[]> {
    return this.searchInternal(query, workspaceId, limit, signal, false);
  }

  // 统一执行关键词与向量混合召回。
  private async searchInternal(
    query: string,
    workspaceId: string,
    limit: number,
    signal: AbortSignal | undefined,
    requireMemoryUse: boolean,
    snapshot?: RunMemorySnapshot | null,
  ): Promise<readonly MemoryRecord[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new MemoryError(MemoryErrorCode.INVALID, "检索内容不能为空");
    this.assertWorkspace(workspaceId);
    if (requireMemoryUse && !this.canUseMemories(snapshot)) return [];
    const resultLimit = Math.min(Math.max(limit, 1), 50);
    const candidateLimit = Math.max(
      MIN_HYBRID_CANDIDATES,
      resultLimit * HYBRID_CANDIDATE_MULTIPLIER,
    );
    const keyword = snapshot
      ? this.repository.searchKeywordSnapshot(
          normalizedQuery,
          workspaceId,
          snapshot.versions,
          candidateLimit,
          snapshot.globalMemories && snapshot.workspaceMemories
            ? [...snapshot.globalMemories, ...snapshot.workspaceMemories]
            : snapshot.globalMemories,
        )
      : this.repository.searchKeywordVisible(normalizedQuery, workspaceId, candidateLimit);
    const overflowProvisional =
      requireMemoryUse && snapshot?.provisionalMemories?.length
        ? formatProvisionalMemoriesContext(snapshot.provisionalMemories).overflow
        : [];
    const overflowHits = searchOverflowProvisionalMemories(
      normalizedQuery,
      overflowProvisional,
      resultLimit,
    );
    const mergeOverflow = (base: readonly MemoryRecord[]): readonly MemoryRecord[] => {
      if (!overflowHits.length) return base.slice(0, resultLimit);
      const seen = new Set(base.map((item) => item.id));
      const extra = overflowHits.filter((item) => !seen.has(item.id));
      return [...base, ...extra].slice(0, resultLimit);
    };
    try {
      await this.ensureEmbeddingIndex(signal);
      const [queryVector] = await this.embedMany("query", [normalizedQuery], signal);
      if (!queryVector) return mergeOverflow(keyword);
      const semanticScores = (
        snapshot
          ? this.repository.listSnapshotEmbeddings(
              workspaceId,
              snapshot.versions,
              this.embedder.modelId,
              snapshot.globalMemories && snapshot.workspaceMemories
                ? [...snapshot.globalMemories, ...snapshot.workspaceMemories]
                : snapshot.globalMemories,
            )
          : this.repository.listVisibleEmbeddings(workspaceId, this.embedder.modelId)
      )
        // ponytail: exact scan is simpler for local memory volumes; add an ANN index when profiling shows this hot.
        .map(({ memory, values }) => ({ memory, score: dotProduct(queryVector, values) }))
        .sort((left, right) => right.score - left.score);
      const bestSemanticScore = semanticScores[0]?.score;
      const semantic = semanticScores
        // E5 absolute scores cluster tightly; keep candidates close to the best rank instead of using an ineffective absolute threshold.
        .filter(
          ({ score }) =>
            bestSemanticScore !== undefined && bestSemanticScore - score <= MAX_SEMANTIC_SCORE_DROP,
        )
        .slice(0, candidateLimit)
        .map(({ memory }) => memory);

      return mergeOverflow(fuseRanks(keyword, semantic));
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      return mergeOverflow(keyword);
    }
  }

  // 使用 Run 固定的开关、用户个性、上下文版本及本 Session 暂存记录在内存中拼装，不写入磁盘 context.md。
  public async buildContext(
    workspaceId: string,
    _signal?: AbortSignal,
    snapshot?: RunMemorySnapshot | null,
  ): Promise<string> {
    this.assertWorkspace(workspaceId);
    const settings = snapshot?.settings ?? this.repository.getSettings();
    const context =
      settings.useMemories && this.dreaming
        ? await this.dreaming.readContext(workspaceId, snapshot ?? undefined)
        : null;
    const globalContext =
      settings.useMemories && this.dreaming
        ? this.dreaming.readGlobalContext(snapshot ?? undefined)
        : null;
    const userProfileContext =
      settings.useMemories && this.dreaming
        ? this.dreaming.readUserProfileContext(snapshot ?? undefined)
        : null;
    const provisionalContext = settings.useMemories
      ? formatProvisionalMemoriesContext(snapshot?.provisionalMemories ?? []).text
      : null;
    return buildMemoryContextPrompt(
      settings,
      settings.useMemories ? context : null,
      settings.useMemories ? globalContext : null,
      provisionalContext,
      userProfileContext,
    );
  }

  private async create(
    input: {
      content: string;
      scope: MemoryScopeValue;
      sourceSessionId: string | null;
      sourceType: MemorySourceType;
      workspaceId: string | null;
    },
    signal?: AbortSignal,
  ): Promise<MemoryRecord> {
    const content = normalizeContent(input.content);
    const workspaceId = input.scope === MemoryScope.GLOBAL ? null : input.workspaceId;
    if (input.scope === MemoryScope.WORKSPACE && !workspaceId) {
      throw new MemoryError(MemoryErrorCode.INVALID, "项目记忆必须指定 Workspace");
    }
    this.assertWorkspace(workspaceId);
    if (this.repository.findDuplicate(content.normalized, input.scope, workspaceId)) {
      throw new MemoryError(MemoryErrorCode.DUPLICATE, "已有相同作用范围的记忆");
    }
    const createdAt = Date.now();
    const memory: StoredMemoryInput = {
      content: content.content,
      createdAt,
      id: randomUUID(),
      normalizedContent: content.normalized,
      revision: 1,
      scope: input.scope,
      sourceSessionId: input.sourceSessionId,
      sourceType: input.sourceType,
      updatedAt: createdAt,
      workspaceId,
    };
    const embedding = await this.tryEmbedMemory(memory.content, signal);
    this.repository.create(memory, embedding);
    return memory;
  }

  private async tryEmbedMemory(
    content: string,
    signal?: AbortSignal,
  ): Promise<MemoryEmbedding | null> {
    try {
      const [values] = await this.embedMany("document", [content], signal);
      return values ? { dimensions: values.length, modelId: this.embedder.modelId, values } : null;
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      return null;
    }
  }

  private async embedMany(
    purpose: "document" | "query",
    inputs: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly (readonly number[])[]> {
    if (!inputs.length) return [];
    try {
      const vectors = await this.embedder.embed(purpose, inputs, signal);
      if (vectors.length !== inputs.length) throw new Error("Embedding count mismatch");
      const dimensions = vectors[0]?.length ?? 0;
      if (!dimensions || vectors.some((vector) => vector.length !== dimensions)) {
        throw new Error("Embedding dimensions mismatch");
      }
      return vectors.map(normalizeVector);
    } catch (error: unknown) {
      if (error instanceof MemoryError) throw error;
      if (signal?.aborted) throw error;
      throw new MemoryError(
        MemoryErrorCode.EMBEDDING_FAILED,
        error instanceof Error ? error.message : "向量生成失败",
      );
    }
  }

  private async ensureEmbeddingIndex(signal?: AbortSignal): Promise<void> {
    if (this.repository.isEmbeddingIndexCurrent(this.embedder.modelId)) return;
    await this.withMutation(async () => {
      if (this.repository.isEmbeddingIndexCurrent(this.embedder.modelId)) return;
      const memories = this.repository.list();
      const vectors = await this.embedMany(
        "document",
        memories.map(({ content }) => content),
        signal,
      );
      const updatedAt = Date.now();
      this.repository.replaceEmbeddingIndex(
        this.embedder.modelId,
        memories.map((memory, index) => ({
          dimensions: vectors[index]?.length ?? 0,
          memoryId: memory.id,
          memoryRevision: memory.revision,
          modelId: this.embedder.modelId,
          updatedAt,
          values: vectors[index] ?? [],
        })),
        updatedAt,
      );
    });
  }

  private async withMutation<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertWorkspace(workspaceId: string | null): void {
    if (workspaceId !== null && !this.repository.hasWorkspace(workspaceId)) {
      throw new MemoryError(MemoryErrorCode.WORKSPACE_NOT_FOUND, "Workspace 不存在");
    }
  }
}

export function getDefaultMemorySettings(): MemorySettings {
  return { ...DEFAULT_SETTINGS };
}

function normalizeVector(vector: readonly number[]): readonly number[] {
  if (!vector.length || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Invalid embedding vector");
  }
  const magnitude = Math.hypot(...vector);
  if (!magnitude) throw new Error("Invalid zero embedding vector");
  return vector.map((value) => value / magnitude);
}

function dotProduct(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) return Number.NEGATIVE_INFINITY;
  return left.reduce((score, value, index) => score + value * (right[index] ?? 0), 0);
}

function fuseRanks(
  keyword: readonly MemoryRecord[],
  semantic: readonly MemoryRecord[],
): readonly MemoryRecord[] {
  const records = new Map<string, MemoryRecord>();
  const scores = new Map<string, number>();
  const add = (items: readonly MemoryRecord[], weight: number) => {
    items.forEach((memory, index) => {
      records.set(memory.id, memory);
      scores.set(memory.id, (scores.get(memory.id) ?? 0) + weight / (HYBRID_RRF_K + index + 1));
    });
  };
  add(keyword, KEYWORD_WEIGHT);
  add(semantic, SEMANTIC_WEIGHT);
  return [...records.values()].sort(
    (left, right) =>
      (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0) || right.updatedAt - left.updatedAt,
  );
}
