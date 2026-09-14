/**
 * src/core/weapons/aura.js — 펄스필드 (§9.5, v1.5 «영역 슬로우» · v1.10 ㊿-o·㊿-p «구역 감속»)
 *
 * 폐쇄된 파라미터 계약 (§9.5 12행 표):
 *   base            : radius slowMul  (★v1.7: 죽어 있던 dmg·tickIntervalSec·falloff 삭제 —
 *                     통일 표기가 그 값들을 «피해 3 · 주기 0.7초»로 화면에 띄워 거짓말을 했다)
 *   evolution.params: evoPullForce
 *
 * ★ §9.5(v1.5, 사용자 결정 2026-08-01) — 펄스필드의 정체성 = «영역 슬로우». v1.4의 «탄막 제거»(너무 쉬움) 폐기.
 *   ★ v1.10 ㊿-o·㊿-p·㊿-r — 반경 안의 적 탄과 적 기체(이동·발사 주기)를 레벨 곡선 slowMul 로 늦춘다(«정지»가 아니라
 *   «기어가기» — S62). ㊿-r: 진화는 Lv8 에서만 일어나고 Lv8~10 은 늘 진화 상태라, 진화 감속(곡선 +15%p)은 그 레벨 칸이
 *   직접 갖는다(옛 evoSlowMul 은 곡선을 «대신»해 Lv8~10 칸이 죽어 있었다). 탄을 지우지 않는다 — «이 범위 안에서만» 느려지고,
 *   벗어나면 원속도로 돌아간다(step.moveBullets 가 매 틱 1 로 되돌린다). 진화는 거기에 작은 잡몹 끌어당김을 더한다.
 *   피해 없음(순수 제어 무기).
 *
 * §9.6.1 훅(state.recomputeEff): rateKey **null**(v1.7 — 주기가 없다) · countKey null ·
 *   pierceApplies false · areaKeys ["radius"](필드 확대).
 * 슬롯 스크래치: 없음(슬로우는 매 틱 연속 적용, 주기 없음).
 */

const CHAFF = 'chaff';

/**
 * 반경 안의 «적 탄 + 적 기체»에 이동 배율 factor 를 «이번 틱» 세팅한다(더 강한 슬로우가 이긴다).
 *   moveBullets 가 적용 후 1 로 리셋 → 필드 밖으로 나가면 원속도. 기체는 발사 주기도 같은 배율을 탄다(emitters).
 */
function slowField(world, eff, factor) {
  const p = world.player;
  const r = eff.radius;
  const rr = r * r;
  const eb = world.enemyBullets.items;
  for (let i = 0; i < eb.length; i += 1) {
    const b = eb[i];
    if (!b.alive) continue;
    const dx = b.x - p.x;
    const dy = b.y - p.y;
    if (dx * dx + dy * dy <= rr && factor < b.slowMul) b.slowMul = factor;
  }
  // ★ v1.10 ㊿-p — 구역은 «탄만»이 아니라 «그 안의 모든 것»을 늦춘다: 적 기체의 이동과 발사 주기도 같은 배율.
  //   사용자(2026-09-09): 「반경 안의 적들도 속도가 느려지는 건 어때? 탄환과 기체를 모두 느려지게 하는 거지.
  //   해당 구역 안에 든 기체는 발사속도도 느려지게 되고, 탄도 느려지고!」
  //   ★ 이것은 정본이 삭제한 knockback 의 뒷문이 «아니다» — 감속은 개체를 **옮기지 않는다**. 편대(column·anchor·
  //     pincer)의 «모양»은 그대로고 «속도»만 준다. 그래서 evoPullForce 를 chaff 로 묶은 논거(편대 파괴)가
  //     여기엔 적용되지 않으며, 밴드 제한도 필요 없다.
  //   ★ 보스·중간보스는 제외 — 그쪽은 자기 사격 곡선(bossBulletScale·escalateFireRateMul)과 페이즈를 갖는다.
  //     보스의 발사 주기를 구역으로 늦추면 보스전이 통째로 무너진다(§8.11·§8.9 의 압박 장치를 무력화).
  //   ★ ㊿-q — 중장갑(ccImmune, §8.17)도 제외한다: 「둔화·행동감속을 무시한다」가 그 개성의 정의이고, 바라지(둔화)·
  //     노바(행동감속)도 이미 그 규칙에서 막힌다. 구역의 «기체» 감속은 그 둘을 합친 제어라 같은 규칙을 탄다.
  //     «탄» 감속은 그대로 걸린다 — 탄은 개체가 아니다.
  const en = world.enemies.items;
  for (let i = 0; i < en.length; i += 1) {
    const e = en[i];
    if (!e.alive || e.isBoss || e.midBossId !== '' || e.ccImmune) continue;
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    if (dx * dx + dy * dy <= rr && factor < e.fieldSlowMul) e.fieldSlowMul = factor;
  }
}

/**
 * 진화(싱귤래리티) — chaff 를 중심으로 끌어당긴다(매 틱). §9.5 — 엘리트·보스·파트 제외(위치 조작 아님).
 */
function pull(world, eff, dt) {
  const p = world.player;
  const en = world.enemies.items;
  const r = eff.radius;
  for (let i = 0; i < en.length; i += 1) {
    const e = en[i];
    if (!e.alive || e.isBoss || e.elite || e.band !== CHAFF) continue;
    const dx = p.x - e.x;
    const dy = p.y - e.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > r * r || d2 === 0) continue;
    const d = Math.sqrt(d2);
    const s = eff.evoPullForce * dt / d;
    e.x += dx * s;
    e.y += dy * s;
  }
}

export function update(world, slot, eff, dt) {
  // §9.1(v1.7) 감속 계수는 데이터(레벨 칸)가 소유한다 — ㊿-r: 진화 구간 Lv8~10 칸이 곡선 +15%p 를 직접 갖는다
  slowField(world, eff, eff.slowMul);
  // ★ slot.evolved 분기 정확히 1개 (§9.5) — 진화(싱귤래리티)의 몫: 작은 잡몹(chaff) 끌어당김
  if (slot.evolved) pull(world, eff, dt);
}

export default { update };
