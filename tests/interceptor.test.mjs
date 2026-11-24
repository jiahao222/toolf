import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ToolCarrierStreamInterceptor,
    CARRIER_MODES,
    CHUNK_GRANULARITIES,
    DEFAULT_CONFIG,
} from '../fetch-interceptor.js';
import { rewriteChatCompletionBody } from '../request-rewriter.js';

function makeSseResponse(lines) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            for (const line of lines) {
                controller.enqueue(encoder.encode(line));
            }
            controller.close();
        },
    });
    return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
}

async function readSseEvents(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    const events = [];
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
            events.push('[DONE]');
        } else {
            events.push(JSON.parse(payload));
        }
    }
    return events;
}

test('rewriteChatCompletionBody - OpenAI 兼容源方案 B 注入 tools(auto) + response_format', () => {
    const raw = JSON.stringify({
        chat_completion_source: 'custom',
        custom_api_format: 'openai_compat',
        model: 'gemini-4-argon',
        stream: true,
        messages: [
            { role: 'system', content: '世界观设定：铁翼港' },
            { role: 'user', content: '开始冒险' },
        ],
    });

    const res = rewriteChatCompletionBody(raw, {
        ...DEFAULT_CONFIG,
        mode: CARRIER_MODES.JSON_SCHEMA,
    });
    assert.equal(res.rewritten, true);
    assert.equal(res.meta.isGemini, false);

    const parsed = JSON.parse(res.body);
    assert.equal(parsed.tool_choice, 'auto');
    assert.equal(parsed.tools.length, 1);
    assert.equal(parsed.tools[0].function.name, 'dispatch_stream_payload');
    assert.ok(parsed.tools[0].function.description.includes('世界观设定：铁翼港'));
    assert.ok(parsed.tools[0].function.description.includes('开始冒险'));
    assert.equal(parsed.response_format.type, 'json_schema');
    assert.deepEqual(parsed.response_format.json_schema.schema.required, ['display_stream']);
    assert.equal(parsed.messages.length, 4);
});

test('rewriteChatCompletionBody - Gemini 原生源方案 B 注入 tools(auto) + responseSchema', () => {
    const raw = JSON.stringify({
        chat_completion_source: 'custom',
        custom_api_format: 'gemini_generate_content',
        model: 'gemini-4-argon',
        stream: true,
        messages: [{ role: 'user', content: '写一段开篇' }],
    });

    const res = rewriteChatCompletionBody(raw, {
        ...DEFAULT_CONFIG,
        mode: CARRIER_MODES.JSON_SCHEMA,
    });
    assert.equal(res.rewritten, true);
    assert.equal(res.meta.isGemini, true);

    const parsed = JSON.parse(res.body);
    assert.equal(parsed.tool_choice, 'auto');
    assert.equal(parsed.responseMimeType, 'application/json');
    assert.equal(parsed.responseSchema.type, 'OBJECT');
    assert.equal(parsed.responseSchema.properties.display_stream.type, 'STRING');
    assert.equal(parsed.response_format, undefined);
});

test('rewriteChatCompletionBody - 跳过 quiet 请求、多模态请求与冲突工具', () => {
    const quietRes = rewriteChatCompletionBody(JSON.stringify({
        type: 'quiet',
        messages: [{ role: 'user', content: 'summarize' }],
    }), DEFAULT_CONFIG);
    assert.equal(quietRes.rewritten, false);
    assert.equal(quietRes.reason, 'quiet-request');

    const mediaRes = rewriteChatCompletionBody(JSON.stringify({
        messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] }],
    }), DEFAULT_CONFIG);
    assert.equal(mediaRes.rewritten, false);
    assert.equal(mediaRes.reason, 'multimodal-passthrough');

    const conflictRes = rewriteChatCompletionBody(JSON.stringify({
        tools: [{ type: 'function', function: { name: 'dispatch_stream_payload_34d98628087f3798' } }],
        messages: [{ role: 'user', content: 'hi' }],
    }), DEFAULT_CONFIG);
    assert.equal(conflictRes.rewritten, false);
    assert.equal(conflictRes.reason, 'conflicting-carrier-tool');
});

