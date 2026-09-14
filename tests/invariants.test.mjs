/**
 * tests/invariants.test.mjs — 퍼즈 + 불변식 (MEMORY ★★ 원칙 4).
 *
 * ★ 퍼즈: 여러 시드 × 3600틱, 랜덤 입력 + 랜덤 스폰(적·적탄)으로 step 을 두들긴다.
 *   매 틱 불변식을 검사한다:
 *     · NaN 좌표 0            — 모든 alive 개체의 x/y/vx/vy 가 유한
 *     · HP ∈ [0, hpMax]       — 플레이어; alive 적은 0 < hp ≤ hpMax
 *     · 엔티티 ≤ 캡           — 각 풀 live ≤ rules.caps.*
 *     · 풀 free 스택 무결      — freeTop + live == size, 스캔한 alive 수 == live
 *   그리고:
 *     · 같은 시드 = 비트 재현   — 동일 시드 두 번 = 표본 열 동일 / 다른 시드 = 상이
 *     · 핫패스 할당 0(힙증가0)  — 풀 items 배열이 재할당되지 않는다(동일 참조·길이)
 *     · 9스트림 독립           — 한 스트림을 뽑아도 다른 스트림이 밀리지 않는다
 */

import { suite, test, assert, loadData } from '../tools/test.mjs';
import {
  createWorld, giveWeapon, levelUpWeapon, givePassive, spawnEnemy, spawnEnemyBullet,
} from '../src/core/state.js';
import { step, makeInput, TICK_DT } from '../src/core/step.js';
import { weapons } from '../src/core/weapons/index.js';
import { makeRng, makeStreams, RNG_STREAMS } from '../src/core/rng.js';

const dt = TICK_DT;
const SEEDS = [1, 42, 1337, 90210];
const TICKS = 3600;

// 검사할 풀 ↔ caps 키
const POOLS = [
  ['enemies', 'enemies'], ['playerBullets', 'playerBullets'], ['enemyBullets', 'enemyBullets'],
  ['pickups', 'pickups'], ['zones', 'zones'], ['drones', 'drones'], ['telegraphs', 'telegraphs'],
];

function fin(v) { return typeof v === 'number' && Number.isFinite(v); }

/** 성장 다이얼을 미리 감아 핫패스(count·pierce·area 훅)를 최대한 자극한다 */
function buildWorld(seed) {
  const data = loadData();
  const w = createWorld({ data, seed, weapons, hooks: { enemies: null, emitters: null }, startWeaponId: 'forward' });
  giveWeapon(w, 'fan');
  giveWeapon(w, 'seeker');
  const rng = makeRng(seed ^ 0x5eed);
  // 무기 레벨 랜덤 상승 (일부는 진화까지)
  for (const fam of ['forward', 'fan', 'seeker']) {
    const s = w.slots.find((x) => x.family === fam);
    const up = rng.int(0, 7);
    for (let i = 0; i < up; i += 1) levelUpWeapon(w, s.index);
  }
  // 패시브 몇 개 (projCountAdd·pierceAdd·areaMul·dmgMul 훅을 켠다)
  const pids = data.passives.passives.map((p) => p.id);
  for (let i = 0; i < 4; i += 1) {
    const id = pids[rng.int(0, pids.length - 1)];
    givePassive(w, id); givePassive(w, id);
  }
  return w;
}

