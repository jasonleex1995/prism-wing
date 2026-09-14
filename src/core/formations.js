/**
 * src/core/formations.js — 편대 배치 (§9.9.2, 순수 core 모듈)
 *
 * 편대는 «모양»이다. 그 모양이 **어디에** 놓이는지는 누가 스폰시켰는지가 정한다 —
 * 웨이브면 스폰 라인 중앙, 소환(§8.9-R9 mbNest)이면 소환자의 자리. 그래서 원점을 인자로 받는다.
 *
 * 구현 어휘: scatter · arc · lineH · vWedge · wall — ★ ㊿-zb 부터 **어휘 전체가 구현돼 있다**.
 * ~~그 외 columnV·pincer·미지 = scatter 폴백~~ — 그 둘은 구현된 적이 없어 25개 웨이브가 저작과 다르게 나왔고,
 * 사용자 결정(2026-09-12 「지금대로 가자 — 데이터를 고치면 될 것 같아」)으로 **데이터에서 삭제**했다(§8.7).
 * scatter 만 `rng.spawn` 을 쓴다 — 나머지는 순수 함수다(§10.2 결정성).
 */

import { DEG2RAD } from './angle.js';

const ARC_SEGS = 64;

/** 반지름 1 · 납작함 flatten(y 배율)인 타원 호(±span/2)의 길이 — 중점 적분 ARC_SEGS 등분. 순수·결정적. check.mjs S54 ⑨ 가 같은 식을 쓴다. */
export function arcEllipseLength(spanRad, flatten) {
  let L = 0;
  const h = spanRad / ARC_SEGS;
  for (let k = 0; k < ARC_SEGS; k += 1) {
    const th = -spanRad / 2 + (k + 0.5) * h;
    const c = Math.cos(th); const sn = Math.sin(th);
    L += Math.sqrt(c * c + flatten * flatten * sn * sn) * h;
  }
  return L;
}

/** 호 길이의 비율 frac(0..1)에 해당하는 각 — 누적 길이를 걸어 선형 보간. frac 0 = −span/2, 1 = +span/2. */
function arcAngleAtFraction(spanRad, flatten, frac) {
  const total = arcEllipseLength(spanRad, flatten);
  const target = frac * total;
  const h = spanRad / ARC_SEGS;
  let acc = 0;
  for (let k = 0; k < ARC_SEGS; k += 1) {
    const th = -spanRad / 2 + (k + 0.5) * h;
    const c = Math.cos(th); const sn = Math.sin(th);
    const seg = Math.sqrt(c * c + flatten * flatten * sn * sn) * h;
    if (acc + seg >= target) return -spanRad / 2 + k * h + (seg > 0 ? (target - acc) / seg : 0) * h;
    acc += seg;
  }
  return spanRad / 2;
}

/**
 * 편대의 i번째(총 count) 개체 좌표를 out 에 쓴다. 원점(originX, originY)이 편대의 기준점이다.
 * 아레나 가로 밖으로 새지 않게 구조적으로 클램프한다(밸런스 값이 아니라 좌표계 경계다).
 */
/**
 * §9.9.2 · §8.7(v1.10 ㉕) 편대별 i번째 개체의 스폰 좌표.
 *   ★ margin — «몸이 설 수 있는 폭»의 여백(px): 호출자가 몸의 반지름 + 흔들림 폭(weave ampPx)을 넘긴다. 모든 편대의 x 는
 *     [a.x + margin, a.x + a.w − margin] 안에만 선다 — 사용자(2026-09-05): 「적이 있는 구간은 일정해야 한다. 화면 밖에 걸쳐
 *     있지 않게」. 이전엔 x 를 아레나 «선»에 클램프해 끝 몸이 반쯤 밖에 섰고, weave 가 거기서 ±amp 만큼 더 나갔다.
 *   ★ vWedge 는 폭에 맞춰 «접는다»(겹친 V): 한 V 에 설 수 있는 최대 단(rank)은 아레나 반폭 − margin 에서 유도하고,
 *     넘치는 몸은 한 단 뒤(gapPx 위)의 다음 V 로 간다. 위기 화살 37기는 옛 계산으로 폭 1156px(아레나 580)라 9단부터
 *     전부 경계에 쌓여 «양쪽 벽에 세로줄»이 됐다(스크린샷). 접으면 17·17·3 의 세 겹 V 다. 난수 0(§10.2).
 */