test('ToolCarrierStreamInterceptor - OpenAI SSE 方案 B 真流式剥壳并保留 reasoning_content', async () => {
    const interceptor = new ToolCarrierStreamInterceptor(DEFAULT_CONFIG);
    const resp = makeSseResponse([
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '思考一下剧情' }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '{"display_stream": "' }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '林岚推开木门，' }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '看见了机械猫发条。"}' }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
    ]);

    const wrapped = interceptor.wrapEventStreamResponse(resp, {
        mode: CARRIER_MODES.JSON_SCHEMA,
        toolName: 'dispatch_stream_payload',
        paramName: 'display_stream',
        clientToolNames: new Set(),
        isGemini: false,
    });

    const events = await readSseEvents(wrapped);
    const contentChunks = [];
    let reasoning = '';
    for (const ev of events) {
        if (ev === '[DONE]') continue;
        // 绝不能混入 Gemini candidates 字段导致平滑流式重复拼接
        assert.equal(ev.candidates, undefined);
        const delta = ev.choices?.[0]?.delta;
        if (delta?.reasoning_content) reasoning += delta.reasoning_content;
        if (delta?.content) contentChunks.push(delta.content);
    }

    assert.equal(reasoning, '思考一下剧情');
    assert.equal(contentChunks.length, 2);
    assert.equal(contentChunks.join(''), '林岚推开木门，看见了机械猫发条。');
});

test('ToolCarrierStreamInterceptor - Gemini SSE 方案 B 真流式剥壳并保留 thought 与 thoughtSignature', async () => {
    const interceptor = new ToolCarrierStreamInterceptor(DEFAULT_CONFIG);
    const resp = makeSseResponse([
        `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '内部思考', thought: true }] } }] })}\n\n`,
        `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '{"display_stream":"第一段' }] } }] })}\n\n`,
        `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '第二段"}' }] } }] })}\n\n`,
        `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '', thoughtSignature: 'sig-123' }] }, finishReason: 'STOP' }] })}\n\n`,
    ]);

    const wrapped = interceptor.wrapEventStreamResponse(resp, {
        mode: CARRIER_MODES.JSON_SCHEMA,
        toolName: 'dispatch_stream_payload',
        paramName: 'display_stream',
        clientToolNames: new Set(),
        isGemini: true,
    });

    const events = await readSseEvents(wrapped);
    let thoughts = '';
    let body = '';
    let sig = '';
    for (const ev of events) {
        assert.equal(ev.choices, undefined);
        for (const p of ev.candidates?.[0]?.content?.parts || []) {
            if (p.thought) thoughts += p.text;
            else if (p.text) body += p.text;
            if (p.thoughtSignature) sig = p.thoughtSignature;
        }
    }

    assert.equal(thoughts, '内部思考');
    assert.equal(body, '第一段第二段');
    assert.equal(sig, 'sig-123');
});

