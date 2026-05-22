// Bypass sharp dependency before ANY imports
(global as any).sharp = () => ({
    toFormat: () => ({
        toBuffer: () => Promise.resolve(Buffer.alloc(0))
    })
});

// Also try to mock it in the require cache if it's already there
try {
    const mockSharp = (global as any).sharp;
    require.cache[require.resolve('sharp')] = {
        id: require.resolve('sharp'),
        filename: require.resolve('sharp'),
        loaded: true,
        exports: mockSharp
    } as any;
} catch (e) {}

import { pipeline, env } from '@xenova/transformers';

// 如果服务器在国内，取消下面这一行的注释以使用镜像加速
// env.remoteHost = 'https://hf-mirror.com';

async function download() {
    console.log('--- 开始预下载 Engage 模块 NLP 模型 (ONNX INT8) ---');
    try {
        const start = Date.now();
        
        // 1. 下载并初始化 Pipeline
        await pipeline('zero-shot-classification', 'Xenova/nli-deberta-v3-small', {
            quantized: true
        });
        
        const duration = ((Date.now() - start) / 1000).toFixed(2);
        console.log(`✅ 成功！模型已缓存至 ~/.cache/huggingface/ (耗时: ${duration}s)`);
        
        // 显式退出，防止部分环境下进程挂起
        process.exit(0);
    } catch (err) {
        console.error('❌ 下载失败，请检查网络连接：', err);
        process.exit(1);
    }
}

download();
