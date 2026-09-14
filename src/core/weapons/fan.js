/**
 * src/core/weapons/fan.js — 팬아웃 (§9.5)
 *
 * 폐쇄된 파라미터 계약 (§9.5 12행 표):
 *   base            : dmg cooldownSec count projSpeed projRadius lifetimeSec pierce
 *                     hitCooldownSec targetMode arcDeg
 *   evolution.params: evoBlastRadius evoSecondaryDmgMul
 *
 * §9.6.1 훅은 state.recomputeEff 가 이미 적용했다:
 *   rateKey "cooldownSec" · countKey "count" · pierceApplies true
 *   areaKeys ["projRadius", "evoBlastRadius"] — ★ evoBlastRadius 는 evolution.params 에 살며
 *   `src = base ∪ (evolved ? evolution.params : {})` 덕에 진화 시에만 areaMul 을 받는다
 *   ★ H2 — arcDeg 는 **산포**라 areaKeys 에 없다. 여기서도 건드리지 않는다
 *
 * ★ 진화(플레어 팬)의 소멸 폭발은 step.releasePlayerBullet 이 탄 release 직전 정확히 1회 부르는
 *   onExpire(world, slot, eff, bullet) 훅으로 실현된다 (§9.5 무기 런타임 계약). 1주차의 s0 마커+
 *   풀 스캔 근사(LIFO 재사용 시 폭발 1회 누락)를 대체한다 — 마커 스크래치 불요.
 */

import { DEG2RAD } from '../angle.js';
import { spawnPlayerBullet, familyDmgMul } from '../state.js';
import { hitEnemy } from '../damage.js';
import { stampFor } from '../stance.js';
import { killEnemy } from '../step.js';

const FORWARD = 'forward';

/** §3.1 의 컨텍스트. ★ 모듈 스코프 1회 — 핫패스에서 새로 만들지 않는다 (§10.3) */
const ctx = { matrix: null, dmgMulSum: 0, elementBonusMul: 1 };

/**
 * 진화(플레어 팬) — 소멸한 탄 자리에서 evoBlastRadius 안의 적에게
 * dmg × evoSecondaryDmgMul (§3.1 의 1항 지역 배율 3종 중 하나).
 *
 * ★ §9.5·D3 — 탄 충돌 밖에서 hp 를 0 이하로 만든 그 자리에서 core 의 killEnemy 로 처치를 완결한다.
 *   killEnemy 는 step.js 소유(진입 !alive 가드로 멱등)이며 §8.6 드랍(drop 스트림)을 step.js 안에서
 *   수행한다 — weapons 파일 스캔(S11)에 드랍 스트림 텍스트가 걸리지 않는다.
 */
function blast(world, slot, eff, b) {
  ctx.matrix = world.data.elements.matrix;
  ctx.dmgMulSum = familyDmgMul(world, 'fan');   // §3.1-2항(㊲) 패밀리의 피해 스탯
  ctx.elementBonusMul = world.stats.elementBonusMul;

  // §4.4 — 폭발은 그 탄의 것이므로 **탄에 각인된 속성**을 그대로 쓴다 (step.js 의 충돌 경로와 동일)
  const stamp = stampFor(world, slot.index, b.stampMode, b.element);
  const en = world.enemies.items;
  const r = eff.evoBlastRadius;

  for (let i = 0; i < en.length; i += 1) {          // §10.3 인덱스 오름차순
    const e = en[i];
    if (!e.alive) continue;
    const dx = e.x - b.x;
    const dy = e.y - b.y;
    if (dx * dx + dy * dy > r * r) continue;
    const dealt = hitEnemy(world, ctx, slot.family, eff.dmg, eff.evoSecondaryDmgMul, stamp, e, slot.index);
    if (dealt > 0 && e.hp <= 0) killEnemy(world, e);
  }
}

/**
 * §9.5 탄 소멸 훅 — step.releasePlayerBullet 이 이 family 의 탄 release **직전** 정확히 1회 부른다
 * (LIFO 재사용 경합 없음). 진화(플레어 팬)일 때만 그 탄 자리에서 폭발한다 — w.evolved 분기 1개.
 */
export function onExpire(world, slot, eff, bullet) {
  if (slot.evolved) blast(world, slot, eff, bullet);
}

/** `count` 발을 arcDeg 부채꼴에 균등 배치. 정면 = 화면 위쪽 (§1.1 — y 는 아래가 +) */
function volley(world, slot, eff) {
  const p = world.player;
  const n = eff.count;
  const stepDeg = n > 1 ? eff.arcDeg / (n - 1) : 0;
  let deg = n > 1 ? -eff.arcDeg * 0.5 : 0;

  for (let i = 0; i < n; i += 1) {
    const r = deg * DEG2RAD;
    // 소멸 시 폭발은 onExpire 가 소유한다 — 여기선 마커를 남기지 않는다
    spawnPlayerBullet(world, slot, eff, p.x, p.y,
      Math.sin(r) * eff.projSpeed, -Math.cos(r) * eff.projSpeed, 1);
    deg += stepDeg;
  }
}

export function update(world, slot, eff, dt) {
  if (eff.targetMode !== FORWARD) {
    throw new Error(`fan: 계약 밖의 targetMode "${eff.targetMode}" — 허용 = forward (§9.5)`);
  }

  // ★ 진화 폭발은 onExpire(탄 release 훅)가 담당한다 — update 는 발사만 (w.evolved 분기는 onExpire 에 1개)
  slot.cooldownT -= dt;
  if (slot.cooldownT > 0) return;
  slot.cooldownT += eff.cooldownSec;
  volley(world, slot, eff);
}

// ★ 레지스트리(index.js)는 default export 를 family→모듈로 매핑한다 → step.releasePlayerBullet 이
//   `fn.onExpire` 로 부르려면 onExpire 가 default export 객체에 있어야 한다 (§9.5 계약)
export default { update, onExpire };
