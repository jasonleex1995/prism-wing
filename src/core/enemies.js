/**
 * src/core/enemies.js — 적 스포너 + 이동 스크립트 훅 (순수 core 모듈)
 *
 * 정본 v1.4 구현 절:
 *   §8.4   적 이동 어휘 moveId — 이 파일이 매 틱 vx/vy 를 세팅하고 step.moveBullets 가 등속 적분한다.
 *          ★ 1주차 슬라이스: dive(직하강) + weave(사인 하강) 2종을 구현. 나머지 6종은 dive 폴백.
 *   §8.6   element 는 아키타입 필드가 아니다 — **웨이브 편성이 주입**한다(상성의 핵심).
 *          hp = archetype.hp × band.hpMult × curve.enemyHpScale[stage].
 *   §8.7   편대·스폰·웨이브 스케줄. ★ 슬라이스: sea 스테이지의 stage-1 해금 웨이브만 순환 스폰한다.
 *          waveClearAdvance = 전멸(live 0)이면 즉시 다음 웨이브, 아니면 waveIntervalSec 간격.
 *   §9.9.2 formations 파라미터(scatter·arc·lineH·vWedge 구현, 그 외 scatter 폴백).
 *   §10.2  world.rng.spawn 만 사용 → 결정성(같은 시드 = 같은 스폰 시퀀스).
 *   §10.3  인덱스 오름차순 순회 · 스폰 상태(world.spawner)는 최초 1회만 alloc(핫패스 0 alloc).
 *   §9.1   core 순수성 — window/Date/Math.random/… 0. import 는 core 내부만.
 *
 * ★ 이 파일은 state.js 가 인쇄 안 된 합성 계약 자리(hooks.enemies)에 주입된다(§9.1). step.js line 59:
 *     if (world.hooks.enemies !== null) world.hooks.enemies(world, dt);
 *   화면 이탈 보상 몰수(§8.7)와 slow/stun 감속·등속 적분은 step.moveBullets 소관이다 — 여기서 안 한다.
 *
 * ★ 슬라이스 범위: sea stage-1 해금 웨이브를 **케이던스·편대·element 의 골격**으로 쓰되, 아키타입은
 *   더 다양한 **로스터**에서 뽑는다(아래). 이유 — sea 의 stage-1 해금 웨이브는 아키타입이 drifter/spitter
 *   둘뿐이라 "느린 탱커 ↔ 빠른 약골"의 대비가 화면에 안 뜬다(사용자 피드백 #3). 정본 웨이브는 아키타입을
 *   확정하지만(콘텐츠), 슬라이스가 **더 다양한 stage-1 적을 뽑는 것**은 임무가 명시 허용한 범위다
 *   ("enemies.js가 더 다양한 stage-1 적을 뽑게, 단 이동/공격이 구현된 것 위주로"). 로스터는 **데이터에서
 *   유도**한다(하드코딩 id 0): 구현된 이동(dive·weave) × 플레이 가능한 밴드(chaff·line) × 테마 부합
 *   (themeOnly ∈ {null, sea}). element 는 여전히 웨이브 레코드가 주입하므로 §8.6 혼재가 유지된다.
 *   eliteIndex 는 웨이브 레코드에서 오고(전부 null → 엘리트 재롤(§8.6)은 슬라이스 밖).
 */

import { spawnEnemy } from './state.js';
import { TAU } from './angle.js';

const DEG2RAD = Math.PI / 180;
const ANCHOR_SWAY_HZ = 0.35;   // §8.4 「좌우 소폭 왕복」의 주기. 진폭은 swayAmpPx 가 소유한다
import { formationPos } from './formations.js';
import { offThemeHpMul } from './elements.js';   // §8.2 ③ 테마 밖 속성 HP
import { firstMidBossDueSec } from './midboss.js';   // §8.19(㊿-e) — 구간 경계는 «당겨진» 시각이 소유한다
import { PHASE } from './stage.js';

/** 슬라이스 스테이지 = sea, 스테이지 번호 1 (curve/해금 인덱스 0). 런 미구동(테스트) 시 폴백. */
const SLICE_STAGE_ID = 'sea';
const SLICE_STAGE_NUMBER = 1;

/** ★ 슬라이스가 구현한 이동(§8.4)·플레이 가능한 밴드(§8.6). 로스터 필터의 근거이며 하드코딩 id 가 아니다. */
const IMPLEMENTED_MOVES = ['dive', 'weave', 'column', 'strafe', 'anchor', 'orbitDrift', 'bounce'];      // step.moveBullets + enemies.applyMovement 가 실제로 미는 2종

/**
 * §8.19 도입 침묵 — 도입종이 쓸 수 있는 이동 동사.
 * ★ 이 목록은 취향이 아니라 «계측이 정한 것»이다:
 *   · strafe    — 화면 상단을 스쳐 지나가 대부분 이탈한다 → §8.7 이탈 몰수로 XP 가 증발한다(45초 XP 253 → 44).
 *   · orbitDrift — 영영 떠나지 않아 rules.fairness.enemyConcurrentMax 를 먹고 뒤 웨이브를 굶긴다(처치는 올라도 XP 228 → 34).
 *   · column     — 같은 이유(체류).
 * 도입종은 «내려와서 떠나는» 동사여야 한다. 완화하려면 먼저 다시 재라. (S48-⑤ 가 강제한다)
 */
const INTRO_MOVES = ['dive', 'weave', 'anchor', 'bounce'];

/**
 * 스폰 상태를 최초 1회만 만든다(§10.3 — 이후 핫패스는 0 alloc).
 * ★ 편성·아키타입 인덱스·간격을 전부 주입된 데이터에서 유도한다(하드코딩 매직넘버 0).
 */
/**
 * §8.10(v1.10 ⑥) — 위기 편성의 스케일링을 스테이지 진입 시 **1회 확정**한다(핫패스 0 alloc·계산).
 *   crisisTotal × swarmTotalScale[pos] 을 서브웨이브 레코드에 나눌 때 레코드마다 반올림하면 총량이 샌다 →
 *   **누적 반올림**: Σplan == round(crisisTotal × scale). 몸/공격형의 갈림은 스폰 때 봉지가 한다(shooterRatio).
 */
function crisisPlan(world, curveIdx) {
  const recs = world.data.stages.phase.crisisWaves;
  const scale = world.data.stages.curve.swarmTotalScale[curveIdx];
  const plan = new Array(recs.length);
  let cum = 0; let done = 0;
  for (let i = 0; i < recs.length; i += 1) {
    cum += recs[i].count * scale;
    const target = Math.round(cum);
    plan[i] = target - done;
    done = target;
  }
  return plan;
}

