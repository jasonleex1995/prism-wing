/**
 * src/core/weapons/beam.js — 빔 (§9.5, v1.10 ㉟ 신설)
 *
 * 폐쇄된 파라미터 계약:
 *   base            : dmg count pierce hitCooldownSec targetMode rangePx beamWidthPx
 *   evolution.params: evoSplitCount evoSplitDmgMul evoSplitRangePx
 *
 * 동사: 가장 가까운 «보이는» 적에게 얇은 레이저를 «계속» 댄다. 표적이 rangePx 안에 있는 동안 hitCooldownSec 마다 dmg.
 *   표적이 죽거나 나가면 «다음 틱»에 다음 표적(재조준 지연 없음). count 는 동시에 대는 빔 수(서로 다른 표적).
 *   pierce: 빔은 표적을 «뚫고» 같은 직선 위(폭 beamWidthPx)의 뒤 적을 pierce 마리까지 더 때린다 — 짝 = 관통 코팅.
 *   진화(프리즘 빔): 빔이 «맞은 적»(각 빔의 표적)에서 evoSplitCount 갈래로 갈라져 그 적 주변 evoSplitRangePx 안의 다른 적에게
 *   dmg × evoSplitDmgMul — 프리즘 윙의 프리즘.
 *
 * 렌더 신호: slot.a0 = 표적 idx(-1 없음) · slot.a2 = 표적 gen · 두 번째 빔은 world.beamFx(§7.4 ㉟ draw.drawBeams 가 읽는다).
 *   — count 1 일 때 슬롯 스크래치만으로 그리고, 여러 빔·갈래는 beamFx 링(짧은 수명)에 선분을 남긴다.
 * 훅(㊲ 빔 분류): rateKey hitCooldownSec · countKey null · pierceApplies false(관통은 레벨 표) · beamKeys [beamWidthPx, rangePx] · dmgStat beamDmgMul
 * 탄이 없다(hitEnemy 직접). 스크래치: a0 = 표적 idx · a1 = 틱 타이머 · a2 = 표적 gen
 * 레퍼런스: 동방 마스터 스파크(지속 빔) · 홀로큐어 BL 북(자동 조준 빔)
 */

import { hitEnemy, targetable } from '../damage.js';
import { stampFor } from '../stance.js';
import { killEnemy, pushChainFx } from '../step.js';
import { familyDmgMul } from '../state.js';

const NEAREST = 'nearest';
const NONE = -1;

const ctx = { matrix: null, dmgMulSum: 0, elementBonusMul: 1 };

