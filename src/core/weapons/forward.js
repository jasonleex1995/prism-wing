/**
 * src/core/weapons/forward.js — 벌컨 (§9.5)
 *
 * 폐쇄된 파라미터 계약 (§9.5 12행 표 — 이 파일은 계약 밖의 키를 읽지 않는다):
 *   base            : dmg cooldownSec count projSpeed projRadius lifetimeSec pierce
 *                     hitCooldownSec targetMode spreadDeg jitterDeg burstCount burstIntervalSec
 *   evolution.params: evoRampSec evoRampFireRateMul
 *
 * ★ 이 파일은 JSON 을 스스로 읽지 않는다. `eff` 는 state.recomputeEff 가 §9.6.1 의
 *   훅(H1~H4)을 **이미 적용해서** 넘긴 값이다 — 따라서 여기서 패시브를 다시 곱하면 이중 적용이다.
 *     rateKey "cooldownSec" (H1: /(1+fireRateMul)) · countKey "count" (+projCountAdd)
 *     pierceApplies true (+pierceAdd) · areaKeys ["projRadius"] (×(1+areaMul), H3 클램프)
 *   ★ H2 — spreadDeg · jitterDeg 는 **산포**라 areaKeys 에 없다. 여기서도 건드리지 않는다.
 *
 * 슬롯 스크래치 (§9.5 의 지속 상태. state.makeSlot 이 자리를 미리 잡아둔다):
 *   cooldownT = 볼리 주기 / a0 = 남은 버스트 발수 / a1 = 버스트 간격 타이머 / a2 = 램프 누적 게임초
 *
 * ★ 보고 대상 ① — 진화의 "피격 시 리셋"을 `world.player.hit` 으로 읽을 수 없다.
 *   step() 은 매 틱 **맨 처음** `player.hit = false` 로 지우고, 그것을 true 로 만드는 collide() 는
 *   fireWeapons() **뒤**에 있다 → 무기 update 가 보는 `player.hit` 은 **항상 false** 다(실측).
 *   즉 `hit` 은 "렌더/점수용" 1틱 플래그이지 무기가 소비할 수 있는 신호가 아니다.
 *   → §2.4 의 i-frame 으로 검출한다: iframeSec 은 피격 순간 rules.player.iframeSec(1.0) 으로
 *     **부여**되고 그 밖에는 매 틱 dt 씩 **단조 감소**한다(i-frame 중 재피격은 게이트된다 = 예외 없음).
 *     따라서 `iframeSec + dt >= rules.player.iframeSec` 은 **피격 직후 그 한 틱에만** 참이다
 *     = 정확한 엣지. 부동소수 동등비교가 아니라 부등호라 취약하지 않다.
 *   정확한 처방은 step.js 가 fireWeapons 전에 지워지지 않는 피격 신호를 두는 것이며,
 *   정본은 그 계약을 인쇄하지 않았다.
 *
 * ★ 보고 대상 ② — 슬롯 스크래치는 a0..a3 인데 **weapons/** 에서 `a3` 는 쓸 수 없다**:
 *   식별자 `a3` 안의 숫자 3 이 §9.1 의 리터럴 화이트리스트({0,1,-1,0.5,2}) 스캐너에 걸린다(실측).
 *   즉 스크래치 4칸 중 **3칸만 사용 가능**하다. 그래서 위 검출을 무저장으로 설계했다.
 */

import { DEG2RAD } from '../angle.js';
import { spawnPlayerBullet } from '../state.js';

const FORWARD = 'forward';

/**
 * 한 번의 볼리 = `count` 발을 spreadDeg 부채꼴에 균등 배치 + 발마다 jitterDeg 흔들기.
 * §9.5 targetMode "forward" = 조준하지 않는다. 정면 = 화면 위쪽 (§1.1 — y 는 아래가 +).
 */
function volley(world, slot, eff) {
  const p = world.player;
  const n = eff.count;
  // count 1 이면 산포가 없다 (n-1 = 0 으로 나누지 않는다)
  const stepDeg = n > 1 ? eff.spreadDeg / (n - 1) : 0;
  let deg = n > 1 ? -eff.spreadDeg * 0.5 : 0;

  for (let i = 0; i < n; i += 1) {
    let a = deg;
    // §9.5 — jitterDeg 는 rng.pattern 을 쓴다 (정본이 플레이어 무기에 명문으로 허용한 유일한 스트림).
    //   데미지 경로가 아니라 **발사 각도**이므로 §3.1 의 "데미지 경로에 RNG 없음"과 충돌하지 않는다.
    if (eff.jitterDeg > 0) a += (world.rng.pattern.f() * 2 - 1) * eff.jitterDeg;
    const r = a * DEG2RAD;
    spawnPlayerBullet(world, slot, eff, p.x, p.y,
      Math.sin(r) * eff.projSpeed, -Math.cos(r) * eff.projSpeed, 1);
    deg += stepDeg;
  }
}

export function update(world, slot, eff, dt) {
  // §9.3 의 정신 — 폴백 금지. 계약 밖 조준 모드를 조용히 무시하지 않는다
  if (eff.targetMode !== FORWARD) {
    throw new Error(`forward: 계약 밖의 targetMode "${eff.targetMode}" — 허용 = forward (§9.5)`);
  }

  let interval = eff.cooldownSec;

  // ★ w.evolved 분기 정확히 1개 (§9.5 "진화의 코드 표현")
  // 오버드라이브 — 연사를 유지할수록 발사 속도가 오른다. **피격 시 리셋**
  if (slot.evolved) {
    // 피격 직후 한 틱 = i-frame 이 방금 부여됐다. player.hit 은 여기서 언제나 false 다 — 위 주석 ① 참조
    if (world.player.iframeSec + dt >= world.data.rules.player.iframeSec) slot.a2 = 0;
    else if (slot.a2 < eff.evoRampSec) {
      slot.a2 += dt;
      if (slot.a2 > eff.evoRampSec) slot.a2 = eff.evoRampSec;
    }
    // 램프 0 -> 1 에 걸쳐 발사 속도 ×1 -> ×evoRampFireRateMul. 주기이므로 나눗셈 (§9.6.1 H1 과 같은 형태)
    interval /= 1 + (eff.evoRampFireRateMul - 1) * (slot.a2 / eff.evoRampSec);
  }

  slot.cooldownT -= dt;
  if (slot.cooldownT <= 0 && slot.a0 <= 0) {
    slot.a0 = eff.burstCount;    // 한 번의 쿨다운에 burstIntervalSec 간격으로 burstCount 볼리
    slot.a1 = 0;                 // 첫 볼리는 즉시
    slot.cooldownT = interval;
  }
  if (slot.a0 > 0) {
    slot.a1 -= dt;
    // dt 가 burstIntervalSec 보다 커도 발수가 새지 않는다. a0 이 상한이라 유한 루프다
    while (slot.a0 > 0 && slot.a1 <= 0) {
      volley(world, slot, eff);
      slot.a0 -= 1;
      slot.a1 += eff.burstIntervalSec;
    }
  }
}

export default { update };