export function formationPos(world, formationId, i, count, originX, originY, out, margin = 0) {
  const a = world.data.rules.view.arena;
  const forms = world.data.stages.formations;
  const rng = world.rng.spawn;
  const lo = a.x + margin;
  const hi = a.x + a.w - margin;

  let x = originX;
  let y = originY;

  if (formationId === 'arc') {
    const f = forms.arc;
    const spanRad = f.spanDeg * DEG2RAD;
    // §9.9.2(v1.10 ㊱) 호 = 납작한 타원(x = sinθ·R, y = −(1−cosθ)·R·flatten). 몸은 **타원 길이를 등분**해 선다(등각이 아니다 —
    //   등각이면 날개 끝의 간격이 가운데의 0.56 배로 눌려 «목걸이 튜브»가 됐다: 위기 새떼 37기 = 가운데 15px·날개 8.8px, 몸 지름 12).
    //   반지름은 저작값과 «(count−1)·minSepPx 를 세울 수 있는 값» 중 큰 쪽 — 37기 → 264px(현 457 < 아레나 488). 난수 0.
    const I = arcEllipseLength(spanRad, f.flatten);                   // 단위 반지름의 타원 호 길이
    const radius = Math.max(f.radiusPx, count > 1 ? (count - 1) * f.minSepPx / I : 0);
    const ang = arcAngleAtFraction(spanRad, f.flatten, count > 1 ? i / (count - 1) : 0.5);
    x = originX + Math.sin(ang) * radius;
    // 가운데가 앞선(=최대 y, 하강 방향으로 선두) 아래로 볼록한 호. (1-cos) 은 가운데 0·날개 양수라
    //   **빼야** 가운데가 앞선다(더하면 날개가 앞서는 ∩ 로 뒤집힌다 — 주석과 반대였다).
    y = originY - (1 - Math.cos(ang)) * radius * f.flatten;
  } else if (formationId === 'lineH') {
    const f = forms.lineH;
    x = originX + (i - (count - 1) / 2) * f.gapPx;
    y = originY;
  } else if (formationId === 'vWedge') {
    const f = forms.vWedge;
    const ar = f.angleDeg * DEG2RAD;
    // 한 V 의 최대 단 — 원점에서 가까운 벽까지의 폭이 정한다(구조 파생, 리터럴 아님). 최소 1단(3기).
    const half = Math.min(originX - lo, hi - originX);
    const maxRank = Math.max(1, Math.floor(half / (f.gapPx * Math.sin(ar))));
    const per = 1 + 2 * maxRank;                          // 한 V 의 몸 수
    const chev = Math.floor(i / per);                     // 몇 번째 V 인가(0 = 선두)
    const j = i % per;
    if (j === 0) { x = originX; y = originY - chev * f.gapPx; }
    else {
      const rank = Math.ceil(j / 2);
      const side = (j % 2 === 1) ? -1 : 1;
      x = originX + side * rank * f.gapPx * Math.sin(ar);
      y = originY - rank * f.gapPx * Math.cos(ar) - chev * f.gapPx;   // 날개가 위로·바깥으로 = 아래로 향한 V, 다음 V 는 한 단 뒤
    }
  } else if (formationId === 'wall') {
    // §8.19.2(v1.9) 도입의 «벽» — 몸을 촘촘히 세우되 줄마다 «차선»(lane)을 한 칸 비운다.
    //   ★ v1.8 의 벽은 순틈이 gapPx - 지름 = 3px 라 «완성된 한 줄»이 물리적으로 통과 불가였다.
    //     그 벽을 두껍게 하면 «강제 피격»이 몸 수에 비례해 늘어 §2.1 ①(완벽하면 안 맞는다)이 깨진다
    //     — 세 각도의 심사가 전부 같은 자리에서 걸렸다. 그래서 질량은 차선이 «먼저» 열려야 풀린다.
    //   차선 = 연속한 laneSlots 칸을 비운 자리. 순틈 = (laneSlots + 1)·gapPx - 몸 지름 이고
    //     S52 가 그 값이 fairness.minGapWidthPx 이상임을 정적으로 강제한다(§12.4 의 어휘를 재사용).
    //   차선의 자리는 줄마다 laneStrideCols 칸씩 옮겨간다 — 난수 0(§10.2), 상태 0. 벽은 «막는 것»이
    //     아니라 «바늘귀가 움직이는 것»이 된다: 비켜 갈 길은 항상 있고, 가만히 있으면 맞는다.
    const f = forms.wall;
    const slots = f.perRow;                       // 한 줄의 «칸» 수(몸 수가 아니다)
    const bodies = slots - f.laneSlots;           // 한 줄에 실제로 서는 몸 수
    const col = i % bodies;
    const row = Math.floor(i / bodies);
    // ★ 차선의 자리는 «지그재그»로 옮겨간다 — 나머지연산으로 감으면 오른쪽 끝에서 왼쪽 끝으로
    //   한 줄 만에 튀어 플레이어가 따라갈 수 없다(실측: 464px 점프, 0.78초에 갈 수 있는 거리는 219px).
    //   삼각파는 줄마다 정확히 laneStrideCols 칸씩만 움직이고 끝에서 되튄다 — 길이 «이어진다».
    const span = bodies;                                   // 차선이 설 수 있는 칸 0..bodies
    const p = (row * f.laneStrideCols) % (2 * span);
    const lane = p <= span ? p : 2 * span - p;
    const slot = col < lane ? col : col + f.laneSlots;      // 차선 칸을 건너뛴다
    // ★ 원점 기준이 «칸 격자»다(몸 수가 아니다) — 마지막 줄이 덜 차도 줄이 좌우로 흔들리지 않는다.
    x = originX + (slot - (slots - 1) / 2) * f.gapPx;
    // §8.19(v1.10) jitterY — 줄을 y 로 흩뜨린다. 사용자: 「한 열씩 띄워서 있는 구조 ✗, 다 같이 우루루」.
    //   0 이면 정확한 격자(v1.9), 1 이면 한 줄 높이만큼 흩어져 줄이 «사라진다». rng.spawn 이라 시드 결정적.
    y = originY - row * f.rowGapPx - rng.f() * f.jitterY * f.rowGapPx;
  } else {
    // scatter (+ 미지 어휘의 폴백) — rng.spawn 산포. jitterPx = y 계단, minSepPx = 가장자리 여백.
    //   ㊿-zb — 여기로 «조용히» 떨어지던 columnV·pincer 는 어휘에서 삭제됐다. 미지 값은 S2 가 먼저 막는다.
    //   ★ 원점 중심으로 흩는다(소환 편대가 소환자 자리에 놓이는 계약). 웨이브는 originX=아레나 중앙이라
    //     결과·rng 소비가 기존과 **완전히 동일**하고(중앙±(a.w-2minSep)/2 = a.x+minSep…a.x+a.w-minSep),
    //     소환(mbNest)만 originX=소환자로 옮겨간다. 아래 클램프가 아레나 밖을 막는다.
    const f = forms.scatter;
    const sep = Math.max(f.minSepPx, margin);            // 가장자리 여백 = max(저작 여백, 몸 + 흔들림)
    x = originX + (rng.f() - 0.5) * (a.w - 2 * sep);
    y = originY - rng.f() * f.jitterPx;
  }

  if (x < lo) x = lo;
  if (x > hi) x = hi;
  out.x = x;
  out.y = y;
  return out;
}
