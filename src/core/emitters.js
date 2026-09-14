/**
 * src/core/emitters.js — 적 공격(이미터) 발사 훅 (순수 core 모듈)
 *
 * 정본 v1.4 구현 절:
 *   §8.5   이미터 어휘 8종(straight·fan·aimed·ring·spiral·laser·zone·wall). 유도·상태이상은
 *          **탄 속성**이지 이미터가 아니다 → 이 파일은 발사 각/속도/개수만 만들고, 유도(turnRate)·
 *          slow/stun 은 spawnEnemyBullet 이 탄 데이터에서 실어 step 이 처리한다.
 *   §8.5   공통 파라미터 telegraphSec·everySec·offsetSec·repeat·restSec 로 케이던스가 유도된다.
 *          잡몹(attack 참조 이미터)은 S30 이 repeat==1 ∧ restSec==0 를 강제 → **메트로놈**.
 *          일반 악절(repeat≥2·restSec>0)도 같은 식으로 환원되게 구현한다(보스는 슬라이스 밖).
 *   §7.4 · §12.4  공정성(느린 속도·관대한 판정·텔레그래프 리드)은 **이미터 데이터가 이미 보장**한다
 *          (speed ≤ fairness.maxBulletSpeed 등은 check.mjs S6 가 로드에서 강제). 여기서 지어내지 않고
 *          데이터대로 발사한다. ★ 텔레그래프 리드: 각 발사는 그 볼리의 telegraphSec **뒤에** 일어난다
 *          (t_fire = firstDelaySec + telegraphSec + offsetSec + k·everySec). 텔레그래프의 **그리기**는
 *          렌더 소관(슬라이스 밖)이지만, 타이밍 리드를 여기서 보존하므로 렌더가 붙어도 core 무변경.
 *   §9.9.2 aimed 는 leadSec 만큼 플레이어 속도를 앞질러 조준한다.
 *   §10.2  결정성 — 발사 각/개수/타이밍이 전부 e.x/e.y/player 상태와 데이터의 **결정 함수**다.
 *          난수를 쓰지 않으므로(쓴다면 world.rng.pattern 만) 같은 시드 = 같은 탄 시퀀스.
 *   §10.3  인덱스 오름차순 순회 · 조회 인덱스(emitById/archById)는 최초 1회만 alloc(핫패스 0 alloc).
 *   §9.1   core 순수성 — window/Date/Math.random/… 0. import 는 core 내부(state.js·angle.js)만.
 *
 * ★ 합성 계약: state.js 가 hooks.emitters 자리를 인쇄 안 된 채로 뒀다(§9.1). step.js line 60:
 *     if (world.hooks.emitters !== null) world.hooks.emitters(world, dt);
 *   이 훅은 **발사만** 한다. 탄 이동·플레이어 충돌·i-frame·상태이상 적용은 step.moveBullets/collide 소관.
 *
 * ★ 스케줄 상태는 개체 필드 e.emitT(이미터 나이) · e.emitPhase(이미 쏜 볼리 수)에 산다.
 *   makeEnemy()가 자리를 예약했고 spawnEnemy()가 스폰마다 0 으로 리셋한다(슬롯 재사용 안전).
 */

import { spawnEnemyBullet, spawnZone, spawnBeam, difficultyAllowsStun, difficultyFireRateMul } from './state.js';
import { DEG2RAD, TAU } from './angle.js';

/**
 * §13.1.1 — 발사체의 치사 지분 귀속 키. 잡몹 = 아키타입 / 중간보스 = midBossId('mb…') /
 *   보스 부위 = 'boss'. sim 의 grade() 는 'mb…'·'boss'·'' 를 분모에서 제외한다(잡몹만 센다).
 */
function srcArchOf(e) {
  if (e.archetypeId !== '') return e.archetypeId;
  if (e.midBossId !== '') return e.midBossId;
  return 'boss';
}

/**
 * 조회 인덱스를 최초 1회만 만든다(§10.3 — 이후 핫패스 0 alloc). Map 순회 금지라 평범한 객체에 담아
 * **조회만** 한다. emitById: 이미터 id → 정의 / archById: 아키타입 id → 정의(attack 을 읽는다).
 */
