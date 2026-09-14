/**
 * tests/stage.test.mjs — 런 오케스트레이션(stage.js)의 정본(§6.5·§8.1·§6.3) 계약 단위 테스트.
 *
 * 커버:
 *   추첨(§8.1) — 6포지션·finale 끝·themed 중복 없음·stage1 introOk·물불풀 전부(구조 증명 200시드)·결정성
 *   페이즈 기계(§6.3·§6.5) — MOB→(crisis)→BOSS_INTRO→BOSS→STAGE_CLEAR/승리, 타이머 만료 즉사
 *   전환 — advanceStage 포지션+1·MOB 리셋 / applyStageClearHeal pct·hpMax 회복·클램프 / stageEntry
 */

import { suite, test, assert, loadData } from '../tools/test.mjs';
import { createWorld } from '../src/core/state.js';
import { TICK_DT } from '../src/core/step.js';
import { weapons } from '../src/core/weapons/index.js';
import { initRun, tickRun, advanceStage, applyStageClearHeal, stageEntry, isFinale, PHASE } from '../src/core/stage.js';

const dt = TICK_DT;
function mkWorld(seed = 1) { return createWorld({ data: loadData(), seed, weapons, hooks: {} }); }
function elementOf(world, id) { return world.data.stages.stages.find((x) => x.id === id).element; }

