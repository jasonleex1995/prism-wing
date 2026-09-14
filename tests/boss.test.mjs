/**
 * tests/boss.test.mjs — 복합 보스(boss.js) + 처치 규칙(step.killBossEntity)의 정본(§8.11~§8.14) 단위 테스트.
 *
 * 커버:
 *   spawnBoss — 코어+파트 스폰 · HP × bossHpScale[포지션] · finale 절대HP · aliveArmorPartCount = armor 수
 *   killBossEntity — armor 파트 처치 = 게이트 1단 해제 / mobility 는 불변 / 코어 처치 = cleared + 전 개체 반납
 *   bossHook — BOSS 페이즈 1회 스폰(가드) + 파트가 코어+anchor 추종
 *   §8.11 봉인 — **탄 경로와 직접피해 경로 양쪽** 모두에서 무적인가 (한쪽만 막던 회귀 방지)
 *   clearField — 보스 등장 시 잔존 잡몹·적탄 정리
 */

import { suite, test, assert, loadData, baselineDifficulty } from '../tools/test.mjs';
import { createWorld, spawnEnemy, spawnEnemyBullet, spawnPlayerBullet, recomputeEff, familyDmgMul } from '../src/core/state.js';
import { killEnemy, step, makeInput, TICK_DT } from '../src/core/step.js';
import { weapons } from '../src/core/weapons/index.js';
import { enemies } from '../src/core/enemies.js';
import { emitters } from '../src/core/emitters.js';
import { bossHook, spawnBoss } from '../src/core/boss.js';
import { hitEnemy } from '../src/core/damage.js';
import { stampFor } from '../src/core/stance.js';
import { initRun, tickRun, stageEntry, PHASE } from '../src/core/stage.js';

function mkRunWorld(seed, stageIndex) {
  // ㉟ 시작 무기 풀이 10종(속성)이 되어 추첨이 빔·체인(탄 없음)을 뽑을 수 있다 — 탄 전제 테스트는 벌컨으로 못박는다
  const w = createWorld({ data: loadData(), seed, weapons, startWeaponId: 'forward', difficulty: baselineDifficulty(),
    hooks: { run: tickRun, enemies, emitters, boss: bossHook } });
  initRun(w);
  if (stageIndex !== undefined) w.run.stageIndex = stageIndex;
  return w;
}
function bossDefFor(w) {
  const id = stageEntry(w).bossId;
  return w.data.bosses.bosses.find((b) => b.id === id);
}
function scanBoss(w) {
  let core = null; const parts = [];
  for (const e of w.enemies.items) if (e.alive && e.isBoss) { if (e.isCore) core = e; else parts.push(e); }
  return { core, parts };
}
function livePickups(w, kind) {
  let n = 0; for (const p of w.pickups.items) if (p.alive && p.kind === kind) n += 1; return n;
}

