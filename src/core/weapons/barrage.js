/**
 * src/core/weapons/barrage.js — 바라지 (§9.5)
 *
 * 폐쇄된 파라미터 계약 (§9.5 12행 표):
 *   base            : dmg cooldownSec targetMode strikeIntervalSec strikesPerVolley
 *                     blastRadius telegraphSec
 *   evolution.params: evoRadiusMul
 *
 * §9.6.1 훅은 state.recomputeEff 가 이미 적용했다:
 *   rateKey "cooldownSec" (H1) · countKey null(㊲ — 포격 수는 레벨 표) · pierceApplies false
 *   areaKeys ["blastRadius"] (H2 확장 코일) · dmgStat "areaDmgMul" (충격파)
 *
 * ★ 착탄은 **예고 뒤에 온다** — telegraphs 풀에 kind 'strike' 로 예고를 놓고(§7.4 의 예고 어휘와
 *   같은 자리), telegraphSec 이 지나면 그 자리에서 폭발시킨다. step.hazards 는 'laser' 만 소유하므로
 *   이 예고의 수명·반납은 **이 파일이 소유**한다(§12.1 — 새 풀을 만들지 않는다).
 * ★ 조준: 기본은 randomInArena(rng.pattern — 정본이 플레이어 무기에 허용한 유일한 스트림, §9.5).
 *   진화(오비탈 스트라이크)는 **가장 밀집한 곳**을 노리고 반경이 evoRadiusMul 배가 된다.
 *
 * 슬롯 스크래치: a0 = 다음 볼리까지 / a1 = 이번 볼리의 남은 착탄 수 / a2 = 다음 착탄까지
 */

import { spawnTelegraph, familyDmgMul } from '../state.js';
import { hitEnemy, targetable } from '../damage.js';
import { stampFor } from '../stance.js';
import { killEnemy } from '../step.js';

const RANDOM_IN_ARENA = 'randomInArena';
const DENSEST = 'densest';
const STRIKE = 'strike';
const HIT = 'barrageHit';        // §7.12(v1.7) 착탄 연출용 kind

/** §3.1 의 컨텍스트. ★ 모듈 스코프 1회 (§10.3) */
const ctx = { matrix: null, dmgMulSum: 0, elementBonusMul: 1 };
const _at = { x: 0, y: 0 };

/**
 * 착탄 지점. targetMode 'densest' 면 «그 반경 안 이웃이 가장 많은 적», 아니면 아레나 무작위.
 *   ★ densest 는 **레벨 8 이 targetMode 로 바꾼다**(진화 플래그가 아니라 계약 값이 정한다).
 */
function aim(world, slot, eff, r, out) {
  const a = world.data.rules.view.arena;
  if (eff.targetMode === DENSEST) {
    const en = world.enemies.items;
    let best = null;
    let bestN = 0;
    for (let i = 0; i < en.length; i += 1) {
      const e = en[i];
      // §8.20 — 착탄 «중심»은 보이는 적이어야 한다. 가장 빽빽한 무리는 언제나 방금 태어난
      //   편대이고 그 편대는 스폰 라인 = 화면 밖에 선다(실측: 볼리가 493.8px 밖 유령 편대
      //   한복판에 떨어졌다). 이웃을 «세는» 안쪽 루프는 일부러 그대로 둔다 — 들어오는 웨이브
      //   쪽으로 기우는 편향은 조준으로서 옳다.
      if (!targetable(world, e)) continue;               // ㊽ 봉인 부위 한복판에 볼리를 떨구지 않는다
      let n = 0;
      for (let j = 0; j < en.length; j += 1) {
        const o = en[j];
        if (!o.alive) continue;
        const dx = o.x - e.x;
        const dy = o.y - e.y;
        if (dx * dx + dy * dy <= r * r) n += 1;
      }
      if (best === null || n > bestN) { bestN = n; best = e; }
    }
    if (best !== null) { out.x = best.x; out.y = best.y; return out; }
  }
  out.x = a.x + world.rng.pattern.f() * a.w;
  out.y = a.y + world.rng.pattern.f() * a.h;
  return out;
}