/** 매 틱 불변식. 위반이면 assert 가 throw */
function checkInvariants(w, caps, seed, tick) {
  const p = w.player;
  const where = `seed ${seed} tick ${tick}`;
  assert.ok(fin(p.x) && fin(p.y) && fin(p.vx) && fin(p.vy), `${where}: 플레이어 좌표 유한`);
  assert.ok(fin(p.hp) && fin(p.hpMax) && p.hpMax > 0, `${where}: hp/hpMax 유한·양수`);
  assert.gte(p.hp, 0, `${where}: hp ≥ 0`);
  assert.lte(p.hp, p.hpMax, `${where}: hp ≤ hpMax`);

  for (let k = 0; k < POOLS.length; k += 1) {
    const [name, capKey] = POOLS[k];
    const pool = w[name];
    // free 스택 무결: 두 카운터의 합은 항상 풀 크기다
    assert.eq(pool.freeTop + pool.live, pool.size, `${where}: ${name} freeTop+live==size`);
    assert.lte(pool.live, caps[capKey], `${where}: ${name} live ≤ cap`);
    assert.gte(pool.live, 0, `${where}: ${name} live ≥ 0`);
    // 스캔한 alive 수가 카운터와 일치 + 모든 alive 좌표 유한
    let alive = 0;
    const it = pool.items;
    for (let i = 0; i < it.length; i += 1) {
      const e = it[i];
      if (!e.alive) continue;
      alive += 1;
      if (!(fin(e.x) && fin(e.y))) assert.ok(false, `${where}: ${name}[${i}] 좌표 NaN`);
      if ('vx' in e && !(fin(e.vx) && fin(e.vy))) assert.ok(false, `${where}: ${name}[${i}] 속도 NaN`);
    }
    assert.eq(alive, pool.live, `${where}: ${name} 스캔 alive == live (스택 무결)`);
  }
  // alive 적은 살아있으므로 hp > 0 이고 회복이 없으니 hpMax 이하
  const en = w.enemies.items;
  for (let i = 0; i < en.length; i += 1) {
    const e = en[i];
    if (!e.alive) continue;
    assert.ok(fin(e.hp) && fin(e.hpMax), `${where}: enemy[${i}] hp 유한`);
    assert.gt(e.hp, 0, `${where}: alive enemy[${i}] hp > 0`);
    assert.lte(e.hp, e.hpMax, `${where}: enemy[${i}] hp ≤ hpMax`);
  }
}

/**
 * 시드 하나로 퍼즈를 돌린다.
 * @param check 매 틱 불변식 검사 여부
 * @returns { fingerprints, itemsRefs } — 재현성·재할당 검증용
 */
function fuzz(seed, ticks, check) {
  const w = buildWorld(seed);
  const data = w.data;
  const caps = data.rules.caps;
  const arena = data.rules.view.arena;
  const archIds = data.enemies.archetypes.map((a) => a.id);
  const hpOf = {}; for (const a of data.enemies.archetypes) hpOf[a.id] = a.hp;
  const elements = data.elements.order;         // normal fire water grass
  const bulletIds = data.bullets.bullets.map((b) => b.id);

  const rng = makeRng(seed);                    // 입력·스폰 결정론 (core RNG 와 별개 스트림)
  const input = makeInput();                    // 재사용 (핫패스 0 alloc 정신)
  const itemsRefs = POOLS.map(([n]) => w[n].items);   // 재할당 감시용 참조 스냅샷
  const fingerprints = [];

  for (let t = 0; t < ticks; t += 1) {
    const u = rng.u32();
    input.left = !!(u & 1); input.right = !!(u & 2);
    input.up = !!(u & 4); input.down = !!(u & 8);
    input.stanceNormal = !!(u & 16); input.stanceFire = !!(u & 32);
    input.stanceWater = !!(u & 64); input.stanceGrass = !!(u & 128);

    // 적 스폰 (아레나 상단, 플레이어 쪽으로 하강) — 몸통 충돌·처치·드랍·픽업 경로 자극
    if (rng.f() < 0.15) {
      const id = archIds[rng.int(0, archIds.length - 1)];
      const el = elements[rng.int(0, elements.length - 1)];
      const ex = arena.x + rng.f() * arena.w;
      const e = spawnEnemy(w, id, el, ex, arena.y + rng.f() * 40, hpOf[id], rng.f() < 0.1);
      if (e !== null) { e.vy = 60 + rng.f() * 120; e.vx = (rng.f() - 0.5) * 80; }
    }
    // 적 탄 스폰 (플레이어 조준) — 피격·i-frame·hp 하한 자극
    if (rng.f() < 0.2) {
      const bid = bulletIds[rng.int(0, bulletIds.length - 1)];
      const bx = arena.x + rng.f() * arena.w;
      const by = arena.y + rng.f() * 60;
      const dx = w.player.x - bx; const dy = w.player.y - by;
      const d = Math.hypot(dx, dy) || 1;
      const sp = 120 + rng.f() * 180;
      spawnEnemyBullet(w, bid, bx, by, (dx / d) * sp, (dy / d) * sp);
    }
    // 레벨업 드래프트 소화 (core 는 큐만 센다 → 소비해 성장 지속)
    while (w.draftQueue > 0) {
      w.draftQueue -= 1;
      const s = w.slots[rng.int(0, w.slots.length - 1)];
      if (s.weaponId !== null) levelUpWeapon(w, s.index);
    }

    step(w, input, dt);
    if (check) checkInvariants(w, caps, seed, t);

    if (t % 300 === 0) {
      fingerprints.push([
        t, Math.round(w.player.x), Math.round(w.player.y), Math.round(w.player.hp * 10),
        w.enemies.live, w.playerBullets.live, w.enemyBullets.live, w.pickups.live,
        Math.round(w.player.xp * 10), w.player.level, w.over ? 1 : 0,
      ]);
    }
  }
  return { fingerprints, itemsRefs, w };
}

