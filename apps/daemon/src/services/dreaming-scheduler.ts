import { DreamingRunStatus, type MemoryService } from "@pi-harness/memory";
import type {
  DreamingRunRecord,
  SqliteDreamingRepository,
} from "../storage/dreaming-repository.js";
import type { SessionEventStore } from "../storage/session-event-store.js";
import type { DreamingService } from "./dreaming-service.js";
import type { GlobalDreamingService } from "./global-dreaming-service.js";
import type { ProviderService } from "./provider-service.js";

const IDLE_MS = 30 * 60_000;
const CHECK_INTERVAL_MS = 60_000;
const ANALYSIS_LIMIT = 2;

// 周期扫描待处理 Run，并按队列顺序分配分析名额。
export class DreamingScheduler {
  private readonly controller = new AbortController();
  private readonly activeSessions = new Set<string>();
  private readonly activeWorkspaces = new Set<string>();
  private isGlobalActive = false;
  private readonly activeProviders = new Map<string, number>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly queue: DreamingRunRecord[] = [];
  private readonly queuedIds = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scanTask: Promise<void> | null = null;
  private drainTask: Promise<void> | null = null;
  private drainRequested = false;
  private shouldScan = false;

  public constructor(
    private readonly dreaming: SqliteDreamingRepository,
    private readonly memories: MemoryService,
    private readonly events: SessionEventStore,
    private readonly providers: ProviderService,
    private readonly service: DreamingService,
    private readonly isSessionActive: (sessionId: string) => boolean | Promise<boolean>,
    private readonly onError: (
      phase: "scan" | "analysis" | "consolidation" | "global_consolidation",
      ids: readonly string[],
    ) => void,
    private readonly onProviderActivity: (providerId: string, active: boolean) => void = () => {},
    private readonly prepareScan: () => boolean = () => true,
    private readonly globalService?: GlobalDreamingService,
  ) {}

  // 判断是否存在正在分析或整理的后台工作。
  public isActive(): boolean {
    return this.tasks.size > 0;
  }

  // 防止正在使用的 Dreaming Provider 被同时修改认证配置。
  public isProviderActive(providerId: string): boolean {
    return (this.activeProviders.get(providerId) ?? 0) > 0;
  }

