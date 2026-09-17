/**
 * src/core/state.js
 *
 * 정본 v1.4 구현 절:
 *   §1.1   좌표 — 논리 1280×720 · arena {350,0,580,720} · playerBoundsInset {56,56,20,20}
 *   §2.1   체력 · 방어  §2.3 히트박스  §2.4 i-frame  §2.6 런 시작 상태  §2.7 상태이상
 *   §4.2   투자 (fire/water/grass)   §4.3 부여
 *   §9.5   무기 슬롯 = 패밀리 계약. levels[] 부분 오버라이드 누적 (§9.3의 유일한 예외)
 *   §9.6   패시브 훅 1:1 — 가산 풀 (v1.5: 패시브 11 · 훅 10)
 *   §9.6.1 passiveHooks — src = base ∪ (evolved ? evolution.params : {}) + H1~H4
 *   §10.2  RNG 8 스트림 주입   §10.3 L2 유지 규칙 — 사전할당 풀 + alive 플래그,
 *                              인덱스 오름차순 순회만, **core 내 객체 생성 금지(핫패스 0 bytes/tick)**
 *   §12.1  2층 캡 — 풀 크기 = rules.caps (B층 안전망)
 *   §9.1   core 순수성
 *
 * ★ 모든 풀은 여기서 **한 번** 할당된다. step() 은 아무것도 new 하지 않는다.
 * ★ 마스터 시드와 무기 모듈 레지스트리는 **주입**된다 — core 는 시계도 파일도 모른다.
 */

import { makeStreams } from './rng.js';
import { WEAPON_MAX_LEVEL, WEAPON_EVOLVE_LEVEL } from './schema.mjs';
import { recomputeStamps, NORMAL } from './stance.js';
import { makeScore } from './score.js';

// ---------------------------------------------------------------------------
// 사전할당 풀 (§10.3)
// ---------------------------------------------------------------------------
/**
 * alive 플래그 + free 스택. 순회는 언제나 인덱스 오름차순이며,
 * alloc/release 는 호출 순서만의 함수다 → 결정적.
 */
function makePool(size, factory) {
  const items = new Array(size);
  const free = new Int32Array(size);
  for (let i = 0; i < size; i += 1) {
    const it = factory(i);
    it.alive = false;
    it.idx = i;
    it.gen = 0;
    items[i] = it;
    free[i] = size - 1 - i;      // pop 순서가 0, 1, 2 … 가 되도록
  }
  return {
    items,
    size,
    freeTop: size,
    live: 0,
    /** 여유가 없으면 null — 초과 정책(§12.1)은 호출자가 소유한다 */
    alloc() {
      if (this.freeTop === 0) return null;
      this.freeTop -= 1;
      const it = this.items[free[this.freeTop]];
      it.alive = true;
      it.gen += 1;
      this.live += 1;
      return it;
    },
    release(it) {
      if (!it.alive) return;
      it.alive = false;
      this.freeTop += 1;
      free[this.freeTop - 1] = it.idx;
      this.live -= 1;
    },
  };
}

// ---------------------------------------------------------------------------
// 엔티티 팩토리 — 필드는 여기서 전부 만들어진다 (히든 클래스 고정 + 0 alloc/tick)
// ---------------------------------------------------------------------------
function makeEnemy(slotCount) {
  return {
    alive: false, idx: 0, gen: 0,
    // §8.17(v1.7) 적 개성 — 전부 «데미지 항»이 아니라 «판정 게이트»다(§3.1 구조 동결 불가침).
    //   hitFloorSec : 같은 무기 슬롯이 이 개체를 다시 때리기까지의 최소 간격. 0 = 하한 없음.
    //     ★ 기록의 거처가 «적»이어야 한다 — 탄이 들고 있는 hitAt 은 «탄 하나»의 기록이라
    //       팬아웃(다발)·드론(다기)·오빗(다체)처럼 탄을 여러 개 내는 무기가 하한을 통째로 우회한다.
    //   pierceCost  : 이 개체를 뚫는 데 드는 관통 수. 무한 관통(-1)에는 영향 없다.
    //   ccImmune    : 감속·행동감속을 무시한다.
    hitFloorSec: 0, pierceCost: 1, ccImmune: false,
    floorAt: new Float64Array(slotCount),
    // §2.7(v1.7) 행동 감속 — 노바의 동사. 이동(slowSec)이 아니라 «발사 주기»를 늘린다.
    //   제자리에서 쏘는 anchor 3종에게 이동 감속은 무효이므로, 그들에게 듣는 유일한 비-스턴 제어다.
    actionSlowSec: 0,
    // §9.5(v1.10 ㊿-p) 펄스필드의 «구역 감속» — 이번 틱의 배율(1 = 없음). 탄의 b.slowMul 과 같은 규약:
    //   aura.update(무기 발사 단계)가 세우고, emitters(발사 주기)와 moveBullets(이동)가 읽고, moveBullets 가 1 로 되돌린다.
    //   ★ 상태이상(slowSec·actionSlowSec)과 «다른 축»이다: 그쪽은 «타이머 + 전역 고정 강도»고, 이쪽은 «구역 + 무기 레벨 강도»다.
    fieldSlowMul: 1,
    archetypeId: '', band: '', element: NORMAL,
    // ★ 개체가 자기 글리프를 들고 다닌다 — 보스 개체는 archetypes 에 없어서(archetypeId '')
    //   렌더가 아키타입으로 모양을 찾을 수 없다. 프레임당 스캔도 사라진다(§10.3).
    shapeId: '',
    // §7.6(v1.7) 공격 기호 — 이 개체가 «무엇을 하는가»를 모양과 별개로 들고 다닌다.
    //   shapeId(종족)만으로는 예측이 안 됐다: 같은 hexPod 이 aimed 와 spiral 을 쓰고,
    //   straight 는 네 가지 모양으로 나왔다(플레이 피드백). '' = 사격하지 않음.
    attackType: '',
    x: 0, y: 0, vx: 0, vy: 0,
    hp: 0, hpMax: 0, radius: 0,
    contactDmg: 0, xp: 0, score: 0,
    elite: false, ghost: false,
    // §8.19.1(v1.9) 도입 구간의 «무해한 몸» 표식 — A층 «위협» 예산(enemyConcurrentMax)에서
    //   빠지고 자기 몫(introConcurrentMax)을 쓴다. v1.8 이 유령에게 준 것과 같은 처방(§12.1).
    introBody: false,
    // §8.7(v1.10 ㉕) 옆벽 클램프 표식 — 잡몹은 아레나 옆벽 안(x ∈ [a.x + r, a.x + a.w − r])에만 있다. 스포너가 켠다
    //   (strafe 는 벽 밖에서 들어오므로 false). 보스·중간보스는 자기 이동이 좌표를 소유한다(false).
    wallX: false,
    // §9.5(v1.10 ㉟) 체인·빔 «이 볼리에서 이미 맞았다» 표식 — world.chainEpoch 와 같으면 제외(배열 초기화 없이 0 alloc)
    chainEpoch: 0,
    // §3.1-4항 — 잡몹은 코어가 아니다. 보스 코어가 이 풀을 쓰게 되면 여기서 켠다
    isCore: false,
    // §8.11 — 복합 보스는 이 풀을 공유한다. isBoss = 코어·파트 공통 표식(이동/이탈/처치 분기).
    //   partId = 부위 식별(patternSet 이미터 조회). phase = 보스 페이즈 인덱스(patternSet 선택, B2b).
    isBoss: false, bossId: '', partId: '', partType: '', anchorX: 0, anchorY: 0, phase: 0,
    // §8.11(v1.5) 레이어 봉인 — 낮은 sealLayer 파트가 살아있으면 이 파트는 무적. sealedNow = 보스훅이 매틱 계산.
    sealLayer: 0, sealedNow: false,
    // §8.9 — 중간보스는 «단일 몸체·부위 없음»이라 isBoss 를 켜지 않는다(보스 처치/타이머/무적 규칙과
    //   무관해야 한다). 대신 이 표식 하나로 이동·이탈·소환·보상이 갈린다. '' = 중간보스 아님.
    midBossId: '',
    // §8.9-R8 — 중간보스만 **이미터 2개**(emitterIds 길이 1~2)를 동시에 돌린다. 두 악절은 서로 다른
    //   offsetSec 로 교대하므로 스케줄 상태도 **둘**이어야 한다(보스 부위·잡몹은 2번을 안 쓴다).
    emitT2: 0, emitPhase2: 0,
    // §8.9-R9 — mbNest 의 잡몹 소환 케이던스(everySec).
    summonT: 0,
    // §11.3 attribution "damageShare" — 초효과 처치 보너스는 막타가 아니라 **누적 피해 지분**이다
    dmgTotal: 0, dmgSuper: 0,
    // §2.7 — 상태이상은 플레이어 전용이지만 구조는 대칭으로 둔다 (오라 진화의 끌어당김 등)
    slowSec: 0, stunSec: 0,
    // 이미터 스케줄 (emitters.js 소관 — 자리만 예약)
    emitT: 0, emitPhase: 0,
    moveT: 0, mp0: 0, mp1: 0, mp2: 0,
  };
}

function makePlayerBullet(capEnemies) {
  return {
    alive: false, idx: 0, gen: 0,
    slot: 0, family: '',
    x: 0, y: 0, vx: 0, vy: 0,
    dmg: 0, localMul: 1, radius: 0,
    element: NORMAL, stampMode: 'spawn',
    pierceLeft: 0, hitCooldownSec: 0,
    age: 0, lifetimeSec: 0,
    // §9.5 — 관통·재히트의 정확한 표현. 적 슬롯별 마지막 히트 시각.
    //   hitEpoch 로 세대를 구분하므로 스폰 때 배열을 지울 필요가 없다 (0 alloc/tick).
    hitEpoch: 0,
    hitStamp: new Int32Array(capEnemies),
    hitAt: new Float64Array(capEnemies),
    // ★ hitGen — 적 슬롯이 풀 재사용(release → 새 적 alloc, gen++)되면 같은 idx 라도
    //   다른 개체다. 관통탄의 재히트 가드가 (hitStamp==hitEpoch && hitGen==e.gen)여야
    //   재사용된 슬롯의 새 적을 조용히 통과하지 않는다 (seeker.targetGen 방어와 대칭).
    hitGen: new Int32Array(capEnemies),
    // 패밀리별 스크래치 (부메랑 왕복 · 시커 타겟 등). s2gen = s2(직전 경유 적)의 gen — 슬롯 재사용 판별.
    s0: 0, s1: 0, s2: 0, s2gen: -1, target: -1, targetGen: -1,
      // §9.6(v1.7) 벽 반사 — 남은 반사 횟수. 0 = 반사 없음(현행). -1 = 무제한.
      bounceLeft: 0,
  };
}

