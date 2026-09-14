/**
 * src/core/boss.js — 복합 보스 (순수 core 훅, §8.11~§8.16)
 *
 * B1b 범위 = **스폰 · 이동 · 격파의 골격**. 발사(patternSet 이미터)·페이즈 전환(phaseThresholds)·
 *   파트파괴 이동페널티·중간보스는 B2.
 *
 * 정본 v1.4 구현 절:
 *   §8.11  복합 구조 — 코어 + 파트(적 풀 공유). 코어 hp 0 = 보스 사망. 파트 파괴는 사망 아님.
 *          hp = data.hp × bossHpScale[런포지션] (tier stage/mid) · finale 는 절대값(스케일 없음).
 *   §8.12  partType(mobility/armament/armor/core). armor 파괴 = 코어 소프트게이트 1단 해제(§3.1-4).
 *   §8.12.1 movePattern(sway/orbitArc/holdCenter) — 전신 이동. 파트는 코어+anchor 를 매 틱 따라붙는다.
 *   §8.13  코어 하드 게이트(㉘) — 모듈이 살아 있으면 코어 sealedNow (봉인 틱이 소유, hitEnemy·collide 가 읽는다) (스폰만).
 *   §10.2  world.rng.boss 만 사용(B2 발사에서). B1b 이동은 결정적(moveT 의 함수, RNG 0).
 *   §9.1   순수성 — window/Date/Math.random 0. import 는 core 내부(state.js·stage.js)만.
 *
 * ★ 처치 규칙(코인·게이트·반납)은 step.killEnemy 의 killBossEntity 가 소유한다(D3 계약과 대칭).
 *   이 파일은 **스폰 신호(run.bossSpawned)에 반응해 스폰**하고 **매 틱 위치를 갱신**할 뿐이다.
 */

import { spawnBossCore, spawnBossPart } from './state.js';
import { terrainBurst } from './terrain.js';   // §8.22(v1.10 ⑧) 쓸어내기 뒤 무작위 지형
import { PHASE, stageEntry } from './stage.js';
import { summon } from './midboss.js';   // §8.9(v1.5) — 스테이지 보스 유령 방패 소환(코어에서)

/** bosses.json 에서 id 로 조회. */
function findBoss(world, id) {
  const list = world.data.bosses.bosses;
  for (let i = 0; i < list.length; i += 1) if (list[i].id === id) return list[i];
  throw new Error(`boss: 미지의 보스 "${id}" (§9.8)`);
}

/** 보스 아레나를 깨끗이 — 남은 잡몹(비-보스)과 적 탄·지형을 반납한다. ★ v1.10 ⑧: 런에서는 «쓸어내기»(wipeTick)가
 *  이 일을 0.7초에 걸쳐 위에서 아래로 한다. 이 즉시판은 BOSS 에 직접 스폰할 때(테스트·슬라이스)만 쓴다. */
function clearField(world) {
  const en = world.enemies.items;
  for (let i = 0; i < en.length; i += 1) if (en[i].alive && !en[i].isBoss) world.enemies.release(en[i]);
  const eb = world.enemyBullets.items;
  for (let i = 0; i < eb.length; i += 1) if (eb[i].alive) world.enemyBullets.release(eb[i]);
  const tr = world.terrain.items;
  for (let i = 0; i < tr.length; i += 1) if (tr[i].alive) world.terrain.release(tr[i]);
}

/**
 * §8.22(v1.10 ⑧) 쓸어내기의 «앞선» y — 스폰 라인에서 아레나 바닥(+여유)까지 entryWipeSec 에 걸쳐 내려간다.
 *   렌더(draw.js)와 판정이 같은 식을 쓴다. wipeT < 0 이면 -Infinity(없음).
 */
export function wipeFrontY(world) {
  const run = world.run;
  if (run === undefined || run.wipeT < 0) return -Infinity;
  const v = world.data.rules.view;
  const a = v.arena;
  const sec = world.data.rules.boss.entryWipeSec;
  const k = sec > 0 ? Math.min(1, run.wipeT / sec) : 1;
  return v.spawnLineY + (a.y + a.h + 40 - v.spawnLineY) * k;
}

