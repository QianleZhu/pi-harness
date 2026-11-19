import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  getWslVersion,
  type SandboxRuntimeConfig,
  VENDORED_SRT_WIN_EXE,
} from "@anthropic-ai/sandbox-runtime";
import { getApplySeccompBinaryPath } from "@anthropic-ai/sandbox-runtime/dist/sandbox/generate-seccomp-filter.js";
import { isPathWithin, resolveWorkspacePath, type SandboxCredential } from "@pi-harness/policy";
import { execa } from "execa";

interface SandboxBoundaryInput {
  workspaceRoot: string;
  protectedPaths: readonly string[];
  allowedDomains: readonly string[];
  deniedDomains?: readonly string[];
  credentials?: readonly SandboxCredentialInput[];
  isWorkspaceWritable?: boolean;
  readPaths?: readonly string[];
  onNetworkApproval?: (request: { host: string; port?: number }) => Promise<boolean>;
}

interface SandboxCredentialInput {
  injectHosts?: readonly string[];
  name: string;
  value: string;
}

export interface SandboxCommandInput {
  commandId: string;
  command: string;
  workspaceRoot: string;
  protectedPaths: readonly string[];
  allowedDomains: readonly string[];
  deniedDomains?: readonly string[];
  credentials?: readonly SandboxCredential[];
  isWorkspaceWritable?: boolean;
  onNetworkApproval?: (request: { host: string; port?: number }) => Promise<boolean>;
  readPaths?: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  onOutput: (chunk: string) => void;
}

