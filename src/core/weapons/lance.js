/**
 * src/core/weapons/lance.js — 랜스 (§9.5)
 *
 * 폐쇄된 파라미터 계약 (§9.5 12행 표):
 *   base            : dmg cooldownSec count pierce hitCooldownSec targetMode
 *                     beamWidthPx chargeSec rangePx
 *   evolution.params: evoFullHeight
 *
 * §9.6.1 훅은 state.recomputeEff 가 이미 적용했다:
 *   훅(㊲ 빔 분류): rateKey "cooldownSec" (H1) · countKey null · pierceApplies false(관통은 자기 레벨 표) ·
 *   beamKeys ["beamWidthPx", "rangePx"] (H7 집속 렌즈) · dmgStat "beamDmgMul" (고압). 옛 countKey/areaKeys 는 폐지.
 *
 * ★ 랜스는 **탄이 아니다**. 정면(화면 위쪽, §1.1)으로 뻗는 폭 beamWidthPx 의 선을 그어 그 안의 적을
 *   **가까운 순으로 pierce 마리**까지 꿴다. hitCooldownSec 0 = 한 발에 한 대상 1회.
 * ★ 진화(레일건) evoFullHeight — 사거리가 아레나 세로 전체가 되고 관통이 무제한이 된다.
 *
 * 슬롯 스크래치: a0 = 발사 주기 타이머(차지 구간 포함) · a1 = 발사 섬광 타이머(렌더 신호)
 *   a0 이 chargeSec 이하인 구간이 «차지»이며(렌더가 그 구간을 그린다), 0 에 닿는 순간 발사한다.
 *   발사 시 a1 = chargeSec 로 세워 drawLance 가 그 동안 밝은 빔을 그린다(즉발 무기의 가시화).
 */

import { hitEnemy, onScreen, targetable } from '../damage.js';
import { stampFor } from '../stance.js';
import { killEnemy } from '../step.js';
import { familyDmgMul } from '../state.js';

const FORWARD = 'forward';

/** §3.1 의 컨텍스트. ★ 모듈 스코프 1회 (§10.3) */
const ctx = { matrix: null, dmgMulSum: 0, elementBonusMul: 1 };

/**
 * 빔 하나. 중심 x = bx, 위로 length 만큼. 가까운 순(= y 가 큰 순)으로 limit 마리까지 적용한다.
 *   ★ 정렬 배열을 만들지 않는다(§10.3 0 alloc): «직전에 맞힌 y 보다 작은 것 중 최대 y» 를 반복해 고른다.
 */
function beam(world, slot, eff, bx, length, limit, stamp) {
  const p = world.player;
  const en = world.enemies.items;
  const halfW = eff.beamWidthPx * 0.5;
  const arena = world.data.rules.view.arena;             // §8.20
  const topY = p.y - length;
  // ★ 커서 = (boundY, boundIdx). y 만으로 진행하면 **같은 y 의 적을 한 명만 맞히고 나머지를 배제**했다
  //   (편대는 한 줄이 정확히 같은 y — lineH/arc 대칭쌍/vWedge 동랭크). idx 동점 처리로 같은 y 안에서
  //   커서가 «전진»하게 해 관통이 그 줄 전부를 때린다(레일건이 한 행을 통째로 관통).
  let boundY = p.y;
  let boundIdx = en.length;
  let hits = 0;

  while (hits < limit) {
    let best = null;
    let bestY = 0;
    let bestIdx = -1;
    for (let i = 0; i < en.length; i += 1) {
      const e = en[i];
      // §8.20 — 오늘의 기하로는 도달 불가지만(빔은 위로 나가고 화면 밖은 항상 더 멀다),
      //   진화(레일건)는 limit = enemies.size 라 매 발 스폰 라인까지 스캔한다. 무예외가 값이다.
      if (!e.alive || !onScreen(arena, e)) continue;
      if (!(e.y < boundY || (e.y === boundY && i > boundIdx))) continue;   // 이미 지난 (y,idx)
      if (e.y < topY) continue;                                            // 사거리 밖
      if (e.x < bx - halfW - e.radius || e.x > bx + halfW + e.radius) continue;
      if (best === null || e.y > bestY || (e.y === bestY && i < bestIdx)) { bestY = e.y; best = e; bestIdx = i; }
    }
    if (best === null) return;
    boundY = bestY; boundIdx = bestIdx;
    // ㊽ 봉인 부위(보호막)는 **통과한다** — 히트 한 칸을 먹지 않는다. §8.11 의 「탄은 통과하고 관통을 소모하지 않는다」와 같은 규칙:
    //   랜스가 보호막에 막혀 뒤의 «부술 수 있는» 모듈에 닿지 못하면, 플레이어가 조준으로 풀 수 없는 벽이 된다.
    if (!targetable(world, best)) continue;
    const dealt = hitEnemy(world, ctx, slot.family, eff.dmg, 1, stamp, best, slot.index);
    if (dealt > 0 && best.hp <= 0) killEnemy(world, best);
    hits += 1;
  }
}

function fire(world, slot, eff) {
  ctx.matrix = world.data.elements.matrix;
  ctx.dmgMulSum = familyDmgMul(world, 'lance');   // §3.1-2항(㊲) 패밀리의 피해 스탯
  ctx.elementBonusMul = world.stats.elementBonusMul;

  const p = world.player;
  const stamp = stampFor(world, slot.index, 'spawn', slot.stampElement);
  const arena = world.data.rules.view.arena;

  let length = eff.rangePx;
  let limit = eff.pierce;
  // ★ slot.evolved 분기 정확히 1개 (§9.5) — 레일건: 아레나 세로 전체 + 무제한 관통
  if (slot.evolved && eff.evoFullHeight) { length = arena.h; limit = world.enemies.size; }

  const n = eff.count;
  // count 개의 평행 빔을 폭 간격으로 정면에 나란히 세운다(count 1 이면 정중앙)
  let bx = p.x - (n - 1) * eff.beamWidthPx * 0.5;
  for (let i = 0; i < n; i += 1) {
    beam(world, slot, eff, bx, length, limit, stamp);
    bx += eff.beamWidthPx;
  }
  // ★ 렌더 신호(§7.4) — 랜스는 즉발이라 «방금 쐈다»를 알릴 흔적이 없다. a1 에 섬광 타이머를
  //   세워(= chargeSec, 리터럴 금지라 파생값) drawLance 가 그 동안 밝은 빔을 그린다.
  slot.a1 = eff.chargeSec;
}

export function update(world, slot, eff, dt) {
  if (eff.targetMode !== FORWARD) {
    throw new Error(`lance: 미구현 targetMode "${eff.targetMode}" — weapons.json 은 forward 만 쓴다 (§9.5)`);
  }
  if (slot.a1 > 0) slot.a1 -= dt;                     // 발사 섬광 타이머 감산(렌더용)
  slot.a0 -= dt;
  if (slot.a0 > 0) return;                            // 차지 구간 포함(a0 ≤ chargeSec 이 «차지»)
  slot.a0 += eff.cooldownSec;
  fire(world, slot, eff);
}

export default { update };
