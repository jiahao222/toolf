/**
 * @file fetch-interceptor.js
 * 网络层 Fetch 拦截器与双协议（OpenAI + Gemini）真流式去壳管道：
 * 1. 请求阶段：将预设与历史打入 tools.function.description，按模式配置 JSON Schema / Python 脚本外壳；
 * 2. 响应阶段：
 *    - 正常真流式路径：实时剥离 JSON / Python 外壳，直接吐纯正文（保留原生 thought/reasoning 不受影响）；
 *    - 自动兜底路径：若模型在 AUTO 模式下仍触发了 carrier tool 的 tool_calls / functionCall，
 *      自动解包还原为普通文本、将 finish_reason 置为 stop，并清理 TauriTavern 末尾追加的 delta.native。
 */

import {
    JsonFieldStreamExtractor,
    PythonScriptStreamExtractor,
    normalizeStreamText,
} from './extractors.js';
import {
    CARRIER_MODES,
    CHUNK_GRANULARITIES,
    DEFAULT_CONFIG,
    rewriteChatCompletionBody,
} from './request-rewriter.js';

export { CARRIER_MODES, CHUNK_GRANULARITIES, DEFAULT_CONFIG };

const CHAT_GENERATE_URL_RE = /\/api\/backends\/chat-completions\/generate\b/;

/**
 * 读取 fetch 参数中的字符串 body
 * @param {any[]} args
 * @returns {Promise<string | null>}
 */
