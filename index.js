/**
 * @file index.js
 * ToolCarrier 真流式助手 - 扩展主入口
 */

import {
    ToolCarrierStreamInterceptor,
    CARRIER_MODES,
    CHUNK_GRANULARITIES,
    DEFAULT_CONFIG,
} from './fetch-interceptor.js';

const STORAGE_NAMESPACE = 'tool_carrier_streamer';

/** @type {ToolCarrierStreamInterceptor | null} */
let interceptor = null;
let uiMounted = false;

let currentSettings = { ...DEFAULT_CONFIG };

function escapeAttr(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

async function loadSettings() {
    try {
        if (window.__TAURITAVERN__?.api?.extension?.store) {
            const store = window.__TAURITAVERN__.api.extension.store;
            const res = await store.tryGetJson({
                namespace: STORAGE_NAMESPACE,
                key: 'settings',
            });
            if (res.found && res.value) {
                currentSettings = { ...DEFAULT_CONFIG, ...res.value };
                return;
            }
        }

        const stored = localStorage.getItem(`tauritavern_${STORAGE_NAMESPACE}_settings`);
        if (stored) {
            currentSettings = { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
        }
    } catch (e) {
        console.warn('[ToolCarrierStreamer] 读取配置失败，采用默认值:', e);
    }
}

async function saveSettings() {
    try {
        if (window.__TAURITAVERN__?.api?.extension?.store) {
            const store = window.__TAURITAVERN__.api.extension.store;
            await store.setJson({
                namespace: STORAGE_NAMESPACE,
                key: 'settings',
                value: currentSettings,
            });
        }
        localStorage.setItem(`tauritavern_${STORAGE_NAMESPACE}_settings`, JSON.stringify(currentSettings));
    } catch (e) {
        console.warn('[ToolCarrierStreamer] 保存配置失败:', e);
    }
}

function getModeDescription(mode) {
    if (mode === CARRIER_MODES.CHUNKED_TOOL_CALL) {
        return '推荐（真工具 + 真流式）：tools(required) 强制走真正 tool_calls，并在同 1 次请求内让模型连续发起多次短段 tool_calls 实时下发，前端逐段无缝拼接并转为 stop，严格仅 1 次 API 调用。';
    }
    if (mode === CARRIER_MODES.PYTHON_SCRIPT) {
        return 'tools(AUTO) 承载全部提示词，让模型在正文流输出 Python 脚本三引号字符串，前端实时剥离 def / 变量 / return 外壳。';
    }
    if (mode === CARRIER_MODES.TOOL_CALL) {
        return '传统单次 tool_choice=required 模式，适合 Vertex AI / Claude / OpenAI 等原生支持 partialArgs / 流式 tool_calls 的渠道。';
    }
    return 'tools(AUTO) 承载全部提示词 + Structured Output JSON Schema 约束解码，走正文流实时剥壳并自动兜底偶发 tool_call。';
}

function mountSettingsUI() {
    if (uiMounted) {
        return;
    }
    const container = document.getElementById('extensions_settings');
    if (!container || document.getElementById('tcs-settings-drawer')) {
        return;
    }
    uiMounted = true;

    const drawerHtml = `
    <div id="tcs-settings-drawer" class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>🚀 ToolCarrier 真流式助手</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="tcs-settings-container">
                <div class="tcs-header">
                    <h4>
                        <span class="fa-solid fa-wave-square"></span>
                        工具承载与流式剥壳
                    </h4>
                    <span id="tcs-status-indicator" class="tcs-status-badge ${currentSettings.enabled ? '' : 'disabled'}">
                        <span class="tcs-status-dot"></span>
                        <span class="tcs-status-text">${currentSettings.enabled ? '已激活' : '未启用'}</span>
                    </span>
                </div>

                <div class="tcs-form-group">
                    <label class="tcs-checkbox-label">
                        <input type="checkbox" id="tcs-enabled-checkbox" ${currentSettings.enabled ? 'checked' : ''}>
                        <span>启用 ToolCarrier 真流式拦截</span>
                    </label>
                    <div class="description">自动把提示词装入工具声明并开启真流式外壳剥离，每轮严格仅调用 1 次 API</div>
                </div>

                <div class="tcs-form-group">
                    <label for="tcs-mode-select">输出承载模式</label>
                    <select id="tcs-mode-select" class="tcs-select">
                        <option value="${CARRIER_MODES.CHUNKED_TOOL_CALL}" ${currentSettings.mode === CARRIER_MODES.CHUNKED_TOOL_CALL ? 'selected' : ''}>方案 C：单轮微 Tool Call 分段真流式（推荐）</option>
                        <option value="${CARRIER_MODES.JSON_SCHEMA}" ${currentSettings.mode === CARRIER_MODES.JSON_SCHEMA ? 'selected' : ''}>方案 B：JSON Schema 真流式</option>
                        <option value="${CARRIER_MODES.PYTHON_SCRIPT}" ${currentSettings.mode === CARRIER_MODES.PYTHON_SCRIPT ? 'selected' : ''}>方案 A：Python 脚本真流式去壳</option>
                        <option value="${CARRIER_MODES.TOOL_CALL}" ${currentSettings.mode === CARRIER_MODES.TOOL_CALL ? 'selected' : ''}>兼容模式：单次强制 Tool Call</option>
                    </select>
                    <div id="tcs-mode-desc" class="description" style="margin-top: 6px;">${getModeDescription(currentSettings.mode)}</div>
                </div>

                <div class="tcs-form-group" id="tcs-granularity-group" style="display: ${currentSettings.mode === CARRIER_MODES.CHUNKED_TOOL_CALL ? 'block' : 'none'};">
                    <label for="tcs-granularity-select">微 Tool Call 分段粒度</label>
                    <select id="tcs-granularity-select" class="tcs-select">
                        <option value="${CHUNK_GRANULARITIES.FAST}" ${currentSettings.chunkGranularity === CHUNK_GRANULARITIES.FAST ? 'selected' : ''}>快响应（40~80 字/段，首段最快）</option>
                        <option value="${CHUNK_GRANULARITIES.BALANCED}" ${currentSettings.chunkGranularity === CHUNK_GRANULARITIES.BALANCED ? 'selected' : ''}>均衡（80~150 字/段，推荐）</option>
                        <option value="${CHUNK_GRANULARITIES.LONG}" ${currentSettings.chunkGranularity === CHUNK_GRANULARITIES.LONG ? 'selected' : ''}>长文稳态（150~250 字/段，适合 3000+ 字）</option>
                    </select>
                    <div class="description" style="margin-top: 6px;">长文建议选「均衡」或「长文稳态」，避免单轮调用次数过多导致后半段被模型合并</div>
                </div>

                <div class="tcs-form-group">
                    <label for="tcs-tool-name">承载工具名</label>
                    <div class="description">用于挂载上下文说明的虚拟工具名称（支持任意合法标识符）</div>
                    <input type="text" id="tcs-tool-name" class="tcs-input-text" value="${escapeAttr(currentSettings.toolName)}">
                </div>

                <div class="tcs-form-group">
                    <label for="tcs-param-name">输出字段 / 变量名</label>
                    <div class="description">JSON Schema 字段名或 Python 变量名，默认 display_stream</div>
                    <input type="text" id="tcs-param-name" class="tcs-input-text" value="${escapeAttr(currentSettings.paramName)}">
                </div>

                <div class="tcs-form-group">
                    <label class="tcs-checkbox-label">
                        <input type="checkbox" id="tcs-consume-checkbox" ${currentSettings.consumeToolCalls ? 'checked' : ''}>
                        <span>自动兜底并消费偶发 Tool Call（推荐）</span>
                    </label>
                    <div class="description">若模型偶尔仍触发工具调用，自动还原为普通文本并转为 stop，不触发第二轮请求</div>
                </div>

                <div class="tcs-form-group">
                    <label class="tcs-checkbox-label">
                        <input type="checkbox" id="tcs-skip-quiet-checkbox" ${currentSettings.skipQuietRequests ? 'checked' : ''}>
                        <span>跳过后台静默请求（quiet / 总结任务）</span>
                    </label>
                </div>

                <div class="tcs-form-group">
                    <label class="tcs-checkbox-label">
                        <input type="checkbox" id="tcs-entropy-checkbox" ${currentSettings.addEntropyPadding ? 'checked' : ''}>
                        <span>附加随机熵锚点（防重复缓存）</span>
                    </label>
                </div>

                <div class="tcs-hint-box">
                    <strong>使用提示：</strong>如果使用 Ny-Gemini 等自带工具越狱脚本的预设，请先在预设条目中关闭 <code>🔑Ny-超强越狱</code>，避免两套拦截器重复套壳。
                </div>
            </div>
        </div>
    </div>
    `;

    container.insertAdjacentHTML('beforeend', drawerHtml);

    // 抽屉展开/收起交由酒馆全局 $(document).on('click', '.inline-drawer-toggle') 统一接管，
    // 避免自定义 click 监听器先改成 block 后又被全局委托立刻判定为“已展开”而闪退收起。
    const enabledCheckbox = document.getElementById('tcs-enabled-checkbox');
    const modeSelect = document.getElementById('tcs-mode-select');
    const modeDesc = document.getElementById('tcs-mode-desc');
    const granularityGroup = document.getElementById('tcs-granularity-group');
    const granularitySelect = document.getElementById('tcs-granularity-select');
    const toolNameInput = document.getElementById('tcs-tool-name');
    const paramNameInput = document.getElementById('tcs-param-name');
    const consumeCheckbox = document.getElementById('tcs-consume-checkbox');
    const skipQuietCheckbox = document.getElementById('tcs-skip-quiet-checkbox');
    const entropyCheckbox = document.getElementById('tcs-entropy-checkbox');
    const statusIndicator = document.getElementById('tcs-status-indicator');
    const statusText = statusIndicator.querySelector('.tcs-status-text');

    const updateState = async () => {
        currentSettings = {
            enabled: enabledCheckbox.checked,
            mode: modeSelect.value,
            chunkGranularity: granularitySelect.value || DEFAULT_CONFIG.chunkGranularity,
            toolName: toolNameInput.value.trim() || DEFAULT_CONFIG.toolName,
            paramName: paramNameInput.value.trim() || DEFAULT_CONFIG.paramName,
            consumeToolCalls: consumeCheckbox.checked,
            skipQuietRequests: skipQuietCheckbox.checked,
            addEntropyPadding: entropyCheckbox.checked,
        };

        modeDesc.textContent = getModeDescription(currentSettings.mode);
        granularityGroup.style.display = currentSettings.mode === CARRIER_MODES.CHUNKED_TOOL_CALL ? 'block' : 'none';
        statusIndicator.classList.toggle('disabled', !currentSettings.enabled);
        statusText.textContent = currentSettings.enabled ? '已激活' : '未启用';

        interceptor?.updateConfig(currentSettings);
        await saveSettings();
    };

    enabledCheckbox.addEventListener('change', updateState);
    modeSelect.addEventListener('change', updateState);
    granularitySelect.addEventListener('change', updateState);
    toolNameInput.addEventListener('change', updateState);
    paramNameInput.addEventListener('change', updateState);
    consumeCheckbox.addEventListener('change', updateState);
    skipQuietCheckbox.addEventListener('change', updateState);
    entropyCheckbox.addEventListener('change', updateState);
}

export async function init() {
    await loadSettings();

    interceptor = new ToolCarrierStreamInterceptor(currentSettings);
    interceptor.install();

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', mountSettingsUI, { once: true });
    } else {
        mountSettingsUI();
    }

    try {
        const ctx = window.SillyTavern?.getContext?.();
        if (ctx?.eventSource && ctx?.event_types?.APP_READY) {
            ctx.eventSource.on(ctx.event_types.APP_READY, mountSettingsUI);
        }
    } catch {
        // Ignore if SillyTavern context is not mounted yet.
    }

    console.log('[ToolCarrierStreamer] 插件初始化完成');
}

if (typeof window !== 'undefined') {
    init().catch(err => console.error('[ToolCarrierStreamer] 初始化异常:', err));
}
