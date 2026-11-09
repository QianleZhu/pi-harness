# MCP 通信机制的演进

> **前言：** 学习 MCP（Model Context Protocol）时，我遇到了几个问题：MCP 为什么选择 JSON-RPC？既然 HTTP 已经能够实现客户端和服务端通信，为什么最初还需要 SSE？HTTP+SSE 存在什么问题？Streamable HTTP 又是如何解决这些问题的？最后，MCP 为什么还要向无状态架构演进？

## 一、MCP 的通信架构

在理解 JSON-RPC 之前，我们首先需要知道 MCP 的作用。

MCP（Model Context Protocol，模型上下文协议）是一种标准化协议，旨在让 AI 应用能够以统一方式连接外部工具和数据源。

例如，用户向 AI 提出一个问题：

**“帮我查询一下北京今天的天气。”**

AI 本身不一定具有实时获取天气信息的能力，因此需要调用外部工具。

整个过程可以理解为：

```text
用户
 │
 ▼
AI 应用
 │
 ▼
MCP Client
 │
 │ 发送工具调用请求
 ▼
MCP Server
 │
 │ 调用实际业务逻辑
 ▼
天气 API
 │
 │ 返回天气数据
 ▼
MCP Server
 │
 │ 返回工具执行结果
 ▼
MCP Client
 │
 ▼
AI 生成最终回答
```

这里需要区分三个角色：

- **MCP Host**：承载 AI 应用的宿主程序，例如 AI 聊天应用或 IDE。
- **MCP Client**：由 Host 管理，负责与 MCP Server 建立协议通信。
- **MCP Server**：对外提供工具（Tools）、资源（Resources）、提示词（Prompts）等能力。

理解这些角色之后，我们会发现：MCP 最核心的工作之一，就是让客户端能够调用服务端提供的功能。

那么问题来了：

**两个不同进程之间，应该如何描述一次函数调用？**

这就引出了 JSON-RPC。

---

## 二、为什么 MCP 使用 JSON-RPC？

### 2.1 什么是 JSON-RPC？

JSON-RPC 全称为 JSON Remote Procedure Call，即基于 JSON 的远程过程调用协议。

它允许客户端通过发送 JSON 消息，调用另一个进程中的方法。

假设服务端有一个加法函数：

```javascript
function add(a, b) {
  return a + b;
}
```

如果客户端和服务端运行在不同进程中，客户端就不能像调用本地函数一样直接执行：

```javascript
const result = add(10, 20);
```

因此，需要一种通信协议，将函数名称和参数发送给服务端。

JSON-RPC 就解决了这个问题。

客户端发送：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "add",
  "params": {
    "a": 10,
    "b": 20
  }
}
```

服务端执行函数，并返回：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": 30
}
```

JSON-RPC 2.0 主要包含以下字段：

| 字段        | 作用               |
| --------- | ---------------- |
| `jsonrpc` | 指定 JSON-RPC 协议版本 |
| `id`      | 请求标识，用于关联请求和响应   |
| `method`  | 要调用的远程方法         |
| `params`  | 方法参数             |
| `result`  | 调用成功时的返回结果       |
| `error`   | 调用失败时的错误信息       |

此外，JSON-RPC 还支持 Notification（通知）：当消息不包含 `id` 时，它是一条不要求响应的通知消息。

### 2.2 JSON-RPC 与 MCP 的关系

MCP 并不是直接使用 `add` 这样的业务函数名作为 RPC 方法，而是在 JSON-RPC 上定义了一系列标准操作。

例如：

```text
tools/list       获取服务端提供的工具列表
tools/call       调用指定工具

resources/list   获取资源列表
resources/read   读取指定资源

prompts/list     获取提示词列表
prompts/get      获取指定提示词
```

调用加法工具时，MCP 请求可以写成：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "add",
    "arguments": {
      "a": 10,
      "b": 20
    }
  }
}
```

服务端返回：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "30"
      }
    ]
  }
}
```

