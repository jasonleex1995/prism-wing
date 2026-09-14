/**
 * tests/step.test.mjs — src/core/step.js 계약 단위 테스트
 *
 * 대상 (임무):
 *   · 이동: bounds 클램프 · 대각 정규화 · SOCD lastInput (§2.2)
 *   · i-frame: 모든 피해원 공유, **게임초당 최대 1회** (§2.4) — 회귀
 *   · 관통 hitGen: 적 슬롯 재사용(release→재alloc, gen++) 후 관통탄이 새 적을 통과하지 않는다 — 회귀
 *   · killEnemy: 진입 !alive 가드 = 멱등 + §8.6 XP 드랍 (D3) — 회귀
 *   · 레벨업: serial 큐 (§6.4) · 스탠스 런 유지 · 발사 → 탄 스폰
 *
 * world = createWorld({ data, seed, weapons, startWeaponId: 'forward' }) · hooks 없이 (1주차: 적 등속 적분만).
 * ★ 결정성 = 같은 시드+입력열 → 비트 동일 / 다른 시드 → 상이.
 */
import { suite, test, assert, loadData } from '../tools/test.mjs';
import { createWorld, spawnEnemy, spawnPlayerBullet, spawnEnemyBullet, spawnPickup, xpToNext } from '../src/core/state.js';
import { step, makeInput, applyHit, killEnemy, TICK_DT } from '../src/core/step.js';
import { investElement, requestStance } from '../src/core/stance.js';
import { elementMul } from '../src/core/elements.js';
import { weapons } from '../src/core/weapons/index.js';

function mk(seed = 1) {
  return createWorld({ data: loadData(), seed, weapons, startWeaponId: 'forward' });
}
/** 자동 발사가 테스트 대상 풀을 오염시키지 않도록 무기를 침묵시킨다 (family 는 남겨 spawn 계약 유지) */
function silence(w) {
  for (const s of w.slots) s.weaponId = null;
}
function down(k) { const i = makeInput(); i[k] = true; return i; }
/** 값은 data/정본에서 유도한다 (매직넘버 지양) */
function bulletDef(w, id) { return w.data.bullets.bullets.find((b) => b.id === id); }
function passiveVal(w, id, lv = 1) { return w.data.passives.passives.find((p) => p.id === id).values[lv - 1]; }

