import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const root = new URL('../', import.meta.url);
const [html, uiSource, workerSource] = await Promise.all([
  readFile(new URL('index.html', root), 'utf8'),
  readFile(new URL('ai.js', root), 'utf8'),
  readFile(new URL('ai-worker.js', root), 'utf8'),
]);
const gameSource = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function setup(t, initialMode = 'success') {
  const dom = new JSDOM(html, { url: 'https://example.test/game/', runScripts: 'outside-only' });
  const { window } = dom;
  const context = dom.getInternalVMContext();
  let mode = initialMode;
  let loads = 0;
  let generations = 0;
  const workers = [];
  const alerts = [];
  window.alert = message => alerts.push(message);
  window.Math.random = () => 0.5;
  window.Worker = class {
    constructor(url, options) {
      assert.equal(url.href, 'https://example.test/game/ai-worker.js');
      assert.equal(options.type, 'module');
      this.active = true;
      workers.push(this);
      const worker = this;
      const self = {
        postMessage(data) {
          queueMicrotask(() => { if (worker.active) worker.onmessage?.({ data }); });
        },
        addEventListener(type, callback) { assert.equal(type, 'message'); worker.listener = callback; },
      };
      const pipeline = async (task, model, options) => {
        loads++;
        assert.equal(task, 'text-generation');
        assert.equal(model, 'HuggingFaceTB/SmolLM-135M-Instruct');
        assert.equal(options.device, 'wasm');
        assert.equal(options.dtype, 'q8');
        assert.equal(options.revision, 'fcc320f490e08fdb4b99d935b2c58d40bf35b0d0');
        options.progress_callback({ status: 'progress', file: 'model_quantized.onnx', progress: 60 });
        if (mode === 'load-error') throw Error('download failed');
        if (mode === 'slow-load') await new Promise(() => {});
        return async (messages, config) => {
          generations++;
          assert.equal(config.max_new_tokens, 64);
          assert.equal(config.do_sample, false);
          assert.ok(messages.at(-1).content.includes('Jiyong'));
          if (mode === 'generate-error') throw Error('inference failed');
          if (mode === 'slow-generate') await new Promise(() => {});
          if (mode === 'empty') return [{ generated_text: '' }];
          const text = '지용이가 행동을 마쳤습니다. <img src=x onerror=alert(1)>';
          return [{ generated_text: mode === 'chat-output' ? [{ role: 'assistant', content: text }] : text }];
        };
      };
      vm.runInNewContext(workerSource.replace(/^import .*;$/m, ''), {
        self, pipeline, env: { backends: { onnx: { wasm: {} } } },
      }, { filename: 'ai-worker.js' });
    }
    postMessage(data) { queueMicrotask(() => { if (this.active) this.listener({ data }); }); }
    terminate() { this.active = false; }
  };
  vm.runInContext(gameSource, context, { filename: 'index.html' });
  vm.runInContext(uiSource, context, { filename: 'ai.js' });
  const el = id => window.document.getElementById(id);
  t.after(() => { workers.forEach(worker => worker.terminate()); dom.window.close(); assert.deepEqual(alerts, []); });
  return {
    window, el,
    evaluate: source => vm.runInContext(source, context),
    setMode: value => { mode = value; },
    loads: () => loads,
    generations: () => generations,
    submit(text = '산책하면서 노래하기') {
      el('aiInput').value = text;
      el('aiForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
    },
    async waitFor(predicate) {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
      }
      throw Error(`Condition not met; status: ${el('aiStatus').textContent}`);
    },
  };
}

const completed = app => app.waitFor(() => app.el('aiStatus').textContent.startsWith('완료'));
const failed = app => app.waitFor(() => app.el('aiStatus').textContent.startsWith('AI 오류'));
const state = app => JSON.parse(app.evaluate('JSON.stringify(stats)'));

test('existing buttons work without model loading; known text reuses original rules', async t => {
  const app = setup(t);
  app.evaluate("act('sleep')");
  assert.equal(app.loads(), 0);
  app.submit('잠자기');
  await completed(app);
  assert.equal(state(app).energy, 140);
  assert.equal(state(app).turn, 2);
  assert.match(app.el('aiResult').textContent, /에너지 \+20.*포만감 -2/);
  assert.match(app.el('aiResult').textContent, /AI 이야기:/);
  assert.equal(app.el('aiSubmit').disabled, false);
});

test('arbitrary input applies one bounded action and renders user/model strings as text', async t => {
  const app = setup(t);
  app.submit('산책 <img src=x onerror=alert(1)>');
  await completed(app);
  const stats = state(app);
  assert.equal(stats.energy, 95);
  assert.equal(stats.happy, 103);
  assert.equal(stats.turn, 1);
  assert.equal(stats.hunger, 8);
  assert.equal(app.el('aiResult').querySelector('img'), null);
  assert.equal(app.el('actionLog').querySelector('img'), null);
});