/** stageId·curveIdx 로 스폰 상태를 만든다(스테이지 진입/전환 시 1회). curveIdx = 런 포지션(0..5). */
function buildSpawner(world, stageId, curveIdx) {
  const list = world.data.stages.stages;
  let stage = null;
  for (let i = 0; i < list.length; i += 1) if (list[i].id === stageId) { stage = list[i]; break; }
  if (stage === null) throw new Error(`enemies: 스테이지 "${stageId}" 없음 (§9.9)`);

  // §8.7 — unlockStageMin ≤ 스테이지번호(= 런포지션+1) 인 웨이브만. 진행할수록 웨이브가 해금된다.
  const stageNumber = curveIdx + 1;
  const waves = [];
  for (let i = 0; i < stage.waves.length; i += 1) {
    if (stage.waves[i].unlockStageMin <= stageNumber) waves.push(stage.waves[i]);
  }
  if (waves.length === 0) throw new Error(`enemies: "${stageId}" 해금 웨이브 0개 (§8.7)`);

  // 아키타입 id → 정의. Map 순회 금지(§10.3)라 평범한 객체에 담아 **조회만** 한다.
  const archIndex = Object.create(null);
  const archetypes = world.data.enemies.archetypes;
  for (let i = 0; i < archetypes.length; i += 1) archIndex[archetypes[i].id] = archetypes[i];

  // ★ 위기(새떼) 전용 아키타입은 정상 웨이브 로스터에서 제외한다(데이터 유도, 하드코딩 id 없음) —
  //   crisisWaves 가 선언한 종이 평범한 웨이브에 섞여 나오면 §8.10 위기의 «장면»이 미리 새 버린다(실측).
  const crisisArch = Object.create(null);
  const phz = world.data.stages.phase;
  crisisArch[phz.crisisShooterId] = true;
  {
    // v1.10 ⑫ — 새떼의 종: 몸(무공격, 서브웨이브 레코드 bodyId — 흔들며 오는 새떼 / 직선 화살) + 공격형(phase). 폴백 금지(§9.3).
    const sh = archIndex[phz.crisisShooterId];
    if (sh === undefined) throw new Error(`enemies: crisisShooterId "${phz.crisisShooterId}" 미지 (§8.10)`);
    if (sh.attack === null) throw new Error(`enemies: crisisShooterId "${sh.id}" 가 안 쏜다 (§8.10)`);
    for (let i = 0; i < phz.crisisWaves.length; i += 1) {
      const b = archIndex[phz.crisisWaves[i].bodyId];
      if (b === undefined) throw new Error(`enemies: crisisWaves[${i}].bodyId "${phz.crisisWaves[i].bodyId}" 미지 (§8.10)`);
      if (b.attack !== null) throw new Error(`enemies: crisisWaves[${i}].bodyId "${b.id}" 가 쏜다 — 새떼의 몸은 무공격 (§8.10)`);
      crisisArch[b.id] = true;
    }
  }

  // ★ 로스터 — **정본이 저작한 stages[].roster 를 쓴다** (§8.3 · §8.6 · §9.9).
  //   v1.7 까지 이 코드는 저작 로스터를 «읽지 않고» archetypes 전량에서 자체 로스터를 만들었다.
  //   그 결과 §8.3 이 명시한 「후반 = 아키타입 해금이 함께 올라 «다른 적»이 나온다」가 0 으로
  //   반영됐다 — 스테이지 1 과 6 의 등장 종 집합이 사실상 같았고, 스테이지 1 에 96HP 짜리
  //   turretPod 가 섰다(실측). unlockStageMin 저작 전체가 죽은 데이터였다.
  //   ★ 해금 기준은 «런의 스테이지 번호»(1..6) — 테마는 셔플되지만 해금은 진행도를 따른다.
  const roster = [];
  for (let i = 0; i < stage.roster.length; i += 1) {
    const ent = stage.roster[i];
    if (ent.unlockStageMin > stageNumber) continue;                // 아직 안 열린 적
    const a = archIndex[ent.archetypeId];
    if (a === undefined) throw new Error(`enemies: 로스터의 미지 아키타입 "${ent.archetypeId}" (§9.9)`);
    if (crisisArch[a.id]) continue;                                // 위기 전용 → 정상 로스터 제외
    if (IMPLEMENTED_MOVES.indexOf(a.moveId) < 0) continue;         // 이동 미구현 → 애초에 제외
    roster.push(a.id);
  }
  if (roster.length === 0) throw new Error(`enemies: "${stageId}" 스테이지 ${stageNumber} 로스터 0종 (§8.6)`);

  // ★ §8.19 도입 침묵 — 판의 «머리»는 탄이 없다.
  //   도입종은 로스터 «밖»의 한 칸이다(stages[].introArchetypeId). 그래서 로스터는 4종 그대로이고
  //   S8·S22·S23·S26·S39 의 정의역이 통째로 보존되며, 곡선이 0 인 포지션은 스폰이 기준선과 바이트 동일하다.
  //   ★ 폴백 금지(§9.3) — 데이터가 어긋나면 조용히 로스터로 흐르지 않고 여기서 터진다.
  const introId = stage.introArchetypeId;
  const introDef = archIndex[introId];
  if (introDef === undefined) throw new Error(`enemies: 도입종 미지 아키타입 "${introId}" (§8.19)`);
  if (introDef.attack !== null) throw new Error(`enemies: 도입종 "${introId}" 이 쏜다 — attack !== null (§8.19)`);
  if (crisisArch[introId]) throw new Error(`enemies: 도입종 "${introId}" 은 위기 전용이다 (§8.10 · §8.19)`);
  if (world.data.enemies.bands[introDef.band].hpMult !== world.data.enemies.bands.chaff.hpMult) {
    throw new Error(`enemies: 도입종 "${introId}" 의 밴드 "${introDef.band}" — 도입종은 chaff 여야 한다(밴드 클램프가 몸 수를 줄인다, §8.19)`);
  }
  if (INTRO_MOVES.indexOf(introDef.moveId) < 0) throw new Error(`enemies: 도입종 "${introId}" 의 이동 "${introDef.moveId}" ∉ 도입 어휘 (§8.19)`);
  // §8.19(v1.10) — 스테이지가 «공격형 : 무공격» 비율을 소유한다(사용자 확정: 총량은 두고 섞이는 비율만 오른다).
  const ratio = world.data.stages.curve.shooterRatio[curveIdx];
  if (typeof ratio !== 'number' || ratio < 0 || ratio > 1) throw new Error(`enemies: curve.shooterRatio[${curveIdx}] 없음/범위 밖 (§8.19)`);
  // 공격형 로스터 — 로스터에서 attack 이 있는 것만. 무공격은 introId(로스터 밖 칸)가 채운다.
  const shooters = [];
  for (let k = 0; k < roster.length; k += 1) if (archIndex[roster[k]].attack !== null) shooters.push(roster[k]);
  if (shooters.length === 0) throw new Error(`enemies: 스테이지 "${stageId}" 로스터에 공격형이 없다 (§8.19)`);
  // 봉지 — 웨이브마다 «공격형 자리»를 섞어 뽑는다. 크기는 풀 상한(caps.enemies), 핫패스 0 alloc.
  const bag = new Uint8Array(world.data.rules.caps.enemies);
  // §8.2(v1.10 ④·⑬) 속성 봉지 — 비율의 출처는 **stages[].mix**(런타임의 유일한 출처, S8 이 «테마 + 먹이 2속성»을 지킨다).
  //   v1.10 ④ 까지는 해금 리스트의 count 가중 분포에서 파생했으나, ⑬ 이 waves[].element 를 지웠다(한 스테이지 2속성 —
  //   「늪이면 풀·물만」, 사용자 2026-09-04). 개체 단위 봉지라 웨이브마다 정확히 mix 다.
  const elemOrder = world.data.elements.order;
  const elemW = new Float64Array(elemOrder.length);
  let elemTot = 0;
  for (let k = 0; k < elemOrder.length; k += 1) {
    const v = stage.mix[elemOrder[k]];
    if (typeof v !== 'number' || v < 0) throw new Error(`enemies: stages[${stageId}].mix.${elemOrder[k]} 가 수가 아니다 (§8.2)`);
    elemW[k] = v; elemTot += v;
  }
  if (elemTot <= 0) throw new Error(`enemies: "${stageId}" mix 합이 0 (§8.2)`);
  for (let k = 0; k < elemW.length; k += 1) elemW[k] /= elemTot;
  const ebag = new Uint8Array(world.data.rules.caps.enemies);
  const equota = new Int32Array(elemOrder.length);
  const erem = new Float64Array(elemOrder.length);
  return {
    stageId, curveIdx, waves, archIndex, roster,
    introId, ratio, shooters, bag,             // §8.19(v1.10) 무공격 칸 · 공격형 비율 · 공격형 로스터 · 봉지
    elemOrder, elemW, ebag, equota, erem,      // §8.2(v1.10 ④) 속성 봉지 — 리스트 파생 가중치 · 몫 · 나머지
    waveIndex: 0, wavesSpawned: 0, nextWaveT: 0,
    element: stage.element,                    // §8.10 themePure 위기 속성
    crisisRule: stage.crisisElementRule,       // "themePure" | "finaleRotating"
    crisisSpawned: 0,                          // 이미 내보낸 위기 서브웨이브 수(반복이면 6 을 넘어 계속 센다)
    crisisPlan: crisisPlan(world, curveIdx),   // 서브웨이브별 확정 스폰 수(사이클 총량 보존)
    cbag: new Uint8Array(world.data.rules.caps.enemies),   // v1.10 ⑥ 새떼 봉지(몸/공격형) — 웨이브 봉지와 분리
  };
}