这里体现了两层不同的职责：

**JSON-RPC 负责定义远程调用消息的结构，MCP 则负责定义具体的方法及其业务语义。**

### 2.3 为什么选择 JSON-RPC？

主要有四个原因。

**第一，实现简单。** JSON-RPC 使用 JSON 描述方法、参数、结果和错误，几乎所有主流编程语言都能轻松处理。

**第二，跨语言。** 客户端可以使用 JavaScript，服务端可以使用 Java 或 Python，只要双方遵循相同的协议规范，就能够通信。

**第三，支持请求关联。** 通过 `id`，客户端能够识别不同请求对应的执行结果。

**第四，不依赖具体的传输方式。** JSON-RPC 只定义消息格式，不要求使用 HTTP、TCP 或其他特定传输机制。

也就是说，下面两种通信方式都可以承载 JSON-RPC：

```text
本地通信：
MCP Client ← stdio → MCP Server

远程通信：
MCP Client ← HTTP → MCP Server
```

因此，JSON-RPC 是 MCP 消息层的基础，而 HTTP、stdio 等才是负责实际数据传递的传输机制。

---

## 三、旧版 MCP 为什么使用 HTTP+SSE？

在 2024-11-05 版本中，MCP 的远程通信采用 HTTP+SSE。

要理解它，首先需要知道 SSE 是什么。

### 3.1 什么是 SSE？

SSE 全称 Server-Sent Events，即服务器发送事件。

它是一种基于 HTTP 的服务端向客户端持续推送消息的机制。

普通 HTTP 请求通常是：

```text
Client                   Server
  |                        |
  |------ HTTP 请求 ------>|
  |                        |
  |<----- HTTP 响应 -------|
  |                        |
  |      本次响应结束       |
```

而 SSE 可以让服务端保持 HTTP 响应流，并持续写入事件：

```text
Client                   Server
  |                        |
  |------ HTTP GET ------->|
  |                        |
  |<----- SSE 事件 1 ------|
  |                        |
  |<----- SSE 事件 2 ------|
  |                        |
  |<----- SSE 事件 3 ------|
  |                        |
  |       ...              |
```

例如服务端返回：

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
```

随后持续输出：

```text
data: {"progress":20}

data: {"progress":60}

data: {"progress":100}
```

客户端就能够实时接收到这些事件，而不必等待整个 HTTP 响应结束。

注意：SSE 本身主要用于服务器向客户端推送数据，并不提供对称的双向消息通道。

### 3.2 HTTP+SSE 如何实现 MCP 通信？

旧版 MCP 使用两条逻辑通信通道：

- HTTP POST：客户端向服务端发送 JSON-RPC 消息。
- SSE：服务端向客户端发送 JSON-RPC 消息。

通信过程如下：

```text
MCP Client                         MCP Server
    |                                   |
    |---------- GET /sse -------------->|
    |                                   |
    |<--------- endpoint 事件 ----------|
    |                                   |
    |    获取 POST 消息发送地址          |
    |                                   |
    |--------- POST /messages --------->|
    |                                   |
    |<--------- 202 Accepted -----------|
    |                                   |
    |        服务端执行工具              |
    |                                   |
    |<--------- SSE message ------------|
    |                                   |
    |         获取调用结果               |
```

第一步，客户端建立 SSE 连接：

```http
GET /sse HTTP/1.1
Accept: text/event-stream
```

服务端返回消息发送入口：

```text
event: endpoint
data: /messages?sessionId=abc123
```

第二步，客户端发送工具调用：

```http
POST /messages?sessionId=abc123 HTTP/1.1
Content-Type: application/json
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "add",
    "arguments": {
      "a": 10,
      "b": 20
    }
  }
}
```

服务端接受消息后，可以返回：

```http
HTTP/1.1 202 Accepted
```

但这个响应并不表示工具执行完成。

最终结果通过之前建立的 SSE 通道返回：

```text
event: message
data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"30"}]}}
```

这就是旧版 HTTP+SSE 的基本工作原理。

---

## 四、HTTP+SSE 存在什么问题？

HTTP+SSE 虽然能够实现 MCP 的远程通信，但其架构存在一些问题。

### 4.1 请求和响应分离，增加通信复杂度

对于一个简单的加法工具：

```javascript
add(10, 20);
```

普通 HTTP 只需要：

```text
发送请求 → 执行函数 → 返回结果
```

而旧版 HTTP+SSE 则需要：

```text
建立 SSE 连接
      ↓
