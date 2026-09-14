/**
 * src/core/step.js
 *
 * 정본 v1.4 구현 절:
 *   §10.1  고정 타임스텝 — TICK_DT = 1/60 게임초. ★ dt 는 **인자**다. core 는 speed 를 모른다
 *   §5.7   매 고정 틱마다 키 상태를 **폴링**한다 (이벤트 큐 아님 — 헤드리스 재현성의 전제)
 *   §2.2   이동 — 관성 없음(moveResponseTau = 0), 대각선 정규화, SOCD = lastInput
 *   §2.3   히트박스   §2.4 i-frame (모든 피해원 공유, 게임초당 최대 1회)
 *   §2.5   몸통 충돌   §2.7 상태이상 (스턴 중에도 자동발사·스탠스 전환은 유효)
 *   §3.1 · §3.2  데미지
 *   §4.3 · §4.4  스탠스 부여 · 각인
 *   §6.4   드래프트 발생 — core 는 큐에 세기만 한다. 소화는 상태 기계의 몫
 *   §8.6   엘리트   §9.6 패시브 (xpGain — ㊲ 잔광·반응 장갑 폐지)  ★ v1.5: 코인·경제 폐지
 *   §10.3  L2 — 인덱스 오름차순 순회만 · 핫패스 0 alloc · Map/Set 순회 없음
 *   §12.1  캡 초과 정책
 *   §9.1   core 순수성
 *
 * ★ 이 파일에 배속이 없다. `main.js` 의 `tickDur` 가 이 함수를 몇 번 부를지 정한다 (§6.1).
 * ★ tools/sim.mjs 는 이 파일을 그대로 import 한다 — 렌더·오디오·DOM 은 애초에 없다 (§10.4).
 */

import { playerToEnemy, enemyToPlayer, noteDamage, noteDamageTaken, onScreen, lifesteal } from './damage.js';
import { terrainUnder, T_SLOW, T_INERTIA, T_HEAT } from './terrain.js';   // §8.21(v1.10 ⑦)
import { hitTier } from './elements.js';
import { addKill, noteHit, addMidBossClear } from './score.js';
import { recomputeEff, spawnPickup, pushHitFx, xpToNext, familyDmgMul, difficultyEnemyDmgMul } from './state.js';
import { tickStance, requestStance, stampFor } from './stance.js';
import { DEG2RAD, wrapAngle } from './angle.js';

/** §10.1 — 잠금. 배속과 무관한 상수 */
export const TICK_HZ = 60;
export const TICK_DT = 1 / 60;

const NORMAL = 'normal';
/** §2.2 — diagonalNormalize: true (×0.70710678). 정본이 인쇄한 상수 그대로 */
const DIAG = 0.70710678;

/**
 * §5.7 — 폴링된 키 상태 1틱분. **이벤트가 아니라 상태다.**
 * 봇(§10.2 bot 스트림)도 이 모양을 만들어 넘긴다 → 시뮬과 게임이 같은 입구를 쓴다.
 */
export function makeInput() {
  return { left: false, right: false, up: false, down: false,
    stanceNormal: false, stanceFire: false, stanceWater: false, stanceGrass: false };
}

/**
 * ★ 고정 dt 1틱.
 * @param world  createWorld() 가 만든 월드
 * @param input  이번 틱의 키 상태 스냅샷 (makeInput() 모양)
 * @param dt     게임초. 호출자가 TICK_DT 를 넘긴다. ★ 여기서 speed 를 곱하지 않는다
 */
export function step(world, input, dt) {
  if (world.over) return;

  world.tick += 1;
  world.time += dt;
  world.player.hit = false;
  world.hitFx.count = 0;            // §7.7 — 히트 피드백 링 = 「이번 틱」 신호. collide 가 다시 채운다
  world.chainFx.count = 0;          // §7.4 ㉟ — 체인·빔 선분 링, 같은 규약(무기 update 가 채운다)

  readInput(world, input, dt);      // 1. 입력 스냅샷
  movePlayer(world, dt);            // 2. 이동
  fireWeapons(world, dt);           // 3. 무기 발사
  if (world.hooks.run !== null) world.hooks.run(world, dt);        // §6.5 런 디렉터 — 페이즈 진행(스폰 게이트 전에)
  if (world.hooks.enemies !== null) world.hooks.enemies(world, dt);
  if (world.hooks.emitters !== null) world.hooks.emitters(world, dt);
  if (world.hooks.boss !== null) world.hooks.boss(world, dt);      // §8.11 보스 스폰·이동(이동 적분 전에)
  moveBullets(world, dt);           // 4. 탄 이동
  collide(world, dt);               // 5. 충돌
  hazards(world, dt);               // 5b. 장판·빔 (§8.5 zone·laser — 적용 1회, i-frame 게이트)
  pickups(world, dt);               // 6. 픽업
  levelUps(world);                  // 7. XP / 레벨
}

// ---------------------------------------------------------------------------
// 1. 입력 스냅샷 (§5.7 · §2.2 SOCD)
// ---------------------------------------------------------------------------
function readInput(world, input, dt) {
  const p = world.player;
  const prev = world.prevInput;

  // §2.2 — SOCD "lastInput": 반대키 동시 입력이면 **마지막에 눌린 키**가 이긴다.
  //   폴링 모델이므로 "눌린 순간" = 직전 틱 대비 상승 엣지다 (§5.5의 edgeTrigger 와 같은 기제).
  if (input.left && !prev.left) p.lastHorizontal = -1;
  if (input.right && !prev.right) p.lastHorizontal = 1;
  if (input.up && !prev.up) p.lastVertical = -1;
  if (input.down && !prev.down) p.lastVertical = 1;

  let dx = 0;
  if (input.left && input.right) dx = p.lastHorizontal;
  else if (input.left) dx = -1;
  else if (input.right) dx = 1;

  let dy = 0;
  if (input.up && input.down) dy = p.lastVertical;
  else if (input.up) dy = -1;
  else if (input.down) dy = 1;

  p.dirX = dx;
  p.dirY = dy;

  // §2.7 — 스탠스 전환은 **스턴 중에도 유효하다** ("스턴은 위치를 잠그는 것이지 판단을 잠그는 것이 아니다")
  // §5.7(v1.4) — 스탠스 키 동시 입력 → 마지막에 눌린 키.
  //   ★ 한 틱에 둘 이상이 동시에 상승 엣지면 Q<W<E<R 순 스캔으로 마지막(R 우선)을 채택한다
  //     (§4.1 키 순서의 결정적 사상 — 정본이 이 순서를 확정했다).
  let want = null;
  if (input.stanceNormal && !prev.stanceNormal) want = NORMAL;
  if (input.stanceFire && !prev.stanceFire) want = 'fire';
  if (input.stanceWater && !prev.stanceWater) want = 'water';
  if (input.stanceGrass && !prev.stanceGrass) want = 'grass';
  if (want !== null) requestStance(world, want);
  tickStance(world, dt);

  prev.left = input.left; prev.right = input.right;
  prev.up = input.up; prev.down = input.down;
  prev.stanceNormal = input.stanceNormal; prev.stanceFire = input.stanceFire;
  prev.stanceWater = input.stanceWater; prev.stanceGrass = input.stanceGrass;

  // §2.4 · §2.7 — 타이머
  if (p.iframeSec > 0) { p.iframeSec -= dt; if (p.iframeSec < 0) p.iframeSec = 0; }
  if (p.slowSec > 0) { p.slowSec -= dt; if (p.slowSec < 0) p.slowSec = 0; }
  if (p.stunSec > 0) { p.stunSec -= dt; if (p.stunSec < 0) p.stunSec = 0; }
  // §11.6(v1.10 ⑲·㉒) 특성 — 자연 재생 · 쉴드 충전
  const fx = world.traitFx;
  if (fx.regenHpPerSec > 0 && p.hp > 0 && p.hp < p.hpMax) { p.hp += fx.regenHpPerSec * dt; if (p.hp > p.hpMax) p.hp = p.hpMax; }
  if (fx.shieldEverySec > 0 && !world.traitState.shieldReady) {                      // 쉴드 생성 — 레벨이 오르면 everySec 이 줄어든다
    world.traitState.shieldT += dt;
    if (world.traitState.shieldT >= fx.shieldEverySec) { world.traitState.shieldReady = true; world.traitState.shieldT = 0; }
  }
}

