/**
 * @file extractors.js
 * 增量流式去壳提取器：
 * 1. JsonFieldStreamExtractor   —— 实时从 JSON 流（或 tool_calls arguments 片段）提取指定字符串字段值；
 * 2. PythonScriptStreamExtractor —— 实时从 Python 脚本流（def ... / var = """..."""）剥壳提取三引号内正文；
 * 3. normalizeStreamText        —— 清理模型偶发的控制标记（如 <ctrl94> / <ctrl95>）。
 */

const JSON_STATE = Object.freeze({
    WAITING_FOR_KEY: 0,
    IN_STRING: 1,
    IN_ESCAPE: 2,
    IN_UNICODE_HEX: 3,
    IN_UNICODE_BRACED: 4,
    COMPLETED: 5,
    PASSTHROUGH: 6,
});

const SIMPLE_ESCAPES = Object.freeze({
    '"': '"',
    '\\': '\\',
    '/': '/',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
});

/**
 * 清理模型输出中偶发的内控标签
 * @param {string} text
 * @returns {string}
 */
export function normalizeStreamText(text) {
    if (typeof text !== 'string' || !text) {
        return '';
    }
    return text
        .replace(/<ctrl95>/gi, '</thinking>\n')
        .replace(/<ctrl94>/gi, '<thinking>\n')
        .replace(/<ctrl\d+>/gi, '');
}

/**
 * 增量流式 JSON 字符串字段提取器。
 * 既用于方案 B（Structured Output JSON 真流式去壳），也用于兜底解码 OpenAI tool_calls arguments。
 */
export class JsonFieldStreamExtractor {
    /**
     * @param {object} [options]
     * @param {string} [options.targetField='display_stream']
     * @param {string[]} [options.fallbackFields]
     * @param {boolean} [options.allowPassthrough=true] 若开头明确不是 JSON（模型无视 schema 直接输出正文），则降级原样透传
     */
    constructor(options = {}) {
        this.targetField = options.targetField || 'display_stream';
        this.fallbackFields = Array.isArray(options.fallbackFields)
            ? options.fallbackFields
            : ['display_stream', 'content', 'story_content', 'text', 'response'];
        this.allowPassthrough = options.allowPassthrough !== false;
        this.reset();
    }

    reset() {
        this.state = JSON_STATE.WAITING_FOR_KEY;
        this.headerBuffer = '';
        this.unicodeBuffer = '';
        this.pendingHighSurrogate = null;
        this.emittedAny = false;
        this.isDone = false;
    }