suite('invariants/퍼즈', () => {
  test(`불변식 유지 (${SEEDS.length}시드 × ${TICKS}틱): NaN 0 · HP∈[0,hpMax] · 캡 · 풀무결`, () => {
    for (const seed of SEEDS) fuzz(seed, TICKS, true);
    // fuzz 안의 매 틱 assert 들이 실제 단언이다. 여기 한 줄로 "완주함"을 못박는다.
    assert.ok(true, `${SEEDS.length}시드 전부 완주 — 불변식 위반 없음`);
  });
});

suite('invariants/결정성', () => {
  test('같은 시드 → 비트 재현 (표본 열 동일)', () => {
    const a = fuzz(1337, 1200, false);
    const b = fuzz(1337, 1200, false);
    assert.deepEq(a.fingerprints, b.fingerprints, '동일 시드 = 동일 궤적');
  });

  test('다른 시드 → 상이한 궤적', () => {
    const a = fuzz(1, 1200, false);
    const b = fuzz(2, 1200, false);
    assert.ne(JSON.stringify(a.fingerprints), JSON.stringify(b.fingerprints), '다른 시드 = 다른 궤적');
  });

  test('9스트림 독립 — 한 스트림을 뽑아도 다른 스트림이 밀리지 않는다', () => {
    const s1 = makeStreams(555);
    for (let i = 0; i < 500; i += 1) s1.draft.u32();     // draft 를 500회 소모
    const s2 = makeStreams(555);                          // 갓 만든 동일 시드
    for (const name of RNG_STREAMS) {
      if (name === 'draft') continue;
      assert.eq(s1[name].u32(), s2[name].u32(), `${name} 스트림은 draft 소모에 무관`);
    }
  });
});

suite('invariants/핫패스', () => {
  test('풀 items 배열은 재할당되지 않는다 (사전할당·힙증가 0)', () => {
    const { itemsRefs, w } = fuzz(4242, TICKS, false);
    for (let k = 0; k < POOLS.length; k += 1) {
      const [name] = POOLS[k];
      assert.eq(w[name].items, itemsRefs[k], `${name}.items 동일 참조 (재할당 없음)`);
      assert.eq(w[name].items.length, w[name].size, `${name}.items 길이 = size (증가 없음)`);
    }
    // gc 가 노출돼 있으면 힙 증가도 상한으로 확인 (없으면 위 구조 불변식만으로 충분)
    if (typeof global.gc === 'function') {
      global.gc();
      const before = process.memoryUsage().heapUsed;
      fuzz(4243, TICKS, false);
      global.gc();
      const after = process.memoryUsage().heapUsed;
      assert.lt(after - before, 8 * 1024 * 1024, '3600틱 힙 증가 < 8MB');
    }
  });
});
