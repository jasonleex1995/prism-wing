/**
 * tests/score.test.mjs — §11.3 런 점수 (src/core/score.js).
 *
 * 정본 계약 (★ v1.5: 경제 폐지 — 실드/토큰/컨티뉴/코인 항 제거):
 *   처치 점수의 초효과 보너스는 **막타가 아니라 누적 피해 지분**(attribution "damageShare").
 *   피격은 그 스테이지 무피격을 깬다(실드 없음). 보스 잔여 타이머는 항상 시간 보너스.
 *   퍼펙트 = 승리 + 전 스테이지 무피격. floor 는 마지막에 딱 한 번(roundMode).
 */

import { suite, test, assert, loadData } from '../tools/test.mjs';
import { createWorld, spawnEnemy } from '../src/core/state.js';
import { killEnemy, applyHit } from '../src/core/step.js';
import { weapons } from '../src/core/weapons/index.js';
import { enemies } from '../src/core/enemies.js';
import { emitters } from '../src/core/emitters.js';
import { bossHook } from '../src/core/boss.js';
import { initRun, tickRun } from '../src/core/stage.js';
import { addKill, addBossClear, addMidBossClear, addRunClear, tally } from '../src/core/score.js';

function mkWorld(difficulty) {
  const w = createWorld({
    data: loadData(), seed: 1, weapons, difficulty,
    hooks: { run: tickRun, enemies, emitters, boss: bossHook },
  });
  initRun(w);
  return w;
}
const S = () => loadData().meta.score;

suite('score/처치 §11.3', () => {
  test('초효과 보너스는 누적 피해 지분 기준 (막타 아님)', () => {
    const w = mkWorld();
    const s = S();
    const def = loadData().enemies.archetypes.find((a) => a.id === 'drifter');

    // 지분 미달 — ×2 피해가 절반 미만
    const a = spawnEnemy(w, 'drifter', 'normal', 600, 200, def.hp, false);
    a.dmgTotal = 100; a.dmgSuper = 10;
    addKill(w, a);
    assert.eq(w.score.kills, a.score, '지분 미달 = 보너스 없음');

    // 지분 충족 — 정확히 기준선도 포함(≥)
    const b = spawnEnemy(w, 'drifter', 'normal', 620, 200, def.hp, false);
    b.dmgTotal = 100; b.dmgSuper = 100 * s.superEffectiveDamageShare;
    const before = w.score.kills;
    addKill(w, b);
    assert.near(w.score.kills - before, b.score * (1 + s.superEffectiveKillBonusRatio), 1e-9,
      '지분 충족 = 점수 × (1 + 보너스비율)');
  });

  test('피해가 0인 개체는 보너스 없음 (지분이 정의되지 않는다)', () => {
    const w = mkWorld();
    const def = loadData().enemies.archetypes.find((a) => a.id === 'drifter');
    const e = spawnEnemy(w, 'drifter', 'normal', 600, 200, def.hp, false);
    e.dmgTotal = 0; e.dmgSuper = 0;
    addKill(w, e);
    assert.eq(w.score.kills, e.score, '지분 미정의 = 기본 점수만');
  });

  test('killEnemy 가 처치 점수를 준다 (경로 연결)', () => {
    const w = mkWorld();
    const def = loadData().enemies.archetypes.find((a) => a.id === 'drifter');
    const e = spawnEnemy(w, 'drifter', 'normal', 600, 200, def.hp, false);
    const sc = e.score;
    killEnemy(w, e);
    assert.eq(w.score.kills, sc, 'killEnemy → addKill');
  });
});

suite('score/무피격 · 보너스', () => {
  test('피격은 그 스테이지 무피격을 깬다 (v1.5: 실드 폐지 = 모든 피격이 진짜)', () => {
    const w = mkWorld();
    assert.ok(w.score.noHit[0], '초기 무피격(전제)');
    applyHit(w, 10);
    assert.eq(w.score.noHit[0], false, '피격 = 무피격 깨짐');
  });

  test('보스 격파 = 격파 보너스 + 잔여 타이머 × timeBonusPerGameSec', () => {
    const w = mkWorld();
    const s = S();
    addBossClear(w, 40);
    assert.eq(w.score.bossClear, s.bossClearBonus, '격파 보너스');
    assert.eq(w.score.time, 40 * s.timeBonusPerGameSec, '시간 보너스 = 잔여 × 계수');
  });

  test('중간보스 · 런 클리어 보너스', () => {
    const w = mkWorld();
    addMidBossClear(w); addRunClear(w);
    assert.eq(w.score.midBossClear, S().midBossClearBonus, '중간보스');
    assert.eq(w.score.runClear, S().runClearBonus, '런 클리어');
  });
});