    /**
     * 查找起始键与起始双引号位置
     * @param {string} buf
     * @returns {number} 内容起始偏移，未匹配返回 -1
     */
    #findValueStart(buf) {
        const names = [this.targetField, ...this.fallbackFields.filter(k => k !== this.targetField)];
        for (const name of names) {
            if (!name) continue;
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pattern = new RegExp(`"(?:\\\\")?${escaped}(?:\\\\")?"\\s*:\\s*"`, 'g');
            const match = pattern.exec(buf);
            if (match) {
                return match.index + match[0].length;
            }
        }
        return -1;
    }

    /**
     * 判断当前头部缓冲是否明显不是 JSON（允许前置空白、```json 围栏或 { ）
     * @param {string} buf
     * @returns {boolean}
     */
    #looksDefinitelyNonJson(buf) {
        const stripped = buf.replace(/^\s*(?:```(?:json)?\s*)?/i, '');
        if (!stripped) return false;
        const first = stripped[0];
        if (first === '{' || first === '"') {
            return false;
        }
        // 可能仍在等待 ```json 围栏补全
        if (first === '`' && stripped.length < 12) {
            return false;
        }
        return stripped.length >= 6;
    }

    /**
     * 喂入增量片段，返回实时解出的正文增量
     * @param {string} chunk
     * @returns {string}
     */
    feed(chunk) {
        if (typeof chunk !== 'string' || !chunk || this.isDone) {
            return '';
        }

        if (this.state === JSON_STATE.PASSTHROUGH) {
            this.emittedAny = true;
            return normalizeStreamText(chunk);
        }

        let source = chunk;
        if (this.state === JSON_STATE.WAITING_FOR_KEY) {
            this.headerBuffer += chunk;
            const startIdx = this.#findValueStart(this.headerBuffer);
            if (startIdx !== -1) {
                source = this.headerBuffer.slice(startIdx);
                this.headerBuffer = '';
                this.state = JSON_STATE.IN_STRING;
            } else {
                if (this.allowPassthrough && (this.#looksDefinitelyNonJson(this.headerBuffer) || this.headerBuffer.length > 160)) {
                    const passthrough = this.headerBuffer;
                    this.headerBuffer = '';
                    this.state = JSON_STATE.PASSTHROUGH;
                    this.emittedAny = true;
                    return normalizeStreamText(passthrough);
                }
                return '';
            }
        }

        let out = '';
        for (let i = 0; i < source.length; i++) {
            const ch = source[i];
            if (this.state === JSON_STATE.IN_STRING) {
                if (ch === '\\') {
                    this.state = JSON_STATE.IN_ESCAPE;
                } else if (ch === '"') {
                    out += this.#flushPendingSurrogate();
                    this.state = JSON_STATE.COMPLETED;
                    this.isDone = true;
                    break;
                } else {
                    out += this.#flushPendingSurrogate();
                    out += ch;
                }
            } else if (this.state === JSON_STATE.IN_ESCAPE) {
                if (ch === 'u') {
                    this.state = JSON_STATE.IN_UNICODE_HEX;
                    this.unicodeBuffer = '';
                } else if (Object.hasOwn(SIMPLE_ESCAPES, ch)) {
                    out += this.#flushPendingSurrogate();
                    out += SIMPLE_ESCAPES[ch];
                    this.state = JSON_STATE.IN_STRING;
                } else {
                    out += this.#flushPendingSurrogate();
                    out += ch;
                    this.state = JSON_STATE.IN_STRING;
                }
            } else if (this.state === JSON_STATE.IN_UNICODE_HEX) {
                if (ch === '{' && this.unicodeBuffer.length === 0) {
                    this.state = JSON_STATE.IN_UNICODE_BRACED;
                    continue;
                }
                if (/^[0-9a-fA-F]$/.test(ch)) {
                    this.unicodeBuffer += ch;
                    if (this.unicodeBuffer.length === 4) {
                        out += this.#emitCodeUnit(parseInt(this.unicodeBuffer, 16));
                        this.unicodeBuffer = '';
                        this.state = JSON_STATE.IN_STRING;
                    }
                } else {
                    out += this.#flushPendingSurrogate();
                    out += '\\u' + this.unicodeBuffer + ch;
                    this.unicodeBuffer = '';
                    this.state = JSON_STATE.IN_STRING;
                }
            } else if (this.state === JSON_STATE.IN_UNICODE_BRACED) {
                if (ch === '}') {
                    out += this.#flushPendingSurrogate();
                    const cp = parseInt(this.unicodeBuffer, 16);
                    if (Number.isFinite(cp) && cp >= 0 && cp <= 0x10FFFF) {
                        out += String.fromCodePoint(cp);
                    }
                    this.unicodeBuffer = '';
                    this.state = JSON_STATE.IN_STRING;
                } else if (/^[0-9a-fA-F]$/.test(ch) && this.unicodeBuffer.length < 6) {
                    this.unicodeBuffer += ch;
                } else {
                    out += this.#flushPendingSurrogate();
                    out += '\\u{' + this.unicodeBuffer + ch;
                    this.unicodeBuffer = '';
                    this.state = JSON_STATE.IN_STRING;
                }
            }
        }

        if (out) {
            this.emittedAny = true;
        }
        return normalizeStreamText(out);
    }

    /**
     * 流结束时刷新残留状态
     * @returns {string}
     */
    flush() {
        let out = '';
        if (this.state === JSON_STATE.WAITING_FOR_KEY && this.headerBuffer) {
            if (this.allowPassthrough) {
                out = this.headerBuffer;
            }
            this.headerBuffer = '';
        } else {
            out += this.#flushPendingSurrogate();
        }
        this.isDone = true;
        return normalizeStreamText(out);
    }

    #emitCodeUnit(unit) {
        if (unit >= 0xD800 && unit <= 0xDBFF) {
            const prev = this.#flushPendingSurrogate();
            this.pendingHighSurrogate = unit;
            return prev;
        }
        if (unit >= 0xDC00 && unit <= 0xDFFF && this.pendingHighSurrogate !== null) {
            const high = this.pendingHighSurrogate;
            this.pendingHighSurrogate = null;
            return String.fromCharCode(high, unit);
        }
        const prev = this.#flushPendingSurrogate();
        return prev + String.fromCharCode(unit);
    }

    #flushPendingSurrogate() {
        if (this.pendingHighSurrogate === null) {
            return '';
        }
        const s = String.fromCharCode(this.pendingHighSurrogate);
        this.pendingHighSurrogate = null;
        return s;
    }
}

const PY_STATE = Object.freeze({
    WAITING_FOR_OPEN: 0,
    IN_TRIPLE_STRING: 1,
    COMPLETED: 2,
    PASSTHROUGH: 3,
});