function ensureLookup(world) {
  if (world.emitLookup !== undefined) return world.emitLookup;
  const emitById = Object.create(null);
  const ems = world.data.enemies.emitters;
  for (let i = 0; i < ems.length; i += 1) emitById[ems[i].id] = ems[i];
  const archById = Object.create(null);
  const arr = world.data.enemies.archetypes;
  for (let i = 0; i < arr.length; i += 1) archById[arr[i].id] = arr[i];
  const bossById = Object.create(null);                 // §9.8 — 보스 파트 patternSet 조회
  const bs = world.data.bosses.bosses;
  for (let i = 0; i < bs.length; i += 1) bossById[bs[i].id] = bs[i];
  const bulletById = Object.create(null);               // §8.5 laser 의 피해는 탄 정의에서 온다
  const bl = world.data.bullets.bullets;
  for (let i = 0; i < bl.length; i += 1) bulletById[bl[i].id] = bl[i];
  // stunDiffId·stunAllowed — §2.7 스턴 게이팅 캐시. 난이도가 바뀔 때만 다시 묻는다(런 중엔 안 바뀐다, §6.1) → stunSilenced
  world.emitLookup = { emitById, archById, bossById, bulletById, stunDiffId: null, stunAllowed: false };
  return world.emitLookup;
}

/**
 * §9.8.1 — 보스 파트가 이 페이즈에 쏘는 이미터 id. 없으면(코어·미정의·빈 페이즈) null.
 *   보스 파트는 페이즈당 emitterIds 1개다(중간보스의 1~2개는 emitters() 가 직접 돌린다). from='part' 는 파트가 anchor 위치의
 *   개별 엔티티라 자동 충족(e.x/e.y = 파트 위치).
 */
function bossPartEmitterId(look, e) {
  const boss = look.bossById[e.bossId];
  if (boss === undefined) return null;
  let part = null;
  for (let i = 0; i < boss.parts.length; i += 1) if (boss.parts[i].id === e.partId) { part = boss.parts[i]; break; }
  if (part === null || part.patternSet === undefined) return null;
  const ps = part.patternSet[e.phase];
  if (ps === undefined || ps.emitterIds.length === 0) return null;
  return ps.emitterIds[0];
}

/**
 * §8.5 — 이미터 나이 age(초) 시점까지 **쏘였어야 할 볼리 총수**.
 *   firstFire = firstDelaySec + telegraphSec + offsetSec  (첫 볼리 = 스폰 유예 + 텔레그래프 리드)
 *   악절 주기 period = repeat·everySec + restSec           (잡몹 메트로놈이면 = everySec)
 *   한 주기 안 볼리 j 는 j·everySec 에 발사, repeat 발 뒤 restSec 쉰다.
 * ★ 누적 카운트로 돌려주므로 큰 dt 도 놓치지 않는다(결정적 캐치업). age < firstFire → 0.
 */
function scheduledVolleys(age, em, firstDelaySec) {
  const firstFire = firstDelaySec + em.telegraphSec + em.offsetSec;
  if (age < firstFire) return 0;
  const period = em.repeat * em.everySec + em.restSec;
  const elapsed = age - firstFire;
  const cyc = Math.floor(elapsed / period);
  const within = elapsed - cyc * period;
  let inCycle = Math.floor(within / em.everySec) + 1;
  if (inCycle > em.repeat) inCycle = em.repeat;   // restSec 구간(볼리 없음)에 걸린 잔여
  return cyc * em.repeat + inCycle;
}

/**
 * §8.5 straight/fan/aimed 의 공용 발사기 — baseAngle 기준으로 count 발을 총폭 spreadDeg 로 편다.
 *   각은 **아래(+y)** 축에서 잰다: vx = sin(a)·speed, vy = cos(a)·speed → a=0 이면 직하강.
 *   count==1 이면 편차 0(정면). fan 은 baseAngle=0(아래) + spreadDeg=arcDeg 로 이 함수를 쓴다.
 */
