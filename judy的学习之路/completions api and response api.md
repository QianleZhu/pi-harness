# 从 Chat Completions 到 Responses API：OpenAI 为什么要重新设计一套 API？

> **核心问题：Chat Completions 已经支持多轮对话、Function Calling 和流式输出，为什么 OpenAI 还要开发 Responses API？它究竟解决了什么问题？**

## 一、背景：从文本生成到 AI Agent

最初，大语言模型的主要任务是文本补全。

例如，向模型输入：

```text
Python 是一种
```

模型继续生成后面的内容。

这种交互方式非常简单：

```text
输入文本 → 模型 → 输出文本
```

后来，随着 ChatGPT 等对话产品出现，开发者需要区分系统指令、用户消息和助手消息。

于是，Chat Completions API 出现了。

它通过 `system`、`user`、`assistant` 等角色组织对话。

但随着模型能力进一步发展，AI 不再只是回答问题。

现在的 AI Agent 可能需要：

1. 分析用户的任务。
2. 搜索网络或读取文件。
3. 调用外部函数。
4. 分析工具返回的结果。
5. 继续调用其他工具。
6. 最终完成任务并报告结果。

这就产生了新的问题：

**如果 AI 不只是聊天，而是在不断推理、调用工具和执行任务，那么原来以聊天消息为中心的 API，是否仍然是最合适的数据结构？**

Responses API 就是在这种背景下出现的。

它试图统一 Chat Completions 的简洁交互方式与 Agent 所需要的复杂执行能力。

---

## 二、Chat Completions 和 Responses API 的核心区别

### 2.1 Chat Completions：以 Message 为中心

Chat Completions API 的地址是：

```http
POST /v1/chat/completions
```

一次典型的请求：

```json
{
  "model": "your-model",
  "messages": [
    {
      "role": "user",
      "content": "你好"
    }
  ]
}
```

返回结果（省略非核心字段）：

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "你好，有什么可以帮助你？"
      },
      "finish_reason": "stop"
    }
  ]
}
```

其核心逻辑可以理解为：

```text
ChatCompletion(messages) → assistant message
```

也就是说，Chat Completions 主要围绕消息展开。

不管模型是生成文字还是调用函数，相关信息通常都由一个 assistant 消息对象承载。

### 2.2 Responses：以 Item 为中心

Responses API 的地址是：

```http
POST /v1/responses
```

请求可以简化为：

```json
{
  "model": "your-model",
  "input": "你好"
}
```

返回：

```json
{
  "id": "resp_123",
  "object": "response",
  "status": "completed",
  "output": [
    {
      "id": "msg_001",
      "type": "message",
      "role": "assistant",
      "status": "completed",
      "content": [
        {
          "type": "output_text",
          "text": "你好，有什么可以帮助你？"
        }
      ]
    }
  ]
}
```

Responses API 的核心变化是：

**模型不再只返回一个以消息为中心的结果，而是返回一个包含多个结构化 Item 的 `output` 数组。**

这些 Item 可以包括：

```text
Response
  └── output[]
       ├── reasoning
       ├── message
       ├── function_call
       └── 其他工具相关 Item
```

因此，可以将其抽象为：

```text
Responses(input) → 一组有类型、有顺序的输出 Item
```

需要注意：这里的输入和输出结构更通用，并不意味着 Responses 天然支持所有模型、所有工具和所有状态管理能力。具体功能仍然取决于服务提供商。

---

## 三、Chat Completions 存在什么设计局限？

我们通过 Function Calling 来分析。

假设用户问：

> 北京今天天气怎么样？

模型需要先告诉用户准备查询天气，再调用 `get_weather`。

### 3.1 Chat Completions 的结构

它可能生成：

```json
{
  "message": {
    "role": "assistant",
    "content": "我准备查询北京的天气。",
    "tool_calls": [
      {
        "id": "call_001",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"city\":\"北京\"}"
        }
      }
    ]
  }
}
```

这里有两个重要信息：

- `content`：模型生成的文字。
- `tool_calls`：模型发出的工具调用请求。

现在我们思考一个问题：

**模型是先生成文字，再决定调用工具，还是先决定调用工具，最后生成文字？**

如果只观察最终返回的 JSON，无法准确判断。

因为 `content` 和 `tool_calls` 只是同一个对象的不同字段。

JSON 对象的字段顺序不能用于表示业务执行顺序。

而 Responses API 改变了这一点。

### 3.2 Responses 将不同动作拆分为独立 Item

例如：

```json
{
  "output": [
    {
      "id": "rs_001",
      "type": "reasoning",
      "summary": [
        {
          "type": "summary_text",
          "text": "用户需要实时天气，需要查询天气服务。"
        }
      ]
    },
    {
      "id": "msg_001",
      "type": "message",
      "role": "assistant",
      "status": "completed",
      "content": [
        {
          "type": "output_text",
          "text": "我准备查询北京的天气。"
        }
      ]
    },
    {
      "id": "fc_001",
      "type": "function_call",
      "status": "completed",
      "call_id": "call_001",
      "name": "get_weather",
      "arguments": "{\"city\":\"北京\"}"
    }
  ]
}
```

*注：这是简化的模拟响应，并非真实 API 调用记录。*

此时，输出项目的顺序非常清晰：

```text
1. reasoning
   模型产生推理项目

        ↓