// ---------------------------------------------------------------------------
// 2. 이동 (§2.2 — 관성 없음. 지수 스무딩 항은 존재하고 기본값이 0이다)
// ---------------------------------------------------------------------------
function movePlayer(world, dt) {
  const p = world.player;
  const rp = world.data.rules.player;
  const b = world.bounds;

  // §8.21(v1.10 ⑦) 지형 장판 — 피해 0, 조작만 건드린다. 어느 장판 위인가는 terrain.js 의 술어가 답한다.
  //   슬라이스(런 없음)는 지형이 없다(풀이 비어 -1). 효과의 «적용»은 여기가 단일 소유자다(§2.2 이동).
  const tr = world.data.rules.terrain;
  const tk = world.run === undefined ? -1 : terrainUnder(world, p.x, p.y);
  //   §8.21 ⑥(v1.10 ⑳·㉑) 지형 효과 배율 — 패시브 «자세 안정기»(stats.terrainResist, 가산 풀 Σ). 세 지형(둔화 깊이·관성 τ·
  //   과열 충전)이 전부 이 하나의 배율을 본다. Lv10 = 1.00 → 배율 0 = 면역(사용자 결정 2026-09-05). 특성은 여기 없다(㉑).
  const tmul = 1 - world.stats.terrainResist;
  //   slow — 기존 둔화 상태를 «이 틱만큼» 갱신한다: 배율·배지·타이머 규약(§2.7)을 그대로 재사용, 밖으로 나가면 다음 틱에 풀린다.
  //   ★ ㊿-zc — 면역(tmul 0)이면 타이머 자체를 안 세운다. 안 그러면 안 느려지는데 HUD 둔화 배지만 켜진다(거짓 표시).
  //   ★ ㊿-ze5 — 보충 «직전» 값을 남긴다. 이 한 줄이 아래 「이 둔화가 어디서 왔는가」의 **유일하게 정확한** 근거다:
  //   감쇠(122행)를 지나고도 남아 있으면 그 둔화는 탄이 건 것이고, 0 이면 지금 서 있는 장판이 세운 것이다.
  const bulletSlowLeft = p.slowSec;
  if (tk === T_SLOW && tmul > 0 && p.slowSec < dt) p.slowSec = dt;
  //   heat — 안에서 차고(스턴 중엔 안 찬다: 연쇄 정지 방지) 밖에서 식는다. 다 차면 stallSec 스턴(«과열 정지») 후 0.
  if (tk === T_HEAT && p.stunSec <= 0) p.heat += (dt / tr.heat.fullSec) * tmul;
  else if (tk !== T_HEAT) p.heat -= dt / tr.heat.coolSec;
  if (p.heat < 0) p.heat = 0;
  if (p.heat >= 1) { if (p.stunSec < tr.heat.stallSec) p.stunSec = tr.heat.stallSec; p.heat = 0; }

  let dx = p.dirX;
  let dy = p.dirY;
  if (p.stunSec > 0) { dx = 0; dy = 0; }          // §2.7 — 스턴 중 이동 입력 무시

  // §2.2 상한 — `player.moveSpeed` 280 고정(v1.10 ⑳: 패시브 이동 속도 배율 폐지 · ㉑: 특성 배율도 없음). 배율은 어디에도 없다.
  let v = rp.moveSpeed;
  if (p.slowSec > 0) {                                                 // §2.7 — 강도는 불변
    const mul = world.data.rules.status.slowMoveSpeedMul;
    //   ★ ㊿-zc — «지형 위인가»가 아니라 «이 둔화가 어디서 왔는가»로 가른다. 예전에는 앞엣것을 봐서,
    //   탄에 맞아 둔화된 채 늪에 들어서면 저항이 그 둔화까지 깎아 줬다 — 늪에 들어가면 **더 빨라졌다**
    //   (검토 실측: 안정기 Lv10 에서 154px/s → 270px/s = 사실상 무둔화). 바로 위 주석이 그러면 안 된다고 적혀 있었다.
    //   ★ ㊿-ze5 — 가르는 법. ~~slowSec ≤ dt~~ 라는 «값 비교»는 경계에서 틀린다: 탄 둔화가 감쇠하다
    //   dt 아래로 내려오는 **두 틱** 동안 값이 「지형이 세운 한 틱」과 똑같아져, 저항이 탄 둔화까지 깎았다
    //   (검토 실측: 안정기 Lv9 · 2.5초 탄 둔화가 장판 위에서 33ms 일찍 풀렸다 — Lv10 뿐 아니라 전 레벨).
    //   값이 아니라 **순서**로 가른다: 지형 보충 직전(149행)에 남아 있던 시간이 곧 「탄이 건 몫」이다.
    //   0 이면 지금 느린 이유는 장판뿐이므로 저항을 먹이고, 남아 있으면 탄이 건 것이므로 그대로 받는다.
    const fromTerrain = bulletSlowLeft <= 0;
    v *= fromTerrain ? 1 - (1 - mul) * tmul : mul;
  }

  if (rp.diagonalNormalize && dx !== 0 && dy !== 0) { dx *= DIAG; dy *= DIAG; }

  const tvx = dx * v;
  const tvy = dy * v;
  //   inertia — 지형이 §2.2 의 지수 스무딩 항을 켠다(기본 0 = 즉시 응답). 값은 rules.terrain.inertia 가 소유한다.
  const tau = tk === T_INERTIA ? tr.inertia.responseTauSec * tmul : rp.moveResponseTau;
  if (tau > 0) {
    // ★ 항은 존재하고 값이 0이다 — "살짝 미끄럽게"가 필요해도 숫자만 바뀐다 (§2.2 · C-4)
    const k = 1 - Math.exp(-dt / tau);
    p.vx += (tvx - p.vx) * k;
    p.vy += (tvy - p.vy) * k;
  } else {
    p.vx = tvx;                                   // 가속/감속 없음, 즉시 정지
    p.vy = tvy;
  }

  p.x += p.vx * dt;
  p.y += p.vy * dt;
  if (p.x < b.minX) p.x = b.minX;
  if (p.x > b.maxX) p.x = b.maxX;
  if (p.y < b.minY) p.y = b.minY;
  if (p.y > b.maxY) p.y = b.maxY;
}

// ---------------------------------------------------------------------------
// 3. 무기 발사 (§2.7 — 자동발사는 스턴 중에도 계속된다)
// ---------------------------------------------------------------------------
function fireWeapons(world, dt) {
  const slots = world.slots;
  for (let i = 0; i < slots.length; i += 1) {     // 인덱스 오름차순 = 슬롯 순서 (§4.3 과 같은 순서)
    const s = slots[i];
    if (s.weaponId === null) continue;
    const fn = world.weaponFns[s.family];
    if (fn === undefined) {
      // §9.3 정신 — 폴백 금지. 조용히 안 쏘는 무기는 "밸런스가 조용히 드리프트하는" 바로 그 자리다
      throw new Error(`step: 무기 모듈 없음 "${s.family}" — src/core/weapons/${s.family}.js 를 레지스트리에 주입하라 (§9.5)`);
    }
    fn.update(world, s, recomputeEff(world, s), dt);
  }
}

