/**
 * tests/midboss.test.mjs — 중간보스(§8.9)의 정본 계약 단위 테스트.
 *
 * 원칙(MEMORY ★★): 값은 데이터/정본에서 유도한다(하드코딩 매직넘버 지양).
 *
 * 커버:
 *   스케줄 — midBossAtSec 시각에 등장 / 스테이지당 마릿수 == curve.midBossCount / 동시 1마리
 *   속성   — notThemeAndNotNormal(테마 속성 아님 · 노말 아님) / 최종 스테이지는 후보 3종 + 비복원
 *   HP     — bosses[].hp × curve.bossHpScale[stageIndex] (★ enemyHpScale 이 아니다)
 *   이탈   — v1.10: 타이머 이탈 폐지(위기 전엔 안 떠난다) / midBossForcedLeaveOnCrisis = 퇴장 연출 + **보상 0**
 *   구간   — §8.19(v1.10): 첫 마리 = midBossFirstId(소환자), 나머지는 다른 형태 / 전원 격파 = 즉시 위기(crisisOnMidBossClear)
 *   이동   — anchor: yHoldPx 까지 하강 후 swayAmpPx 왕복
 *            charge: ★ 회귀 — 스폰 라인(아레나 밖 위쪽)에서 시작해도 실제로 돌진한다
 *   소환   — mbNest 만 summon 이 non-null(S17) / everySec 마다 count 마리 / 원점 = 소환자
 *   발사   — §8.9-R8 이미터 2개가 **각자의 스케줄**로 돈다(mbHammer = fan 탄 + mortar 투척폭탄 둘 다)
 *   처치   — xp 확정 드랍 + 중간보스 격파 점수 + 반납 (v1.5: 코인 폐지)
 */

import { suite, test, assert, loadData, baselineDifficulty } from '../tools/test.mjs';
import { createWorld, spawnMidBoss } from '../src/core/state.js';
import { step, makeInput, TICK_DT, killEnemy } from '../src/core/step.js';
import { weapons } from '../src/core/weapons/index.js';
import { emitters } from '../src/core/emitters.js';
import { enemies } from '../src/core/enemies.js';
import { initRun, tickRun } from '../src/core/stage.js';
import { midBoss } from '../src/core/midboss.js';

const dt = TICK_DT;

function mkRun(seed = 1, withEmitters = false) {
  const world = createWorld({
    data: loadData(), seed, weapons, difficulty: baselineDifficulty(),
    hooks: { enemies: null, emitters: withEmitters ? emitters : null, run: null, boss: null },
  });
  initRun(world);
  world.player.hp = 1e9; world.player.hpMax = 1e9;      // 관측 중 사망하지 않게
  return world;
}
function midOf(world) {
  for (const e of world.enemies.items) if (e.alive && e.midBossId !== '') return e;
  return null;
}
function defOf(world, id) {
  for (const b of world.data.bosses.bosses) if (b.id === id) return b;
  throw new Error(`no boss ${id}`);
}
function midDefs(world) {
  return world.data.bosses.bosses.filter((b) => b.tier === 'mid');
}
/** run 훅 없이 «잡몹 페이즈 시계»만 흘린다(중간보스 계약만 본다) */
function tickMob(world, n) {
  const ph = world.data.stages.phase;
  for (let i = 0; i < n; i += 1) {
    world.run.phaseT += dt;
    world.run.crisis = world.run.phaseT >= ph.crisisStartSec;
    midBoss(world, dt);
    step(world, makeInput(), dt);
  }
}
function livePickups(world) {
  return world.pickups.items.filter((p) => p.alive);
}