suite('boss/spawnBoss', () => {
  test('코어 + 파트 스폰, HP × bossHpScale[포지션], 코어는 닫힌 채(sealedNow) 시작 (㉘)', () => {
    const w = mkRunWorld(1, 0);
    const def = bossDefFor(w);
    assert.eq(def.tier, 'stage', '포지션 0 = 스테이지 보스');
    spawnBoss(w);
    const { core, parts } = scanBoss(w);
    assert.ok(core, '코어 스폰됨');
    // §8.9.1(v1.5) 동적 발사 파트: 포지션 0 = firingPartsPerStage[0] (base 만, extra 0)
    const target0 = w.data.stages.curve.firingPartsPerStage[0];
    const baseCount = def.parts.filter((p) => p.extra !== true).length;
    const extraCount = def.parts.filter((p) => p.extra === true).length;
    const expected0 = baseCount + Math.max(0, Math.min(target0 - baseCount, extraCount));
    assert.eq(parts.length, expected0, `파트 수 = ${expected0} (포지션0 target ${target0})`);
    const scale = w.data.stages.curve.bossHpScale[0];
    assert.near(core.hp, def.core.hp * scale, 1e-6, '코어 HP = core.hp × bossHpScale[0]');
    assert.near(core.hpMax, core.hp, 1e-9, 'hpMax = hp');
    assert.eq(core.sealedNow, true, '모듈이 있으니 코어는 닫혀서 시작 (§8.13 하드 게이트)');
  });

  test('§8.9.1(v1.5) 발사 파트 수가 런 포지션으로 성장 (3,3,4,5,6,7)', () => {
    for (let s = 0; s < 6; s += 1) {
      const w = mkRunWorld(1, s);
      const want = w.data.stages.curve.firingPartsPerStage[s];
      spawnBoss(w);
      assert.eq(scanBoss(w).parts.length, want, `포지션 ${s}: 발사 파트 = ${want}`);
    }
  });

  test('후반 포지션: 코어 HP 가 bossHpScale 로 커진다 (포지션 3)', () => {
    const w = mkRunWorld(1, 3);                       // 여전히 themed 스테이지(0..4)
    const def = bossDefFor(w);
    spawnBoss(w);
    const { core } = scanBoss(w);
    assert.near(core.hp, def.core.hp * w.data.stages.curve.bossHpScale[3], 1e-6, '포지션 3 스케일');
    assert.gt(w.data.stages.curve.bossHpScale[3], w.data.stages.curve.bossHpScale[0], '진행할수록 커진다');
  });

  test('finale(tetrarch): 절대 HP (bossHpScale 미적용)', () => {
    const w = mkRunWorld(1, 5);                       // finale 포지션
    const def = w.data.bosses.bosses.find((b) => b.tier === 'final');
    spawnBoss(w);
    const { core } = scanBoss(w);
    assert.near(core.hp, def.core.hp, 1e-6, 'finale 코어 HP = 절대값(스케일 없음)');
  });

  test('회귀: 보스 개체도 shapeId 를 들고 있다 (렌더는 archetypes 에서 모양을 못 찾는다)', () => {
    // 보스는 archetypeId 가 '' 라 렌더가 아키타입으로 도형을 찾으면 **보스 등장 프레임마다 예외**가 난다.
    const w = mkRunWorld(1, 0);
    spawnBoss(w);
    const { core, parts } = scanBoss(w);
    assert.gt(core.shapeId.length, 0, '코어 shapeId 보유');
    for (const p of parts) assert.gt(p.shapeId.length, 0, `파트(${p.partId}) shapeId 보유`);
    const def = loadData().enemies.archetypes.find((a) => a.id === 'drifter');
    const e = spawnEnemy(w, 'drifter', 'normal', 600, 200, def.hp, false);
    assert.eq(e.shapeId, def.shapeId, '잡몹 shapeId = 아키타입 shapeId');
  });

  test('파트가 코어+anchor 위치에 배치된다', () => {
    const w = mkRunWorld(2, 0);
    spawnBoss(w);
    const { core, parts } = scanBoss(w);
    for (const p of parts) {
      assert.near(p.x, core.x + p.anchorX, 1e-6, '파트 x = 코어+anchorX');
      assert.near(p.y, core.y + p.anchorY, 1e-6, '파트 y = 코어+anchorY');
    }
  });
});

