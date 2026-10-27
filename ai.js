/* global stats, inventory, house, gameEnded, currentEnemy, duelOver,
          act, workturn, eatChoice, nextTurn, log */
(() => {
  'use strict';
  const form = document.getElementById('aiForm');
  const input = document.getElementById('aiInput');
  const submit = document.getElementById('aiSubmit');
  const cancel = document.getElementById('aiCancel');
  const status = document.getElementById('aiStatus');
  const progress = document.getElementById('aiProgress');
  const result = document.getElementById('aiResult');
  const statLabels = {
    energy: '에너지', health: '체력', hunger: '포만감', intelligence: '지능',
    skill: '숙련도', money: '돈', happy: '행복', power: '힘', clean: '청결',
    disease: '병', popularity: '인기도', turn: '턴',
  };
  const actionNames = {
    sleep: 'sleep', wash: 'wash', study: 'study', train: 'exercise', heal: 'rest',
    shop: 'buy an item', work: 'work in a coal mine', beg: 'beg for money',
    rice: 'eat rice noodles', stoneRice: 'eat stone rice',
  };
  let worker;
  let sequence = 0;
  let pending;
  let running = false;
  let stopped = false;
  let lockedButtons = [];

  // Only these trusted functions can change the game. Model output is plain text.
  function resolveAction(text) {
    const normalized = text.trim().toLowerCase().replace(/[.!?。！？]+$/g, '');
    const aliases = [
      ['sleep', ['잠자기', '잠 자기', '자기', '쳐자기', '수면', '잠', 'sleep', '잠 재우기']],
      ['wash', ['씻기', '씻기기', '샤워', '목욕', 'wash']],
      ['study', ['공부', '공부하기', 'study']],
      ['train', ['단련', '단련하기', '운동', '운동하기', 'train']],
      ['heal', ['휴식', '휴식하기', '치료', 'heal']],
      ['shop', ['장보기', '장 보기', '쇼핑', 'shop']],
      ['work', ['로동', '노동', '일하기', '일 하기', '탄광가기', '탄광 가기', 'work']],
      ['beg', ['구걸', '구걸하기']],
      ['rice', ['쌀국수', '쌀국수 먹기']],
      ['stoneRice', ['돌밥', '돌밥 먹기']],
    ];
    // Exact aliases avoid executing a different action for "공부 말고 산책하기".
    for (const [key, names] of aliases) {
      if (names.includes(normalized)) return { key, label: names[0] };
    }
    return { key: 'free', label: text };
  }

  function snapshot() {
    return {
      ...Object.fromEntries(Object.keys(statLabels).map(key => [key, stats[key]])),
      items: inventory.map(item => item.name).join(', ') || '없음',
      house,
    };
  }

  function describeChanges(before, after) {
    const changes = Object.entries(statLabels).flatMap(([key, label]) => {
      const delta = after[key] - before[key];
      return delta ? [`${label} ${delta > 0 ? '+' : ''}${delta}`] : [];
    });
    if (before.items !== after.items) changes.push(`인벤토리: ${after.items}`);
    if (before.house !== after.house) changes.push(`집: ${after.house}`);
    return changes.join(' / ') || '능력치 변화 없음';
  }

  function executeAction(action, text) {
    switch (action.key) {
      case 'work': workturn('coalmine'); break;
      case 'beg': workturn('beg'); break;
      case 'rice':
        if (stats.money < 50) { log('쌀국수를 먹으려면 50원이 필요합니다.'); break; }
        eatChoice('ricenoodle'); break;
      case 'stoneRice':
        if (stats.money < 5) { log('돌밥을 먹으려면 5원이 필요합니다.'); break; }
        eatChoice('stonerice'); break;
      case 'free':
        stats.energy = Math.max(0, stats.energy - 5);
        stats.happy += 3;
        // Never interpolate untrusted input into the original HTML-based log().
        document.getElementById('actionLog').textContent = `자유 행동: ${text}`;
        nextTurn();
        break;
      default: act(action.key);
    }
    return document.getElementById('actionLog').textContent;
  }

  function lockGame(locked) {
    if (locked) {
      lockedButtons = [...document.querySelectorAll('button')]
        .filter(button => !['aiCancel', 'restartGame'].includes(button.id))
        .map(button => [button, button.disabled]);
      lockedButtons.forEach(([button]) => { button.disabled = true; });
    } else {
      lockedButtons.forEach(([button, wasDisabled]) => {
        button.disabled = gameEnded || wasDisabled;
      });
      lockedButtons = [];
    }
    input.disabled = locked || gameEnded;
    cancel.hidden = !locked;
    form.setAttribute('aria-busy', String(locked));
  }

  function resetWorker() {
    worker?.terminate();
    worker = undefined;
  }

  function rejectPending(message) {
    if (!pending) return;
    const current = pending;
    pending = undefined;
    clearTimeout(current.timer);
    current.reject(new Error(message));
  }

  function ensureWorker() {
    if (worker) return;
    if (!window.Worker || typeof WebAssembly === 'undefined') {
      throw new Error('이 브라우저에서는 AI를 실행할 수 없습니다. 최신 브라우저를 사용해 주세요.');
    }
    if (location.protocol === 'file:') {
      throw new Error('AI는 HTTPS 또는 localhost로 연 페이지에서 실행해 주세요.');
    }
    worker = new Worker(new URL('./ai-worker.js', document.baseURI), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (!pending || data.id !== pending.id) return;
      if (data.type === 'progress') {
        const item = data.progress;
        if (item.status === 'progress' && Number.isFinite(item.progress)) {
          progress.hidden = false;
          progress.value = Math.min(100, Math.max(0, item.progress));
          status.textContent = `모델 다운로드: ${Math.round(progress.value)}% (${item.file})`;
        } else if (item.status === 'initiate' || item.status === 'done') {
          progress.hidden = false;
          progress.removeAttribute('value');
          status.textContent = '모델 파일을 준비하고 있습니다…';
        }
        return;
      }
      if (data.type === 'error') {
        rejectPending(data.message);
        resetWorker();
        return;
      }
      const current = pending;
      pending = undefined;
      clearTimeout(current.timer);
      current.resolve(data);
    };
    worker.onerror = event => {
      event.preventDefault();
      rejectPending('모델 실행 파일을 불러오지 못했습니다. 네트워크 연결을 확인하고 다시 시도해 주세요.');
      resetWorker();
    };
  }

  function request(type, payload = {}) {
    ensureWorker();
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending = {
        id, resolve, reject,
        timer: setTimeout(() => {
          rejectPending('AI 처리 시간이 초과되었습니다. 다시 시도해 주세요.');
          resetWorker();
        }, type === 'load' ? 300000 : 120000),
      };
      worker.postMessage({ type, id, ...payload });
    });
  }

  cancel.addEventListener('click', () => {
    stopped = true;
    rejectPending('AI 처리를 중지했습니다.');
    resetWorker();
  });

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (running || gameEnded) return;
    const text = input.value.trim();
    if (!text || text.length > 300) {
      status.textContent = '행동을 1~300자로 입력해 주세요.';
      return;
    }
    if (currentEnemy && !duelOver) {
      status.textContent = '진행 중인 결투를 버튼으로 마친 뒤 자유 행동을 입력해 주세요.';
      return;
    }
    running = true;
    stopped = false;
    lockGame(true);
    progress.hidden = false;
    progress.removeAttribute('value');
    result.textContent = '';
    let actualResult = '';
    try {
      status.textContent = 'AI 모델을 준비하고 있습니다. 첫 실행은 시간이 걸릴 수 있습니다…';
      // A failed download or cancellation here must never consume a turn.
      await request('load');
      if (stopped || gameEnded) return;
      const before = snapshot();
      const previousEvents = new Set(eventHistory);
      const action = resolveAction(text);
      const outcome = executeAction(action, text);
      const after = snapshot();
      const changes = describeChanges(before, after);
      const statChanges = Object.keys(statLabels).flatMap(key => {
        const delta = after[key] - before[key];
        return delta ? [`${key} ${delta > 0 ? '+' : ''}${delta}`] : [];
      }).join(', ') || 'no stat changes';
      const events = eventHistory.filter(item => !previousEvents.has(item)).map(item => item.text);
      actualResult = `입력: ${text}\n처리: ${action.key === 'free' ? '자유 행동' : action.label}\n실제 결과: ${outcome}\n능력치 변화: ${changes}`;
      if (events.length) actualResult += `\n발생한 이벤트: ${events.join(' / ')}`;
      if (gameEnded) actualResult += `\n${document.getElementById('gameOverReason').textContent}`;
      result.textContent = actualResult;
      progress.hidden = true;
      status.textContent = '행동이 반영되었습니다. AI가 결과를 설명하고 있습니다…';
      const response = await request('generate', {
        actionName: action.key === 'free' ? text : actionNames[action.key],
        statChanges,
        gameOver: gameEnded,
      });
      // AI output is never HTML or executable code, and never controls stats.
      result.textContent = `${actualResult}\n\nAI 이야기:\n${response.text}`;
      status.textContent = '완료 · 이 브라우저에서 SmolLM 135M으로 생성했습니다.';
    } catch (error) {
      status.textContent = `${stopped ? 'AI 처리를 중지했습니다.' : `AI 오류: ${error.message}`} ${actualResult ? '이미 반영된 행동 결과는 위에 남아 있습니다.' : '행동과 턴은 반영되지 않았습니다.'}`;
    } finally {
      progress.hidden = true;
      running = false;
      lockGame(false);
      if (!gameEnded) input.focus();
    }
  });
})();
