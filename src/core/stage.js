/**
 * src/core/stage.js — 런 오케스트레이션 (순수 core, §6.5 전역 상태 기계의 전투/진행 절반)
 *
 * 정본 v1.4 구현 절:
 *   §8.1   themeDraw — 6 테마 중 5 비복원 추첨(rng.theme) + finale 부착 = 6 포지션. 스테이지 1 은
 *          introOk 필수. **증명(§8.1)**: 1종만 탈락 → 물·불·풀 각 최소 1회 · stage-1 introOk 항상 가능.
 *   §6.3   페이즈 길이(전부 stages.phase / rules.boss 의 게임초). mobPhaseSec 120 · crisisStartSec 80(상한) — 중간보스 전원 격파 시 앞당김(v1.10)
 *          · introSec 3 · bossTimerSec 180.
 *   §6.5   전역 상태 기계의 **전투/진행 절반** — MOB→BOSS_INTRO→BOSS→STAGE_CLEAR→(다음/승리).
 *          ★ 메뉴·전환 화면(TITLE/DIFFICULTY/THEME_BANNER/HEAL/RESULTS)과 DRAFT 결정,   (v1.5: SHOP 폐지)
 *            그리고 **STAGE_CLEAR→advanceStage** 는 **드라이버(main.js 사람 UI / sim 봇)의 몫**이다.
 *            이 파일은 게임클럭이 흐르는 전투 페이즈만 tickRun 으로 진행한다. 즉 헤드리스 루프는
 *            `while(!over){ if(결정 대기) 드라이버가 해소; else step(); }` 이며 — main.js 와 sim 이
 *            **같은 전이 함수(advanceStage·applyStageClearHeal…)를 호출**하므로 전투는 "certified=shipped"
 *            (§10.4)로 동일 재현된다. STAGE_CLEAR 에서 tickRun 은 스스로 전이하지 않는다(드라이버 대기).
 *   §9.1   순수성 — window/Date/Math.random/… 0. import 는 core 내부만(현재 0). rng 는 world.rng.theme.
 *   §10.3  런 상태는 initRun 1회만 alloc(핫패스 tickRun 은 0 alloc). themeDraw 셔플의 slice 는 런 1회.
 *
 * ★ 배선(B1 다음 슬라이스)에서 채우는 사이드이펙트(이 파일은 신호만 세팅):
 *     - MOB→BOSS_INTRO 전이 시 쓸어내기(run.wipeT, §8.22 — boss.wipeTick 이 잡몹·탄·지형을 위에서 아래로 지운다) + XP 자동수집(phaseEndAutocollect = 픽업 전량 자석).
 *     - BOSS 진입 시 run.bossSpawned=false 를 보스 훅(boss.js)이 보고 스폰.
 *     - 보스 코어 격파 시 killEnemy(step.js)가 run.cleared=true 를 세팅 → 여기서 STAGE_CLEAR/승리로 소화.
 */

import { midBoss, clearMidBoss, midBossSectionCleared } from './midboss.js';
import { terrainTick, clearTerrain, fadeTerrain } from './terrain.js';
import { addBossClear, addRunClear } from './score.js';

export const PHASE = {
  MOB: 'MOB',                 // 잡몹 페이즈 (내부 마지막 구간 = 위기, §8.19 초기→중간보스→위기)
  BOSS_INTRO: 'BOSS_INTRO',   // 보스 등장 연출 (무적·무발사·타이머 정지)
  BOSS: 'BOSS',               // 보스전 (180s 타이머)
  STAGE_CLEAR: 'STAGE_CLEAR', // 보스 격파 — 드라이버가 드래프트/회복 후 advanceStage 호출 (v1.5: 상점 폐지)
};

/**
 * §6.5(v1.10 ㊿-s) 어트랙트 — 타이틀에서 attractIdleSec 동안 입력이 없으면 봇이 도는 «쇼케이스 런»이 언제 끝나는가.
 *   사망이면 끝 · flow.attract.endAfterMobPhase 면 잡몹 페이즈를 벗어나는 순간 끝(보스전 스포일러 방지 + 루프 길이).
 *   ★ 입력으로 끝나는 것은 드라이버(main.js)의 몫이다 — core 는 입력 장치를 모른다(§9.1).
 */
export function attractOver(world) {
  if (world.over) return true;
  if (!world.data.meta.flow.attract.endAfterMobPhase) return false;
  return world.run !== undefined && world.run.phase !== PHASE.MOB;
}