suite('boss/처치 규칙 (killBossEntity)', () => {
  test('하드 게이트(㉘) — 모듈이 하나라도 살아 있으면 코어는 무적(탄 통과·피해 0), 마지막 모듈이 죽은 «다음 틱»에 열린다', () => {
    const w = mkRunWorld(3, 0);
    w.run.phase = PHASE.BOSS; w.run.bossSpawned = false; w.run.bossTimer = w.data.stages.phase.bossTimerSec;
    step(w, makeInput(), TICK_DT);
    const { core, parts } = scanBoss(w);
    assert.gt(parts.length, 0, '모듈이 있다');
    w.run.bossTransitionT = 0;
    const ctx = w.dmgCtx; ctx.matrix = w.data.elements.matrix;
    assert.eq(core.sealedNow, true, '닫힘');
    assert.eq(hitEnemy(w, ctx, 'forward', 50, 1, 'normal', core, 0), 0, '닫힌 코어엔 피해 0');
    // 모듈을 하나만 남기고 부순다 — 여전히 닫힘 (armor 든 아니든 «모듈» 이다)
    for (let i = 0; i < parts.length - 1; i += 1) killEnemy(w, parts[i]);
    step(w, makeInput(), TICK_DT);
    assert.eq(core.sealedNow, true, '하나라도 남으면 닫힘');
    assert.eq(hitEnemy(w, ctx, 'forward', 50, 1, 'normal', core, 0), 0, '여전히 0');
    assert.ok(core.alive, '코어 생존 (파트 파괴 ≠ 보스 사망)');
    assert.eq(w.run.cleared, false, '파트 파괴는 클리어 아님');
    // 마지막 모듈
    const last = parts.find((p) => p.alive);
    killEnemy(w, last);
    step(w, makeInput(), TICK_DT);
    assert.eq(core.sealedNow, false, '모듈 0 → 열림');
    const hp0 = core.hp;
    assert.gt(hitEnemy(w, ctx, 'forward', 50, 1, 'normal', core, 0), 0, '열린 코어엔 피해가 든다');
    assert.lt(core.hp, hp0, 'HP 감소');
  });

  test('닫힌 코어를 지나는 탄은 소멸하지 않고 통과한다(파트 봉인과 같은 규약)', () => {
    const w = mkRunWorld(5, 0);
    w.run.phase = PHASE.BOSS; w.run.bossSpawned = false; w.run.bossTimer = w.data.stages.phase.bossTimerSec;
    step(w, makeInput(), TICK_DT);
    const { core } = scanBoss(w);
    w.run.bossTransitionT = 0;
    const s0 = w.slots[0];
    const eff = recomputeEff(w, s0);
    for (const s2 of w.slots) s2.weaponId = null;                 // 자동 발사 끔(탄은 직접 놓는다)
    const b = spawnPlayerBullet(w, s0, eff, core.x, core.y, 0, 0, 1);
    const hp0 = core.hp;
    step(w, makeInput(), TICK_DT);
    assert.ok(b.alive, '탄이 소멸하지 않는다(통과)');
    assert.eq(core.hp, hp0, '코어 HP 불변');
  });

  test('코어 처치 → run.cleared + 모든 보스 개체 반납 (v1.5: 코인 드랍 폐지)', () => {
    const w = mkRunWorld(5, 0);
    spawnBoss(w);
    const { core } = scanBoss(w);
    killEnemy(w, core);
    assert.ok(w.run.cleared, 'stage clear 신호');
    let bossLeft = 0; for (const e of w.enemies.items) if (e.alive && e.isBoss) bossLeft += 1;
    assert.eq(bossLeft, 0, '코어+모든 파트 반납');
  });

  test('보스 처치는 잡몹 드랍(xp) 경로를 타지 않는다', () => {
    const w = mkRunWorld(6, 0);
    spawnBoss(w);
    const { core } = scanBoss(w);
    const xpBefore = livePickups(w, 'xp');
    killEnemy(w, core);
    assert.eq(livePickups(w, 'xp'), xpBefore, '보스 개체는 xp 드랍 없음 (§8.11 xp 0)');
  });

  test('mobility 파트 파괴 → 폭주 (§8.12 v1.5: speedPxSec ×mobilityPenalty(1.5) · 스웨이 유지 · 발사 격화)', () => {
    const w = mkRunWorld(1, 0);
    w.run.order[0] = 'sea';                            // manta = thruster(mobility) 보유 (결정적)
    spawnBoss(w);
    w.run.phase = PHASE.BOSS; w.run.bossSpawned = true; w.run.bossTimer = 100;
    const mob = scanBoss(w).parts.filter((p) => p.partType === 'mobility');
    assert.gt(mob.length, 0, 'manta 는 mobility 파트(thruster) 보유');
    assert.eq(w.run.bossMoveSpeedMul, 1, '초기 속도 배율 1');
    assert.eq(w.run.bossMoveAmpMul, 1, '초기 진폭 배율 1');
    assert.eq(w.run.bossFireRateMul, 1, '초기 발사 배율 1');
    killEnemy(w, mob[0]);
    assert.eq(w.run.bossMoveSpeedMul, w.data.rules.boss.mobilityPenalty, 'speedPxSec ×mobilityPenalty(폭주 1.5)');
    assert.eq(w.run.bossMoveAmpMul, 1, 'ampPx 유지 (스웨이 유지 — 격렬하게 왕복, 정지 아님)');
    assert.eq(w.run.bossFireRateMul, w.data.rules.boss.escalateFireRateMul, '부위 파괴 = 발사 격화');
  });
});

