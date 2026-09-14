/**
 * src/core/weapons/chain.js — 체인 라이트닝 (§9.5, v1.10 ㉟ 신설)
 *
 * 폐쇄된 파라미터 계약:
 *   base            : dmg cooldownSec count hitCooldownSec targetMode acquireRadius chainRangePx chainCount chainDmgMul
 *   evolution.params: evoForkOnSuper evoChainCountMul
 *
 * 동사: cooldownSec 마다 «즉발». 플레이어에서 acquireRadius 안의 가장 가까운 적을 때리고, 거기서 chainRangePx 안의
 *   다음 적으로 chainCount 번 튄다(한 번 맞은 적은 이 볼리에서 다시 안 맞는다). 홉마다 피해 × chainDmgMul 누적.
 *   count > 1 이면 서로 다른 첫 표적에서 count 줄기가 출발한다.
 *   진화(폭풍): 연쇄 수 × evoChainCountMul, 그리고 상성 ×2 로 맞은 적에서는 줄기가 «둘로 갈라진다»(evoForkOnSuper).
 *
 * 렌더 신호: world.chainFx(§7.4 ㉟ — 선분 링, draw.drawChainFx) 에 홉마다 선분 1개 + 짧은 수명(cooldownSec 의 절반).
 * 훅(㊲ 빔 분류): rateKey cooldownSec · countKey null · pierceApplies false · beamKeys [chainRangePx, acquireRadius] · dmgStat beamDmgMul
 * 탄이 없다(hitEnemy 직접). 스크래치: cooldownT 만. 레퍼런스: 뱀서 번개 반지 · 디아블로 체인 라이트닝
 */

import { hitEnemy, targetable } from '../damage.js';
import { hitTier } from '../elements.js';
import { stampFor } from '../stance.js';
import { killEnemy, pushChainFx } from '../step.js';
import { familyDmgMul } from '../state.js';

const NEAREST = 'nearest';

const ctx = { matrix: null, dmgMulSum: 0, elementBonusMul: 1 };

/** (x, y) 에서 radius 안의 가장 가까운 «보이는» 적 — visited 표식(epoch) 이 찍힌 적은 제외 */
function nearest(world, x, y, radius, epoch) {
  const en = world.enemies.items;
  let best = -1;
  let bestD = radius * radius;
  for (let i = 0; i < en.length; i += 1) {
    const e = en[i];
    if (!targetable(world, e)) continue;               // ㊽
    if (e.chainEpoch === epoch) continue;
    const dx = e.x - x;
    const dy = e.y - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** 한 줄기 — 시작점에서 hops 번 튄다. 갈라짐(fork)은 재귀 깊이 1 로 제한(무한 분기 방지) */
function bolt(world, slot, eff, stamp, sx, sy, first, hops, mul, epoch, canFork) {
  const en = world.enemies.items;
  let x = sx; let y = sy; let idx = first; let m = mul;
  for (let h = 0; h < hops && idx >= 0; h += 1) {
    const e = en[idx];
    e.chainEpoch = epoch;
    const dealt = hitEnemy(world, ctx, slot.family, eff.dmg, m, stamp, e, slot.index);
    pushChainFx(world, x, y, e.x, e.y, stamp);
    const forked = canFork && hitTier(ctx.matrix, stamp, e.element) === 'super';
    const ex = e.x; const ey = e.y;
    if (dealt > 0 && e.hp <= 0) killEnemy(world, e);
    x = ex; y = ey;
    m *= eff.chainDmgMul;
    idx = nearest(world, x, y, eff.chainRangePx, epoch);
    if (forked && idx >= 0) {
      // 갈라짐(폭풍) — 이 줄기가 «이미 골라 둔» 다음 표적을 잠그고 «그다음» 표적으로 두 번째 줄기를 보낸다.
      //   같은 epoch 를 쓰므로 두 줄기가 한 적을 두 번 맞히지 않는다. 재귀 깊이 1(두 번째 줄기는 다시 갈라지지 않는다).
      const nextE = en[idx];
      //   ★ ㊿-zc — 이 잠금은 **끝까지 유지한다**. ~~nextE.chainEpoch = 0;~~ 으로 되돌려 놓으면
      //   두 번째 줄기가 이 적을 다시 고르고, 그 뒤 이 줄기가 같은 적을 한 번 더 때린다 —
      //   바로 위 줄이 못박은 「한 적을 두 번 맞히지 않는다」가 그 자리에서 깨진다(실측: 홉 10 · 맞은 적 9).
      //   푸는 바람에 잃는 것도 없다 — 이 줄기는 다음 바퀴 첫 줄에서 스스로 epoch 를 다시 찍는다.
      //   ★ 이 잠금이 «시체를 때리지 않는다»의 유일한 장치이기도 하다 — 잠긴 nextE 는 두 번째 줄기가
      //   고를 수 없으니 죽을 수 없고, nearest 는 targetable(=alive) 로 이미 거른다. 그래서 alive 가드가 없다.
      nextE.chainEpoch = epoch;
      const second = nearest(world, x, y, eff.chainRangePx, epoch);
      if (second >= 0) bolt(world, slot, eff, stamp, x, y, second, hops - h - 1, m, epoch, false);
    }
  }
}

function fire(world, slot, eff) {
  ctx.matrix = world.data.elements.matrix;
  ctx.dmgMulSum = familyDmgMul(world, 'chain');   // §3.1-2항(㊲) 패밀리의 피해 스탯
  ctx.elementBonusMul = world.stats.elementBonusMul;
  const p = world.player;
  const stamp = stampFor(world, slot.index, 'spawn', slot.stampElement);
  // 볼리 epoch — 적의 chainEpoch 와 비교해 «이 볼리에서 이미 맞은 적»을 가른다(배열 초기화 0 alloc)
  world.chainEpoch += 1;
  const epoch = world.chainEpoch;
  let hops = eff.chainCount;
  let fork = false;
  if (slot.evolved) { hops = Math.round(hops * eff.evoChainCountMul); fork = eff.evoForkOnSuper === true; }
  for (let k = 0; k < eff.count; k += 1) {
    const first = nearest(world, p.x, p.y, eff.acquireRadius, epoch);
    if (first < 0) return;
    bolt(world, slot, eff, stamp, p.x, p.y, first, hops, 1, epoch, fork);
  }
}

export function update(world, slot, eff, dt) {
  if (eff.targetMode !== NEAREST) {
    throw new Error(`chain: 계약 밖의 targetMode "${eff.targetMode}" — 허용 = nearest (§9.5)`);
  }
  slot.cooldownT -= dt;
  if (slot.cooldownT > 0) return;
  slot.cooldownT += eff.cooldownSec;
  fire(world, slot, eff);
}

export default { update };