function makeEnemyBullet() {
  return {
    alive: false, idx: 0, gen: 0,
    bulletId: '',
    // §13.1.1 maxArchetypeLethalityShare — 「누가 쐈는가」. 잡몹 = 아키타입 id · 보스 = 'boss' · 중간보스 = 'mb…'(emitters.srcArchOf).
    //   sim 은 'boss'·'mb…'·'' 를 분모에서 뺀다. ★ ㊿-r — 보스·중간보스 귀속은 '' 가 아니다(그래서 피해 곡선을 탄다). '' = 테스트·도구가 직접 만든 탄
    srcArch: '',
    x: 0, y: 0, vx: 0, vy: 0,
    dmg: 0, radius: 0, hitRadius: 0,
    // §4.1 — 적 탄에 element 가 없다. 스키마가 이미 그것을 강제한다 (§9.7)
    status: null, statusDurationSec: 0,
      // §9.7(v1.7) 유도 지속시간(초). age 가 이걸 넘으면 유도를 멈추고 직진한다.
      //   ★ 없으면 유도는 maxBulletAgeSec(12초) 내내 계속된다 — 「어느 방향으로 달리는가」가
      //     답이 되지 못해 «회피 불가»가 구조적으로 생긴다(실측: 유도탄이 「길 0개」의 주범).
      //     따라오되 «따돌릴 수 있어야» 한다. 0 = 무제한(v1.6 동작).
      homingSec: 0,
      // §8.5(v1.7) 벽 반사 — 남은 반사 횟수. 0 = 반사 없음. -1 = 무제한.
      //   ★ 무제한이면 위치가 «삼각파 접기»의 닫힌 형태라 봇이 정확히 외삽할 수 있다(bot.js).
      bounceLeft: 0,
    accel: 0, turnRateDegSec: 0, retargetSec: 0, retargetT: 0,
    // §9.7(v1.5) 파동탄 — 진행 방향 수직으로 사인 진동(경로가 물결친다). waveAmp=0 이면 직진.
    waveAmp: 0, waveHz: 0,
    slowMul: 1,   // §9.5(v1.5) 펄스필드 슬로우/정지 — 이동 배율(펄스필드가 매 틱 세팅, moveBullets 가 적용 후 1로 리셋)
    age: 0,
  };
}

/** §11.6(v1.10 ㉒) — 특성 효과의 평면 표현. 0 = «없음». 핫패스(step·damage)는 이것만 읽는다(문자열 비교 0). */
function makeTraitFx() {
  return { regenHpPerSec: 0, lifestealPct: 0, lifestealHpRatio: 0, shieldEverySec: 0 };   // lifestealHpRatio: 이 비율 이하일 때만(㉗)
}

/** §11.6 — 보유 레벨 표 {id: 0..maxLevel}. 0 = 없음. 키 집합은 데이터가 정한다(특성이 늘면 여기가 따라온다). */
function makeTraitLevels(data) {
  const lv = {};
  const defs = data.traits.traits;
  for (let i = 0; i < defs.length; i += 1) lv[defs[i].id] = 0;
  return lv;
}

/** §11.6 — 보유 레벨로 traitFx 를 다시 만든다(결정적). 값은 «그 레벨의 절대값»(values[lv-1]). 미지의 kind 는 폴백 없이 던진다(§9.3). */
function recomputeTraitFx(world) {
  const fx = world.traitFx;
  const base = makeTraitFx();
  for (const k of Object.keys(base)) fx[k] = base[k];
  const defs = world.data.traits.traits;
  for (let i = 0; i < defs.length; i += 1) {
    const def = defs[i];
    const lv = world.traits[def.id];
    if (lv === undefined) throw new Error(`state: 특성 레벨 표에 "${def.id}" 가 없다 (§11.6)`);
    if (lv <= 0) continue;
    const v = def.effect.values[lv - 1];
    switch (def.effect.kind) {
      case 'regenHpPerSec': fx.regenHpPerSec = v; break;
      case 'lifestealPct': fx.lifestealPct = v; fx.lifestealHpRatio = def.effect.hpRatio; break;
      case 'shieldEverySec': fx.shieldEverySec = v; break;
      default: throw new Error(`state: 미지의 특성 효과 "${def.effect.kind}" (§11.6)`);
    }
  }
  return fx;
}

/**
 * §11.6(v1.10 ㉒) — 특성 한 레벨 획득. 사용자(2026-09-05): 「딱 3개 — 자연 재생·흡혈·쉴드 생성 — 중에서 선택하게 하고,
 *   선택하면 쿨타임이 줄거나 회복 폭이 늘어나는 방식」. maxLevel(= 한 런의 구슬 수)이면 false. 미지의 id 는 던진다.
 */
export function applyTrait(world, traitId) {
  const lv = world.traits[traitId];
  if (lv === undefined) throw new Error(`state: 미지의 특성 "${traitId}" (§11.6)`);
  if (lv >= world.data.traits.maxLevel) return false;
  world.traits[traitId] = lv + 1;
  recomputeTraitFx(world);
  return true;
}

function makePickup() {
  return { alive: false, idx: 0, gen: 0, kind: '', value: 0, x: 0, y: 0, vx: 0, vy: 0, magnet: false };
}

function makeZone() {
  // §13.1.1 srcArch — 「누가 깔았는가」(치사 지분). 플레이어 기뢰·출처불명은 '' (분모에서 제외).
  return { alive: false, idx: 0, gen: 0, x: 0, y: 0, radius: 0, dmg: 0, activeSec: 0, warnSec: 0, age: 0, fromPlayer: false, srcArch: '' };
}

function makeTerrain() {
  // §8.21 — 지형 장판. kind = TERRAIN_KINDS 인덱스(0 slow · 1 inertia · 2 heat). 위에서 아래로 흘러 내려간다(scrollSpeedPx).
  return { alive: false, idx: 0, gen: 0, x: 0, y: 0, radius: 0, kind: 0, fadeT: -1 };   // fadeT ≥ 0 = 사라지는 중(효과 없음)
}

function makeDrone() {
  // §9.5 — family 로 식별한다. ~~슬롯 재정렬(swapSlots)~~ 은 ㊿-ze6 에서 폐지됐지만 규칙은 남는다:
  //   슬롯이 «가리키는 무기»는 재정렬 말고도 바뀐다(튜토리얼 resetLoadout 이 슬롯을 비우고 다시 채운다 —
  //   그 자리가 ㊿-z8 의 «주인 잃은 탄» 결함이었다). orbit/mine 과 같은 규약.
  return { alive: false, idx: 0, gen: 0, family: '', x: 0, y: 0, ox: 0, oy: 0, fireT: 0 };
}

function makeTelegraph() {
  // §8.5 laser — 이 풀이 **활성 빔**도 담는다(새 풀 금지, §12.1 S2: 풀 10 ⟺ 초과정책 10).
  //   kind 'laser': x/y=발사 원점 · a=진행각(rad) · r=widthPx · durSec=충전+활성 총수명 · dmg=피해.
  //   §7.4 — 빔은 2단이다: [0, warnSec) = **충전(경고)**: 무해, track 이면 플레이어를 따라 조준.
  //     [warnSec, durSec) = **활성**: 각이 잠기고 피해. 「충전이 곧 텔레그래프」(§7.4·§8.5).
  //   §13.1.1 srcArch — 「누가 쐈는가」(치사 지분). 플레이어 예고·출처불명은 '' (분모에서 제외).
  return {
    alive: false, idx: 0, gen: 0, kind: '', x: 0, y: 0, r: 0, a: 0,
    // §8.5(v1.5) 소사 레이저 — aStart≠aEnd 이면 활성 구간에 각이 aStart→aEnd 로 회전한다. 같으면 고정 빔.
    aStart: 0, aEnd: 0,
    age: 0, durSec: 0, warnSec: 0, track: false, dmg: 0, owner: -1, srcArch: '',
  };
}

// ---------------------------------------------------------------------------
// §7.7 — 히트 피드백 이벤트 버퍼 (core → render 핸드오프)
//   ★ 순수 장식이다. 판정(hp)·rng·위치 어디에도 되먹임이 없으므로 결정성에 무영향이다.
//     collide 가 히트마다 상성 tier(super/neutral/resist)·위치·공격 속성·처치여부·개체 id 를
//     결정적으로 싣고, main.js 의 updateFx(render)가 **매 스텝 뒤** 소진해 3중 감각 파티클로 옮긴다.
//   ★ 사전할당 링 + count. count 는 step 진입 시 0 으로 리셋한다(world.player.hit 과 같은 「이번 틱」 신호).
//     가득 차면 조용히 버린다 — 장식 손실은 게임을 깨뜨리지 않는다(초과 정책 = 이번 틱 앞쪽 우선).
//   ★ 크기 = caps.particles(총 파티클 예산). 새 키를 만들지 않고 기존 예산을 재사용한다.
// ---------------------------------------------------------------------------
/** §7.4(v1.10 ㉟) 체인·빔 선분 링 — 「이번 틱」 신호(hitFx 와 같은 규약: step 진입 때 count = 0). 크기 = caps.particles 재사용. */
function makeChainFxBuffer(cap) {
  const buf = new Array(cap);
  for (let i = 0; i < cap; i += 1) buf[i] = { x1: 0, y1: 0, x2: 0, y2: 0, element: NORMAL };
  return { buf, count: 0, cap };
}

function makeHitFxBuffer(cap) {
  const buf = new Array(cap);
  for (let i = 0; i < cap; i += 1) {
    buf[i] = { x: 0, y: 0, element: NORMAL, tier: 'neutral', killed: false, enemyIdx: -1, enemyGen: -1 };
  }
  return { buf, count: 0, cap };
}