suite('boss/레이어 봉인 (§8.11 v1.5)', () => {
  test('낮은 레이어(앞)가 살아있으면 높은 레이어(불 키스톤)는 무적 — kiln', () => {
    const w = mkRunWorld(1, 0);
    w.run.order[0] = 'volcano';                        // kiln — turret/plate(불,L1) · vent(물,L0)
    spawnBoss(w);
    w.run.phase = PHASE.BOSS; w.run.bossSpawned = true; w.run.bossTimer = 100; w.run.bossTransitionT = 0;
    bossHook(w, TICK_DT);                              // sealedNow 계산
    const parts = scanBoss(w).parts;
    const turret = parts.find((p) => p.partId === 'turret');
    const plate = parts.find((p) => p.partId === 'plate');
    const vent = parts.find((p) => p.partId === 'vent');
    assert.ok(turret && plate && vent, 'turret·plate·vent 스폰');
    assert.eq(turret.sealLayer, 1, 'turret sealLayer=1');
    assert.eq(vent.sealLayer, 0, 'vent sealLayer=0');
    assert.eq(turret.sealedNow, true, 'turret 봉인 (L0 vent 생존)');
    assert.eq(plate.sealedNow, true, 'plate 봉인');
    assert.eq(vent.sealedNow, false, 'vent 열림 (최소 레이어)');

    // 데미지 게이트: 봉인 파트는 탄이 닿아도 hp 불변, 열린 파트는 감소
    const s = w.slots[0];
    const hp0 = turret.hp;
    spawnPlayerBullet(w, s, recomputeEff(w, s), turret.x, turret.y, 0, 0, 1);
    step(w, makeInput(), TICK_DT);
    assert.eq(turret.hp, hp0, '봉인 파트 = 피해 0 (탄 통과)');
    const ventHp0 = vent.hp;
    spawnPlayerBullet(w, s, recomputeEff(w, s), vent.x, vent.y, 0, 0, 1);
    step(w, makeInput(), TICK_DT);
    assert.lt(vent.hp, ventHp0, '열린 파트는 피해를 받는다');
  });

  // ★ 회귀 방지 — 봉인은 v1.5에서 신설되며 step.collide(탄 경로)에만 들어갔고
  //   damage.hitEnemy(직접피해 경로)에는 빠져 있었다. 그래서 nova·lance·barrage·fan진화
  //   4무기가 「무적」 부위를 그대로 부쉈다. 위 테스트가 탄만 쏘느라 못 잡았으므로,
  //   같은 불변식을 **직접피해 경로에서도** 고정한다.
  test('★ 봉인 파트는 직접피해(hitEnemy) 경로에서도 무적이다', () => {
    const w = mkRunWorld(1, 0);
    w.run.order[0] = 'volcano';
    spawnBoss(w);
    w.run.phase = PHASE.BOSS; w.run.bossSpawned = true; w.run.bossTimer = 100; w.run.bossTransitionT = 0;
    bossHook(w, TICK_DT);
    const parts = scanBoss(w).parts;
    const turret = parts.find((p) => p.partId === 'turret');
    const vent = parts.find((p) => p.partId === 'vent');
    assert.eq(turret.sealedNow, true, '전제: turret 봉인');
    assert.eq(vent.sealedNow, false, '전제: vent 열림');

    // 무기 모듈(§9.5)이 만드는 것과 동일한 §3.1 컨텍스트
    const ctx = {
      matrix: w.data.elements.matrix,
      dmgMulSum: familyDmgMul(w, 'nova'),   // ㊲ 패밀리의 피해 스탯(노바 = areaDmgMul)
      elementBonusMul: w.stats.elementBonusMul,
    };
    const stamp = stampFor(w, 0, 'spawn', w.slots[0].stampElement);

    const tHp = turret.hp;
    assert.eq(hitEnemy(w, ctx, 'nova', 9999, 1, stamp, turret, 0), 0, '봉인 파트 = 직접피해 0');
    assert.eq(turret.hp, tHp, '봉인 파트 hp 불변');

    const vHp = vent.hp;
    assert.gt(hitEnemy(w, ctx, 'nova', 50, 1, stamp, vent, 0), 0, '열린 파트는 직접피해를 받는다');
    assert.lt(vent.hp, vHp, '열린 파트 hp 감소');
  });

  test('낮은 레이어를 다 부수면 높은 레이어가 열린다 (봉인 불사 방지)', () => {
    const w = mkRunWorld(1, 0);
    w.run.order[0] = 'volcano';
    spawnBoss(w);
    w.run.phase = PHASE.BOSS; w.run.bossSpawned = true; w.run.bossTimer = 100; w.run.bossTransitionT = 0;
    bossHook(w, TICK_DT);
    for (const p of scanBoss(w).parts) if (p.sealLayer === 0) killEnemy(w, p);   // 최소 레이어 전멸
    bossHook(w, TICK_DT);
    const parts = scanBoss(w).parts;
    assert.gt(parts.length, 0, 'L1 파트 생존');
    for (const p of parts) assert.eq(p.sealedNow, false, `${p.partId} 봉인 해제 (최소 레이어 상승)`);
  });
});

