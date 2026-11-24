import type { MemoryService } from "@pi-harness/memory";
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
const WORKSPACE_LIMIT = 2;

// 周期扫描待处理 Run，一个工作区只启动一个带工具的整理 Agent。
export class DreamingScheduler {
  private readonly controller = new AbortController();
  private readonly activeWorkspaces = new Set<string>();
  private isGlobalActive = false;
  private readonly activeProviders = new Map<string, number>();
  private readonly tasks = new Set<Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scanTask: Promise<void> | null = null;
  private shouldScan = false;

  public constructor(
    private readonly dreaming: SqliteDreamingRepository,
    private readonly memories: MemoryService,
    private readonly events: SessionEventStore,
    private readonly providers: ProviderService,
    private readonly service: DreamingService,
    private readonly isSessionActive: (sessionId: string) => boolean | Promise<boolean>,
    private readonly onError: (
      phase: "scan" | "consolidation" | "global_consolidation",
      ids: readonly string[],
    ) => void,
    private readonly onProviderActivity: (providerId: string, active: boolean) => void = () => {},
    private readonly prepareScan: () => boolean = () => true,
    private readonly globalService?: GlobalDreamingService,
  ) {}

  // 判断是否存在正在运行的整理任务。
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
    await Promise.all([...this.tasks]);
  }

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

  // 扫描符合空闲条件的 Run，一个工作区收集全部待处理 Run 交给同一个 Agent。
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
    const settings = this.memories.getSettings();
    if (!settings.generateMemories) return;
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

    const eligibleSessions = new Map<string, boolean>();
    const batches = new Map<string, DreamingRunRecord[]>();
    for (const run of this.dreaming.listPendingRuns()) {
      if (this.controller.signal.aborted) return;
      if (this.activeWorkspaces.has(run.workspaceId)) continue;
      let eligible = eligibleSessions.get(run.sessionId);
      if (eligible === undefined) {
        eligible = await this.isIdle(run.sessionId);
        eligibleSessions.set(run.sessionId, eligible);
      }
      if (!eligible) continue;
      const batch = batches.get(run.workspaceId) ?? [];
      batch.push(run);
      batches.set(run.workspaceId, batch);
    }

    for (const [workspaceId, batch] of batches) {
      if (this.controller.signal.aborted) return;
      if (this.activeWorkspaces.size >= WORKSPACE_LIMIT) break;
      if (this.activeWorkspaces.has(workspaceId)) continue;
      const sessionIds = new Set(batch.map((run) => run.sessionId));
      let active = false;
      for (const sessionId of sessionIds) {
        if (await this.isSessionActive(sessionId)) {
          active = true;
          break;
        }
      }
      if (active) continue;
      this.activeWorkspaces.add(workspaceId);
      const runIds = batch.map((run) => run.runId);
      this.track(
        "consolidation",
        runIds,
        model.providerId,
        () =>
          this.service.processRuns({
            workspaceId,
            runIds,
            ...model,
            signal: this.controller.signal,
          }),
        () => this.activeWorkspaces.delete(workspaceId),
      );
    }
  }

  // 只有 Session 没有活动 Run 且最后事件已空闲时才允许启动。
  private async isIdle(sessionId: string): Promise<boolean> {
    if (await this.isSessionActive(sessionId)) return false;
    const snapshot = await this.events.load(sessionId, this.controller.signal);
    const lastEvent = snapshot.events.at(-1);
    if (!lastEvent || Date.now() - lastEvent.timestamp < IDLE_MS) return false;
    return !(await this.isSessionActive(sessionId));
  }

  // 任务完成后只释放名额，不立即触发新的扫描。
  private track(
    phase: "consolidation" | "global_consolidation",
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
      });
    this.tasks.add(task);
  }
}