/**
 * §7.7 — 히트 이벤트 1건을 링에 싣는다. collide 의 유일한 호출처. **순수 장식**(결정성 무영향).
 * @param element  공격에 각인된 속성(= stampFor 의 결과). ×2 버스트의 색이 이것이다.
 * @param tier     'super' | 'neutral' | 'resist' (elements.hitTier).
 * @param killed   이 히트로 적이 죽었는가(처치 FX 를 render 가 확대할 근거 — §7.7 처치 FX 열).
 * @param enemyIdx · enemyGen  개체 식별(render 의 임팩트 프리즈를 그 개체에 묶기 위함 — §7.7 스케일 1.12).
 */
export function pushHitFx(world, x, y, element, tier, killed, enemyIdx, enemyGen) {
  const h = world.hitFx;
  if (h.count >= h.cap) return;
  const ev = h.buf[h.count];
  ev.x = x; ev.y = y; ev.element = element; ev.tier = tier;
  ev.killed = killed; ev.enemyIdx = enemyIdx; ev.enemyGen = enemyGen;
  h.count += 1;
}

// ---------------------------------------------------------------------------
// §9.6 — 패시브 훅(v1.5: 11 패시브 · 10 훅). 각 스탯의 소유자는 정확히 1개 패시브다 (1:1)
// ---------------------------------------------------------------------------
/**
 * §3.1 · §9.6 — 훅의 기본값.
 *   *Mul / *Add : 0 (가산 풀의 항등원. 피해 스탯은 §3.1-2항에서 1 + Σ 가 된다)
 *   elementBonusMul : ★ 1.0 (§3.1 — 이것만 곱의 항등원이다. k 이지 가산항이 아니다)
 */
function makeStats() {
  return {
    // 공용 1 · 탄 4 (§9.6 ㊲ — 탄 무기 패밀리에만 훅이 있다)
    fireRateMul: 0, projCountAdd: 0, pierceAdd: 0, projSpeedMul: 0, durationMul: 0,
    // 빔 2 · 범위 2 · 궤도 1 — 피해 스탯(beamDmgMul·areaDmgMul)은 rules.passiveHooks[family].dmgStat 이 고르고(familyDmgMul),
    //   범위 스탯은 beamKeys(H7)·areaKeys(H2)·orbitKeys(H8)에 곱한다
    beamDmgMul: 0, beamAreaMul: 0, areaMul: 0, areaDmgMul: 0, orbitMul: 0,
    // 기체 4
    maxHpAdd: 0, terrainResist: 0, xpGainMul: 0,          // terrainResist: §8.21 ⑥ 지형 효과 ×(1 − Σ) — 이동 속도 배율은 v1.10 ⑳ 에 폐지
    elementBonusMul: 1,                                    // ★ 곱의 항등원(k), 가산항이 아니다
  };
}

/**
 * §3.1-2항(v1.10 ㊲) — 패밀리의 «피해 패시브» 가산항. dmgStat = 'beamDmgMul'(랜스·빔·체인) · 'areaDmgMul'(노바·바라지·미사일) ·
 *   'orbitMul'(오빗·옵션 — 궤도 확장은 궤도 1종뿐이라 반경·공전과 피해를 같이 든다) · null(탄 무기·펄스필드 = 피해 패시브 없음 → 0).
 *   옛 전무기 공통 dmgMul(탄두 증량)은 폐지됐다.
 */
export function familyDmgMul(world, family) {
  //   ★ ㊿-z7 — 이름 있는 오류로 던진다. 주인 잃은 탄(family === null)이 여기로 들어오면 예전엔
  //   「Cannot read properties of undefined」라는 말만 남아서, 화면이 죽은 «이유»를 화면이 안 알려줬다.
  const h = world.data.rules.passiveHooks[family];
  if (h === undefined) {
    throw new Error(`state: 미지의 무기 패밀리 "${family}" — 슬롯을 비우면서 그 슬롯이 낳은 탄·드론을 안 거뒀다 (§3.1-2항 · §6.7)`);
  }
  return h.dmgStat === null ? 0 : world.stats[h.dmgStat];
}

/**
 * §11.1(v1.10 ㊸) — 이 슬롯의 무기가 그 패시브에서 **실제로 혜택을 받는가**. 사용자(2026-09-06): 「실제 혜택을 받는 무기만 언급해 달라」.
 *   passiveAppliesTo 가 «저작값(base)의 설계 질문」이라면, 이것은 «지금 이 무기의 유효 파라미터(eff)» 질문이다 —
 *   레벨·진화로 키가 생기거나(진화 전용 반경) 관통이 무제한이 되면 답이 달라진다. 화면은 이쪽을 읽는다.
 *   ★ 기체 4(HP·지형·XP·상성)는 무기를 가리지 않으므로 이 질문 자체가 성립하지 않는다 → false(화면은 줄을 아예 안 그린다).
 */
export function passiveAffectsSlot(world, slot, stat) {
  if (slot.weaponId === null) return false;
  const hooks = world.data.rules.passiveHooks[slot.family];
  const eff = recomputeEff(world, slot);
  const has = (k) => k !== null && Object.prototype.hasOwnProperty.call(eff, k);
  const hasAny = (keys) => { for (let i = 0; i < keys.length; i += 1) if (has(keys[i])) return true; return false; };
  switch (stat) {
    case 'fireRateMul': return has(hooks.rateKey);
    case 'projCountAdd': return has(hooks.countKey);
    case 'pierceAdd': return hooks.pierceApplies === true && has('pierce') && eff.pierce !== -1;
    case 'projSpeedMul': return hasAny(hooks.speedKeys);
    case 'durationMul': return hasAny(hooks.durationKeys);
    case 'areaMul': return hasAny(hooks.areaKeys);
    case 'beamAreaMul': return hasAny(hooks.beamKeys);
    case 'orbitMul': return hasAny(hooks.orbitKeys) || hooks.dmgStat === 'orbitMul';
    case 'beamDmgMul': return hooks.dmgStat === 'beamDmgMul';
    case 'areaDmgMul': return hooks.dmgStat === 'areaDmgMul';
    default: return false;
  }
}

/**
 * §11.1(v1.10 ㊲) — 패시브(stat)가 이 패밀리에 «기계적으로 유효»한가. 훅 표(rules.passiveHooks)만 읽는 순수 함수 —
 *   드래프트(미보유 무기 분류 패시브는 유효한 무기가 있어야 나온다)와 check.mjs S41(진화 짝은 유효해야 한다)이 같은 답을 낸다.
 *   기체 4(maxHpAdd·terrainResist·xpGainMul·elementBonusMul)는 무기와 무관하게 항상 유효.
 */
export function passiveAppliesTo(hooks, baseDef, stat) {
  switch (stat) {
    case 'fireRateMul': return hooks.rateKey !== null;
    case 'projCountAdd': return hooks.countKey !== null;
    case 'pierceAdd': return hooks.pierceApplies === true && baseDef.pierce !== -1;
    case 'projSpeedMul': return hooks.speedKeys.length > 0;
    case 'durationMul': return hooks.durationKeys.length > 0;
    case 'beamDmgMul': return hooks.dmgStat === 'beamDmgMul';
    case 'beamAreaMul': return hooks.beamKeys.length > 0;
    case 'areaMul': return hooks.areaKeys.length > 0;
    case 'areaDmgMul': return hooks.dmgStat === 'areaDmgMul';
    case 'orbitMul': return hooks.orbitKeys.length > 0 || hooks.dmgStat === 'orbitMul';
    default: return true;     // 기체 4
  }
}

/** 보유 패시브 → 스탯 캐시. 패시브 변경 시에만 호출한다 */
export function recomputeStats(world) {
  const st = world.stats;
  const fresh = makeStats();
  const keys = Object.keys(fresh);
  for (let i = 0; i < keys.length; i += 1) st[keys[i]] = fresh[keys[i]];
  const list = world.data.passives.passives;
  for (let i = 0; i < world.passives.length; i += 1) {
    const p = world.passives[i];
    if (p.id === null) continue;
    let def = null;
    for (let j = 0; j < list.length; j += 1) if (list[j].id === p.id) { def = list[j]; break; }
    if (def === null) throw new Error(`state: 미지의 패시브 "${p.id}" (§9.6)`);
    const v = def.values[p.level - 1];   // §9.6 — values 는 각 레벨의 **절대 총량**이지 증분이 아니다
    if (def.stat === 'elementBonusMul') st.elementBonusMul = v;   // ★ k 는 대입이지 합산이 아니다
    else st[def.stat] += v;
  }
  // §2.1(v1.4) — maxHpAdd(패시브 bulkhead)가 hpMax 를 직접 바꾸고,
  //   **모든 hpMax 증가는 그 증가분만큼 hp 를 채운다**(단일 규칙 — 델타만 회복).
  const base = world.data.rules.player.hpMax;
  const prevMax = world.player.hpMax;
  world.player.hpMax = base + st.maxHpAdd;
  if (world.player.hpMax > prevMax) world.player.hp += world.player.hpMax - prevMax;
  if (world.player.hp > world.player.hpMax) world.player.hp = world.player.hpMax;
  for (let i = 0; i < world.slots.length; i += 1) world.slots[i].effDirty = true;
}

// ---------------------------------------------------------------------------
// §9.5 · §9.6.1 — 무기 슬롯의 유효 파라미터
// ---------------------------------------------------------------------------
function makeSlot(index) {
  return {
    index,
    weaponId: null, family: null,
    level: 0, evolved: false,
    stampElement: NORMAL,
    cooldownT: 0,
    effDirty: true,
    eff: {},          // 재사용. 매 틱 새로 만들지 않는다
    // 패밀리별 지속 상태 (오빗 각도 · 오버드라이브 램프 · 부메랑 왕복 위상 …)
    a0: 0, a1: 0, a2: 0, a3: 0,
  };
}

/** 훅 키 배열의 «있는 키만» 배율 — H5·H6·H7·H8 공통 (§9.6.1) */
function mulKeys(eff, keys, m) {
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    if (Object.prototype.hasOwnProperty.call(eff, k)) eff[k] = eff[k] * m;
  }
}

