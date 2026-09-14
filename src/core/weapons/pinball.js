/**
 * src/core/weapons/pinball.js — 핀볼 (§9.5, v1.10 ㉟ 신설)
 *
 * 폐쇄된 파라미터 계약:
 *   base            : dmg cooldownSec count projSpeed projRadius lifetimeSec pierce hitCooldownSec targetMode
 *                     bounceLeft launchDeg
 *   evolution.params: evoSplitOnBounce evoMaxBalls
 *
 * 동사: 무겁고 느린 공을 대각(launchDeg, 좌우 교대)으로 던진다. 공은 벽에 튕기며(bounceLeft, -1 = 무제한) lifetimeSec 동안
 *   남아 관통(-1)·재히트(hitCooldownSec)로 여러 번 때린다 — «오래 남을수록 강하다»(짝 = 장기 배터리).
 *   진화(멀티볼): 벽에 «튕길 때마다» 공이 하나 더 갈라진다(evoSplitOnBounce), 무대의 공 수는 evoMaxBalls 까지.
 *
 * 벽 반사는 step.bounceOffWalls 가 한다(§9.6 v1.7 — 리턴과 같은 규칙). 갈라짐 검출: 탄의 s0 에 직전 vx 부호를 두고
 *   부호가 뒤집힌 틱에 갈라진다(반사 이벤트를 따로 두지 않는다 — 부호 뒤집힘 = 좌우 벽 반사).
 * 훅: 값(rateKey · countKey · pierceApplies · 배율 목록)은 rules.passiveHooks.pinball 이 소유한다 — 여기 옮겨 적지 않는다(옮겨 적은 speedKeys [projSpeed] 가 낡아 있었다, ㊵)
 * 스크래치: cooldownT · a0 = 좌우 교대 부호. 탄: s0 = 직전 vx 부호 · s1 = 갈라진 공 표식(1)
 * 레퍼런스: 알카노이드 멀티볼 · 뱀서 룬트레이서(벽 반사 관통)
 */

import { DEG2RAD } from '../angle.js';
import { spawnPlayerBullet } from '../state.js';

const FORWARD = 'forward';
const SPLIT = 1;

function launch(world, slot, eff, ox, oy, sign, split) {
  const r = eff.launchDeg * DEG2RAD;
  const b = spawnPlayerBullet(world, slot, eff, ox, oy, Math.sin(r) * eff.projSpeed * sign, -Math.cos(r) * eff.projSpeed, 1);
  if (b === null) return null;
  b.s0 = sign;                                   // 직전 vx 부호
  b.s1 = split ? SPLIT : 0;
  return b;
}

/** 무대의 이 슬롯 공 수 (evoMaxBalls 상한용) */
function liveBalls(world, slot) {
  const it = world.playerBullets.items;
  let n = 0;
  for (let i = 0; i < it.length; i += 1) if (it[i].alive && it[i].slot === slot.index) n += 1;
  return n;
}

export function update(world, slot, eff, dt) {
  if (eff.targetMode !== FORWARD) {
    throw new Error(`pinball: 계약 밖의 targetMode "${eff.targetMode}" — 허용 = forward (§9.5)`);
  }
  // ★ w.evolved 분기 정확히 1개 — 멀티볼: 좌우 벽 반사(vx 부호 뒤집힘)마다 공이 하나 더
  if (slot.evolved && eff.evoSplitOnBounce === true) {
    const it = world.playerBullets.items;
    for (let i = 0; i < it.length; i += 1) {
      const b = it[i];
      if (!b.alive || b.slot !== slot.index) continue;
      const sign = b.vx >= 0 ? 1 : -1;
      if (b.s0 !== 0 && sign !== b.s0 && liveBalls(world, slot) < eff.evoMaxBalls) {
        const c = launch(world, slot, eff, b.x, b.y, -sign, true);
        if (c !== null) c.age = b.age;             // 같은 남은 수명 — 무한 증식 방지(수명이 상한)
      }
      b.s0 = sign;
    }
  }
  slot.cooldownT -= dt;
  if (slot.cooldownT > 0) return;
  slot.cooldownT += eff.cooldownSec;
  const p = world.player;
  if (slot.a0 === 0) slot.a0 = 1;
  for (let k = 0; k < eff.count; k += 1) {
    // 진화면 evoMaxBalls 는 «무대의 공 수» 상한 — 새 투척도 그 안에서만(갈라짐만 막으면 자연 투척이 상한을 넘긴다)
    if (slot.evolved && liveBalls(world, slot) >= eff.evoMaxBalls) break;
    launch(world, slot, eff, p.x, p.y, slot.a0, false);
    slot.a0 = -slot.a0;                          // 좌우 교대
  }
}

export default { update };
