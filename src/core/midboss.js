/**
 * src/core/midboss.js — 중간보스 (§8.9, 순수 core 모듈)
 *
 * §8.19(v1.10) 중간보스 «구간» — 보스 구간처럼 서 있다:
 *   첫 마리는 **무조건 소환자**(`midBossFirstId`, mbNest) → 유령이 «적당히» 흐른다(웨이브는 정지, §8.19).
 *   나머지는 소환자를 뺀 종에서 `rng.spawn` 이 뽑는다. **타이머 이탈은 없다** — 격파하거나, 위기가 오면
 *   위로 «빠져나간다»(midBossForcedLeaveOnCrisis = 퇴장 연출). 전원 격파 = 그 즉시 위기(crisisOnMidBossClear).
 *   무시해도 **쫓아오지 않는다**(추격 금지). 무시 = "위기가 올 때까지 탄막을 회피한다"는 선택. 공짜가 아니다.
 *
 * 정본 절:
 *   §8.9   3종 전 테마 공용(`bosses.json`, tier "mid", parts [], phases 1개) · 단일 몸체
 *          mbHammer(anchor + fan/zone 교대) · mbLancer(charge + laser) · mbNest(anchor + aimed + 소환)
 *   §8.9   등장 시각 = `stages.phase.midBossAtSec[stageIndex]`(배열) — 그 길이 == `curve.midBossCount[i]`
 *          (S29). hp = `bosses[].hp × curve.midBossHpScale[stageIndex]`(㉝ 보스 곡선과 분리) — **enemyHpScale 이 아니다**
 *          (그러면 "DPS 체크 = 보스전 예고편"이 소멸한다).
 *   §8.9   `midBossElementRule "notThemeAndNotNormal"` = **런타임 주입**. 저작값 element 는 null 이고
 *          그것이 곧 「주입 대상」 표식이다(S15). 최종 스테이지는 테마가 없으므로 "테마가 아님"이
 *          **공허참** → 후보 = {fire,water,grass} 전부이고 `rng.spawn` 이 **비복원 2개**를 뽑는다.
 *   §8.9   `midBossForcedLeaveOnCrisis` — 위기 세션(새떼)이 시작되면 남아 있어도 퇴장 연출로 이탈한다.
 *   §8.19  `midBossFirstId` — 스테이지의 첫 중간보스는 이 소환자다(S55). `crisisOnMidBossClear` —
 *          예정된 전원이 등장했고 살아 있는 마리가 0 이면 stage.tickRun 이 위기를 앞당긴다(§8.10).
 *   §8.9-R9 `summon` 은 `midBossSummonsAllowed`(= ["mbNest"])를 통과한 개체만 non-null(S17).
 *          중간보스는 **잡몹 페이즈**에 있으므로 소환된 잡몹의 XP 획득은 정상이다(§6.4 전제 유지).
 *   §9.8.2 `moveId` 는 중간보스 판본에만 인쇄된 필드다 — `charge` 의 **유일한 사용자**가 mbLancer 라
 *          이 파일이 써지는 순간 동결 어휘 8종의 1/8 이 처음으로 도달 가능해진다.
 *
 * ★ 이 파일이 **소유**하는 것: 등장 스케줄 · 속성 주입 · 이동(anchor/charge) · 이탈 · 소환.
 *   발사는 emitters.js(중간보스 분기), 처치 보상은 step.killEnemy(midBossId 분기)가 소유한다.
 * ★ 결정성 — rng 는 `spawn` 스트림만 쓴다(종·속성 추첨). 이동·소환은 순수 함수다.
 */

import { spawnMidBoss, spawnEnemy } from './state.js';
import { formationPos } from './formations.js';
import { offThemeHpMul } from './elements.js';   // §8.2 ③

const ELEMENTS3 = ['fire', 'water', 'grass'];   // §4.1 — 노말을 뺀 3종(주입 후보)
const EXIT_SPEED_PX = 220;                      // §8.9(v1.5) 퇴장 상승 속도(비행슈팅 «서서히 빠져나감»)

/**
 * 현재 스테이지의 **테마 속성**. finale 은 저작값이 null 이고 그것이 곧 "테마가 없다"이다.
 *   ★ stage.js 를 import 하지 않는다 — stage.js 가 이 파일을 부르므로(훅) 순환이 된다.
 *     필요한 건 data + run 뿐이라 여기서 직접 읽는 편이 의존 방향을 한쪽으로 유지한다.
 */
