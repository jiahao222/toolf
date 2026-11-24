import test from 'node:test';
import assert from 'node:assert/strict';
import {
    JsonFieldStreamExtractor,
    PythonScriptStreamExtractor,
    normalizeStreamText,
} from '../extractors.js';

test('JsonFieldStreamExtractor - 实时跨 chunk 提取字段、转义字符与 emoji 代理对', () => {
    const ex = new JsonFieldStreamExtractor({ targetField: 'display_stream' });
    const chunks = [
        '{"dis',
        'play_stream": "铁翼港的黄昏\\',
        'n林岚说：\\"你好\\uD83D',
        '\\uDE80\\"，随后转身。"}',
        '   ',
    ];

    const outputs = chunks.map(c => ex.feed(c));
    const tail = ex.flush();

    // 确认在收完之前已经产生增量输出（真流式）
    assert.ok(outputs[1].includes('铁翼港的黄昏'));
    assert.equal(outputs.join('') + tail, '铁翼港的黄昏\n林岚说："你好🚀"，随后转身。');
});

test('JsonFieldStreamExtractor - 兼容带 ```json 围栏的 JSON 输出', () => {
    const ex = new JsonFieldStreamExtractor({ targetField: 'display_stream' });
    const chunks = ['```json\n{\n  "display_stream": "第一段', '\\n第二段"\n}\n```'];
    const result = chunks.map(c => ex.feed(c)).join('') + ex.flush();
    assert.equal(result, '第一段\n第二段');
});

test('JsonFieldStreamExtractor - 模型无视 Schema 直接吐普通正文时自动降级透传', () => {
    const ex = new JsonFieldStreamExtractor({ targetField: 'display_stream' });
    const chunks = ['<thinking>先构思</thinking>\n', '普通正文内容不会被吞掉。'];
    const result = chunks.map(c => ex.feed(c)).join('') + ex.flush();
    assert.equal(result, '<thinking>先构思</thinking>\n普通正文内容不会被吞掉。');
});

test('PythonScriptStreamExtractor - 实时剥离 Python 函数与跨块三引号外壳', () => {
    const ex = new PythonScriptStreamExtractor();
    const chunks = [
        '```python\ndef render_output():\n    display_stream = """\n',
        '第一句台词：',
        '“欢迎来到铁翼港。”',
        '结束前"',
        '""\n    return display_stream\n```',
    ];

    const outputs = chunks.map(c => ex.feed(c));
    const tail = ex.flush();

    assert.equal(outputs[0], '');
    assert.ok(outputs[1].length > 0);
    assert.equal(outputs.join('') + tail, '第一句台词：“欢迎来到铁翼港。”结束前');
});

test('PythonScriptStreamExtractor - 支持 r\'\'\' 原始三单引号与普通文本透传', () => {
    const ex1 = new PythonScriptStreamExtractor();
    const res1 = ex1.feed("story = r'''\n原始正文内容\n'''\nprint(story)") + ex1.flush();
    assert.equal(res1, '原始正文内容\n');

    const ex2 = new PythonScriptStreamExtractor();
    const res2 = ex2.feed('这是一段完全没有 Python 外壳的普通长文本回复，应当直接原样显示出来。') + ex2.flush();
    assert.equal(res2, '这是一段完全没有 Python 外壳的普通长文本回复，应当直接原样显示出来。');
});

test('normalizeStreamText - 清理 ctrl 控制标记', () => {
    assert.equal(normalizeStreamText('<ctrl94>思考<ctrl95>正文<ctrl99>'), '<thinking>\n思考</thinking>\n正文');
});