/**
 * §8.22(v1.10 ⑧) 보스 등장 쓸어내기 — 사용자(2026-09-04): 「보스가 등장하면서 화면을 싹 뒤집는 모션이 나오면서 잡몹도
 *   사라지고, 장판이 랜덤하게 생기는」. 앞선(wipeFrontY)이 지나간 것을 지운다: 비-보스 적(잡몹·유령·중간보스) · 적 탄 ·
 *   지형. 보상 0(반납 — 옛 clearField 와 같다). 끝나면 남은 것을 전부 지우고 terrainBurst 로 지형을 무작위로 놓는다.
 *   ★ 앞선 속도 ≈ 1,100px/s 라 어떤 탄(≤ 260)도 앞지르지 못한다 — 0.7초 뒤 무대는 보스뿐이다.
 */
export function wipeTick(world, dt) {
  const run = world.run;
  if (run.wipeT < 0) return;
  run.wipeT += dt;
  const sec = world.data.rules.boss.entryWipeSec;
  const done = run.wipeT >= sec;
  const front = done ? Infinity : wipeFrontY(world);
  const en = world.enemies.items;
  for (let i = 0; i < en.length; i += 1) if (en[i].alive && !en[i].isBoss && en[i].y < front) world.enemies.release(en[i]);
  const eb = world.enemyBullets.items;
  for (let i = 0; i < eb.length; i += 1) if (eb[i].alive && eb[i].y < front) world.enemyBullets.release(eb[i]);
  const tr = world.terrain.items;
  for (let i = 0; i < tr.length; i += 1) if (tr[i].alive && tr[i].y < front) world.terrain.release(tr[i]);
  if (done) {
    run.wipeT = -1;
    terrainBurst(world);
  }
}

/** 살아있는 보스 코어. 없으면 null(동시 1개). */
function findCore(world) {
  const en = world.enemies.items;
  for (let i = 0; i < en.length; i += 1) { const e = en[i]; if (e.alive && e.isBoss && e.isCore) return e; }
  return null;
}

/**
 * §8.11/§13.6 — 현재 스테이지 보스를 스폰한다. 파트를 먼저(낮은 풀 idx = collide 가 먼저 맞아
 *   코어를 가린다 ≈ partHitPriority outermostFirst), 코어를 나중에 놓는다.
 */
export function spawnBoss(world) {
  const entry = stageEntry(world);
  const def = findBoss(world, entry.bossId);
  const run = world.run;
  // ★ BOSS_INTRO 에 스폰되면 introSec 동안 무적(damage.js·step.js 의 bossTransitionT 게이트 재사용) +
  //   무발사(emitters) → 그 사이 위에서 서서히 강림한다. BOSS 에 직접 스폰(테스트)이면 0.
  run.bossPhase = 0;
  run.bossTransitionT = run.phase === PHASE.BOSS_INTRO ? world.data.rules.boss.introSec : 0;
  run.bossMoveSpeedMul = 1; run.bossMoveAmpMul = 1;  // 새 보스 = 1페이즈
  run.bossFireRateMul = 1;                                                                       // §8.12(v1.5) 격화 초기화
  const scale = def.tier === 'final' ? 1 : world.data.stages.curve.bossHpScale[world.run.stageIndex];
  const arena = world.data.rules.view.arena;
  const cx = arena.x + arena.w / 2;
  const cy = def.movePatternParams.yHoldPx;

  // v1.10 ⑧ — 런(BOSS_INTRO)에서는 stage.tickRun 이 wipeT 를 0 으로 켜 두었고 wipeTick 이 쓸어낸다. 아니면 즉시판.
  if (!(run.phase === PHASE.BOSS_INTRO && run.wipeT >= 0)) clearField(world);

  // §8.9.1(v1.5) — «발사 파트 수»가 런 포지션으로 성장한다(3,3,4,5,6,7). base 부위(extra≠true)는 항상
  //   스폰하고, extra 부위(선택 armament)는 firingPartsPerStage[포지션] − base 수 만큼 앞에서부터 스폰한다.
  //   ★ ㉘ 코어 하드 게이트: 모듈(파트)이 하나라도 살아 있으면 코어는 무적 — 파트 수가 늘면 «열리는 시각»도 늦어진다.
  const target = world.data.stages.curve.firingPartsPerStage[world.run.stageIndex];
  const parts = def.parts;
  let baseCount = 0;
  for (let i = 0; i < parts.length; i += 1) if (parts[i].extra !== true) baseCount += 1;
  const extraQuota = target - baseCount < 0 ? 0 : target - baseCount;

  let extraSpawned = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part.extra === true) {
      if (extraSpawned >= extraQuota) continue;          // 포지션 정원 초과 = 미스폰(정의엔 존재, 런엔 부재)
      extraSpawned += 1;
    }
    spawnBossPart(world, def.id, part, part.hp * scale, cx, cy);
  }
  const core = spawnBossCore(world, def.id, def.core, def.core.hp * scale, cx, cy);
  if (core !== null) core.sealedNow = true;              // §8.13(㉘) 모듈이 있으니 닫힌 채 시작(봉인 틱이 첫 틱에 다시 잰다)
}