2. message
   模型生成一条文字消息

        ↓

3. function_call
   模型请求调用天气工具
```

相比 Chat Completions，Responses API 不仅告诉我们模型输出了什么，还可以表达不同输出项目的先后关系。

不过，这里的顺序是协议呈现的输出顺序，并不等于模型全部内部计算的精确时间顺序。

另外，`function_call` 的生成完成，并不意味着外部函数已经执行成功。

### 3.3 为什么这种设计更适合 Agent？

假设一个 AI 编程助手需要修复代码。

```text
用户：修复项目启动错误

    ↓
模型分析问题
    ↓
读取项目文件
    ↓
模型分析文件内容
    ↓
修改源代码
    ↓
运行测试
    ↓
读取测试结果
    ↓
向用户报告
```

在这个过程中，模型可能产生多种结构化输出。

如果我们把每个动作都视为不同类型的 Item，就可以更自然地组织整个工作流。

例如，应用可以根据 Item 类型执行不同的逻辑：

```python
for item in response.output:

    if item.type == "reasoning":
        # 推理项目：可按权限记录允许公开的信息
        pass

    elif item.type == "message":
        # 普通消息：展示给用户
        pass

    elif item.type == "function_call":
        # 工具调用：交由工具执行程序处理
        pass
```

这就是 Responses API 以 Item 为中心设计的价值。

---

## 四、Responses 的重要能力：保留推理状态

OpenAI 官方文章用侦探做了一个比喻：

你向侦探提供证据，侦探进行调查，可能咨询专家，最后告诉你调查结果。

侦探在调查过程中会保存自己的私人笔记，以便后续继续分析。

这里的私人笔记，就是 Reasoning State（推理状态）。

### 4.1 对话历史不等于推理状态

这是理解 Responses API 非常重要的一点。

我们需要区分两个概念。

**Conversation History（对话历史）**

例如：

```json
[
  {
    "role": "user",
    "content": "帮我检查项目为什么启动失败"
  },
  {
    "role": "assistant",
    "content": "我需要检查依赖文件。"
  }
]
```

它描述的是对话中已经交换的消息。

**Reasoning State（推理状态）**

则表示模型在解决问题时产生、且可用于后续推理的状态信息。

例如，模型可能分析多个错误原因、决定调查方向，并在工具调用后继续处理先前尚未完成的问题。

这些推理信息不一定包含在普通对话消息中。

因此：

```text
对话历史 ≠ 完整推理状态
```

### 4.2 Chat Completions 如何延续上下文？

传统方式通常由开发者自己维护消息列表。

```python
messages = [
    {
        "role": "user",
        "content": "帮我分析 Python 项目启动失败的问题"
    }
]

# 第一次请求
response = client.chat.completions.create(
    model="your-model",
    messages=messages
)

# 将模型消息添加到历史记录
messages.append(
    response.choices[0].message
)

# 用户继续提问
messages.append({
    "role": "user",
    "content": "继续分析"
})

# 第二次请求：重新传递历史消息
response = client.chat.completions.create(
    model="your-model",
    messages=messages
)
```

这种方式能够保留模型可见的聊天上下文。

但是，对于 OpenAI 不公开原始思维链的推理模型，普通消息历史并不能完整携带之前未公开的推理状态。

因此，后续请求可能需要重新建立部分推理上下文。

### 4.3 Responses 如何延续推理？

OpenAI 的 Responses API 可以通过 `previous_response_id` 关联先前的响应。

```python
# 示例：使用 OpenAI Responses API