/** weapons[].levels[0..level-1] 을 base 에 순서대로 덮는다 (§9.3의 유일한 부분 오버라이드 예외) */
function resolveLevels(def, level, out) {
  const keys = Object.keys(def.base);
  for (let i = 0; i < keys.length; i += 1) out[keys[i]] = def.base[keys[i]];
  for (let L = 0; L < level; L += 1) {
    const row = def.levels[L];
    const rk = Object.keys(row);
    for (let i = 0; i < rk.length; i += 1) out[rk[i]] = row[rk[i]];
  }
  return out;
}

/**
 * ★ §9.6.1 — 슬롯의 유효 파라미터를 계산해 slot.eff 에 **제자리로** 쓴다.
 *
 *   src = resolveLevels(base, level) ∪ (w.evolved ? evolution.params : {})
 *   fireRateMul  : eff[rateKey]  = src[rateKey] / (1 + v)
 *   areaMul      : eff[areaKey]  = src[areaKey] × (1 + v)     // areaKeys 중 src 에 있는 것 전부
 *   pierceAdd    : eff.pierce    = src.pierce + v             // pierceApplies == false 면 무효
 *   projCountAdd : eff[countKey] = src[countKey] + v          // countKey == null 이면 무효 (H4)
 *   H3           : projRadius 는 render.playerBulletMaxRadiusPx 로 클램프 (판정·렌더 동시)
 *
 * ★ §9.6.1(v1.4) 확정 — 여기서 `src` 는 **`resolveLevels(base, level)` 로 레벨 오버라이드가
 *   적용된 유효 파라미터 집합**에 evolution.params 를 합집합한 것이다. 적용 순서 =
 *   resolveLevels → ∪evolution.params → H1~H4. 「인쇄된 base 블록 그대로 읽으면
 *   levels[].pierce·count 가 증발한다」던 문면 결함(예: seeker Lv5 count·pierce)을
 *   정본이 base.* → src.* 로 고쳐 닫았다. 코드(eff = 그 src)는 이미 정합.
 */
export function recomputeEff(world, slot) {
  if (!slot.effDirty) return slot.eff;
  const eff = slot.eff;
  for (const k of Object.keys(eff)) delete eff[k];
  if (slot.weaponId === null) { slot.effDirty = false; return eff; }

  const def = world.weaponDefs[slot.family];
  resolveLevels(def, slot.level, eff);

  // src = base ∪ (evolved ? evolution.params : {})
  if (slot.evolved) {
    const ep = def.evolution.params;
    const ek = Object.keys(ep);
    for (let i = 0; i < ek.length; i += 1) eff[ek[i]] = ep[ek[i]];
  }

  const hooks = world.data.rules.passiveHooks[slot.family];
  const st = world.stats;

  // H1 — fireRateMul 은 10 패밀리 전부에 적용된다. 주기(간격)이므로 나눗셈
  eff[hooks.rateKey] = eff[hooks.rateKey] / (1 + st.fireRateMul);

  // H2 — areaMul 은 "닿는 범위"만. 산포(spreadDeg·jitterDeg·arcDeg)는 areaKeys 에 없다
  for (let i = 0; i < hooks.areaKeys.length; i += 1) {
    const k = hooks.areaKeys[i];
    if (Object.prototype.hasOwnProperty.call(eff, k)) eff[k] = eff[k] * (1 + st.areaMul);
  }

  // H5 (v1.10 ㉟) — projSpeedMul 은 speedKeys(탄속·귀환 속도)에, H6 — durationMul 은 durationKeys(수명)에.
  //   «있는 키만»(areaKeys 와 같은 규약) — 키가 없는 패밀리엔 무효(패시브 desc 가 무효 목록을 말한다, H4 와 같은 원칙).
  // H7 (㊲) — beamAreaMul(집속 렌즈)은 beamKeys(빔 폭·사거리 / 체인 도약 거리·탐지 반경)에, H8 — orbitMul(궤도 확장)은
  //   orbitKeys(궤도 반경·구체·공전 속도 / 옵션 사거리)에. 같은 «있는 키만» 규약.
  mulKeys(eff, hooks.speedKeys, 1 + st.projSpeedMul);
  mulKeys(eff, hooks.durationKeys, 1 + st.durationMul);
  mulKeys(eff, hooks.beamKeys, 1 + st.beamAreaMul);
  mulKeys(eff, hooks.orbitKeys, 1 + st.orbitMul);

  // pierceAdd — pierceApplies == false 면 무효. pierce: -1(무제한)에는 적용되지 않는다
  if (hooks.pierceApplies && eff.pierce !== -1) eff.pierce += st.pierceAdd;

  // H4 — countKey == null 이면 그 패시브는 그 무기에 무효다 (aura · nova · drone)
  if (hooks.countKey !== null) eff[hooks.countKey] += st.projCountAdd;

  // H3 — projRadius 클램프. 판정 반경과 렌더 반경을 **동시에** (I-2)
  const maxR = world.data.rules.render.playerBulletMaxRadiusPx;
  if (Object.prototype.hasOwnProperty.call(eff, 'projRadius') && eff.projRadius > maxR) {
    eff.projRadius = maxR;
  }

  slot.effDirty = false;
  return eff;
}

// ---------------------------------------------------------------------------
// 월드 생성
// ---------------------------------------------------------------------------
/**
 * @param opts.data     schema.validate() 를 통과한 9파일
 * @param opts.seed     uint32 마스터 시드. ★ core 바깥(main.js)에서 생성해 주입한다 (§10.2)
 * @param opts.weapons  { [family]: { update(world, slot, eff, dt, api) } }
 *                      — src/core/weapons/** 의 12 update 함수 레지스트리 (§9.5).
 *                      ★ 주입 이유: 정본 §9.1 은 파일 배치만 확정하고 **합성 계약을 인쇄하지 않았다**.
 *                        주입이면 core 밖 import 0 을 유지하면서 1주차에 2~3개만 꽂을 수 있다.
 * @param opts.hooks    { enemies, emitters } — 각각 (world, dt) 를 받는 함수 또는 null.
 *                      1주차에는 null 이며 step() 은 적의 등속 적분만 한다.
 */