/**
 * 스폰 상태 확보. 스테이지가 바뀌면(런 진행) 재빌드한다. themeDraw 는 비복원이라 stageId 로 유일 식별.
 * ★ 핫패스 0-alloc(§10.3) — 스칼라를 인라인한다(래퍼 객체를 만들면 MOB 매 틱 리터럴이 새로 alloc 된다).
 */
function ensureSpawner(world) {
  let stageId; let curveIdx;
  if (world.run !== undefined && world.run.order !== undefined) {
    stageId = world.run.order[world.run.stageIndex];
    curveIdx = world.run.stageIndex;
  } else {
    stageId = SLICE_STAGE_ID;
    curveIdx = SLICE_STAGE_NUMBER - 1;
  }
  if (world.spawner !== undefined && world.spawner.stageId === stageId) return world.spawner;
  world.spawner = buildSpawner(world, stageId, curveIdx);
  return world.spawner;
}

/** §8.6 · §8.2 ③ — hp = archetype.hp × band.hpMult × enemyHpScale[런포지션] × offThemeHpMul(테마 밖 속성이면 < 1). 잡몹 HP 의 단일 입구. */
function enemyHp(world, def, element) {
  const band = world.data.enemies.bands[def.band];
  const scale = world.data.stages.curve.enemyHpScale[world.spawner.curveIdx];
  return def.hp * band.hpMult * scale * offThemeHpMul(world.data, world.spawner.element, element);
}

/** §8.4 — moveId 별 하강 속도의 거처. dive.speed | weave.speed | anchor.enterSpeed … 를 유도한다. */
function descentSpeed(mp) {
  if (typeof mp.speed === 'number') return mp.speed;
  if (typeof mp.enterSpeed === 'number') return mp.enterSpeed;  // anchor 계열 폴백(슬라이스 밖)
  return 0;
}

/**
 * §9.9.2 — 편대별 i번째 개체의 스폰 좌표. 원점 = 스폰 라인 중앙.
 * spawnEdge 는 슬라이스에서 top 만 유효(sea stage-1 전량 top). base y = view.spawnLineY.
 */
function placement(world, wave, i, count, out, def, formOverride, elite = false) {
  // 편대의 원점 = 스폰 라인 중앙(웨이브). 모양 자체는 formations.js 가 소유한다(§9.9.2).
  const a = world.data.rules.view.arena;
  const mv = def === undefined ? '' : def.moveId;
  const mp = def === undefined ? null : def.moveParams;
  // §8.4(v1.7) — 이동 동사가 «어디서 들어오는가»를 정하는 두 경우. 이걸 안 읽어서 세 아키타입이
  //   스폰만 되고 아레나에 한 번도 서지 못했다(실측 도달률 flanker·thornWeaver·rearDart 전부 0.0%):
  //   · strafe 는 「좌/우 벽 진입 → 수평 횡단」인데 상단 스폰라인에서 vy=0 이라 화면 위에 머물렀다.
  //   값은 이미 저작돼 있었다 — moveParams.yPx(flanker 180 · thornWeaver 140) · warnSec(0.8).
  if (mv === 'strafe' && mp !== null && typeof mp.yPx === 'number') {
    // 좌우 벽 «밖»에서 시작한다. 어느 쪽인지는 편대 인덱스로 갈라 rng 를 쓰지 않는다(§10.2 결정성).
    const pad = world.data.rules.view.spawnPadPx;
    const left = (i % 2) === 0;
    out.x = left ? a.x - pad : a.x + a.w + pad;
    out.y = a.y + mp.yPx;
    return out;
  }
  // §8.19(v1.8) 도입 구간은 편대도 «벽»으로 강제한다 — 아키타입만 갈아 끼우면 웨이브 레코드의
  //   scatter/arc 가 그대로 흩어 놓아 「빽빽하게 길을 뚫는」 그림이 되지 않는다(플레이 피드백).
  const formId = formOverride === undefined ? wave.formationId : formOverride;
  return formationPos(world, formId, i, count,
    a.x + a.w / 2, world.data.rules.view.spawnLineY, out, bodyMargin(world, def, elite));
}

/**
 * §8.7(v1.10 ㉕) «몸이 설 수 있는 폭»의 여백 = 유효 반지름(엘리트면 × elite.sizeMult) + 흔들림 폭(weave 의 ampPx).
 *   편대(formationPos)가 이 여백 안에만 몸을 세운다. 그 뒤의 이동은 step 의 옆벽 클램프(wallX)가 지킨다 — 둘이 합쳐
 *   «적이 있는 구간은 일정하다»(사용자 2026-09-05)를 만든다.
 */
export function bodyMargin(world, def, elite = false) {
  if (def === undefined) return 0;
  const mp = def.moveParams;
  const r = elite ? def.radius * world.data.rules.elite.sizeMult : def.radius;
  return r + (def.moveId === 'weave' && mp !== null && typeof mp.ampPx === 'number' ? mp.ampPx : 0);
}

/**
 * §8.2(v1.10 ④) 속성 봉지 — count 칸에 스포너의 속성 가중치(elemW, 해금 리스트 파생)대로 속성 인덱스를 채우고
 *   rng.spawn 으로 섞는다. 몫은 최대 나머지법(Hamilton): floor 합이 count 에 모자란 만큼 나머지가 큰 순으로 +1.
 *   → 웨이브마다 각 속성의 마릿수가 «정확히» round 수준으로 맞고(σ 0), 자리만 매 판 다르다(§8.19 봉지와 같은 원리).
 *   ★ 결정성 — 동률 나머지는 elements.order 순으로 깬다(순회 순서 고정). 0 alloc(§10.3).
 */