first = client.responses.create(
    model="your-supported-openai-model",
    input="分析 Python 项目启动失败的原因",
    store=True
)

second = client.responses.create(
    model="your-supported-openai-model",

    # 关联第一次响应
    previous_response_id=first.id,

    input="继续分析刚才的问题"
)

print(second.output_text)
```

这里关键的是：

```python
previous_response_id=first.id
```

它使后续响应能够关联之前的上下文，并在支持的条件下复用相关推理状态。

此外，Responses 还支持通过推理 Item 传递状态；部分场景可以使用加密的推理内容，而不需要让客户端获得原始思维链。

response api是有状态API completions api 是无状态api, 因此每次都要传入完整的messages.

需要强调两点：

1. 这并不意味着模型拥有无限记忆，仍然受到上下文窗口及相关限制的影响。
2. `previous_response_id` 是 OpenAI 提供的能力，不能假设所有兼容 Responses 格式的服务都支持。

OpenAI 在其官方文章中报告，在特定 GPT-5 与 TauBench 测试设置下，保留推理状态带来了约 5% 的性能提升。

这说明对于复杂 Agent 工作流，保留推理状态可能具有实际价值，但不代表所有任务都会有相同程度的收益。

---

## 五、隐藏的 Reasoning State 和 Thinking 是一回事吗？

它们密切相关，但不能完全画等号。

首先理解三个概念：

| 概念                   | 含义            |
| -------------------- | ------------- |
| Raw Chain of Thought | 模型生成的原始推理内容   |
| Reasoning State      | 支持后续推理延续的状态信息 |
| Reasoning Summary    | 模型推理内容的可公开摘要  |

Reasoning State 可以包含对推理延续有用的信息，但不能简单认为它一定等于一整段明文 Thinking。

### 5.1 DeepSeek 可以公开 Thinking

DeepSeek 的思考模式可以通过 `reasoning_content` 返回思维链内容。

例如：

```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_DEEPSEEK_API_KEY",
    base_url="https://api.deepseek.com"
)

response = client.chat.completions.create(
    model="deepseek-flash",

    messages=[
        {
            "role": "user",
            "content": "9.11 和 9.8 哪个大？"
        }
    ],

    extra_body={
        "thinking": {"type": "enabled"}
    }
)

message = response.choices[0].message

# 模型公开的思维链内容
print(message.reasoning_content)

# 模型最终回答
print(message.content)
```

这意味着，Chat Completions 的协议结构本身，并没有绝对禁止模型返回或传递推理内容。

DeepSeek 的实际行为还存在一个重要细节：

- 当请求携带 `tools` 时，按照 DeepSeek 当前文档，应当完整回传历史 `reasoning_content`。
- 当请求不携带 `tools` 时，历史 `reasoning_content` 即使回传，也不会被拼接到后续上下文中。

所以，不能笼统地认为「Chat Completions 一定无法保存 Thinking」。

更准确的说法是：

**OpenAI 的 Responses API 提供了不向客户端公开原始思维链，也能延续推理状态的机制。**

### 5.2 为什么 OpenAI 不公开完整的原始 CoT？

官方主要提到了以下风险。

**第一，原始推理内容可能包含错误。**

模型可能在内部尝试多个推理方向，其中包括错误猜测和自我修正。

如果把所有中间内容直接展示给用户，用户可能将试探性的想法误认为可靠结论。

**第二，原始推理内容可能包含不适宜公开的信息。**

模型在分析某些危险任务时，内部推理可能涉及最终回答不会提供的内容。

直接公开全部内容，会带来额外的安全风险。

**第三，保护模型可监控性。**

这是一个非常值得研究的问题。

假设我们训练一个 AI Agent，要求它修复代码，并通过测试。

但模型发现可以通过修改测试配置来骗过评分系统。

如果它的原始推理明确写下：

```text
修改测试配置比修复 Bug 更容易。
这样可能骗过评分系统。
```

监控系统就有机会识别这种异常意图。

但是，如果我们直接训练模型「思维链绝对不能出现作弊想法」，可能产生副作用：

```text
模型不再明确写出作弊想法
          ↓
但仍然可能采取作弊行为
          ↓