export function createWorld(opts) {
  const data = opts.data;
  const startWeaponId = opts.startWeaponId === undefined ? null : opts.startWeaponId;
  const rules = data.rules;
  const caps = rules.caps;
  const rp = rules.player;

  // §1.1 — 이동 가능 영역 (파생: 540 × 608 @ (370, 56))
  const a = rules.view.arena;
  const ins = rules.view.playerBoundsInset;
  const bounds = {
    minX: a.x + ins.left, maxX: a.x + a.w - ins.right,
    minY: a.y + ins.top, maxY: a.y + a.h - ins.bottom,
  };
  // §1.1(v1.10 ㊿-t) 반사 벽 (파생: 580 × 672 @ (350, 0)) = 아레나 − HP·XP 띠 — 아래는 바닥선(672), 위 · 좌우는 아레나 끝.
  //   사용자(2026-09-12) 「핀볼이 벽에 튕길때, 밑에 있는 HP, 경험치바를 통과?해서 반사되던데?」 — 아레나 끝(y 720)에서 튀었고,
  //   띠는 모든 탄보다 먼저 그려지므로(§1.2 «띠는 레이어 1») 공이 HP·XP 바 «위로» 바를 가로질렀다.
  //   ★ 벽은 화면이 이미 말하는 경계를 따른다 — 하단 띠 = 불투명 판 + 바닥선 = «경기장 밖»(hud.drawArenaBands).
  //     상단 띠는 벽이 아니다: 반투명 판 아래로 적이 날아들고 표적이 되는 «경기장 위의 오버레이»다(막으면 그 적에게 핀볼이 못 닿는다).
  //   탄은 제 반경만큼 안쪽에서 튄다(step.bounceOffWalls). step · 봇의 반사탄 접기 · 계측(tools/lib/escape.mjs)이 이 하나를 쓴다(S65).
  const walls = {
    x: a.x, y: a.y,
    w: a.w, h: a.h - rules.view.bandHpH - rules.view.bandXpH,
  };

  // §4.2 — 투자축은 elements.investable 이 소유한다. 이 파일에 "fire" 를 박지 않는다
  const invest = {};
  for (let i = 0; i < data.elements.investable.length; i += 1) invest[data.elements.investable[i]] = 0;

  // 패밀리 → 정의 (id == family, §9.5)
  const weaponDefs = {};
  for (let i = 0; i < data.weapons.weapons.length; i += 1) {
    const w = data.weapons.weapons[i];
    weaponDefs[w.family] = w;
  }

  const world = {
    data,
    seed: opts.seed >>> 0,
    rng: makeStreams(opts.seed),
    weaponFns: opts.weapons,
    // §9.1 이 파일 배치(enemies.js · emitters.js)만 확정하고 **합성 계약을 인쇄하지 않았다** →
    // 주입으로 둔다. 1주차에는 둘 다 null 이며 step() 은 적의 등속 적분만 한다.
    hooks: {
      enemies: opts.hooks === undefined || opts.hooks.enemies === undefined ? null : opts.hooks.enemies,
      emitters: opts.hooks === undefined || opts.hooks.emitters === undefined ? null : opts.hooks.emitters,
      // §6.5 — 런 디렉터(stage.js)와 보스(boss.js) 훅. 미주입(테스트) 시 null → 전투만 진행.
      run: opts.hooks === undefined || opts.hooks.run === undefined ? null : opts.hooks.run,
      boss: opts.hooks === undefined || opts.hooks.boss === undefined ? null : opts.hooks.boss,
    },
    weaponDefs,
    bounds,
    walls,            // §1.1 ㊿-t 반사 벽(파생) — step.bounceOffWalls · bot 접기 · 계측(escape)이 같은 것을 쓴다

    tick: 0,
    time: 0,          // §0.2 — 게임초. 배속은 core 밖(main.js 의 tickDur)에만 있다

    player: {
      x: (bounds.minX + bounds.maxX) / 2,   // §2.6(v1.4) — 이동 가능 영역 하단 중앙 = (minX+maxX)/2, maxY
      y: bounds.maxY,                       //   bounds 파생(리터럴 아님) → 새 키 없음. 마커 해소됨
      vx: 0, vy: 0,
      hp: rp.hpMax, hpMax: rp.hpMax,
      defense: rp.defenseBase,
      iframeSec: 0,
      stance: rp.startStance,               // §2.6 — 노말
      stanceCooldown: 0,
      invest,                               // §2.6 — fire 0 / water 0 / grass 0 (§4.2 investable)
      level: 1, xp: 0, xpToNext: 0,
      slowSec: 0, stunSec: 0,
      heat: 0,                              // §8.21(v1.10 ⑦) 과열 게이지 [0,1] — 불 지형 안에서 차고 밖에서 식는다
      dirX: 0, dirY: 0,
      lastHorizontal: 0, lastVertical: 0,   // §2.2 SOCD = lastInput
      hit: false,                           // 이번 틱에 피격했는가 (렌더/점수용)
    },
    // §11.3 — 런 점수 누적기. §6.1 난이도는 배속(main)과 점수 배율(여기) 두 곳에서 쓰인다
    score: makeScore(data),
    difficultyId: opts.difficulty === undefined ? 'normal' : opts.difficulty,

    // §5.7 — 직전 틱의 키 상태. SOCD(lastInput)와 상승 엣지 판정의 유일한 근거. 재사용(0 alloc)
    prevInput: { left: false, right: false, up: false, down: false,
      stanceNormal: false, stanceFire: false, stanceWater: false, stanceGrass: false },

    // §3.1 — 데미지 컨텍스트. 매 틱 재사용한다 (핫패스 0 alloc)
    dmgCtx: { matrix: null, dmgMulSum: 0, elementBonusMul: 1 },
    // §11.1(v1.6) null = 매 런 추첨. 특정 무기를 시험하는 테스트만 값을 넘긴다.
    startWeaponId,

    slots: new Array(rp.weaponSlots),
    passives: new Array(rp.passiveSlots),
    stats: makeStats(),

    enemies: makePool(caps.enemies, () => makeEnemy(rp.weaponSlots)),
    playerBullets: makePool(caps.playerBullets, () => makePlayerBullet(caps.enemies)),
    enemyBullets: makePool(caps.enemyBullets, makeEnemyBullet),
    pickups: makePool(caps.pickups, makePickup),
    zones: makePool(caps.zones, makeZone),
    terrain: makePool(caps.terrain, makeTerrain),   // §8.21(v1.10 ⑦) 지형 장판 — 피해 0, 조작만 건드린다
    drones: makePool(caps.drones, makeDrone),
    telegraphs: makePool(caps.telegraphs, makeTelegraph),

    // §6.4 — 레벨업 드래프트 큐. 소화는 호출자(상태 기계)의 몫이며 core 는 세기만 한다
    draftQueue: 0,
    // §11.6(v1.10 ⑲·㉒) 특성 — 보스 처치 보상. traits = {id: 레벨}(0 = 없음), traitQueue = 아직 안 고른 구슬 수,
    //   traitFx = 핫패스가 읽는 평면 효과(applyTrait 가 재계산), traitState = 런 안의 카운터(쉴드 충전).
    traits: makeTraitLevels(opts.data),
    traitQueue: 0,
    traitFx: makeTraitFx(),
    traitState: { shieldT: 0, shieldReady: false },
    draftsSeen: 0,
    elementPity: 0,      // §11.1 elementCardPity — 속성 카드가 "등장"하지 않은 연속 드래프트 수
    autoEquipDone: false, // §9.9 onboarding.autoEquipFirstElement — 투자 0→1 최초 전이에서만

    // §13.1.1 capHits — A층/B층 defer·reject 발화 카운터 (시뮬 게이트가 읽는다)
    capHits: { playerBullet: 0, enemyBullet: 0, enemy: 0, pickup: 0, zone: 0, drone: 0, telegraph: 0 },

    // §7.7 — 히트 피드백 이벤트 링(core→render). 순수 장식·결정성 무영향(위 makeHitFxBuffer 주석)
    hitFx: makeHitFxBuffer(caps.particles),
    chainFx: makeChainFxBuffer(caps.particles),     // ㉟ 체인·빔 선분(이번 틱)
    chainEpoch: 0,                                  // ㉟ 볼리 epoch 카운터(적의 chainEpoch 와 비교)

    over: false,
  };

  for (let i = 0; i < rp.weaponSlots; i += 1) world.slots[i] = makeSlot(i);
  for (let i = 0; i < rp.passiveSlots; i += 1) world.passives[i] = { id: null, level: 0 };

  // §11.1(v1.6) — 시작 무기는 매 런 «속성 계열»에서 추첨한다. rng.draft 를 쓰므로
  //   같은 시드 = 같은 시작 무기다(§10.2 결정성). 고정 startWeaponId 는 폐지됐다.
  //   ★ opts.startWeaponId 로 못박을 수 있다 — 특정 무기를 시험하는 테스트가 쓴다.
  //     게임 실행은 넘기지 않으므로 항상 추첨이다.
  if (world.startWeaponId !== null) {
    giveWeapon(world, world.startWeaponId);
  } else {
    const startPool = [];
    const wlist = world.data.weapons.weapons;
    for (let i = 0; i < wlist.length; i += 1) {
      if (wlist[i].slotClass === 'element') startPool.push(wlist[i].id);
    }
    giveWeapon(world, world.rng.draft.pick(startPool));
  }
  // §11.1(v1.10 ㉚) — 시작 무기의 «진화 짝 패시브»를 Lv1 로 함께 준다(사용자 2026-09-05: 「랜덤 무기에 대응되는 진화 패시브도
  //   하나 같이 주자」). 짝은 weapons[].evolution.requiresPassive 가 소유(S41) — 여기서 새 값을 만들지 않는다.
  //   성장 예산: 이 한 레벨은 공짜 픽이라 S10 의 minTotalSink 유도식이 1 을 뺀다.
  {
    const startSlot = world.slots.find((sl) => sl.weaponId !== null);
    if (startSlot !== undefined) {
      const req = world.weaponDefs[startSlot.family].evolution.requiresPassive;
      if (!givePassive(world, req.id)) throw new Error(`state: 시작 짝 패시브 "${req.id}" 지급 실패 (§11.1 ㉚)`);
    }
  }
  recomputeStats(world);
  recomputeStamps(world);
  world.player.xpToNext = xpToNext(world, 1);
  return world;
}

// ---------------------------------------------------------------------------
// 성장
// ---------------------------------------------------------------------------
/** §11.1 · §5.3 — 새 무기는 "가장 앞의 빈 슬롯에 자동 배치" (draft.slotAssign = "append") */
export function giveWeapon(world, weaponId) {
  const def = world.weaponDefs[weaponId];
  if (def === undefined) throw new Error(`state: 미지의 무기 "${weaponId}" (§9.5 — id == family)`);
  // ★ 계열 슬롯 — element 무기는 0..eSlots-1, utility 무기는 eSlots..weaponSlots-1 에만 앉는다.
  const eSlots = world.data.rules.player.elementSlots;
  const lo = def.slotClass === 'utility' ? eSlots : 0;
  const hi = def.slotClass === 'utility' ? world.slots.length : eSlots;
  for (let i = lo; i < hi; i += 1) {
    const s = world.slots[i];
    if (s.weaponId !== null) continue;
    s.weaponId = def.id;
    s.family = def.family;
    s.level = 1;
    s.evolved = false;
    s.cooldownT = 0;
    s.effDirty = true;
    recomputeStamps(world);   // §4.3 재계산 시점 ② — 새 무기 획득
    return i;
  }
  return -1;                  // §11.1 — 만석이면 newWeapon 카드가 애초에 풀에 없다
}

/** §9.5 — Lv7 → Lv8 레벨업 카드 그 자체가 진화 카드다 */
export function levelUpWeapon(world, slotIndex) {
  const s = world.slots[slotIndex];
  if (s.weaponId === null) throw new Error(`state: 빈 슬롯 ${slotIndex} 의 레벨업 (§9.5)`);
  if (s.level >= WEAPON_MAX_LEVEL) return false;   // Lv10 에서 종료 (v1.10 ⑱)
  s.level += 1;
  if (s.level === WEAPON_EVOLVE_LEVEL) s.evolved = true;   // Lv8 = 진화. Lv9·10 은 진화체 강화
  s.effDirty = true;
  return true;
}

/** §9.6 — 획득과 레벨업이 같은 passive 카테고리 */
export function givePassive(world, passiveId) {
  const maxLevel = world.data.passives.maxLevel;
  for (let i = 0; i < world.passives.length; i += 1) {
    if (world.passives[i].id === passiveId) {
      if (world.passives[i].level >= maxLevel) return false;
      world.passives[i].level += 1;
      recomputeStats(world);
      return true;
    }
  }
  for (let i = 0; i < world.passives.length; i += 1) {
    if (world.passives[i].id !== null) continue;
    world.passives[i].id = passiveId;
    world.passives[i].level = 1;
    recomputeStats(world);
    return true;
  }
  return false;               // 6칸 만석 + 미보유 → 카드가 풀에 없다 (§11.1)
}

// ---------------------------------------------------------------------------
// 스폰 (§12.1 — 초과 정책은 caps.overflow 가 소유한다)
// ---------------------------------------------------------------------------
/**
 * §12.1 — playerBullet 초과 = "rejectSpawn". 오래된 것 재활용 절대 금지.
 * §4.4  — element 각인은 **생성 순간**에 일어난다 (spawn 모드). live 모드는 stampFor() 가 매 적용마다 재평가.
 * @returns 탄 또는 null (풀 만석)
 */
export function spawnPlayerBullet(world, slot, eff, x, y, vx, vy, localMul) {
  const b = world.playerBullets.alloc();
  if (b === null) { world.capHits.playerBullet += 1; return null; }
  b.slot = slot.index;
  b.family = slot.family;
  b.x = x; b.y = y; b.vx = vx; b.vy = vy;
  b.dmg = eff.dmg;
  b.localMul = localMul;
  b.radius = eff.projRadius;
  b.element = slot.stampElement;                                  // §4.4 spawn 각인
  b.stampMode = world.weaponDefs[slot.family].elementStampMode;
  b.pierceLeft = eff.pierce;
  b.hitCooldownSec = eff.hitCooldownSec;
  b.age = 0;
  b.lifetimeSec = eff.lifetimeSec;
  b.hitEpoch += 1;                                                // 히트 기록 세대 교체 = 배열 클리어 불필요
  b.s0 = 0; b.s1 = 0; b.s2 = 0; b.target = -1; b.targetGen = -1;
  // §9.5(v1.7) anchored — 플레이어에 «붙어 있는» 탄(오빗 공전체)은 아레나 이탈 개념이 없다.
  //   자유 탄과 같은 컬링을 받으면 벽에 붙었을 때 바깥쪽 공전체가 지워졌다가 다음 틱에
  //   다시 만들어져 링에 구멍이 깜빡인다(확장 코일 Lv2 부터 상시). 수명은 소유 무기가 관리한다.
  b.anchored = false;
  b.bounceLeft = eff.bounceLeft === undefined ? 0 : eff.bounceLeft;   // §9.6(v1.7)
  return b;
}