/** 예고가 익으면 그 자리에서 폭발. */
function detonate(world, slot, eff, x, y, r) {
  ctx.matrix = world.data.elements.matrix;
  ctx.dmgMulSum = familyDmgMul(world, 'barrage');   // §3.1-2항(㊲) 패밀리의 피해 스탯
  ctx.elementBonusMul = world.stats.elementBonusMul;
  const stamp = stampFor(world, slot.index, 'spawn', slot.stampElement);
  const en = world.enemies.items;
  for (let i = 0; i < en.length; i += 1) {
    const e = en[i];
    if (!e.alive) continue;
    const dx = e.x - x;
    const dy = e.y - y;
    if (dx * dx + dy * dy > r * r) continue;
    const dealt = hitEnemy(world, ctx, slot.family, eff.dmg, 1, stamp, e, slot.index);
    // §2.7(v1.7) 바라지의 동사 = «개체 이동 감속». 착탄 지점의 적이 느려진다.
    //   v1.5 부터 공급자가 없어 죽어 있던 e.slowSec 에 드디어 주인이 생긴다.
    //   ★ stackMode "refresh"(§2.7) — 그냥 대입하면 긴 잔여를 짧은 신규가 덮어써 overwrite 가 된다.
    //   ★ ccImmune 은 여기서 막힌다. 피해는 그대로 들어가고 «제어만» 무효다.
    if (!e.ccImmune && eff.slowSec > e.slowSec) e.slowSec = eff.slowSec;
    if (dealt > 0 && e.hp <= 0) killEnemy(world, e);
  }
}

export function update(world, slot, eff, dt) {
  if (eff.targetMode !== RANDOM_IN_ARENA && eff.targetMode !== DENSEST) {
    throw new Error(`barrage: 미구현 targetMode "${eff.targetMode}" — 계약 = randomInArena | densest (§9.5)`);
  }
  // ★ slot.evolved 분기 정확히 1개 (§9.5) — 오비탈 스트라이크: 반경 확대
  const radius = slot.evolved ? eff.blastRadius * eff.evoRadiusMul : eff.blastRadius;

  // ── 익은 예고를 터뜨린다(이 무기가 소유) ─────────────────────────────────
  const ts = world.telegraphs.items;
  for (let i = 0; i < ts.length; i += 1) {
    const t = ts[i];
    if (!t.alive || t.kind !== STRIKE) continue;
    if (t.age < t.durSec) continue;
    detonate(world, slot, eff, t.x, t.y, t.r);
    // §7.12(v1.7) 착탄 연출 — v1.6 까지 예고 원이 «소리 없이 사라졌다». 맞았는지 안 맞았는지가
    //   화면에 없어서 「공격한다는 느낌이 없다」가 됐다(플레이 피드백).
    //   풀도 필드도 늘리지 않는다: 같은 텔레그래프의 kind 를 «명중»으로 바꿔 짧게 남긴다.
    t.kind = HIT;
    t.age = 0;
    t.durSec = eff.impactFlashSec;
  }

  // ── 착탄 연출이 끝난 것을 반납한다(이 무기가 소유) ──────────────────────
  for (let i = 0; i < ts.length; i += 1) {
    const t = ts[i];
    if (t.alive && t.kind === HIT && t.age >= t.durSec) world.telegraphs.release(t);
  }
  
  // ── 볼리 스케줄 — cooldownSec 마다 strikesPerVolley 발, 간격 strikeIntervalSec ──
  if (slot.a1 <= 0) {
    slot.a0 -= dt;
    if (slot.a0 <= 0) { slot.a0 += eff.cooldownSec; slot.a1 = eff.strikesPerVolley; slot.a2 = 0; }
  }
  if (slot.a1 <= 0) return;

  slot.a2 -= dt;
  if (slot.a2 > 0) return;
  slot.a2 += eff.strikeIntervalSec;
  slot.a1 -= 1;

  aim(world, slot, eff, radius, _at);
  // 예고를 놓는다 — r 에 폭발 반경, durSec 에 예고 시간. 익으면 위에서 터진다
  spawnTelegraph(world, STRIKE, _at.x, _at.y, radius, eff.telegraphSec, slot.index);
}

export default { update };