function themeElement(world) {
  const id = world.run.order[world.run.stageIndex];
  const stages = world.data.stages.stages;
  for (let i = 0; i < stages.length; i += 1) if (stages[i].id === id) return stages[i].element;
  throw new Error(`midboss: 미지의 스테이지 id "${id}" (§9.9)`);
}

/** bosses.json 의 tier "mid" 3종. 최초 1회만 만든다(§10.3 핫패스 0 alloc). */
function ensureMidDefs(world) {
  if (world.midDefs !== undefined) return world.midDefs;
  const out = [];
  const bs = world.data.bosses.bosses;
  for (let i = 0; i < bs.length; i += 1) if (bs[i].tier === 'mid') out.push(bs[i]);
  if (out.length === 0) throw new Error('midboss: tier "mid" 개체가 없다 (§8.9)');
  world.midDefs = out;
  return out;
}

/** §8.9 — 이 스테이지의 등장 시각 배열. S29 가 길이 == midBossCount 를 이미 강제한다. */
function atSecList(world) {
  return world.data.stages.phase.midBossAtSec[world.run.stageIndex];
}

/**
 * §8.19(v1.10 ㊿-e) — 중간보스 등장 시각. 저작 시각에서 `run.midBossShiftSec` 만큼 «당겨진» 값이다.
 *   사용자(2026-09-06): 「초기 구간에서 적을 일찍 죽여놓고 중간 보스까지 시간이 오래 걸려서 애매하게 기다린다.
 *   적이 다 죽으면 바로 나오도록」. → 배수 창(스폰이 멈추고 무리가 흘러 나가는 구간)에서 **필드가 비면**
 *   스케줄 «전체»를 같은 양만큼 당긴다. 전체를 당기는 이유: 서로의 간격(3초 = 「우르르」)이 설계이기 때문이다.
 *   ★ 이 함수가 시각의 **유일한 입구**다 — 저작 배열을 직접 읽는 곳이 남으면 구간 판정이 어긋난다.
 */
function midBossDueSec(world, i) {
  const list = atSecList(world);
  return i >= list.length ? Infinity : list[i] - world.run.midBossShiftSec;
}

/** §8.19 — 첫 중간보스의 (당겨진) 등장 시각. 「초기 구간」의 끝이자 배수 창의 기준점. */
export function firstMidBossDueSec(world) {
  return midBossDueSec(world, 0);
}

/**
 * ㊿-e — 「지금 당겨도 되는가」. ① 아직 첫 마리 전이고 ② 배수 창에 들어왔고(초기 스폰이 끝났고)
 *   ③ 잡몹이 하나도 안 남았다. ①의 이유: 2번째 이후는 3초 간격이라 «기다림»이 없다.
 *   ②가 없으면 웨이브 0 이 스폰되기 «전» 첫 틱에 필드가 비어 보여 즉시 발화한다.
 */
function earlyFieldDrained(world, ph) {
  const run = world.run;
  if (run.midBossNext !== 0) return false;
  // ★ 스포너가 «실제로 웨이브를 낸» 뒤에만 본다. 슬라이스/테스트 월드(enemies 훅 없음)엔 필드라는 개념이 없고,
  //   첫 웨이브 전의 빈 화면을 «다 죽였다»로 읽으면 스테이지가 시작하자마자 중간보스가 나온다.
  if (world.spawner === undefined || world.spawner.wavesSpawned <= 0) return false;
  const first = firstMidBossDueSec(world);
  if (!Number.isFinite(first) || run.phaseT < first - ph.earlyDrainSec) return false;
  const it = world.enemies.items;
  for (let i = 0; i < it.length; i += 1) {
    const e = it[i];
    if (e.alive && !e.isBoss && e.midBossId === '') return false;
  }
  return true;
}

/**
 * §8.9 `notThemeAndNotNormal` 의 주입. 테마 속성을 뺀 나머지에서 `rng.spawn` 이 뽑는다.
 *   최종 스테이지(테마 없음)는 후보 3종 전부 · **같은 스테이지에서 이미 쓴 속성은 제외**(비복원).
 */
