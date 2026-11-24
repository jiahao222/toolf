# ToolCarrier 真流式助手 (ToolCarrier Streamer)

专为需要在 **AIStudio2API / Google AI Studio 通道**（或其他不支持 `functionCall` 参数增量流式的渠道）下**保留工具声明承载上下文、同时实现真正边生成边流式输出**的 TauriTavern 通用扩展。

---

## 📖 原理说明

Google AI Studio 底层协议对 `functionCall` / `executableCode` 均为整包返回（必须等整段生成结束才吐出），但对 **Structured Output JSON** 与 **普通文本流（Python 脚本）** 支持原生逐块真流式。

本扩展在不修改任何预设文件、不修改 `AIStudio2API` 服务端的前提下，单轮对话严格仅调用 **1 次 API**：

1. **请求阶段**：把预设与对话历史打包进 `tools[...].function.description`，并用干净路由壳替代 `messages`。
2. **输出承载（支持在扩展面板随时切换）**：
   - **方案 C：`单轮微 Tool Call 分段真流式`（默认推荐）**——保持 `tool_choice: required`（Gemini 原生为 `ANY`），指令模型在**同 1 次请求内连续发起多次短段 `tool_calls`**（支持在面板选择 `40~80` / `80~150` / `150~250` 字粒度）。由于 Google AI Studio 服务端每生成完 1 个 `functionCall` 就会立刻 flush，扩展在前端逐段实时解包拼接成正文并将 `finish_reason` 转为 `stop`，**100% 走真工具通道 + 实时分段流式 + 严格仅 1 次 API 调用**。
   - **方案 B：`JSON Schema 真流式`**——自动注入 `responseSchema`（Gemini 原生）或 `response_format: json_schema`（OpenAI 兼容），服务端约束解码保证 100% 合法 JSON 流，前端状态机实时剥离 `{"display_stream":"..."}` 外壳并逐字输出。
   - **方案 A：`Python 脚本真流式去壳`**——指令模型输出 `def render_output(): payload = """..."""` 代码块，前端状态机实时剥离函数头、三引号与 `return` 尾部，只向酒馆流式吐正文。
   - **兼容模式：`单次强制 Tool Call`**——保持单次 `tool_choice: required`，用于原生支持 `partialArgs` / 流式 `tool_calls` 的 Vertex AI / Claude / OpenAI 等渠道。
3. **自动兜底与历史防污染**：自动把承载工具的 `tool_calls` / `functionCall` 消费并还原为正文、`finish_reason` 置为 `stop`，并清理 TauriTavern 末尾补发的 `delta.native`，不触发多余第二轮请求。

---

## 🚀 侧载安装方法

1. 在 TauriTavern 设置中打开数据根目录（`System -> Data Directory`），定位到扩展目录：
   - 默认用户目录：`<数据根目录>/default-user/extensions/`
   - 或全局目录：`<数据根目录>/extensions/third-party/`
2. 将本文件夹 `tool-carrier-streamer` 完整复制进去。
3. 重启或刷新 TauriTavern，在右侧 **Extensions（扩展设置）** 中展开 **🚀 ToolCarrier 真流式助手**。
4. **配合 `Ny-Gemini` 预设使用时**：在预设提示词列表里关闭 **`🔑Ny-超强越狱`**（避免原预设自带的 `Ny-Gemini-小白x` 重复拦截），其他预设条目标记保持原样即可。

---

## 🧪 运行测试

```bash
node --test extensions/tool-carrier-streamer/tests/*.test.mjs
```
