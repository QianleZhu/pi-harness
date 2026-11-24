import { HarnessEventType } from "@pi-harness/agent-runtime";
import { MemoryService } from "@pi-harness/memory";
import type { Credential, CredentialInfo, CredentialStore } from "@pi-harness/providers";
import { Value } from "typebox/value";
import { DreamingScheduler } from "../services/dreaming-scheduler.js";
import { DreamingService } from "../services/dreaming-service.js";
import {
  CredentialListSchema,
  CredentialSchema,
  ParentMessageSchema,
} from "../services/dreaming-worker-protocol.js";
import { GlobalDreamingService } from "../services/global-dreaming-service.js";
import { LocalMemoryEmbedder } from "../services/local-memory-embedder.js";
import { ProviderService } from "../services/provider-service.js";
import { type HarnessDatabase, openHarnessDatabase } from "../storage/database.js";
import { SessionEventStore } from "../storage/session-event-store.js";
import {
  cleanupDreamingContextDirectories,
  cleanupDreamingDirectories,
} from "../utils/dreaming-wiki.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  modify?: (current: Credential | undefined) => Promise<Credential | undefined>;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
};
const pending = new Map<number, Pending>();
let nextId = 0;
let scheduler: DreamingScheduler | null = null;
let providers: ProviderService | null = null;
let database: HarnessDatabase | null = null;
let closing = false;
let shouldRefreshProviders = false;

// 有后台任务时暂缓刷新，下一次检查在空闲后应用配置。
function refreshProvidersWhenIdle(): boolean {
  if (!shouldRefreshProviders) return true;
  if (scheduler?.isActive()) return false;
  providers?.refreshCustomProviders();
  shouldRefreshProviders = false;
  return true;
}

// 通过 IPC 发送受限消息，凭据不写入日志或命令行。
function send(message: object): void {
  if (!process.connected || !process.send) throw new Error("Dreaming parent unavailable");
  process.send(message, () => {});
}

// 等待主进程响应，并限制 IPC 等待时间。
function request(
  method: string,
  params: object = {},
  modify?: Pending["modify"],
  signal?: AbortSignal,
): Promise<unknown> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      pending.delete(id);
      clearTimeout(timer);
      cleanup();
      if (modify && process.connected) send({ type: "modify_result", id, ok: false });
      reject(signal?.reason ?? new Error("Dreaming IPC canceled"));
    };
    const timer = setTimeout(() => {
      pending.delete(id);
      cleanup();
      if (modify && process.connected) send({ type: "modify_result", id, ok: false });
      reject(new Error("Dreaming IPC timeout"));
    }, 60_000);
    signal?.addEventListener("abort", abort, { once: true });
    pending.set(id, { resolve, reject, timer, cleanup, ...(modify ? { modify } : {}) });
    try {
      send({ type: "request", id, method, ...params });
    } catch (error: unknown) {
      clearTimeout(timer);
      pending.delete(id);
      cleanup();
      reject(error);
    }
  });
}

// 只接受主进程返回的有效凭据数据。
function credential(value: unknown): Credential | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Value.Check(CredentialSchema, value)) throw new Error("Invalid credential response");
  return value as Credential;
}

// 模型使用 daemon 持有的凭据与串行更新队列。
const credentials: CredentialStore = {
  async read(providerId, options) {
    return credential(await request("credential_read", { providerId }, undefined, options?.signal));
  },
  async list(options) {
    const value = await request("credential_list", {}, undefined, options?.signal);
    if (!Value.Check(CredentialListSchema, value)) throw new Error("Invalid credential list");
    return value as CredentialInfo[];
  },
  async modify(providerId, fn, options) {
    return credential(await request("credential_modify", { providerId }, fn, options?.signal));
  },
  async delete(providerId, options) {
    await request("credential_delete", { providerId }, undefined, options?.signal);
  },
};

// 从主进程读取会话运行状态，错误时不启动分析。
async function isSessionActive(sessionId: string): Promise<boolean> {
  const value = await request("session_active", { sessionId });
  if (typeof value !== "boolean") throw new Error("Invalid session activity response");
  return value;
}