function fillElementBag(world, s, count) {
  const n = s.elemOrder.length;
  const quota = s.equota; const rem = s.erem; const ebag = s.ebag;
  let used = 0;
  for (let k = 0; k < n; k += 1) {
    const exact = count * s.elemW[k];
    quota[k] = Math.floor(exact);
    rem[k] = exact - quota[k];
    used += quota[k];
  }
  for (let left = count - used; left > 0; left -= 1) {     // 최대 나머지 순으로 +1
    let best = -1;
    for (let k = 0; k < n; k += 1) if (rem[k] > 0 && (best < 0 || rem[k] > rem[best])) best = k;
    if (best < 0) {                                         // 방어(부동소수: 나머지 합 ≈ left) — 최대 가중치에 준다
      best = 0;
      for (let k = 1; k < n; k += 1) if (s.elemW[k] > s.elemW[best]) best = k;
    }
    quota[best] += 1; rem[best] = 0;
  }
  let w = 0;
  for (let k = 0; k < n; k += 1) for (let q = 0; q < quota[k]; q += 1) ebag[w++] = k;
  for (let i = count - 1; i > 0; i -= 1) {                  // Fisher–Yates
    const j = Math.floor(world.rng.spawn.f() * (i + 1));
    const t = ebag[i]; ebag[i] = ebag[j]; ebag[j] = t;
  }
}

const _pos = { x: 0, y: 0 };   // 재사용(핫패스 0 alloc)

/**
 * §12.1(v1.8) — A층 `enemyConcurrentMax` 가 «세는 것»은 웨이브가 낸 잡몹뿐이다.
 *   보스·중간보스(§8.9)와 유령 소환(§8.9-R9)은 웨이브 예산 밖이다 — 유령은 자기 몫으로
 *   같은 enemyConcurrentMax 를 갖는다(midboss.summon).
 *   ★ v1.8 이전엔 소환에 예산 검사가 «아예 없었고» 웨이브 게이트가 유령까지 세어,
 *     예산 있는 개체가 예산 없는 개체에 굶었다. 그리고 유령 때문에 live 가 0 이 되지 않아
 *     §8.7 waveClearAdvance 가 중간보스 구간 내내 죽어 있었다.
 *   ★ 결정성: 인덱스 오름차순 순회 · 0 alloc (§10.3).
 */
export function waveLive(world) {
  const it = world.enemies.items;
  let n = 0;
  for (let i = 0; i < it.length; i += 1) {
    const e = it[i];
    if (!e.alive) continue;
    if (e.isBoss || e.midBossId !== '' || e.ghost) continue;
    n += 1;
  }
  return n;
}

/**
 * §12.1(v1.9) — A층 «위협» 예산이 세는 것. 도입 구간의 몸(introBody)은 빠진다.
 *   ★ 이것은 v1.8 이 유령에게 이미 한 처방과 «같은 것»이다: 예산 있는 개체가 예산 없는 개체에
 *     굶으면 안 된다. v1.8 은 도입 구간에 introConcurrentMax(200)를 «주었지만» 웨이브 게이트는
 *     여전히 enemyConcurrentMax(42)를 보고 있었다 — 그래서 도입 예산은 절반만 살아 있었고,
 *     벽을 두껍게 하는 순간 창이 닫힌 뒤 정상 스포너가 20초 넘게 굶는다(실측: 무기 침묵 시
 *     tests/emitters 결정성 2건이 그 자리에서 빨개진다). 이 함수가 그 절반을 마저 잇는다.
 *   ★ 「무해한 몸은 위협이 아니다」의 근거: 도입종은 attack == null 이 S48 로 강제되고(쏘지 않는다),
 *     벽에는 차선이 있어(§8.19.2) 언제나 비켜 갈 길이 있다. 접촉 피해는 남는다 — 예산에서 빠지는
 *     것이지 무적이 되는 것이 아니다.
 *   ★ 결정성: 인덱스 오름차순 순회 · 0 alloc (§10.3).
 */
export function threatLive(world) {
  const it = world.enemies.items;
  let n = 0;
  for (let i = 0; i < it.length; i += 1) {
    const e = it[i];
    if (!e.alive) continue;
    if (e.isBoss || e.midBossId !== '' || e.ghost || e.introBody) continue;
    n += 1;
  }
  return n;
}

/** §8.19.1 — 도입 구간 몸의 자기 예산(introConcurrentMax)이 세는 것. */
export function introLive(world) {
  const it = world.enemies.items;
  let n = 0;
  for (let i = 0; i < it.length; i += 1) {
    const e = it[i];
    if (!e.alive) continue;
    if (e.introBody) n += 1;
  }
  return n;
}