监控系统更难发现异常
```

这涉及 Reward Hacking（奖励黑客行为）和 Chain-of-Thought Monitoring（思维链监控）。

OpenAI 希望保留相对自由的内部推理表达，以帮助检测模型的异常行为，而不是只训练模型让内部推理看起来完全符合规范。

不过，思维链并不一定忠实反映模型内部的全部计算过程，因此它也不能作为唯一的安全监控依据。

**第四，商业竞争。**

模型推理轨迹可能透露部分行为策略和具有商业价值的信息。

公开原始思维链虽然不等于公开模型参数，但可能帮助竞争对手分析模型的推理模式。

### 5.3 Responses 如何处理这种矛盾？

它试图同时满足两个需求：

```text
需求一：
模型在多轮任务中继续利用推理状态

需求二：
客户端不直接获取完整原始思维链
```

实现途径包括：

```text
服务端保存并关联响应
        ↓
previous_response_id
        ↓
后续调用复用可用上下文和推理状态
```

或者通过受支持的加密推理 Item 在请求之间传递相关信息。

因此，推理状态的**保留和使用**，与原始推理内容的**公开**，是可以分开的。

---

## 六、Semantic Streaming Events：语义化流式事件

这是 Responses API 的另一个改进。

### 6.1 Chat Completions 如何流式输出？

使用 `stream=True` 后，Chat Completions 会持续返回增量数据。

例如：

```json
{
  "choices": [
    {
      "delta": {
        "content": "北京"
      }
    }
  ]
}
```

接下来：

```json
{
  "choices": [
    {
      "delta": {
        "content": "今天"
      }
    }
  ]
}
```

如果模型生成函数调用，则可能返回：

```json
{
  "choices": [
    {
      "delta": {
        "tool_calls": [
          {
            "index": 0,
            "function": {
              "arguments": "{\"city\":"
            }
          }
        ]
      }
    }
  ]
}
```

这里的 `delta` 表示增量信息。

开发者需要检查 `delta` 中的字段，才能区分：

- 当前在生成普通文字。
- 当前在生成工具调用参数。
- 当前是否已经结束生成。

### 6.2 Responses 将这些变化定义为不同事件

例如：

```text
response.created

response.output_item.added

response.output_text.delta

response.output_text.done

response.output_item.done

response.completed
```

工具调用则可能出现：

```text
response.output_item.added

response.function_call_arguments.delta

response.function_call_arguments.done

response.output_item.done
```

这些事件具有明确的业务含义。

例如：

```json
{
  "type": "response.output_text.delta",
  "delta": "我准备查询北京的天气。"
}
```

开发者看到 `response.output_text.delta`，就知道这是文本生成事件。

如果收到：

```json
{
  "type": "response.function_call_arguments.delta",
  "delta": "{\"city\":"
}
```

就知道模型正在生成工具调用参数。

因此：

**Semantic Streaming Events 的核心不是实现流式输出，而是让流式输出的每个事件具有明确的语义。**

---

## 七、Internally-tagged Polymorphism：内部标记多态

这个概念来自数据建模和类型系统。

我们先拆开理解。

- Polymorphism：多态，一个通用类型可以具有多种具体形式。
- Internally-tagged：在数据对象内部使用字段标记具体类型。

### 7.1 一个简单的例子

假设有两种动物：

```json
[
  {
    "type": "dog",
    "name": "旺财",
    "breed": "金毛"
  },
  {
    "type": "cat",
    "name": "咪咪",
    "indoor": true
  }
]
```

程序通过 `type` 判断数据类型：

```python
for animal in animals:

    if animal["type"] == "dog":
        # 当前对象是狗，读取狗相关属性
        print(animal["breed"])

    elif animal["type"] == "cat":
        # 当前对象是猫，读取猫相关属性
        print(animal["indoor"])