function fireSpread(world, e, em, count, spreadDeg, baseAngle) {
  for (let i = 0; i < count; i += 1) {
    const off = count > 1 ? (i / (count - 1) - 0.5) * spreadDeg : 0;
    const a = baseAngle + off * DEG2RAD;
    spawnEnemyBullet(world, em.bulletId, e.x, e.y, Math.sin(a) * em.speed, Math.cos(a) * em.speed, srcArchOf(e));
  }
}

/**
 * §8.5 aimed — 플레이어를 leadSec 만큼 앞질러 조준한 뒤 spreadDeg 로 편다. (v1.10 ㊲: 잔광(ghostSec) 조준 제외 폐지)
 */
function fireAimed(world, e, em, p, count) {
  const dx = (p.x + p.vx * em.leadSec) - e.x;
  const dy = (p.y + p.vy * em.leadSec) - e.y;
  fireSpread(world, e, em, count, em.spreadDeg, Math.atan2(dx, dy));   // atan2(dx,dy): +y 축 기준각
}

/** §8.5 ring — count 발을 360° 등분, rotOffsetDeg 만큼 회전. base(아래)는 전원(全圓)이라 무의미. */
function fireRing(world, e, em, count) {
  for (let i = 0; i < count; i += 1) {
    const a = em.rotOffsetDeg * DEG2RAD + (i / count) * TAU;
    spawnEnemyBullet(world, em.bulletId, e.x, e.y, Math.sin(a) * em.speed, Math.cos(a) * em.speed, srcArchOf(e));
  }
}

/**
 * §8.5 spiral — 원래는 durationSec 동안 rateSec 간격으로 rotStepDeg 씩 돌며 뿌리는 시간 확장 패턴이다.
 * ★ 슬라이스 근사: 한 볼리를 rotStepDeg 간격의 count 발로 놓고, 볼리마다 rotStepDeg 만큼 시작각을
 *   돌린다(회전감 보존). 시간 확장(durationSec/rateSec)은 모델링하지 않는다 — 슬라이스 로스터가
 *   spiral 을 쓰지 않으므로 미실행 경로다(보스/시그니처에서 붙을 때 확장).
 */
function fireSpiral(world, e, em, volleyIdx, count) {
  const spin = volleyIdx * em.rotStepDeg * DEG2RAD;
  for (let i = 0; i < count; i += 1) {
    const a = spin + i * em.rotStepDeg * DEG2RAD;
    spawnEnemyBullet(world, em.bulletId, e.x, e.y, Math.sin(a) * em.speed, Math.cos(a) * em.speed, srcArchOf(e));
  }
}

/**
 * §8.5 wall — 아레나를 가로지르는 벽. 가운데에 폭 gapWidthPx 의 안전 통로 «하나»(gapCount)를 비우고
 *   count 개 벽돌을 좌우 두 벽에 **가장자리까지** 균등 배치한다.
 *   ★ 회귀(실측): 예전엔 gapWidthPx 를 안 읽고(틈이 slot 개수에서 창발) 양 끝에 step 폭 여백을 남겨
 *     **벽을 통째로 우회**할 수 있었다(frostCrown·tetrarch 보스가 실제로 쓴다 — «미실행» 주석은 낡음).
 */
function fireWall(world, e, em, count) {
  const a = world.data.rules.view.arena;
  const cx = a.x + a.w * 0.5;
  const half = em.gapWidthPx * 0.5;              // 고정 중앙 통로 반폭
  const sideW = a.w * 0.5 - half;                // 한쪽 벽이 덮는 폭 [가장자리 … 통로]
  const leftN = Math.ceil(count * 0.5);          // 홀수면 왼쪽에 하나 더(결정적)
  const rightN = count - leftN;
  for (let j = 0; j < leftN; j += 1) {           // 왼쪽 벽: [a.x, cx-half] 균등, 각 칸 중앙
    const x = a.x + (j + 0.5) * (sideW / leftN);
    spawnEnemyBullet(world, em.bulletId, x, e.y, 0, em.speed, srcArchOf(e));
  }
  for (let j = 0; j < rightN; j += 1) {          // 오른쪽 벽: [cx+half, a.x+a.w] 균등
    const x = cx + half + (j + 0.5) * (sideW / rightN);
    spawnEnemyBullet(world, em.bulletId, x, e.y, 0, em.speed, srcArchOf(e));
  }
}