test('failed download consumes no turn and retry initializes a new worker', async t => {
  const app = setup(t, 'load-error');
  const before = state(app);
  app.submit();
  await failed(app);
  assert.deepEqual(state(app), before);
  assert.equal(app.el('aiSubmit').disabled, false);
  app.setMode('success');
  app.submit();
  await completed(app);
  assert.equal(state(app).turn, 1);
  assert.equal(app.loads(), 2);
});

test('inference failure preserves completed action and actual result', async t => {
  const app = setup(t, 'generate-error');
  app.submit('잠자기');
  await failed(app);
  assert.equal(state(app).turn, 1);
  assert.match(app.el('aiResult').textContent, /실제 결과: 지용이는 푹 잤다/);
  assert.match(app.el('aiStatus').textContent, /이미 반영된/);
});

test('cancel during download leaves stats intact and restores controls', async t => {
  const app = setup(t, 'slow-load');
  app.submit();
  await app.waitFor(() => app.el('aiProgress').value === 60);
  assert.equal(app.el('aiSubmit').disabled, true);
  assert.equal(app.el('aiInput').disabled, true);
  app.el('aiCancel').click();
  await app.waitFor(() => app.el('aiStatus').textContent.includes('반영되지 않았습니다'));
  assert.equal(state(app).turn, 0);
  assert.equal(app.el('aiSubmit').disabled, false);
  app.setMode('success');
  app.submit();
  await completed(app);
  assert.equal(state(app).turn, 1);
});

test('cancel during generation preserves result; double submit cannot consume extra turns', async t => {
  const app = setup(t, 'slow-generate');
  app.submit();
  await app.waitFor(() => app.el('aiStatus').textContent.includes('설명하고 있습니다'));
  app.submit();
  assert.equal(state(app).turn, 1);
  app.el('aiCancel').click();
  await app.waitFor(() => app.el('aiStatus').textContent.includes('이미 반영된'));
  assert.match(app.el('aiResult').textContent, /행복 \+3/);
  assert.equal(app.el('aiSubmit').disabled, false);
});

test('whitespace, long input and ongoing duels do not download or consume turns', t => {
  const app = setup(t);
  app.submit('   ');
  assert.match(app.el('aiStatus').textContent, /1~300자/);
  app.submit('가'.repeat(301));
  assert.match(app.el('aiStatus').textContent, /1~300자/);
  app.evaluate('startDuel()');
  app.submit();
  assert.match(app.el('aiStatus').textContent, /결투를 버튼으로/);
  assert.equal(app.loads(), 0);
  assert.equal(state(app).turn, 0);
});

test('game over keeps outcome visible and only restart remains enabled', async t => {
  const app = setup(t);
  app.evaluate('stats.hunger = 1');
  app.submit('잠자기');
  await completed(app);
  assert.equal(app.el('gameOverBox').hidden, false);
  assert.match(app.el('aiResult').textContent, /기아로 죽음/);
  assert.equal(app.el('aiSubmit').disabled, true);
  assert.equal(app.el('restartGame').disabled, false);
  assert.equal(app.el('aiInput').disabled, true);
});

test('gameplay failure is reported truthfully; model is reused and both output shapes are handled', async t => {
  const app = setup(t, 'chat-output');
  app.submit('공부');
  await completed(app);
  assert.equal(state(app).turn, 0);
  assert.match(app.el('aiResult').textContent, /돈이 없어 공부를 못했다/);
  app.submit('잠자기');
  await completed(app);
  assert.equal(app.loads(), 1);
  assert.equal(app.generations(), 2);
});

test('events remain in result when the 50-entry history rotates', async t => {
  const app = setup(t);
  app.evaluate(`eventHistory = Array.from({length: 50}, () => ({turn: 0, text: '과거'})); stats.turn = 2;`);
  app.submit('잠자기');
  await completed(app);
  assert.match(app.el('aiResult').textContent, /발생한 이벤트: 시간이 지나며/);
});

test('empty model output is an explicit error with actual outcome retained', async t => {
  const app = setup(t, 'empty');
  app.submit();
  await failed(app);
  assert.match(app.el('aiStatus').textContent, /빈 응답/);
  assert.match(app.el('aiResult').textContent, /실제 결과:/);
});

test('negative phrases are not mistaken for exact game commands', async t => {
  const app = setup(t);
  app.submit('공부 말고 산책하기');
  await completed(app);
  assert.match(app.el('aiResult').textContent, /처리: 자유 행동/);
  assert.equal(state(app).money, 0);
  assert.equal(state(app).turn, 1);
});