export interface SandboxProcessInput extends SandboxBoundaryInput {
  commandId: string;
  command: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface SandboxedProcess {
  process: ChildProcessWithoutNullStreams;
  close(): Promise<void>;
  getViolations?(): readonly string[];
}

const ENVIRONMENT_NAMES = ["LANG", "LC_ALL", "PATH", "TERM"] as const;
const WINDOWS_WORKER_ENVIRONMENT_NAMES = [
  "LOCALAPPDATA",
  "PATHEXT",
  "ProgramData",
  "SystemRoot",
  "USERPROFILE",
] as const;

/** 在 WSL 中找出 Windows 文件系统的实际挂载路径。 */
async function readWindowsMounts(): Promise<string[]> {
  if (!getWslVersion()) return [];
  const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
  return mountInfo.split("\n").flatMap((line) => {
    const [mount, filesystem] = line.split(" - ");
    const mountPath = mount?.split(" ")[4];
    if (!mountPath || !filesystem) return [];
    if (!filesystem.startsWith("drvfs ") && !filesystem.includes("aname=drvfs;")) return [];
    // mountinfo 使用八进制转义表示挂载路径中的空格、制表符、换行和反斜杠。
    return [
      mountPath.replace(/\\([0-7]{3})/g, (_, code: string) =>
        String.fromCharCode(Number.parseInt(code, 8)),
      ),
    ];
  });
}

/**
 * 作用：
 * 1、解析并固定真实 workspaceRoot
 * 2、生成文件系统规则：- 允许读取 workspace、临时目录、Node 运行目录和额外资源。
    - 拒绝读取真实 HOME、workspace 同级目录和 daemon 私有目录。
    - read_only 只允许写临时目录。
    - workspace_write 额外允许写 workspace。
 * 3、生成网络 allow/deny 规则
 * 4、配置 SRT 凭据代理。
 * 5、只继承 PATH、语言和终端等少量环境变量。
 * 6、把 HOME、TMPDIR 指向临时目录。
 */
async function prepareSandbox(input: SandboxBoundaryInput) {
  const isWindows = process.platform === "win32";
  const isWorkspaceWritable = input.isWorkspaceWritable !== false;
  // 受保护路径相对于 daemon 的 cwd 解析，worker 会在 workspace 中启动。
  const protectedPaths = input.protectedPaths.map((path) => resolve(path));
  const windowsMounts = await readWindowsMounts();
  const workspaceRoot = await resolveWorkspacePath({
    workspaceRoot: input.workspaceRoot,
    path: ".",
    protectedPaths,
  });
  // WSL 的 Windows 盘符在 Linux HOME 之外，隔离工具从 Linux 文件系统运行。
  if (windowsMounts.some((root) => isPathWithin(root, workspaceRoot))) {
    throw new Error("SANDBOX_WORKSPACE_UNAVAILABLE: WSL 沙箱需要 Linux 文件系统中的工作区");
  }
  // Linux 的 seccomp helper 在 Bubblewrap 内启动，安装目录可能位于被遮蔽的 HOME。
  const seccompPath = process.platform === "linux" ? getApplySeccompBinaryPath() : null;
  if (seccompPath && windowsMounts.some((root) => isPathWithin(root, seccompPath))) {
    throw new Error("SANDBOX_RUNTIME_UNAVAILABLE: WSL 沙箱需要 Linux 文件系统中的项目依赖");
  }
  const readPaths = [dirname(process.execPath), ...(input.readPaths ?? [])].filter(
    (path) => !windowsMounts.some((root) => isPathWithin(root, path)),
  );
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-harness-sandbox-"));
  // SRT 的 allow 不接受全局 `*`；空 allow 由 ask callback 放行，凭据目标仍需进入配置完成 SRT 校验。
  const allowedDomains =
    input.allowedDomains.length === 0
      ? [...new Set((input.credentials ?? []).flatMap(({ injectHosts }) => injectHosts ?? []))]
      : [...input.allowedDomains];
  const config: SandboxRuntimeConfig = {
    network: {
      allowedDomains,
      deniedDomains: [...(input.deniedDomains ?? [])],
      deniedDomainReasons: Object.fromEntries(
        (input.deniedDomains ?? []).map((entry) => [entry, `PI Harness deny rule: ${entry}`]),
      ),
      ...((input.credentials?.length ?? 0) > 0 ? { tlsTerminate: {} } : {}),
    },
    filesystem: {
      // Windows 使用专用账户的 NTFS 访问权限作为读取基线，避免向整块盘或用户目录写 ACL。
      denyRead: [
        ...(isWindows ? [] : [homedir(), dirname(workspaceRoot)]),
        ...protectedPaths,
        ...windowsMounts,
      ],
      allowRead: [
        // Windows 写授权已包含读取权限，避免每次对同一个目录重复添加和撤销读取 ACL。
        ...(isWindows && isWorkspaceWritable ? [] : [workspaceRoot]),
        ...(isWindows ? [] : [temporaryRoot]),
        ...readPaths,
        ...(seccompPath ? [seccompPath] : []),
      ],
      // Windows 目标进程使用 SRT 专用账户自己的临时目录。
      allowWrite: [
        ...(isWorkspaceWritable ? [workspaceRoot] : []),
        ...(isWindows ? [] : [temporaryRoot]),
      ],
      denyWrite: [
        ...protectedPaths,
        ...windowsMounts,
        ...(seccompPath ? [seccompPath] : []),
        // pnpm 安装的可执行文件可能是硬链接，SRT 以目录 ACL 保护该 helper。
        ...(isWindows ? [dirname(VENDORED_SRT_WIN_EXE)] : []),
      ],
    },
    ...((input.credentials?.length ?? 0) > 0
      ? {
          credentials: {
            envVars: input.credentials?.map(({ injectHosts, name }) => ({
              ...(injectHosts === undefined ? {} : { injectHosts: [...injectHosts] }),
              mode: "mask" as const,
              name,
            })),
          },
        }
      : {}),
    ...(isWindows ? { windows: { srtWin: { path: VENDORED_SRT_WIN_EXE } } } : {}),
  };
  return {
    config,
    environment: {
      ...Object.fromEntries(
        [...ENVIRONMENT_NAMES, ...(isWindows ? WINDOWS_WORKER_ENVIRONMENT_NAMES : [])].flatMap(
          (name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]]),
        ),
      ),
      HOME: temporaryRoot,
      TMPDIR: temporaryRoot,
      TEMP: temporaryRoot,
      TMP: temporaryRoot,
      CLAUDE_CODE_TMPDIR: temporaryRoot,
    },
    temporaryRoot,
    workspaceRoot,
  };
}