// 初始化 Worker 独立连接、恢复状态并启动后台调度。
async function start(paths: {
  databasePath: string;
  sessionsPath: string;
  globalRoot: string;
}): Promise<void> {
  database = openHarnessDatabase(paths.databasePath);
  const eventStore = new SessionEventStore(paths.sessionsPath, false);
  await eventStore.initialize();
  for (const run of database.dreaming.listWaitingRuns()) {
    const snapshot = await eventStore.load(run.sessionId);
    const terminal = snapshot.events.find(
      (event) =>
        event.runId === run.runId &&
        (event.type === HarnessEventType.RUN_COMPLETED ||
          event.type === HarnessEventType.RUN_FAILED ||
          event.type === HarnessEventType.RUN_ABORTED),
    );
    if (terminal) database.dreaming.recordRunEnd(run.runId, terminal.timestamp);
    else if (!(await isSessionActive(run.sessionId)))
      database.dreaming.skipWaitingRun(run.runId, Date.now());
  }
  database.dreaming.failInterrupted(Date.now());
  await cleanupDreamingDirectories(paths.globalRoot, database.dreaming);
  await cleanupDreamingContextDirectories(paths.globalRoot, database.dreaming);
  providers = await ProviderService.create(database.providerSettings, credentials);
  if (shouldRefreshProviders) {
    providers.refreshCustomProviders();
    shouldRefreshProviders = false;
  }
  const embedder = new LocalMemoryEmbedder(paths.globalRoot);
  const memories = new MemoryService(database.memories, embedder);
  const globalService = new GlobalDreamingService(
    database.dreaming,
    database.sessions,
    providers,
    embedder,
  );
  const service = new DreamingService(
    paths.globalRoot,
    database.sessions,
    eventStore,
    providers,
    memories,
    database.memories,
    database.dreaming,
    embedder,
    globalService,
  );
  scheduler = new DreamingScheduler(
    database.dreaming,
    memories,
    database.sessions,
    eventStore,
    providers,
    service,
    isSessionActive,
    (phase, runIds) => send({ type: "failure", phase, runIds }),
    (providerId, active) => send({ type: "activity", providerId, active }),
    refreshProvidersWhenIdle,
    globalService,
  );
  scheduler.wake();
  send({ type: "ready" });
}

// 停止调度后关闭 Worker 独占连接。
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await scheduler?.close();
  await providers?.close();
  database?.close();
  if (process.connected) process.disconnect();
}

// 处理 daemon 的控制消息和凭据事务回调。
process.on("message", (message: unknown) => {
  if (!Value.Check(ParentMessageSchema, message)) return;
  if (message.type === "init") {
    void start(message).catch(() => {
      process.exitCode = 1;
      if (process.connected) process.disconnect();
    });
  } else if (message.type === "providers_changed") {
    shouldRefreshProviders = true;
    if (providers && refreshProvidersWhenIdle()) scheduler?.wake();
  } else if (message.type === "shutdown")
    void shutdown().catch(() => {
      process.exitCode = 1;
      if (process.connected) process.disconnect();
    });
  else if (message.type === "response") {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    item.cleanup();
    if (message.ok) item.resolve(message.value);
    else item.reject(new Error("Dreaming IPC request failed"));
  } else if (message.type === "modify_current") {
    const item = pending.get(message.id);
    if (!item?.modify) return;
    void Promise.resolve()
      .then(() => item.modify?.(credential(message.value)))
      .then(
        (value) => send({ type: "modify_result", id: message.id, ok: true, value }),
        () => send({ type: "modify_result", id: message.id, ok: false }),
      )
      .catch(() => {
        process.exitCode = 1;
        if (process.connected) process.disconnect();
      });
  }
});
process.on("disconnect", () => {
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.cleanup();
    item.reject(new Error("Dreaming parent unavailable"));
  }
  pending.clear();
  void shutdown().catch(() => {
    process.exitCode = 1;
  });
});