/**
 * §8.5 zone — 개체 위치에 원형 장판. 피해는 적용 1회(dmg)이며 i-frame 이 게이트한다(step.hazards).
 *   텔레그래프 리드는 스케줄(scheduledVolleys 의 telegraphSec)이 이미 소비했으므로 여기선 **즉시 활성**.
 */
function fireZone(world, e, em) {
  spawnZone(world, e.x, e.y, em.radius, em.dmg, em.activeSec, false, srcArchOf(e));
}

/**
 * §8.5 mortar — «폭탄»(v1.5): 플레이어 예측 위치로 던져 fuseSec 뒤 터진다(반경 radius·dmg).
 *   착탄점에 warnSec=fuseSec 장판을 놓는다 → 퓨즈 동안 예고(무해)만, 그 뒤 activeSec 폭발(hazards 소유).
 *   예측 = 현재 위치 + 속도×leadSec (제자리면 발밑, 이동 중이면 진행 앞) → 방향을 바꿔야 피한다.
 *   착탄점은 아레나 안으로 클램프. zone 과 달리 «개체 자리»가 아니라 «표적 자리»에 놓인다.
 */
function fireMortar(world, e, em, p) {
  const a = world.data.rules.view.arena;
  let tx = p.x + p.vx * em.leadSec;
  let ty = p.y + p.vy * em.leadSec;
  if (tx < a.x) tx = a.x; else if (tx > a.x + a.w) tx = a.x + a.w;
  if (ty < a.y) ty = a.y; else if (ty > a.y + a.h) ty = a.y + a.h;
  spawnZone(world, tx, ty, em.radius, em.dmg, em.activeSec, false, srcArchOf(e), em.fuseSec);
}

/**
 * §8.5 · §7.4 laser — 개체에서 뻗는 폭 widthPx 의 빔. angleDeg 는 화면 표준(0=+x, 90=+y 아래).
 *   ★ 2단(§7.4 「충전이 곧 텔레그래프」): telegraphSec 동안 **충전(경고·무해)** — 이때 그려지는
 *     점선/보간이 예고다 — 뒤에 activeSec 동안 **활성(피해)**. trackDuringCharge 면 충전 중 플레이어를
 *     따라 조준하다가 활성 진입 시 각이 잠긴다(hazards 소관). 이 2단이 없으면 빔이 예고 없이 즉발해
 *     사람도 봇도 피할 수 없다(실측된 공정성 결함).
 *   피해는 bulletId 가 가리키는 탄 정의의 dmg.
 */
function fireLaser(world, e, em, p, look) {
  let a = em.angleDeg * DEG2RAD;
  if (em.trackDuringCharge) a = Math.atan2(p.y - e.y, p.x - e.x);
  const bul = look.bulletById[em.bulletId];
  if (bul === undefined) throw new Error(`emitters: laser "${em.id}" 의 미지 탄 "${em.bulletId}" (§9.7)`);
  spawnBeam(world, e.x, e.y, a, em.widthPx, bul.dmg, em.activeSec, e.idx, srcArchOf(e),
    em.telegraphSec, em.trackDuringCharge === true);
}

// §8.5(v1.5) 소사 레이저 — 활성 구간 동안 각이 angleStartDeg→angleEndDeg 로 «회전»(아레나를 쓸고 지나간다).
//   보스 시그니처. 충전(경고)엔 시작각 고정선을 보여주고, 활성엔 그 각이 끝각까지 스윕한다(플레이어는 앞서 달려 피함).
function fireSweep(world, e, em, look) {
  const aStart = em.angleStartDeg * DEG2RAD;
  const aEnd = em.angleEndDeg * DEG2RAD;
  const bul = look.bulletById[em.bulletId];
  if (bul === undefined) throw new Error(`emitters: sweep "${em.id}" 의 미지 탄 "${em.bulletId}" (§9.7)`);
  spawnBeam(world, e.x, e.y, aStart, em.widthPx, bul.dmg, em.activeSec, e.idx, srcArchOf(e),
    em.telegraphSec, false, aEnd);            // track=false · aEnd = 소사 끝각
}

