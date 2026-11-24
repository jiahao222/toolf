# ToolCarrier 真流式助手 (ToolCarrier Streamer)

专为需要在 **AIStudio2API / Google AI Studio 通道**（或其他不支持 `functionCall` 参数增量流式的渠道）下**保留工具声明承载上下文、同时实现真正边生成边流式输出**的 TauriTavern 通用扩展。

---

## 📖 原理说明

Google AI Studio 底层协议对 `functionCall` / `executableCode` 均为整包返回（必须等整段生成结束才吐出），但对 **Structured Output JSON** 与 **普通文本流（Python 脚本）** 支持原生逐块真流式。

本扩展在不修改任何预设文件、不修改 `AIStudio2API` 服务端的前提下，单轮对话严格仅调用 **1 次 API**：

1. **请求阶段**：把预设与对话历史打包进 `tools[...].function.description`，将 `tool_choice` 设为 `auto`（Gemini 原生自动映射为 `mode: AUTO`），并用干净路由壳替代 `messages`。
2. **输出承载（支持在扩展面板随时切换）**：
   - **方案 B：`JSON Schema 真流式`（默认推荐）**——自动注入 `responseSchema`（Gemini 原生）或 `response_format: json_schema`（OpenAI 兼容），服务端约束解码保证 100% 合法 JSON 流，前端状态机实时剥离 `{"display_stream":"..."}` 外壳并逐字输出。
   - **方案 A：`Python 脚本真流式去壳`**——指令模型输出 `def render_output(): payload = """..."""` 代码块，前端状态机实时剥离函数头、三引号与 `return` 尾部，只向酒馆流式吐正文。
   - **兼容模式：`强制 Tool Call`**——保持 `tool_choice: required`，用于原生支持 `partialArgs` / 流式 `tool_calls` 的 Vertex AI 等渠道。
3. **自动兜底**：若 `AUTO` 模式下模型偶发真的触发了 `functionCall` / `tool_calls`，扩展会自动解包还原成正文、将 `finish_reason` 置为 `stop`，并清理 TauriTavern 末尾补发的 `delta.native`，不触发多余第二轮请求。

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
