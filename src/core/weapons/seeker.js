/**
 * src/core/weapons/seeker.js — 시커 (§9.5)
 *
 * 폐쇄된 파라미터 계약 (§9.5 12행 표):
 *   base            : dmg cooldownSec count projSpeed projRadius lifetimeSec pierce
 *                     hitCooldownSec targetMode turnRateDegSec acquireRadius retargetSec
 *   evolution.params: evoDistinctTargets evoRetargetOnKill
 *
 * §9.6.1 훅은 state.recomputeEff 가 이미 적용했다:
 *   rateKey "cooldownSec" · countKey "count" · pierceApplies true
 *   areaKeys ["projRadius", "acquireRadius"] — ★ 탐지 반경이 areaMul 로 커진다
 *
 * 탄 스크래치 (state.makePlayerBullet 이 자리를 잡아둔다):
 *   target = 적 풀 인덱스(-1 = 없음) / targetGen = 그 슬롯의 세대(풀 재사용 오인 방지) / s0 = 재조준 타이머
 *
 * ★ 조종은 이 파일이 한다. step.js 는 vx/vy 등속 적분만 하며, fireWeapons 가 moveBullets
 *   **앞**에 있으므로 이 틱의 조종이 이 틱의 이동에 그대로 반영된다 (§10.1 순서).
 */

import { DEG2RAD, wrapAngle } from '../angle.js';
import { spawnPlayerBullet } from '../state.js';
import { targetable } from '../damage.js';   // §8.20 · ㊽ — 조준은 «맞힐 수 있는 적»만 고른다

const NEAREST = 'nearest';

/** 진화(스웜)의 "서로 다른 타겟" 배제 목록. ★ 모듈 스코프 1회 — 핫패스에서 새로 만들지 않는다 (§10.3) */
const taken = [];

/**
 * radius 안의 최근접 적. 없으면 -1.
 * §10.3 — 인덱스 오름차순 순회. 거리 동점이면 **낮은 인덱스**가 이긴다 = 결정적.
 */
function nearestEnemy(world, x, y, radius, exclude) {
  const en = world.enemies.items;
  let best = -1;
  let bestD = radius * radius;      // 반경 밖은 애초에 후보가 아니다
  for (let i = 0; i < en.length; i += 1) {
    const e = en[i];
    // §8.20 — 조준은 «보이는 적»만 고른다(피해 게이트는 「0 을 준다」까지만 한다).
    if (!targetable(world, e)) continue;               // ㊽ 유도탄도 «맞힐 수 있는 것»만 쫓는다
    if (exclude !== null && exclude.indexOf(i) >= 0) continue;
    const dx = e.x - x;
    const dy = e.y - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** 살아있는 우리 탄을 타겟 쪽으로 turnRateDegSec 만큼만 꺾는다 */
function steer(world, slot, eff, dt, retargetOnKill) {
  const items = world.playerBullets.items;
  const en = world.enemies.items;
  const maxTurn = eff.turnRateDegSec * DEG2RAD * dt;

  for (let i = 0; i < items.length; i += 1) {
    const b = items[i];
    // §5.3·§9.5 family-키 규칙 — 슬롯 재정렬이 b.slot 을 stale 로 만드므로 family 로만 식별한다
    // (id==family 1:1 유일 → 조건 하나로 충분·스왑 안전). b.slot 필터는 제거됐다.
    if (!b.alive || b.family !== slot.family) continue;

    // 타겟을 놓쳤는가 = 없거나 / 죽었거나 / 그 풀 슬롯이 **다른 적으로 재사용**됐거나
    const lost = b.target < 0 || !en[b.target].alive || en[b.target].gen !== b.targetGen;

    b.s0 -= dt;
    // 진화(evoRetargetOnKill)면 타겟이 죽는 즉시 다시 고른다. 아니면 retargetSec 주기를 기다린다
    if (b.s0 <= 0 || (lost && retargetOnKill)) {
      b.s0 = eff.retargetSec;
      b.target = nearestEnemy(world, b.x, b.y, eff.acquireRadius, null);
      b.targetGen = b.target < 0 ? -1 : en[b.target].gen;
    }
    if (b.target < 0) continue;
    const e = en[b.target];
    // 놓친 타겟은 재조준 시점까지 **마지막 방향으로 직진**한다
    if (!e.alive || e.gen !== b.targetGen) continue;

    const cur = Math.atan2(b.vy, b.vx);
    let d = wrapAngle(Math.atan2(e.y - b.y, e.x - b.x) - cur);
    if (d > maxTurn) d = maxTurn;
    else if (d < -maxTurn) d = -maxTurn;
    const a = cur + d;
    b.vx = Math.cos(a) * eff.projSpeed;
    b.vy = Math.sin(a) * eff.projSpeed;
  }
}

/** `count` 발을 쏜다. 타겟이 없으면 정면(화면 위쪽, §1.1)으로 나가서 스스로 찾아간다 */
function volley(world, slot, eff, distinct) {
  const p = world.player;
  const n = eff.count;
  taken.length = 0;                 // 재사용 — 새 배열을 만들지 않는다

  for (let i = 0; i < n; i += 1) {
    const t = nearestEnemy(world, p.x, p.y, eff.acquireRadius, distinct ? taken : null);
    let vx = 0;
    let vy = -eff.projSpeed;
    if (t >= 0) {
      const e = world.enemies.items[t];
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 0) { vx = (dx / d) * eff.projSpeed; vy = (dy / d) * eff.projSpeed; }
      if (distinct) taken.push(t);
    }
    const b = spawnPlayerBullet(world, slot, eff, p.x, p.y, vx, vy, 1);
    if (b === null) return;         // §12.1 — playerBullet 초과 = rejectSpawn. 재활용 금지
    b.target = t;
    b.targetGen = t < 0 ? -1 : world.enemies.items[t].gen;
    b.s0 = eff.retargetSec;
  }
}

export function update(world, slot, eff, dt) {
  // §9.5 는 seeker 에 nearest · lowestHp · randomInArena 를 허용하지만 weapons.json 은 8레벨 전부
  // "nearest" 다. 안 쓰는 모드를 상상해서 구현하지 않고, 들어오면 **소리내어 실패**한다 (§9.3 폴백 금지)
  if (eff.targetMode !== NEAREST) {
    throw new Error(`seeker: 미구현 targetMode "${eff.targetMode}" — weapons.json 은 nearest 만 쓴다 (§9.5)`);
  }

  let distinct = false;
  let retargetOnKill = false;
  // ★ w.evolved 분기 정확히 1개 (§9.5 "진화의 코드 표현")
  // 스웜 — 각 탄이 서로 다른 타겟을 노리고, 타겟이 죽으면 즉시 다시 고른다
  if (slot.evolved) {
    distinct = eff.evoDistinctTargets;
    retargetOnKill = eff.evoRetargetOnKill;
  }

  steer(world, slot, eff, dt, retargetOnKill);

  slot.cooldownT -= dt;
  if (slot.cooldownT > 0) return;
  slot.cooldownT += eff.cooldownSec;
  volley(world, slot, eff, distinct);
}

export default { update };
