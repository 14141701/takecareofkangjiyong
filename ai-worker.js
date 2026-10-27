// All model downloads and inference happen in this browser worker, never on a server.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

env.allowLocalModels = false;
// GitHub Pages does not provide the isolation headers required for WASM threads.
env.backends.onnx.wasm.numThreads = 1;

const MODEL = 'HuggingFaceTB/SmolLM-135M-Instruct';
const REVISION = 'fcc320f490e08fdb4b99d935b2c58d40bf35b0d0';
let generatorPromise;
let busy = false;

function getGenerator(id) {
  if (!generatorPromise) {
    generatorPromise = pipeline('text-generation', MODEL, {
      revision: REVISION,
      device: 'wasm',
      dtype: 'q8',
      progress_callback: progress => self.postMessage({ type: 'progress', id, progress }),
    }).catch(error => {
      generatorPromise = null;
      throw error;
    });
  }
  return generatorPromise;
}

self.addEventListener('message', async ({ data }) => {
  const { id, type } = data;
  if (busy || !['load', 'generate'].includes(type)) return;
  busy = true;
  try {
    const generator = await getGenerator(id);
    if (type === 'load') {
      self.postMessage({ type: 'ready', id });
      return;
    }
    // A short, plain prompt works better than a JSON contract for a 135M model.
    // Game facts remain visible in Korean in the UI, regardless of narration quality.
    const messages = [{
      role: 'user',
      content: `In a fictional life simulation, Jiyong attempted this action: ${data.actionName}. ` +
        `The game recorded these actual changes: ${data.statChanges}. ` +
        `${data.gameOver ? 'The game ended. ' : ''}` +
        'Describe the result in one short sentence. Do not invent other rewards.',
    }];
    const output = await generator(messages, {
      max_new_tokens: 64,
      do_sample: false,
      repetition_penalty: 1.15,
      return_full_text: false,
    });
    const generated = output[0]?.generated_text;
    const text = typeof generated === 'string'
      ? generated.trim()
      : generated?.at(-1)?.content?.trim();
    if (!text) throw new Error('모델이 빈 응답을 반환했습니다.');
    self.postMessage({ type: 'complete', id, text: text.split(/(?<=[.!?。！？])\s+/u).slice(0, 2).join(' ') });
  } catch (error) {
    self.postMessage({ type: 'error', id, message: String(error.message || error) });
  } finally {
    busy = false;
  }
});
