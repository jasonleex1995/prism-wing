/**
 * src/core/weapons/boomerang.js — 리턴 (§9.5)
 *
 * 폐쇄된 파라미터 계약 (§9.5 12행 표 — 이 파일은 계약 밖의 키를 읽지 않는다):
 *   base            : dmg cooldownSec count projSpeed projRadius lifetimeSec pierce
 *                     hitCooldownSec targetMode outRangePx returnSpeed canRehit bounceLeft spacingDeg
 *   evolution.params: evoChainCount
 *
 * §9.6.1 훅은 state.recomputeEff 가 이미 적용했다 — 값(rateKey · countKey · pierceApplies · 배율 목록)은 rules.passiveHooks.boomerang 이
 *   소유한다. 여기 옮겨 적지 않는다(옮겨 적은 areaKeys 목록이 낡아 있었다).
 *
 * ★ 데미지·재히트는 이 파일이 하지 않는다. pierce=-1(무제한 관통)·hitCooldownSec=0.5 를 실은
 *   탄을 spawnPlayerBullet 로 내보내면, step.collide 가 (hitStamp/hitAt/hitGen) 로 **같은 적을
 *   0.5초마다 다시** 때린다 → 나갈 때·돌아올 때 "두 번 벤다"가 자동으로 성립한다. canRehit 는
 *   그 계약을 사람이 읽는 표식일 뿐 코드가 소비하지 않는다.
 *
 * ★ 이 파일이 하는 일 = **궤적 조종만** (seeker.steer 와 같은 결). step.js 는 vx/vy 등속 적분만
 *   하고, fireWeapons 가 moveBullets **앞**이라 이 틱의 조종이 이 틱의 이동에 반영된다 (§10.1).
 *
 * 탄 스크래치 (state.makePlayerBullet 이 자리를 잡아둔다):
 *   s0 = 국면 (0=나감 OUT / 1=귀환 RETURN)
 *   s1 = OUT: 원점 x  ·  RETURN: 남은 경유 수(진화 체인)
 *   s2 = OUT: 원점 y  ·  RETURN: 직전 경유한 적 idx(-1=없음 — 재획득에서 제외해 같은 적 재붕괴 방지)
 *   target/targetGen = RETURN 의 경유 대상 적(진화 체인 리턴)
 *
 * ★ 회수(catch) — releasePlayerBullet 은 step.js 가 export 하지 않는다. 대신 귀환한 탄에
 *   b.age = lifetimeSec 를 실으면 바로 뒤 moveBullets 가 그 틱에 release 한다(§9.5 수명 경로).
 *   boomerang 은 onExpire 가 없어 release 는 순수 풀 반납이다.
 */

import { spawnPlayerBullet } from '../state.js';
import { targetable } from '../damage.js';   // §8.20 · ㊽ — 체인 경유점도 «맞힐 수 있는 적»만
import { DEG2RAD, TAU } from '../angle.js';

const FORWARD = 'forward';
const SWEEP = 'sweep';           // ㉚ 회전 조준
const OUT = 0;
const RETURN = 1;