suite('score/집계 tally', () => {
  test('전 스테이지 무피격 + 승리 = 퍼펙트 (v1.5: 컨티뉴 폐지)', () => {
    const w = mkWorld();
    w.run.won = true;                                   // ★ 퍼펙트는 승리한 런에만 성립(§11.3)
    const t = tally(w);
    assert.eq(t.noHitCount, w.score.noHit.length, '6/6 무피격');
    assert.ok(t.perfect, '퍼펙트 성립');
    assert.eq(t.perfectBonus, S().perfectBonus, '퍼펙트 보너스');
  });

  test('미승리 런은 무피격이어도 퍼펙트가 아니다 (타임아웃 익스플로잇 방지)', () => {
    const w = mkWorld();
    w.run.won = false; w.run.stageIndex = 2;            // 스테이지 3에서 사망(1~2만 클리어)
    const t = tally(w);
    assert.eq(t.noHitCount, 2, '클리어한 2 스테이지만 무피격으로 센다');
    assert.ok(!t.perfect, '미승리 = 퍼펙트 아님');
    assert.eq(t.perfectBonus, 0, '퍼펙트 보너스 0');
  });

  test('㊿-u 클리어 시간 = 실제로 플레이한 초(틱 ÷ tickHz ÷ 배속) — 사망한 런에는 없다', () => {
    for (const id of ['normal', 'hard', 'hell']) {
      const w = mkWorld(id);
      const speed = w.data.meta.difficulty[id].speed;
      const hz = w.data.rules.loop.tickHz;
      w.tick = 45276;                                // 45,276틱 = 게임초 754.6
      w.time = 0;                                    // ★ world.time 은 읽지 않는다(1/60 누적의 소수 오차) — 틱으로 센다
      w.run.won = true;
      const got = tally(w).clearSec;
      assert.lt(Math.abs(got - 45276 / hz / speed), 1e-9, `${id}: 승리 = 틱 ÷ ${hz} ÷ 배속 ${speed} (실제 ${got})`);
      if (speed > 1) assert.lt(got, 45276 / hz, `${id}: 배속이 빠르면 실제로 흐른 시간은 게임초보다 짧다(헬 24분이 30:00 으로 보이면 안 된다)`);
      w.run.won = false;
      assert.eq(tally(w).clearSec, null, `${id}: 미승리(사망 · 시간 초과) = null`);
    }
  });

  test('floor 는 마지막 한 번 (roundMode) — 소수 raw 로 pre-floor 회귀를 잡는다', () => {
    const w = mkWorld('hell');                          // scoreMul 2.5
    for (let i = 0; i < w.score.noHit.length; i += 1) w.score.noHit[i] = false;  // 보너스 격리
    // ★ raw 를 «소수»로 만든다(초효과 킬 보너스가 실전에서 score.kills 를 소수로 만드는 것과 동형).
    //   중간에 floor 하는 회귀면 floor(10.7)=10 → floor(10×2.5)=25 로 정답과 달라진다 = 뮤턴트 검출.
    w.score.kills = 10.7;                               // raw = 10.7 → ×2.5 = 26.75 → floor 26
    const t = tally(w);
    assert.eq(t.scoreMul, loadData().meta.difficulty.hell.scoreMul, '난이도 배율');
    assert.eq(t.total, Math.floor(10.7 * t.scoreMul), '총점 = floor(합 × 배율) — floor 1회 (26 ≠ pre-floor 25)');
  });

  test('난이도별 배율이 총점에 반영된다 — 표에 있는 난이도 «전부»가 순증', () => {
    // ★ 난이도 id 를 하드코딩하지 않는다(㊿ 에서 「디재스터」가 삭제됐다). 표를 읽고 그 순서대로 본다.
    const diff = loadData().meta.difficulty;
    const ids = Object.keys(diff).filter((k) => diff[k] !== null && typeof diff[k] === 'object');
    assert.gt(ids.length, 1, '난이도가 둘 이상');
    const mk = (d) => { const w = mkWorld(d); w.score.kills = 1000; return tally(w).total; };
    for (let i = 1; i < ids.length; i += 1) {
      assert.gt(mk(ids[i]), mk(ids[i - 1]), `${ids[i]} > ${ids[i - 1]}`);
    }
  });

  test('미지 난이도는 소리내어 실패', () => {
    const w = mkWorld('nope');
    assert.throws(() => tally(w), '미지 난이도 → throw');
  });
});