获取 POST 地址
      ↓
发送 JSON-RPC 请求
      ↓
等待 SSE 返回结果
      ↓
根据 id 匹配响应
```

客户端必须同时管理 HTTP 请求和 SSE 消息流。

例如可能需要一个 Map 保存正在等待的请求：

```javascript
// 保存尚未收到响应的请求
const pendingRequests = new Map();

// 收到 SSE 消息后，根据 id 找到对应请求
function handleMessage(message) {
  const request = pendingRequests.get(message.id);

  if (request) {
    request.resolve(message.result);

    // 请求完成，删除记录
    pendingRequests.delete(message.id);
  }
}
```

这种方式并非不能工作，而是对于简单工具调用来说，复杂度偏高。

### 4.2 SSE 连接断开后的恢复问题

假设客户端正在调用一个耗时工具：

```text
Client                    Server
   |                         |
   |------ POST 请求 -------->|
   |                         |
   |                   开始执行任务
   |                         |
   X  SSE 连接意外断开        |
   |                         |
   |                   任务执行完成
   |                         |
   |                   原 SSE 通道不可用
```

此时客户端可能不知道任务究竟有没有执行成功。

旧版 HTTP+SSE 没有提供后来 Streamable HTTP 那样的通用可选流恢复机制，因此需要应用额外处理断线恢复、结果查询以及重复执行等问题。

尤其对于创建订单、扣款等有副作用的操作，客户端不能在连接断开之后盲目重新执行。

### 4.3 增加服务端水平扩容难度

假设 MCP Server 部署了三个实例：

```text
               Load Balancer
                     |
         +-----------+-----------+
         |           |           |
      Server A    Server B    Server C
```

用户的 SSE 连接建立在 Server A 上。

但是客户端后续的 POST 请求可能被分配给 Server B。

此时：

- Server A 持有客户端的 SSE 连接。
- Server B 接收到工具调用请求。
- Server B 需要让 Server A 将结果发送给客户端。

如果两个服务实例之间没有共享状态或消息转发机制，就可能无法正确返回结果。

通常需要引入：

- Sticky Session（会话粘滞）
- Redis 等共享存储
- 跨实例消息队列或消息总线

这会增加部署和运维成本。

### 4.4 强制维护 SSE 通道的必要性不高

并不是所有 MCP 工具都需要流式响应。

例如：

```javascript
add(1, 2);
getUserInfo(1001);
getServerTime();
```

这些工具可能在很短的时间内完成。

如果只是返回一个简单 JSON，就没有必要为所有远程调用都预先建立专门的 SSE 消息通道。

**因此，HTTP+SSE 的核心问题并不是 SSE 本身，而是旧版 MCP 强制将请求发送和响应接收拆分到不同的通道。**

---

## 五、Streamable HTTP 是如何解决这些问题的？

为了解决旧版 HTTP+SSE 的不足，MCP 在 2025-03-26 版本引入了 Streamable HTTP。

它的核心思想是：

**让一次 HTTP POST 请求就能够完成一次 JSON-RPC 调用，同时根据实际情况选择普通 JSON 响应或者 SSE 流式响应。**

### 5.1 简单工具调用：直接返回 JSON

例如客户端调用加法工具：

```text
MCP Client                         MCP Server
    |                                   |
    |----------- POST /mcp ------------>|
    |                                   |
    |             执行 add              |
    |                                   |
    |<---------- JSON 响应 -------------|
    |                                   |
    |             调用结束               |