function injectElement(world) {
  const run = world.run;
  const theme = themeElement(world);
  // §8.9(v1.5, 사용자 결정) — 중간보스는 «무조건 테마 속성»(화산=불 중간보스, 테마 일관성).
  //   finale(테마 null)만 기존처럼 비-노말 후보에서 직전과 다르게 뽑는다(§8.16 서로 다른 속성).
  if (theme !== null) { run.midBossElementPrev = theme; return theme; }
  let n = 0;
  const pick = [];
  for (let i = 0; i < ELEMENTS3.length; i += 1) {
    const el = ELEMENTS3[i];
    if (el === run.midBossElementPrev) continue;
    pick.push(el);
    n += 1;
  }
  if (n === 0) { pick.push(ELEMENTS3[0]); n = 1; }    // 방어(도달 불가: 후보가 최소 1개 남는다)
  const el = pick[Math.floor(world.rng.spawn.f() * n) % n];
  run.midBossElementPrev = el;
  return el;
}

/**
 * §8.19(v1.10) 종 선택 — 사용자 결정: 「무조건 소환하는 중간보스 하나 + 다른 형태의 중간보스들, 마치 보스 구간처럼」.
 *   첫 마리(midBossNext === 1)는 `midBossFirstId`(소환자). 나머지는 소환자를 **뺀** 종에서 `rng.spawn` 이 뽑는다.
 *   S55 가 midBossFirstId ∈ tier mid ∧ summon ≠ null ∧ 나머지 종 ≥ 1 을 정적으로 지킨다 — 여기서는 믿고 쓴다.
 *   ★ 결정성 — 첫 마리는 rng 소비 0(고정), 나머지는 f() 1회. 종 수가 달라도 스트림 소비는 마리당 ≤ 1.
 */
function pickDef(world, defs) {
  const firstId = world.data.stages.phase.midBossFirstId;
  if (world.run.midBossNext === 1) {
    for (let i = 0; i < defs.length; i += 1) if (defs[i].id === firstId) return defs[i];
    throw new Error(`midboss: midBossFirstId "${firstId}" 가 tier mid 에 없다 (§8.19)`);
  }
  let n = 0;
  for (let i = 0; i < defs.length; i += 1) if (defs[i].id !== firstId) n += 1;
  if (n === 0) throw new Error('midboss: 소환자를 뺀 중간보스 종이 없다 (§8.19 S55)');
  let k = Math.floor(world.rng.spawn.f() * n) % n;
  for (let i = 0; i < defs.length; i += 1) {
    if (defs[i].id === firstId) continue;
    if (k === 0) return defs[i];
    k -= 1;
  }
  return defs[0];                                       // 방어(도달 불가)
}

/** §8.9 — 한 마리 등장. 아레나 상단 스폰 라인에서 들어온다.
 *   ★ v1.5 동시 다수: 진입 x 를 «스폰 순번»으로 3슬롯 순환(중앙·우·좌). 연속 3스폰이 항상 서로 다른
 *     슬롯이라 동시(≤2, 순간 ≤3)에도 x 가 겹치지 않는다 — 생존 «수»로 고르면 정상상태 2에서 3번째부터
 *     좌슬롯이 중복된다(리뷰 지적). 결정적(RNG 0). ★ midBossNext 는 spawnOne 직전 이미 +1 됨. */
function spawnOne(world) {
  const defs = ensureMidDefs(world);
  const def = pickDef(world, defs);
  const a = world.data.rules.view.arena;
  const hp = def.hp * world.data.stages.curve.midBossHpScale[world.run.stageIndex];   // ㉝ 중간보스는 자기 곡선(보스와 분리)
  const slot = (world.run.midBossNext - 1) % 3;         // 0=중앙 1=우 2=좌 (연속 3스폰 = 3슬롯)
  const q = a.w / 4;
  const off = slot === 0 ? 0 : (slot === 1 ? q : -q);
  const e = spawnMidBoss(world, def, injectElement(world), hp,
    a.x + a.w / 2 + off, world.data.rules.view.spawnLineY);
  return e;
}


/** 이탈 — 화면 위로 사라진다. 보상 0(반납만 한다). */
function leave(world, e) {
  world.enemies.release(e);
}

