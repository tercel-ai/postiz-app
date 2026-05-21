import { pipeline } from '@xenova/transformers';

async function download() {
    console.log('start downloading...');
    await pipeline('zero-shot-classification', 'Xenova/nli-deberta-v3-small', {
        quantized: true
    });
    console.log('downloaded');
}

download();