/** 최근접 적(반경 무제한, exclude idx 제외). 없으면 -1. §10.3 — 인덱스 오름차순, 동점은 낮은 인덱스 = 결정적 */
function nearest(world, x, y, exclude) {
  const en = world.enemies.items;
  let best = -1;
  let bestD = 0;
  for (let i = 0; i < en.length; i += 1) {
    if (i === exclude) continue;                 // 직전 경유 적 제외 (체인이 다음 적으로 진행)
    const e = en[i];
    if (!targetable(world, e)) continue;               // ㊽
    const dx = e.x - x;
    const dy = e.y - y;
    const d = dx * dx + dy * dy;
    if (best < 0 || d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** 살아있는 이 family 의 탄을 국면에 따라 조종한다 */
function steer(world, slot, eff, chain) {
  const items = world.playerBullets.items;
  const en = world.enemies.items;
  const p = world.player;

  for (let i = 0; i < items.length; i += 1) {
    const b = items[i];
    // §5.3·§9.5 family-키 규칙 — 슬롯 재정렬이 b.slot 을 stale 로 만드므로 family 로만 식별한다
    if (!b.alive || b.family !== slot.family) continue;

    // ── OUT: 직진하다 원점에서 outRangePx 벗어나면 귀환으로 전환 ───────────────────
    if (b.s0 === OUT) {
      const dx = b.x - b.s1;
      const dy = b.y - b.s2;
      if (dx * dx + dy * dy >= eff.outRangePx * eff.outRangePx) {
        b.s0 = RETURN;
        b.s1 = chain ? eff.evoChainCount : 0;   // s1 재용도: 남은 경유 수
        b.s2 = -1;                              // s2 재용도: 직전 경유 적(-1=없음)
        b.s2gen = -1;
        b.target = -1;
        b.targetGen = -1;
      }
      continue;                                  // 나가는 동안은 발사 속도 그대로
    }

    // ── RETURN: (진화) 경유 대상 갱신 → 목적지로 등속, 플레이어 도달 시 회수 ──────────
    if (chain && b.s1 > 0) {
      const lost = b.target < 0 || !en[b.target].alive || en[b.target].gen !== b.targetGen;
      if (lost) {
        // ★ 직전 경유 적(s2)을 제외하고 다음 최근접을 고른다 — 안 그러면 방금 닿은 적이 여전히
        //   rr 안이라 같은 적에 evoChainCount 를 ~3틱만에 몰아 소진해 체인이 한 적으로 붕괴한다.
        //   ★ gen 확인: s2 슬롯이 죽거나 **다른 적으로 재사용**됐으면 제외를 무효화한다(엉뚱한 신규
        //     적을 배제하지 않도록). 원래 경유 적이 그대로 살아있을 때만 제외가 의미 있다.
        const ex = (b.s2 >= 0 && en[b.s2].alive && en[b.s2].gen === b.s2gen) ? b.s2 : -1;
        b.target = nearest(world, b.x, b.y, ex);
        b.targetGen = b.target < 0 ? -1 : en[b.target].gen;
        if (b.target < 0) b.s1 = 0;              // 경유할 적이 없다 → 곧장 플레이어로
      }
      if (b.target >= 0) {
        const e = en[b.target];
        const rr = eff.projRadius + e.radius;
        const ex = e.x - b.x;
        const ey = e.y - b.y;
        if (ex * ex + ey * ey <= rr * rr) {       // 경유 도달 → 이 경유 소진
          b.s2 = b.target;                        // 방금 경유한 적을 기억 = 다음 재획득에서 제외
          b.s2gen = e.gen;                        // 그 적의 gen(슬롯 재사용 판별용)
          b.s1 -= 1;
          b.target = -1;
          b.targetGen = -1;
        }
      }
    }

    let tx = p.x;
    let ty = p.y;
    let toPlayer = true;
    if (chain && b.s1 > 0 && b.target >= 0) {      // 유효 경유 대상이 있으면 그쪽으로
      tx = en[b.target].x;
      ty = en[b.target].y;
      toPlayer = false;
    }
    const dx = tx - b.x;
    const dy = ty - b.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (toPlayer && d <= eff.projRadius) {         // 플레이어에게 회수됨 → 수명 경로로 반납
      b.age = b.lifetimeSec;
      continue;
    }
    if (d > 0) {
      b.vx = (dx / d) * eff.returnSpeed;
      b.vy = (dy / d) * eff.returnSpeed;
    }
  }
}

/** `count` 발을 정면 부채꼴에 균등 투척. count 1 이면 정면 직상 */
function throwVolley(world, slot, eff) {
  const p = world.player;
  const n = eff.count;
  // ★ 다발 투척의 부채 각은 CANON 미규정(§0.4 → 구현 소유).
  //   §9.5(v1.7) «총 부채폭 고정»에서 «탄당 간격 고정»으로 바꾼다.
  //   총폭 45°를 n 등분하던 v1.6 까지는 **짝수 count 에 정면 탄이 없었다** — count 2 는 ±22.5°라
  //   정면의 적을 둘 다 빗나간다. 실측: Lv2(count 1) 11 DPS → Lv3(count 2) **0 DPS**.
  //   레벨업이 무기를 죽이는 자리였다. 간격을 고정하면 짝수도 정면을 ±6° 로 감싸 명중한다.
  //   값은 데이터가 소유한다(§9.1 — weapons/** 는 숫자 리터럴을 쓰지 않는다).
  // §9.5(v1.10 ㉚) targetMode 'sweep' — 사용자: 「정면 공격이 너무 많다. 리턴은 오빗처럼 그냥 돌면서 계속 쏘는 느낌으로」.
  //   조준각이 게임초 × sweepDegSec 로 계속 돌고, n 발은 360°/n 씩 벌려 전방위로 나간다. 난수 0(시간 기반 = 시드 결정적).
  //   'forward' 는 옛 정면 부채(spacingDeg)를 그대로 둔다(어휘에 살아 있고 구현도 있다).
  const sweep = eff.targetMode === SWEEP;
  const stepRad = sweep ? (Math.PI * 2) / n : eff.spacingDeg * DEG2RAD;
  let a = sweep ? (world.time * eff.sweepDegSec * DEG2RAD) % TAU : -stepRad * (n - 1) * 0.5;   // 숫자 리터럴 0 (§9.1) — TAU 는 angle.js

  for (let i = 0; i < n; i += 1) {
    const vx = Math.sin(a) * eff.projSpeed;
    const vy = -Math.cos(a) * eff.projSpeed;      // a=0 → 위/정면 (§1.1 — y 아래가 +)
    const b = spawnPlayerBullet(world, slot, eff, p.x, p.y, vx, vy, 1);
    if (b === null) return;                        // §12.1 — playerBullet 초과 = rejectSpawn
    b.s0 = OUT;
    b.s1 = p.x;                                    // 원점 x
    b.s2 = p.y;                                    // 원점 y
    a += stepRad;
  }
}

export function update(world, slot, eff, dt) {
  if (eff.targetMode !== FORWARD && eff.targetMode !== SWEEP) {
    throw new Error(`boomerang: 미구현 targetMode "${eff.targetMode}" — forward | sweep (§9.5)`);
  }

  // ★ slot.evolved 분기 정확히 1개 (§9.5 "진화의 코드 표현")
  // 체인 리턴 — 귀환 경로가 최근접 적 evoChainCount 마리를 경유한다
  let chain = false;
  if (slot.evolved) chain = true;

  steer(world, slot, eff, chain);

  slot.cooldownT -= dt;
  if (slot.cooldownT > 0) return;
  slot.cooldownT += eff.cooldownSec;
  throwVolley(world, slot, eff);
}

export default { update };
