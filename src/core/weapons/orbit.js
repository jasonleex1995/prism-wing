/**
 * src/core/weapons/orbit.js — 오빗 (§9.5)
 *
 * 폐쇄된 파라미터 계약 (§9.5 12행 표):
 *   base            : dmg hitCooldownSec projRadius orbitRadius angularSpeedDegSec bodyCount
 *   evolution.params: evoGuardBodies
 *
 * §9.6.1 훅은 state.recomputeEff 가 이미 적용했다:
 *   rateKey "hitCooldownSec" (H1) · countKey null(㊲ — 구체 수는 레벨 표) · pierceApplies false
 *   orbitKeys ["orbitRadius", "projRadius", "angularSpeedDegSec"] (H8 궤도 확장) · dmgStat "orbitMul"(구체 피해도 궤도 확장)
 *
 * ★ 표현의 선택 — 공전체는 **playerBullets 풀의 «정지한 탄»**이다. 이유: 그 풀만이 적 슬롯별
 *   재히트 기록(hitStamp/hitAt/hitGen)을 이미 들고 있고, §9.5 의 hitCooldownSec(대상별 재타격 간격)이
 *   정확히 그 기록을 요구한다. 새 풀도, collide 의 새 분기도 필요 없다.
 *   - 매 틱 위치를 궤도 위로 **직접** 세팅하고 age 를 0 으로 되돌린다 → 수명으로 사라지지 않는다.
 *   - pierceLeft = -1 (무제한) → 한 대상을 때려도 소멸하지 않는다.
 *   - stampMode 는 weaponDefs 가 'live' 를 주므로 collide 가 **적용 순간의 스탠스**를 재평가한다(§4.4).
 *
 * 슬롯 스크래치: a0 = 공전 각(rad)   ·   탄 스크래치: s0 = 1 이면 «방패 공»(이지스)
 */

import { spawnPlayerBullet } from '../state.js';
import { DEG2RAD, TAU } from '../angle.js';

/** 이 family 의 살아있는 공전체 수 */
function bodyCount(world, slot) {
  const it = world.playerBullets.items;
  let n = 0;
  for (let i = 0; i < it.length; i += 1) if (it[i].alive && it[i].family === slot.family) n += 1;
  return n;
}

/** 부족한 만큼 공전체를 만든다. 탄이지만 «날지 않는» 탄이다. */
function ensureBodies(world, slot, eff) {
  const p = world.player;
  let have = bodyCount(world, slot);
  while (have < eff.bodyCount) {
    const b = spawnPlayerBullet(world, slot, eff, p.x, p.y, 0, 0, 1);
    if (b === null) return;                       // §12.1 rejectSpawn — 다음 틱에 다시 시도
    b.pierceLeft = -1;                            // 무제한: 때려도 소멸하지 않는다
    b.lifetimeSec = eff.hitCooldownSec;           // age 를 매 틱 0 으로 되돌리므로 만료되지 않는다
    b.age = 0;
    b.anchored = true;                            // §9.5(v1.7) 아레나 이탈 컬링 면제 — 벽에 붙어도 링이 안 깨진다
    have += 1;
  }
}

/** 궤도 위에 균등 배치하고 나이를 되돌린다(수명·이탈로 사라지지 않게). */
function place(world, slot, eff) {
  const p = world.player;
  const it = world.playerBullets.items;
  const n = eff.bodyCount;
  // ㊿-n — 앞선 evoGuardBodies 개가 «방패 공»이다. 비진화면 0개. 렌더도 이 표시(s0)를 읽는다.
  const guard = slot.evolved ? eff.evoGuardBodies : 0;
  let k = 0;
  for (let i = 0; i < it.length; i += 1) {
    const b = it[i];
    if (!b.alive || b.family !== slot.family) continue;   // §5.3 family-키로만 식별
    b.s0 = k < guard ? 1 : 0;
    const a = slot.a0 + (k / n) * TAU;
    b.x = p.x + Math.cos(a) * eff.orbitRadius;
    b.y = p.y + Math.sin(a) * eff.orbitRadius;
    b.vx = 0; b.vy = 0;
    b.age = 0;
    // ★ 공전체는 영속(수명 없음)이라 스폰 때 각인한 dmg/반경/쿨다운이 **레벨업해도 안 갱신**됐다 —
    //   기존 공전체가 Lv1 수치로 굳었다. 매 틱 현재 eff 로 다시 각인해 레벨 성장이 반영되게 한다.
    b.dmg = eff.dmg;
    b.radius = eff.projRadius;
    b.hitCooldownSec = eff.hitCooldownSec;
    k += 1;
  }
}

/**
 * 진화(이지스) — **지정된 «방패 공»에 닿은 적 탄을 지운다. 매 틱, 쿨다운 없음.**
 *   ★ v1.10 ㊿-n 사용자(2026-09-08): 「이지스가 탄을 지운다는 게 쿨타임이 있는 걸까? 어떤 게 탄을 지우는지
 *     알기가 어려워. 차라리 공 5개 중에서 1개가 탄을 지우는 역할을 한다든지 하는 게 좋지 않을까.」
 *   ㊿-n 이전: 1초 쿨다운으로 «전체 공»이 한 번씩 훑었다 → 어느 공이, 언제 지우는지 화면이 말하지 않았고
 *     탄이 공 위에 최대 1초 얹혀 있다 사라졌다(실측 DPS 기여 0%: 진화해도 화력이 그대로였다).
 *   ㊿-n 이후: 앞선 `evoGuardBodies` 개만 방패이고 **접촉 즉시** 지운다. 렌더가 그 공에 링을 둘러 «이 공이 방패»라고 말한다.
 *     규칙이 눈에 보이므로 「방패 공을 탄 쪽으로 돌려 놓는다」는 조작이 처음으로 성립한다.
 */
function aegis(world, slot) {
  const it = world.playerBullets.items;
  const eb = world.enemyBullets.items;
  for (let i = 0; i < it.length; i += 1) {
    const b = it[i];
    if (!b.alive || b.family !== slot.family || b.s0 !== 1) continue;   // 방패 공만
    for (let j = 0; j < eb.length; j += 1) {
      const g = eb[j];
      if (!g.alive) continue;
      const dx = g.x - b.x;
      const dy = g.y - b.y;
      const rr = b.radius + g.hitRadius;
      if (dx * dx + dy * dy <= rr * rr) world.enemyBullets.release(g);
    }
  }
}

export function update(world, slot, eff, dt) {
  slot.a0 += eff.angularSpeedDegSec * DEG2RAD * dt;
  if (slot.a0 > TAU) slot.a0 -= TAU;              // 유계 유지(장시간 런의 부동소수 방어)

  ensureBodies(world, slot, eff);
  place(world, slot, eff);

  // ★ slot.evolved 분기 정확히 1개 (§9.5)
  if (slot.evolved) aegis(world, slot);
}

export default { update };
