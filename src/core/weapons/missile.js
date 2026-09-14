/**
 * src/core/weapons/missile.js — 미사일 (§9.5, v1.10 ㉟ 신설 — 속성 무기 10종 확장)
 *
 * 폐쇄된 파라미터 계약:
 *   base            : dmg cooldownSec count projSpeed projRadius lifetimeSec pierce hitCooldownSec targetMode
 *                     blastRadius spreadDeg
 *   evolution.params: evoClusterCount evoClusterDmgMul
 *
 * 동사: 느린 로켓을 정면으로 쏜다(count 발, spreadDeg 부채). 탄이 «어디서든 사라지는 순간»(적에 맞아 소멸·수명 끝)
 *   blastRadius 안의 적 전부에 dmg — 폭발 그 자체가 무기라 pierce 는 0 이다(첫 적에 닿으면 터진다).
 *   진화(클러스터): 폭발 자리에서 evoClusterCount 발의 자탄이 부채로 다시 퍼져 각각 dmg × evoClusterDmgMul 로 터진다.
 *   자탄은 다시 갈라지지 않는다(b.s0 = 1 표식).
 *
 * 훅(§9.6.1): rateKey cooldownSec · countKey count · pierceApplies false · areaKeys [blastRadius](확장 코일 = 범위)
 *   · speedKeys [projSpeed] · durationKeys [lifetimeSec]
 * 스크래치: cooldownT 만. 탄: s0 = 자탄 표식(1) · s1 = 폭발 배율(자탄은 evoClusterDmgMul)
 * 레퍼런스: 뱀서 불 지팡이(느린 큰 탄 + 폭발) · 브로타토 로켓
 */

import { DEG2RAD } from '../angle.js';
import { spawnPlayerBullet, familyDmgMul } from '../state.js';
import { hitEnemy } from '../damage.js';
import { stampFor } from '../stance.js';
import { killEnemy } from '../step.js';

const FORWARD = 'forward';
const CHILD = 1;

/** §3.1 의 컨텍스트. 모듈 스코프 1회 (§10.3) */
const ctx = { matrix: null, dmgMulSum: 0, elementBonusMul: 1 };

/** 폭발 — 자리 (x, y) 의 blastRadius 안 전 적에 dmg × mul. 처치는 core 의 killEnemy 로 완결(§9.5 D3). */
function blast(world, slot, eff, b, mul) {
  ctx.matrix = world.data.elements.matrix;
  ctx.dmgMulSum = familyDmgMul(world, 'missile');   // §3.1-2항(㊲) 패밀리의 피해 스탯
  ctx.elementBonusMul = world.stats.elementBonusMul;
  const stamp = stampFor(world, slot.index, b.stampMode, b.element);   // §4.4 — 탄에 각인된 속성
  const en = world.enemies.items;
  const r = eff.blastRadius;
  for (let i = 0; i < en.length; i += 1) {
    const e = en[i];
    if (!e.alive) continue;
    const dx = e.x - b.x;
    const dy = e.y - b.y;
    if (dx * dx + dy * dy > r * r) continue;
    const dealt = hitEnemy(world, ctx, slot.family, eff.dmg, mul, stamp, e, slot.index);
    if (dealt > 0 && e.hp <= 0) killEnemy(world, e);
  }
}

/** count 발을 spreadDeg 부채로(정면 = 위). 자탄이면 원점·부채·표식을 달리한다 */
function volley(world, slot, eff, ox, oy, n, spreadDeg, child) {
  const stepDeg = n > 1 ? spreadDeg / (n - 1) : 0;
  let deg = n > 1 ? -spreadDeg * 0.5 : 0;
  for (let i = 0; i < n; i += 1) {
    const r = deg * DEG2RAD;
    const b = spawnPlayerBullet(world, slot, eff, ox, oy, Math.sin(r) * eff.projSpeed, -Math.cos(r) * eff.projSpeed, 1);
    if (b === null) return;                        // §12.1 — rejectSpawn
    b.s0 = child ? CHILD : 0;
    if (child) b.lifetimeSec = eff.lifetimeSec * 0.5;   // 자탄은 짧게 — 폭발 자리 «근처»에서 한 번 더 터진다(멀리 날아가지 않는다)
    deg += stepDeg;
  }
}

/**
 * §9.5 탄 소멸 훅 — release 직전 정확히 1회. 미사일은 «항상» 터진다(진화 아님). 진화면 자탄을 뿌린다(w.evolved 분기 1개).
 */
export function onExpire(world, slot, eff, b) {
  const child = b.s0 === CHILD;
  blast(world, slot, eff, b, child ? eff.evoClusterDmgMul : 1);
  if (slot.evolved && !child) {
    // 자탄은 부채 «전방위»(spreadDeg 의 2배… 가 아니라 계약값 그대로 — 산포는 데이터 소유). 다시 갈라지지 않는다.
    volley(world, slot, eff, b.x, b.y, eff.evoClusterCount, eff.spreadDeg, true);
  }
}

export function update(world, slot, eff, dt) {
  if (eff.targetMode !== FORWARD) {
    throw new Error(`missile: 계약 밖의 targetMode "${eff.targetMode}" — 허용 = forward (§9.5)`);
  }
  slot.cooldownT -= dt;
  if (slot.cooldownT > 0) return;
  slot.cooldownT += eff.cooldownSec;
  volley(world, slot, eff, world.player.x, world.player.y, eff.count, eff.spreadDeg, false);
}

export default { update, onExpire };