// ══════════════════════════════════════════════════════════════════════
suite('midboss — 등장 스케줄 (§8.9)', () => {
  test('midBossAtSec 시각에 등장하고, 그 전엔 없다', () => {
    const w = mkRun(2);
    const at = w.data.stages.phase.midBossAtSec[0][0];
    tickMob(w, Math.floor(at / dt) - 2);
    assert.eq(midOf(w), null, '예정 시각 전엔 없다');
    tickMob(w, 4);
    assert.ne(midOf(w), null, '예정 시각에 등장');
  });

  test('스테이지당 등장 마릿수 == curve.midBossCount', () => {
    const counts = loadData().stages.curve.midBossCount;
    for (let idx = 0; idx < counts.length; idx += 1) {
      const w = mkRun(5 + idx);
      w.run.stageIndex = idx;
      const ph = w.data.stages.phase;
      tickMob(w, Math.floor(ph.crisisStartSec / dt));
      // §8.9(v1.5) 동시 다수 — «등장 수»는 스폰 카운터로 센다(겹쳐 나오므로 null 전이로 못 센다).
      assert.eq(w.run.midBossNext, counts[idx], `스테이지 ${idx + 1} 등장 수 = midBossCount`);
    }
  });

  test('§8.9(v1.5) 동시 다수 — 15초 간격 + 30초 수명 = 겹쳐서 나온다(우르르)', () => {
    const w = mkRun(9);
    w.run.stageIndex = 4;                               // 4마리(22,37,52,67), 15초 간격
    const n = Math.floor(w.data.stages.phase.crisisStartSec / dt);
    let maxLive = 0;
    for (let i = 0; i < n; i += 1) {
      tickMob(w, 1);
      let live = 0;
      for (const e of w.enemies.items) if (e.alive && e.midBossId !== '') live += 1;
      if (live > maxLive) maxLive = live;
    }
    assert.gte(maxLive, 2, '최소 2마리가 동시에 떠 있는 순간이 있다');
  });
});

// ══════════════════════════════════════════════════════════════════════
suite('midboss — 속성 주입 · HP (§8.9)', () => {
  test('themeElseNonTheme — 테마 스테이지는 테마 속성으로 주입 (§8.9 v1.5)', () => {
    const data = loadData();
    let checked = 0;
    for (let seed = 1; seed <= 12; seed += 1) {
      const w = mkRun(seed);
      const stageId = w.run.order[0];
      const theme = data.stages.stages.find((s) => s.id === stageId).element;
      tickMob(w, Math.floor(data.stages.phase.midBossAtSec[0][0] / dt) + 2);
      const e = midOf(w);
      assert.ne(e, null, '등장했다');
      assert.ne(e.element, 'normal', '노말이 아니다');
      assert.eq(e.element, theme, `테마(${theme}) 속성이다 — 중간보스=테마`);
      checked += 1;
    }
    assert.eq(checked, 12, '12 시드 전부 검사했다 (vacuous 아님)');
  });

  test('최종 스테이지(테마 없음) — 주입 후보 3종 전부 + 시드마다 2종 이상(비복원)', () => {
    const data = loadData();
    const lastIdx = data.stages.curve.midBossCount.length - 1;
    const seen = new Set();
    for (let seed = 1; seed <= 10; seed += 1) {
      const w = mkRun(seed);
      w.run.stageIndex = lastIdx;
      const perSeed = new Set();
      const n = Math.floor(data.stages.phase.crisisStartSec / dt);
      for (let i = 0; i < n; i += 1) {
        tickMob(w, 1);
        for (const e of w.enemies.items) {
          if (e.alive && e.midBossId !== '') { perSeed.add(e.element); seen.add(e.element); }
        }
      }
      assert.gte(perSeed.size, 2, '연속 주입은 직전과 다르다 → 최소 2종');
    }
    assert.eq(seen.size, 3, '10 시드에 걸쳐 후보 3종이 전부 나온다(테마가 없으므로)');
  });

  test('hp = bosses[].hp × midBossHpScale[stageIndex] (㉝ 보스 곡선과 분리 · enemyHpScale 도 아니다)', () => {
    const data = loadData();
    const idx = 4;
    const w = mkRun(3);
    w.run.stageIndex = idx;
    tickMob(w, Math.floor(data.stages.phase.midBossAtSec[idx][0] / dt) + 2);
    const e = midOf(w);
    const def = defOf(w, e.midBossId);
    assert.near(e.hpMax, def.hp * data.stages.curve.midBossHpScale[idx], 1e-6, 'midBossHpScale');
    assert.ne(data.stages.curve.midBossHpScale[idx], data.stages.curve.enemyHpScale[idx],
      '잡몹 곡선과 다르다 (vacuous 아님)');
    // ㉝ 이후 보스 곡선과도 갈렸다 — 이 테스트가 옛날엔 두 값이 같아 «우연히» 통과했다(㊲ 재보정에서 드러남)
    assert.ne(data.stages.curve.midBossHpScale[idx], data.stages.curve.bossHpScale[idx],
      '보스 곡선과도 다르다 (중간보스는 자기 곡선)');
  });
});