/** §8.7 — 한 웨이브를 편성대로 스폰한다. element 는 편성이 주입(§8.6). */
function spawnWave(world, s) {
  const wave = s.waves[s.waveIndex];
  const phase = world.data.stages.phase;
  // ★ 아키타입은 로스터 라운드로빈으로 다양화한다(웨이브 골격 = 편대·element·count·eliteIndex 는 그대로).
  //   wave 0 → roster[0](= drifter, 첫 필터 통과 아키타입)이라 element 테스트의 전제와 정합한다.
  //   슬라이스(런 없음)는 구간이 없다 → 레코드 편대. 런이면 첫 중간보스 시각 «전»이 초기 구간.
  const early = world.run != null && world.run.phaseT < firstMidBossDueSec(world);   // ㊿-e 당겨진 경계
  // 주 아키타입 = «공격형» 로스터의 순환. 밴드·count 는 이것이 정한다.
  const archetypeId = s.shooters[s.waveIndex % s.shooters.length];
  const def = s.archIndex[archetypeId];
  if (def === undefined) throw new Error(`enemies: 미지의 아키타입 "${archetypeId}" (§9.7)`);
  const introDef = s.archIndex[s.introId];
  // §8.19(v1.8) 도입 구간은 «탄을 쏘지 않는» 적만 서므로 별도 예산을 쓴다 — A층 상한은
  //   «위협»을 묶는 장치인데 무해한 벽은 성격이 다르다. 「화면을 가득 채운다」의 재료다.
  // §8.19(v1.10) 공격형 예산은 포지션 곡선을 탄다 — 비율 60~80% 를 42 로는 못 세운다(실측: 5·6 이 42·50% 에 멈췄다).
  //   기본값 42 는 그대로 두고 배율만 곡선이라 S12·S26·S50 의 스칼라 계약은 안 건드린다.
  const shootMax = Math.round(world.data.rules.fairness.enemyConcurrentMax
    * world.data.stages.curve.threatBudgetScale[s.curveIdx]);
  const chaffMax = world.data.rules.fairness.introConcurrentMax;

  // ★ count 는 밴드로 나눠 구조적으로 클램프한다(밸런스 매직넘버 아님 — effHP ∝ hpMult 이므로 탱커 웨이브가
  //   벽이 되지 않게 총 HP 예산을 대략 보존한다). chaff(hpMult 1.0)는 원본 count 유지, line(2.5)은 줄어든다.
  // §8.19(v1.10) 마리수는 «무공격 밴드»(chaff) 기준이다 — 사양이 「300마리 중 30이 쏜다」이므로
  //   몸의 대부분은 무공격이고, 공격형은 비율만큼 섞인다. 공격형 밴드로 세면 line/turret 이
  //   주 아키타입일 때 무공격까지 같이 줄어 «가득 찬 화면»이 무너진다(실측: forest 첫 웨이브 7기).
  const band = world.data.enemies.bands[introDef.band];
  // §8.6 — 스테이지별 스폰 밀도(curve.spawnDensityScale). ★ 실측으로 발견된 누락: 이것이 없으면
  //   스테이지 1 이 저작 의도(0.7배)보다 30% 더 몰려오고 후반은 반대로 헐거워진다.
  const density = world.data.stages.curve.spawnDensityScale[s.curveIdx];
  // §8.7.1(v1.8) — 몸 수의 «하한»은 밴드가 소유한다(C-4). 하드코딩 2 는 안전망이 아니라
  //   실제 값으로 돌고 있었다(실측: 전 웨이브의 43.8% 가 4마리 미만). 총 HP 예산은 여전히
  //   hpMult 나눗셈이 보존하고, 하한은 「그 예산이 몇 개의 몸으로 쪼개지는가」만 정한다.
  // ★ §8.19.1 — 초입 위기만 «몸 수»를 레코드에서 가져오지 않는다. 그 값은 밀도가 아니라 «장면»이다
  //   (한 줄 18기 × N줄). 그래서 포지션 곡선을 곱하지 «않는다» — 곱하면 포지션 3 에서 450기가 되어
  //   장면이 아니라 폭발이 된다(실측). 같은 벽이 뒤로 갈수록 무거워지는 것은 enemyHpScale 이 이미 한다.
  const count = Math.max(band.minPerWave, Math.round((wave.count / band.hpMult) * density));
  // §8.19(v1.10) 봉지 — count 칸 중 round(count × ratio) 칸이 공격형. rng.spawn 으로 섞는다(§10.2 시드 난수).
  //   마리수 편차 0 · 배치만 매 판 다르다(독립 베르누이는 300마리 10%에서 σ 5.2 = ±40%).
  const nShoot = Math.round(count * s.ratio);
  const bag = s.bag;
  for (let i = 0; i < count; i += 1) bag[i] = i < nShoot ? 1 : 0;
  for (let i = count - 1; i > 0; i -= 1) {                  // Fisher–Yates
    const j = Math.floor(world.rng.spawn.f() * (i + 1));
    const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
  }
  // §8.2(v1.10 ④) 속성 봉지 — count 칸을 mix 로 나눈다(최대 나머지법 → 합이 정확히 count). 그 다음 셔플.
  //   몸마다 속성이 다르므로 «한 웨이브 = 한 색»이 아니라 «매 순간 화면 ≈ mix» 다(테마가 항상 다수).
  fillElementBag(world, s, count);

  // §12.1(v1.9) — 예산은 «자기 몫»을 센다: 도입 구간의 몸은 introConcurrentMax, 그 밖은
  //   enemyConcurrentMax(위협). 루프 진입 전 1회 계산 후 지역 증분(0 alloc·결정적).
  let liveShoot = threatLive(world);
  let liveChaff = introLive(world);
  for (let i = 0; i < count; i += 1) {
    let shoot = bag[i] === 1;
    // §8.7 초과 정책 = defer — 예산은 «자기 몫»을 센다(공격형 = 위협, 무공격 = 도입).
    // ★ v1.10 ⑪ 공격형 예산이 찼으면 그 칸은 «몸»으로 선다 — 비율은 상한이지 밀도의 구멍이 아니다. 안 그러면 후반
    //   (비율 55~70%)에서 예산에 막힌 칸이 통째로 비어 벽이 헐거워졌다(실측 포지션 5: 21초 178기 vs 포지션 1: 392기).
    if (shoot && liveShoot >= shootMax) shoot = false;
    const d = shoot ? def : introDef;
    if (shoot) liveShoot += 1;
    else { if (liveChaff >= chaffMax) continue; liveChaff += 1; }
    // §8.6 — 엘리트 = 두 경로의 OR:
    //   (1) eliteIndex: 그 웨이브의 n번째 개체에 접두 플래그(베이크된 스포트라이트, perWaveMax 1).
    //   (2) 엘리트 재롤(§8.6, 이제 구현 — 예약된 rng.elite 스트림): 자격 개체(밴드∈bandAllowed ∧
    //       속성∈elementAllowed)가 런 포지션 곡선 확률 elitePerWaveChance[curveIdx] 로 엘리트가 된다.
    //       곡선은 포지션(초반 0 → 최종 1.0)으로 오른다 → 테마가 셔플돼도 «초반 헐거움·후반 전면 엘리트».
    //       ★ 단락평가로 자격 개체만 rng.elite 를 뽑는다(결정성: 같은 시드 = 같은 엘리트열, §10.2).
    const el = world.data.rules.elite;
    const element = s.elemOrder[s.ebag[i]];               // §8.2(v1.10 ④) 몸의 속성 = 속성 봉지
    const eligible = el.bandAllowed.indexOf(def.band) >= 0 && el.elementAllowed.indexOf(element) >= 0;
    const chance = world.data.stages.curve.elitePerWaveChance[s.curveIdx];
    // §8.6(v1.7) — ★ 곡선이 «유일한 권위»다. v1.6 까지 베이크된 eliteIndex 는 곡선을 통째로
    //   무시했다: 스테이지 1 은 곡선이 0.0 인데도 웨이브의 34% 가 엘리트를 낳았고, 엘리트는
    //   hpMult 4.0 이라 Lv1 무기로 10~20초짜리 벽이었다(플레이 피드백).
    //   이제 베이크된 스포트라이트도 «그 스테이지가 엘리트를 허용할 때만» 선다 — 초반엔 같은
    //   자리에 평범한 몹이 서고, 스테이지가 갈수록 그 자리가 엘리트가 된다.
    const stageAllows = chance > 0;
    const rerollElite = eligible && stageAllows && world.rng.elite.f() < chance;
    const bakedElite = stageAllows && eligible && wave.eliteIndex !== null && i === wave.eliteIndex;
    // §8.6 perWaveMax — 선언만 되어 있고 아무도 강제하지 않던 값이다(재롤이 웨이브당 여러 마리를
    //   만들 수 있었다). 이제 실제로 상한이다.
    // §8.6 perWaveMax(=1) 는 «베이크된 스포트라이트» 쪽 서술이다 — eliteIndex 가 단일 인덱스라
    //   구조적으로 웨이브당 1기다. 재롤에까지 상한을 걸면 안 된다: 정본 v1.5 가 「최종 1.0 = 자격
    //   전원」으로 «후반 전면 엘리트화»를 확정했으므로, 상한을 걸면 그 설계가 통째로 죽는다
    //   (실측: 걸었더니 스테이지 6 엘리트율이 1.2% 로 주저앉았다).
    const elite = bakedElite || rerollElite;
    // ★ v1.10 ㉕ 자리는 «유효 반지름»(엘리트면 sizeMult 배)으로 여백을 잡는다 — 엘리트가 경계에 반쯤 걸치던 원인.
    placement(world, wave, i, count, _pos, d, early ? phase.introFormationId : undefined, shoot && elite);
    // 개체별로 종·체력이 갈린다 — 봉지가 정한 자리에 공격형(def) 또는 무공격(introDef).
    const born = spawnEnemy(world, shoot ? archetypeId : s.introId, element, _pos.x, _pos.y,
      enemyHp(world, shoot ? def : introDef, element), shoot && elite);   // §8.2 ③ 속성별 HP(테마 밖이면 약하다)
    // §12.1(v1.9) — 무공격 몸에 표식을 켠다. 이 한 줄이 「무해한 몸은 위협 예산을 먹지 않는다」다.
    if (born !== null && !shoot) born.introBody = true;
    if (born !== null) born.wallX = d.moveId !== 'strafe';                 // §8.7 ㉕ 옆벽 클램프(strafe 는 벽 밖에서 들어온다)
  }

  s.waveIndex = (s.waveIndex + 1) % s.waves.length;   // §8.7 waveListExhausted = "cycle"
  s.wavesSpawned += 1;                                 // 런 구동 시 mobPhaseMaxWaves 상한의 근거
}

