/**
 * tests/visible.test.mjs — §8.20 가시 피해 (v1.8) · §8.7.1 웨이브 몸 수 하한 · §12.1 유령 예산
 *
 * 정본 계약:
 *   §8.20  판정 사각형 = render/draw.drawWorld 의 clip 사각형(rules.view.arena)과 «같은 것».
 *          몸(중심 ± radius)이 그 사각형과 겹칠 때만 피해를 받는다 — 보이면 맞고, 안 보이면 안 맞는다.
 *          게이트는 «두 경로 모두»에 있다: 탄 경로(step.collide)와 직접피해(damage.hitEnemy).
 *          탄은 «통과»하고 관통을 소모하지 않는다(§8.11 봉인의 「무적이되 탄은 통과」와 같은 계약).
 *   §8.20  대칭 — min(view.playerBoundsInset) > player.hitboxRadius 인 한, 아레나와 겹치지 않는
 *          적은 «반지름과 무관하게» 몸통 충돌도 줄 수 없다.
 *   §8.7.1 웨이브 몸 수의 하한은 밴드가 소유한다(bands[].minPerWave).
 *   §12.1  유령·중간보스는 웨이브 예산 밖이고, 유령은 자기 몫으로 enemyConcurrentMax 를 갖는다.
 */
import { suite, test, assert, loadData } from '../tools/test.mjs';
import { onScreen, hitEnemy } from '../src/core/damage.js';
import { createWorld, spawnEnemy, spawnPlayerBullet } from '../src/core/state.js';
import { step, TICK_DT } from '../src/core/step.js';
import { weapons } from '../src/core/weapons/index.js';
import { enemies, waveLive } from '../src/core/enemies.js';
import { emitters } from '../src/core/emitters.js';
import { bossHook } from '../src/core/boss.js';
import { initRun, tickRun, PHASE } from '../src/core/stage.js';

const d = loadData();
const A = d.rules.view.arena;

function mkWorld(seed = 1) {
  return createWorld({ data: loadData(), seed, weapons, hooks: { run: tickRun, enemies, emitters, boss: bossHook } });
}
function ctxOf(w) {
  return { matrix: w.data.elements.matrix, dmgMulSum: 0, elementBonusMul: 1 };
}

// ── ① 술어 = 클립 사각형 ────────────────────────────────────────────────
suite('visible/§8.20 술어', () => {
  test('네 변 각각 — 1px 걸치면 화면 안, 1px 밖이면 화면 밖', () => {
    const r = 10;
    assert.ok(onScreen(A, { x: A.x - r + 1, y: 300, radius: r }), '좌: 1px 걸침');
    assert.ok(!onScreen(A, { x: A.x - r, y: 300, radius: r }), '좌: 1px 밖');
    assert.ok(onScreen(A, { x: A.x + A.w + r - 1, y: 300, radius: r }), '우: 1px 걸침');
    assert.ok(!onScreen(A, { x: A.x + A.w + r, y: 300, radius: r }), '우: 1px 밖');
    assert.ok(onScreen(A, { x: 600, y: A.y - r + 1, radius: r }), '상: 1px 걸침');
    assert.ok(!onScreen(A, { x: 600, y: A.y - r, radius: r }), '상: 1px 밖');
    assert.ok(onScreen(A, { x: 600, y: A.y + A.h + r - 1, radius: r }), '하: 1px 걸침');
    assert.ok(!onScreen(A, { x: 600, y: A.y + A.h + r, radius: r }), '하: 1px 밖');
  });

  test('스폰 라인은 «가장 큰» 잡몹으로도 화면 밖이다 (도입 구간이 진짜 무적 구간이라는 뜻)', () => {
    let rMax = 0;
    for (const a of d.enemies.archetypes) if (a.radius > rMax) rMax = a.radius;
    const eliteR = rMax * d.rules.elite.sizeMult;
    assert.gt(eliteR, 0, '최대 반지름 > 0');
    assert.ok(!onScreen(A, { x: 600, y: d.rules.view.spawnLineY, radius: eliteR }),
      `spawnLineY(${d.rules.view.spawnLineY}) + 최대 반지름(${eliteR}) 이 아레나와 겹치지 않는다`);
  });
});

// ── ② 직접피해 경로(hitEnemy) ──────────────────────────────────────────
suite('visible/§8.20 직접피해', () => {
  test('화면 밖 적은 hitEnemy 가 0 을 돌려준다 / 같은 적이 화면 안이면 피해가 들어간다', () => {
    const w = mkWorld();
    const e = spawnEnemy(w, 'drifter', 'normal', 600, d.rules.view.spawnLineY, 100, false);
    assert.ok(e !== null, '스폰 성공');
    const hpBefore = e.hp;
    const out = hitEnemy(w, ctxOf(w), 'nova', 40, 1, 'normal', e, 0);
    assert.eq(out, 0, '화면 밖 = 반환 0');
    assert.eq(e.hp, hpBefore, '화면 밖 = hp 불변');
    e.y = 200;                                  // 같은 적을 아레나 «안»으로
    const out2 = hitEnemy(w, ctxOf(w), 'nova', 40, 1, 'normal', e, 0);
    assert.gt(out2, 0, '화면 안 = 피해 > 0 (대조군)');
    assert.lt(e.hp, hpBefore, '화면 안 = hp 감소');
  });
});