// ══════════════════════════════════════════════════════════════════════
suite('midboss — 이탈 (§8.9 「선택적」의 정의 · v1.10 보스 구간처럼)', () => {
  test('v1.10: 위기 전에는 떠나지 않는다 (타이머 이탈 폐지)', () => {
    const w = mkRun(2);
    const ph = w.data.stages.phase;
    tickMob(w, Math.floor(ph.midBossAtSec[0][0] / dt) + 2);
    const e = midOf(w);
    assert.ne(e, null, '등장했다');
    // 옛 체류 45초를 훌쩍 넘겨도(위기 직전까지) 서 있다 — 격파 아니면 위기가 부른다
    const until = ph.crisisStartSec - 0.5;
    tickMob(w, Math.floor((until - w.run.phaseT) / dt));
    assert.eq(e.alive, true, '위기 직전까지 살아 있다');
    assert.ne(e.mp0, -1, '퇴장 연출도 시작하지 않았다');
  });

  test('midBossForcedLeaveOnCrisis — 새떼가 오면 퇴장 연출로 빠져나가고 보상은 0이다', () => {
    const w = mkRun(2);
    const ph = w.data.stages.phase;
    assert.eq(ph.midBossForcedLeaveOnCrisis, true, '정본이 강제 이탈을 켜 뒀다');
    tickMob(w, Math.floor(ph.midBossAtSec[0][0] / dt) + 2);
    const e = midOf(w);
    assert.ne(e, null, '등장했다');
    // ★ ㊿-f — 유령도 xp 를 흘리므로(플레이어 무기가 유령을 잡는다) «중간보스의» 드랍만 격리해서 본다:
    //   무기를 내려놓으면 이 창에서 죽는 것은 아무것도 없다 = 새 구슬은 중간보스의 것뿐이다.
    for (const sl of w.slots) sl.weaponId = null;
    const before = livePickups(w).length;
    const scoreBefore = w.score.midBossClear;
    tickMob(w, Math.floor((ph.crisisStartSec - w.run.phaseT) / dt) + 2);   // 위기 진입
    assert.eq(w.run.crisis, true, '위기 구간에 들어왔다');
    assert.eq(e.alive, true, '즉시 반납이 아니라 아직 살아서 빠져나가는 중(연출)');
    assert.eq(e.mp0, -1, '퇴장 상태');
    const yMid = e.y;
    tickMob(w, 20);
    assert.lt(e.y, yMid, '위로 상승 중');
    tickMob(w, 300);                                    // off-screen 까지 충분히
    assert.eq(e.alive, false, '퇴장 완료 = 반납');
    assert.eq(midOf(w), null, '무대에 중간보스 0');
    assert.eq(livePickups(w).length, before, '퇴장 = 드랍 0');
    assert.eq(w.score.midBossClear, scoreBefore, '퇴장 = 격파 점수 0');
  });
});