/**
 * §8.12.1 — 전신 이동. 코어를 movePattern 대로 움직이고 파트를 코어+anchor 로 따라붙인다.
 *   보스 개체는 vx/vy=0 이며 위치를 여기서 직접 세팅한다(step.moveBullets 의 등속 적분은 무해).
 *   sway: x = cx + ampPx·sin(w·moveT), w = speedPxSec/ampPx → 최대 측속 = speedPxSec.
 *   orbitArc 는 B1b 에서 sway 로 근사(B2 에서 정식 구현).
 */
/** §8.11 — 부위는 코어에 매달린 «고정 오프셋»이다. 코어를 옮긴 쪽이 반드시 이걸 부른다(등장 연출 · 평시 이동 둘 다). */
function followCore(world, core) {
  const en = world.enemies.items;
  for (let i = 0; i < en.length; i += 1) {
    const e = en[i];
    if (!e.alive || !e.isBoss || e.isCore) continue;
    e.x = core.x + e.anchorX;
    e.y = core.y + e.anchorY;
  }
}

function moveBoss(world) {
  const core = findCore(world);
  if (core === null) return;
  const run = world.run;
  const def = findBoss(world, core.bossId);
  const mp = def.movePatternParams;
  const arena = world.data.rules.view.arena;
  const cx = arena.x + arena.w / 2;

  // ★ BOSS_INTRO — 위(spawnLineY)에서 yHoldPx 로 «서서히 강림»(smoothstep). 무적·무발사는
  //   bossTransitionT 게이트(damage.js·step.js·emitters)가 소유 — 여기선 위치만.
  if (run.phase === PHASE.BOSS_INTRO) {
    const introSec = world.data.rules.boss.introSec;
    const t = introSec > 0 ? Math.min(run.phaseT / introSec, 1) : 1;
    const eased = t * t * (3 - 2 * t);
    const sy = world.data.rules.view.spawnLineY;
    core.x = cx;
    core.y = sy + (mp.yHoldPx - sy) * eased;
    followCore(world, core);
    return;
  }

  // §8.12(v1.5) — mobility 파괴 시 speedPxSec ×1.5 · ampPx **유지**(정지가 아니라 «격렬하게 왕복»).
  //   배율은 run 이 소유한다. v1.4 는 ×0.5 · amp→0(정지)이었고 아래 `effAmp <= 0` 가드가 그 잔재다 —
  //   bossMoveAmpMul 이 1 말고 다른 값이 되는 곳이 없어 지금은 도달하지 않는다(가드는 그대로 둔다).
  const effAmp = mp.ampPx * run.bossMoveAmpMul;
  const effSpeed = mp.speedPxSec * run.bossMoveSpeedMul;
  if (def.movePattern === 'holdCenter' || effAmp <= 0) {
    core.x = cx;
    core.y = mp.yHoldPx;
  } else {
    const w = effSpeed / effAmp;                       // 최대 측속 = effSpeed
    core.x = cx + effAmp * Math.sin(w * core.moveT);
    core.y = mp.yHoldPx;
  }

  followCore(world, core);

  const en = world.enemies.items;
  // §8.11(v1.5) 레이어 봉인 — 살아있는 파트 중 «최소 sealLayer»보다 높은 파트는 무적(sealedNow).
  //   낮은 레이어(앞)를 다 부숴야 높은 레이어(뒤·키스톤)가 열린다. 항상 최소 레이어 파트는 열려 있어
  //   보스가 봉인으로 불사가 되는 일은 없다. 코어는 자체 armor 게이트라 제외.
  let minLayer = Infinity;
  let modules = 0;
  for (let i = 0; i < en.length; i += 1) {
    const e = en[i];
    if (e.alive && e.isBoss && !e.isCore) { modules += 1; if (e.sealLayer < minLayer) minLayer = e.sealLayer; }
  }
  for (let i = 0; i < en.length; i += 1) {
    const e = en[i];
    if (!e.alive || !e.isBoss) continue;
    // §8.13(v1.10 ㉘) 코어 하드 게이트 — 사용자: 「보스는 무기 모듈이 파괴되지 않으면 딜이 아예 안 들어오는 구조」.
    //   모듈(코어가 아닌 모든 파트)이 하나라도 살아 있으면 코어는 봉인 = 무적·탄 통과·자물쇠. 다 부수면 열린다.
    e.sealedNow = e.isCore ? modules > 0 : e.sealLayer > minLayer;
  }
}