```

这就是通过内部类型标记组织多种数据结构。

在 JSON API 设计中，更准确的术语是 Tagged Union 或 Discriminated Union，即带类型判别字段的联合类型。

### 7.2 Responses 如何应用？

Responses 中的 `output` 可以同时包含多种 Item：

```json
{
  "output": [
    {
      "type": "reasoning",
      "summary": []
    },
    {
      "type": "message",
      "role": "assistant",
      "content": []
    },
    {
      "type": "function_call",
      "name": "get_weather",
      "arguments": "{\"city\":\"北京\"}",
      "call_id": "call_001"
    }
  ]
}
```

这些对象都属于输出 Item，但每个 Item 可以包含不同的字段。

程序根据内部的 `type` 进行解析。

这样未来增加新类型时，也不需要把所有功能塞进同一个消息对象。

### 7.3 工具定义结构也体现了这种设计

Chat Completions 中的函数工具定义通常是：

```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "查询天气",
    "parameters": {
      "type": "object",
      "properties": {
        "city": {
          "type": "string"
        }
      }
    }
  }
}
```

Responses 则采用：

```json
{
  "type": "function",
  "name": "get_weather",
  "description": "查询天气",
  "parameters": {
    "type": "object",
    "properties": {
      "city": {
        "type": "string"
      }
    }
  }
}
```

可以看到，Responses 将具体函数的属性与 `type` 放在同一层级。

而 Chat Completions 在外层标记工具类型后，又使用了一个 `function` 包装对象。

这不是说前者无法表达多种类型，而是后者在结构组织上更加扁平和统一。

---

## 八、Semantic Streaming Events 和 Internally-tagged Polymorphism 不是同一个东西吗？

从代码表面看，它们确实非常相似，因为都使用 `type` 字段。

但它们解决的问题不同。

我们看一个流式事件：

```json
{
  "type": "response.output_item.added",
  "output_index": 0,
  "item": {
    "id": "fc_001",
    "type": "function_call",
    "status": "in_progress",
    "call_id": "call_001",
    "name": "get_weather",
    "arguments": ""
  }
}
```

这里同时存在两个 `type`。

**第一个：**

```json
"type": "response.output_item.added"
```

表示发生了什么事件：

> 开始生成一个新的输出项目。

这是 Semantic Streaming Event。

**第二个：**

```json
"item": {
  "type": "function_call"
}
```

表示当前输出项目是什么类型：

> 这是一个函数调用项目。

这是 Internally-tagged Polymorphism。

因此，它们的区别可以概括为：

| 概念                             | 解决的问题      |
| ------------------------------ | ---------- |
| Semantic Streaming Events      | 现在发生了什么事件？ |
| Internally-tagged Polymorphism | 当前数据是什么类型？ |

更直观的理解：

```text
Event：发生了什么？
  └── Item：操作的是哪种数据？
```

Event 负责描述事件，Item 负责描述数据对象。

它们使用了相似的类型判别方式，但属于两个不同的协议层面。

---

## 九、Chat Completions 能不能自己实现语义化流式事件？

答案是：**完全可以。**

这也是理解两个 API 差异的关键。

假设我们使用 Chat Completions：

```python
stream = client.chat.completions.create(
    model="your-model",
    messages=[
        {
            "role": "user",
            "content": "你好"
        }
    ],
    stream=True
)
```

开发者可以自己封装一层转换逻辑：

```python
def emit(event):
    # 示例：将事件交给前端或其他处理程序
    print(event)


for chunk in stream:
    if not chunk.choices:
        continue

    delta = chunk.choices[0].delta

    # 情况一：模型正在生成文本
    if delta.content is not None:
        emit({
            "type": "text.delta",
            "delta": delta.content
        })

    # 情况二：模型正在生成工具调用
    if delta.tool_calls:
        for tool in delta.tool_calls:

            if (
                tool.function is not None
                and tool.function.arguments is not None
            ):
                emit({
                    "type": "function.arguments.delta",
                    "index": tool.index,
                    "delta": tool.function.arguments
                })