// ─────────────────────────────────────────────────────────────────────────
suite('step · 이동 (§2.2)', () => {
  test('등속 — 관성 없음 (moveResponseTau 0): Δ = moveSpeed × dt', () => {
    const w = mk();
    silence(w);
    const rp = w.data.rules.player;
    const y0 = w.player.y;
    step(w, down('up'), TICK_DT);
    assert.near(w.player.y, y0 - rp.moveSpeed * TICK_DT, 1e-9, 'up 1틱 = -moveSpeed·dt');
    assert.eq(w.player.vy, -rp.moveSpeed, 'vy 즉시 = -moveSpeed (가속 없음)');
  });

  test('bounds 클램프 — 위로 계속 = minY 에 정확히 고정', () => {
    const w = mk();
    silence(w);
    for (let i = 0; i < 400; i += 1) step(w, down('up'), TICK_DT);
    assert.eq(w.player.y, w.bounds.minY, 'y 클램프 = minY (파생값)');
    for (let i = 0; i < 400; i += 1) step(w, down('left'), TICK_DT);
    assert.eq(w.player.x, w.bounds.minX, 'x 클램프 = minX');
    // 좌표 유한 불변식
    assert.finite(w.player.x, 'x 유한');
    assert.finite(w.player.y, 'y 유한');
  });

  test('대각 정규화 — 두 축 동시 = ×0.70710678 (속도 상한 보존)', () => {
    const w = mk();
    silence(w);
    const rp = w.data.rules.player;
    assert.ok(rp.diagonalNormalize, '정본: diagonalNormalize true');
    const DIAG = 0.70710678;
    const x0 = w.player.x; const y0 = w.player.y;
    const inp = makeInput(); inp.up = true; inp.left = true;
    step(w, inp, TICK_DT);
    assert.near(w.player.x, x0 - rp.moveSpeed * DIAG * TICK_DT, 1e-6, 'x 대각 성분');
    assert.near(w.player.y, y0 - rp.moveSpeed * DIAG * TICK_DT, 1e-6, 'y 대각 성분');
    // 두 축 성분 크기가 같다 = 45° 정규화
    assert.near(Math.abs(x0 - w.player.x), Math.abs(y0 - w.player.y), 1e-9, '두 축 동일 성분');
  });

  test('SOCD lastInput — 반대키 동시 입력이면 마지막에 눌린 키가 이긴다', () => {
    const w = mk();
    silence(w);
    // 틱1: left 먼저 → 왼쪽으로
    let x = w.player.x;
    step(w, down('left'), TICK_DT);
    assert.lt(w.player.x, x, '틱1 left → x 감소');
    // 틱2: left 유지 + right 추가(상승 엣지) → 마지막에 눌린 right 가 이긴다
    x = w.player.x;
    const both = makeInput(); both.left = true; both.right = true;
    step(w, both, TICK_DT);
    assert.gt(w.player.x, x, '틱2 left+right 동시 → 마지막 눌린 right 승 → x 증가');
    assert.eq(w.player.lastHorizontal, 1, 'lastHorizontal = 1 (right)');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('step · i-frame 게임초당 1회 (§2.4) — 회귀', () => {
  test('정지 몸통 충돌이 매 틱 겹쳐도 1.0 게임초당 정확히 1회만 피격', () => {
    const w = mk();
    silence(w);
    const px = w.player.x; const py = w.player.y;
    const def = w.data.enemies.archetypes.find((a) => a.id === 'columnAnt');
    const e = spawnEnemy(w, 'columnAnt', 'normal', px, py, def.hp, false);
    let hits = 0; let prev = w.player.hp;
    // 60틱 = 1.0 게임초 → 정확히 1회
    for (let i = 0; i < 60; i += 1) {
      e.x = px; e.y = py;                 // 적을 계속 겹쳐 둔다 (매 틱 피해원 존재)
      step(w, makeInput(), TICK_DT);
      if (w.player.hp < prev) { hits += 1; prev = w.player.hp; }
    }
    assert.eq(hits, 1, '1.0 게임초 = 1회 (i-frame 게이트)');
    // 120틱 = 2.0 게임초 → 정확히 2회 (게이트가 진짜로 시간당 1회임을 증명; 미게이트면 매 틱)
    for (let i = 0; i < 60; i += 1) {
      e.x = px; e.y = py;
      step(w, makeInput(), TICK_DT);
      if (w.player.hp < prev) { hits += 1; prev = w.player.hp; }
    }
    assert.eq(hits, 2, '2.0 게임초 = 2회 (미게이트였다면 수십 회)');
    assert.lt(hits, 120, '틱마다 맞지 않는다 = 게이트 존재');
    // HP 불변식: [0, hpMax]
    assert.gte(w.player.hp, 0, 'hp >= 0');
    assert.lte(w.player.hp, w.player.hpMax, 'hp <= hpMax');
  });

  test('i-frame 중 겹친 탄은 소멸하지 않고 통과한다 (§2.4 v1.4)', () => {
    const w = mk();
    silence(w);
    const px = w.player.x; const py = w.player.y;
    // 피격을 유발할 탄 하나 (피해 적용 → 소멸) + i-frame 중 겹칠 탄 하나 (통과)
    spawnEnemyBullet(w, 'pelletS', px, py, 0, 0);
    spawnEnemyBullet(w, 'pelletS', px, py, 0, 0);
    assert.eq(w.enemyBullets.live, 2, '두 탄 배치');
    step(w, makeInput(), TICK_DT);
    // 정확히 한 탄만 소멸 (피해 준 그 탄). 나머지는 i-frame 중이라 통과 = 여전히 살아있다
    assert.eq(w.enemyBullets.live, 1, 'i-frame 중 겹친 탄은 통과 (1개만 소멸)');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('step · 관통 hitGen (§9.5) — 회귀', () => {
  test('적 슬롯 재사용(gen++) 후 관통탄이 새 적을 조용히 통과하지 않는다', () => {
    const w = mk();
    silence(w);
    const slot = w.slots[0];                              // family forward, stampElement normal
    const eff = { dmg: 50, projRadius: 6, pierce: 0, hitCooldownSec: 0, lifetimeSec: 999 };
    const b = spawnPlayerBullet(w, slot, eff, 600, 300, 0, 0, 1);
    b.pierceLeft = -1;                                    // 무제한 관통 (탄이 살아남아 재히트 가능)
    b.lifetimeSec = 999;
    const A = spawnEnemy(w, 'drifter', 'normal', 600, 300, 3, false);
    const idxA = A.idx; const genA = A.gen;
    step(w, makeInput(), TICK_DT);                        // 탄 dmg 50 > 3 → A 처치, 탄 생존
    assert.ok(!A.alive, 'A 처치됨');
    assert.ok(b.alive, '무제한 관통탄 생존');
    const B = spawnEnemy(w, 'drifter', 'normal', 600, 300, 3, false);
    assert.eq(B.idx, idxA, 'B 가 A 의 슬롯 재사용 (같은 idx)');
    assert.eq(B.gen, genA + 1, 'gen++ = 다른 개체');
    step(w, makeInput(), TICK_DT);                        // hitGen: (hitEpoch, e.gen) 쌍으로 판정
    assert.ok(!B.alive, 'B 가 피격 처치됨 — 재사용 슬롯을 통과하지 않는다 (hitGen 가드)');
  });

  test('같은 개체(gen 동일)는 hitCooldownSec 0 에서 재히트하지 않는다 (음성 대칭)', () => {
    const w = mk();
    silence(w);
    const slot = w.slots[0];
    const eff = { dmg: 1, projRadius: 6, pierce: 0, hitCooldownSec: 0, lifetimeSec: 999 };
    const b = spawnPlayerBullet(w, slot, eff, 600, 300, 0, 0, 1);
    b.pierceLeft = -1; b.lifetimeSec = 999;
    const A = spawnEnemy(w, 'drifter', 'normal', 600, 300, 100, false);   // 안 죽는 hp
    const hp0 = A.hp;
    step(w, makeInput(), TICK_DT);                        // 1히트
    const hp1 = A.hp;
    assert.lt(hp1, hp0, '1히트 = hp 감소');
    step(w, makeInput(), TICK_DT);                        // 같은 gen + hitCooldownSec 0 → 재히트 없음
    assert.eq(A.hp, hp1, 'hitCooldownSec 0 = 같은 대상 정확히 1회 (재히트 없음)');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('step · killEnemy 멱등 + §8.6 드랍 (D3) — 회귀', () => {
  test('killEnemy = XP 드랍 + 풀 release, 두 번째 호출은 무해 (멱등)', () => {
    const w = mk();
    const e = spawnEnemy(w, 'drifter', 'normal', 500, 300, 6, false);   // chaff, coin 0
    const xp = e.xp; const ex = e.x; const ey = e.y;
    const pickBefore = w.pickups.live;
    const enemyLive = w.enemies.live;
    killEnemy(w, e);
    assert.ok(!e.alive, '처치 후 release');
    assert.eq(w.enemies.live, enemyLive - 1, '적 풀 live 감소');
    assert.eq(w.pickups.live, pickBefore + 1, 'XP 픽업 1개 (chaff coinDropChance 0 → 코인 없음)');
    // 드랍된 XP 픽업 검증
    let found = null;
    for (const q of w.pickups.items) if (q.alive && q.kind === 'xp') { found = q; break; }
    assert.ok(found !== null, 'XP 픽업 존재');
    assert.eq(found.value, xp, 'XP value = e.xp');
    assert.eq(found.x, ex, '드랍 위치 x'); assert.eq(found.y, ey, '드랍 위치 y');
    // 멱등 — 같은 틱에 두 피해원이 부르는 상황
    const pickAfter = w.pickups.live; const enemyAfter = w.enemies.live;
    killEnemy(w, e);
    assert.eq(w.pickups.live, pickAfter, '이중 처치는 드랍을 두 번 하지 않는다');
    assert.eq(w.enemies.live, enemyAfter, '이중 release 없음 (free 스택 무결)');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('step · 레벨업 · 스탠스 · 발사', () => {
  test('레벨업 serial — 동시 다중은 병합 없이 순차 (§6.4)', () => {
    const w = mk();
    silence(w);
    const need = xpToNext(w, 1) + xpToNext(w, 2);         // 2레벨분 + 여분
    w.player.xp = need + 0.5;
    const q0 = w.draftQueue;
    step(w, makeInput(), TICK_DT);
    assert.eq(w.player.level, 3, 'Lv1 → Lv3 (2회 순차)');
    assert.eq(w.draftQueue, q0 + 2, '드래프트 큐 +2 (레벨당 1장)');
    assert.near(w.player.xp, 0.5, 1e-9, '남은 XP = 0.5 (float 누산)');
    assert.lt(w.player.xp, w.player.xpToNext, '다음 임계 미만');
  });

  test('스탠스 런 유지 — 부여 후 스텝을 흘려도 각인이 유지된다 (§4.3)', () => {
    const w = mk();
    silence(w);
    investElement(w, 'fire');                             // invest.fire = 1
    requestStance(w, 'fire');                             // stance fire, 슬롯 1..N = fire
    assert.eq(w.player.stance, 'fire', '스탠스 fire');
    assert.eq(w.slots[0].stampElement, 'fire', 'invest 1 → 슬롯1(=idx0) fire');
    assert.eq(w.slots[1].stampElement, 'normal', '슬롯2 이후 무속성');
    for (let i = 0; i < 30; i += 1) step(w, makeInput(), TICK_DT);
    assert.eq(w.player.stance, 'fire', '스탠스 입력 없으면 런 내내 유지');
    assert.eq(w.slots[0].stampElement, 'fire', '각인 유지 (재계산 이벤트 없음)');
  });

  test('발사 → 탄 스폰: forward 는 첫 틱에 즉시 발사 (cooldownT 0)', () => {
    const w = mk();
    assert.eq(w.playerBullets.live, 0, '시작 시 탄 0');
    step(w, makeInput(), TICK_DT);
    assert.gte(w.playerBullets.live, 1, '첫 틱에 볼리 발사');
    let b = null;
    for (const x of w.playerBullets.items) if (x.alive) { b = x; break; }
    assert.eq(b.family, 'forward', '발사 무기 = forward');
    assert.lt(b.vy, 0, '정면 = 화면 위쪽 (vy < 0)');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('step · 결정성 (§10.2/§10.3)', () => {
  test('같은 시드 + 같은 입력열 → 상태 비트 동일 / 다른 시드 → 상이', () => {
    const inputs = [down('up'), down('left'), makeInput(), down('right'), down('down')];
    function run(seed) {
      const w = mk(seed);
      for (let r = 0; r < 40; r += 1) step(w, inputs[r % inputs.length], TICK_DT);
      return JSON.stringify({
        x: w.player.x, y: w.player.y, tick: w.tick,
        pb: w.playerBullets.live, en: w.enemies.live,
        rngDraft: w.rng.draft.u32(),
      });
    }
    assert.eq(run(12345), run(12345), '같은 시드 = 비트 동일');
    assert.ne(run(12345), run(9999), '다른 시드 = 상이');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// §7.7 히트 피드백 — collide 가 상성 tier 를 render 로 실어 보낸다 (world.hitFx)
//   ★ 이것이 "3중 감각을 그릴 근거"의 전달 계약이다. 값은 elements.matrix 에서 유도(매직넘버 금지).
//   ★ 순수 장식이므로 판정(hp)·rng 에 영향 없음 + 같은 시드 → 버퍼 비트 동일 유지.
// ═════════════════════════════════════════════════════════════════════════

/** 자동발사 침묵 후, 지정 stamp 로 탄 1발을 (600,300)의 fire 적에 겹쳐 1스텝 때린다 */
function hitFireWith(stamp, { dmg = 1, hp = 100 } = {}, seed = 1) {
  const w = mk(seed);
  silence(w);
  const slot = w.slots[0];
  slot.stampElement = stamp;                              // spawnPlayerBullet 이 b.element 로 읽는다 (spawn 모드)
  const eff = { dmg, projRadius: 6, pierce: 0, hitCooldownSec: 0, lifetimeSec: 999 };
  spawnPlayerBullet(w, slot, eff, 600, 300, 0, 0, 1);
  const e = spawnEnemy(w, 'drifter', 'fire', 600, 300, hp, false);
  step(w, makeInput(), TICK_DT);
  return { w, e };
}

suite('step · §7.7 히트 tier 전달 (world.hitFx)', () => {
  test('불 적을 super/neutral/resist 스탬프로 때리면 각각 다른 tier 를 싣는다', () => {
    const M = loadData().elements.matrix;
    // 데이터 기반 기대값 (정본 LOCKED 매트릭스: water→fire=2, grass→fire=0.5, normal→fire=1)
    const cases = [
      ['water', 'super'],
      ['grass', 'resist'],
      ['normal', 'neutral'],
    ];
    for (const [stamp, tier] of cases) {
      const mul = elementMul(M, stamp, 'fire');
      const wantTier = mul > 1 ? 'super' : mul < 1 ? 'resist' : 'neutral';
      assert.eq(wantTier, tier, `사전조건: ${stamp}→fire mul=${mul}`);
      const { w } = hitFireWith(stamp);
      assert.eq(w.hitFx.count, 1, `${stamp}: 히트 이벤트 1건`);
      const ev = w.hitFx.buf[0];
      assert.eq(ev.tier, tier, `${stamp}: tier = ${tier}`);
      assert.eq(ev.element, stamp, `${stamp}: 공격 속성 실림 (버스트 색의 근거)`);
      assert.eq(ev.killed, false, `${stamp}: 안 죽는 hp → killed false`);
    }
  });

  test('세 tier 가 실제로 서로 다르다 (셋이 같으면 화면이 못 구분한다)', () => {
    const a = hitFireWith('water').w.hitFx.buf[0].tier;
    const b = hitFireWith('grass').w.hitFx.buf[0].tier;
    const c = hitFireWith('normal').w.hitFx.buf[0].tier;
    assert.ne(a, b, 'super ≠ resist');
    assert.ne(b, c, 'resist ≠ neutral');
    assert.ne(a, c, 'super ≠ neutral');
  });

  test('처치 시 killed=true + 위치·개체 id 가 실린다 (처치 FX·프리즈 바인딩 근거)', () => {
    const { w, e } = hitFireWith('water', { dmg: 999, hp: 3 });
    const ev = w.hitFx.buf[0];
    assert.eq(ev.tier, 'super', 'super 처치');
    assert.eq(ev.killed, true, '이 히트로 처치 → killed true');
    assert.eq(ev.x, 600, '히트 위치 x = 적 위치');
    assert.eq(ev.y, 300, '히트 위치 y = 적 위치');
    assert.eq(ev.enemyGen, e.gen, '개체 gen 실림 (재사용 슬롯 구분)');
  });

  test('count 는 매 스텝 리셋된다 — 「이번 틱」 신호 (히트 없는 스텝 = 0)', () => {
    const { w } = hitFireWith('water', { dmg: 1, hp: 100 });
    assert.eq(w.hitFx.count, 1, '히트 스텝 = 1');
    step(w, makeInput(), TICK_DT);   // hitCooldownSec 0 → 같은 적 재히트 없음 → 이 스텝은 히트 0
    assert.eq(w.hitFx.count, 0, '다음 스텝 = 리셋 (재히트 없음)');
  });

  test('히트 fx 는 결정적 — 같은 시드+입력 → hitFx 버퍼 비트 동일', () => {
    function sig(seed) {
      const { w } = hitFireWith('grass', { dmg: 1, hp: 100 }, seed);
      return JSON.stringify(w.hitFx.buf.slice(0, w.hitFx.count));
    }
    assert.eq(sig(7), sig(7), '같은 시드 = 비트 동일');
  });

  test('상성 tier 는 데미지에 쓴 stamp 와 같은 matrix 로 뽑는다 = I-2 (색은 거짓말 안 함)', () => {
    // live 스탬프(오빗류)가 아니어도, 데미지 감산이 실제로 ×2 였는지와 tier=super 가 함께 성립
    const M = loadData().elements.matrix;
    const { w, e } = hitFireWith('water', { dmg: 10, hp: 1000 });
    const dealt = e.hpMax - e.hp;
    // water→fire ×2, dmg 10, dmgMul/게이트 1 → 20 근처(부동소수 그대로)
    assert.near(dealt, 10 * elementMul(M, 'water', 'fire'), 1e-9, '실제 데미지 = ×2 반영');
    assert.eq(w.hitFx.buf[0].tier, 'super', '같은 히트가 super tier 로 표시됨');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 효과 로직 8종 회귀 가드 (step.js applyHit / applyStatus / collect / moveBullets)
//   과거 프로브 16/16 은 통과했으나 커밋된 단언이 0개였다 → 여기서 닫는다.
//   값은 전부 data/정본에서 유도한다. 각 경로 = 양성 + 경계/음성.
// ═════════════════════════════════════════════════════════════════════════

// ── 1. 피격 피해 (§3.2) — v1.5: 실드 폐지, 모든 피격이 진짜 ──────────────────
suite('step · 적 탄 피격 피해 (§3.2)', () => {
  test('적 탄 피격 → HP −enemyToPlayer + i-frame 발동 + 탄 소멸', () => {
    const w = mk();
    silence(w);
    const px = w.player.x; const py = w.player.y;
    const rp = w.data.rules.player;
    const dmg = bulletDef(w, 'pelletS').dmg;
    const expected = Math.ceil(Math.max(dmg - w.player.defense, dmg * rp.damageFloorRatio));  // §3.2
    spawnEnemyBullet(w, 'pelletS', px, py, 0, 0);
    const hp0 = w.player.hp;
    assert.eq(w.enemyBullets.live, 1, '피격 대상 탄 1개 배치');
    step(w, makeInput(), TICK_DT);
    assert.eq(w.player.hp, hp0 - expected, 'HP −enemyToPlayer (§3.2)');
    assert.eq(w.player.iframeSec, rp.iframeSec, 'i-frame 발동 = rules.player.iframeSec');
    assert.ok(w.player.hit, '피격 판정 (p.hit true)');
    assert.eq(w.enemyBullets.live, 0, '피해 준 그 탄은 소멸');
  });
});

// ── 3. slow 둔화 (§2.7) ───────────────────────────────────────────────────
suite('step · slow 둔화 (§2.7)', () => {
  test('slow 탄 피격 → slowSec 부여 · 이동 ×slowMoveSpeedMul · 1틱 감쇠', () => {
    const w = mk();
    silence(w);
    const px = w.player.x; const py = w.player.y;
    const dur = bulletDef(w, 'hexBolt').statusDurationSec;
    const mul = w.data.rules.status.slowMoveSpeedMul;
    const ms = w.data.rules.player.moveSpeed;
    spawnEnemyBullet(w, 'hexBolt', px, py, 0, 0);
    step(w, makeInput(), TICK_DT);                  // 피격 틱: readInput 이 먼저라 이 틱 이동엔 미적용
    assert.near(w.player.slowSec, dur, 1e-9, '피격 = 전체 지속 부여 (resist 0)');
    const y0 = w.player.y;
    step(w, down('up'), TICK_DT);                   // 다음 틱: 둔화 상태로 이동
    assert.near(y0 - w.player.y, ms * mul * TICK_DT, 1e-6, '둔화 이동 = moveSpeed×mul×dt');
    assert.near(w.player.slowSec, dur - TICK_DT, 1e-9, 'slowSec 1틱 감쇠');
  });

  test('slow 만료 후 이동 속도 원복 (경계)', () => {
    const w = mk();
    silence(w);
    const px = w.player.x; const py = w.player.y;
    const dur = bulletDef(w, 'hexBolt').statusDurationSec;
    const ms = w.data.rules.player.moveSpeed;
    spawnEnemyBullet(w, 'hexBolt', px, py, 0, 0);
    step(w, makeInput(), TICK_DT);
    const ticks = Math.ceil(dur / TICK_DT) + 2;
    for (let i = 0; i < ticks; i += 1) step(w, makeInput(), TICK_DT);   // 만료까지
    assert.eq(w.player.slowSec, 0, 'slowSec 만료 = 0');
    const y0 = w.player.y;
    step(w, down('up'), TICK_DT);
    assert.near(y0 - w.player.y, ms * TICK_DT, 1e-6, '원복 = 전속 이동 (둔화 배율 없음)');
  });
});

// ── 4. stun 스턴 (§2.7) ───────────────────────────────────────────────────
suite('step · stun 스턴 (§2.7)', () => {
  test('stun 탄 피격 → 이동 0 · 자동발사는 유지 · 감쇠 (§2.7 위치만 잠근다)', () => {
    const w = mk();                                 // ★ 무기 유지: 발사 지속을 검증
    const px = w.player.x; const py = w.player.y;
    const dur = bulletDef(w, 'stunMark').statusDurationSec;
    spawnEnemyBullet(w, 'stunMark', px, py, 0, 0);
    step(w, makeInput(), TICK_DT);                  // 피격 → 스턴
    assert.near(w.player.stunSec, dur, 1e-9, '스턴 지속 부여');
    const y0 = w.player.y;
    let firedWhileStunned = false;
    for (let i = 0; i < 40; i += 1) {               // forward 쿨다운 0.5s(30틱) → 이 창에서 최소 1볼리
      const pbBefore = w.playerBullets.live;
      const stunned = w.player.stunSec > 0;
      step(w, down('up'), TICK_DT);
      if (stunned && w.player.stunSec > 0 && w.playerBullets.live > pbBefore) firedWhileStunned = true;
    }
    assert.eq(w.player.y, y0, '스턴 내내 이동 0 (up 입력 무시)');
    assert.ok(firedWhileStunned, '스턴 중에도 자동발사 계속 (§2.7)');
    assert.ok(w.player.stunSec > 0, '40틱 후에도 스턴 잔여 (dur 1.0s = 60틱)');
  });

  test('stun 만료 후 이동 원복 (경계)', () => {
    const w = mk();
    silence(w);
    const px = w.player.x; const py = w.player.y;
    const dur = bulletDef(w, 'stunMark').statusDurationSec;
    const ms = w.data.rules.player.moveSpeed;
    spawnEnemyBullet(w, 'stunMark', px, py, 0, 0);
    step(w, makeInput(), TICK_DT);
    const ticks = Math.ceil(dur / TICK_DT) + 2;
    for (let i = 0; i < ticks; i += 1) step(w, makeInput(), TICK_DT);
    assert.eq(w.player.stunSec, 0, 'stunSec 만료 = 0');
    const y0 = w.player.y;
    step(w, down('up'), TICK_DT);
    assert.near(y0 - w.player.y, ms * TICK_DT, 1e-6, '원복 = 이동 재개');
  });
});

// ── 5·6. (v1.10 ㊲) reactive 반응 장갑 · afterimage 잔광 폐지 — 기체 패시브 4 = 강화 격벽·자세 안정기·학습 회로·상성 증폭

// ── 7. enemyExitForfeitsReward (§8.7) ─────────────────────────────────────
suite('step · enemyExitForfeitsReward (§8.7)', () => {
  test('적이 아레나 밖으로 나가면 XP/코인 픽업이 생기지 않는다 (보상 소멸)', () => {
    const w = mk();
    silence(w);
    const a = w.data.rules.view.arena;
    // 아레나 하단 근처 + 플레이어와 떨어진 x 에 두고 아래로 내보낸다 (killEnemy 아닌 release 경로)
    const e = spawnEnemy(w, 'drifter', 'normal', a.x + 30, a.y + a.h - 10, 6, false);
    e.vy = w.data.rules.player.moveSpeed;           // 아래로 이동
    assert.eq(w.enemies.live, 1, '적 1');
    assert.eq(w.pickups.live, 0, '드랍 전 픽업 0');
    let ticks = 0;
    while (w.enemies.live > 0 && ticks < 120) { step(w, makeInput(), TICK_DT); ticks += 1; }
    assert.eq(w.enemies.live, 0, '적이 화면 밖으로 나가 release 됨');
    assert.eq(w.pickups.live, 0, '보상 몰수 = XP·코인 픽업 0 (killEnemy 미경유)');
  });

  test('대조: 같은 적을 killEnemy 로 잡으면 XP 가 드랍된다 (양성 대칭)', () => {
    const w = mk();
    silence(w);
    const e = spawnEnemy(w, 'drifter', 'normal', 640, 300, 6, false);
    const pick0 = w.pickups.live;
    killEnemy(w, e);
    assert.eq(w.pickups.live, pick0 + 1, '처치 = XP 드랍 (exit 경로와 대비되는 보상 존재)');
  });
});

// ── 8. 상태이상 지속 (§2.7) — v1.5: 상점 resist 폐지, 항상 전체 지속 ──────────
suite('step · 상태이상 지속 (§2.7)', () => {
  test('slow 는 전체 지속 dur 로 적용 · 강도(이동 배율)는 불변', () => {
    const w = mk();
    silence(w);
    const px = w.player.x; const py = w.player.y;
    const dur = bulletDef(w, 'hexBolt').statusDurationSec;
    const mul = w.data.rules.status.slowMoveSpeedMul;
    const ms = w.data.rules.player.moveSpeed;
    spawnEnemyBullet(w, 'hexBolt', px, py, 0, 0);
    step(w, makeInput(), TICK_DT);
    assert.near(w.player.slowSec, dur, 1e-9, '지속 = 전체 dur');
    const y0 = w.player.y;
    step(w, down('up'), TICK_DT);
    assert.near(y0 - w.player.y, ms * mul * TICK_DT, 1e-6, '둔화 강도(×mul) 불변');
  });

  test('stun 도 전체 지속 dur 로 적용', () => {
    const w = mk();
    silence(w);
    const px = w.player.x; const py = w.player.y;
    const dur = bulletDef(w, 'stunMark').statusDurationSec;
    spawnEnemyBullet(w, 'stunMark', px, py, 0, 0);
    step(w, makeInput(), TICK_DT);
    assert.near(w.player.stunSec, dur, 1e-9, 'stun 지속 = 전체 dur');
  });
});

// ── applyHit 격리 게이트 (§2.4 뮤턴트 고정) ────────────────────────────────
suite('step · applyHit 격리 게이트 (§2.4)', () => {
  // ★ applyHit 는 step.js 가 "모든 피해원이 공유하는 단 하나의 게이트"로 못박은 함수다.
  //   i-frame 조기반환(약 349행)은 그 계약의 본체이나, 현재 호출자(collide 의 탄·몸통 2경로)가
  //   각기 다른 목적으로 호출 **전에** iframeSec 를 이미 게이트하므로 step() 경유로는 도달-무효과 →
  //   그 라인의 뮤턴트가 살아남았다. 이 격리 테스트가 applyHit 를 직접 불러 조기반환을 고정한다.
  test('i-frame 중 직접 호출 → false 반환 · HP/i-frame 불변', () => {
    const w = mk();
    silence(w);
    w.player.iframeSec = 0.5;                        // i-frame 활성
    const hp0 = w.player.hp;
    const ret = applyHit(w, 50);
    assert.eq(ret, false, 'i-frame 중 = 게이트로 false');
    assert.eq(w.player.hp, hp0, 'HP 불변 (피해 미적용)');
    assert.eq(w.player.iframeSec, 0.5, 'i-frame 재설정 없음 (조기반환)');
  });

  test('i-frame 0 이면 직접 호출 → true · 피해 적용 + i-frame 발동 (양성 대칭)', () => {
    const w = mk();
    silence(w);
    w.player.iframeSec = 0;
    const rp = w.data.rules.player;
    const hp0 = w.player.hp;
    const raw = 30;
    const expected = Math.ceil(Math.max(raw - w.player.defense, raw * rp.damageFloorRatio));
    const ret = applyHit(w, raw);
    assert.eq(ret, true, 'i-frame 0 = 피해 적용 true');
    assert.eq(w.player.hp, hp0 - expected, 'HP −enemyToPlayer(raw)');
    assert.eq(w.player.iframeSec, rp.iframeSec, 'i-frame 발동');
  });
});

// ── 탄 거동 v1.5 (가속 · 파동) ──────────────────────────────────────────────
suite('step · 탄 거동 v1.5 (가속·파동, §9.7)', () => {
  test('가속탄 — accel≠0 이면 속도가 accel×t 만큼 증가', () => {
    const w = mk(); silence(w);
    const b = spawnEnemyBullet(w, 'accelDart', 400, 100, 0, 90);   // 아래로 90px/s
    const sp0 = Math.hypot(b.vx, b.vy);
    for (let t = 0; t < 60; t += 1) step(w, makeInput(), TICK_DT);  // 1s
    const sp1 = Math.hypot(b.vx, b.vy);
    assert.gt(sp1, sp0, '1s 후 속도 증가');
    assert.near(sp1, sp0 + bulletDef(w, 'accelDart').accel, 1.5, 'Δ속도 = accel × 1s');
  });

  test('파동탄 — waveAmp≠0 이면 경로가 진행방향 수직으로 물결친다', () => {
    const w = mk(); silence(w);
    const b = spawnEnemyBullet(w, 'weaveBolt', 400, 30, 0, 120);   // 아래로 → 수직 진동축 = x
    const xs = [];
    for (let t = 0; t < 50; t += 1) { step(w, makeInput(), TICK_DT); xs.push(b.x); }
    assert.gt(Math.max(...xs) - Math.min(...xs), 20, 'x 가 좌우로 흔들린다 (물결)');
    // 대조: 직진탄(pelletS)은 x 불변
    const s = spawnEnemyBullet(w, 'pelletS', 150, 30, 0, 120);
    for (let t = 0; t < 50; t += 1) step(w, makeInput(), TICK_DT);
    assert.near(s.x, 150, 1e-6, '직진탄은 x 불변 (물결 아님)');
  });
});

// ── 유령몹 (§8.9 v1.5) ──────────────────────────────────────────────────────
suite('step · 유령몹 (§8.9 v1.5)', () => {
  test('유령몹 = xp·score 0, 처치해도 XP 픽업 없음 (파밍 불가)', () => {
    const w = mk(); silence(w);
    const def = w.data.enemies.archetypes.find((a) => a.id === 'drifter');
    // 일반 잡몹: xp>0, 처치 시 xp 픽업 1
    const normal = spawnEnemy(w, 'drifter', 'normal', 200, 200, def.hp, false, false);
    assert.gt(normal.xp, 0, '일반 잡몹 xp>0');
    const normalXp = normal.xp;                 // ★ killEnemy 는 개체를 풀에 반납한다 — 뒤에서 재사용되므로 «값»을 잡아 둔다
    const before = w.pickups.items.filter((p) => p.alive && p.kind === 'xp').length;
    killEnemy(w, normal);
    assert.eq(w.pickups.items.filter((p) => p.alive && p.kind === 'xp').length - before, 1, '일반 잡몹 = xp 픽업 1');
    // ★ v1.10 ㊿-f — 유령몹: score 는 여전히 0(순위표 파밍 차단)이지만 xp 는 «ghostXpRatio 만큼» 준다.
    //   0 이던 시절엔 중간보스 구간(웨이브 정지 → 죽일 게 유령뿐)의 XP 가 정확히 0 이었다.
    const ratio = w.data.rules.boss.ghostXpRatio;
    assert.ok(ratio > 0 && ratio < 1, `ghostXpRatio ∈ (0,1) — 지금 ${ratio}`);
    const ghost = spawnEnemy(w, 'drifter', 'normal', 300, 200, def.hp, false, true);
    assert.eq(ghost.ghost, true, 'ghost 플래그');
    assert.eq(ghost.score, 0, '유령 score 0 (점수는 못 판다)');
    assert.near(ghost.xp, normalXp * ratio, 1e-9, '유령 xp = 같은 개체 × ghostXpRatio');
    assert.lt(ghost.xp, normalXp, '유령이 일반보다 적다 = 파밍 유인 없음');
    const g0 = w.pickups.items.filter((p) => p.alive && p.kind === 'xp').length;
    killEnemy(w, ghost);
    assert.eq(w.pickups.items.filter((p) => p.alive && p.kind === 'xp').length - g0, 1, '유령 처치도 구슬 1개는 남긴다');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('step · §2.6 ㊼ XP 구슬은 내려온다 (사거리 긴 무기가 자기 보상을 못 받던 회귀)', () => {
  test('구슬은 xpDriftPxSec 로 내려오고, 아래 끝을 뚫지 않는다', () => {
    const w = mk(); silence(w);
    const rp = w.data.rules.player;
    assert.gt(rp.xpDriftPxSec, 0, '낙하 속도가 저작돼 있다');
    const far = w.player.x + rp.magnetRadius * 3;              // 자석 밖(가로로 떨어진 자리)
    const q = spawnPickup(w, 'xp', 3, far, 60);                 // 화면 맨 위에서 죽은 적의 구슬
    const y0 = q.y;
    for (let i = 0; i < 60; i += 1) step(w, makeInput(), TICK_DT);
    assert.gt(q.y, y0, `내려왔다 (${y0} → ${q.y.toFixed(0)})`);
    assert.near(q.y - y0, rp.xpDriftPxSec, 2, '한 게임초에 xpDriftPxSec 만큼');
    for (let i = 0; i < 60 * 3; i += 1) step(w, makeInput(), TICK_DT);
    assert.ok(q.y <= w.bounds.maxY + 1, `아래 끝을 뚫고 내려가지 않는다 (y ${q.y.toFixed(0)} ≤ ${w.bounds.maxY})`);
  });

  // ★ v1.10 ㊿-l — 바닥에 닿은 구슬은 «가로로» 플레이어에게 흘러온다.
  //   내려오기만 하면 바닥선에 줄지어 쌓인다: 실측(포지션 5 위기 32초) 회수율 43~61%, 살아 있는 구슬의 66~72% 가 바닥에 붙어 있었다.
  test('바닥에 닿으면 플레이어 쪽으로 흘러와 결국 회수된다 (바닥에 줄지어 쌓이지 않는다)', () => {
    const w = mk(); silence(w);
    const rp = w.data.rules.player;
    const before = w.player.xp;
    const far = w.player.x + rp.magnetRadius * 3;
    const q = spawnPickup(w, 'xp', 3, far, 60);
    const x0 = q.x;
    for (let i = 0; i < 60 * 8; i += 1) step(w, makeInput(), TICK_DT);
    assert.ok(Math.abs(q.alive ? q.x - w.player.x : 0) < Math.abs(x0 - w.player.x), '플레이어 쪽으로 가까워졌다');
    for (let i = 0; i < 60 * 20; i += 1) step(w, makeInput(), TICK_DT);
    assert.eq(w.pickups.live, 0, '결국 회수됐다');
    assert.gt(w.player.xp, before, 'XP 가 들어왔다');
  });

  test('가로 흐름은 즉시가 아니다 — 자리잡기가 여전히 의미를 갖는다', () => {
    const w = mk(); silence(w);
    const rp = w.data.rules.player;
    const far = w.player.x + rp.magnetRadius * 3;
    const q = spawnPickup(w, 'xp', 3, far, w.bounds.maxY);      // 이미 바닥
    const x0 = q.x;
    step(w, makeInput(), TICK_DT);
    assert.near(Math.abs(q.x - x0), rp.xpDriftPxSec * TICK_DT, 1e-6, '한 틱에 xpDriftPxSec × dt 만큼만');
  });

  test('맨 위에서 죽어도 결국 먹을 수 있다 — 같은 세로줄이면 자석에 걸린다 (실측 회귀: 만렙 빔 478처치 XP 0)', () => {
    const w = mk(); silence(w);
    const before = w.player.xp;
    spawnPickup(w, 'xp', 5, w.player.x, 60);                    // 플레이어 «바로 위»에서 죽은 적
    for (let i = 0; i < 60 * 12; i += 1) step(w, makeInput(), TICK_DT);
    assert.eq(w.pickups.live, 0, '구슬이 회수됐다');
    assert.gt(w.player.xp, before, 'XP 가 들어왔다');
  });
});