test('ToolCarrierStreamInterceptor - Gemini AUTO 模式偶发 functionCall 自动兜底并清理 delta.native', async () => {
    const interceptor = new ToolCarrierStreamInterceptor(DEFAULT_CONFIG);
    const resp = makeSseResponse([
        `data: ${JSON.stringify({
            candidates: [{
                index: 0,
                content: {
                    role: 'model',
                    parts: [{
                        functionCall: {
                            name: 'dispatch_stream_payload',
                            args: { display_stream: '兜底还原的正文内容' },
                        },
                        thoughtSignature: 'sig-fc',
                    }],
                },
            }],
        })}\n\n`,
        `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [] }, finishReason: 'STOP' }] })}\n\n`,
        `data: ${JSON.stringify({
            choices: [{
                index: 0,
                delta: {
                    native: {
                        gemini: {
                            content: {
                                role: 'model',
                                parts: [{
                                    functionCall: {
                                        name: 'dispatch_stream_payload',
                                        args: { display_stream: '兜底还原的正文内容' },
                                    },
                                    thoughtSignature: 'sig-fc',
                                }],
                            },
                        },
                    },
                },
            }],
        })}\n\n`,
    ]);

    const wrapped = interceptor.wrapEventStreamResponse(resp, {
        mode: CARRIER_MODES.JSON_SCHEMA,
        toolName: 'dispatch_stream_payload',
        paramName: 'display_stream',
        clientToolNames: new Set(),
        isGemini: true,
    });

    const events = await readSseEvents(wrapped);
    let body = '';
    let nativeParts = null;
    for (const ev of events) {
        for (const p of ev.candidates?.[0]?.content?.parts || []) {
            assert.equal(p.functionCall, undefined);
            if (p.text) body += p.text;
        }
        if (ev.choices?.[0]?.delta?.native) {
            nativeParts = ev.choices[0].delta.native.gemini.content.parts;
        }
    }

    assert.equal(body, '兜底还原的正文内容');
    assert.ok(Array.isArray(nativeParts));
    assert.equal(nativeParts[0].functionCall, undefined);
    assert.equal(nativeParts[0].text, '兜底还原的正文内容');
    assert.equal(nativeParts[0].thoughtSignature, 'sig-fc');
});