/**
 * §8.9 `anchor` — enterSpeed 로 yHoldPx 까지 내려온 뒤 그 높이에서 좌우로 swayAmpPx 왕복한다.
 *   ★ 왕복 속도는 **enterSpeed 를 재사용**한다(중간보스 moveParams 에 속도 키가 하나뿐이다 —
 *     새 데이터 키를 만들지 않는다). mp0 = 진입 완료 플래그 · mp1 = 왕복 위상 · mp2 = 왕복 중심 x.
 */
function moveAnchor(world, e, mp, dt) {
  if (e.mp0 === 0) {
    e.y += mp.enterSpeed * dt;
    if (e.y >= mp.yHoldPx) {
      e.y = mp.yHoldPx; e.mp0 = 1;
      // §8.20(v1.10 ⑨) 왕복 중심은 «몸 전체가 아레나 안»에 남는 범위로 조인다 — 우/좌 슬롯(±w/4) + swayAmpPx(파쇄추 190)
      //   이면 x 가 아레나 밖 45px 까지 나가 몸이 통째로 숨었다(플레이 피드백: 「중간보스가 화면 밖에 숨는다」).
      const a = world.data.rules.view.arena;
      const lo = a.x + e.radius + mp.swayAmpPx;
      const hi = a.x + a.w - e.radius - mp.swayAmpPx;
      e.mp2 = lo > hi ? a.x + a.w / 2 : Math.min(hi, Math.max(lo, e.x));
    }
    return;
  }
  const w = mp.swayAmpPx > 0 ? mp.enterSpeed / mp.swayAmpPx : 0;   // 각속도 = 선속도 / 진폭
  e.mp1 += w * dt;
  e.x = e.mp2 + Math.sin(e.mp1) * mp.swayAmpPx;
}

/**
 * §8.9 `charge` — windUpSec 동안 멈춰서 **조준을 굳히고**(그 사이가 곧 회피 리드) dashSpeed 로 돌진한다.
 *   아레나를 관통해 빠져나가면 다시 스폰 라인에서 조준 → 다음 돌진. ★ `charge` 의 유일한 사용자다(§9.8.2).
 *   mp0 = 상태(0 조준 / 1 돌진·아직 진입 전 / 2 돌진·진입함) · mp1 = 조준 타이머 · mp2 = 돌진 각(rad)
 *   ★ 「진입 전」 상태가 따로 있는 이유(회귀): 스폰 라인은 **아레나 위쪽 밖**이라, 진입 여부를 안 보면
 *     돌진하자마자 «밖에 있다»로 판정돼 즉시 리셋 → 영원히 조준만 반복한다(실측된 버그).
 */
function moveCharge(world, e, mp, dt) {
  const a = world.data.rules.view.arena;
  if (e.mp0 === 0) {
    e.vx = 0; e.vy = 0;
    e.mp1 += dt;
    if (e.mp1 >= mp.windUpSec) {
      const p = world.player;
      e.mp2 = Math.atan2(p.y - e.y, p.x - e.x);      // 조준을 «굳힌다» — 돌진 중엔 다시 안 본다
      e.mp0 = 1; e.mp1 = 0;
    }
    return;
  }
  e.x += Math.cos(e.mp2) * mp.dashSpeed * dt;
  e.y += Math.sin(e.mp2) * mp.dashSpeed * dt;
  const inside = e.x >= a.x && e.x <= a.x + a.w && e.y >= a.y && e.y <= a.y + a.h;
  if (inside) { e.mp0 = 2; return; }
  if (e.mp0 !== 2) return;                            // 아직 한 번도 안 들어왔다 = 진입 중
  // 관통해 빠져나갔다 → 스폰 라인으로 복귀해 다시 조준한다(추격 금지 — 리셋이지 추적이 아니다)
  // §8.20(v1.10 ⑨) x 도 «몸 전체가 안»으로 — 모서리(a.x, a.x+a.w)에 세우면 반지름 28 의 절반이 화면 밖에서
  //   조준한다(플레이 피드백 실물: 우측 모서리에 반쯤 잘린 창병). y 와 같은 이유로 반지름만큼 안쪽이다.
  if (e.x < a.x + e.radius) e.x = a.x + e.radius;
  if (e.x > a.x + a.w - e.radius) e.x = a.x + a.w - e.radius;
  // §8.20(v1.8) — 복귀 지점은 아레나 «안»이다. spawnLineY(−40)로 되돌리면 반지름 28 짜리
  //   창병의 몸이 한 픽셀도 안 보이는 곳에서 windUpSec 1.2초를 조준한다(실측: 생존의 32.8%).
  //   §8.20 이 그 시간을 무적으로 바꾸므로, 안 고치면 창병만 실효 체력 ×1.5 가 된다.
  //   저작 결함은 §8.20 이 만든 것이 아니라 §8.20 이 드러낸 것이며, 고칠 자리가 여기다.
  e.y = a.y + e.radius;
  e.mp0 = 0; e.mp1 = 0;
}