```

客户端不需要提前建立独立 SSE 连接。

服务端直接通过当前 HTTP 请求返回 JSON-RPC 结果。

### 5.2 耗时工具调用：使用 SSE 流式返回

如果工具执行时间较长，服务端可以通过 SSE 逐步返回与当前请求相关的通知，最后返回调用结果。

```text
MCP Client                         MCP Server
    |                                   |
    |----------- POST /mcp ------------>|
    |                                   |
    |             执行工具               |
    |                                   |
    |<--------- SSE 进度通知 ------------|
    |                                   |
    |<--------- SSE 进度通知 ------------|
    |                                   |
    |<--------- 最终 JSON-RPC 响应 ------|
    |                                   |
    |             响应流结束             |
```

例如在 Node.js 中，SSE 底层可以这样实现：

```javascript
// 以下代码仅演示 HTTP SSE 输出原理
// 并不是完整的 MCP Server 实现

res.writeHead(200, {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no"
});

// 发送第一条事件，不结束 HTTP 响应
res.write('data: {"progress":20}\n\n');

// 继续写入下一条事件
res.write('data: {"progress":60}\n\n');

// 发送最后一条事件
res.write('data: {"progress":100}\n\n');

// 所有消息发送完成后，结束响应
res.end();
```

这里需要理解两个方法：

- `res.write()`：向当前 HTTP 响应继续写入数据。
- `res.end()`：结束当前 HTTP 响应。

真正的 MCP SSE 消息还需要符合 JSON-RPC 的格式以及对应的通知、结果结构。

**Streamable HTTP 并没有抛弃 SSE，而是让 SSE 成为按需使用的流式响应机制。**

对于简单请求，直接返回 JSON；对于需要进度通知的请求，可以返回 SSE 流。

### 5.3 Streamable HTTP 还有什么优势？

最明显的变化是请求与响应的关联更加直接。

旧版：

```text
POST 请求 ───────→ Server
                      |
SSE 独立通道 ←─────────┘
```

新版：

```text
POST 请求 ───────→ Server
     ↑                |
     └──── HTTP 响应 ──┘
```

这降低了客户端的协议处理复杂度。

不过，2025 版 Streamable HTTP 仍然保留了可选的协议级 Session，以及用于独立服务端通知的 GET SSE 流。它也允许服务端实现基于 `Last-Event-ID` 的流恢复。

因此，**Streamable HTTP 最初解决的是通信通道设计问题，并没有一次性完全解决协议状态管理问题。**

这就引出了下一阶段：无状态 MCP。

---

## 六、什么是无状态 MCP？

### 6.1 无状态的真正含义

无状态（Stateless）是指：

**服务端处理当前请求时，不需要依赖上一次请求保存在某个服务实例中的协议会话状态。**

例如有两个工具：

```javascript
getUserInfo(userId);

getUserOrders(userId);
```

在有状态模型下，客户端和服务端可能首先进行初始化，交换协议版本、能力信息，并创建 Session。

后续请求通过 Session ID 找到之前保存的协议上下文。

```javascript
// 旧版有状态实现的概念示意

const sessions = new Map();

// 初始化时保存会话信息
sessions.set("session-123", {
  protocolVersion: "2025-11-25",
  clientCapabilities: {}
});

// 后续请求查找会话
const session = sessions.get("session-123");
```

这种方式存在一个问题：

如果会话保存在 Server A 的内存中，那么请求被转发给 Server B 时，Server B 可能无法读取该会话。

而无状态设计的思想是：

**每次请求都携带完成本次调用所必需的协议上下文，让服务端可以独立处理当前请求。**

这样就不必依赖之前建立的协议 Session。

### 6.2 2026 版 MCP 如何实现无状态？

MCP 在 2026-07-28 版本将协议核心改为无状态模型，主要通过以下机制实现。

**第一，取消强制初始化握手。**

旧版客户端通常需要：

```text
initialize
    ↓
