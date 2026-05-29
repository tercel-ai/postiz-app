import Module from 'module';
import path from 'path';

// Intercept 'sharp' before @xenova/transformers loads it.
// We must catch both bare `require('sharp')` and relative subpath requires
// (e.g. `require('./sharp')` inside sharp/lib/utility.js). The previous
// request-string-only check missed those. Now we also resolve the path and
// check whether it lands inside any sharp package directory.
const SHARP_STUB_ID = path.resolve(__dirname, '__sharp_stub__');

const mockSharp: any = function () {
    return { toFormat: () => ({ toBuffer: () => Promise.resolve(Buffer.alloc(0)) }) };
};
mockSharp.cache = () => {};
mockSharp.format = () => ({});
mockSharp.versions = {};
mockSharp.queue = { on: () => {} };

require.cache[SHARP_STUB_ID] = {
    id: SHARP_STUB_ID,
    filename: SHARP_STUB_ID,
    loaded: true,
    exports: mockSharp,
    children: [],
    paths: [],
    parent: null,
} as any;

const SHARP_RE = /[/\\]node_modules[/\\](?:.*[/\\])?sharp[/\\]/;

const _original = (Module as any)._resolveFilename.bind(Module);
(Module as any)._resolveFilename = function (request: string, parent: any, ...rest: any[]) {
    // Fast path: request string already looks like sharp
    if (request === 'sharp' || request.startsWith('sharp/') || SHARP_RE.test(request)) {
        return SHARP_STUB_ID;
    }
    // Slow path: resolve the real path and check if it falls inside a sharp package
    const resolved: string = _original(request, parent, ...rest);
    if (SHARP_RE.test(resolved)) return SHARP_STUB_ID;
    return resolved;
};

async function download() {
    console.log('--- 开始预下载 Engage 模块 NLP 模型 (ONNX INT8) ---');
    try {
        // Dynamic require so the Module hook is already in place when transformers loads.
        const { pipeline, env } = require('@xenova/transformers') as typeof import('@xenova/transformers');

        // 如果服务器在国内，取消下面这一行的注释以使用镜像加速
        // env.remoteHost = 'https://hf-mirror.com';

        const start = Date.now();
        await pipeline('zero-shot-classification', 'Xenova/nli-deberta-v3-small', {
            quantized: true,
        });

        const duration = ((Date.now() - start) / 1000).toFixed(2);
        console.log(`✅ 成功！模型已缓存至 ~/.cache/huggingface/ (耗时: ${duration}s)`);
        process.exit(0);
    } catch (err) {
        console.error('❌ 下载失败，请检查网络连接：', err);
        process.exit(1);
    }
}

download();