/**
 * §8.1 — 스테이지 순서를 결정적으로 뽑는다(런 시작 1회). rng.theme 만 소비(다른 스트림 불변).
 *   반환 = 6 포지션 [themed×5, finale]. 스테이지 1 은 introOk. 비복원(중복 없음).
 */
function drawStageOrder(world) {
  const td = world.data.stages.themeDraw;
  const stages = world.data.stages.stages;
  const rng = world.rng.theme;

  const introOk = Object.create(null);
  for (let i = 0; i < stages.length; i += 1) introOk[stages[i].id] = stages[i].introOk;

  const pool = td.pool.slice();                       // 6 테마 복사 (런 1회 = slice 허용, §10.3)
  // Fisher-Yates (rng.theme). i 내림차순, j = floor(f·(i+1)) ∈ [0,i]
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng.f() * (i + 1));
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }

  // 스테이지 1 = 셔플 순서상 첫 introOk 테마(§8.1 stage1RequiresIntroOk). introOk 3종이라 항상 존재.
  let s1 = 0;
  if (td.stage1RequiresIntroOk) {
    s1 = -1;
    for (let i = 0; i < pool.length; i += 1) { if (introOk[pool[i]]) { s1 = i; break; } }
    if (s1 < 0) throw new Error('stage: introOk 테마가 풀에 없다 (§8.1 증명 위반)');
  }

  const order = [pool[s1]];
  for (let i = 0; i < pool.length && order.length < td.count; i += 1) {
    if (i === s1) continue;                            // s1 은 이미 넣었다
    order.push(pool[i]);                               // 셔플 순서대로 채운다 (count-1 개 → 1종 탈락)
  }
  order.push(td.finalStageId);                         // 6번째 = finale (추첨 대상 아님)
  return order;
}

/** 런 상태를 만든다(런 시작 1회). world.run 을 세팅하고 돌려준다. */
export function initRun(world) {
  world.run = {
    order: drawStageOrder(world),   // [6] stage id
    stageIndex: 0,                  // 0..5 (런 포지션)
    phase: PHASE.MOB,
    phaseT: 0,                      // 현재 페이즈 경과(게임초)
    crisis: false,                  // 잡몹 페이즈 마지막 서브구간(§8.10) — v1.10: 한 번 켜지면 페이즈 끝까지(sticky)
    crisisAtSec: -1,                // v1.10 — 위기가 «실제로» 켜진 phaseT. 새떼 스케줄(spawnCrisis)의 원점. -1 = 아직
    terrainNextT: 0,                // §8.21(v1.10 ⑦) — 다음 지형 장판 스폰 시각(world.time)
    terrainBag: [0, 1, 2],          // §8.21 ③(v1.10 ㉑) — finale «mixed» 가방(3종 무작위 순서, 3개마다 전부). 고정 길이 = 0 alloc
    terrainBagN: 0,                 //   가방에 남은 수(0 = 다음에 다시 섞어 채운다). clearTerrain 이 0 으로
    wipeT: -1,                      // §8.22(v1.10 ⑧) — 보스 등장 쓸어내기 경과(-1 = 없음). boss.js 가 진행·종료
    midBossNext: 0,                 // §8.9 — 이 스테이지에서 다음에 낼 중간보스의 스케줄 인덱스
    midBossShiftSec: 0,             // §8.19(㊿-e) — 배수 창에서 필드가 비면 스케줄 전체를 이만큼 «앞당긴다»
    midBossElementPrev: '',         //   최종 스테이지의 «서로 다른 속성»(비복원) 기억
    bossTimer: 0,                   // 보스 타이머 잔여(BOSS 진입 시 bossTimerSec)
    timedOut: false,                // §6.3 — 타이머 만료 지연 확정 플래그(막타가 이기게)
    bossSpawned: false,             // BOSS 페이즈 보스 스폰 1회 가드(보스 훅이 본다)
    bossPhase: 0,                   // §8.11 보스 페이즈(코어 HP 임계 [0.6,0.3] → 0/1/2, patternSet 선택)
    bossTransitionT: 0,             // 페이즈 전환 잔여(>0 = 보스 무적 + 타이머 정지, §6.3)
    bossMoveSpeedMul: 1,            // §8.12(v1.5) mobility 파괴 = 폭주(×1.5, 정지 아님)
    bossMoveAmpMul: 1,              //   스웨이 유지(격렬하게 움직인다)
    bossFireRateMul: 1,             // §8.12(v1.5) 부위 파괴마다 상승 = 보스 격화(발사 빨라짐)
    cleared: false,                 // 보스 코어 격파 신호(killEnemy 가 세팅 → tickRun 이 소화)
    won: false,                     // finale 격파 = 런 클리어(승리)
    deathCause: null,               // null | 'hp' | 'timeout'
  };
  return world.run;
}