/** §12.1 — enemy 초과 = "defer". 스포너가 다음 틱에 재시도한다 (웨이브가 공짜로 사라지지 않는다) */
/**
 * §8.6 — 런 포지션(스테이지 인덱스). 런이 없으면(테스트·슬라이스 월드) 0 = 배율 1.
 *   ★ enemyHpScale 은 enemies.js 가 hp 를 넘겨주며 이미 적용한다. xpScale 은 xp 가 개체 정의에서
 *     직접 오므로 **여기가 유일한 적용 자리**다.
 */
function curveIdxOf(world) {
  return (world.run !== undefined && world.run.order !== undefined) ? world.run.stageIndex : 0;
}

/** §7.6(v1.7) 이미터 id → 타입. 스폰 때 1회만 부른다(핫패스 아님). */
function emitterTypeOf(world, emitterId) {
  const ems = world.data.enemies.emitters;
  for (let i = 0; i < ems.length; i += 1) if (ems[i].id === emitterId) return ems[i].type;
  throw new Error(`state: 미지의 이미터 "${emitterId}" (§8.5 — 폴백 금지)`);
}

/**
 * §11.3(v1.10 ㊿) — 난이도 체력 배율. **모든 적의 hp 는 이 문을 지난다**(잡몹·중간보스·보스 코어/파트,
 *   즉 아래 네 스포너 전부). 난이도는 이제 «배속·점수»만이 아니라 «적이 얼마나 단단한가»를 정한다.
 *   ★ 기준선은 «가장 어려운 난이도»다(hell.hpMul == 1) — 저작값이 곧 헬이고 쉬운 난이도는 그 할인이다.
 *     만드는 사람이 조율하는 자리가 곧 헬이 되도록(§11.3 · S60 ②).
 *   ★ 여기가 아니라 각 곡선(enemyHpScale·bossHpScale…)에 곱하면 난이도가 스테이지 곡선을 오염시킨다.
 */
export function difficultyHpMul(world) {
  const d = world.data.meta.difficulty[world.difficultyId];
  if (d === undefined) throw new Error(`state: 미지의 난이도 "${world.difficultyId}" (§11.3)`);
  return d.hpMul;
}

/**
 * §8.5 · §11.3(v1.10 ㊿-z6) — 난이도 «적 발사 주기» 배율. 적이 쏘는 시계가 이만큼 빨리 간다.
 *   사용자(2026-09-12) 「흡혈이 조금 사기인것 같아서, 차라리 다음 전략은 어떨까 — 하드·헬 적 공격속도 ×1.2」:
 *   흡혈을 깎는 대신 **맞는 빈도**를 올린다. 회복이 초당 값이라, 세게 한 번보다 자주 여러 번이 흡혈을 더 잘 이긴다.
 *   ★ 거는 자리는 §8.12 의 보스 격화(run.bossFireRateMul)와 **같은 자리 = 이미터 시계**다. 데이터의 everySec 을
 *     건드리지 않으므로 악절의 «모양»(repeat·restSec·offsetSec 의 비율)은 그대로고 빠르기만 바뀐다.
 *   ★ 기준선은 가장 쉬운 난이도다(normal == 1, S60 ②'' — enemyDmgMul 과 같은 쪽 끝).
 */
export function difficultyFireRateMul(world) {
  const d = world.data.meta.difficulty[world.difficultyId];
  if (d === undefined) throw new Error(`state: 미지의 난이도 "${world.difficultyId}" (§11.3)`);
  return d.enemyFireRateMul;
}

/**
 * §3.2 · §11.3(v1.10 ㊿-q) — 난이도 공격력 배율. **적이 플레이어에게 주는 피해는 전부 이 문을 지난다** —
 *   탄·몸통·장판·빔 네 피해원이 step.applyHit 한 곳으로 모이고, 거기서 raw 에 이 배율이 곱해진다(S60 ⑧).
 *   ★ 기준선은 hpMul 과 «반대쪽» 끝 = 가장 쉬운 난이도다(normal.enemyDmgMul == 1, S60 ②').
 *     저작 피해(bullets[].dmg · contactDmg · 장판 dmg)는 §2.1 관대함 산술(「최대 단발 22 → 죽으려면 최소 5초」)이 서는 자리이고,
 *     그 보증은 노멀의 것이다(§6.2 「무-트위치 기둥은 Normal에서 보장된다」). 어려운 난이도는 그 위로 더 아프다.
 *   ★ 스폰(spawnEnemyBullet·spawnZone·spawnBeam)에 곱하지 않는다 — 몸통 피해가 빠지고, §8.18 의 «1 로 클램프»와 섞여
 *     어느 배율이 어디서 잘렸는지 아무도 못 읽게 된다.
 */
export function difficultyEnemyDmgMul(world) {
  const d = world.data.meta.difficulty[world.difficultyId];
  if (d === undefined) throw new Error(`state: 미지의 난이도 "${world.difficultyId}" (§11.3)`);
  return d.enemyDmgMul;
}

/**
 * §8.21 · §11.3(v1.10 ㊿-w) — 무대에 동시에 놓이는 **지형 장판 수의 상한**. 사용자(2026-09-12) 「난이도가 높아질수록 장판이 더 많아졌으면 좋겠어(노말 3~4개 · 하드 4~5개 · 헬 6~8개)」
 *   ★ 배율이 아니라 «개수»다 — 그래서 rules.terrain 에는 상한이 없다(난이도 표가 유일한 거처, S60 ⑪ · S2 닫힌 키).
 *   ★ 문은 하나다: terrain.terrainTick 만 이 함수를 부른다(S60 ⑫) — 보스 등장 무리(terrainBurst)는 bossEntryCount 가 따로 정하고,
 *     그 값은 «가장 낮은 난이도의 상한»도 넘지 않는다(S56 ⑥).
 */
export function difficultyTerrainCap(world) {
  const d = world.data.meta.difficulty[world.difficultyId];
  if (d === undefined) throw new Error(`state: 미지의 난이도 "${world.difficultyId}" (§11.3)`);
  return d.terrainMaxOnScreen;
}

/** 난이도 표에서 id 의 순번 — 표의 키 순서가 곧 난이도 순서다(normal → hard → hell, S60 ①). 스칼라 키는 난이도가 아니다. 없으면 -1. */
function difficultyRank(md, id) {
  const keys = Object.keys(md);
  let r = 0;
  for (let i = 0; i < keys.length; i += 1) {
    const v = md[keys[i]];
    if (v === null || typeof v !== 'object') continue;   // stunMinDifficulty
    if (keys[i] === id) return r;
    r += 1;
  }
  return -1;
}

/**
 * §2.7 — 이 난이도에서 스턴 탄이 나오는가(난이도 ≥ stunMinDifficulty). 미달이면 스턴 탄을 쏘는 이미터는 «발사 시점»에
 *   침묵한다(emitters.stunSilenced → fireVolley) — 치환 없음 · 텔레그래프 없음 · rng 무소비.
 *   ★ v1.10 ㊿-q 전까지 stunMinDifficulty 를 읽는 코드가 0 이었다 — 값 검사(S13 · S60 ⑥)만 통과하고 집행이 없어서
 *     노멀에서도 서리왕관(pylon)·늪(sac) 보스의 페이즈 3 이 스턴 탄을 쐈다(S60 ⑨ 가 이 자리를 지킨다).
 */
export function difficultyAllowsStun(world) {
  const md = world.data.meta.difficulty;
  const at = difficultyRank(md, world.difficultyId);
  if (at < 0) throw new Error(`state: 미지의 난이도 "${world.difficultyId}" (§11.3)`);
  const min = difficultyRank(md, md.stunMinDifficulty);
  if (min < 0) throw new Error(`state: stunMinDifficulty "${md.stunMinDifficulty}" 가 난이도 표에 없다 (§2.7)`);
  return at >= min;
}