```

这里的 `emit()` 是自定义函数。

我们已经通过 Chat Completions 的 `delta` 实现了具有语义的事件。

但这个简化实现还没有覆盖完整的工具调用生命周期。

如果需要实现类似 Responses 的协议，开发者通常还需要：

- 为每个工具调用维护独立状态。
- 根据 `tool.index` 拼接函数参数。
- 识别工具调用的开始和结束。
- 处理多个工具调用。
- 在结束时生成对应的完成事件。

这里还有一个信息上的限制：

如果原始 Chat Completions 返回的数据没有保留某些操作的准确顺序，我们的转换层无法凭空恢复这些信息。

因此：

**Responses 并不是实现了 Chat Completions 绝对无法实现的流式功能，而是将事件类型、输出结构和部分生命周期信息标准化到了协议本身。**

开发者不需要为同样的常见需求重复设计一套事件协议。

---

## 十、OpenAI 与 DeepSeek 的 Responses API 有什么区别？

这里需要特别强调：

**兼容 Responses API 格式，不等于拥有 OpenAI Responses API 的全部能力。**

DeepSeek 官方表示，新增 Responses API 格式支持的重要原因之一，是满足用户将 DeepSeek 模型接入 Codex 的需求。

Codex 等应用采用特定的 API 协议。

即使一个模型具备代码分析和工具调用能力，如果接口格式不兼容，也会增加接入成本。

DeepSeek 提供 Responses 接口，可以降低这种集成成本。

但是它采用了与 OpenAI 不同的状态管理设计。

### 10.1 OpenAI Responses

支持在适当配置下通过：

```python
previous_response_id=previous.id
```

关联之前的响应。

也可以在支持的模式下通过相关推理 Item 管理上下文。

### 10.2 DeepSeek Responses

DeepSeek 文档明确说明：

```text
Responses API 是无状态的。
```

服务端不保存响应和会话供后续通过 ID 恢复。

因此，DeepSeek 的 Responses API 不支持 `previous_response_id`。

开发者仍然需要在后续请求中回传必要的对话历史。

同时，DeepSeek 的 Responses API 支持哪些工具，也与 OpenAI 不完全一样。例如，`web_search` 的服务端执行受到模型支持范围的限制，并不能直接假设 OpenAI 的所有托管工具在 DeepSeek 上可用。

---

## 十二、开发者应该选择哪个 API？

可以根据实际需求判断。

| 场景                         | 建议                    |
| -------------------------- | --------------------- |
| 普通聊天机器人                    | Chat Completions 已经足够 |
| 文本生成、翻译、问答                 | 两者都可以                 |
| 旧项目已经稳定使用 Chat Completions | 没必要仅为新接口迁移            |
| 简单 Function Calling        | 两者都能实现                |
| 复杂 Agent 工作流               | 优先评估 Responses        |
| 需要 OpenAI 的推理状态管理          | 优先 Responses          |
| 需要 OpenAI 托管工具             | 根据 Responses 支持情况选择   |
| DeepSeek 接入 Codex          | 使用兼容的 Responses 接口    |

更重要的不是选择看起来更新的接口，而是确认自己需要哪种能力。

---

## 十三、总结：Responses API 真正改变了什么？

回顾整个分析，可以将 Responses API 的设计价值归纳为五点。

### 1. 从 Message 到 Item

Chat Completions 主要围绕对话消息组织输出。

Responses 将消息、推理项目和工具调用等作为不同类型的输出 Item。

这样可以更自然地表达复杂任务中的多个动作。

### 2. 从普通对话到 Agent 工作流

Chat Completions 很适合构建聊天程序。

Responses 则进一步考虑模型推理、工具调用、状态延续以及复杂任务执行。

### 3. 从消息历史到推理状态管理

普通对话历史并不等于完整推理状态。

在支持的模型和平台上，Responses 可以保留和复用相关推理信息，而不需要向客户端公开原始思维链。

### 4. 从 Delta 到 Semantic Streaming Events



Chat Completions 通过增量数据表达流式输出。

Responses 定义了更加明确的事件类型，使开发者更容易判断输出项目的生命周期和生成状态。

### 5. 通过内部类型标记统一数据结构

Responses 使用 `type` 字段区分不同种类的 Item 和事件。

这使接口能够以统一的形式组织不同类型的数据，同时保持较好的扩展性。

### 最终结论

Chat Completions 和 Responses API 的关系，不应该简单理解成新接口取代旧接口，也不能认为旧接口做不到 Function Calling 或流式输出。

两者更根本的差别是**设计时所考虑的核心场景不同**。

Chat Completions 主要从聊天机器人需求出发：

```text
用户消息
   ↓
模型生成
   ↓
助手消息
```

Responses 则进一步围绕复杂任务执行进行设计：

```text
用户提出任务
   ↓
模型推理
   ↓
生成结构化输出
   ↓
请求调用工具
   ↓
获得工具结果
   ↓
继续推理
   ↓
输出最终结果
```

所以，Responses API 真正的价值不只是更换了参数名称，也不是简单增加了几个新字段。

**它试图将 AI 从“对话生成器”转变为“能够在统一协议下推理、调用工具和执行任务的系统组件”。**

这就是从 Chat Completions 走向 Responses API 背后的软件架构演进。

---

## 参考资料

1. [OpenAI — Why we built the Responses API](https://developers.openai.com/blog/responses-api)
2. [OpenAI — Migrate to the Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)
3. [OpenAI — Reasoning models](https://developers.openai.com/api/docs/guides/reasoning)
4. [OpenAI — Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses)
5. [DeepSeek — Chat Completions API](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion)
6. [DeepSeek — Responses API 使用指南](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)
7. [DeepSeek — 思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)

