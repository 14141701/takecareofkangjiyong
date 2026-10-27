import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const root = new URL('../', import.meta.url);
let server;
let browser;
let base;

before(async () => {
  server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const filenames = { '/': 'index.html', '/index.html': 'index.html', '/ai.js': 'ai.js', '/ai-worker.js': 'ai-worker.js' };
    if (!filenames[path]) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8');
    response.end(await readFile(new URL(filenames[path], root)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox'],
  });
});

after(async () => {
  await browser?.close();
  await new Promise(resolve => server?.close(resolve));
});

// Keep the real Worker/message flow; replace only the expensive external ML runtime.
function fakeRuntime(mode) {
  return `
    export const env = { backends: { onnx: { wasm: {} } } };
    export async function pipeline(task, model, options) {
      if (task !== 'text-generation' || !model.includes('135M') || options.device !== 'wasm' || options.dtype !== 'q8') throw Error('Invalid model configuration');
      options.progress_callback({status: 'progress', file: 'model_quantized.onnx', progress: 60});
      ${mode === 'load-error' ? "throw Error('Test download failed');" : ''}
      ${mode === 'slow-load' ? 'await new Promise(resolve => setTimeout(resolve, 60000));' : ''}
      return async (messages, config) => {
        if (config.max_new_tokens !== 64) throw Error('Missing generation limit');
        ${mode === 'generate-error' ? "throw Error('Test inference failed');" : ''}
        ${mode === 'slow-generate' ? 'await new Promise(resolve => setTimeout(resolve, 60000));' : ''}
        return [{ generated_text: '지용이가 행동을 마쳤습니다. <img src=x onerror=alert(1)>' }];
      };
    }
  `;
}