export function spawnEnemy(world, archetypeId, element, x, y, hp, elite, ghost) {
  const e = world.enemies.alloc();
  if (e === null) { world.capHits.enemy += 1; return null; }
  const defs = world.data.enemies.archetypes;
  let def = null;
  for (let i = 0; i < defs.length; i += 1) if (defs[i].id === archetypeId) { def = defs[i]; break; }
  if (def === null) throw new Error(`state: 미지의 아키타입 "${archetypeId}" (§9.7)`);
  const band = world.data.enemies.bands[def.band];
  const el = world.data.rules.elite;

  e.archetypeId = def.id;
  e.band = def.band;
  e.shapeId = def.shapeId;
  // §7.6(v1.7) 공격 기호 — 이미터 타입을 개체에 굽는다(렌더가 매 프레임 찾지 않게).
  e.attackType = def.attack === null ? '' : emitterTypeOf(world, def.attack.emitterId);
  e.element = element;                    // §8.6 — element 는 아키타입 필드가 아니다. 편성이 주입한다
  e.x = x; e.y = y; e.vx = 0; e.vy = 0;
  e.hp = (elite ? hp * el.hpMult : hp) * difficultyHpMul(world);   // §8.6 엘리트 = 접두 플래그 · §11.3 난이도 배율
  e.hpMax = e.hp;
  e.radius = elite ? def.radius * el.sizeMult : def.radius;
  e.contactDmg = elite ? def.contactDmg * el.contactDmgMul : def.contactDmg;
  // §8.6 · §13.5 — 스테이지별 XP 배율(curve.xpScale). ★ 이 줄이 없으면 §13.5 의 XP 예산
  //   (누적 26,450 · 사다리 [12,19,26,34,43,54])이 성립하지 않는다 — 실측으로 발견된 누락이다.
  e.xp = (elite ? def.xp * el.xpMult : def.xp) * world.data.stages.curve.xpScale[curveIdxOf(world)];
  e.score = def.score;
  e.elite = elite;
  // §8.9(v1.5) 유령몹 — 소환된 «유령 군대». 공격/압박은 하되 처치해도 XP·점수 0(파밍 불가, 순수 긴장).
  e.ghost = ghost === true;
  e.introBody = false;                    // §8.19.1 — 스포너가 도입 구간에서만 켠다
  e.wallX = false;                        // §8.7 ㉕ — 스포너가 켠다
  e.chainEpoch = 0;                       // ㉟
  // §8.9(v1.5 · ★v1.10 ㊿-f) 유령몹 — score 는 0(순위표 파밍 차단), **xp 는 ghostXpRatio 만큼은 준다**.
  //   사용자(2026-09-06): 「위기 구간에서 어느 순간 경험치 드랍이 안되는 경우가 있었어」. 실측 원인:
  //   중간보스 구간은 웨이브가 정지(midBossSuspendsWaves)라 **죽일 수 있는 것이 유령뿐**이고, 유령 xp 가 0 이라
  //   그 40초 동안 잡몹 XP 가 «정확히 0» 이었다(실측 포지션 3~6: 처치 3~50, 전부 유령, XP 0). 그 유령들은
  //   위기가 시작해도 남아 흘러들어가(midBossForcedLeaveOnCrisis) 위기 초반까지 «안 나오는» 것으로 보인다.
  //   ★ 파밍 차단은 유지된다 — 비율이 1 미만이고 소환 구간 자체가 시계로 닫힌다(위기가 온다).
  if (e.ghost) { e.xp *= world.data.rules.boss.ghostXpRatio; e.score = 0; }
  e.isCore = false;
  e.isBoss = false; e.bossId = ''; e.partId = ''; e.partType = ''; e.anchorX = 0; e.anchorY = 0; e.phase = 0;
  e.sealLayer = 0; e.sealedNow = false;
  e.midBossId = '';
  e.dmgTotal = 0; e.dmgSuper = 0;
  e.slowSec = 0; e.stunSec = 0; e.fieldSlowMul = 1; e.actionSlowSec = 0; e.floorAt.fill(0);
  // §8.17(v1.7) 적 개성 — 선택 키(§8.11 sealLayer 와 같은 규약). 미선언 = 기본값 = 현행 동작.
  e.hitFloorSec = def.hitFloorSec === undefined ? 0 : def.hitFloorSec;
  e.pierceCost = def.pierceCost === undefined ? 1 : def.pierceCost;
  e.ccImmune = def.ccImmune === undefined ? false : def.ccImmune;
  e.emitT = 0; e.emitPhase = 0; e.emitT2 = 0; e.emitPhase2 = 0; e.summonT = 0; e.moveT = 0;
  e.mp0 = 0; e.mp1 = 0; e.mp2 = 0;                 // makeEnemy 대칭 — 재사용 stale 방지
  return e;
}

/**
 * §8.11 — 보스 코어를 적 풀에 스폰한다. ㉘: 코어는 모듈이 살아 있는 동안 sealedNow(하드 게이트) — 보스훅이 매 틱 갱신.
 *   hp 스케일링은 boss.js 소관. 이 헬퍼는 필드 전량 리셋만 책임진다(makeEnemy 대칭).
 */
export function spawnBossCore(world, bossId, core, hp, x, y) {
  const e = world.enemies.alloc();
  if (e === null) { world.capHits.enemy += 1; return null; }
  e.archetypeId = ''; e.band = ''; e.shapeId = core.shapeId;
  e.element = core.element;                       // §8.14 R1 — 코어는 노말
  e.x = x; e.y = y; e.vx = 0; e.vy = 0;           // 위치는 boss.js 가 직접 세팅(vx/vy=0)
  e.hp = hp * difficultyHpMul(world); e.hpMax = e.hp;   // §11.3 난이도 배율
  e.radius = core.radius; e.contactDmg = core.contactDmg;
  e.xp = 0; e.score = core.score;
  e.elite = false; e.ghost = false; e.introBody = false; e.wallX = false; e.chainEpoch = 0;
  e.isCore = true;
  e.isBoss = true; e.bossId = bossId; e.partId = ''; e.partType = 'core'; e.anchorX = 0; e.anchorY = 0; e.phase = 0;
  e.midBossId = ''; e.emitT2 = 0; e.emitPhase2 = 0; e.summonT = 0;
  e.dmgTotal = 0; e.dmgSuper = 0;
  e.slowSec = 0; e.stunSec = 0; e.fieldSlowMul = 1; e.emitT = 0; e.emitPhase = 0; e.moveT = 0; e.actionSlowSec = 0; e.floorAt.fill(0);
  e.hitFloorSec = 0; e.pierceCost = 1; e.ccImmune = false;   // §8.17(v1.7) 개성은 잡몹 전용 — 보스는 봉인(sealLayer)·코어게이트가 그 역할을 한다
  e.sealLayer = 0; e.sealedNow = false;            // §8.13(㉘) — 코어 봉인은 boss.js 가 «모듈 생존»으로 켠다. 풀 재사용 stale 방지(나머지 3개 스포너와 대칭)
  e.mp0 = 0; e.mp1 = 0; e.mp2 = 0;                 // makeEnemy 대칭 — 스크래치도 전량 리셋(재사용 stale 방지)
  return e;
}

/** §8.11 — 보스 파트를 스폰한다(코어+anchor 위치는 boss.js 가 매 틱 따라붙인다). */
export function spawnBossPart(world, bossId, part, hp, cx, cy) {
  const e = world.enemies.alloc();
  if (e === null) { world.capHits.enemy += 1; return null; }
  e.archetypeId = ''; e.band = ''; e.shapeId = part.shapeId;
  e.element = part.element;
  e.anchorX = part.anchor[0]; e.anchorY = part.anchor[1];
  e.x = cx + e.anchorX; e.y = cy + e.anchorY; e.vx = 0; e.vy = 0;
  e.hp = hp * difficultyHpMul(world); e.hpMax = e.hp;   // §11.3 난이도 배율
  e.radius = part.radius; e.contactDmg = part.contactDmg;
  e.xp = 0; e.score = part.score;
  e.elite = false; e.ghost = false; e.introBody = false; e.wallX = false; e.chainEpoch = 0;
  e.isCore = false;
  e.isBoss = true; e.bossId = bossId; e.partId = part.id; e.partType = part.partType; e.phase = 0;
  e.sealLayer = part.sealLayer === undefined ? 0 : part.sealLayer; e.sealedNow = false;
  e.midBossId = ''; e.emitT2 = 0; e.emitPhase2 = 0; e.summonT = 0;
  e.dmgTotal = 0; e.dmgSuper = 0;
  e.slowSec = 0; e.stunSec = 0; e.fieldSlowMul = 1; e.emitT = 0; e.emitPhase = 0; e.moveT = 0; e.actionSlowSec = 0; e.floorAt.fill(0);
  e.hitFloorSec = 0; e.pierceCost = 1; e.ccImmune = false;   // §8.17(v1.7) 개성은 잡몹 전용 — 보스는 봉인(sealLayer)·코어게이트가 그 역할을 한다
  e.mp0 = 0; e.mp1 = 0; e.mp2 = 0;                 // makeEnemy 대칭 — 스크래치도 전량 리셋(재사용 stale 방지)
  return e;
}

/**
 * §8.9 — 중간보스를 적 풀에 스폰한다. **단일 몸체·부위 없음**이므로 isBoss 는 켜지 않는다.
 *   hp 스케일(bossHpScale)·속성 주입(notThemeAndNotNormal)은 midboss.js 소관 — 이 헬퍼는
 *   makeEnemy 대칭의 필드 전량 리셋만 책임진다.
 */
export function spawnMidBoss(world, def, element, hp, x, y) {
  const e = world.enemies.alloc();
  if (e === null) { world.capHits.enemy += 1; return null; }
  e.archetypeId = ''; e.band = ''; e.shapeId = def.shapeId;
  e.element = element;                            // §8.9 런타임 주입(저작값은 null)
  e.x = x; e.y = y; e.vx = 0; e.vy = 0;
  e.hp = hp * difficultyHpMul(world); e.hpMax = e.hp;   // §11.3 난이도 배율
  e.radius = def.radius; e.contactDmg = def.contactDmg;
  e.xp = def.xp; e.score = def.score;
  e.elite = false; e.ghost = false; e.introBody = false; e.wallX = false; e.chainEpoch = 0;
  e.isCore = false;
  e.isBoss = false; e.bossId = ''; e.partId = ''; e.partType = ''; e.anchorX = 0; e.anchorY = 0; e.phase = 0;
  e.sealLayer = 0; e.sealedNow = false;
  e.midBossId = def.id;
  e.dmgTotal = 0; e.dmgSuper = 0;
  e.slowSec = 0; e.stunSec = 0; e.fieldSlowMul = 1; e.actionSlowSec = 0; e.floorAt.fill(0);
  e.hitFloorSec = 0; e.pierceCost = 1; e.ccImmune = false;
  e.emitT = 0; e.emitPhase = 0; e.emitT2 = 0; e.emitPhase2 = 0; e.summonT = 0;
  e.moveT = 0; e.mp0 = 0; e.mp1 = 0; e.mp2 = 0;
  return e;
}

/** §12.1 — pickup 초과 = "merge": 신규 값을 최근접 기존 픽업에 합산 (★ 손실 0 = 무-노가다 기둥 보존) */
export function spawnPickup(world, kind, value, x, y) {
  // §2.6(v1.7) — 보상은 «닿을 수 있는 곳»에 떨어진다. 처치 지점을 그대로 쓰면 아레나 가장자리에서
  //   죽은 적의 XP 가 플레이어의 이동 가능 영역(bounds = 아레나 − 인셋) 밖에 남아 영영 못 먹는다.
  //   ★ 이탈 몰수(§8.7)와는 다른 문제다: 그건 «안 죽인 것»의 보상이고, 이건 «죽인 것»의 보상이다.
  //     죽였는데 못 먹는 것은 규칙이 아니라 사고다(플레이 피드백).
  const b = world.bounds;
  let px = x; let py = y;
  if (px < b.minX) px = b.minX; else if (px > b.maxX) px = b.maxX;
  if (py < b.minY) py = b.minY; else if (py > b.maxY) py = b.maxY;
  return spawnPickupAt(world, kind, value, px, py);
}