/** 현재 런 포지션의 stages.json 엔트리. */
export function stageEntry(world) {
  const id = world.run.order[world.run.stageIndex];
  const stages = world.data.stages.stages;
  for (let i = 0; i < stages.length; i += 1) if (stages[i].id === id) return stages[i];
  throw new Error(`stage: 미지의 스테이지 id "${id}" (§9.9)`);
}

/** 현재 포지션이 finale(마지막)인가. */
export function isFinale(world) {
  return world.run.order[world.run.stageIndex] === world.data.stages.themeDraw.finalStageId;
}

/**
 * ★ 런 디렉터 — 게임클럭이 흐르는 페이즈의 시간 진행/전이. step() 가 매 고정 틱 부른다(hooks.run).
 *   전투(스폰·보스)는 enemies/boss 훅이, 결정(드래프트/상점)은 드라이버가 소화한다.
 */
export function tickRun(world, dt) {
  const run = world.run;
  const ph = world.data.stages.phase;
  const boss = world.data.rules.boss;
  run.phaseT += dt;
  // §8.21(v1.10 ⑦) — 지형 장판: 흐름·반납은 매 페이즈, 스폰은 MOB 에서만(terrain.js 가 가른다)
  terrainTick(world, dt);

  if (run.phase === PHASE.MOB) {
    // 위기 서브구간(§8.10) — 독립 상태 아님(§6.5). v1.10: 시작은 둘 중 «먼저 오는 쪽»이고 한 번 켜지면 페이즈 끝까지다.
    //   · crisisStartSec — 상한(시계). 이 시각엔 중간보스가 남아 있어도 온다(midBossForcedLeaveOnCrisis).
    //   · crisisOnMidBossClear — 예정된 중간보스 전원이 등장했고 살아 있는 마리가 0 이면 «그 즉시»(격파 = 다음 구간,
    //     보스 구간처럼). 이게 없으면 빨리 잡을수록 빈 무대가 길어진다(실측: 이탈 75초 → 위기 106초 사이 26초 공백).
    if (!run.crisis) {
      run.crisis = run.phaseT >= ph.crisisStartSec
        || (ph.crisisOnMidBossClear && midBossSectionCleared(world));
      if (run.crisis) { run.crisisAtSec = run.phaseT; fadeTerrain(world); }   // §8.21 ④ 위기엔 지형이 없다 — 남은 것은 줄어들며 사라진다
    }
    // §8.9 — 중간보스는 «잡몹 페이즈의 선택지»다. 등장·이동·이탈·소환을 midboss.js 가 소유한다.
    midBoss(world, dt);
    if (run.phaseT >= ph.mobPhaseSec) {
      run.crisis = false; run.crisisAtSec = -1;
      clearMidBoss(world);           // 잡몹 페이즈가 끝나면 무대에 남지 않는다
      run.phase = PHASE.BOSS_INTRO;
      run.phaseT = 0;
      run.bossSpawned = false;       // ★ 보스를 «인트로»에 스폰해 위에서 서서히 강림시킨다(boss.js)
      // §8.22(v1.10 ⑧) 쓸어내기 — 남은 잡몹·유령·적탄·지형을 «즉시 증발»이 아니라 위에서 아래로 쓸어 지운다(boss.js 가 진행).
      run.wipeT = 0;
      // phaseEndAutocollect — 남은 XP 픽업을 전부 자석에 붙인다(플레이어에게 날아와 회수된다, 손실 0).
      if (ph.phaseEndAutocollect) {
        const pk = world.pickups.items;
        for (let i = 0; i < pk.length; i += 1) if (pk[i].alive) pk[i].magnet = true;
      }
    }
    return;
  }

  if (run.phase === PHASE.BOSS_INTRO) {
    // 연출 중 보스 무적·무발사·타이머 정지(§6.3). 시간만 흐른다.
    if (run.phaseT >= boss.introSec) {
      run.phase = PHASE.BOSS;
      run.phaseT = 0;
      run.bossTimer = ph.bossTimerSec;   // timerStartsAfterIntro (§8.11)
      run.timedOut = false;
      // ★ bossSpawned 은 BOSS_INTRO 에서 이미 true — 강림이 끝난 보스가 그대로 전투에 들어간다.
    }
    return;
  }

  if (run.phase === PHASE.BOSS) {
    // ★ 격파 신호를 타이머보다 **먼저** 소화한다 — 이미 코어가 죽은 보스는 타이머 잔여와 무관하게
    //   클리어/승리해야 한다(§6.3). killEnemy 가 collide(run 훅 뒤)에서 run.cleared 를 세팅하므로
    //   신호는 항상 다음 틱에 소비되는데, 그 틱의 bossTimer 감소가 먼저 0 을 넘으면 격파가 시간초과
    //   패배로 뒤집힌다 — 순서를 역전해 막는다.
    if (run.cleared) {
      // §11.6(v1.10 ⑲) — 특성 구슬이 아직 무대에 있으면(플레이어에게 날아오는 중) 그것을 먹을 때까지 기다린다.
      //   보스는 이미 죽었고 탄도 없다 — «구슬을 먹으면 선택»이 사실이 되게 한다(즉시 전이하면 구슬이 사라진다).
      if (traitPickupAlive(world)) return;
      run.cleared = false;
      // §11.3 — 보스 격파 보너스 + 잔여 타이머의 시간 보너스(토큰을 쓴 보스전은 0)
      addBossClear(world, run.bossTimer);
      if (isFinale(world)) { addRunClear(world); run.won = true; world.over = true; return; }
      run.phase = PHASE.STAGE_CLEAR;
      run.phaseT = 0;
      return;
    }
    // ★ 타이머 만료를 **한 틱 미룬다**(§6.3). killEnemy 는 collide(run 훅 뒤)에서 run.cleared 를
    //   세팅하므로, 타이머가 0 을 넘는 그 틱에 «막타»가 들어오면 cleared 는 이 틱엔 아직 안 보인다.
    //   그 틱에 즉사시키면 clutch 격파가 시간초과 패배로 뒤집힌다 → 만료는 flag 만 세우고, 다음 틱에
    //   cleared(위)를 먼저 본 뒤에도 여전히 미격파면 그때 확정한다(격파가 항상 이긴다).
    if (run.timedOut) {
      run.deathCause = 'timeout';
      world.over = true;
      return;
    }
    // §6.3 — 페이즈 전환 중엔 타이머 정지(timerPausesOnPhaseTransition).
    if (run.bossTransitionT <= 0) {
      run.bossTimer -= dt;
      if (run.bossTimer <= 0) {
        run.bossTimer = 0;
        run.timedOut = true;     // 이 틱엔 확정 보류 — 같은 틱 격파에게 기회를 준다
      }
    }
    return;
  }

  // PHASE.STAGE_CLEAR — 드라이버가 advanceStage 를 부를 때까지 대기(게임클럭 정지 = 여기서 아무것도 안 함).
}