/** §7.4(v1.10 ㉟) 체인·빔 선분 신호 — 무기 update 가 홉·갈래마다 하나씩 남긴다. 렌더(draw.drawChainFx)가 이번 프레임에 그린다. */
export function pushChainFx(world, x1, y1, x2, y2, element) {
  const c = world.chainFx;
  if (c.count >= c.cap) return;
  const s = c.buf[c.count];
  s.x1 = x1; s.y1 = y1; s.x2 = x2; s.y2 = y2; s.element = element;
  c.count += 1;
}

/**
 * §9.5(v1.4) 무기 런타임 계약 D2 — 플레이어 탄 release 의 유일한 관문.
 *   (1) b.family 로 현재 슬롯을 해소한다 (world.slots 선형 탐색 · id==family 1:1 · 없으면 스킵)
 *   (2) 그 family 모듈에 onExpire 가 있으면 release **직전에 정확히 1회** 부른다
 *       onExpire(world, slot, recomputeEff(world, slot), bullet) — fan 진화 폭발 등.
 *   (3) playerBullets.release(b)
 * ★ 탄이 풀로 반환되기 **전에** onExpire 가 불리므로 LIFO 재사용 경합이 구조적으로 불가능하다
 *   (v1.3 fan.sweepExpired 의 스캔-마커 해킹을 대체). 모든 플레이어 탄 release 는 이 함수 경유.
 */
function releasePlayerBullet(world, b) {
  const fn = world.weaponFns[b.family];
  if (fn !== undefined && fn.onExpire !== undefined) {
    let slot = null;
    for (let i = 0; i < world.slots.length; i += 1) {
      if (world.slots[i].family === b.family) { slot = world.slots[i]; break; }
    }
    if (slot !== null) fn.onExpire(world, slot, recomputeEff(world, slot), b);
  }
  world.playerBullets.release(b);
}

// ---------------------------------------------------------------------------
// 4. 탄 이동
// ---------------------------------------------------------------------------
/**
 * §9.6/§8.5(v1.7 · ㊿-t) 벽 반사 — 반사 벽(world.walls = 아레나 − HP·XP 띠)에서 되튄다. ★ 탄은 **제 반경만큼 안쪽**에서 튄다 —
 *   가장자리가 벽에 닿는 순간이다(중심에서 튀면 공의 절반이 HP 바를 덮는다 · 적 기체의 bounce 이동도 반경만큼 안쪽에서 튄다).
 *   컬링 경계가 아니다(컬링은 아레나에서 pad 만큼 더 바깥). ㊿-t 전에는 아레나 끝(y 720)에서 튀어, 탄보다 먼저 그려지는 HP·XP 띠
 *   위로 공이 바를 가로질렀다(사용자(2026-09-12) 「핀볼이 벽에 튕길때, 밑에 있는 HP, 경험치바를 통과?해서 반사되던데?」).
 *   반환 = 이 탄이 되튀었는가. 반사 예산(bounceLeft)이 남아 있을 때만 되튄다.
 *   ★ «안에서 벽을 넘은» 틱에만 되튄다(prevX/prevY = 이번 틱 이동 전 위치) — 벽 밖(HP·XP 띠 · 화면 위)에서 생긴 탄을 벽 안으로 순간이동시키지 않는다.
 *     밖에서 생긴 탄은 들어올 때까지 직선이고, 바깥으로 가던 탄은 그대로 나간다. 봇의 접기(bot.foldWall)가 같은 규칙이다.
 *   ★ 순수 기하다 — 입사각 = 반사각. RNG 를 안 쓰므로 결정성 무영향.
 *   ★ 위치를 벽 안으로 «되접어» 넣는다. 단순히 속도만 뒤집으면 벽을 파고든 채로 매 틱 부호가 뒤집혀 탄이 벽에 들러붙는다.
 */
function bounceOffWalls(b, w, prevX, prevY) {
  if (b.bounceLeft === 0) return false;
  const r = b.radius;
  const left = w.x + r;
  const right = w.x + w.w - r;
  const top = w.y + r;
  const floor = w.y + w.h - r;
  let hit = false;
  if (b.x < left && prevX >= left) { b.x = left + (left - b.x); b.vx = -b.vx; hit = true; }
  else if (b.x > right && prevX <= right) { b.x = right - (b.x - right); b.vx = -b.vx; hit = true; }
  if (b.y < top && prevY >= top) { b.y = top + (top - b.y); b.vy = -b.vy; hit = true; }
  else if (b.y > floor && prevY <= floor) { b.y = floor - (b.y - floor); b.vy = -b.vy; hit = true; }
  if (hit && b.bounceLeft > 0) b.bounceLeft -= 1;
  return hit;
}

