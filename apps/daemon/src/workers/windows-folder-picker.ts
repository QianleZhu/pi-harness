// 在独立进程的同一线程上运行 Win32 COM 文件夹选择器。
import { isAbsolute } from "node:path";
import koffi from "koffi";

const ole32 = koffi.load("ole32.dll");
const user32 = koffi.load("user32.dll");
const pointerSize = koffi.sizeof("void *");

// CoCreateInstance 使用 Windows 内存布局的 GUID。
const fileOpenDialogClass = Buffer.from("9c5a1cdc8ae8de4da5a160f82a20aef7", "hex");
const fileOpenDialogInterface = Buffer.from("88727cd5add46847be029d969532d960", "hex");
const COINIT_APARTMENTTHREADED = 0x2;
const CLSCTX_INPROC_SERVER = 0x1;
const FOS_NOCHANGEDIR = 0x8;
const FOS_PICKFOLDERS = 0x20;
const FOS_FORCEFILESYSTEM = 0x40;
const SIGDN_FILESYSPATH = 0x80058000;
const HRESULT_CANCELLED = 0x800704c7 | 0;
const EVENT_OBJECT_SHOW = 0x8002;
const GW_OWNER = 4;
const SWP_NOSIZE_NOMOVE = 0x3;
const WS_POPUP = 0x80000000;
const VK_MENU = 0x12;
const KEYEVENTF_KEYUP = 0x2;

const coInitialize = ole32.func("int32 __stdcall CoInitializeEx(void *, uint32)");
const coUninitialize = ole32.func("void __stdcall CoUninitialize()");
const coCreate = ole32.func(
  "int32 __stdcall CoCreateInstance(void *, void *, uint32, void *, void *)",
);
const coFree = ole32.func("void __stdcall CoTaskMemFree(void *)");
const createWindow = user32.func(
  "void * __stdcall CreateWindowExW(uint32, str16, str16, uint32, int, int, int, int, void *, void *, void *, void *)",
);
const destroyWindow = user32.func("bool __stdcall DestroyWindow(void *)");
const getWindow = user32.func("void * __stdcall GetWindow(void *, uint32)");
const activateWindow = user32.func("bool __stdcall SetForegroundWindow(void *)");
const setWindowPos = user32.func(
  "bool __stdcall SetWindowPos(void *, intptr, int, int, int, int, uint32)",
);
const keyEvent = user32.func("void __stdcall keybd_event(uint8, uint8, uint32, uintptr)");
const showEvent = koffi.proto(
  "void __stdcall FolderShowEvent(void *, uint32, void *, int32, int32, uint32, uint32)",
);
const setEventHook = user32.func(
  "void * __stdcall SetWinEventHook(uint32, uint32, void *, FolderShowEvent *, uint32, uint32, uint32)",
);
const unhookEvent = user32.func("bool __stdcall UnhookWinEvent(void *)");

const release = koffi.proto("uint32 __stdcall FolderRelease(void *)");
const show = koffi.proto("int32 __stdcall FolderShow(void *, void *)");
const setOptions = koffi.proto("int32 __stdcall FolderSetOptions(void *, uint32)");
const setTitle = koffi.proto("int32 __stdcall FolderSetTitle(void *, str16)");
const getResult = koffi.proto("int32 __stdcall FolderGetResult(void *, void *)");
const getDisplayName = koffi.proto("int32 __stdcall FolderGetDisplayName(void *, uint32, void *)");

// 按 Windows COM 虚表槽位调用方法，偏移随进程指针宽度变化。
function invoke(
  object: bigint,
  slot: number,
  signature: ReturnType<typeof koffi.proto>,
  ...args: unknown[]
): number {
  const vtable = koffi.decode(object, "void *");
  const target = koffi.decode(vtable, slot * pointerSize, "void *");
  return koffi.call(target, signature, object, ...args) as number;
}

// HRESULT 的符号位表示失败，S_FALSE 等非零成功值仍需正常清理。
function checkResult(result: number, operation: string): void {
  if (result < 0) throw new Error(`${operation}: 0x${(result >>> 0).toString(16)}`);
}

// 在系统的模态消息循环中处理窗口显示事件，避免后台 daemon 打开的窗口被盖住。
function showDialog(dialog: bigint): number {
  const owner = createWindow(0, "STATIC", null, WS_POPUP, 0, 0, 0, 0, null, null, null, null);
  if (!owner) throw new Error("CreateWindowExW failed");

  try {
    // 隐藏所属窗口可避免任务栏图标，只处理此选择器进程中归它所有的窗口。
    const callback = koffi.register(
      (_hook: bigint, _event: number, window: bigint | null, objectId: number, childId: number) => {
        if (!window || objectId !== 0 || childId !== 0 || getWindow(window, GW_OWNER) !== owner)
          return;
        // Windows 可以拒绝前台激活，这时仍让选择器显示在普通窗口上方。
        if (!activateWindow(window)) setWindowPos(window, -1, 0, 0, 0, 0, SWP_NOSIZE_NOMOVE);
      },
      koffi.pointer(showEvent),
    );
    try {
      const hook = setEventHook(
        EVENT_OBJECT_SHOW,
        EVENT_OBJECT_SHOW,
        null,
        callback,
        process.pid,
        0,
        0,
      );
      if (!hook) throw new Error("SetWinEventHook failed");
      try {
        // 和 DeepSeek Harness 一样，在 Show 前用一次完整的 Alt 按键争取前台激活。
        keyEvent(VK_MENU, 0, 0, 0);
        keyEvent(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
        return invoke(dialog, 3, show, owner);
      } finally {
        unhookEvent(hook);
      }
    } finally {
      koffi.unregister(callback);
    }
  } finally {
    destroyWindow(owner);
  }
}

// 取回 Shell 分配的绝对路径，并释放字符串、Shell 项和对话框各自的资源。
function pickFolder(): string | null {
  checkResult(coInitialize(null, COINIT_APARTMENTTHREADED), "CoInitializeEx");
  try {
    const dialogOut = Buffer.alloc(pointerSize);
    checkResult(
      coCreate(fileOpenDialogClass, null, CLSCTX_INPROC_SERVER, fileOpenDialogInterface, dialogOut),
      "CoCreateInstance",
    );
    const dialog: bigint = koffi.decode(dialogOut, "void *");
    try {
      checkResult(
        invoke(dialog, 9, setOptions, FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR),
        "SetOptions",
      );
      checkResult(invoke(dialog, 17, setTitle, "选择工作区目录"), "SetTitle");
      const result = showDialog(dialog);
      if (result === HRESULT_CANCELLED) return null;
      checkResult(result, "Show");

      const itemOut = Buffer.alloc(pointerSize);
      checkResult(invoke(dialog, 20, getResult, itemOut), "GetResult");
      const item: bigint = koffi.decode(itemOut, "void *");
      try {
        const nameOut = Buffer.alloc(pointerSize);
        checkResult(invoke(item, 5, getDisplayName, SIGDN_FILESYSPATH, nameOut), "GetDisplayName");
        try {
          const path: string = koffi.decode(nameOut, "str16");
          if (!isAbsolute(path)) throw new Error("Folder picker returned a non-absolute path");
          return path;
        } finally {
          coFree(koffi.decode(nameOut, "void *"));
        }
      } finally {
        invoke(item, 2, release);
      }
    } finally {
      invoke(dialog, 2, release);
    }
  } finally {
    coUninitialize();
  }
}

// 标准输出只传目录本身，取消时保持为空。
const path = pickFolder();
if (path !== null) process.stdout.write(path);