// ══════════════════════════════════════════════════════════════════════
suite('midboss — 구간 (§8.19 v1.10 · 첫 마리 소환자 · 격파 = 위기)', () => {
  /** run 훅(tickRun)이 시계와 위기를 소유하는 세계 — 웨이브/발사는 끈다(중간보스 계약만 본다) */
  function mkDirected(seed, stageIndex) {
    const world = createWorld({
      data: loadData(), seed, weapons,
      hooks: { enemies: null, emitters: null, run: tickRun, boss: null },
    });
    initRun(world);
    world.run.stageIndex = stageIndex;
    world.player.hp = 1e9; world.player.hpMax = 1e9;
    return world;
  }
  function liveMids(world) {
    const out = [];
    for (const e of world.enemies.items) if (e.alive && e.midBossId !== '') out.push(e);
    return out;
  }
  function tickTo(world, sec) {
    while (world.run.phaseT < sec) step(world, makeInput(), dt);
  }

  test('첫 마리는 midBossFirstId(소환자)이고, 나머지는 전부 다른 형태다 — 전 시드', () => {
    const d = loadData(); const ph = d.stages.phase;
    const pos = ph.midBossAtSec.length - 1;                          // 최종 포지션 = 가장 많은 마릿수
    const at = ph.midBossAtSec[pos];
    // 첫 시각에 «함께» 나오는 수 = at[0] 과 같은 시각의 칸 수 (v1.10 ③: 첫 둘은 동시)
    let firstBatch = 0;
    for (const t of at) if (t === at[0]) firstBatch += 1;
    for (let seed = 1; seed <= 12; seed += 1) {
      const w = mkDirected(seed, pos);
      tickTo(w, at[0] + 0.5);
      const first = liveMids(w);
      assert.eq(first.length, firstBatch, `시드 ${seed}: 첫 시각엔 ${firstBatch}마리`);
      // ★ 스폰 순서 = items 순서(빈 칸부터 채움) — 첫 칸이 소환자다
      assert.eq(first[0].midBossId, ph.midBossFirstId, `시드 ${seed}: 첫 마리 = ${ph.midBossFirstId}`);
      tickTo(w, at[at.length - 1] + 0.5);
      const all = liveMids(w);
      assert.eq(all.length, at.length, `시드 ${seed}: 전원 등장(타이머 이탈 없음)`);
      let nest = 0;
      for (const e of all) if (e.midBossId === ph.midBossFirstId) nest += 1;
      assert.eq(nest, 1, `시드 ${seed}: 소환자는 정확히 1마리`);
    }
  });

  test('첫 둘은 같은 시각에 함께 서고, 진입 x 슬롯이 다르다 (v1.10 ③ 시각표)', () => {
    const d = loadData(); const ph = d.stages.phase;
    for (let pos = 0; pos < ph.midBossAtSec.length; pos += 1) {
      const at = ph.midBossAtSec[pos];
      assert.ok(at.length >= 2, `포지션 ${pos + 1}: 하한 2마리 — 「소환자 하나 + 다른 형태」가 성립하려면 최소 둘`);
      assert.eq(at[0], at[1], `포지션 ${pos + 1}: 첫 둘은 동시`);
      const w = mkDirected(7, pos);
      tickTo(w, at[0] + 0.5);
      const mids = liveMids(w);
      assert.eq(mids.length, 2, `포지션 ${pos + 1}: 첫 시각에 2마리`);
      assert.ne(Math.round(mids[0].x), Math.round(mids[1].x), `포지션 ${pos + 1}: 같은 자리에 겹치지 않는다`);
    }
  });

  test('crisisOnMidBossClear — 예정 전원이 등장하고 전부 죽으면 «그 즉시» 위기, 원점은 그 시각', () => {
    const d = loadData(); const ph = d.stages.phase;
    assert.eq(ph.crisisOnMidBossClear, true, '정본이 격파 앞당김을 켜 뒀다');
    // 셋째가 «나중에» 예정된 포지션을 고른다 — 「전원 등장」 조건이 실제로 검사되게
    let pos = -1;
    for (let i = 0; i < ph.midBossAtSec.length; i += 1) {
      const at = ph.midBossAtSec[i];
      if (at.length >= 3 && at[at.length - 1] > at[0]) { pos = i; break; }
    }
    assert.ok(pos >= 0, '늦게 오는 마리가 있는 포지션이 있다');
    const at = ph.midBossAtSec[pos];
    const w = mkDirected(3, pos);
    tickTo(w, at[0] + 0.5);
    let mids = liveMids(w);
    assert.ok(mids.length >= 1 && mids.length < at.length, '첫 시각엔 일부만 등장');
    for (const e of mids) killEnemy(w, e);
    step(w, makeInput(), dt);
    assert.eq(w.run.crisis, false, '아직 예정된 마리가 남아 위기가 아니다 (전원 «등장» 조건)');
    tickTo(w, at[at.length - 1] + 0.5);
    mids = liveMids(w);
    assert.ok(mids.length >= 1, '늦은 마리 등장');
    for (const e of mids) assert.ne(e.midBossId, ph.midBossFirstId, '늦은 마리는 소환자가 아니다');
    const tKill = w.run.phaseT;
    for (const e of mids) killEnemy(w, e);
    step(w, makeInput(), dt);
    assert.eq(w.run.crisis, true, '전원 격파 = 즉시 위기 (crisisStartSec 보다 훨씬 이르다)');
    assert.lt(w.run.crisisAtSec, ph.crisisStartSec, '앞당겨졌다');
    assert.ok(Math.abs(w.run.crisisAtSec - tKill) <= 2 * dt, '원점 = 격파 시각');
    tickTo(w, ph.crisisStartSec + 1);
    assert.eq(w.run.crisis, true, '한 번 켜지면 페이즈 끝까지(sticky)');
  });

  test('격파하지 못하면 crisisStartSec 이 상한이다 (그때 퇴장 연출로 전원 이탈)', () => {
    const d = loadData(); const ph = d.stages.phase;
    const w = mkDirected(5, 0);
    // 「격파하지 못하면」이 이 테스트의 전제다 — 무기를 비워 아무것도 죽지 않게 한다.
    //   ㊳ 무기 밸런스 재저작으로 시작 무기가 중간보스를 실제로 잡기 시작해 이 전제가 깨졌다(값이 아니라 전제를 고정한다).
    for (const s of w.slots) { s.weaponId = null; s.family = ''; s.effDirty = true; }
    tickTo(w, ph.crisisStartSec - dt);
    assert.eq(w.run.crisis, false, '상한 직전은 아직 중간보스 구간');
    assert.eq(liveMids(w).length, ph.midBossAtSec[0].length, '전원 살아 있다');
    tickTo(w, ph.crisisStartSec + 0.5);
    assert.eq(w.run.crisis, true, '상한에서 위기');
    assert.eq(Math.abs(w.run.crisisAtSec - ph.crisisStartSec) <= dt, true, '원점 = 상한');
    for (const e of liveMids(w)) assert.eq(e.mp0, -1, '퇴장 중');
  });
});