async function setup(t, initialMode = 'success', viewport) {
  const context = await browser.newContext({ viewport });
  t.after(() => context.close());
  let mode = initialMode;
  let loads = 0;
  await context.route('https://cdn.jsdelivr.net/**', route => {
    loads++;
    return route.fulfill({ contentType: 'text/javascript', body: fakeRuntime(mode) });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.addInitScript(() => { Math.random = () => 0.5; });
  await page.goto(base);
  return { page, setMode: value => { mode = value; }, loads: () => loads };
}

async function submit(page, text = '산책하면서 노래하기') {
  await page.locator('#aiInput').fill(text);
  await page.locator('#aiSubmit').click();
}

async function done(page) {
  await page.waitForFunction(() => document.getElementById('aiStatus').textContent.startsWith('완료'));
}

const state = page => page.evaluate(() => ({ energy: stats.energy, happy: stats.happy, hunger: stats.hunger, money: stats.money, turn: stats.turn }));

test('existing buttons work without loading AI; known text uses original rules and actual results', async t => {
  const { page, loads } = await setup(t);
  await page.getByRole('button', { name: '쳐자기', exact: true }).click();
  assert.equal(loads(), 0);
  assert.equal((await state(page)).energy, 120);
  await submit(page, '잠자기');
  await done(page);
  assert.equal((await state(page)).energy, 140);
  assert.equal((await state(page)).turn, 2);
  assert.match(await page.locator('#aiResult').innerText(), /에너지 \+20.*포만감 -2/);
  assert.match(await page.locator('#aiResult').innerText(), /AI 이야기:/);
  assert.equal(loads(), 1);
  assert.equal(await page.locator('#aiSubmit').isEnabled(), true);
});

test('free text consumes one turn; input and AI output stay inert text', async t => {
  const { page } = await setup(t);
  await submit(page, '산책하기 <img src=x onerror=alert(1)>');
  await done(page);
  assert.deepEqual(await state(page), { energy: 95, happy: 103, hunger: 8, money: 0, turn: 1 });
  assert.equal(await page.locator('#aiResult img, #actionLog img').count(), 0);
  assert.match(await page.locator('#aiResult').innerText(), /실제 결과: 자유 행동:/);
  await submit(page, '씻기');
  await done(page);
  assert.equal((await state(page)).turn, 2);
});

test('failed download leaves all state intact and allows retry', async t => {
  const { page, setMode } = await setup(t, 'load-error');
  const before = await state(page);
  await submit(page);
  await page.waitForFunction(() => document.getElementById('aiStatus').textContent.includes('Test download failed'));
  assert.deepEqual(await state(page), before);
  assert.equal(await page.locator('#aiSubmit').isEnabled(), true);
  setMode('success');
  await page.locator('#aiSubmit').click();
  await done(page);
  assert.equal((await state(page)).turn, 1);
});

test('inference failure preserves actual game result without executing twice', async t => {
  const { page, setMode } = await setup(t, 'generate-error');
  await submit(page, '잠자기');
  await page.waitForFunction(() => document.getElementById('aiStatus').textContent.includes('Test inference failed'));
  assert.match(await page.locator('#aiResult').innerText(), /실제 결과: 지용이는 푹 잤다/);
  assert.equal((await state(page)).turn, 1);
  setMode('success');
  await page.locator('#aiSubmit').click();
  await done(page);
  assert.equal((await state(page)).turn, 2);
});

test('cancel during download consumes no turn; controls recover for retry', async t => {
  const { page, setMode } = await setup(t, 'slow-load');
  await submit(page);
  await page.waitForFunction(() => document.getElementById('aiProgress').value === 60);
  assert.equal(await page.getByRole('button', { name: '쳐자기', exact: true }).isDisabled(), true);
  await page.locator('#aiCancel').click();
  await page.waitForFunction(() => document.getElementById('aiStatus').textContent.includes('반영되지 않았습니다'));
  assert.equal((await state(page)).turn, 0);
  setMode('success');
  await page.locator('#aiSubmit').click();
  await done(page);
  assert.equal((await state(page)).turn, 1);
});

test('cancel after action preserves result and blocks double submits', async t => {
  const { page } = await setup(t, 'slow-generate');
  await submit(page);
  await page.waitForFunction(() => document.getElementById('aiStatus').textContent.includes('설명하고 있습니다'));
  await page.locator('#aiForm').evaluate(form => form.dispatchEvent(new Event('submit', { cancelable: true })));
  assert.equal((await state(page)).turn, 1);
  await page.locator('#aiCancel').click();
  await page.waitForFunction(() => document.getElementById('aiStatus').textContent.includes('이미 반영된'));
  assert.match(await page.locator('#aiResult').innerText(), /행복 \+3/);
  assert.equal(await page.locator('#aiSubmit').isEnabled(), true);
});

test('whitespace and ongoing duels are rejected before downloading', async t => {
  const { page, loads } = await setup(t);
  await submit(page, '   ');
  assert.match(await page.locator('#aiStatus').innerText(), /1~300자/);
  await page.getByRole('button', { name: '결투 신청', exact: true }).click();
  await submit(page);
  assert.match(await page.locator('#aiStatus').innerText(), /결투를 버튼으로/);
  assert.equal(loads(), 0);
  assert.equal((await state(page)).turn, 0);
});

test('game over retains generated outcome and offers explicit restart', async t => {
  const { page } = await setup(t);
  await page.evaluate(() => { stats.hunger = 1; });
  await submit(page, '잠자기');
  await done(page);
  assert.equal(await page.locator('#gameOverBox').isVisible(), true);
  assert.match(await page.locator('#aiResult').innerText(), /기아로 죽음/);
  assert.equal(await page.locator('#aiSubmit').isDisabled(), true);
  assert.equal(await page.locator('#restartGame').isEnabled(), true);
  await page.locator('#restartGame').click();
  assert.equal((await state(page)).turn, 0);
});

test('mobile input fits viewport and keyboard submission works', async t => {
  const { page } = await setup(t, 'success', { width: 375, height: 812 });
  await page.locator('#aiInput').fill('공부 말고 산책하기');
  await page.locator('#aiInput').press('Control+Enter');
  await done(page);
  assert.match(await page.locator('#aiResult').innerText(), /처리: 자유 행동/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});