/**
 * §8.18(v1.7) 잡몹 사격 강도의 스테이지 곡선. 1 미만이면 이미터 시간이 느리게 흘러 발사가 뜸해진다.
 *   런이 없는 슬라이스 월드(테스트)에서는 1 — 곡선은 런의 진행이 있어야 의미가 있다.
 */
function mobFireScale(world) {
  if (world.run === undefined || world.run.stageIndex === undefined) return 1;
  return world.data.stages.curve.mobFireRateScale[world.run.stageIndex];
}

/** 한 볼리를 타입대로 발사한다(§8.5 어휘 8종 전부). */
// §17 — 보스 발사체 밀도는 스테이지가 갈수록 는다(bossBulletScale). 잡몹·중간보스는 1(불변).
//   발사 시점 count 만 곱한다(이미터 데이터·66슬롯 명명법 불변). laser·zone 은 count 가 없어 제외.
function effCount(world, e, em) {
  if (!e.isBoss) return em.count;
  const mul = world.data.stages.curve.bossBulletScale[world.run.stageIndex];
  return Math.round(em.count * mul);
}

/**
 * §2.7 — 스턴 게이팅. 난이도 < stunMinDifficulty 이면 스턴 탄(bullets[].status == "stun")을 쏘는 이미터는 «발사 시점»에 침묵한다.
 *   치환 없음 · 텔레그래프 없음 · rng 무소비(§2.7 표). 묻는 자리는 모든 볼리가 반드시 지나는 fireVolley 다 —
 *   보스 부위·코어·중간보스·잡몹 네 갈래가 전부 거기로 모이므로 한 곳이면 된다(콘텐츠는 난이도를 모른다).
 *   ★ v1.10 ㊿-q 전까지 이 판정이 없었다 → 노멀에서도 서리왕관·늪 보스 페이즈 3 이 스턴 탄을 쐈다.
 *   난이도 판정은 difficultyId 가 바뀔 때만 다시 한다(런 중엔 안 바뀐다, §6.1) → 볼리당 조회 1회 · 0 alloc.
 */
function stunSilenced(world, look, em) {
  const bul = look.bulletById[em.bulletId];
  if (bul === undefined || bul.status !== 'stun') return false;
  if (look.stunDiffId !== world.difficultyId) {
    look.stunDiffId = world.difficultyId;
    look.stunAllowed = difficultyAllowsStun(world);
  }
  return !look.stunAllowed;
}

function fireVolley(world, e, em, volleyIdx, p, look) {
  if (stunSilenced(world, look, em)) return;        // §2.7 — 발사 «전에» 묻는다(S60 ⑨). 볼리는 버리고 시계는 흐른다
  const t = em.type;
  const count = effCount(world, e, em);
  if (t === 'straight') fireSpread(world, e, em, count, em.spreadDeg, 0);
  else if (t === 'fan') fireSpread(world, e, em, count, em.arcDeg, 0);
  else if (t === 'aimed') fireAimed(world, e, em, p, count);
  else if (t === 'ring') fireRing(world, e, em, count);
  else if (t === 'spiral') fireSpiral(world, e, em, volleyIdx, count);
  else if (t === 'wall') fireWall(world, e, em, count);
  else if (t === 'zone') fireZone(world, e, em);
  else if (t === 'mortar') fireMortar(world, e, em, p);
  else if (t === 'laser') fireLaser(world, e, em, p, look);
  else if (t === 'sweep') fireSweep(world, e, em, look);
  else throw new Error(`emitters: 미지의 이미터 타입 "${t}" (${em.id}, §8.5 — 폴백 금지)`);
}