/**
 * 增量流式 Python 脚本去壳提取器（方案 A）。
 * 自动剥离 ```python / def ...(): / payload = """ ... """ / return payload / ``` 外壳，
 * 实时逐块输出三引号内部的正文。
 */
export class PythonScriptStreamExtractor {
    /**
     * @param {object} [options]
     * @param {boolean} [options.allowPassthrough=true]
     */
    constructor(options = {}) {
        this.allowPassthrough = options.allowPassthrough !== false;
        this.reset();
    }

    reset() {
        this.state = PY_STATE.WAITING_FOR_OPEN;
        this.headerBuffer = '';
        this.quoteDelimiter = '"""';
        this.tailBuffer = '';
        this.emittedAny = false;
        this.isDone = false;
    }

    /**
     * 匹配起始三引号（如 payload = """ / story = r''' / return """）
     * @param {string} buf
     * @returns {{ index: number, delimiter: string } | null}
     */
    #findOpeningDelimiter(buf) {
        const match = /(?:[a-zA-Z_][a-zA-Z0-9_]*\s*=\s*|return\s+)[rRuUfF]{0,2}("""|''')/.exec(buf);
        if (!match) {
            return null;
        }
        return {
            index: match.index + match[0].length,
            delimiter: match[1],
        };
    }

    /**
     * 判断头部是否明显不是 Python 代码块/函数壳
     * @param {string} buf
     * @returns {boolean}
     */
    #looksDefinitelyNonPython(buf) {
        const trimmed = buf.trimStart();
        if (trimmed.length < 24) return false;
        if (/^(?:```|def\s|class\s|#|import\s|from\s|[a-zA-Z_][a-zA-Z0-9_]*\s*=|return\s)/.test(trimmed)) {
            return false;
        }
        return true;
    }

    /**
     * @param {string} chunk
     * @returns {string}
     */
    feed(chunk) {
        if (typeof chunk !== 'string' || !chunk || this.isDone) {
            return '';
        }

        if (this.state === PY_STATE.PASSTHROUGH) {
            this.emittedAny = true;
            return normalizeStreamText(chunk);
        }

        let bodyChunk = chunk;
        if (this.state === PY_STATE.WAITING_FOR_OPEN) {
            this.headerBuffer += chunk;
            const found = this.#findOpeningDelimiter(this.headerBuffer);
            if (found) {
                this.quoteDelimiter = found.delimiter;
                bodyChunk = this.headerBuffer.slice(found.index);
                // 去掉三引号后紧跟的首个换行（若模型写了 """\n正文）
                if (bodyChunk.startsWith('\r\n')) bodyChunk = bodyChunk.slice(2);
                else if (bodyChunk.startsWith('\n')) bodyChunk = bodyChunk.slice(1);
                this.headerBuffer = '';
                this.state = PY_STATE.IN_TRIPLE_STRING;
            } else {
                if (this.allowPassthrough && (this.#looksDefinitelyNonPython(this.headerBuffer) || this.headerBuffer.length > 260)) {
                    const raw = this.headerBuffer;
                    this.headerBuffer = '';
                    this.state = PY_STATE.PASSTHROUGH;
                    this.emittedAny = true;
                    return normalizeStreamText(raw);
                }
                return '';
            }
        }

        if (this.state === PY_STATE.IN_TRIPLE_STRING) {
            const combined = this.tailBuffer + bodyChunk;
            const closeIdx = combined.indexOf(this.quoteDelimiter);
            if (closeIdx !== -1) {
                const emitted = combined.slice(0, closeIdx);
                this.tailBuffer = '';
                this.state = PY_STATE.COMPLETED;
                this.isDone = true;
                if (emitted) this.emittedAny = true;
                return normalizeStreamText(emitted);
            }

            // 保留末尾 2 个字符作为滑动窗口，避免三引号跨 chunk 被截断漏匹配
            const holdLen = this.quoteDelimiter.length - 1;
            if (combined.length > holdLen) {
                const safeOut = combined.slice(0, combined.length - holdLen);
                this.tailBuffer = combined.slice(combined.length - holdLen);
                if (safeOut) this.emittedAny = true;
                return normalizeStreamText(safeOut);
            }
            this.tailBuffer = combined;
            return '';
        }

        return '';
    }

    /**
     * @returns {string}
     */
    flush() {
        let out = '';
        if (this.state === PY_STATE.WAITING_FOR_OPEN && this.headerBuffer) {
            if (this.allowPassthrough) {
                out = this.headerBuffer;
            }
            this.headerBuffer = '';
        } else if (this.state === PY_STATE.IN_TRIPLE_STRING && this.tailBuffer) {
            out = this.tailBuffer;
            this.tailBuffer = '';
        }
        this.isDone = true;
        return normalizeStreamText(out);
    }
}