test('ToolCarrierStreamInterceptor - OpenAI 非流式 JSON 响应去壳', async () => {
    const interceptor = new ToolCarrierStreamInterceptor(DEFAULT_CONFIG);
    const mock = new Response(JSON.stringify({
        choices: [{
            index: 0,
            message: { role: 'assistant', content: JSON.stringify({ display_stream: '非流式正文' }) },
            finish_reason: 'stop',
        }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const wrapped = await interceptor.wrapJsonResponse(mock, {
        mode: CARRIER_MODES.JSON_SCHEMA,
        toolName: 'dispatch_stream_payload',
        paramName: 'display_stream',
        clientToolNames: new Set(),
        isGemini: false,
    });
    const json = await wrapped.json();
    assert.equal(json.choices[0].message.content, '非流式正文');
});

test('rewriteChatCompletionBody - 默认方案 C（单轮微 Tool Call）注入 tools(required) 与分段粒度指令', () => {
    const raw = JSON.stringify({
        chat_completion_source: 'custom',
        custom_api_format: 'openai_compat',
        model: 'gemini-4-argon',
        stream: true,
        messages: [
            { role: 'system', content: '世界观设定：霜星七号' },
            { role: 'user', content: '开始打捞任务' },
        ],
    });

    const res = rewriteChatCompletionBody(raw, {
        ...DEFAULT_CONFIG,
        chunkGranularity: CHUNK_GRANULARITIES.FAST,
    });
    assert.equal(res.rewritten, true);
    assert.equal(res.meta.mode, CARRIER_MODES.CHUNKED_TOOL_CALL);

    const parsed = JSON.parse(res.body);
    assert.equal(parsed.tool_choice, 'required');
    assert.equal(parsed.response_format, undefined);
    assert.equal(parsed.responseSchema, undefined);
    assert.equal(parsed.tools.length, 1);
    assert.ok(parsed.tools[0].function.description.includes('世界观设定：霜星七号'));
    assert.ok(parsed.messages[3].content.includes('40-80 characters'));
});

test('ToolCarrierStreamInterceptor - OpenAI SSE 方案 C 单轮多次微 tool_calls 实时逐段解包并转为 stop', async () => {
    const interceptor = new ToolCarrierStreamInterceptor(DEFAULT_CONFIG);
    const resp = makeSseResponse([
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'dispatch_stream_payload', arguments: JSON.stringify({ display_stream: '第一段正文，' }) } }] }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'dispatch_stream_payload', arguments: JSON.stringify({ display_stream: '第二段无缝衔接。\\n\\n' }) } }] }, finish_reason: null }] })}\n\n`,
        // 模拟部分反代复用 index=1 但切换新 call_id
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_3', type: 'function', function: { name: 'dispatch_stream_payload', arguments: JSON.stringify({ display_stream: '第三段收尾。' }) } }] }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
        'data: [DONE]\n\n',
    ]);

    const wrapped = interceptor.wrapEventStreamResponse(resp, {
        mode: CARRIER_MODES.CHUNKED_TOOL_CALL,
        toolName: 'dispatch_stream_payload',
        paramName: 'display_stream',
        clientToolNames: new Set(),
        isGemini: false,
    });

    const events = await readSseEvents(wrapped);
    const chunks = [];
    let finishReason = null;
    for (const ev of events) {
        if (ev === '[DONE]') continue;
        const ch = ev.choices?.[0];
        assert.equal(ch?.delta?.tool_calls, undefined);
        if (ch?.delta?.content) chunks.push(ch.delta.content);
        if (ch?.finish_reason) finishReason = ch.finish_reason;
    }

    assert.equal(chunks.length, 3);
    assert.equal(chunks.join(''), '第一段正文，第二段无缝衔接。\\n\\n第三段收尾。');
    assert.equal(finishReason, 'stop');
});

test('ToolCarrierStreamInterceptor - Gemini SSE 方案 C 多段 functionCall 顺序无缝输出', async () => {
    const interceptor = new ToolCarrierStreamInterceptor(DEFAULT_CONFIG);
    const resp = makeSseResponse([
        `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ functionCall: { name: 'dispatch_stream_payload', args: { display_stream: '秋雨如瓢泼，' } } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ functionCall: { name: 'dispatch_stream_payload', args: { display_stream: '秋雨如瓢泼，' } } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ functionCall: { name: 'dispatch_stream_payload', args: { display_stream: '客栈孤灯明灭。' } } }] }, finishReason: 'STOP' }] })}\n\n`,
    ]);

    const wrapped = interceptor.wrapEventStreamResponse(resp, {
        mode: CARRIER_MODES.CHUNKED_TOOL_CALL,
        toolName: 'dispatch_stream_payload',
        paramName: 'display_stream',
        clientToolNames: new Set(),
        isGemini: true,
    });

    const events = await readSseEvents(wrapped);
    const chunks = [];
    for (const ev of events) {
        for (const p of ev.candidates?.[0]?.content?.parts || []) {
            assert.equal(p.functionCall, undefined);
            if (p.text) chunks.push(p.text);
        }
    }

    assert.equal(chunks.length, 3);
    assert.equal(chunks.join(''), '秋雨如瓢泼，秋雨如瓢泼，客栈孤灯明灭。');
});

test('ToolCarrierStreamInterceptor - OpenAI 非流式 JSON 方案 C 多段 tool_calls 无缝拼接', async () => {
    const interceptor = new ToolCarrierStreamInterceptor(DEFAULT_CONFIG);
    const mock = new Response(JSON.stringify({
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                    { id: 'c1', type: 'function', function: { name: 'dispatch_stream_payload', arguments: JSON.stringify({ display_stream: '前半句，' }) } },
                    { id: 'c2', type: 'function', function: { name: 'dispatch_stream_payload', arguments: JSON.stringify({ display_stream: '后半句。' }) } },
                ],
            },
            finish_reason: 'tool_calls',
        }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });

    const wrapped = await interceptor.wrapJsonResponse(mock, {
        mode: CARRIER_MODES.CHUNKED_TOOL_CALL,
        toolName: 'dispatch_stream_payload',
        paramName: 'display_stream',
        clientToolNames: new Set(),
        isGemini: false,
    });
    const json = await wrapped.json();
    assert.equal(json.choices[0].message.content, '前半句，后半句。');
    assert.equal(json.choices[0].message.tool_calls, undefined);
    assert.equal(json.choices[0].finish_reason, 'stop');
});
