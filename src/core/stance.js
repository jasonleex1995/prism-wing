/**
 * src/core/stance.js   ★ 이 게임의 핵심 ★
 *
 * 정본 v1.4 구현 절:
 *   §4.2  투자 — investable(fire water grass) · elementCapPerElement 4 · elementCapTotal 6
 *   §4.3  부여 — 투자 레벨 N → **슬롯 1..N** 의 무기가 그 속성. 나머지는 무속성(×1)
 *   §4.3  노말 스탠스(Q) = N 0 강제 / 전환 쿨다운 0 / 전환 딜레이 없음 (다음 틱 즉시)
 *   §4.3  재계산 시점 = 속성 레벨 상승 · 새 무기 획득 · 슬롯 재정렬 → 즉시(다음 틱)
 *   §4.4  각인 규칙 — spawn(생성 시 각인, 이후 불변) / live(매 적용마다 재평가)
 *   §5.7  스탠스 키 동시 입력 → 마지막에 눌린 키
 *   §9.1  core 순수성
 *
 * ★ 값은 전부 rules.player 에서 온다. 이 파일에 4도 6도 0도 없다.
 * ★ 투자 가능 판정은 elements.js 의 isInvestable 이 **단일 소스**다 (막판 중복 제거).
 */

import { isInvestable } from './elements.js';

const NORMAL = 'normal';

/** §4.2 — 그 속성의 투자 레벨. 노말은 투자축이 아니므로 언제나 0 (§4.3: N 0 강제) */
export function investmentOf(world, element) {
  if (element === NORMAL) return 0;
  const v = world.player.invest[element];
  if (v === undefined) throw new Error(`stance: 투자축이 아닌 속성 "${element}" (§4.2)`);
  return v;
}

/** §4.2 — 투자 합계 */
export function investTotal(world) {
  const inv = world.player.invest;
  const list = world.data.elements.investable;
  let sum = 0;
  for (let i = 0; i < list.length; i += 1) sum += inv[list[i]];
  return sum;
}

/**
 * §4.3 — 현재 스탠스가 부여하는 슬롯 수 N.
 * 노말 스탠스면 0. 투자 0인 속성 스탠스도 0(기계적으로 같다 — §4.3의 "노말이 하는 일").
 */
export function stampCount(world) {
  return investmentOf(world, world.player.stance);
}

/**
 * ★★ §4.3 부여 규칙의 유일한 구현 지점 ★★
 * 슬롯 순서대로 앞 N개 무기가 현재 스탠스 속성, 나머지는 무속성(normal).
 * 호출 시점 = 스탠스 전환 / 속성 레벨 상승 / 새 무기 획득 / 슬롯 재정렬 (전부 "다음 틱 즉시").
 */
export function recomputeStamps(world) {
  const n = stampCount(world);
  const el = world.player.stance;
  const slots = world.slots;
  // ★ 속성 각인은 «속성 슬롯»(0..elementSlots-1)에만 내린다. 유틸 칸은 영원히 노말이다 —
  //   유틸 무기가 상성 ×2 를 받으면 「조준하지 않는 무기는 상성을 노릴 수 없다」는 전제가 무너진다.
  const eSlots = world.data.rules.player.elementSlots;
  for (let i = 0; i < slots.length; i += 1) {
    if (i >= eSlots) { slots[i].stampElement = NORMAL; continue; }
    // ★ 슬롯 1..N = 인덱스 0..N-1. 빈 슬롯도 자리를 차지한다 (정본은 "슬롯 1..N"이라 말한다).
    slots[i].stampElement = i < n ? el : NORMAL;
  }
}

/**
 * §4.3 · §5.7 — 스탠스 전환 요청.
 * 쿨다운(rules.player.stanceSwitchCooldown = 0)이 남아 있으면 무시한다.
 * 구조는 존재하고 값이 0이다 → "살짝 굳게"가 필요해도 숫자만 바뀐다 (C-4).
 * @returns 전환이 실제로 일어났는가
 */
export function requestStance(world, element) {
  const p = world.player;
  if (p.stanceCooldown > 0) return false;
  if (element === p.stance) return false;
  if (world.data.elements.order.indexOf(element) < 0) {
    throw new Error(`stance: 어휘 밖의 속성 "${element}" (§4.1)`);
  }
  p.stance = element;
  p.stanceCooldown = world.data.rules.player.stanceSwitchCooldown;
  // §4.3 "전환 딜레이 없음. 다음 틱부터 즉시 적용" — 재계산을 미루지 않는다.
  recomputeStamps(world);
  return true;
}

/** 고정 dt 1틱만큼 쿨다운을 흘린다 (§0.2: Sec = 게임초. 배속은 core 밖) */
export function tickStance(world, dt) {
  const p = world.player;
  if (p.stanceCooldown > 0) {
    p.stanceCooldown -= dt;
    if (p.stanceCooldown < 0) p.stanceCooldown = 0;
  }
}

/**
 * §4.2 — 속성 투자 +1. 상한 2종을 여기서 강제한다.
 * @returns 실제로 올랐는가
 */
export function investElement(world, element) {
  const rp = world.data.rules.player;
  if (!isInvestable(world.data.elements, element)) {
    throw new Error(`stance: 투자 가능 속성이 아니다 "${element}" (§4.2 — 노말 +1 카드는 존재하지 않는다)`);
  }
  if (world.player.invest[element] >= rp.elementCapPerElement) return false;
  if (investTotal(world) >= rp.elementCapTotal) return false;
  world.player.invest[element] += 1;
  recomputeStamps(world);   // §4.3 재계산 시점 ①
  return true;
}

/**
 * §4.4 — 피해 개체가 적용할 속성.
 *   spawn : 생성 순간 각인된 값을 그대로 쓴다 (각인 세탁 방지)
 *   live  : 슬롯의 **현재** 각인을 매 적용마다 재평가한다 (orbit · aura)
 * ★ I-2: 화면에 그려진 색 = 그 개체가 지금 적용할 배율. 이 함수가 그 단일 진실이다.
 */
export function stampFor(world, slotIndex, stampMode, spawnedElement) {
  if (stampMode === 'live') return world.slots[slotIndex].stampElement;
  return spawnedElement;
}

export { NORMAL };