/** §2.1 — 스테이지 클리어 회복(flow.stageClearHealPct). 드라이버가 HEAL 연출 시점에 부른다. */
/** §11.6 — 무대에 살아 있는 특성 구슬이 있는가 */
export function traitPickupAlive(world) {
  const it = world.pickups.items;
  for (let i = 0; i < it.length; i += 1) if (it[i].alive && it[i].kind === 'trait') return true;
  return false;
}

export function applyStageClearHeal(world) {
  const pct = world.data.meta.flow.stageClearHealPct;
  const p = world.player;
  const heal = pct * p.hpMax;
  p.hp += heal;
  if (p.hp > p.hpMax) p.hp = p.hpMax;
}

/**
 * §6.5 — 다음 스테이지로. 드라이버가 STAGE_CLEAR 에서 드래프트 소화·회복 뒤 부른다 (v1.5: 상점 폐지).
 *   런 포지션을 올리고 MOB 페이즈로 리셋한다. (스폰 상태 리셋·필드 클리어는 배선에서.)
 */
export function advanceStage(world) {
  const run = world.run;
  clearTerrain(world);             // §8.21 — 이전 테마의 지형은 넘어가지 않는다
  run.wipeT = -1;
  run.stageIndex += 1;
  run.phase = PHASE.MOB;
  run.phaseT = 0;
  run.crisis = false; run.crisisAtSec = -1;
  run.midBossNext = 0;
  run.midBossShiftSec = 0;
  run.midBossElementPrev = '';
  run.bossTimer = 0;
  run.timedOut = false;
  run.bossSpawned = false;
  run.cleared = false;
  return run;
}

// ★ v1.5 — 컨티뉴/부활(canContinue·reviveContinue)은 폐지됐다: 경제 제거 + 원데스=게임오버.
//   사망 = 즉시 RESULTS (main.js). 코인 비용도, 소급 무효도 없다.