协商协议版本和能力
    ↓
notifications/initialized
    ↓
开始工具调用
```

新版客户端不再依赖这套初始化过程。

如果需要提前发现服务端能力，可以调用 `server/discover`，但它并不是每次调用工具前都必须执行的握手。

**第二，每次请求携带协议上下文。**

例如调用加法工具：

```http
POST /mcp HTTP/1.1
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: add
```

请求体：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "add",
    "arguments": {
      "a": 10,
      "b": 20
    },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        "name": "my-client",
        "version": "1.0.0"
      },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

其中：

| 字段                   | 作用               |
| -------------------- | ---------------- |
| `protocolVersion`    | 当前请求使用的 MCP 协议版本 |
| `clientInfo`         | 客户端软件的名称、版本等信息   |
| `clientCapabilities` | 客户端支持的协议能力       |
| `name`               | 当前需要调用的工具        |
| `arguments`          | 工具执行需要的业务参数      |

这样 MCP Server 就能够独立理解和处理当前请求。

需要注意，`clientInfo` 描述的是客户端软件，并不等同于已经验证的最终用户身份。

**第三，移除协议级 Session。**

新版不再使用 `Mcp-Session-Id` 维护跨请求的协议会话。

因此，请求不需要始终交给同一个 MCP Server 实例。

**第四，支持基于 HTTP Header 的路由。**

新版要求提供 `Mcp-Method`，并在工具调用等适用场景中提供 `Mcp-Name`。

这样 API Gateway 就可以直接识别：

```text
Mcp-Method: tools/call
Mcp-Name: add
```

无需先解析 JSON 请求体才能确定调用类型。

当然，服务端仍需要校验请求头和请求体的一致性。

### 6.3 无状态是不是每次都要传递所有用户信息？

不是。

这是无状态设计中非常容易产生的误解。

**无状态要求传递必要信息，而不是传递所有信息。**

例如用户希望查询自己的订单。

客户端可以发送：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "getMyOrders",
    "arguments": {
      "status": "pending"
    }
  }
}
```

这里为了突出业务参数，省略了完整的 2026 版 `_meta` 等协议字段。

服务端处理流程：

```text
收到请求
    ↓
验证 Authorization 中的身份凭证
    ↓
获取经过认证的用户身份
    ↓
读取 status 参数
    ↓
查询 MySQL 数据库
    ↓
返回用户订单
```

用户身份可以通过 HTTP Authorization 等认证机制获得，不应该直接相信未经验证的用户 ID 参数。

订单数据保存在数据库中，也不必每次通过 MCP 请求把全部订单数据传过来。

因此，我们需要区分：

- **协议状态**：协议版本、客户端能力、协议 Session 等。
- **业务状态**：订单、用户资料、任务记录、文件等。

无状态 MCP 主要取消的是服务端对隐式协议会话的依赖。

业务数据依然可以存储在 MySQL、Redis 等系统中。

---

## 七、无状态 MCP 如何实现多轮交互？

假设 MCP Server 提供一个删除数据库的工具：

```javascript
deleteDatabase("test");
```

执行删除之前，需要先得到用户确认。

问题在于：

**如果服务端不再长期保存协议 Session，它应该如何等待用户确认？**

2026 版 MCP 引入了 MRTR（Multi Round-Trip Requests，多轮往返请求）机制。

它的核心思想是：当服务端需要额外输入时，先返回“需要输入”的结果，由客户端收集输入后再次发起请求。

流程如下：

```text
MCP Client                        MCP Server
    |                                  |
    |---- 调用 deleteDatabase -------->|
    |                                  |
    |<------ input_required -----------|
    |                                  |
    |        向用户请求确认             |
    |                                  |
    |---- 携带 inputResponses -------->|
    |                                  |
    |       验证输入及执行权限          |
    |                                  |
    |<-------- 最终执行结果 ------------|
```