// ══════════════════════════════════════════════════════════════════════
suite('midboss — 이동 (§9.8.2 moveId)', () => {
  test('anchor — yHoldPx 까지 내려와 swayAmpPx 안에서 왕복한다', () => {
    const w = mkRun(1);
    const def = defOf(w, 'mbHammer');
    const mp = def.moveParams;
    const a = w.data.rules.view.arena;
    const e = spawnMidBoss(w, def, 'fire', 1e9, a.x + a.w / 2, w.data.rules.view.spawnLineY);
    let minX = 1e9; let maxX = -1e9; let maxY = -1e9;
    for (let i = 0; i < Math.floor(20 / dt); i += 1) {
      midBoss(w, dt); step(w, makeInput(), dt);
      minX = Math.min(minX, e.x); maxX = Math.max(maxX, e.x); maxY = Math.max(maxY, e.y);
    }
    assert.near(maxY, mp.yHoldPx, 1e-6, 'yHoldPx 에서 멈춘다');
    assert.gt(maxX - minX, mp.swayAmpPx, '실제로 왕복한다 (vacuous 아님)');
    assert.lte(maxX - minX, mp.swayAmpPx * 2 + 1e-6, '진폭은 swayAmpPx 를 넘지 않는다');
  });

  test('§8.20(v1.10 ⑨) 몸 전체가 아레나 안 — anchor 왕복은 모서리를 넘지 않고, charge 복귀는 반지름만큼 안쪽이다', () => {
    const w = mkRun(4);
    const a = w.data.rules.view.arena;
    // (1) 파쇄추(anchor, sway 190)를 «우 슬롯»에 강제로 세운다 → 왕복 중심이 조여져 몸이 아레나 안에 남는다
    const hammer = defOf(w, 'mbHammer');
    const e = spawnMidBoss(w, hammer, 'fire', hammer.hp, a.x + a.w / 2 + a.w / 4, w.data.rules.view.spawnLineY);
    let maxX = -Infinity; let minX = Infinity;
    for (let i = 0; i < 60 * 30; i += 1) {
      tickMob(w, 1);
      if (!e.alive) break;
      if (e.mp0 === 1) { if (e.x > maxX) maxX = e.x; if (e.x < minX) minX = e.x; }
    }
    assert.ok(maxX + e.radius <= a.x + a.w + 1e-6, `오른쪽 끝 ${(maxX + e.radius).toFixed(1)} ≤ 아레나 ${a.x + a.w}`);
    assert.ok(minX - e.radius >= a.x - 1e-6, `왼쪽 끝 ${(minX - e.radius).toFixed(1)} ≥ 아레나 ${a.x}`);
    assert.gt(maxX - minX, hammer.moveParams.swayAmpPx, '왕복은 그대로 크다(진폭을 줄인 게 아니라 중심을 옮겼다)');
    // (2) 창병(charge) — 돌진해 빠져나간 뒤 복귀 x 가 모서리가 아니라 반지름만큼 안쪽
    const w2 = mkRun(5);
    const lancer = defOf(w2, 'mbLancer');
    const l = spawnMidBoss(w2, lancer, 'water', lancer.hp, a.x + a.w / 2, w2.data.rules.view.spawnLineY);
    w2.player.x = a.x + a.w - 5; w2.player.y = a.y + a.h - 5;     // 우하단 구석을 조준하게 → 대각 돌진으로 우측으로 빠져나간다
    let returned = false;
    for (let i = 0; i < 60 * 20; i += 1) {
      const before = l.mp0;
      tickMob(w2, 1);
      if (before === 2 && l.mp0 === 0) {                           // 관통 → 복귀 순간
        returned = true;
        assert.ok(l.x - l.radius >= a.x - 1e-6 && l.x + l.radius <= a.x + a.w + 1e-6, `복귀 x ${l.x.toFixed(1)} — 몸 전체가 안`);
        assert.near(l.y, a.y + l.radius, 1e-6, '복귀 y = 위 모서리 + 반지름');
        break;
      }
    }
    assert.ok(returned, '한 번은 관통해 복귀했다');
  });

  test('회귀: charge — 스폰 라인(아레나 밖 위쪽)에서 시작해도 돌진이 성립한다', () => {
    const w = mkRun(1);
    const def = defOf(w, 'mbLancer');
    const a = w.data.rules.view.arena;
    const e = spawnMidBoss(w, def, 'fire', 1e9, a.x + a.w / 2, w.data.rules.view.spawnLineY);
    assert.lt(w.data.rules.view.spawnLineY, a.y, '스폰 라인은 아레나 위쪽 «밖»이다 (회귀의 전제)');
    let maxY = -1e9;
    for (let i = 0; i < Math.floor(10 / dt); i += 1) {
      midBoss(w, dt); step(w, makeInput(), dt);
      maxY = Math.max(maxY, e.y);
    }
    assert.gt(maxY, a.y + a.h * 0.5, '아레나를 가로질러 돌진한다(조준만 반복하지 않는다)');
  });
});