function nearest(world, x, y, radius, epoch) {
  const en = world.enemies.items;
  let best = NONE;
  let bestD = radius * radius;
  for (let i = 0; i < en.length; i += 1) {
    const e = en[i];
    if (!targetable(world, e)) continue;               // ㊽ 봉인·전환 무적 = «맞힐 수 없는 것»은 조준하지 않는다
    if (e.chainEpoch === epoch) continue;
    const dx = e.x - x;
    const dy = e.y - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** 관통 — (px,py)→(tx,ty) 직선을 표적 너머로 연장해 폭 안·사거리 안의 적을 «가까운 순»으로 pierce 마리 때린다 */
function pierceRay(world, slot, eff, stamp, px, py, tx, ty, epoch) {
  const en = world.enemies.items;
  let dx = tx - px; let dy = ty - py;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len <= 0) return;
  dx /= len; dy /= len;
  const halfW = eff.beamWidthPx * 0.5;
  let hits = 0;
  let boundT = len;                                    // 표적보다 뒤(투영 t 가 큰) 적만
  while (hits < eff.pierce) {
    let best = NONE; let bestT = eff.rangePx;
    for (let i = 0; i < en.length; i += 1) {
      const e = en[i];
      if (!targetable(world, e) || e.chainEpoch === epoch) continue;   // ㊽
      const ox = e.x - px; const oy = e.y - py;
      const t = ox * dx + oy * dy;
      if (t <= boundT || t > eff.rangePx) continue;
      const perp = Math.abs(ox * dy - oy * dx);
      if (perp > halfW + e.radius) continue;
      if (t < bestT) { bestT = t; best = i; }
    }
    if (best === NONE) return;
    const e = en[best];
    e.chainEpoch = epoch;
    boundT = bestT;
    const d = hitEnemy(world, ctx, slot.family, eff.dmg, 1, stamp, e, slot.index);
    pushChainFx(world, tx, ty, e.x, e.y, stamp);
    if (d > 0 && e.hp <= 0) killEnemy(world, e);
    hits += 1;
  }
}

/** 한 틱의 «댐» — 빔 count 개가 서로 다른 표적을 잡고, 각각 hitCooldownSec 마다 때린다. 갈래는 진화. */
function tick(world, slot, eff) {
  ctx.matrix = world.data.elements.matrix;
  ctx.dmgMulSum = familyDmgMul(world, 'beam');   // §3.1-2항(㊲) 패밀리의 피해 스탯
  ctx.elementBonusMul = world.stats.elementBonusMul;
  const p = world.player;
  const en = world.enemies.items;
  const stamp = stampFor(world, slot.index, 'spawn', slot.stampElement);
  world.chainEpoch += 1;
  const epoch = world.chainEpoch;
  // 첫 빔은 슬롯이 기억하는 표적을 유지(안 죽었고 사거리 안이면) — 빔이 표적 사이를 «튀지» 않는다
  let first = slot.a0;
  if (first !== NONE) {
    const e = en[first];
    const dx = e.x - p.x; const dy = e.y - p.y;
    // ㊽ 표적 유지도 같은 판단 — 보호막이 켜지면(모듈이 봉인되면) 그 자리에서 표적을 놓는다
    if (e.gen !== slot.a2 || !targetable(world, e) || dx * dx + dy * dy > eff.rangePx * eff.rangePx) first = NONE;
  }
  if (first === NONE) first = nearest(world, p.x, p.y, eff.rangePx, epoch);
  slot.a0 = first;
  slot.a2 = first === NONE ? NONE : en[first].gen;
  if (first === NONE) return;
  for (let k = 0; k < eff.count; k += 1) {
    const idx = k === 0 ? first : nearest(world, p.x, p.y, eff.rangePx, epoch);
    if (idx === NONE) return;
    const e = en[idx];
    e.chainEpoch = epoch;
    const dealt = hitEnemy(world, ctx, slot.family, eff.dmg, 1, stamp, e, slot.index);
    if (k > 0) pushChainFx(world, p.x, p.y, e.x, e.y, stamp);             // 첫 빔은 슬롯 스크래치로 그린다(drawBeams)
    const ex = e.x; const ey = e.y;
    if (dealt > 0 && e.hp <= 0) killEnemy(world, e);
    // 관통 — 표적 뒤 같은 직선(폭 beamWidthPx)의 적을 pierce 마리까지(가까운 순). 사거리 rangePx 는 표적 기준이 아니라 원점 기준.
    if (eff.pierce > 0) pierceRay(world, slot, eff, stamp, p.x, p.y, ex, ey, epoch);
    // ★ w.evolved 분기 정확히 1개 — 프리즘: 맞은 적(이 빔의 표적)에서 갈래 — 관통으로 꿴 적에서는 갈라지지 않는다
    if (slot.evolved) {
      for (let s2 = 0; s2 < eff.evoSplitCount; s2 += 1) {
        const j = nearest(world, ex, ey, eff.evoSplitRangePx, epoch);
        if (j === NONE) break;
        const t = en[j];
        t.chainEpoch = epoch;
        const d2 = hitEnemy(world, ctx, slot.family, eff.dmg, eff.evoSplitDmgMul, stamp, t, slot.index);
        pushChainFx(world, ex, ey, t.x, t.y, stamp);
        if (d2 > 0 && t.hp <= 0) killEnemy(world, t);
      }
    }
  }
}

export function update(world, slot, eff, dt) {
  if (eff.targetMode !== NEAREST) {
    throw new Error(`beam: 계약 밖의 targetMode "${eff.targetMode}" — 허용 = nearest (§9.5)`);
  }
  slot.a1 -= dt;
  if (slot.a1 > 0) return;
  slot.a1 += eff.hitCooldownSec;
  tick(world, slot, eff);
}

export default { update };