例如，服务端第一次收到删除请求时，返回一个包含 `resultType: "input_required"` 和 `inputRequests` 的结果，要求客户端获取用户确认。

客户端拿到确认结果后，在后续请求中通过 `inputResponses` 返回用户输入。

如果需要保留本次交互过程的阶段性信息，还可以使用受保护的 `requestState` 进行显式状态传递。

注意：

这里仍然存在状态，只不过不再要求服务端把状态一直保存在某台机器的 Session 中，而是将跨请求所需的状态显式传递，或存储到外部持久化系统。

对于敏感操作，还需要验证用户权限、确认内容及状态有效期，不能仅凭客户端返回的一个 `true` 就执行危险操作。

---

## 八、无状态 MCP 为什么更适合分布式部署？

无状态设计最直接的收益，就是更容易进行水平扩容。

### 8.1 有状态架构

```text
             Load Balancer
                   |
        +----------+----------+
        |          |          |
     Server A   Server B   Server C
        |          |          |
     Session A  Session B  Session C
```

客户端的请求可能依赖某个实例上的会话。

如果实例重启，会话可能丢失。

如果增加服务器，还需要考虑会话分配、共享和迁移。

### 8.2 无状态架构

```text
             Load Balancer
                   |
        +----------+----------+
        |          |          |
     Server A   Server B   Server C
        |          |          |
        +----------+----------+
                   |
              MySQL / Redis
```

每个实例都能够独立处理完整请求。

如果 Server A 故障，之后的新请求可以分配给 Server B。

这带来了几个优势：

1. **容易水平扩容**：增加服务器实例即可提升整体请求处理能力。
2. **减少会话粘滞依赖**：不必保证同一客户端始终访问同一个服务实例。
3. **降低协议会话管理开销**：减少长期会话在内存中的占用。
4. **更适合容器化和 Serverless**：新实例不需要恢复客户端之前的协议 Session。
5. **便于流量调度**：负载均衡器可以根据实际负载分配新请求。

但是，无状态不代表所有问题都自动解决。

对于长时间运行的任务，仍然可能需要任务数据库、消息队列和结果查询机制。

对于跨实例实时通知，仍然可能需要消息总线。

对于涉及写入的工具，还需要防止重试导致重复执行，例如使用幂等键或其他业务幂等机制。

---

## 九、无状态 MCP 是否意味着不再使用 SSE？

不是。

**无状态和是否使用 SSE，是两个完全不同的概念。**

无状态解决的是：

> 服务端是否需要依赖之前的协议会话？

SSE 解决的是：

> 服务端是否需要在同一个 HTTP 响应中持续推送消息？

因此，即使 MCP 已经采用无状态设计，它仍然可以通过 SSE 返回工具执行期间的进度通知。

```text
Client                         Server
   |                              |
   |--------- POST /mcp --------->|
   |                              |
   |<------- SSE 进度通知 ---------|
   |                              |
   |<------- SSE 进度通知 ---------|
   |                              |
   |<------- 最终执行结果 ---------|
   |                              |
   |          请求结束             |
```

这里存在一条持续一段时间的 HTTP 响应流，但并不意味着服务端必须保存跨请求的 MCP 协议 Session。

2026 版还进一步移除了旧版独立 GET SSE 监听入口。

如果客户端需要接收工具列表变化等长期通知，可以通过 `subscriptions/listen` 请求建立相应的 SSE 订阅流。

另外，2026 版不再支持通过 `Last-Event-ID` 恢复断开的 SSE 响应流，因此业务上仍需处理断线与重试。

---

## 十、MCP 通信机制的版本演进

通过前面的分析，可以将 MCP 的远程通信演进分为三个阶段。