  // 合并启动、配置变化和定时扫描，不并发执行扫描。
  public wake(): void {
    if (this.controller.signal.aborted) return;
    this.shouldScan = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.scanTask) return;
    this.scanTask = this.scanLoop().finally(() => {
      this.scanTask = null;
      if (this.controller.signal.aborted) return;
      if (this.shouldScan) this.wake();
      else {
        this.timer = setTimeout(() => this.wake(), CHECK_INTERVAL_MS);
        this.timer.unref();
      }
    });
  }

  // 停止新工作并等待已取消的调用完成。
  public async close(): Promise<void> {
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    if (this.scanTask) await this.scanTask;
    if (this.drainTask) await this.drainTask;
    await Promise.all([...this.tasks]);
  }

  // 合并扫描期间收到的唤醒请求。
  private async scanLoop(): Promise<void> {
    while (this.shouldScan && !this.controller.signal.aborted) {
      this.shouldScan = false;
      try {
        await this.scan();
      } catch {
        if (!this.controller.signal.aborted) this.onError("scan", []);
      }
    }
  }

  // 扫描符合空闲条件的 Run，并将全部结果按顺序加入等待队列。
  private async scan(): Promise<void> {
    if (!this.prepareScan()) return;
    const model = this.dreaming.getModel();
    if (!model) return;
    try {
      await this.providers.resolveRunModel(model.providerId, model.modelId);
    } catch {
      return;
    }
    if (this.controller.signal.aborted) return;

    const batches = new Map<string, string[]>();
    for (const run of this.dreaming.listPendingConsolidation()) {
      if (this.activeWorkspaces.has(run.workspaceId)) continue;
      const batch = batches.get(run.workspaceId) ?? [];
      if (batch.length < 2) batch.push(run.runId);
      batches.set(run.workspaceId, batch);
    }
    for (const [workspaceId, runIds] of batches) {
      this.activeWorkspaces.add(workspaceId);
      this.track(
        "consolidation",
        runIds,
        model.providerId,
        () =>
          this.service.consolidateRuns({
            workspaceId,
            runIds,
            ...model,
            signal: this.controller.signal,
          }),
        () => this.activeWorkspaces.delete(workspaceId),
      );
    }

    const settings = this.memories.getSettings();
    if (!settings.useMemories || !settings.generateMemories) return;
    if (this.globalService && !this.isGlobalActive && this.globalService.hasPending()) {
      this.isGlobalActive = true;
      this.track(
        "global_consolidation",
        [],
        model.providerId,
        () =>
          this.globalService?.consolidate({ ...model, signal: this.controller.signal }) ??
          Promise.resolve(),
        () => {
          this.isGlobalActive = false;
        },
      );
    }
    const eligible = new Map<string, boolean>();
    for (const run of this.dreaming.listPendingRuns()) {
      if (this.controller.signal.aborted) return;
      if (this.queuedIds.has(run.runId) || this.activeSessions.has(run.sessionId)) continue;
      let canQueue = eligible.get(run.sessionId);
      if (canQueue === undefined) {
        canQueue = !(await this.isSessionActive(run.sessionId));
        if (canQueue) {
          const snapshot = await this.events.load(run.sessionId, this.controller.signal);
          const lastEvent = snapshot.events.at(-1);
          canQueue =
            !!lastEvent &&
            Date.now() - lastEvent.timestamp >= IDLE_MS &&
            !(await this.isSessionActive(run.sessionId));
        }
        eligible.set(run.sessionId, canQueue);
      }
      if (canQueue) {
        this.queue.push(run);
        this.queuedIds.add(run.runId);
      }
    }
    this.drain();
  }

  // 顺序取队列任务，启动前复查会话活动、记忆开关与持久化状态。
  private drain(): void {
    if (this.controller.signal.aborted) return;
    if (this.drainTask) {
      this.drainRequested = true;
      return;
    }
    this.drainRequested = false;
    this.drainTask = this.drainQueue()
      .catch(() => {
        if (!this.controller.signal.aborted) this.onError("scan", []);
      })
      .finally(() => {
        this.drainTask = null;
        if (this.drainRequested) this.drain();
      });
  }

  // 名额不足时保留剩余队列，不符合条件的任务留待下次扫描。
  private async drainQueue(): Promise<void> {
    while (
      this.queue.length &&
      this.activeSessions.size < ANALYSIS_LIMIT &&
      !this.controller.signal.aborted
    ) {
      if (!this.prepareScan()) return;
      const run = this.queue.shift();
      if (!run) break;
      this.queuedIds.delete(run.runId);
      const settings = this.memories.getSettings();
      if (
        !settings.useMemories ||
        !settings.generateMemories ||
        this.activeSessions.has(run.sessionId)
      )
        continue;
      if (await this.isSessionActive(run.sessionId)) continue;
      // 排队期间会话可能再次完成 Run，必须重新计算空闲时间。
      const snapshot = await this.events.load(run.sessionId, this.controller.signal);
      const lastEvent = snapshot.events.at(-1);
      if (
        !lastEvent ||
        Date.now() - lastEvent.timestamp < IDLE_MS ||
        (await this.isSessionActive(run.sessionId))
      )
        continue;
      const current = this.memories.getSettings();
      const model = this.dreaming.getModel();
      if (
        !current.useMemories ||
        !current.generateMemories ||
        !model ||
        this.controller.signal.aborted ||
        this.dreaming.findRun(run.runId)?.status !== DreamingRunStatus.PENDING
      )
        continue;
      this.activeSessions.add(run.sessionId);
      this.track(
        "analysis",
        [run.runId],
        model.providerId,
        () =>
          this.service.analyzeRun({
            workspaceId: run.workspaceId,
            sessionId: run.sessionId,
            runId: run.runId,
            ...model,
            signal: this.controller.signal,
          }),
        () => this.activeSessions.delete(run.sessionId),
      );
    }
  }

  // 任务完成后只释放名额并消费现有队列，不触发新的扫描。
  private track(
    phase: "analysis" | "consolidation" | "global_consolidation",
    ids: string[],
    providerId: string,
    work: () => Promise<void>,
    release: () => void,
  ): void {
    this.activeProviders.set(providerId, (this.activeProviders.get(providerId) ?? 0) + 1);
    this.onProviderActivity(providerId, true);
    const task = work()
      .catch(() => {
        if (!this.controller.signal.aborted) this.onError(phase, ids);
      })
      .finally(() => {
        release();
        const remaining = (this.activeProviders.get(providerId) ?? 1) - 1;
        if (remaining === 0) {
          this.activeProviders.delete(providerId);
          this.onProviderActivity(providerId, false);
        } else this.activeProviders.set(providerId, remaining);
        this.tasks.delete(task);
        if (phase === "analysis") this.drain();
      });
    this.tasks.add(task);
  }
}