/**
 * §8.11 — 코어 HP 임계(phaseThresholds [0.6,0.3])를 지나면 페이즈 전환.
 *   전환 = phaseTransitionSec 동안 보스 무적(collide) + 타이머 정지(tickRun). 끝나면 전 파트의 phase 를
 *   각인해 patternSet 이 새 페이즈로 바뀌고(이미터 악절도 처음부터), "몰아치고 쉰다"의 층이 오른다.
 */
function advancePhase(world, dt) {
  const run = world.run;
  const core = findCore(world);
  if (core === null) return;

  if (run.bossTransitionT > 0) {
    run.bossTransitionT -= dt;
    if (run.bossTransitionT <= 0) {
      run.bossTransitionT = 0;
      const en = world.enemies.items;
      for (let i = 0; i < en.length; i += 1) {
        const e = en[i];
        // ★ B-3: 페이즈는 오직 오른다 — HP 임계 전환이 모듈 격파로 이미 올라간 페이즈를 낮추지 않게 max.
        if (e.alive && e.isBoss) { if (run.bossPhase > e.phase) e.phase = run.bossPhase; e.emitT = 0; e.emitPhase = 0; }
      }
    }
    return;                                            // 전환 중엔 재판정 안 함
  }

  const thr = world.data.rules.boss.phaseThresholds;   // [0.6, 0.3]
  const ratio = core.hpMax > 0 ? core.hp / core.hpMax : 0;
  let target = 0;
  for (let i = 0; i < thr.length; i += 1) if (ratio < thr[i]) target = i + 1;
  if (target > run.bossPhase) {
    run.bossPhase = target;
    run.bossTransitionT = world.data.rules.boss.phaseTransitionSec;
  }
}

/**
 * ★ 훅 진입점 — step.js 가 매 틱 부른다(hooks.boss). BOSS 페이즈에만 활성.
 *   run.bossSpawned(스테이지.tickRun 이 BOSS 진입 시 false 로 세팅)를 보고 1회 스폰 후 매 틱 이동.
 */
export function bossHook(world, dt) {
  const run = world.run;
  if (run.phase !== PHASE.BOSS && run.phase !== PHASE.BOSS_INTRO) return;   // ★ 강림 연출도 여기서
  if (!run.bossSpawned) { spawnBoss(world); run.bossSpawned = true; }
  wipeTick(world, dt);                                                       // §8.22 쓸어내기(BOSS_INTRO 첫 entryWipeSec)
  advancePhase(world, dt);
  moveBoss(world);
  // §8.9(v1.5) — 유령 방패: bossSummonsAllowed 스테이지·최종 보스는 코어에서 유령을 소환한다(경험치 0,
  //   위쪽 사격을 흡수 = 엄폐). 발사·전환과 달리 «강림·전환 중»엔 멈춘다(숨돌릴 틈 유지).
  if (run.phase === PHASE.BOSS && run.bossTransitionT <= 0) {
    const core = findCore(world);
    if (core !== null) {
      const def = findBoss(world, core.bossId);
      if (def !== undefined && def.summon !== undefined && def.summon !== null) summon(world, core, def, dt);
    }
  }
}