suite('boss/페이즈 전환 (§8.11)', () => {
  test('코어 HP 임계 통과 → 전환(무적·타이머 정지) 후 파트 phase 각인', () => {
    const w = mkRunWorld(1, 0);
    w.run.order[0] = 'sea';
    spawnBoss(w);
    w.run.phase = PHASE.BOSS; w.run.bossSpawned = true; w.run.bossTimer = 100;
    const { core } = scanBoss(w);
    const thr = w.data.rules.boss.phaseThresholds;    // [0.6, 0.3]

    // 코어 HP 를 0.6 미만·0.3 초과(phase-1 밴드)로 → 다음 step 의 bossHook 이 전환 시작
    core.hp = core.hpMax * ((thr[0] + thr[1]) / 2);    // ≈0.45
    step(w, makeInput(), TICK_DT);
    assert.eq(w.run.bossPhase, 1, '목표 페이즈 1로 전환');
    assert.gt(w.run.bossTransitionT, 0, '전환 창(무적) 시작');

    // 전환 중 타이머 정지 — run 훅이 boss 훅보다 앞서 시작 틱에 1틱 오차가 있으므로, 시작 다음
    //   틱부터의 안정성을 본다(결정적·무시 가능한 경계 오차, §6.3 의 의미는 "전환 동안 멈춘다").
    const timerDuring = w.run.bossTimer;
    // 전환 중 무적: 코어에 정지 탄을 겹쳐도 무피해
    const slot = w.slots[0]; const eff = recomputeEff(w, slot);
    spawnPlayerBullet(w, slot, eff, core.x, core.y, 0, 0, 1);
    const hp0 = core.hp;
    for (let t = 0; t < 10; t += 1) step(w, makeInput(), TICK_DT);
    assert.eq(w.run.bossTimer, timerDuring, '전환 중 보스 타이머 정지(시작 다음 틱부터)');
    assert.eq(core.hp, hp0, '전환 중 코어 무적');

    // 전환 종료 → 파트 phase 1 각인
    const need = Math.ceil(w.data.rules.boss.phaseTransitionSec * 60) + 2;
    for (let t = 0; t < need; t += 1) step(w, makeInput(), TICK_DT);
    assert.eq(w.run.bossTransitionT, 0, '전환 종료');
    for (const pt of scanBoss(w).parts) assert.eq(pt.phase, 1, '파트 patternSet phase 1 각인');
  });

  test('전환은 임계당 1회 (같은 밴드 재진입 없음)', () => {
    const w = mkRunWorld(2, 0);
    w.run.order[0] = 'sea';
    spawnBoss(w);
    w.run.phase = PHASE.BOSS; w.run.bossSpawned = true; w.run.bossTimer = 100;
    const { core } = scanBoss(w);
    core.hp = core.hpMax * 0.5;
    step(w, makeInput(), TICK_DT);                     // phase 0→1 전환 시작
    assert.eq(w.run.bossPhase, 1, 'phase 1');
    // 전환 끝까지
    for (let t = 0; t < Math.ceil(w.data.rules.boss.phaseTransitionSec * 60) + 2; t += 1) step(w, makeInput(), TICK_DT);
    assert.eq(w.run.bossTransitionT, 0, '전환 종료');
    // 같은 phase-1 밴드에서 더 이상 전환 없음
    w.player.iframeSec = 99999;
    step(w, makeInput(), TICK_DT);
    assert.eq(w.run.bossPhase, 1, '같은 밴드 재전환 없음');
    assert.eq(w.run.bossTransitionT, 0, '전환 재시작 없음');
  });
});