/**
 * ★ 훅 진입점 — step.js 가 매 고정 틱 부른다(hooks.emitters 로 주입).
 *   각 alive 적의 attack(archetype)을 읽어 firstDelaySec·telegraphSec 리드 뒤 emitter 케이던스대로
 *   탄을 쏜다. 이동·충돌·i-frame·상태이상은 step 소관 — 이 훅은 **발사만** 한다.
 */
export function emitters(world, dt) {
  //   §11.3(v1.10 ㊿-z6) 난이도가 적의 «발사 주기»를 당긴다 — 문은 하나이고 여기서 한 번만 연다.
  //   보스 격화(run.bossFireRateMul)와 같은 자리(이미터 시계)에 곱한다: 악절의 모양은 그대로, 빠르기만 바뀐다.
  const fireMul = difficultyFireRateMul(world);
  const look = ensureLookup(world);
  const items = world.enemies.items;
  const p = world.player;
  for (let i = 0; i < items.length; i += 1) {
    const e = items[i];
    if (!e.alive) continue;
    if (e.stunSec > 0) continue;                    // 스턴 = 개체 정지(step.moveBullets 와 대칭). 나이도 얼린다
    // §2.7(v1.7) 행동 감속 — 노바의 동사. 스턴처럼 멈추지는 않고 «발사 주기»만 늘린다.
    //   emitT 가 느리게 흐르므로 scheduledVolleys 가 보는 시간이 늦어진다 = 발사가 뜸해진다.
    //   ★ 이동(slowSec)과 갈라 둔 이유: 제자리에서 쏘는 anchor 3종에게 이동 감속은 무효다.
    // §9.5(㊿-p) 구역 감속 — 펄스필드 반경 안이면 발사 주기도 같은 배율로 늦어진다(사용자 2026-09-09:
    //   「해당 구역 안에 든 기체는 발사속도도 느려지게 되고, 탄도 느려지고」). 상태이상과 «곱»으로 겹친다.
    const actMul = (e.actionSlowSec > 0 ? world.data.rules.status.actionSlowMul : 1) * e.fieldSlowMul;
    // §8.18(v1.7) 잡몹 사격 «강도»의 스테이지 곡선. v1.6 까지 잡몹의 발사 주기와 탄 피해는
    //   전 스테이지 동일했다 — 스테이지 1 의 적이 스테이지 6 의 적과 «똑같이» 쏘았다.
    //   체력·밀도만 오르고 사격은 안 올랐으므로 초반이 상대적으로 과하고 후반이 싱거웠다.
    //   ★ 보스·중간보스는 제외 — 보스는 bossBulletScale + escalateFireRateMul 로 자기 곡선을
    //     이미 갖고, 중간보스는 정본이 값으로 확정한 별개 압박 장치다(§8.9).
    const stageMul = (e.isBoss || e.midBossId !== '') ? 1 : mobFireScale(world);

    // §8.9-R8 — 중간보스는 **이미터 1~2개**를 동시에 돌린다(offsetSec 교대 → 동시 텔레그래프 1개가
    //   정적으로 증명된다). 그래서 스케줄 상태가 둘이다: (emitT, emitPhase) · (emitT2, emitPhase2).
    if (e.midBossId !== '') {
      const mb = look.bossById[e.midBossId];
      if (mb === undefined) throw new Error(`emitters: 미지의 중간보스 "${e.midBossId}" (§8.9)`);
      const ids = mb.patternSet[0].emitterIds;              // 중간보스 phases = 1개
      const emA = look.emitById[ids[0]];
      if (emA === undefined) throw new Error(`emitters: 미지의 중간보스 이미터 "${ids[0]}" (§8.9)`);
      e.emitT += dt * actMul * fireMul;
      e.attackType = emA.type;                 // §7.6(v1.7) 중간보스도 같은 어휘
      const wantA = scheduledVolleys(e.emitT, emA, 0);
      while (e.emitPhase < wantA) {
        fireVolley(world, e, emA, e.emitPhase, p, look); e.emitPhase += 1;
        e.attackType = emA.type;               // ★ v1.8 — 방금 쏜 이미터를 싣는다(아래 B 와 대칭)
      }
      if (ids.length > 1) {
        const emB = look.emitById[ids[1]];
        if (emB === undefined) throw new Error(`emitters: 미지의 중간보스 이미터 "${ids[1]}" (§8.9)`);
        e.emitT2 += dt * actMul * fireMul;
        const wantB = scheduledVolleys(e.emitT2, emB, 0);
        while (e.emitPhase2 < wantB) {
          fireVolley(world, e, emB, e.emitPhase2, p, look); e.emitPhase2 += 1;
          // ★ v1.8 결함 수정 — 기호가 emitterIds[0] 에 얼어붙어 mbHammer 가 폭탄을 던지는 내내
          //   «부채»라고 거짓말했다. 방금 쏜 이미터를 싣는다(렌더 전용 필드 = 시뮬 불변).
          e.attackType = emB.type;
        }
      }
      continue;
    }

    let em;
    let firstDelay;
    if (e.isBoss) {
      // ★ 강림(BOSS_INTRO)·페이즈 전환 중엔 발사 정지 = 진짜 «숨돌릴 틈». emitT 도 안 올린다(백로그 방지).
      if (world.run !== undefined && world.run.bossTransitionT > 0) continue;
      if (e.isCore) {
        // §9.8.1(v1.5) — 코어(무속성 중앙)도 발사한다: 회피가능한 원거리 압박(rules.boss.coreEmitterId).
        //   어느 거리에서도 닿아 «원거리 치즈»를 막고 가운데가 살아난다. 배치는 언제나 = 메트로놈.
        em = look.emitById[world.data.rules.boss.coreEmitterId];
        if (em === undefined) throw new Error(`emitters: 미지의 코어 이미터 "${world.data.rules.boss.coreEmitterId}" (§9.8.1)`);
        firstDelay = 0;
      } else {
        // §9.8.1 — 보스 파트가 patternSet 이미터로 발사한다.
        const emId = bossPartEmitterId(look, e);
        if (emId === null) continue;                // 이 페이즈 이미터 없음
        em = look.emitById[emId];
        if (em === undefined) throw new Error(`emitters: 미지의 보스 이미터 "${emId}" (${e.bossId}/${e.partId}, §9.8)`);
        firstDelay = 0;                             // 보스는 등장 연출 뒤 스폰 → 즉시 악절 시작
      }
    } else {
      const def = look.archById[e.archetypeId];
      if (def === undefined || def.attack === null) continue;   // 사격 안 함 = attack: null (§8.5)
      em = look.emitById[def.attack.emitterId];
      if (em === undefined) throw new Error(`emitters: 미지의 이미터 "${def.attack.emitterId}" (${e.archetypeId}, §9.7 — 폴백 금지)`);
      firstDelay = def.attack.firstDelaySec;
    }

    // §8.12(v1.5) — 보스는 모듈이 부서질수록 «격화»한다(발사 빨라짐). run.bossFireRateMul(부위 파괴 시 상승).
    // §7.6(v1.7) 공격 기호 — 해석된 이미터의 타입을 개체에 실어 렌더가 읽게 한다.
    //   여기가 «항상 현재»인 유일한 자리다: 보스 부위는 페이즈마다 이미터가 바뀐다(§9.8.1).
    e.attackType = em.type;
    const edt = ((e.isBoss && world.run !== undefined) ? dt * world.run.bossFireRateMul : dt) * actMul * stageMul;
    e.emitT += edt * fireMul;   // ㊿-z6 — 배율은 «시계를 전진시키는 줄»에 둔다(세 곳이 같은 모양이어야 게이트가 샌 곳을 본다)
    const want = scheduledVolleys(e.emitT, em, firstDelay);
    while (e.emitPhase < want) {                     // 결정적 캐치업(보통 0~1회)
      fireVolley(world, e, em, e.emitPhase, p, look);
      e.emitPhase += 1;
    }
  }
}