/** 独立进程持有 SRT 的全局管理器，避免并发 workspace 串用文件权限和网络代理。 */
export async function runSandboxedCommand(input: SandboxCommandInput) {
  input.signal?.throwIfAborted();
  if (process.platform === "win32") {
    throw new Error("SANDBOX_PLATFORM_UNAVAILABLE: Windows 使用受监管的沙箱命令入口");
  }
  const { config, environment, temporaryRoot, workspaceRoot } = await prepareSandbox(input);
  try {
    const subprocess = execa(
      process.execPath,
      [fileURLToPath(new URL("./sandbox-worker.mjs", import.meta.url))],
      {
        cwd: workspaceRoot,
        detached: true,
        env: environment,
        extendEnv: false,
        ipcInput: {
          command: input.command,
          commandId: input.commandId,
          config,
          credentials: input.credentials ?? [],
          mode: "command",
          type: "start",
        },
        ipc: true,
        all: true,
        maxBuffer: input.maxOutputBytes,
        reject: false,
        timeout: input.timeoutMs,
        killSignal: "SIGKILL",
        ...(input.signal === undefined ? {} : { cancelSignal: input.signal }),
      },
    );
    let hasStoppedGroup = false;
    let hasCleanupError = false;
    let violations: string[] = [];
    // 正常退出也清理后台子进程；进程组信号不依赖 Shell 是否主动转发。
    const stopGroup = () => {
      if (subprocess.pid === undefined || hasStoppedGroup) return;
      hasStoppedGroup = true;
      try {
        process.kill(-subprocess.pid, "SIGKILL");
      } catch (error: unknown) {
        hasCleanupError = !(error instanceof Error && "code" in error && error.code === "ESRCH");
      }
    };
    subprocess.all?.on("data", (chunk: Buffer | string) => {
      input.onOutput(chunk.toString());
    });
    const ipcTask = (async () => {
      for await (const message of subprocess.getEachMessage()) {
        if (typeof message !== "object" || message === null || !("type" in message)) continue;
        if (
          message.type === "network-approval" &&
          "requestId" in message &&
          typeof message.requestId === "string" &&
          "host" in message &&
          typeof message.host === "string"
        ) {
          const port =
            "port" in message && typeof message.port === "number" ? message.port : undefined;
          let allowed = input.allowedDomains.length === 0;
          try {
            if (!allowed) {
              allowed =
                (await input.onNetworkApproval?.({
                  host: message.host,
                  ...(port === undefined ? {} : { port }),
                })) ?? false;
            }
          } finally {
            await subprocess.sendMessage({
              allowed,
              requestId: message.requestId,
              type: "network-approval-result",
            });
          }
        }
        if (message.type === "violations" && "lines" in message && Array.isArray(message.lines)) {
          violations = message.lines.filter((line): line is string => typeof line === "string");
        }
      }
    })();
    process.once("exit", stopGroup);
    subprocess.once("exit", stopGroup);
    const result = await subprocess.finally(() => {
      process.removeListener("exit", stopGroup);
      stopGroup();
    });
    await ipcTask;
    if (hasCleanupError) throw new Error("SANDBOX_CLEANUP_FAILED: 无法终止沙箱进程组");
    return {
      ...result,
      violations,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/** 长驻进程与一次性命令使用同一 SRT worker 边界，stdio 只作为协议管道转发。 */
export async function spawnSandboxedProcess(input: SandboxProcessInput): Promise<SandboxedProcess> {
  input.signal?.throwIfAborted();
  const isWindows = process.platform === "win32";
  const { config, environment, temporaryRoot, workspaceRoot } = await prepareSandbox(input);
  const subprocess = spawn(
    process.execPath,
    [fileURLToPath(new URL("./sandbox-worker.mjs", import.meta.url))],
    {
      cwd: workspaceRoot,
      detached: true,
      env: environment,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  if (subprocess.stdin === null || subprocess.stdout === null || subprocess.stderr === null) {
    subprocess.kill("SIGKILL");
    await rm(temporaryRoot, { recursive: true, force: true });
    throw new Error("SANDBOX_PROCESS_START_FAILED: 沙箱 worker 管道不可用");
  }
  const sandboxWorker = subprocess as ChildProcessWithoutNullStreams;
  let violations: string[] = [];
  let closing: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  const exited = new Promise<void>((resolve) => subprocess.once("exit", () => resolve()));
  const removeTemporaryRoot = () =>
    (cleanup ??= rm(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    }));
  /** 通过 IPC 发送启动参数、联网审批结果和停止请求。 */
  const send = (message: object) =>
    new Promise<void>((resolve, reject) => {
      subprocess.send(message, (error) => (error ? reject(error) : resolve()));
    });
  /** Windows worker 需要继续存活以便关闭 broker 并撤回 NTFS 授权。 */
  const stopWindowsWorker = () => {
    if (!subprocess.connected || subprocess.exitCode !== null || subprocess.signalCode !== null)
      return;
    void send({ type: "stop" }).catch(() => {
      if (subprocess.connected) subprocess.disconnect();
    });
  };
  const signalGroup = (signal: NodeJS.Signals) => {
    if (subprocess.pid === undefined) return;
    try {
      process.kill(-subprocess.pid, signal);
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };
  const close = () =>
    (closing ??= (async () => {
      try {
        if (
          subprocess.pid !== undefined &&
          subprocess.exitCode === null &&
          subprocess.signalCode === null
        ) {
          sandboxWorker.stdin.end();
          if (isWindows) {
            stopWindowsWorker();
            await Promise.race([
              exited,
              delay(15_000, undefined, { ref: false }).then(() => {
                throw new Error("SANDBOX_CLEANUP_FAILED: Windows 沙箱进程未在期限内退出");
              }),
            ]);
          } else {
            await Promise.race([exited, delay(250)]);
          }
          if (!isWindows && subprocess.exitCode === null && subprocess.signalCode === null) {
            signalGroup("SIGTERM");
            await Promise.race([exited, delay(500)]);
            if (subprocess.exitCode === null && subprocess.signalCode === null) {
              signalGroup("SIGKILL");
              await Promise.race([
                exited,
                delay(1_500).then(() => {
                  throw new Error("SANDBOX_CLEANUP_FAILED: 沙箱进程未在期限内退出");
                }),
              ]);
            }
          }
        }
      } finally {
        sandboxWorker.stdin.destroy();
        sandboxWorker.stdout.destroy();
        sandboxWorker.stderr.destroy();
        if (
          !isWindows ||
          subprocess.pid === undefined ||
          subprocess.exitCode !== null ||
          subprocess.signalCode !== null
        ) {
          await removeTemporaryRoot();
        }
      }
    })());
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let startupError = "";
  const captureStartupError = (chunk: Buffer) => {
    startupError = `${startupError}${chunk.toString()}`.slice(0, 512);
  };
  sandboxWorker.stderr.on("data", captureStartupError);
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // worker 可能在发送启动参数完成前退出，仍由下面的 await 报告该错误。
  void ready.catch(() => undefined);
  subprocess.on("message", (message: unknown) => {
    if (typeof message !== "object" || message === null || !("type" in message)) return;
    if (message.type === "sandbox-process") {
      sandboxWorker.stderr.removeListener("data", captureStartupError);
      resolveReady?.();
      return;
    }
    if (message.type === "violations" && "lines" in message && Array.isArray(message.lines)) {
      violations = message.lines.filter((line): line is string => typeof line === "string");
      return;
    }
    if (
      message.type === "network-approval" &&
      "requestId" in message &&
      typeof message.requestId === "string" &&
      "host" in message &&
      typeof message.host === "string"
    ) {
      const host = message.host;
      const requestId = message.requestId;
      const port = "port" in message && typeof message.port === "number" ? message.port : undefined;
      void (async () => {
        const allowed =
          input.allowedDomains.length === 0 ||
          ((await input.onNetworkApproval?.({
            host,
            ...(port === undefined ? {} : { port }),
          })) ??
            false);
        await send({
          allowed,
          requestId,
          type: "network-approval-result",
        });
      })().catch(() => {
        if (isWindows) stopWindowsWorker();
        else signalGroup("SIGKILL");
      });
    }
  });
  subprocess.once("error", () =>
    rejectReady?.(new Error("SANDBOX_PROCESS_START_FAILED: 无法启动沙箱 worker")),
  );
  subprocess.once("exit", () =>
    rejectReady?.(
      new Error(
        startupError.trim() || "SANDBOX_PROCESS_START_FAILED: 沙箱 worker 在服务就绪前退出",
      ),
    ),
  );
  const abort = () => {
    if (isWindows) stopWindowsWorker();
    else signalGroup("SIGKILL");
    rejectReady?.(new Error("SANDBOX_PROCESS_ABORTED: 沙箱进程启动已取消"));
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    await send({
      args: [...input.args],
      command: input.command,
      commandId: input.commandId,
      config,
      credentials: input.credentials ?? [],
      environment: input.environment,
      mode: "process",
      type: "start",
    });
    // 路径校验期间也可能收到中止，启动消息发出后立即补发停止。
    if (input.signal?.aborted) abort();
    await ready;
    input.signal?.throwIfAborted();
    return {
      process: sandboxWorker,
      close,
      getViolations: () => violations,
    };
  } catch (error: unknown) {
    await close();
    input.signal?.throwIfAborted();
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", abort);
  }
}
