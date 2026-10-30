const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync(new URL("./index.html", `file://${__dirname}/`), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const elements = new Map();
const timers = [];
const storage = new Map();

function getElement(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      disabled: false,
      innerHTML: "",
      style: {},
      textContent: "",
      querySelectorAll: () => []
    });
  }
  return elements.get(id);
}

const context = vm.createContext({
  assert,
  Audio: function Audio() { this.play = () => {}; },
  console,
  document: { getElementById: getElement },
  localStorage: {
    clear: () => storage.clear(),
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value))
  },
  location: { reload: () => {} },
  Math,
  timers,
  setTimeout: callback => { timers.push(callback); return timers.length; },
  clearTimeout: () => {}
});
context.window = context;

const tests = `
// 새 저장 형식이 인벤토리, 부동산, 장착 객체의 동일성을 복원한다.
inventory = [{ name: "벽돌", price: 10, damage: 1, magicdamage: 0 }];
stats.equippedWeapon = inventory[0];
stats.money = 123;
house = "움막";
saveProgress();
inventory = [];
stats.money = 0;
stats.equippedWeapon = null;
house = "종이가방";
loadProgress();
assert.equal(stats.money, 123);
assert.equal(house, "움막");
assert.equal(inventory.length, 1);
assert.equal(stats.equippedWeapon, inventory[0]);

// 기존 저장 형식도 장착 무기를 실제 인벤토리 항목에 다시 연결한다.
localStorage.clear();
localStorage.setItem("jiyongSave", JSON.stringify({ ...stats, equippedWeapon: { name: "짱돌", damage: 1 } }));
localStorage.setItem("jiyongInventory", JSON.stringify([{ name: "짱돌", price: 15, damage: 1 }]));
localStorage.setItem("jiyongHouse", JSON.stringify("판자집"));
loadProgress();
assert.equal(house, "판자집");
assert.equal(stats.equippedWeapon, inventory[0]);

// 인벤토리가 가득 찬 상태에서 장착 무기가 자동 판매되면 효과도 해제된다.
inventory = [
  { name: "장착 무기", price: 1, damage: 5 },
  { name: "두 번째", price: 1 },
  { name: "세 번째", price: 1 }
];
stats.equippedWeapon = inventory[0];
addToInventory("새 무기", 1);
assert.equal(stats.equippedWeapon, null);

// 친밀도 결투에는 인기도 보상이 없어도 0으로 정규화되어 NaN이 발생하지 않는다.
stats.friendship["제임스브라운"] = 0;
socialDuelChoice("제임스브라운");
assert.equal(currentEnemy.pop, 0);
currentEnemy.health = 0;
stats.popularity = 5;
winDuel();
assert.equal(stats.popularity, 5);

// 반격 타이머가 끝나기 전 연타한 두 번째 공격은 무시된다.
timers.length = 0;
currentEnemy = { name: "테스트 적", health: 100, power: 2, money: 0, pop: 0 };
duelOver = false;
setDuelActionPending(false);
stats.power = 10;
stats.health = 100;
const originalRandom = Math.random;
Math.random = () => 0;
duelTurn("attack");
duelTurn("attack");
assert.equal(currentEnemy.health, 95);
assert.equal(duelActionPending, true);
assert.equal(timers.length, 1);
timers.shift()();
assert.equal(duelActionPending, false);
Math.random = originalRandom;
`;

vm.runInContext(`${script}\n${tests}`, context, { filename: "index.html" });
console.log("All regression tests passed.");