| 对比维度        | HTTP+SSE（2024） | Streamable HTTP（2025） | Streamable HTTP（2026） |
| ----------- | -------------- | --------------------- | --------------------- |
| 发送请求        | HTTP POST      | HTTP POST             | HTTP POST             |
| 接收结果        | 独立 SSE 通道      | JSON 或当前请求的 SSE 流     | JSON 或当前请求的 SSE 流     |
| HTTP 入口     | 两个入口           | 统一 MCP 入口             | 统一 MCP 入口             |
| GET SSE 监听  | 必需             | 可选                    | 移除                    |
| 初始化握手       | 需要             | 需要                    | 移除                    |
| 协议级 Session | 连接关联           | 可选                    | 移除                    |
| SSE 流恢复     | 无统一机制          | 可选支持                  | 不支持 `Last-Event-ID`   |
| 多轮交互        | 会话内交互          | 会话内交互                 | MRTR                  |
| 水平扩容        | 需要处理连接归属       | 可采用无状态部署              | 协议核心无状态               |

这里特别需要注意：2025 版 Streamable HTTP 的 Session 是可选的，实际上一些 SDK 早已支持无状态部署模式。

2026 版的变化是将**无状态正式变成新协议版本的核心设计**，而不是第一次让 MCP 具备无状态能力。

此外，协议演进不代表所有客户端都会立即升级。实际开发时，仍需要确认 MCP Client 和 Server 使用的协议版本，必要时兼容旧版初始化和传输流程。

---

## 十一、总结：MCP 为什么要这样设计？

回顾整个技术演进过程，可以看到 MCP 的设计思路逐渐变得清晰。

**第一阶段：选择 JSON-RPC。**

解决不同进程之间如何统一描述远程函数调用的问题。

```text
方法名称 + 参数
       ↓
   JSON-RPC
       ↓
执行结果或错误
```

**第二阶段：采用 HTTP+SSE。**

解决 MCP Client 和 MCP Server 之间的远程消息传递问题。

```text
HTTP POST：发送消息
SSE：接收消息
```

但这种方式要求维护独立的 SSE 接收通道，带来了连接管理和服务端部署复杂度。

**第三阶段：引入 Streamable HTTP。**

让一次 HTTP 请求可以直接返回 JSON，必要时使用 SSE 流式输出。

```text
HTTP POST
    |
    +── 简单请求 → JSON 响应
    |
    +── 流式请求 → SSE 响应
```

**第四阶段：协议核心转向无状态。**

让服务端不再依赖跨请求保存的协议 Session，而是在每次请求中携带必要的协议上下文，通过显式状态传递完成多轮交互。

```text
独立请求
    ↓
负载均衡器
    ↓
任意 MCP Server 实例
    ↓
执行工具
    ↓
返回结果
```

最终可以用四句话概括：

- **JSON-RPC**：解决远程调用消息应该如何表示。
- **HTTP+SSE**：解决早期 MCP 如何通过 HTTP 实现双向消息交换。
- **Streamable HTTP**：解决请求与响应通道分离带来的复杂度，并保留按需流式返回的能力。
- **无状态 MCP**：解决跨请求协议会话依赖，使 MCP Server 更容易进行水平扩容和分布式部署。

从架构设计上看，这些变化并不是孤立的。

它们共同推动 MCP 从早期偏向长连接、会话驱动的通信模型，逐渐转向更适合生产环境的、以独立请求为中心的 HTTP 服务模型。

**理解 MCP 的关键，不只是记住它使用 JSON-RPC 和 HTTP，而是理解不同协议层分别解决了什么问题，以及这些设计为什么会随着实际工程需求不断演进。**

---

## 参考资料

1. [JSON-RPC 2.0 官方规范](https://www.jsonrpc.org/specification)
2. [MCP 2024-11-05：HTTP+SSE Transport](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports)
3. [MCP 2025-11-25：Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
4. [MCP 2026-07-28：Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
5. [MCP 官方博客：The 2026-07-28 Specification](https://blog.modelcontextprotocol.io/posts/2026-07-28/)

*本文基于截至 2026 年 11 月的 MCP 官方协议规范整理。*
