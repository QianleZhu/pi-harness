import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute } from "node:path";
import {
  parseWindowsBinShell,
  SandboxManager,
  SandboxRuntimeConfigSchema,
} from "@anthropic-ai/sandbox-runtime";
import { getOneMessage, sendMessage } from "execa";

/**
 * @typedef {{
 *   args?: string[],
 *   command: string,
 *   commandId: string,
 *   config: unknown,
 *   credentials: unknown[],
 *   environment?: Record<string, string>,
 *   mode: "command" | "process",
 *   type: "start"
 * }} SandboxWorkerInput
 */

/** @param {readonly string[]} values */
const quote = (values) =>
  values.map((value) => (value === "" ? "''" : `'${value.replaceAll("'", `'"'"'`)}'`)).join(" ");

const isWindows = process.platform === "win32";
const stopController = new AbortController();
/** @type {import("node:child_process").ChildProcess | undefined} */
let child;
/** @type {string | undefined} */
let temporaryRoot;

/** 结束 Windows broker，由原生 Job Object 回收目标进程树。 */
function stopWindowsProcess() {
  stopController.abort();
  child?.kill("SIGKILL");
}

if (isWindows) {
  process.once("disconnect", stopWindowsProcess);
  process.on("message", (message) => {
    if (message && typeof message === "object" && "type" in message && message.type === "stop") {
      stopWindowsProcess();
    }
  });
  // daemon 被关闭时，标准流也可能在 IPC 断开前先关闭。
  process.stdout.on("error", stopWindowsProcess);
  process.stderr.on("error", stopWindowsProcess);
}

// 配置通过父进程管道传入，不读取 workspace 或用户的 SRT 配置。
let stage = "input";
try {
  /** @type {unknown} */
  const input = await getOneMessage();
  if (
    typeof input !== "object" ||
    input === null ||
    !("type" in input) ||
    input.type !== "start" ||
    !("command" in input) ||
    typeof input.command !== "string" ||
    !input.command ||
    !("commandId" in input) ||
    typeof input.commandId !== "string" ||
    !input.commandId ||
    !("config" in input) ||
    !("credentials" in input) ||
    !Array.isArray(input.credentials) ||
    !("mode" in input) ||
    (input.mode !== "command" && input.mode !== "process") ||
    (input.mode === "process" &&
      (!("args" in input) ||
        !Array.isArray(input.args) ||
        !input.args.every((value) => typeof value === "string" && !value.includes("\0")) ||
        !("environment" in input) ||
        typeof input.environment !== "object" ||
        input.environment === null ||
        !Object.entries(input.environment).every(
          ([name, value]) =>
            /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) &&
            typeof value === "string" &&
            !value.includes("\0"),
        )))
  ) {
    throw new Error("沙箱输入无效");
  }
  const sandboxInput = /** @type {SandboxWorkerInput} */ (input);
  if (isWindows) temporaryRoot = process.env.TEMP;
  const config = SandboxRuntimeConfigSchema.parse(sandboxInput.config);
  if (sandboxInput.mode === "process" && !isWindows) {
    for (const [name, value] of Object.entries(sandboxInput.environment ?? {}))
      process.env[name] = value;
  }
  for (const credential of sandboxInput.credentials) {
    if (
      typeof credential !== "object" ||
      credential === null ||
      !("name" in credential) ||
      typeof credential.name !== "string" ||
      !("value" in credential) ||
      typeof credential.value !== "string"
    ) {
      throw new Error("沙箱凭据配置无效");
    }
  }
  const credentials = /** @type {{name: string, value: string}[]} */ (sandboxInput.credentials);
  for (const credential of credentials) {
    process.env[credential.name] = credential.value;
  }
  stage = "initialization";
  if (isWindows) {
    // 读取授权绑定到同一个本地用户，直到 SRT 撤回授权前为当前 worker 独占。
    const windowsLease = createServer((socket) => socket.destroy());
    windowsLease.listen(String.raw`\\.\pipe\pi-harness-srt-windows`);
    await once(windowsLease, "listening");
    stopController.signal.throwIfAborted();
    if (sandboxInput.environment?.PATH !== undefined) {
      process.env.PATH = sandboxInput.environment.PATH;
    }
  }
  /** @param {{host: string, port: number | undefined}} request */
  const askNetwork = async ({ host, port }) => {
    const requestId = randomUUID();
    await sendMessage({ host, port, requestId, type: "network-approval" });
    const response = await getOneMessage({
      filter: (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "network-approval-result" &&
        "requestId" in message &&
        message.requestId === requestId,
    });
    return (
      typeof response === "object" &&
      response !== null &&
      "allowed" in response &&
      response.allowed === true
    );
  };
  await SandboxManager.initialize(config, askNetwork, true);
  stopController.signal.throwIfAborted();
  stage = "configuration";
  // Windows 直接传入程序与参数，保留 cmd.exe 的整段命令参数。
  const isWindowsProcess = isWindows && sandboxInput.mode === "process";
  const args = sandboxInput.args ?? [];
  const windowsExecutable = isWindowsProcess
    ? isAbsolute(sandboxInput.command)
      ? sandboxInput.command
      : sandboxInput.command.toLowerCase() === "cmd.exe"
        ? parseWindowsBinShell("cmd").exe
        : undefined
    : undefined;
  if (isWindowsProcess && !windowsExecutable) throw new Error("Windows 沙箱需要绝对程序路径");
  const command = isWindowsProcess
    ? (args.at(-1) ?? "")
    : sandboxInput.mode === "process"
      ? quote([sandboxInput.command, ...(sandboxInput.args ?? [])])
      : sandboxInput.command;
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
    command,
    windowsExecutable ? { exe: windowsExecutable, args: args.slice(0, -1) } : undefined,
    undefined,
    isWindows ? stopController.signal : undefined,
    process.cwd(),
    { commandId: sandboxInput.commandId, commandText: sandboxInput.command },
  );
  // SRT 已把真实值保存在宿主代理的哨兵注册表中；启动目标前清除 worker 与外层 runner 环境副本。
  for (const credential of credentials) {
    delete process.env[credential.name];
    delete env[credential.name];
  }
  const executable = argv[0];
  if (executable === undefined) throw new Error("沙箱未返回可执行命令");
  // 此版本 SRT 总会附加一个命令参数。无参数的程序只保留可执行文件。
  if (isWindowsProcess && args.length === 0) argv.pop();
  stopController.signal.throwIfAborted();
  stage = "execution";
  child = spawn(executable, argv.slice(1), {
    cwd: process.cwd(),
    env,
    shell: false,
    windowsHide: true,
    stdio:
      sandboxInput.mode === "process"
        ? [isWindows ? "ignore" : "pipe", "pipe", "pipe"]
        : ["ignore", "inherit", "inherit"],
  });
  // 先监听退出，确保快速返回的进程也能到达清理阶段。
  const exited = once(child, isWindows ? "close" : "exit");
  void exited.catch(() => undefined);
  await once(child, "spawn");
  if (sandboxInput.mode === "process") {
    if (child.stdout === null || child.stderr === null || (!isWindows && child.stdin === null)) {
      throw new Error("沙箱进程管道不可用");
    }
    if (child.stdin) process.stdin.pipe(child.stdin);
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
  }
  if (process.connected) await sendMessage({ pid: child.pid, type: "sandbox-process" });
  const [exitCode] = await exited;
  process.exitCode = exitCode ?? 1;
  if (process.connected) {
    await sendMessage({
      lines: SandboxManager.getSandboxViolationStore()
        .getViolationsForCommand(sandboxInput.commandId)
        .map(({ line }) => line),
      type: "violations",
    });
  }
} catch (error) {
  const code =
    stage === "input"
      ? "SANDBOX_INPUT_INVALID"
      : stage === "initialization"
        ? "SANDBOX_INITIALIZATION_FAILED"
        : stage === "configuration"
          ? "SANDBOX_CONFIGURATION_FAILED"
          : "SANDBOX_COMMAND_START_FAILED";
  const causeCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z0-9_]+$/i.test(error.code)
      ? ` (${error.code})`
      : "";
  const message =
    causeCode === " (EADDRINUSE)"
      ? "已有 Windows 沙箱命令正在运行。"
      : [" (not_provisioned)", " (reinstall_required)"].includes(causeCode)
        ? "请运行项目文档中的 Windows SRT 安装命令。"
        : `沙箱在 ${stage} 阶段失败。`;
  process.stderr.write(`${code}${causeCode}: ${message}\n`);
  process.exitCode = 1;
} finally {
  try {
    await SandboxManager.reset();
  } catch {
    process.stderr.write("SANDBOX_CLEANUP_FAILED: 沙箱资源清理失败。\n");
    process.exitCode = 1;
  }
  if (temporaryRoot) {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
      () => process.stderr.write("SANDBOX_CLEANUP_FAILED: 无法移除 Windows 沙箱临时目录。\n"),
    );
  }
}
// 后台命令可能持有 stdout；父进程在收到 worker 退出后清理整个进程组。
process.exit(process.exitCode ?? 1);