// ── ③ 탄 경로(step.collide) ────────────────────────────────────────────
function fireAt(w, e) {
  const slot = { index: 0, family: 'forward', stampElement: 'normal' };
  const eff = { dmg: 40, pierce: 3, projRadius: 6, hitCooldownSec: 0, lifetimeSec: 5 };
  return spawnPlayerBullet(w, slot, eff, e.x, e.y, 0, 0, 1);
}
const NOINPUT = { mx: 0, my: 0, stance: 0, bomb: false, pause: false };

suite('visible/§8.20 탄 경로', () => {
  test('화면 밖 적에 겹친 탄은 피해 0 · 관통 미소모 · 탄 생존', () => {
    const w = mkWorld();
    initRun(w);
    const e = spawnEnemy(w, 'drifter', 'normal', 600, d.rules.view.spawnLineY, 100, false);
    const b = fireAt(w, e);
    assert.ok(b !== null, '탄 스폰');
    const pierce0 = b.pierceLeft;
    const hp0 = e.hp;
    step(w, NOINPUT, TICK_DT);
    assert.eq(e.hp, hp0, '화면 밖 = hp 불변');
    assert.ok(b.alive, '탄이 살아 있다 (흡수가 아니라 통과)');
    assert.eq(b.pierceLeft, pierce0, '관통 미소모');
  });

  test('대조군 — 같은 탄이 아레나 «안»의 적에게는 피해를 준다', () => {
    const w = mkWorld();
    initRun(w);
    const e = spawnEnemy(w, 'drifter', 'normal', 600, 300, 100, false);
    const b = fireAt(w, e);
    const hp0 = e.hp;
    step(w, NOINPUT, TICK_DT);
    assert.lt(e.hp, hp0, '화면 안 = 피해가 들어간다');
    assert.lt(b.pierceLeft, 3, '화면 안 = 관통 소모');
  });
});

// ── ④ 대칭 ──────────────────────────────────────────────────────────────
suite('visible/§8.20 대칭', () => {
  test('min(playerBoundsInset) > hitboxRadius — 아레나 밖 적은 몸통 충돌도 못 준다', () => {
    const ins = Object.values(d.rules.view.playerBoundsInset);
    const mn = Math.min(...ins);
    assert.gt(mn, d.rules.player.hitboxRadius,
      `min(inset)=${mn} > hitboxRadius=${d.rules.player.hitboxRadius} (적 반지름과 무관한 증명의 전제)`);
  });
});

// ── ⑤ §8.7.1 몸 수 하한 · §12.1 유령 예산 ──────────────────────────────
suite('visible/§8.7.1 · §12.1 예산', () => {
  test('밴드 하한은 4밴드 전부 선언되고 hpMult 오름차순으로 비증가다', () => {
    const bs = Object.entries(d.enemies.bands).map(([k, v]) => [k, v.hpMult, v.minPerWave]);
    for (const [k, , m] of bs) assert.ok(Number.isInteger(m) && m >= 1, `bands.${k}.minPerWave 정수 ≥1`);
    bs.sort((a, b) => a[1] - b[1]);
    for (let i = 1; i < bs.length; i += 1) {
      assert.lte(bs[i][2], bs[i - 1][2], `${bs[i - 1][0]} → ${bs[i][0]} 하한 비증가`);
    }
  });

  test('chaff 웨이브는 minPerWave 아래로 스폰하지 않는다', () => {
    const w = mkWorld(7);
    initRun(w);
    w.run.phase = PHASE.MOB;
    w.run.stageIndex = 0;
    enemies(w, TICK_DT);
    let n = 0;
    // v1.10 — 마리수는 무공격 밴드(chaff) 기준이고, 그중 shooterRatio 만큼이 공격형(다른 밴드일 수 있다).
    //   하한은 «웨이브 몸 수 전체»의 계약이다 — 공격형 자리도 그 몸 수 안에 있다.
    for (const e of w.enemies.items) if (e.alive) n += 1;
    assert.gte(n, d.enemies.bands.chaff.minPerWave, '첫 웨이브 몸 수 ≥ chaff.minPerWave');
  });

  test('waveLive 는 유령·중간보스를 «세지 않는다» (§12.1 예산의 분리)', () => {
    const w = mkWorld(3);
    initRun(w);
    w.run.phase = PHASE.BOSS;
    spawnEnemy(w, 'drifter', 'normal', 600, 200, 10, false);
    const base = waveLive(w);
    assert.eq(base, 1, '웨이브 잡몹 1');
    spawnEnemy(w, 'drifter', 'normal', 610, 210, 10, false, true);   // 유령
    assert.eq(waveLive(w), base, '유령은 웨이브 예산에 들어가지 않는다');
    assert.eq(w.enemies.live, 2, '풀의 live 는 둘 다 센다 (B층은 여전히 본다)');
  });
});