/**
 * §8.10 — 위기 서브웨이브의 속성. themePure = 60기 전부 테마 속성(정답 스탠스의 페이오프),
 *   finaleRotating(최종 전용) = 서브웨이브 1·2 물 → 3·4 불 → 5·6 풀 (§8.16 · §7.12.3).
 */
function crisisElement(s, subWave) {
  if (s.crisisRule === 'themePure') return s.element;
  if (s.crisisRule !== 'finaleRotating') throw new Error(`enemies: 미지의 crisisElementRule "${s.crisisRule}" (§8.10)`);
  if (subWave <= 2) return 'water';
  if (subWave <= 4) return 'fire';
  return 'grass';
}

/** §8.10 — 한 위기 서브웨이브(9 swarmChaff + 1 swarmLancer)를 편성대로 내보낸다. */
/**
 * §8.10(v1.10 ⑥) — 새떼 서브웨이브 하나. subWave 는 1..crisisSubWaves 로 접은 인덱스(반복 사이클의 몇 번째 파인가).
 *   레코드가 편대·몸 수를, phase.crisisBodyId/ShooterId 가 두 종을, curve.shooterRatio[pos] 가 «쏘는 비율»을 갖는다
 *   (사용자 2026-09-04: 「탄환을 쏘는 것은 stage 가 올라감에 따라 비율이 높아지게」 — 정상 웨이브와 같은 곡선, 새 키 0).
 *   봉지: round(count × ratio) 칸이 공격형, rng.spawn 으로 섞는다 — 마릿수 편차 0, 자리만 매 판 다르다.
 *   속성은 crisisElement(themePure | finaleRotating — 서브웨이브 index 기준이라 사이클마다 같은 회전).
 */
function spawnCrisisSubWave(world, s, subWave) {
  const ph = world.data.stages.phase;
  const recs = ph.crisisWaves;
  const swarmMax = world.data.rules.fairness.swarmConcurrentMax;
  const el = crisisElement(s, subWave);
  const shooter = s.archIndex[ph.crisisShooterId];
  // §8.10(v1.10 ㉜) 위기 체력 배율 — 사용자: 「위기 구간이 가만히 있어도 깨지는 느낌」. 새떼가 «닿기 전에 죽으면» 피하기 구간이
  //   못 된다 → 포지션 곡선으로 새떼 HP 만 올린다(초기 벽·중간보스·보스는 무관). enemyHp 위에 곱한다(테마 밖 배율도 그대로).
  const chs = world.data.stages.curve.crisisHpScale[s.curveIdx];
  const hpShoot = enemyHp(world, shooter, el) * chs;
  const ratio = world.data.stages.curve.shooterRatio[s.curveIdx];

  for (let i = 0; i < recs.length; i += 1) {
    const r = recs[i];
    if (r.subWave !== subWave) continue;
    const body = s.archIndex[r.bodyId];             // v1.10 ⑫ 서브웨이브의 몸 종(arc 새떼 / vWedge 화살)
    const hpBody = enemyHp(world, body, el) * chs;
    const count = s.crisisPlan[i];                  // 스테이지 진입 시 확정(사이클 총량 보존)
    const nShoot = Math.round(count * ratio);
    const bag = s.cbag;
    for (let k = 0; k < count; k += 1) bag[k] = k < nShoot ? 1 : 0;
    for (let k = count - 1; k > 0; k -= 1) {          // Fisher–Yates (rng.spawn)
      const j = Math.floor(world.rng.spawn.f() * (k + 1));
      const t = bag[k]; bag[k] = bag[j]; bag[j] = t;
    }
    // §8.6 · §8.10(v1.10 ㉘) 위기에도 엘리트가 선다 — 사용자: 「위기 구간에는 엘리트가 왜 하나도 없어? 초기 구간만큼 빡세야 한다」.
    //   정상 웨이브와 «같은 규칙»: 자격(밴드 ∈ bandAllowed ∧ 속성 ∈ elementAllowed) 개체가 elitePerWaveChance[포지션] 확률로,
    //   rng.elite 스트림(단락평가 — 자격 개체만 뽑는다, §10.2). 새떼 몸(chaff)은 자격 밖이라 화살(line)·공격형만 후보다.
    const el2 = world.data.rules.elite;
    const chance = world.data.stages.curve.elitePerWaveChance[s.curveIdx];
    for (let k = 0; k < count; k += 1) {
      if (world.enemies.live >= swarmMax) break;      // §12.4 swarmConcurrentMax (새떼 전용 상한)
      const shoot = bag[k] === 1;
      const d = shoot ? shooter : body;
      const eligible = chance > 0 && el2.bandAllowed.indexOf(d.band) >= 0 && el2.elementAllowed.indexOf(el) >= 0;
      const elite = eligible && world.rng.elite.f() < chance;
      placement(world, r, k, count, _pos, d, undefined, elite);   // 레코드가 formationId 를 들고 있다(arc/vWedge)
      const bornC = spawnEnemy(world, d.id, el, _pos.x, _pos.y, shoot ? hpShoot : hpBody, elite);
      if (bornC !== null) bornC.wallX = d.moveId !== 'strafe';   // §8.7 ㉕
    }
  }
}

/**
 * §8.10(v1.10 ⑥) — 위기 세션: 위기 시작(run.crisisAtSec — 격파로 앞당겨질 수 있다)부터 crisisCycleSec 마다 한 사이클
 *   (crisisSubWaves 파, 균등 간격). crisisSwarmLoop 면 페이즈 끝까지 사이클을 반복한다 — 「빠른 무리가 쭈르륵 내려오며
 *   피하거나 부숴서 길을 내는」 구간(사용자 2026-09-04). false 면 한 사이클만(옛 v1.3~v1.10 ⑤).
 *   정상 웨이브의 정지 여부는 crisisSuspendsWaves 가 정한다(enemies() 의 구간 분기). 누적 카운트라 큰 dt 도
 *   놓치지 않는다(결정적 캐치업).
 */
function spawnCrisis(world, s) {
  const ph = world.data.stages.phase;
  const elapsed = world.run.phaseT - world.run.crisisAtSec;
  const interval = ph.crisisCycleSec / ph.crisisSubWaves;
  let want = Math.floor(elapsed / interval) + 1;
  if (!ph.crisisSwarmLoop && want > ph.crisisSubWaves) want = ph.crisisSubWaves;
  while (s.crisisSpawned < want) {
    s.crisisSpawned += 1;
    spawnCrisisSubWave(world, s, ((s.crisisSpawned - 1) % ph.crisisSubWaves) + 1);   // 1..6 으로 접는다
  }
}