const _pos = { x: 0, y: 0 };   // 재사용(핫패스 0 alloc)

/**
 * §8.9-R9 — mbNest 의 소환. everySec 마다 count 마리를 formationId 모양으로 낸다.
 *   ★ 편대의 **원점은 소환자**다(산란모함이 자기 자리에서 알을 뿌린다). 편대는 «모양»이고
 *     그 모양이 어디에 놓이는지는 누가 스폰시켰는지가 정한다 — 웨이브면 스폰 라인, 소환이면 모함.
 */
export function summon(world, e, def, dt) {
  const sm = def.summon;
  if (sm === null || sm === undefined) return;
  e.summonT += dt;
  if (e.summonT < sm.everySec) return;
  e.summonT -= sm.everySec;
  const curve = world.data.stages.curve;
  const idx = world.run.stageIndex;
  const arch = world.data.enemies.archetypes;
  let a = null;
  for (let i = 0; i < arch.length; i += 1) if (arch[i].id === sm.archetypeId) { a = arch[i]; break; }
  if (a === null) throw new Error(`midboss: 미지의 소환 아키타입 "${sm.archetypeId}" (§8.9-R9)`);
  const hp = a.hp * curve.enemyHpScale[idx] * offThemeHpMul(world.data, themeElement(world), e.element);   // §8.2 ③ 소환도 잡몹이다
  // §12.1(v1.8) — 유령은 웨이브 예산 «밖»이므로 자기 예산을 갖는다. 새 키 0 —
  //   telegraphConcurrentMaxGlobal = enemyConcurrentMax × perEntity 와 같은 재사용식 파생이다.
  //   정적 산술: 웨이브 42 + 유령 42 + max(midBossCount) 5 = 89 ≤ caps.enemies 128 (S12 가 강제).
  const ghostMax = world.data.rules.fairness.enemyConcurrentMax;
  const it = world.enemies.items;
  let ghostLive = 0;
  if (sm.ghost === true) {
    for (let i = 0; i < it.length; i += 1) if (it[i].alive && it[i].ghost) ghostLive += 1;
  }
  for (let i = 0; i < sm.count; i += 1) {
    if (sm.ghost === true && ghostLive >= ghostMax) break;
    if (sm.ghost === true) ghostLive += 1;
    formationPos(world, sm.formationId, i, sm.count, e.x, e.y, _pos, a.radius + (a.moveId === 'weave' && a.moveParams !== null && typeof a.moveParams.ampPx === 'number' ? a.moveParams.ampPx : 0));   // §8.7 ㉕ 여백(= enemies.bodyMargin — 순환이라 인라인)
    const g = spawnEnemy(world, sm.archetypeId, e.element, _pos.x, _pos.y, hp, false, sm.ghost === true);   // §8.9 유령 소환
    if (g !== null) g.wallX = a.moveId !== 'strafe';                                                     // §8.7 ㉕

  }
}

/**
 * ★ 훅 진입점 — stage.tickRun 의 MOB 분기가 매 고정 틱 부른다.
 *   (1) 위기 강제 이탈 → (2) 등장 스케줄 → (3) 이탈 타이머 → (4) 이동 → (5) 소환.
 *   발사는 emitters.js 가, 처치 보상은 step.killEnemy 가 소유한다.
 */
