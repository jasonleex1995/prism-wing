/**
 * src/core/weapons/nova.js — 노바 (§9.5)
 *
 * 폐쇄된 파라미터 계약 (§9.5 12행 표):
 *   base            : dmg intervalSec radius expandSec telegraphSec actionSlowSec
 *   evolution.params: evoRing2Radius evoSecondaryDmgMul evoActionSlowSec
 *
 * §9.6.1 훅은 state.recomputeEff 가 이미 적용했다:
 *   rateKey "intervalSec" (H1) · countKey **null** · pierceApplies false
 *   areaKeys ["radius", "evoRing2Radius"] — 2단 링도 areaMul 을 받는다(진화 시에만 존재) · dmgStat "areaDmgMul" (충격파, ㊲)
 *
 * ★ expandSec·telegraphSec 는 **연출의 시간**이다. 판정은 §8.5 와 같은 「적용 1회」이며 폭발 시점에
 *   한 번 적용한다 — 확장 애니메이션은 렌더의 몫이고 core 의 판정을 나누지 않는다.
 * ★ 진화(슈퍼노바)는 2단 링(evoRing2Radius, dmg × evoSecondaryDmgMul)과 **더 긴 행동 감속**을 더한다.
 *
 * 슬롯 스크래치: a0 = 다음 폭발까지 남은 시간
 */

import { hitEnemy } from '../damage.js';
import { stampFor } from '../stance.js';
import { killEnemy } from '../step.js';
import { familyDmgMul } from '../state.js';

/** §3.1 의 컨텍스트. ★ 모듈 스코프 1회 (§10.3) */
const ctx = { matrix: null, dmgMulSum: 0, elementBonusMul: 1 };

/** 반경 r 안의 적에게 dmg × localMul 을 1회 적용하고, 행동 감속 slowSec 을 건다. */
function ring(world, slot, eff, r, localMul, stamp, slowSec) {
  const p = world.player;
  const en = world.enemies.items;
  for (let i = 0; i < en.length; i += 1) {
    const e = en[i];
    if (!e.alive) continue;
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    if (dx * dx + dy * dy > r * r) continue;
    const dealt = hitEnemy(world, ctx, slot.family, eff.dmg, localMul, stamp, e, slot.index);
    // §2.7(v1.7) 노바의 동사 = «행동 감속». 이동이 아니라 발사 주기를 늘린다(emitters.js 가 읽는다).
    //   ★ 이동 감속으로 하면 둘이 동시에 깨진다: ① 바라지와 동사가 겹치고
    //      ② 제자리에서 쏘는 anchor 3종(turretPod·mortarHulk·frostLance)에게 문자 그대로 무효다.
    //   ★ refresh 계약 · ccImmune 게이트는 바라지와 대칭.
    if (!e.ccImmune && slowSec > e.actionSlowSec) e.actionSlowSec = slowSec;
    if (dealt > 0 && e.hp <= 0) killEnemy(world, e);
  }
}

function detonate(world, slot, eff) {
  ctx.matrix = world.data.elements.matrix;
  ctx.dmgMulSum = familyDmgMul(world, 'nova');   // §3.1-2항(㊲) 패밀리의 피해 스탯
  ctx.elementBonusMul = world.stats.elementBonusMul;

  const stamp = stampFor(world, slot.index, 'spawn', slot.stampElement);
  ring(world, slot, eff, eff.radius, 1, stamp, eff.actionSlowSec);

  // ★ slot.evolved 분기 정확히 1개 (§9.5) — 2단 링이 더 멀리 닿고, 닿은 적은 더 오래 굳는다.
  //   §9.5(v1.7) 「확산 링이 적 탄을 지운다」는 폐기했다 — 오빗 진화(이지스)의 동사와 겹쳤고,
  //   한 무기가 동사 하나를 독점한다는 원칙이 깨지면 유틸 2칸을 나눠 쓸 이유가 사라진다.
  if (slot.evolved) {
    ring(world, slot, eff, eff.evoRing2Radius, eff.evoSecondaryDmgMul, stamp, eff.evoActionSlowSec);
  }
}

export function update(world, slot, eff, dt) {
  slot.a0 -= dt;
  if (slot.a0 > 0) return;
  slot.a0 += eff.intervalSec;
  detonate(world, slot, eff);
}

export default { update };