async function readRequestBody(args) {
    const [resource, init] = args;
    if (init && typeof init.body === 'string') {
        return init.body;
    }
    if (typeof Request !== 'undefined' && resource instanceof Request) {
        try {
            return await resource.clone().text();
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * 构造替换 body 后的 fetch 参数
 * @param {any[]} args
 * @param {string} newBody
 * @returns {any[]}
 */
function replaceRequestBody(args, newBody) {
    const [resource, init] = args;
    if (init && typeof init === 'object' && init.body !== undefined) {
        return [resource, { ...init, body: newBody }];
    }
    if (typeof Request !== 'undefined' && resource instanceof Request) {
        return [new Request(resource, { body: newBody }), init];
    }
    return [resource, { ...(init || {}), body: newBody }];
}

/**
 * 从工具参数对象或 JSON 字符串中提取目标字段文本
 * @param {any} rawArgs
 * @param {string} paramName
 * @returns {string}
 */
function extractFromToolArgs(rawArgs, paramName) {
    if (typeof rawArgs === 'string') {
        if (!rawArgs) return '';
        try {
            const parsed = JSON.parse(rawArgs);
            return extractFromToolArgs(parsed, paramName);
        } catch {
            const extractor = new JsonFieldStreamExtractor({
                targetField: paramName,
                allowPassthrough: false,
            });
            return extractor.feed(rawArgs) + extractor.flush();
        }
    }
    if (rawArgs && typeof rawArgs === 'object') {
        const direct = rawArgs[paramName]
            ?? rawArgs.display_stream
            ?? rawArgs.content
            ?? rawArgs.text
            ?? rawArgs.response;
        if (typeof direct === 'string') {
            return normalizeStreamText(direct);
        }
        let longest = '';
        for (const val of Object.values(rawArgs)) {
            if (typeof val === 'string' && val.length > longest.length) {
                longest = val;
            }
        }
        return normalizeStreamText(longest);
    }
    return '';
}

/**
 * 针对非流式纯文本输出剥离 JSON / Python 外壳
 * @param {string} text
 * @param {string} mode
 * @param {string} paramName
 * @returns {string}
 */
function unwrapCompleteText(text, mode, paramName) {
    if (typeof text !== 'string' || !text) {
        return '';
    }
    if (mode === CARRIER_MODES.JSON_SCHEMA) {
        const extractor = new JsonFieldStreamExtractor({
            targetField: paramName,
            allowPassthrough: true,
        });
        return extractor.feed(text) + extractor.flush();
    }
    if (mode === CARRIER_MODES.PYTHON_SCRIPT) {
        const extractor = new PythonScriptStreamExtractor({ allowPassthrough: true });
        return extractor.feed(text) + extractor.flush();
    }
    return normalizeStreamText(text);
}

export class ToolCarrierStreamInterceptor {
    /**
     * @param {Partial<typeof DEFAULT_CONFIG>} [initialConfig]
     */
    constructor(initialConfig = {}) {
        this.config = { ...DEFAULT_CONFIG, ...initialConfig };
        this.originalFetch = null;
        this.isHooked = false;
    }

    /**
     * @param {Partial<typeof DEFAULT_CONFIG>} newConfig
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
    }

    install() {
        if (this.isHooked || typeof window === 'undefined' || typeof window.fetch !== 'function') {
            return;
        }

        this.originalFetch = window.fetch;
        const self = this;

        window.fetch = async function (...args) {
            const [resource] = args;
            const url = typeof resource === 'string'
                ? resource
                : (resource instanceof URL ? resource.href : (resource?.url || ''));

            if (!self.config.enabled || !CHAT_GENERATE_URL_RE.test(url)) {
                return self.originalFetch.apply(this, args);
            }

            const rawBody = await readRequestBody(args);
            if (!rawBody) {
                return self.originalFetch.apply(this, args);
            }

            const rewriteResult = rewriteChatCompletionBody(rawBody, self.config);
            if (!rewriteResult.rewritten || !rewriteResult.body || !rewriteResult.meta) {
                if (rewriteResult.reason === 'conflicting-carrier-tool') {
                    console.info('[ToolCarrierStreamer] 检测到请求已含其他工具壳（如 Ny-超强越狱），已跳过二次改写。请关闭预设中的重复越狱开关以启用本扩展真流式。');
                }
                return self.originalFetch.apply(this, args);
            }

            const patchedArgs = replaceRequestBody(args, rewriteResult.body);
            const response = await self.originalFetch.apply(this, patchedArgs);

            if (!response || !response.ok || !response.body) {
                return response;
            }

            const contentType = String(response.headers.get('content-type') || '').toLowerCase();
            if (contentType.includes('text/event-stream')) {
                return self.wrapEventStreamResponse(response, rewriteResult.meta);
            }
            if (contentType.includes('application/json')) {
                return self.wrapJsonResponse(response, rewriteResult.meta);
            }
            return response;
        };

        this.isHooked = true;
        console.log('[ToolCarrierStreamer] 拦截器已激活，模式:', this.config.mode);
    }

    uninstall() {
        if (!this.isHooked || !this.originalFetch || typeof window === 'undefined') {
            return;
        }
        window.fetch = this.originalFetch;
        this.originalFetch = null;
        this.isHooked = false;
        console.log('[ToolCarrierStreamer] 拦截器已卸载');
    }

    /**
     * 判断某个工具名是否属于本扩展注入的承载工具（而不是用户注册的真实工具）
     * @param {string} name
     * @param {{ toolName: string, clientToolNames: Set<string> }} meta
     * @returns {boolean}
     */
    #isCarrierTool(name, meta) {
        if (typeof name !== 'string' || !name) return false;
        if (meta.clientToolNames?.has(name)) return false;
        return name === meta.toolName;
    }

    /**
     * 创建正文去壳状态机
     * @param {string} mode
     * @param {string} paramName
     */
    #createTextExtractor(mode, paramName) {
        if (mode === CARRIER_MODES.JSON_SCHEMA) {
            return new JsonFieldStreamExtractor({
                targetField: paramName,
                allowPassthrough: true,
            });
        }
        if (mode === CARRIER_MODES.PYTHON_SCRIPT) {
            return new PythonScriptStreamExtractor({ allowPassthrough: true });
        }
        return null;
    }

    /**
     * 包装 SSE 流式响应（同时支持 OpenAI choices 流与 Gemini candidates 流）
     * @param {Response} originalResponse
     * @param {{ mode: string, toolName: string, paramName: string, clientToolNames: Set<string>, isGemini: boolean }} meta
     * @returns {Response}
     */
    wrapEventStreamResponse(originalResponse, meta) {
        const self = this;
        const textExtractor = this.#createTextExtractor(meta.mode, meta.paramName);
        const openaiToolExtractors = new Map();
        const openaiToolCallIds = new Map();
        const carrierToolIndices = new Set();
        const isChunkedToolMode = meta.mode === CARRIER_MODES.CHUNKED_TOOL_CALL;
        let sawCarrierToolCall = false;
        let googleToolEmitted = '';
        let utf8Remainder = '';

        const textDecoder = new TextDecoder('utf-8');
        const textEncoder = new TextEncoder();

        /**
         * 处理单条 OpenAI choices SSE chunk
         * @param {any} parsed
         * @returns {{ mutated: boolean, drop: boolean }}
         */
        const transformOpenAiChunk = (parsed) => {
            let mutated = false;
            const choice = parsed.choices?.[0];
            if (!choice || typeof choice !== 'object') {
                return { mutated: false, drop: false };
            }

            const delta = choice.delta;
            if (!delta || typeof delta !== 'object') {
                if (sawCarrierToolCall && self.config.consumeToolCalls && choice.finish_reason === 'tool_calls') {
                    choice.finish_reason = 'stop';
                    mutated = true;
                }
                return { mutated, drop: false };
            }

            // 清理 TauriTavern gemini.rs 末尾补发的 delta.native，避免把已消费的合成 functionCall 回放进历史
            if (delta.native?.gemini?.content?.parts && Array.isArray(delta.native.gemini.content.parts)) {
                const parts = delta.native.gemini.content.parts;
                const hasCarrierNative = parts.some(p => p?.functionCall && self.#isCarrierTool(p.functionCall.name, meta));
                if (hasCarrierNative && self.config.consumeToolCalls) {
                    const cleanedParts = [];
                    for (const part of parts) {
                        if (part?.functionCall && self.#isCarrierTool(part.functionCall.name, meta)) {
                            const extracted = extractFromToolArgs(part.functionCall.args, meta.paramName);
                            const replacement = { text: extracted };
                            if (part.thoughtSignature) {
                                replacement.thoughtSignature = part.thoughtSignature;
                            }
                            cleanedParts.push(replacement);
                        } else {
                            cleanedParts.push(part);
                        }
                    }
                    delta.native.gemini.content.parts = cleanedParts;
                    mutated = true;
                }
            }

            // 路径 1：兜底处理 OpenAI delta.tool_calls（如传统 tool_call 模式或 AUTO 模式下偶发调用）
            if (Array.isArray(delta.tool_calls)) {
                const remaining = [];
                for (let i = 0; i < delta.tool_calls.length; i++) {
                    const tc = delta.tool_calls[i];
                    const idx = typeof tc.index === 'number' ? tc.index : i;
                    const fnName = tc.function?.name;
                    if (fnName && self.#isCarrierTool(fnName, meta)) {
                        carrierToolIndices.add(idx);
                    }
                    if (carrierToolIndices.has(idx)) {
                        sawCarrierToolCall = true;
                        mutated = true;
                        // 兼容部分反代复用相同 index 但换新 id（或重复传 function.name）开启下一段微 tool_call
                        const prevId = openaiToolCallIds.get(idx);
                        const isNewCallOnSameIndex = Boolean(
                            (tc.id && prevId && tc.id !== prevId)
                            || (!tc.id && fnName && openaiToolExtractors.get(idx)?.isDone),
                        );
                        if (isNewCallOnSameIndex) {
                            const flushed = openaiToolExtractors.get(idx)?.flush() || '';
                            if (flushed) {
                                delta.content = (delta.content || '') + flushed;
                            }
                            openaiToolExtractors.delete(idx);
                        }
                        if (tc.id) {
                            openaiToolCallIds.set(idx, tc.id);
                        }
                        if (!openaiToolExtractors.has(idx)) {
                            openaiToolExtractors.set(idx, new JsonFieldStreamExtractor({
                                targetField: meta.paramName,
                                allowPassthrough: false,
                            }));
                        }
                        const extracted = openaiToolExtractors.get(idx).feed(tc.function?.arguments || '');
                        if (extracted) {
                            delta.content = (delta.content || '') + extracted;
                        }
                        if (!self.config.consumeToolCalls) {
                            remaining.push(tc);
                        }
                    } else {
                        remaining.push(tc);
                    }
                }
                if (self.config.consumeToolCalls && mutated) {
                    if (remaining.length > 0) {
                        delta.tool_calls = remaining;
                    } else {
                        delete delta.tool_calls;
                    }
                }
            }

            // 路径 2：主路径 —— 实时剥离 delta.content 的 JSON / Python 外壳（不动 reasoning_content / reasoning）
            if (typeof delta.content === 'string' && delta.content.length > 0 && textExtractor && !sawCarrierToolCall) {
                const unwrapped = textExtractor.feed(delta.content);
                delta.content = unwrapped;
                mutated = true;
            }

            if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
                let tail = '';
                if (textExtractor && !sawCarrierToolCall) {
                    tail += textExtractor.flush();
                }
                for (const ex of openaiToolExtractors.values()) {
                    tail += ex.flush();
                }
                if (tail) {
                    delta.content = (delta.content || '') + tail;
                    mutated = true;
                }
                if (sawCarrierToolCall && self.config.consumeToolCalls && choice.finish_reason === 'tool_calls') {
                    choice.finish_reason = 'stop';
                    mutated = true;
                }
            }

            // 若这一帧仅承载了被剥掉的外壳前缀（无 content、无 reasoning、无 tool_calls、无 finish_reason、无 usage、无 native），可跳过空帧
            const hasPayload = Boolean(
                (typeof delta.content === 'string' && delta.content.length > 0)
                || delta.reasoning_content
                || delta.reasoning
                || delta.role
                || delta.native
                || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
                || (choice.finish_reason !== null && choice.finish_reason !== undefined)
                || parsed.usage,
            );
            return { mutated, drop: mutated && !hasPayload };
        };

        /**
         * 处理单条 Gemini candidates SSE chunk
         * @param {any} parsed
         * @returns {{ mutated: boolean, drop: boolean }}
         */
        const transformGeminiChunk = (parsed) => {
            let mutated = false;
            const candidate = parsed.candidates?.[0];
            if (!candidate || typeof candidate !== 'object') {
                return { mutated: false, drop: false };
            }

            const parts = candidate.content?.parts;
            if (Array.isArray(parts)) {
                const nextParts = [];
                for (const part of parts) {
                    if (!part || typeof part !== 'object') {
                        nextParts.push(part);
                        continue;
                    }

                    // 思考过程原样透传
                    if (part.thought === true) {
                        nextParts.push(part);
                        continue;
                    }

                    // 处理 Gemini functionCall（chunked_tool_call 主路径 + AUTO 模式兜底）
                    if (part.functionCall && self.#isCarrierTool(part.functionCall.name, meta)) {
                        sawCarrierToolCall = true;
                        mutated = true;
                        const fullOrDelta = extractFromToolArgs(part.functionCall.args, meta.paramName);
                        let deltaText = '';
                        if (fullOrDelta) {
                            if (isChunkedToolMode) {
                                // 单轮微 tool_calls 模式下，每个 functionCall 都是独立顺序分片，直接原样拼接
                                deltaText = fullOrDelta;
                                googleToolEmitted += fullOrDelta;
                            } else if (fullOrDelta.startsWith(googleToolEmitted)) {
                                deltaText = fullOrDelta.slice(googleToolEmitted.length);
                                googleToolEmitted = fullOrDelta;
                            } else {
                                deltaText = fullOrDelta;
                                googleToolEmitted += fullOrDelta;
                            }
                        }
                        if (deltaText || part.thoughtSignature) {
                            const textPart = { text: deltaText };
                            if (part.thoughtSignature) {
                                textPart.thoughtSignature = part.thoughtSignature;
                            }
                            nextParts.push(textPart);
                        }
                        if (!self.config.consumeToolCalls) {
                            nextParts.push(part);
                        }
                        continue;
                    }

                    // 主路径：剥离普通 text part 中的 JSON / Python 外壳
                    if (typeof part.text === 'string' && part.text.length > 0 && textExtractor && !sawCarrierToolCall) {
                        const unwrapped = textExtractor.feed(part.text);
                        mutated = true;
                        if (unwrapped || part.thoughtSignature) {
                            nextParts.push({ ...part, text: unwrapped });
                        }
                        continue;
                    }

                    nextParts.push(part);
                }

                if (candidate.finishReason && textExtractor && !sawCarrierToolCall) {
                    const tail = textExtractor.flush();
                    if (tail) {
                        nextParts.push({ text: tail });
                        mutated = true;
                    }
                }

                if (mutated) {
                    candidate.content.parts = nextParts;
                }
            } else if (candidate.finishReason && textExtractor && !sawCarrierToolCall) {
                const tail = textExtractor.flush();
                if (tail) {
                    candidate.content = { role: 'model', parts: [{ text: tail }] };
                    mutated = true;
                }
            }

            const hasRemainingParts = Array.isArray(candidate.content?.parts) && candidate.content.parts.length > 0;
            const hasMeta = Boolean(candidate.finishReason || parsed.usageMetadata);
            return { mutated, drop: mutated && !hasRemainingParts && !hasMeta };
        };

        const processLine = (line, controller) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) {
                controller.enqueue(textEncoder.encode(line + '\n'));
                return;
            }

            const rawData = trimmed.slice(5).trim();
            if (rawData === '[DONE]') {
                let tail = '';
                if (textExtractor && !sawCarrierToolCall) {
                    tail += textExtractor.flush();
                }
                for (const ex of openaiToolExtractors.values()) {
                    tail += ex.flush();
                }
                if (tail) {
                    const synthetic = meta.isGemini
                        ? { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: tail }] } }] }
                        : { choices: [{ index: 0, delta: { content: tail }, finish_reason: null }] };
                    controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(synthetic)}\n\n`));
                }
                controller.enqueue(textEncoder.encode(line + '\n'));
                return;
            }

            let parsed;
            try {
                parsed = JSON.parse(rawData);
            } catch {
                controller.enqueue(textEncoder.encode(line + '\n'));
                return;
            }

            let result = { mutated: false, drop: false };
            if (Array.isArray(parsed.candidates)) {
                result = transformGeminiChunk(parsed);
            } else if (Array.isArray(parsed.choices)) {
                result = transformOpenAiChunk(parsed);
            }

            if (result.drop) {
                return;
            }
            if (result.mutated) {
                controller.enqueue(textEncoder.encode(`data: ${JSON.stringify(parsed)}\n`));
            } else {
                controller.enqueue(textEncoder.encode(line + '\n'));
            }
        };

        const transformStream = new TransformStream({
            transform(chunk, controller) {
                const text = utf8Remainder + textDecoder.decode(chunk, { stream: true });
                const lines = text.split(/\r?\n/);
                utf8Remainder = lines.pop() || '';
                for (const line of lines) {
                    processLine(line, controller);
                }
            },
            flush(controller) {
                const remaining = utf8Remainder + textDecoder.decode();
                utf8Remainder = '';
                if (remaining) {
                    for (const line of remaining.split(/\r?\n/)) {
                        if (line.length > 0) {
                            processLine(line, controller);
                        }
                    }
                }
            },
        });

        return new Response(originalResponse.body.pipeThrough(transformStream), {
            status: originalResponse.status,
            statusText: originalResponse.statusText,
            headers: originalResponse.headers,
        });
    }

    /**
     * 包装非流式 JSON 响应（兼容 OpenAI choices 与 Gemini candidates/responseContent）
     * @param {Response} originalResponse
     * @param {{ mode: string, toolName: string, paramName: string, clientToolNames: Set<string>, isGemini: boolean }} meta
     * @returns {Promise<Response>}
     */
    async wrapJsonResponse(originalResponse, meta) {
        let json;
        try {
            json = await originalResponse.json();
        } catch {
            return originalResponse;
        }

        const choice = json?.choices?.[0];
        const message = choice?.message;
        let handledByTool = false;

        if (message && Array.isArray(message.tool_calls)) {
            const remaining = [];
            const extractedParts = [];
            for (const tc of message.tool_calls) {
                const fnName = tc?.function?.name;
                if (this.#isCarrierTool(fnName, meta)) {
                    handledByTool = true;
                    const text = extractFromToolArgs(tc.function?.arguments, meta.paramName);
                    if (text) extractedParts.push(text);
                    if (!this.config.consumeToolCalls) {
                        remaining.push(tc);
                    }
                } else {
                    remaining.push(tc);
                }
            }
            if (handledByTool) {
                if (extractedParts.length > 0) {
                    const joiner = meta.mode === CARRIER_MODES.CHUNKED_TOOL_CALL ? '' : '\n';
                    message.content = extractedParts.join(joiner);
                }
                if (this.config.consumeToolCalls) {
                    if (remaining.length > 0) {
                        message.tool_calls = remaining;
                    } else {
                        delete message.tool_calls;
                    }
                    if (choice.finish_reason === 'tool_calls') {
                        choice.finish_reason = 'stop';
                    }
                }
            }
        }

        if (!handledByTool && message && typeof message.content === 'string' && message.content.length > 0) {
            message.content = unwrapCompleteText(message.content, meta.mode, meta.paramName);
        }

        // 同步清理 TauriTavern 非流式归一化后的 native.gemini.content.parts
        if (handledByTool && this.config.consumeToolCalls && Array.isArray(message?.native?.gemini?.content?.parts)) {
            message.native.gemini.content.parts = message.native.gemini.content.parts.map((part) => {
                if (part?.functionCall && this.#isCarrierTool(part.functionCall.name, meta)) {
                    const replacement = { text: extractFromToolArgs(part.functionCall.args, meta.paramName) };
                    if (part.thoughtSignature) replacement.thoughtSignature = part.thoughtSignature;
                    return replacement;
                }
                return part;
            });
        }

        return new Response(JSON.stringify(json), {
            status: originalResponse.status,
            statusText: originalResponse.statusText,
            headers: originalResponse.headers,
        });
    }
}