export function midBoss(world, dt) {
  const run = world.run;
  const ph = world.data.stages.phase;
  const it = world.enemies.items;

  // (1) §8.9 midBossForcedLeaveOnCrisis — 새떼가 오면 무대를 «전원» 비운다. v1.10: 즉시 반납이 아니라
  //     «퇴장 연출»(mp0 = -1, 위로 상승)을 시작한다 — 아래 (3) 이 off-screen 에서 반납한다.
  if (ph.midBossForcedLeaveOnCrisis && run.crisis) {
    for (let i = 0; i < it.length; i += 1) if (it[i].alive && it[i].midBossId !== '') it[i].mp0 = -1;
  }

  // (2) 등장 — 예정 시각을 지난 «모든» 미등장 마리를 낸다. §8.9(v1.5): «동시 1마리» 게이트를
  //     제거 → 스케줄(midBossAtSec)이 곧 등장이다. 5초 간격 = 겹쳐서 «우르르»(보스 구간처럼 함께 선다).
  if (!run.crisis) {
    const list = atSecList(world);
    // ★ ㊿-e — 배수 창에서 필드가 비면 스케줄을 «지금»으로 당긴다(사용자: 「적이 다 죽으면 바로 나오도록」).
    if (ph.midBossOnFieldClear && run.midBossNext < list.length && earlyFieldDrained(world, ph)) {
      const due = midBossDueSec(world, run.midBossNext);
      if (run.phaseT < due) run.midBossShiftSec += due - run.phaseT;
    }
    while (run.midBossNext < list.length && run.phaseT >= midBossDueSec(world, run.midBossNext)) {
      run.midBossNext += 1;
      spawnOne(world);
    }
  }

  // (3~5) 살아있는 각 중간보스를 «개체별 독립»으로 처리한다(퇴장·이동·소환).
  //   ★ v1.10: 타이머 이탈(midBossLeaveAfterSec)은 폐지 — 격파 아니면 위기까지 선다(보스 구간처럼).
  const defs = ensureMidDefs(world);
  const sy = world.data.rules.view.spawnLineY;
  for (let i = 0; i < it.length; i += 1) {
    const e = it[i];
    if (!e.alive || e.midBossId === '') continue;
    // (3) 퇴장 연출 — 위기가 부른 마리는 위로 «서서히 빠져나간다»(비행슈팅). off-screen 에서 반납.
    //     스턴보다 먼저 본다 — 퇴장은 「행동」이 아니라 「무대에서 치우는 일」이라 스턴이 붙잡지 않는다.
    if (e.mp0 === -1) {
      e.y -= EXIT_SPEED_PX * dt;
      if (e.y < sy - 60) leave(world, e);
      continue;
    }
    // ★ §2.7 「스턴 = 개체 정지」 — 이동·소환 멈춤. stunSec 감소는 step.moveBullets 단일 소유(이중 방지).
    if (e.stunSec > 0) continue;
    // (4) 이동 — §9.8.2 moveId(anchor | charge)
    let def = null;
    for (let j = 0; j < defs.length; j += 1) if (defs[j].id === e.midBossId) { def = defs[j]; break; }
    if (def === null) throw new Error(`midboss: 미지의 중간보스 "${e.midBossId}" (§8.9)`);
    if (def.moveId === 'charge') moveCharge(world, e, def.moveParams, dt);
    else if (def.moveId === 'anchor') moveAnchor(world, e, def.moveParams, dt);
    else throw new Error(`midboss: 미구현 moveId "${def.moveId}" — §8.9 는 anchor|charge 만 쓴다`);
    // (5) 소환 — midBossSummonsAllowed 를 통과한 개체만 summon 이 non-null 이다(S17)
    summon(world, e, def, dt);
  }
}

/**
 * §8.19(v1.10) 중간보스 구간 «격파» — 예정된 전원이 등장했고(midBossNext == 스케줄 길이) 살아 있는 마리가
 *   0 이면 참. stage.tickRun 이 `crisisOnMidBossClear` 로 위기를 앞당길 때 쓴다(§8.10).
 *   ★ 유령(midBossId '')은 세지 않는다 — 소환자가 죽으면 남은 유령은 위기 속으로 흘러 들어간다.
 */
export function midBossSectionCleared(world) {
  const run = world.run;
  if (run.midBossNext < atSecList(world).length) return false;
  const it = world.enemies.items;
  for (let i = 0; i < it.length; i += 1) if (it[i].alive && it[i].midBossId !== '') return false;
  return true;
}

/** 페이즈/스테이지 전이에서 무대를 «전원» 비운다(잡몹 페이즈가 끝나면 중간보스는 남지 않는다). */
export function clearMidBoss(world) {
  const it = world.enemies.items;
  for (let i = 0; i < it.length; i += 1) if (it[i].alive && it[i].midBossId !== '') leave(world, it[i]);
}