suite('boss/bossHook · clearField', () => {
  test('bossHook: BOSS 페이즈서 1회만 스폰(가드), 비-BOSS 페이즈선 아무것도 안 함', () => {
    const w = mkRunWorld(1, 0);
    w.run.phase = PHASE.MOB;
    bossHook(w, TICK_DT);
    assert.eq(scanBoss(w).core, null, 'MOB 페이즈선 보스 스폰 없음');

    w.run.phase = PHASE.BOSS; w.run.bossSpawned = false;
    bossHook(w, TICK_DT);
    assert.ok(w.run.bossSpawned, '스폰 후 가드 세팅');
    assert.ok(scanBoss(w).core, '코어 스폰됨');
    bossHook(w, TICK_DT);                                       // 재호출
    let cores = 0; for (const e of w.enemies.items) if (e.alive && e.isBoss && e.isCore) cores += 1;
    assert.eq(cores, 1, '재스폰 없음 (bossSpawned 가드)');
  });

  test('회귀(partHitPriority outermostFirst): 코어+파트에 겹친 탄은 파트가 흡수, 코어 무피해', () => {
    const w = mkRunWorld(1, 0);
    spawnBoss(w);
    w.run.phase = PHASE.BOSS; w.run.bossSpawned = true; w.run.bossTimer = 100;
    const { core, parts } = scanBoss(w);
    // 코어와 겹치는(anchor 길이 < core.r + part.r) 파트 하나
    let part = null;
    for (const p of parts) if (Math.hypot(p.anchorX, p.anchorY) < core.radius + p.radius) { part = p; break; }
    assert.ok(part, '코어와 겹치는 파트 존재 (양성 경로)');

    // 코어↔파트 중점에 정지 플레이어 탄 (둘 다에 겹치게)
    const slot = w.slots[0]; const eff = recomputeEff(w, slot);
    const bx = core.x + part.anchorX * 0.5;
    const by = core.y + part.anchorY * 0.5;
    const b = spawnPlayerBullet(w, slot, eff, bx, by, 0, 0, 1);
    assert.ok(b, '탄 스폰');
    const overCore = (core.x - bx) ** 2 + (core.y - by) ** 2 <= (core.radius + b.radius) ** 2;
    const overPart = (part.x - bx) ** 2 + (part.y - by) ** 2 <= (part.radius + b.radius) ** 2;
    assert.ok(overCore && overPart, '탄이 코어·파트 둘 다에 겹친다 (테스트 전제)');

    const coreHp0 = core.hp;
    let partsHp0 = 0; for (const p of parts) partsHp0 += p.hp;
    step(w, makeInput(), TICK_DT);
    let partsHp1 = 0; for (const p of parts) partsHp1 += p.hp;
    assert.lt(partsHp1, partsHp0, '파트가 피해를 받는다 (흡수)');
    assert.eq(core.hp, coreHp0, '코어는 무피해 — 파트가 가린다 (§8.11)');
  });

  test('보스 파트가 patternSet 이미터로 발사한다 (텔레그래프 리드 후, 파트 위치=상반부에서)', () => {
    const w = mkRunWorld(1, 0);
    spawnBoss(w);
    w.run.phase = PHASE.BOSS; w.run.bossSpawned = true; w.run.bossTimer = 200;
    w.player.iframeSec = 99999;                       // 관찰 무적(피격 사망 방지)
    const arena = w.data.rules.view.arena;
    let sawTop = false;
    for (let t = 0; t < 180; t += 1) {                 // 3초
      step(w, makeInput(), TICK_DT);
      for (const b of w.enemyBullets.items) if (b.alive && b.y < arena.y + arena.h * 0.4) sawTop = true;
    }
    assert.gt(w.enemyBullets.live, 0, '보스가 적 탄을 쏜다');
    assert.ok(sawTop, '적 탄이 아레나 상반부(보스 파트 위치)에서 발생 — 플레이어가 아니라 파트가 쏜다');
  });

  test('보스 발사는 결정적 (같은 시드 → 같은 적탄 수)', () => {
    function fire(seed) {
      const w = mkRunWorld(seed, 0);
      spawnBoss(w);
      w.run.phase = PHASE.BOSS; w.run.bossSpawned = true; w.run.bossTimer = 200; w.player.iframeSec = 99999;
      for (let t = 0; t < 150; t += 1) step(w, makeInput(), TICK_DT);
      return w.enemyBullets.live;
    }
    assert.eq(fire(2), fire(2), '동일 시드 = 동일 적탄 수(결정성)');
  });

  test('§9.8.1(v1.5) 코어도 발사한다 — 파트를 다 없애도 코어 원거리 탄이 나온다', () => {
    const w = mkRunWorld(3, 0);
    spawnBoss(w);
    w.run.phase = PHASE.BOSS; w.run.bossSpawned = true; w.run.bossTimer = 200;
    w.run.bossTransitionT = 0; w.player.iframeSec = 99999;
    for (const e of w.enemies.items) if (e.alive && e.isBoss && !e.isCore) killEnemy(w, e);   // 파트 전멸 → 코어만
    for (const b of w.enemyBullets.items) if (b.alive) w.enemyBullets.release(b);             // 잔탄 소거
    for (let t = 0; t < 300; t += 1) step(w, makeInput(), TICK_DT);
    assert.gt(w.enemyBullets.live, 0, '코어만 남아도 적 탄이 나온다 (코어 발사 = 원거리 압박)');
    const coreEm = w.data.enemies.emitters.find((e) => e.id === w.data.rules.boss.coreEmitterId);
    assert.ok(w.enemyBullets.items.some((b) => b.alive && b.bulletId === coreEm.bulletId), '코어 이미터 탄이다');
  });

  test('clearField: 보스 등장 시 잔존 잡몹·적탄 정리', () => {
    const w = mkRunWorld(1, 0);
    const def = loadData().enemies.archetypes.find((a) => a.id === 'drifter');
    spawnEnemy(w, 'drifter', 'normal', 600, 200, def.hp, false);
    spawnEnemy(w, 'drifter', 'water', 620, 220, def.hp, false);
    spawnEnemyBullet(w, 'pelletS', 600, 300, 0, 100);
    assert.gte(w.enemies.live, 2, '잡몹 존재');
    assert.gte(w.enemyBullets.live, 1, '적탄 존재');
    spawnBoss(w);
    let mobs = 0; for (const e of w.enemies.items) if (e.alive && !e.isBoss) mobs += 1;
    assert.eq(mobs, 0, '잡몹 전부 정리됨');
    assert.eq(w.enemyBullets.live, 0, '적탄 전부 정리됨');
    assert.ok(scanBoss(w).core, '보스는 남는다');
  });
});