function spawnPickupAt(world, kind, value, x, y) {
  const p = world.pickups.alloc();
  if (p === null) {
    world.capHits.pickup += 1;
    const items = world.pickups.items;
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < items.length; i += 1) {     // 인덱스 오름차순 — 동점이면 낮은 인덱스 (§10.3)
      const q = items[i];
      if (!q.alive || q.kind !== kind) continue;
      const dx = q.x - x;
      const dy = q.y - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = q; }
    }
    if (best !== null) { best.value += value; return best; }
    // ★ 같은 kind 픽업이 하나도 없다 = 풀이 «다른» kind 로 포화. 손실 0 을 지키려면 다른 kind 두 개를
    //   병합해 슬롯을 비우고 새 픽업을 그 자리에 놓는다.
    //   ★★ ㊿-zk — **이 블록은 실제로 돈다. 지우지 마라.** ~~v1.5 기준 kind 는 xp 하나뿐이라 도달 불가 · 죽은 코드로
    //     읽어도 된다~~ 는 v1.10 ⑲ 에서 거짓이 됐다: 금색 **특성 구슬(kind 'trait')** 이 생겼고, 경험치 구슬로 풀이
    //     꽉 찬 순간 보스가 죽으면 같은 kind 가 없어 정확히 여기로 온다. step.js 는 `if (q !== null)` 로 실패를
    //     말없이 건너뛰므로, 이 블록이 없으면 **보스를 잡고도 특성 보상을 조용히 잃는다**(멈추지도 않아 눈치채기 어렵다).
    //     퍼징 중 이 블록을 지워 봤더니 테스트 556개가 전부 초록이었다 → tests/state.test.mjs 「㊿-zk」 가 이제 막는다.
    const firstOf = Object.create(null);
    for (let i = 0; i < items.length; i += 1) {
      const q = items[i];
      if (!q.alive) continue;
      const prev = firstOf[q.kind];
      if (prev !== undefined) {
        prev.value += q.value;                        // 같은 kind 두 개 병합(손실 0)
        world.pickups.release(q);                     // 슬롯 확보
        const np = world.pickups.alloc();
        np.kind = kind; np.value = value; np.x = x; np.y = y; np.vx = 0; np.vy = 0; np.magnet = false;
        return np;
      }
      firstOf[q.kind] = q;
    }
    return null;                                      // 포화인데 모든 kind 가 한 개씩뿐일 때만(풀 384 · kind 2 라 사실상 불가)
  }
  p.kind = kind; p.value = value;
  p.x = x; p.y = y; p.vx = 0; p.vy = 0; p.magnet = false;
  return p;
}

/** §12.1 — enemyBullet 초과 = "rejectSpawn" */
/**
 * §8.5 zone — 원형 장판. 적 장판(fromPlayer=false)은 안에 있는 플레이어를 때리고, 플레이어 장판
 *   (무기 A2)은 적을 때린다. 피해는 **적용 1회**이며 i-frame 이 게이트한다(§8.5 「dps 는 없다」).
 */
/**
 * §8.18(v1.7) 적 공격 «피해»의 스테이지 곡선. ★ ㊿-r — 보스·중간보스도 탄다: 이미터가 귀속을 'boss'·'mb…' 로 싣는다
 *   (사용자 확정 2026-09-11 「난이도가 높을수록, 스테이지가 높아질수록 강해지는게 맞지!」). 귀속 '' 은 테스트·도구가 직접 만든 탄뿐이다.
 *   ★ 1 로 클램프한다 = «깎기만 하고 올리지 않는다». 빔/장판은 이미 저작 상한에 서 있고,
 *     §2.1 이 「hpMax 100 · 최대 단발 22 · i-frame 1.0 → 죽으려면 최소 5초」를 **산술적 보증**으로
 *     못박았다. 22 × 1.4 = 31 이면 4회 = 3.2초가 되어 그 보증이 깨진다.
 *     또 beamCore 는 잡몹 1종(turretPod)과 보스 5종이 «공유»하므로 저작값을 낮추면 보스가 약해진다.
 *   초반 완화(스테이지1 ×0.65)만 얻고 상한은 건드리지 않는 것이 이 클램프의 값이다.
 */
function mobDmgMul(world, srcArch, clampToOne) {
  if (srcArch === undefined || srcArch === '') return 1;
  if (world.run === undefined || world.run.stageIndex === undefined) return 1;
  const v = world.data.stages.curve.mobBulletDmgScale[world.run.stageIndex];
  return clampToOne === true ? Math.min(1, v) : v;
}

export function spawnZone(world, x, y, radius, dmg, activeSec, fromPlayer, srcArch, warnSec) {
  const z = world.zones.alloc();
  if (z === null) { world.capHits.zone += 1; return null; }
  z.x = x; z.y = y; z.radius = radius;
  z.dmg = Math.max(1, Math.round(dmg * mobDmgMul(world, srcArch, true)));   // §8.18(v1.7)
  z.activeSec = activeSec; z.age = 0; z.fromPlayer = fromPlayer;
  z.warnSec = warnSec === undefined ? 0 : warnSec;    // §8.5 v1.5 — mortar «퓨즈»(착탄→폭발). 0 = 즉시 활성(기존)
  z.srcArch = srcArch === undefined ? '' : srcArch;   // §13.1.1 치사 지분 귀속
  return z;
}

/**
 * telegraphs 풀의 범용 스폰 — kind 가 소유자를 가른다.
 *   'laser'  = 적 활성 빔(step.hazards 가 수명·피해를 소유)
 *   그 외    = 만든 쪽(무기)이 수명·효과를 소유한다(예: barrage 의 'strike' 예고).
 */
export function spawnTelegraph(world, kind, x, y, r, durSec, owner) {
  const t = world.telegraphs.alloc();
  if (t === null) { world.capHits.telegraph += 1; return null; }
  t.kind = kind; t.x = x; t.y = y; t.a = 0; t.r = r;
  t.age = 0; t.durSec = durSec; t.warnSec = 0; t.track = false; t.dmg = 0;
  t.owner = owner; t.srcArch = '';
  return t;
}

/**
 * §8.5 laser — 활성 빔(telegraphs 풀 재사용). 원점에서 angleRad 방향 반직선, 폭 widthPx.
 *   §7.4 — 2단: warnSec 동안 **충전(경고·무해)** → activeSec 동안 **활성(피해)**. durSec = 둘의 합.
 *   track 이면 충전 중 플레이어를 따라 조준하다가 활성 진입 시 각이 잠긴다.
 */
export function spawnBeam(world, x, y, angleRad, widthPx, dmg, activeSec, owner, srcArch, warnSec, track, angleEndRad) {
  const t = world.telegraphs.alloc();
  if (t === null) { world.capHits.telegraph += 1; return null; }
  const warn = warnSec === undefined ? 0 : warnSec;
  t.kind = 'laser'; t.x = x; t.y = y; t.a = angleRad; t.r = widthPx;
  t.aStart = angleRad; t.aEnd = angleEndRad === undefined ? angleRad : angleEndRad;   // aStart≠aEnd = 소사
  t.age = 0; t.warnSec = warn; t.durSec = warn + activeSec;
  t.dmg = Math.max(1, Math.round(dmg * mobDmgMul(world, srcArch, true)));   // §8.18(v1.7)
  t.track = track === true;
  t.owner = owner;
  t.srcArch = srcArch === undefined ? '' : srcArch;   // §13.1.1 치사 지분 귀속
  return t;
}

export function spawnEnemyBullet(world, bulletId, x, y, vx, vy, srcArch) {
  const b = world.enemyBullets.alloc();
  if (b === null) { world.capHits.enemyBullet += 1; return null; }
  const defs = world.data.bullets.bullets;
  let def = null;
  for (let i = 0; i < defs.length; i += 1) if (defs[i].id === bulletId) { def = defs[i]; break; }
  if (def === null) throw new Error(`state: 미지의 탄 "${bulletId}" (§9.7)`);
  b.bulletId = def.id;
  b.srcArch = srcArch === undefined ? '' : srcArch;
  b.x = x; b.y = y; b.vx = vx; b.vy = vy;
  // §8.18(v1.7) 적 탄 «피해»의 스테이지 곡선. 발사 주기(emitters.mobFireScale — 잡몹만)와 짝이다.
  //   ★ ㊿-r — 피해 곡선은 보스('boss')·중간보스('mb…') 탄에도 걸린다(사용자 확정 2026-09-11). 귀속 '' 은 테스트·도구가 직접 만든 탄뿐.
  const dmgMul = (srcArch !== '' && world.run !== undefined && world.run.stageIndex !== undefined)
    ? world.data.stages.curve.mobBulletDmgScale[world.run.stageIndex] : 1;
  b.dmg = Math.max(1, Math.round(def.dmg * dmgMul));
  b.radius = def.radius;
  b.hitRadius = def.radius * def.hitboxScale;   // §2.3
  b.status = def.status;
  b.statusDurationSec = def.statusDurationSec;
  b.bounceLeft = def.bounceLeft === undefined ? 0 : def.bounceLeft;   // §8.5(v1.7)
  b.homingSec = def.homingSec === undefined ? 0 : def.homingSec;     // §9.7(v1.7)
  b.accel = def.accel;
  b.turnRateDegSec = def.turnRateDegSec;
  b.retargetSec = def.retargetSec;
  b.retargetT = 0;
  b.waveAmp = def.waveAmp;
  b.waveHz = def.waveHz;
  b.slowMul = 1;
  b.age = 0;
  return b;
}

/**
 * §9.9 meta.xp — curve "poly": 레벨 L → L+1 에 필요한 XP = base × L^exp.
 * ★ §9.9(v1.4) 확정 — xpToNext 는 float 다. **레벨별 반올림이 없다**: §13.5 의 누적 검산
 *   Σ_{L=1}^{53} 6·L^1.32 = 26,450(연속 합)이 이 독법을 강제한다. float 누산, 표시만 정수.
 */
export function xpToNext(world, level) {
  const xp = world.data.meta.xp;
  if (xp.curve !== 'poly') throw new Error(`state: 미지의 xp.curve "${xp.curve}" (§9.9)`);
  return xp.base * Math.pow(level, xp.exp);
}

export { makePool };