/**
 * §8.4 — 매 틱 alive 적의 vx/vy 를 moveId 로 갱신한다. step.moveBullets 가 등속 적분한다.
 *   dive  : vy = speed, vx = 0 (직하강)
 *   weave : vy = speed, vx = ampPx·ω·cos(ω·moveT), ω = 2π·freqHz (사인 좌우의 해석적 속도)
 *   그 외 : dive 폴백(슬라이스)
 * ★ e.moveT 는 step 이 적분 후 dt 만큼 올린다 → 여기서는 **현재 moveT** 로 속도를 산출한다.
 */
/**
 * §8.19(v1.10) 구간의 «속도» — 사용자 사양: 「초기 구간은 느리게 천천히, 위기 구간은 꽤 빠르게」.
 *   구간은 사건 타이머가 가른다(새 시계 0): 초기 = 첫 중간보스 전 · 위기 = run.crisis(격파 앞당김 또는 crisisStartSec 상한) · 그 사이 = mid.
 *   슬라이스(런 없음)는 1.0 — 구간이 없다. 유령·중간보스·보스는 각자 소관이라 여기 안 온다.
 */
function sectionSpeedMul(world) {
  const run = world.run;
  if (run == null) return 1;
  const ph = world.data.stages.phase;
  const m = ph.sectionSpeedMul;
  if (run.crisis) return m.crisis;
  // §8.19 ① 배수는 «속도를 올리지 않는다»(v1.10 ⑮, 사용자: 「천천히 잡으면서 파밍하는 구간인데 왜 빨라지나」) —
  //   스폰만 멈추고 무리는 초기 속도 그대로 흘러 나간다. 그래서 earlyDrainSec 이 벽 한 벌의 통과 시간(≈ 23초)만큼 길다(S54 ⑦).
  if (run.phaseT < firstMidBossDueSec(world)) return m.early;   // ㊿-e 당겨진 경계
  return m.mid;
}

function applyMovement(world) {
  const items = world.enemies.items;
  const arch = world.spawner.archIndex;
  const arena = world.data.rules.view.arena;
  const sMul = sectionSpeedMul(world);
  for (let i = 0; i < items.length; i += 1) {
    const e = items[i];
    if (!e.alive) continue;
    if (e.isBoss) continue;              // 보스 개체는 archIndex 에 없다 — 이동은 boss.js 소관(§8.12.1)
    if (e.midBossId !== '') continue;    // 중간보스도 마찬가지 — 이동은 midboss.js 소관(§8.9)
    const def = arch[e.archetypeId];
    const mp = def.moveParams;
    const speed = descentSpeed(mp) * sMul;
    const mv = def.moveId;

    if (mv === 'bounce') {
      // §8.4(v1.7) 벽 반사 — 대각으로 들어와 좌우 벽을 되튀며 내려온다.
      //   플레이어의 도탄 무기(리턴)와 «같은 규칙»을 적이 쓴다. 벽이 내 편만은 아니라는 것을 가르친다.
      //   ★ 진입 방향은 strafe 와 같은 규약으로 정한다 — 스폰 x 가 중앙보다 왼쪽인가. rng 금지(§10.2).
      //   ★ 반사는 여기서 «속도 부호»만 뒤집는다. 위치 되접기는 step 의 적 이동이 클램프로 처리한다.
      if (e.mp0 === 0) e.mp0 = e.x < (arena.x + arena.w * 0.5) ? 1 : -1;
      const hx = (typeof mp.hSpeed === 'number' ? mp.hSpeed : descentSpeed(mp)) * sMul;   // 좌우도 구간 속도를 탄다
      if (e.x <= arena.x + e.radius && e.mp0 < 0) e.mp0 = 1;
      else if (e.x >= arena.x + arena.w - e.radius && e.mp0 > 0) e.mp0 = -1;
      e.vx = hx * e.mp0;
      e.vy = speed;

    } else if (mv === 'weave' && typeof mp.ampPx === 'number' && typeof mp.freqHz === 'number') {
      const w = TAU * mp.freqHz;
      e.vy = speed;
      e.vx = mp.ampPx * w * Math.cos(w * e.moveT);

    } else if (mv === 'strafe') {
      // §8.4 — 좌/우 벽 진입 → 수평 횡단 → 반대편 이탈. yPx 고정.
      //   ★ 진입 방향은 «스폰 x 가 아레나 중앙보다 왼쪽인가»로 정한다 — rng 를 쓰지 않는다(§10.2 결정성).
      if (e.mp0 === 0) e.mp0 = e.x < (arena.x + arena.w * 0.5) ? 1 : -1;
      e.vx = speed * e.mp0;
      e.vy = 0;

    } else if (mv === 'anchor') {
      // §8.4 — 상단 진입 → yHoldPx 정지 → 좌우 소폭 왕복 → leaveAfterSec 후 하단 이탈.
      const hold = typeof mp.yHoldPx === 'number' ? mp.yHoldPx : 0;
      const sway = typeof mp.swayAmpPx === 'number' ? mp.swayAmpPx : 0;
      const leave = typeof mp.leaveAfterSec === 'number' ? mp.leaveAfterSec : 0;
      if (e.mp0 === 0 && e.y < hold) {
        e.vy = speed; e.vx = 0;                        // ① 진입
      } else {
        if (e.mp0 === 0) { e.mp0 = 1; e.mp1 = e.moveT; }   // 정지 시각을 잠근다
        const held = e.moveT - e.mp1;
        if (held >= leave) {
          e.vy = speed; e.vx = 0;                      // ③ 이탈
        } else {
          const w = TAU * ANCHOR_SWAY_HZ;              // ② 체류 — 속도로 준다(적분해도 진폭을 안 넘는다)
          e.vy = 0;
          e.vx = sway * w * Math.cos(w * held);
        }
      }

    } else if (mv === 'orbitDrift') {
      // §8.4(v1.10 ㉕ 재작성) — 플레이어 쪽으로 호를 그리며 접근 → keepDistPx 근처에서 «플레이어 위쪽 반원»을 진자처럼 돈다.
      //   v1.7 식은 접선항(turn × keep = 174~220px/s)이 속도(38~51)를 압도해 정규화 뒤 «거의 접선만» 남았다 → 상단에서
      //   스폰되자마자 옆으로 미끄러져 한 번도 들어오지 못하고 화면 밖(x < 아레나 − 80)에서 13초를 맴돌다 사라졌다(실측:
      //   사이렌레이 41%·스토커 37% 의 생애가 아레나 밖). 사용자: 「계속 화면 밖으로 피하는 몹들」.
      //   ① 반경 항 r = clamp((d − keep)/keep, −1, 1): 멀면 «속도 그대로» 접근(r=1), keep 근처 0, 안쪽이면 후퇴(r=−1).
      //   ② 접선 항 = min(turn × keep, speed) × (1 − 0.7|r|) × 방향(mp0) — 멀리서는 30%(호), keep 에서 100%(궤도).
      //   ③ 접선 방향은 옆벽(반지름 여백) 또는 «플레이어 높이»에 닿으면 뒤집는다(진자) — 화면 밖·플레이어 아래로 가지 않는다.
      //      사용자: 「적이 화면 밑에서 나온다」·「적이 있는 구간은 일정해야 한다」. 방향의 첫 값은 스폰 x 로(rng 0, §10.2).
      const keep = typeof mp.keepDistPx === 'number' ? mp.keepDistPx : 0;
      const turn = typeof mp.turnRateDegSec === 'number' ? mp.turnRateDegSec : 0;
      const px = world.player.x; const py = world.player.y;
      let dx = px - e.x;
      let dy = py - e.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 0.0001) { dx /= d; dy /= d; } else { dx = 0; dy = 1; }
      if (e.mp0 === 0) e.mp0 = e.x < px ? 1 : -1;
      const r = keep > 0 ? Math.max(-1, Math.min(1, (d - keep) / keep)) : 1;
      const orbitV = Math.min(turn * DEG2RAD * keep, speed);
      const tan = orbitV * (1 - 0.7 * Math.abs(r)) * e.mp0;
      let vx = dx * r * speed - dy * tan;
      let vy = dy * r * speed + dx * tan;
      // ③ 되접기 — 벽·플레이어 높이에서 접선 방향을 뒤집고 이번 틱의 속도도 뒤집힌 값으로
      const m = e.radius;
      const atWall = (e.x <= arena.x + m && vx < 0) || (e.x >= arena.x + arena.w - m && vx > 0);
      const atLevel = e.y >= py - m && vy > 0;
      if (atWall || atLevel) {
        e.mp0 = -e.mp0;
        const t2 = -tan;
        vx = dx * r * speed - dy * t2;
        vy = dy * r * speed + dx * t2;
        if (atLevel && vy > 0) vy = 0;                 // 그래도 내려가면 멈춘다 — 플레이어 아래는 없다
        if (atWall) { if (e.x <= arena.x + m && vx < 0) vx = 0; if (e.x >= arena.x + arena.w - m && vx > 0) vx = 0; }
      }
      const vm = Math.sqrt(vx * vx + vy * vy);
      if (vm > speed) { vx = vx / vm * speed; vy = vy / vm * speed; }
      e.vx = vx;
      e.vy = vy;

    } else {
      // dive · column + 폴백 — 직하강. column 의 «일렬 종대»는 이동이 아니라 스폰 편성(gapSec)이 만든다.
      e.vy = speed;
      e.vx = 0;
    }
  }
}

