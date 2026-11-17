import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Credential, CredentialStore } from "@pi-harness/providers";
import { Value } from "typebox/value";
import { CredentialSchema, WorkerMessageSchema } from "./dreaming-worker-protocol.js";

// 管理独立 Dreaming 进程并集中协调模型凭据。
export class DreamingWorkerHost {
  private child: ChildProcess | null = null;
  private readonly activeProviders = new Set<string>();
  private readonly pendingModifications = new Map<
    string,
    { resolve: (value: Credential | undefined) => void; reject: (error: Error) => void }
  >();
  private readonly modificationRequests = new Set<string>();
  private readonly canceledModifications = new Set<string>();
  private closing = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    private readonly paths: { databasePath: string; sessionsPath: string; globalRoot: string },
    private readonly credentials: CredentialStore,
    private readonly isSessionActive: (sessionId: string) => boolean,
    private readonly onFailure: (phase: string, runIds: readonly string[]) => void,
  ) {}

  // 启动 Worker，工作失败只影响后台任务。
  public start(): void {
    if (this.closing || this.child) return;
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const entry = fileURLToPath(
      new URL(`../workers/dreaming-worker.${extension}`, import.meta.url),
    );
    const child = spawn(process.execPath, ["--import", "tsx", entry], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    this.child = child;
    child.on("message", (message: unknown) => this.onMessage(child, message));
    child.on("error", () => this.onFailure("worker", []));
    // 管道断开时释放所有持锁的凭据操作，避免阻塞主进程后续更新。
    child.on("disconnect", () => {
      for (const [key, pending] of this.pendingModifications) {
        if (!key.startsWith(`${child.pid}:`)) continue;
        pending.reject(new Error("Dreaming worker disconnected"));
        this.pendingModifications.delete(key);
      }
    });
    child.on("close", () => {
      if (this.child !== child) return;
      this.child = null;
      this.activeProviders.clear();
      for (const pending of this.pendingModifications.values())
        pending.reject(new Error("Dreaming worker stopped"));
      this.pendingModifications.clear();
      if (!this.closing) {
        this.onFailure("worker", []);
        this.restartTimer = setTimeout(() => this.start(), 1000);
        this.restartTimer.unref();
      }
    });
    this.send(child, { type: "init", ...this.paths });
  }

  // 同步 Provider 定义和认证可用性。
  public providersChanged(): void {
    if (this.child) this.send(this.child, { type: "providers_changed" });
  }

  // 防止运行中的后台模型被同时修改。
  public isProviderActive(providerId: string): boolean {
    return this.activeProviders.has(providerId);
  }

  // 判断是否有 Dreaming 分析或整理任务正在执行。
  public isActive(): boolean {
    return this.activeProviders.size > 0;
  }

  // 通知 Worker 结束运行，超时后回收进程。
  public async close(): Promise<void> {
    this.closing = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    this.send(child, { type: "shutdown" });
    const timer = setTimeout(() => child.kill(), 5000);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("Dreaming worker did not stop")), 7000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (deadline) clearTimeout(deadline);
    }
  }

  // 处理 Worker 的活动状态和受限请求。
  private onMessage(child: ChildProcess, message: unknown): void {
    if (!Value.Check(WorkerMessageSchema, message)) return;
    if (message.type === "activity") {
      if (message.active) this.activeProviders.add(message.providerId);
      else this.activeProviders.delete(message.providerId);
      return;
    }
    if (message.type === "failure") {
      this.onFailure(message.phase, message.runIds);
      return;
    }
    if (message.type === "modify_result") {
      const key = `${child.pid}:${message.id}`;
      const pending = this.pendingModifications.get(key);
      if (!pending) {
        if (!message.ok && this.modificationRequests.has(key)) this.canceledModifications.add(key);
        return;
      }
      this.pendingModifications.delete(key);
      if (!message.ok) pending.reject(new Error("Dreaming credential update failed"));
      else if (message.value === undefined || message.value === null) pending.resolve(undefined);
      else if (Value.Check(CredentialSchema, message.value))
        pending.resolve(message.value as Credential);
      else pending.reject(new Error("Invalid Dreaming credential"));
      return;
    }
    if (message.type !== "request") return;
    void this.handleRequest(child, message).catch(() =>
      this.send(child, { type: "response", id: message.id, ok: false }),
    );
  }

  // 凭据修改在 daemon 的同一写队列中执行，回调期间保持锁定。
  private async handleRequest(
    child: ChildProcess,
    request: { id: number; method: string; providerId?: string; sessionId?: string },
  ): Promise<void> {
    let value: unknown;
    if (request.method === "session_active") {
      if (!request.sessionId) throw new Error("Session ID missing");
      value = this.isSessionActive(request.sessionId);
    } else if (request.method === "credential_list") {
      value = await this.credentials.list();
    } else {
      const providerId = request.providerId;
      if (!providerId) throw new Error("Provider ID missing");
      if (request.method === "credential_read") value = await this.credentials.read(providerId);
      else if (request.method === "credential_delete") await this.credentials.delete(providerId);
      else if (request.method === "credential_modify") {
        const key = `${child.pid}:${request.id}`;
        this.modificationRequests.add(key);
        try {
          value = await this.credentials.modify(
            providerId,
            (current) =>
              new Promise((resolve, reject) => {
                if (!child.connected || this.canceledModifications.has(key)) {
                  reject(new Error("Dreaming credential update canceled"));
                  return;
                }
                this.pendingModifications.set(key, { resolve, reject });
                this.send(child, { type: "modify_current", id: request.id, value: current });
              }),
          );
        } finally {
          this.modificationRequests.delete(key);
          this.canceledModifications.delete(key);
        }
      } else throw new Error("Unknown Dreaming request");
    }
    this.send(child, { type: "response", id: request.id, ok: true, value });
  }

  // IPC 断开后不再向已退出的进程发送消息。
  private send(child: ChildProcess, message: object): void {
    if (child.connected) child.send(message, () => {});
  }
}