// ══════════════════════════════════════════════════════════════════════
suite('midboss — 소환 · 발사 (§8.9-R8/R9)', () => {
  test('summon 은 midBossSummonsAllowed 를 통과한 개체만 non-null (S17)', () => {
    const w = mkRun(1);
    const allowed = w.data.rules.boss.midBossSummonsAllowed;
    let nonNull = 0;
    for (const d of midDefs(w)) {
      if (d.summon !== null) { nonNull += 1; assert.eq(allowed.includes(d.id), true, `${d.id} 는 허용 목록에 있다`); }
      else assert.eq(allowed.includes(d.id), false, `${d.id} 는 허용 목록에 없다`);
    }
    assert.gt(nonNull, 0, '소환하는 개체가 실제로 있다 (vacuous 아님)');
  });

  test('mbNest — everySec 마다 count 마리를 소환자 자리에서 낸다', () => {
    const w = mkRun(1);
    const def = defOf(w, 'mbNest');
    const sm = def.summon;
    const a = w.data.rules.view.arena;
    const e = spawnMidBoss(w, def, 'fire', 1e9, a.x + a.w / 2, w.data.rules.view.spawnLineY);
    const ticks = Math.floor(sm.everySec / dt) + 2;
    for (let i = 0; i < ticks; i += 1) { midBoss(w, dt); step(w, makeInput(), dt); }
    const mobs = w.enemies.items.filter((x) => x.alive && x.midBossId === '');
    assert.eq(mobs.length, sm.count, '한 주기에 count 마리');
    for (const m of mobs) assert.eq(m.archetypeId, sm.archetypeId, '지정 아키타입');
    // 원점이 소환자다 — y 는 모함 근처(scatter 의 jitterPx 안)
    const jitter = w.data.stages.formations.scatter.jitterPx;
    for (const m of mobs) assert.lte(Math.abs(m.y - e.y), jitter + 1e-6, '소환자 자리에서 나온다');
  });

  test('§8.9-R8 mbHammer — 이미터 2개가 각자의 스케줄로 돈다(탄 + 장판)', () => {
    const w = mkRun(1, true);
    const def = defOf(w, 'mbHammer');
    assert.eq(def.patternSet[0].emitterIds.length, 2, '이미터가 실제로 2개다 (vacuous 아님)');
    const a = w.data.rules.view.arena;
    const e = spawnMidBoss(w, def, 'fire', 1e9, a.x + a.w / 2, w.data.rules.view.spawnLineY);
    let sawBullet = false; let sawZone = false;
    for (let i = 0; i < Math.floor(12 / dt); i += 1) {
      midBoss(w, dt); step(w, makeInput(), dt);
      if (w.enemyBullets.live > 0) sawBullet = true;
      for (const z of w.zones.items) if (z.alive && !z.fromPlayer) sawZone = true;
    }
    assert.eq(sawBullet, true, 'fan 이미터가 쐈다');
    assert.eq(sawZone, true, 'zone 이미터가 장판을 깔았다');
    assert.gt(e.emitPhase, 0, '1번 악절이 돌았다');
    assert.gt(e.emitPhase2, 0, '2번 악절도 따로 돌았다');
  });
});