// ══════════════════════════════════════════════════════════════════════════
// 추첨 (§8.1)
// ══════════════════════════════════════════════════════════════════════════
suite('stage/추첨 §8.1', () => {
  test('구조 증명(200시드): 6포지션·finale 끝·중복 없음·stage1 introOk·물불풀 전부', () => {
    const finale = loadData().stages.themeDraw.finalStageId;
    let checked = 0;
    for (let seed = 0; seed < 200; seed += 1) {
      const w = mkWorld(seed);
      const order = initRun(w).order;
      assert.eq(order.length, 6, `seed ${seed}: 6 포지션`);
      assert.eq(order[5], finale, `seed ${seed}: 마지막 = finale`);

      const themed = order.slice(0, 5);
      assert.eq(new Set(themed).size, 5, `seed ${seed}: themed 5종 중복 없음`);
      assert.ok(!themed.includes(finale), `seed ${seed}: finale 는 themed 자리에 없다`);

      const s1 = w.data.stages.stages.find((x) => x.id === order[0]);
      assert.ok(s1.introOk, `seed ${seed}: stage-1(${order[0]}) introOk`);

      const els = new Set(themed.map((id) => elementOf(w, id)));
      for (const e of ['water', 'fire', 'grass']) assert.ok(els.has(e), `seed ${seed}: ${e} 테마 ≥1`);
      checked += 1;
    }
    assert.eq(checked, 200, '200시드 전수 검사');
  });

  test('결정성: 같은 시드 → 같은 순서', () => {
    assert.eq(initRun(mkWorld(42)).order.join(','), initRun(mkWorld(42)).order.join(','), '동일 시드 = 동일 순서');
  });

  test('rng.theme 만 소비: 스테이지 추첨이 spawn/draft 스트림을 흔들지 않는다', () => {
    // 독립 스트림 증명 — initRun 전후로 다른 스트림의 다음 draw 가 불변
    const a = mkWorld(7); const before = a.rng.spawn.f();
    const b = mkWorld(7); initRun(b); const after = b.rng.spawn.f();
    assert.eq(before, after, 'theme 추첨은 spawn 스트림을 이동시키지 않는다');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 페이즈 기계 (§6.3 · §6.5)
// ══════════════════════════════════════════════════════════════════════════
suite('stage/페이즈 §6.5', () => {
  test('MOB → 위기(내부 서브구간) → BOSS_INTRO 타이밍', () => {
    const w = mkWorld(); const run = initRun(w); const ph = w.data.stages.phase;
    assert.eq(run.phase, PHASE.MOB, '시작 = MOB');

    run.phaseT = ph.crisisStartSec - dt * 2;
    tickRun(w, dt);
    assert.eq(run.crisis, false, 'crisisStartSec 전 = 위기 아님');

    run.phaseT = ph.crisisStartSec;
    tickRun(w, dt);
    assert.ok(run.crisis, 'crisisStartSec 후 = 위기');
    assert.eq(run.phase, PHASE.MOB, '위기는 여전히 MOB (독립 상태 아님, §6.5)');

    run.phaseT = ph.mobPhaseSec;
    tickRun(w, dt);
    assert.eq(run.phase, PHASE.BOSS_INTRO, 'mobPhaseSec 후 = BOSS_INTRO');
    assert.eq(run.crisis, false, '전이 시 위기 해제');
    assert.eq(run.phaseT, 0, '새 페이즈 시계 리셋');
  });

  test('BOSS_INTRO → BOSS: introSec 후 타이머 장전(timerStartsAfterIntro)', () => {
    const w = mkWorld(); const run = initRun(w);
    const boss = w.data.rules.boss; const ph = w.data.stages.phase;
    run.phase = PHASE.BOSS_INTRO; run.phaseT = boss.introSec;
    tickRun(w, dt);
    assert.eq(run.phase, PHASE.BOSS, 'introSec 후 = BOSS');
    assert.eq(run.bossTimer, ph.bossTimerSec, '타이머 = bossTimerSec');
    assert.eq(run.bossSpawned, false, '보스 스폰 트리거 대기');
  });

  test('BOSS 타이머 만료 = 즉사 (deathCause timeout · over) — 만료는 한 틱 미뤄 확정된다', () => {
    const w = mkWorld(); const run = initRun(w);
    run.phase = PHASE.BOSS; run.bossTimer = dt * 0.5;   // 반 틱 남음
    tickRun(w, dt);
    assert.eq(run.bossTimer, 0, '타이머 0');
    assert.ok(run.timedOut, '만료 flag (이 틱엔 미확정 — 막타 기회)');
    assert.ok(!w.over, '만료 틱엔 아직 over 아님');
    tickRun(w, dt);                                     // 다음 틱: cleared 없으면 확정
    assert.eq(run.deathCause, 'timeout', '사인 = 시간초과');
    assert.ok(w.over, 'over');
  });

  test('BOSS 격파(비-finale) → STAGE_CLEAR (런 계속)', () => {
    const w = mkWorld(); const run = initRun(w);
    run.stageIndex = 0;
    assert.ok(!isFinale(w), '포지션 0 = finale 아님');
    run.phase = PHASE.BOSS; run.bossTimer = 100; run.cleared = true;
    tickRun(w, dt);
    assert.eq(run.phase, PHASE.STAGE_CLEAR, '격파 → STAGE_CLEAR');
    assert.eq(run.cleared, false, '격파 신호 소화됨');
    assert.eq(w.over, false, '런은 계속');
  });

  test('finale 격파 → 승리 (won · over, 엔드리스 없음)', () => {
    const w = mkWorld(); const run = initRun(w);
    run.stageIndex = 5;
    assert.ok(isFinale(w), '포지션 5 = finale');
    run.phase = PHASE.BOSS; run.bossTimer = 100; run.cleared = true;
    tickRun(w, dt);
    assert.ok(run.won, '승리 플래그');
    assert.ok(w.over, 'over');
  });

  test('회귀: 막판 격파는 타임아웃보다 우선한다 (cleared 를 timer 보다 먼저 소화)', () => {
    const w = mkWorld(); const run = initRun(w);
    run.stageIndex = 0;
    run.phase = PHASE.BOSS; run.bossTimer = dt * 0.5; run.cleared = true;  // 타이머 0 임박 + 격파 신호 동시
    tickRun(w, dt);
    assert.eq(run.phase, PHASE.STAGE_CLEAR, '격파가 타임아웃을 이긴다 → STAGE_CLEAR');
    assert.eq(run.deathCause, null, '시간초과 사망으로 뒤집히지 않는다');
    assert.eq(w.over, false, '런 계속');
  });

  test('회귀: finale 막판 격파 → 승리 (타임아웃 패배 아님)', () => {
    const w = mkWorld(); const run = initRun(w);
    run.stageIndex = 5;
    run.phase = PHASE.BOSS; run.bossTimer = dt * 0.5; run.cleared = true;
    tickRun(w, dt);
    assert.ok(run.won, '승리');
    assert.eq(run.deathCause, null, '시간초과 아님');
    assert.ok(w.over, 'over(승리 종료)');
  });

  test('음성: STAGE_CLEAR 에서 tickRun 은 게임클럭을 진행시키지 않는다(대기)', () => {
    const w = mkWorld(); const run = initRun(w);
    run.phase = PHASE.STAGE_CLEAR;
    const before = run.stageIndex;
    tickRun(w, dt);
    assert.eq(run.phase, PHASE.STAGE_CLEAR, '드라이버 대기 — 스스로 전이하지 않는다');
    assert.eq(run.stageIndex, before, '포지션 불변');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 전환 (advanceStage · heal · stageEntry)
// ══════════════════════════════════════════════════════════════════════════
suite('stage/전환', () => {
  test('advanceStage: 포지션 +1, MOB 리셋', () => {
    const w = mkWorld(); const run = initRun(w);
    run.stageIndex = 0; run.phase = PHASE.STAGE_CLEAR; run.phaseT = 5; run.bossTimer = 30;
    advanceStage(w);
    assert.eq(run.stageIndex, 1, '다음 포지션');
    assert.eq(run.phase, PHASE.MOB, 'MOB 리셋');
    assert.eq(run.phaseT, 0, '시계 리셋');
    assert.eq(run.bossTimer, 0, '보스 타이머 리셋');
  });

  test('applyStageClearHeal: pct·hpMax 회복, hpMax 클램프', () => {
    const w = mkWorld(); initRun(w);
    const pct = w.data.meta.flow.stageClearHealPct;
    const p = w.player;
    assert.gt(pct, 0, 'stageClearHealPct > 0 (양성 경로)');
    p.hp = 10;
    applyStageClearHeal(w);
    assert.near(p.hp, Math.min(p.hpMax, 10 + pct * p.hpMax), 1e-9, '10 + pct·hpMax');
    p.hp = p.hpMax;
    applyStageClearHeal(w);
    assert.eq(p.hp, p.hpMax, 'hpMax 초과 없음(클램프)');
  });

  test('stageEntry: 현재 포지션의 stages 엔트리 + bossId 보유', () => {
    const w = mkWorld(); const run = initRun(w);
    const e = stageEntry(w);
    assert.eq(e.id, run.order[0], '현재 스테이지 id 일치');
    assert.ok(e.bossId, 'bossId 존재');
  });
});