function moveBullets(world, dt) {
  const a = world.data.rules.view.arena;
  const pad = 64;

  const pb = world.playerBullets.items;
  for (let i = 0; i < pb.length; i += 1) {
    const b = pb[i];
    if (!b.alive) continue;
    const prevX = b.x;
    const prevY = b.y;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.age += dt;
    if (b.anchored) continue;                 // §9.5(v1.7) 붙어 있는 탄은 이탈하지 않는다(소유 무기가 수명을 관리)
    bounceOffWalls(b, world.walls, prevX, prevY);   // §9.6(v1.7 · ㊿-t) 반사 예산이 있으면 가장자리가 반사 벽에 닿는 순간 되튄다
    if (b.age >= b.lifetimeSec
        || b.x < a.x - pad || b.x > a.x + a.w + pad
        || b.y < a.y - pad || b.y > a.y + a.h + pad) {
      releasePlayerBullet(world, b);          // D2 — 수명 만료·화면 밖도 onExpire 경유
    }
  }

  const eb = world.enemyBullets.items;
  const pl = world.player;
  for (let i = 0; i < eb.length; i += 1) {
    const b = eb[i];
    if (!b.alive) continue;
    const prevX = b.x;                            // ㊿-t 반사는 «이번 틱에 벽을 넘었는가»로 본다
    const prevY = b.y;
    if (b.accel !== 0) {                          // §9.7 — 가속은 탄의 속성이다
      const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (sp > 0) {
        const ns = sp + b.accel * dt;
        b.vx = (b.vx / sp) * ns;
        b.vy = (b.vy / sp) * ns;
      }
    }
    // §8.5·§9.7 — 유도: turnRateDegSec>0 이면 retargetSec 마다 플레이어 쪽으로 각을 꺾는다(재조준 간격이
    //   회피 창을 준다). 사이엔 직진. 이 통합이 없으면 «유도탄»이 직진해 유도의 의미가 사라진다(실측 버그).
    // §9.7(v1.7) — 유도는 homingSec 까지만. 그 뒤엔 직진하므로 «따돌릴 수 있다».
    if (b.turnRateDegSec !== 0 && (b.homingSec === 0 || b.age < b.homingSec)) {
      b.retargetT -= dt;
      if (b.retargetT <= 0) {
        b.retargetT += b.retargetSec;
        const sp2 = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        if (sp2 > 0) {
          const cur = Math.atan2(b.vy, b.vx);
          let d = wrapAngle(Math.atan2(pl.y - b.y, pl.x - b.x) - cur);
          const maxTurn = b.turnRateDegSec * DEG2RAD * b.retargetSec;   // 간격 동안 누적 가능한 최대 회전
          if (d > maxTurn) d = maxTurn; else if (d < -maxTurn) d = -maxTurn;
          const na = cur + d;
          b.vx = Math.cos(na) * sp2;
          b.vy = Math.sin(na) * sp2;
        }
      }
    }
    // §9.7(v1.5) 파동탄 — 진행 방향 수직으로 사인 진동. 수직속도 = waveAmp·ω·cos(ω·age), ω=2π·waveHz.
    //   vx/vy(전진)는 그대로 두고 위치에만 수직 성분을 더한다 → 경로가 물결친다. slowMul 도 함께 적용.
    if (b.waveAmp !== 0) {
      const sp3 = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (sp3 > 0) {
        const w = Math.PI * 2 * b.waveHz;
        const pv = b.waveAmp * w * Math.cos(w * b.age) * b.slowMul;
        b.x += (-b.vy / sp3) * pv * dt;
        b.y += (b.vx / sp3) * pv * dt;
      }
    }
    // §9.5(v1.5) 펄스필드 슬로우 — slowMul(펄스필드가 이번 틱 세팅)로 이동을 줄인다. 적용 후 1로 리셋
    //   → 필드를 벗어나면 다음 틱부터 원속도(«범위 안에서만 느려진다»).
    // ★★ v1.10 ㊿-o — **나이도 같은 배율로 흐른다**(시간 지연). 이게 없으면 «느리게»가 «지우기»가 된다:
    //   탄은 maxBulletAgeSec(6초)에 사라지므로, 반경 R 을 건너지 못할 만큼 느려지면 필드 안에서 수명이 다한다.
    //   조건은 `R ≤ 최저 탄속 × maxBulletAgeSec × slowMul` 인데, 실측 R 최대 271px(Lv10 176 × 확장 코일 +54%)에
    //   최저 탄속 90 · 6초를 넣으면 필요한 slowMul 이 **0.50** 이다 — 즉 진화(0.15)는 물론 **base(0.4)조차
    //   느린 탄을 지우고 있었다**(사용자 2026-09-08: 「펄스 필드가 진화해버리면 모든 탄이 멈춰서 게임이 너무 쉬워져」).
    //   ★ 값으로는 못 고친다 — 반경은 패시브로 자라고 탄속은 이미터마다 다르다. 그래서 «시간»을 고친다:
    //     필드 안에서는 이동도 나이도 같은 비율로 느려지므로 **어떤 반경·어떤 배율에서도 탄은 결국 건너온다.**
    //     그 대가로 필드가 탄을 오래 머금는다 — 그것은 «위협이 쌓이는» 그림이고, 사라지는 것과 정반대다.
    //   ★ 유도(homingSec)·파동(waveHz)·재조준(retargetT)도 age 를 읽으므로 함께 늦어진다 = 시간 지연으로 일관.
    const slow = b.slowMul;
    b.x += b.vx * slow * dt;
    b.y += b.vy * slow * dt;
    b.slowMul = 1;
    b.age += dt * slow;
    bounceOffWalls(b, world.walls, prevX, prevY);   // §8.5(v1.7 · ㊿-t) 적 탄도 같은 규칙 · 같은 벽으로 되튄다
    // §9.5(v1.5) — 최대 수명(maxBulletAgeSec): 화면에 묶인 탄이 무한 누적하지 않게 흩어져 사라진다
    //   (정상 탄은 그 전에 off-screen 으로 나간다). 풀 포화(capHits) 방지.
    //   ★ ㊿-o 이후 이 시계는 «필드 안에서는 느리게» 간다 — 안 그러면 슬로우가 삭제가 된다(위 참조).
    if (b.x < a.x - pad || b.x > a.x + a.w + pad || b.y < a.y - pad || b.y > a.y + a.h + pad
        || b.age > world.data.rules.fairness.maxBulletAgeSec) {
      world.enemyBullets.release(b);
    }
  }

  // 적의 등속 적분. moveId 8종의 스크립트는 src/core/enemies.js 의 소관이며 vx/vy 를 쓴다 (§8.4)
  const en = world.enemies.items;
  for (let i = 0; i < en.length; i += 1) {
    const e = en[i];
    if (!e.alive) continue;
    // §9.5(㊿-p) 구역 감속 — 이번 틱의 배율을 «먼저 꺼내고 즉시 1 로 되돌린다». 스턴으로 continue 해도
    //   되돌림이 빠지지 않게 이 순서다(안 그러면 구역을 벗어난 적이 영원히 느린 채로 남는다).
    const field = e.fieldSlowMul;
    e.fieldSlowMul = 1;
    if (e.stunSec > 0) { e.stunSec -= dt; continue; }
    let m = field;
    if (e.slowSec > 0) { e.slowSec -= dt; m *= world.data.rules.status.slowMoveSpeedMul; }
    // §2.7(v1.7) 행동 감속 — 감소는 여기가 «단일 소유»다(stunSec 과 같은 규약, 이중 감소 방지).
    //   읽는 곳은 emitters.js(발사 주기)이며 이동에는 관여하지 않는다 — 제자리형 적에게 듣는 유일한 비-스턴 제어.
    if (e.actionSlowSec > 0) { e.actionSlowSec -= dt; if (e.actionSlowSec < 0) e.actionSlowSec = 0; }
    e.x += e.vx * m * dt;
    e.y += e.vy * m * dt;
    e.moveT += dt * field;      // ㊿-p — 구역 안에서는 «시간»이 느리다(weave/strafe 위상도 함께 늦어져 궤적이 일관된다)
    // §8.7(v1.10 ㉕) 옆벽 클램프 — 잡몹은 아레나 옆벽 «안»에만 있다(몸 전체). 편대 여백(bodyMargin)이 자리를, 이것이 그 뒤
    //   이동(weave 의 오일러 오차·엘리트 반지름·궤도)을 지킨다. 사용자: 「적이 있는 구간은 일정해야 한다 — 화면 밖에 걸치지 않게」.
    //   strafe(벽 밖 진입)·보스·중간보스는 wallX 가 꺼져 있다. 아래(y)는 «지나간다»가 규칙이라 그대로 몰수 경로.
    if (e.wallX) {
      if (e.x < a.x + e.radius) e.x = a.x + e.radius;
      else if (e.x > a.x + a.w - e.radius) e.x = a.x + a.w - e.radius;
    }
    // §8.7 — 아레나를 벗어난 적은 보상을 몰수당한다 (enemyExitForfeitsReward).
    //   ★ 보스 개체는 예외 — 느린 스웨이가 자기 자신을 이탈 처리해 사라지면 안 된다(§8.11).
    //   ★ 중간보스도 예외 — 이탈은 midBossLeaveAfterSec 이 정한다(§8.9), 좌표가 정하지 않는다.
    if (!e.isBoss && e.midBossId === ''
      && (e.y > a.y + a.h + pad || e.x < a.x - pad * 2 || e.x > a.x + a.w + pad * 2)) {
      world.enemies.release(e);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. 충돌
//   ★ collide.gridCellPx(64) 의 균일 그리드는 src/core/collide.js 의 소관이다 (§9.1).
//     1주차 규모(적 ≤96 × 탄 ≤256)에서는 직접 순회가 등가이며 결정성도 동일하다.
// ---------------------------------------------------------------------------
function collide(world, dt) {
  const ctx = world.dmgCtx;
  ctx.matrix = world.data.elements.matrix;
  ctx.dmgMulSum = 0;                                      // §3.1-2항(㊲) — 탄마다 그 슬롯 패밀리의 피해 스탯으로 채운다(아래)
  ctx.elementBonusMul = world.stats.elementBonusMul;      // §3.1-3항 — resonance 의 k

  const pb = world.playerBullets.items;
  const en = world.enemies.items;
  const arena = world.data.rules.view.arena;              // §8.20 판정 사각형 = 렌더 클립 사각형

  // (a) 플레이어 탄 → 적
  for (let i = 0; i < pb.length; i += 1) {
    const b = pb[i];
    if (!b.alive) continue;
    for (let j = 0; j < en.length; j += 1) {              // 인덱스 오름차순 (§10.3)
      const e = en[j];
      if (!e.alive) continue;
      // §8.20 — 화면 밖은 때릴 수 없다. ★ 탄은 «통과»하고 관통을 소모하지 않는다
      //   (§8.11 봉인의 「무적이되 탄은 통과」와 같은 계약). 흡수로 하면 스폰 라인의 안 보이는
      //   적이 뒤의 전부를 가리는 엄폐물이 되어 DPS 벽을 겹으로 세운다.
      if (!onScreen(arena, e)) continue;
      const dx = e.x - b.x;
      const dy = e.y - b.y;
      const rr = e.radius + b.radius;
      if (dx * dx + dy * dy > rr * rr) continue;

      // §8.11 partHitPriority "outermostFirst" — 코어를 가리는 파트가 이 탄과 겹치면 파트가 흡수한다.
      //   (풀 idx 순서에 의존하지 않는다 — 잡몹 페이즈가 free-스택을 뒤섞어 코어가 파트보다 낮은 idx 를
      //    가질 수 있다.) 파트는 ≤5 라 이 스캔은 0-alloc·저비용이며 코어 겹침에만 발화한다.
      if (e.isBoss && e.isCore) {
        let shielded = false;
        for (let k = 0; k < en.length; k += 1) {
          const pt = en[k];
          if (!pt.alive || !pt.isBoss || pt.isCore) continue;
          const pdx = pt.x - b.x;
          const pdy = pt.y - b.y;
          const prr = pt.radius + b.radius;
          if (pdx * pdx + pdy * pdy <= prr * prr) { shielded = true; break; }
        }
        if (shielded) continue;
      }

      // §8.11(v1.5) 레이어 봉인 — 낮은 레이어(앞) 파트가 살아있으면 이 파트는 무적. 탄은 통과(잠금 렌더가 신호).
      // §8.13(v1.10 ㉘) 코어 하드 게이트 — 모듈이 하나라도 살아 있으면 코어도 같은 봉인(탄 통과). 부수는 순서가 곧 규칙.
      if (e.isBoss && e.sealedNow) continue;

      // §6.3 — 페이즈 전환 중 보스(코어·파트) 무적 = 공짜 숨돌릴 틈. 탄은 통과(소멸 아님, i-frame 과 대칭).
      if (e.isBoss && world.run !== undefined && world.run.bossTransitionT > 0) continue;

      // §9.5 — hitCooldownSec: 같은 대상을 다시 때리기까지의 최소 간격.
      //        0.0 = 한 대상에 정확히 1회 (재히트 없음)
      // ★ hitGen — 히트 기록은 (hitEpoch, e.gen) 쌍으로 유효하다. 적 슬롯이 풀 재사용되면
      //   같은 idx 라도 e.gen 이 올라 다른 개체다 → 스탬프가 살아 있어도 "새 적"으로 취급해
      //   재히트 가드를 통과시킨다 (재사용 슬롯의 새 적을 관통탄이 조용히 무시하던 손실 차단).
      if (b.hitStamp[e.idx] === b.hitEpoch && b.hitGen[e.idx] === e.gen) {
        if (b.hitCooldownSec === 0) continue;
        if (world.time - b.hitAt[e.idx] < b.hitCooldownSec) continue;
      }
      // §8.17(v1.7) 장갑 — 적이 소유하는 재히트 하한. 위 hitCooldownSec 과 «독립»이며 둘 다 통과해야 한다.
      //   ★ max(hitCooldownSec, hitFloorSec) 로 합성하면 안 된다: hitCooldownSec 0 은 「한 대상에 정확히
      //     1회」(위 주석)라, max 는 그 0 을 하한으로 바꿔 관통탄에 재히트 «능력»을 새로 부여한다 —
      //     장갑을 달았더니 더 맞는 정반대가 된다.
      //   ★ 기록의 거처가 «적 × 슬롯»이다. 탄이 들고 있는 hitAt 은 «탄 하나»의 기록이라 팬아웃(다발)·
      //     드론(다기)·오빗(다체)이 탄마다 새 기록을 만들어 하한을 통째로 우회한다.
      //   ★ 막힌 탄은 pierce 를 «소모하지 않고» 통과한다 — §8.11 봉인 부위의 「탄은 통과」와 대칭.
      //     흡수(소모)로 하면 장갑 적이 뒤의 전부를 가리는 엄폐물이 되어 DPS 벽을 겹으로 세운다.
      if (e.hitFloorSec > 0) {
        const at = e.floorAt[b.slot];
        if (at !== 0 && world.time - at < e.hitFloorSec) continue;
        e.floorAt[b.slot] = world.time;
      }
      b.hitStamp[e.idx] = b.hitEpoch;
      b.hitGen[e.idx] = e.gen;
      b.hitAt[e.idx] = world.time;

      // §4.4 — spawn 은 각인된 값, live(orbit·aura) 는 현재 스탠스를 재평가
      const stamp = stampFor(world, b.slot, b.stampMode, b.element);
      const tier = hitTier(ctx.matrix, stamp, e.element);
      ctx.dmgMulSum = familyDmgMul(world, world.slots[b.slot].family);   // §3.1-2항(㊲) — 미사일 = areaDmgMul, 그 외 탄 = 0
      const dealt = playerToEnemy(ctx, b.dmg, b.localMul, stamp, e);
      lifesteal(world, dealt, e, world.slots[b.slot].family);   // ㊿-z8 탄 경로도 문을 지난다 · ㊿-za 패밀리가 «든다/안 든다»를 정한다
      e.hp -= dealt;
      noteDamage(world, b.family, dealt);           // §13.1.1 무기 지배도(시뮬 전용, 게임엔 무영향)
      // §11.3 attribution "damageShare" — 초효과 처치 보너스의 근거는 막타가 아니라 누적 지분이다
      e.dmgTotal += dealt;
      if (tier === 'super') e.dmgSuper += dealt;

      // §7.7 — 상성 tier 를 render 로 실어 보낸다(3중 감각의 근거). ★ 데미지에 쓴 그 stamp·그 matrix 로
      //   tier 를 뽑으므로 I-2(색=배율)와 어긋날 수 없다. killed 를 먼저 확정해 처치 FX 확대 근거를 싣는다.
      const killed = e.hp <= 0;
      pushHitFx(world, e.x, e.y, stamp, tier, killed, e.idx, e.gen);

      if (killed) { killEnemy(world, e); }

      // pierce: -1 = 무제한 (§9.6.1). 0 = 첫 히트에 소멸
      if (b.pierceLeft === -1) continue;
      // §8.17(v1.7) 차폐 — 소모량은 적이 정한다(pierceCost, 기본 1). 예산이 모자라면 뚫지 못하고 소멸한다.
      if (b.pierceLeft >= e.pierceCost) { b.pierceLeft -= e.pierceCost; continue; }
      releasePlayerBullet(world, b);          // D2 — 관통 소진도 onExpire 경유
      break;
    }
  }

  // (b) 적 탄 → 플레이어 (§2.3 히트박스 r = 4)
  const p = world.player;
  const rp = world.data.rules.player;
  const eb = world.enemyBullets.items;
  for (let i = 0; i < eb.length; i += 1) {
    const b = eb[i];
    if (!b.alive) continue;
    const dx = p.x - b.x;
    const dy = p.y - b.y;
    const rr = rp.hitboxRadius + b.hitRadius;
    if (dx * dx + dy * dy > rr * rr) continue;
    // §2.4(v1.4) — i-frame 중 통과하는 탄은 소멸하지 않는다. **피해를 실제로 준 그 탄 하나만**
    //   소멸(아래 release). 광역 소거는 hitBulletClearRadius 만 (v1.5: 실드·폭탄 폐지).
    if (p.iframeSec > 0) continue;
    if (applyHit(world, b.dmg, b.srcArch)) {
      if (b.status !== null) applyStatus(world, b.status, b.statusDurationSec);
      world.enemyBullets.release(b);
    }
  }

  // (c) 몸통 충돌 (§2.5 — 데미지 있음, i-frame 공유. 밀리지 않는다, 관통 통과)
  for (let i = 0; i < en.length; i += 1) {
    const e = en[i];
    if (!e.alive) continue;
    if (p.iframeSec > 0) break;
    const dx = p.x - e.x;
    const dy = p.y - e.y;
    const rr = rp.hitboxRadius + e.radius;
    if (dx * dx + dy * dy > rr * rr) continue;
    applyHit(world, e.contactDmg, e.archetypeId);
    break;
  }
  // ★ v1.5 — (d) omni 요격 섹션은 폐지됐다: omni 무기 삭제.
}

/**
 * §8.5 — 장판(zone) · 빔(laser). 둘 다 **적용 1회 = dmg** 이며 i-frame 이 게이트한다("dps 는 없다").
 *   zone 은 zones 풀, 활성 빔은 telegraphs 풀(kind 'laser')에 산다. 수명(activeSec)이 다하면 반납.
 *   ★ fromPlayer 장판(무기 A2)은 적을 때리는 것이라 여기(플레이어 피격)에서는 건너뛴다 — 나이만 먹인다.
 */
function hazards(world, dt) {
  const p = world.player;
  const rp = world.data.rules.player;

  const zs = world.zones.items;
  for (let i = 0; i < zs.length; i += 1) {
    const z = zs[i];
    if (!z.alive) continue;
    z.age += dt;
    // ★ 소유권 — 플레이어 장판은 **그 무기가** 수명·반납을 소유한다. 여기선 나이만 먹인다.
    //   (v1.5 에서 mine 이 삭제돼 현재 fromPlayer 장판의 생산자는 없다 — 경로는 유지.)
    if (z.fromPlayer) continue;
    if (z.age >= z.warnSec + z.activeSec) { world.zones.release(z); continue; }   // 퓨즈+활성 종료 = 반납
    if (z.age < z.warnSec) continue;                                              // §8.5 mortar 퓨즈(예고) = 무해 회피창
    const dx = p.x - z.x;
    const dy = p.y - z.y;
    const rr = z.radius + rp.hitboxRadius;
    if (dx * dx + dy * dy <= rr * rr) applyHit(world, z.dmg, z.srcArch);   // §13.1.1 장판 시전자 귀속
  }

  const ts = world.telegraphs.items;
  for (let i = 0; i < ts.length; i += 1) {
    const t = ts[i];
    if (!t.alive) continue;
    t.age += dt;
    // ★ 소유권 — 'laser'(적 빔)만 step 이 소유한다. 그 외 kind 는 만든 무기가 소유(barrage 예고 등).
    if (t.kind !== 'laser') continue;
    if (t.age >= t.durSec) { world.telegraphs.release(t); continue; }
    // §7.4 — 충전(경고) 구간: 무해. track 이면 플레이어를 겨누되, 활성 beamLockSec 전에 각을 «잠근다»
    //   → 「path 확정 후 뜸 → 확 발사」(회피 창). 잠금창 동안은 예고가 멈춰 서서 피할 곳을 준다.
    if (t.age < t.warnSec) {
      const trackUntil = t.warnSec - world.data.rules.fairness.beamLockSec;
      if (t.track && t.age < trackUntil) t.a = Math.atan2(p.y - t.y, p.x - t.x);
      continue;
    }
    // §8.5(v1.5) 소사 레이저 — aStart≠aEnd 면 활성 진행도에 따라 각을 aStart→aEnd 로 회전시킨다(아레나를 쓸고 간다).
    if (t.aStart !== t.aEnd) {
      const activeSec = t.durSec - t.warnSec;
      const prog = activeSec > 0 ? Math.min(1, (t.age - t.warnSec) / activeSec) : 1;
      t.a = t.aStart + (t.aEnd - t.aStart) * prog;
    }
    // 활성 구간: 반직선(원점 x,y · 방향 a)까지의 수직거리. 빔 뒤쪽(투영<0)은 맞지 않는다.
    const ux = Math.cos(t.a);
    const uy = Math.sin(t.a);
    const rx = p.x - t.x;
    const ry = p.y - t.y;
    if (rx * ux + ry * uy < 0) continue;
    const perp = Math.abs(rx * uy - ry * ux);
    if (perp <= t.r * 0.5 + rp.hitboxRadius) {
      // §9.5(v1.7) 오빗의 차폐 — 「펄스필드는 탄은 막는데 빔은 못 막는다」의 답.
      //   빔은 원점에서 뻗는 반직선이므로, 원점과 나 사이에 공전체가 서 있으면 그 몫만큼 흩어진다.
      //   ★ 판정 폭이 공전체 반경보다 넓다(beamBlockRadiusPx). 순수 기하로 하면 차단 창이
      //     0.08~0.15초인데 빔 활성은 0.5~2.2초라 «실측 0%»가 나온다 — 장식이지 대항 수단이 아니다.
      //   ★ 감산이지 무효화가 아니다(§2.1 관대함: 영구 무효는 없다). 피해의 «양»만 줄인다.
      applyHit(world, t.dmg * beamBlockMul(world, t, p), t.srcArch);   // §13.1.1 빔 시전자 귀속
    }
  }
}

/**
 * §9.5(v1.7) 오빗 차폐 — 빔 원점 t 와 플레이어 p 를 잇는 선분 위에 공전체가 있으면 피해가 준다.
 *   반환 = 피해 배율 (1 = 그대로, 1-ratio = 막힘). 공전체가 없으면 항상 1 이다.
 *   ★ 「선분 위」의 판정 폭은 eff 가 아니라 규칙이 소유한다(rules.fairness.beamBlockRadiusPx ·
 *     beamBlockRatio) — 공전체 반경을 그대로 쓰면 차단 창이 빔 활성 시간의 5% 미만이라 실측 0% 다.
 *   ★ 결정성: 순수 기하다. RNG 를 안 쓴다.
 */
function beamBlockMul(world, t, p) {
  const f = world.data.rules.fairness;
  const it = world.playerBullets.items;
  const dx = p.x - t.x;
  const dy = p.y - t.y;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-9) return 1;
  const rr = f.beamBlockRadiusPx * f.beamBlockRadiusPx;
  for (let i = 0; i < it.length; i += 1) {
    const b = it[i];
    if (!b.alive || !b.anchored) continue;             // 붙어 있는 탄(공전체)만 방패가 된다
    // 선분 t→p 위로의 사영. 구간 밖(원점 뒤·플레이어 너머)은 막지 못한다.
    const s = ((b.x - t.x) * dx + (b.y - t.y) * dy) / len2;
    if (s <= 0 || s >= 1) continue;
    const px = b.x - (t.x + dx * s);
    const py = b.y - (t.y + dy * s);
    if (px * px + py * py <= rr) return 1 - f.beamBlockRatio;
  }
  return 1;
}

/**
 * §2.4 · §3.2 — 모든 피해원이 공유하는 단 하나의 게이트.
 * @returns 실제로 피해가 적용됐는가 (v1.5: 실드 폐지 — 아래 §3.2 주석 참조)
 *
 * ★ export 이유(뮤테이션 가드) — 아래 i-frame 조기반환은 이 함수가 "게이트"라는 계약의 본체다.
 *   현재 호출자(collide 의 탄·몸통 2경로)는 각기 다른 목적으로 호출 **전에** iframeSec 를 이미
 *   게이트하므로(§2.4 v1.4 탄 통과 비소멸 · 탄+몸통 이중피격 차단) 이 조기반환은 그 경로들에서는
 *   도달-무효과다. 그러나 정본이 applyHit 를 "모든 피해원이 공유하는 단 하나의 게이트"로 못박았고,
 *   풀에 이미 예약된 zone/DoT(makeZone) 같은 미래 피해원은 이 게이트를 경유하게 된다.
 *   → 가드를 제거해 계약을 약화하는 대신, applyHit 를 직접 호출하는 격리 단위 테스트
 *     (tests/step.test.mjs "applyHit 격리 게이트")로 이 조기반환을 고정한다.
 */
export function applyHit(world, raw, srcArch) {
  const p = world.player;
  const rp = world.data.rules.player;
  if (p.iframeSec > 0) return false;              // 게임초당 최대 1회

  p.hit = true;
  p.iframeSec = rp.iframeSec;

  // §11.6(v1.10 ⑲·㉒ · ㊿-zc) 쉴드 — 충전된 쉴드는 그 피격의 **HP 피해만** 막는다(피해 0, i-frame 은 그대로 = 연타 차단). 다시 충전.
  //   ★ 상태이상(둔화·스턴)은 **그대로 통과한다** — 사용자(2026-09-12) 「쉴드는 둔화나 저항을 막지는 않아.
  //   탄이나 레이저 같은 비행기의 HP를 깎는 것에 대해서만 반응하는게 맞아」. 그래서 여기서 true 를 돌려주고,
  //   호출부는 그 true 를 보고 applyStatus 를 건다. ~~피격 1회를 «통째로» 막는다~~ 는 문면이 코드와 달랐다(검토가 결함으로 신고했다).
  const ts = world.traitState;
  if (ts.shieldReady) { ts.shieldReady = false; ts.shieldT = 0; noteHit(world); return true; }

  // §3.2 — 피격: taken 계산 + i-frame 발동 (v1.5: 실드 폐지 = 원데스 긴박함, 방어막 없음)
  noteHit(world);
  // ★ v1.10 ㊿-q — raw 에 난이도 공격력 배율(meta.difficulty[].enemyDmgMul)을 곱한다. 탄·몸통·장판·빔 네 피해원이 전부
  //   이 함수로 모이므로 문은 이 한 줄이다(S60 ⑧). 정액 감산·하한보다 «앞» = 원천이 세지는 것이지 방어가 약해지는 것이 아니다(§3.2 1항).
  const taken = enemyToPlayer(rp, p, raw * difficultyEnemyDmgMul(world));
  noteDamageTaken(world, srcArch === undefined ? '' : srcArch, taken);     // §13.1.1 치사 지분
  p.hp -= taken;
  if (p.hp <= 0) {
    p.hp = 0;
    world.over = true;
    // §11.4 — 사인을 명시한다(두 사인: 'hp' / 'timeout'). 시뮬의 bossTimeoutRate 가 이걸 센다.
    if (world.run !== undefined) world.run.deathCause = 'hp';
  }

  return true;
}

/** §2.7 — stackMode "refresh": 중첩 금지. 잔여 = max(잔여, 신규) (v1.5: 상점 resist 폐지) */
function applyStatus(world, status, durSec) {
  const p = world.player;
  const d = durSec;                               // resistAffects = "duration". 강도(0.55)는 불변
  if (status === 'slow') { if (d > p.slowSec) p.slowSec = d; return; }
  if (status === 'stun') { if (d > p.stunSec) p.stunSec = d; return; }
  throw new Error(`step: 미지의 상태이상 "${status}" (§9.7)`);
}

/**
 * §8.6 — 처치 보상. chaff·line 은 코인 0 (이것이 LOCKED "일부 잡몹만"의 정의다).
 * §9.5(v1.4) 무기 런타임 계약 D3 — **step.js 가 export.** 탄 충돌 밖에서 피해를 주는
 *   무기 모듈(fan 진화 폭발 등)이 import 해서 `if (e.hp <= 0) killEnemy(world, e)` 로 부른다.
 * ★ 진입 시 `if (!e.alive) return` 으로 **멱등** — 같은 틱에 두 피해원이 부르면 두 번째는 무해.
 * ★ S11 안전: world.rng.drop 텍스트가 이 파일(step.js)에 잔류하므로 weapons 파일 스캔에 안 걸림.
 */
export function killEnemy(world, e) {
  if (!e.alive) return;                                             // D3 멱등 가드
  if (e.isBoss) { killBossEntity(world, e); return; }              // §8.11 — 보스 개체는 별도 처치 규칙
  if (e.midBossId !== '') { killMidBoss(world, e); return; }       // §8.9 — 중간보스는 개체 필드가 보상을 소유
  addKill(world, e);                                                // §11.3 처치 점수(유령몹은 score 0 → 0점)
  // §8.9(★v1.10 ㊿-f) 유령몹도 xp 를 «비율만큼» 흘린다 — 값은 spawnEnemy 가 ghostXpRatio 로 이미 깎아 뒀다.
  //   여기서 «유령이냐»를 다시 묻지 않는 이유: 보상의 크기는 개체가 소유하고, 이 자리는 「죽었으면 준다」만 안다.
  if (e.xp > 0) spawnPickup(world, 'xp', e.xp, e.x, e.y);
  // v1.5 — 회복 픽업 드랍 폐지(사용자 지시). 잡몹 드랍원은 xp 뿐. 회복 = 스테이지클리어(10%)·보급카드(5%).
  world.enemies.release(e);
}

/**
 * §8.9 — 중간보스 처치. 보상: xp + 중간보스 격파 점수 (v1.5: 코인·회복 드랍 폐지).
 *   ★ 이탈(midboss.js 의 leave)은 이 경로를 타지 않는다 = 보상 0.
 */
function killMidBoss(world, e) {
  addKill(world, e);                                     // §11.3 개체 점수(초효과 지분 보너스 포함)
  addMidBossClear(world);                                // §11.3 중간보스 격파 보너스
  spawnPickup(world, 'xp', e.xp, e.x, e.y);
  world.enemies.release(e);
}

/**
 * §8.11/§8.12 — 보스 개체(코어·파트) 처치. killEnemy 가 e.isBoss 면 여기로 위임한다(멱등 가드는 상위).
 *   코어 격파 = 보스 사망 → run.cleared + 모든 보스 개체 반납(잡몹 드랍 없음, xp 0).
 *   주변 파트 파괴 = 코어 하드 게이트는 boss.js 의 봉인 틱이 «살아있는 모듈 수»로 다시 잰다(§8.13 ㉘).
 *   ★ 이동 페널티(mobility)·발사 격화(armament)는 B2. 여기선 게이트·반납만 (v1.5: 코인 폐지).
 */
/** 현재 런 포지션이 최종(테마 없음)인가. stage.isFinale 과 같은 판정이나 step 은 stage.js 를 import 하지 않는다(순환). */
function isFinaleStage(world) {
  const id = world.run.order[world.run.stageIndex];
  const list = world.data.stages.stages;
  for (let i = 0; i < list.length; i += 1) if (list[i].id === id) return list[i].element === null;
  return false;
}

function killBossEntity(world, e) {
  const bcfg = world.data.rules.boss;
  const en = world.enemies.items;
  addKill(world, e);                                     // §11.3 — 코어·파트 모두 개체 점수를 준다
  if (e.isCore) {
    if (world.run !== undefined) world.run.cleared = true;         // stage.tickRun 이 다음 틱에 소화
    for (let i = 0; i < en.length; i += 1) if (en[i].alive && en[i].isBoss) world.enemies.release(en[i]);
    // §11.6(v1.10 ⑲) 특성 구슬 — 스테이지 보스(최종 제외)의 코어 자리에서 금색 구슬이 나와 «자석»으로 날아온다.
    //   먹으면 traitQueue 가 1 오르고, stage.tickRun 은 구슬이 무대에 있는 동안 STAGE_CLEAR 로 넘어가지 않는다.
    //   ★ ㊿-z8 — 튜토리얼에서는 떨구지 않는다. 특성 3택은 PHASE.STAGE_CLEAR 에서만 열리는데(main.js)
    //   튜토리얼의 run.phase 는 끝까지 MOB 이라, 구슬이 나오고 자석으로 빨려 들어오고 **아무 일도 안 일어난다**.
    //   보상처럼 보이는 것이 보상이 아니면 가르치는 화면에서 가장 나쁘다(검토 재현: traitQueue 1 인 채로 종료).
    if (world.run !== undefined && world.tut === undefined && !world.run.won && !isFinaleStage(world)) {
      const q = spawnPickup(world, 'trait', 1, e.x, e.y);
      if (q !== null) q.magnet = true;
    }
    return;
  }
  // §8.12(v1.5) — 모듈(부위) 격파 = XP 드랍. 각 부위를 잡을 때마다 score 비례 xp 를 떨군다(플레이 피드백).
  //   ★ score 가 부위 중요도를 인코딩 + 스폰 부위 수가 포지션따라 늚(firingPartsPerStage 3→7) = 자연 스케일.
  if (bcfg.partXpRatio > 0 && e.score > 0) {
    const partXp = Math.round(e.score * bcfg.partXpRatio);
    if (partXp > 0) spawnPickup(world, 'xp', partXp, e.x, e.y);
  }
  // §8.12(v1.5) — 모듈 파괴 = «격화». 부위가 부서질수록 보스가 더 공격적으로(발사 빨라짐).
  //   ★ escalateFireRateMax 로 상한 — 부위 수(최대 7)가 늘어도 발사 밀도가 페어니스 상한(320)을 넘지 않게.
  if (world.run !== undefined) {
    world.run.bossFireRateMul = Math.min(world.run.bossFireRateMul * bcfg.escalateFireRateMul, bcfg.escalateFireRateMax);
  }
  if (e.partType === 'armor') {
    // §8.12(v1.5 B-3) — 모듈 격파 = «새 패턴». armor 를 부수면 남은 부위를 다음 페이즈 패턴으로
    //   즉시 격상(발악 앞당김). ★ 페이즈는 오직 오른다(advancePhase 가 HP 임계와 max 합성) → 격파할수록
    //   보스가 발악에 가까워진다 = 「모듈이 죽을수록 강해지는」 체감(속도만이 아니라 패턴).
    for (let i = 0; i < en.length; i += 1) {
      const c = en[i];
      if (c.alive && c.isBoss && !c.isCore && c.phase < 2) { c.phase += 1; c.emitT = 0; c.emitPhase = 0; }
    }
  } else if (e.partType === 'mobility' && world.run !== undefined) {
    world.run.bossMoveSpeedMul = bcfg.mobilityPenalty;    // §8.12(v1.5) 엔진 파괴 = 폭주(×1.5, 정지 아님)
    world.run.bossMoveAmpMul = 1;                          //   스웨이 유지(격렬하게 왕복)
  }
  world.enemies.release(e);
}

// ---------------------------------------------------------------------------
// 6. 픽업 (§2.6 magnetRadius · §12.1 merge)
// ---------------------------------------------------------------------------
function pickups(world, dt) {
  const p = world.player;
  const rp = world.data.rules.player;
  // §2.6 · §9.6(v1.10 ㉚) 자석 반경도 확장 코일(areaMul)을 탄다 — 점선 원 = 자석 = 오빗 궤도(S58)가 같이 커진다
  //   (사용자: 「범위 무기와 점선 원이 연관돼 보인다」). 판정(여기)과 그림(draw.drawHitboxDot)이 같은 식.
  const mag = rp.magnetRadius * (1 + world.stats.areaMul);
  // §2.6(v1.4) — 픽업 회수 2단계: magnetRadius 자석 → 획득 반경 = spriteRadius 접촉.
  //   둘 다 bounds/스프라이트에서 파생되는 구조 규칙(리터럴 아님) → 새 키 없음.
  const grab = rp.spriteRadius;
  const items = world.pickups.items;

  // §2.6(v1.10 ㊼) 구슬은 «내려온다» — 무대는 위에서 아래로 흐르는데 구슬만 제자리에 서 있으면, **사거리가 긴 무기가
  //   자기 보상을 못 받는다**: 빔(사거리 630)이 스폰 라인에서 잡으면 구슬이 화면 맨 위에 쌓이고 플레이어는 아래에 있다
  //   (실측 2026-09-06: 만렙 빔 25초 위기 478처치 → 획득 XP **0**, 구슬 중앙값 y 56 vs 플레이어 664. 벌컨도 165처치 0).
  //   「죽였는데 못 먹는 것은 규칙이 아니라 사고다」(§2.6 v1.7) 의 같은 문제다 → 구슬은 xpDriftPxSec 로 내려온다.
  // ★ v1.10 ㊿-l — 내려오기만 하면 **바닥에 가로로 줄지어 쌓인다**. 사용자(2026-09-08): 「위기 구간에서 계속
  //   경험치를 안 뱉는다」. 실측(포지션 5 · 위기 32초): 드랍은 정상(3,545~4,410)인데 **회수는 43~61%** 였고
  //   살아 있는 구슬의 **66~72% 가 바닥선(bounds.maxY)에 붙어** 있었다(동시 최대 291개). 위기는 새떼를 피하느라
  //   가로로 훑을 여유가 없는 구간이라 「주우러 가는 조작」이 성립하지 않는다 — 초기 구간 회수율은 99~100% 다.
  //   → 바닥에 닿은 구슬은 **같은 속도로 플레이어 쪽으로 가로로 흐른다**. 즉시 오지 않으므로(아레나 반폭 290px ≈ 3.2초)
  //     자리잡기는 여전히 의미가 있고, 다만 «영영 못 먹는 줄»이 생기지 않는다. 새 키 0(xpDriftPxSec 재사용).
  const drift = rp.xpDriftPxSec * dt;
  const floorY = world.bounds.maxY;

  for (let i = 0; i < items.length; i += 1) {
    const q = items[i];
    if (!q.alive) continue;
    if (q.kind === 'xp' && !q.magnet) {
      if (q.y < floorY) q.y = Math.min(floorY, q.y + drift);
      else {
        const toX = p.x - q.x;                       // 바닥에 닿은 뒤에는 가로로 흘러온다
        if (toX !== 0) q.x += (toX > 0 ? 1 : -1) * Math.min(drift, Math.abs(toX));
      }
    }
    const dx = p.x - q.x;
    const dy = p.y - q.y;
    const d2 = dx * dx + dy * dy;
    if (!q.magnet && d2 <= mag * mag) q.magnet = true;
    if (q.magnet) {
      const d = Math.sqrt(d2);
      if (d > 0) {
        // ★ 자석은 플레이어보다 느리면 안 된다 — movePlayer 와 같은 상한(moveSpeed 고정, 배율 없음 — v1.10 ⑳·㉑).
        const v = rp.moveSpeed;
        q.x += (dx / d) * v * dt;
        q.y += (dy / d) * v * dt;
      }
    }
    if (d2 <= grab * grab) {
      collect(world, q);
      world.pickups.release(q);
    }
  }
}

function collect(world, q) {
  const p = world.player;
  if (q.kind === 'xp') {
    const gain = q.value * (1 + world.stats.xpGainMul);                                // §9.6 study
    p.xp += gain;
    if (world.tele !== undefined) world.tele.xpGained += gain;                         // §13.1.1 farmXpRatio
    return;
  }
  if (q.kind === 'trait') { world.traitQueue += 1; return; }                            // §11.6(v1.10 ⑲) 보스의 금색 구슬 → 특성 선택 큐
  // v1.5 — 회복 픽업 폐지: 픽업 kind 는 xp 뿐. 회복 = 스테이지클리어·보급카드가 직접 hp 를 올린다.
  throw new Error(`step: 미지의 픽업 "${q.kind}"`);
}

// ---------------------------------------------------------------------------
// 7. XP / 레벨 (§6.4 — core 는 큐에 세기만 한다. 소화는 상태 기계의 몫)
// ---------------------------------------------------------------------------
function levelUps(world) {
  const p = world.player;
  // §6.4 — 동시 다중 레벨업 = 병합 없이 **순차** 드래프트 (xp.levelUpQueueMode = "serial")
  while (p.xp >= p.xpToNext) {
    p.xp -= p.xpToNext;
    p.level += 1;
    p.xpToNext = xpToNext(world, p.level);
    world.draftQueue += 1;
  }
}