/**
 * ★ 훅 진입점 — step.js 가 매 고정 틱 부른다(hooks.enemies 로 주입).
 *   (1) 스폰 케이던스 → (2) 갓 스폰한 개체 포함 전 개체의 이동 속도 갱신.
 *   화면 이탈 몰수(§8.7)·slow/stun 감속·좌표 적분은 step.moveBullets 소관이다.
 */
export function enemies(world, dt) {
  const runMode = world.run !== undefined && world.run.order !== undefined;
  // §6.5 — 런 구동이면 스폰은 MOB 페이즈에만. BOSS_INTRO/BOSS/STAGE_CLEAR 엔 잔존 개체 이동만.
  //   ★ 스포너가 아직 없으면(그 스테이지에 잡몹을 한 번도 안 스폰) 움직일 잡몹도 없다 → 이동 생략.
  if (runMode && world.run.phase !== PHASE.MOB) {
    if (world.spawner !== undefined) applyMovement(world);
    return;
  }

  const s = ensureSpawner(world);

  // §8.19(v1.10) 바깥 게이트도 «같은» 곡선 배율을 탄다 — 루프 안만 올리면 웨이브 시작이 42 에 막혀
  //   간격이 2.65 → 8초로 벌어진다(실측 포지션 6: threatLive 49 에서 정지). 두 자리가 다른 값을 보면 안 된다.
  const concurrentMax = Math.round(world.data.rules.fairness.enemyConcurrentMax
    * world.data.stages.curve.threatBudgetScale[s.curveIdx]);
  const ph = world.data.stages.phase;
  // §8.19(v1.10) 구간은 «순차·배타»다 — 사용자: 「초기 구간이 끝나지 않았는데 중간보스가 나온다」.
  //   위기  : 새떼 서브웨이브(§8.10)를 내보내고, crisisSuspendsWaves 가 false 면 정상 웨이브도 «계속»
  //           흐른다(waveIntervalSec, sectionSpeedMul.crisis) — 사용자: 「속도 빠른 적이 끊임없이 나오는 구간」.
  //           true 면 새떼만(옛 v1.1 관대함). ★ 위기가 먼저다 — 시각으로는 중간보스 구간 안일 수 있다(격파 앞당김).
  //   초기  : 첫 중간보스 − earlyDrainSec 까지 스폰. 간격은 earlyWaveIntervalSec(우루루).
  //   배수  : 그 뒤 첫 중간보스까지 스폰 0 — 무리가 화면을 빠져나갈 시간이다.
  //   중간보스: midBossSuspendsWaves 면 웨이브 정지 — 몹이 적어야 중간보스를 «피할 수» 있다(유령만 흐른다).
  //   슬라이스(런 없음)는 구간이 없다.
  let interval = ph.waveIntervalSec;
  if (runMode) {
    const firstMb = firstMidBossDueSec(world);   // ㊿-e — 필드가 비면 당겨진다
    const t = world.run.phaseT;
    if (world.run.crisis) {                                                          // 위기
      spawnCrisis(world, s);
      if (ph.crisisSuspendsWaves) { applyMovement(world); return; }
    }
    else if (t < firstMb - ph.earlyDrainSec) interval = ph.earlyWaveIntervalSec;    // 초기
    else if (t < firstMb) { applyMovement(world); return; }                          // 배수
    else if (ph.midBossSuspendsWaves) { applyMovement(world); return; }              // 중간보스 구간
  }
  // §6.3 — 런 구동은 mobPhaseMaxWaves 상한. 슬라이스(테스트)는 무한 순환(상한 없음).
  const wavesLeft = !runMode || s.wavesSpawned < ph.mobPhaseMaxWaves;

  // §12.1(v1.9) — 두 셈이 «다른 일»을 한다:
  //   · 예산(누가 더 설 수 있는가) = threatLive — 도입 구간의 무해한 몸은 위협 예산을 먹지 않는다.
  //   · 케이던스(전멸이면 즉시 다음) = waveLive — 화면이 실제로 비었는가는 몸 전부를 세야 한다.
  //   ★ 이 분리가 없으면 벽이 창을 넘어 내려오는 동안 정상 스포너가 통째로 굶는다.
  const wLive = waveLive(world);
  const tLive = threatLive(world);
  // ★ v1.10 ⑪ 바깥 게이트는 «두 예산 중 하나라도» 자리가 있으면 연다 — 공격형 예산(42×배율)만 보면 후반(비율 55~70%)에서
  //   공격형이 차는 순간 웨이브 전체가 서서 벽이 헐거워졌다(실측 포지션 5: 21초 183기). 안의 봉지가 예산 찬 공격형 칸을
  //   몸으로 돌리므로(fallback), 몸 예산(introConcurrentMax)에 자리가 있으면 웨이브는 선다.
  const cLive = introLive(world);
  if ((tLive < concurrentMax || cLive < world.data.rules.fairness.introConcurrentMax) && wavesLeft) {
    // §8.7 waveClearAdvance — 전멸(live 0)이면 즉시 다음, 아니면 waveIntervalSec 간격.
    if (wLive === 0 || world.time >= s.nextWaveT) {
      spawnWave(world, s);
      s.nextWaveT = world.time + interval;
    }
  }

  applyMovement(world);
}