// ══════════════════════════════════════════════════════════════════════
suite('midboss — 처치 보상 (§8.9, 거처 = bosses[] 개체 필드)', () => {
  test('xp 확정 드랍 + 격파 점수 + 반납 (v1.5: 코인 드랍 폐지)', () => {
    const w = mkRun(1);
    const def = defOf(w, 'mbHammer');
    const e = spawnMidBoss(w, def, 'fire', 10, 300, 300);
    const before = w.score.midBossClear;
    killEnemy(w, e);
    const ps = livePickups(w);
    const xp = ps.filter((p) => p.kind === 'xp').reduce((s, p) => s + p.value, 0);
    assert.eq(xp, def.xp, 'xp 는 개체 필드가 소유');
    assert.eq(ps.filter((p) => p.kind === 'coin').length, 0, '코인 픽업 없음 (경제 폐지)');
    assert.eq(w.score.midBossClear - before, w.data.meta.score.midBossClearBonus, '격파 보너스');
    assert.eq(e.alive, false, '반납');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('midboss — 필드가 비면 앞당긴다 (§8.19 v1.10 ㊿-e)', () => {
  // 사용자(2026-09-06): 「초기 구간에서 적을 일찍 죽여놓고, 중간 보스까지 나오는데 시간이 오래걸려서
  //   애매하게 기다리는 경우가 있어. 적이 다 죽으면 바로 나오도록.」
  function mkSpawner(seed = 1) {
    const world = createWorld({
      data: loadData(), seed, weapons, difficulty: baselineDifficulty(),
      hooks: { enemies, emitters: null, run: tickRun, boss: null },
    });
    initRun(world);
    world.player.hp = 1e9; world.player.hpMax = 1e9;
    for (const sl of world.slots) sl.weaponId = null;      // 적을 죽이는 것은 «테스트»다(무기 아님)
    return world;
  }
  /** 첫 중간보스가 «등장한» phaseT. killFrom 초부터 매 틱 잡몹을 전멸시킨다(null = 안 죽인다). */
  function appearAt(world, killFrom) {
    for (let i = 0; i < Math.floor(90 / dt); i += 1) {
      step(world, makeInput(), dt);
      if (killFrom !== null && world.run.phaseT >= killFrom) {
        for (const e of world.enemies.items) if (e.alive && !e.isBoss && e.midBossId === '') killEnemy(world, e);
      }
      if (midOf(world) !== null) return world.run.phaseT;
    }
    return Infinity;
  }

  test('정본이 규칙을 켜 뒀다', () => {
    assert.eq(loadData().stages.phase.midBossOnFieldClear, true, 'midBossOnFieldClear');
  });

  test('배수 창에서 필드를 비우면 «그 자리에서» 등장한다 — 저작 시각을 크게 앞당긴다', () => {
    const w = mkSpawner();
    const ph = w.data.stages.phase;
    const due = ph.midBossAtSec[w.run.stageIndex][0];
    const drainStart = due - ph.earlyDrainSec;
    const t = appearAt(w, drainStart);
    assert.lt(t, due - ph.earlyDrainSec + 2, `배수 창 초입에 나온다 — ${t.toFixed(1)}초 (저작 ${due}초)`);
    assert.gt(w.run.midBossShiftSec, ph.earlyDrainSec - 2, '스케줄 전체가 배수 길이만큼 당겨졌다');
  });

  test('안 죽이면 저작 시각 근처다 — 앞당김은 «비었을 때»만 (자연 배수는 배수 창을 다 쓴다)', () => {
    const w = mkSpawner();
    const due = w.data.stages.phase.midBossAtSec[w.run.stageIndex][0];
    const t = appearAt(w, null);
    assert.lt(Math.abs(t - due), 2, `저작 ${due}초 근처 — ${t.toFixed(1)}초`);
  });

  test('앞당김은 죽인 쪽이 «훨씬» 빠르다 (규칙이 실제로 무는지)', () => {
    const a = mkSpawner(2);
    const b = mkSpawner(2);
    const ph = a.data.stages.phase;
    const due = ph.midBossAtSec[a.run.stageIndex][0];
    const fast = appearAt(a, due - ph.earlyDrainSec);
    const slow = appearAt(b, null);
    assert.gt(slow - fast, ph.earlyDrainSec * 0.5, `죽이면 ${fast.toFixed(1)}초 vs 두면 ${slow.toFixed(1)}초`);
  });

  test('초기 스폰 구간(배수 전)에는 앞당기지 않는다 — 웨이브가 아직 올 예정이다', () => {
    const w = mkSpawner();
    const ph = w.data.stages.phase;
    const due = ph.midBossAtSec[w.run.stageIndex][0];
    const cut = due - ph.earlyDrainSec - 2;
    for (let i = 0; i < Math.floor(cut / dt); i += 1) {
      step(w, makeInput(), dt);
      for (const e of w.enemies.items) if (e.alive && !e.isBoss && e.midBossId === '') killEnemy(w, e);
    }
    assert.eq(w.run.midBossShiftSec, 0, '초기 스폰 중에는 당기지 않는다');
    assert.eq(midOf(w), null, '중간보스 없음');
  });

  test('스케줄 전체가 같은 양만큼 당겨져 서로의 간격(우르르)이 보존된다', () => {
    const w = mkSpawner();
    const ph = w.data.stages.phase;
    const list = ph.midBossAtSec[w.run.stageIndex];
    appearAt(w, list[0] - ph.earlyDrainSec);
    const shift = w.run.midBossShiftSec;
    assert.gt(shift, 0, '당겨졌다');
    const gap = list[1] - list[0];
    for (let i = 0; i < Math.floor((gap + 0.3) / dt); i += 1) step(w, makeInput(), dt);
    let n = 0;
    for (const e of w.enemies.items) if (e.alive && e.midBossId !== '') n += 1;
    assert.gt(n, 1, `간격 ${gap}초 뒤 둘째도 나왔다 (당김 ${shift.toFixed(1)}초)`);
  });
});
