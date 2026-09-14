/**
 * src/core/elements.js
 *
 * 정본 v1.4 구현 절:
 *   §4.1    상성 (LOCKED) — 물 > 불 > 풀 > 물, 노말은 항상 ×1
 *   §3.1-3항 데미지 공식의 배율 항 (elem)
 *   §9.4.4  elements.json 스키마 — order · investable · matrix
 *   §9.1    core 순수성
 *
 * ★ 이 파일에 상성 숫자가 없다. matrix 는 elements.json 이 유일하게 소유한다 (C-2 · C-8).
 * ★ 적의 공격에는 속성이 없다 (§4.1) — 그러므로 이 표는 플레이어→적 경로에서만 조회된다.
 */

/**
 * §4.1 · §3.1-3항 — 공격 속성 → 방어 속성 배율. ∈ {0.5, 1.0, 2.0}
 * 미지 속성은 에러다 (§9.3 정신: 폴백 금지 — 조용히 ×1 을 돌려주면 상성이 죽는다).
 */
export function elementMul(matrix, attacker, defender) {
  const row = matrix[attacker];
  if (row === undefined) {
    throw new Error(`elements.matrix: 미지의 공격 속성 "${attacker}" (§4.1)`);
  }
  const m = row[defender];
  if (m === undefined) {
    throw new Error(`elements.matrix["${attacker}"]: 미지의 방어 속성 "${defender}" (§4.1)`);
  }
  return m;
}

/**
 * §3.1-3항 전체 — 상성 배율 + resonance 증폭.
 *   elem = matrix[stamp][target]
 *   if (elem > 1) elem = 1 + (elem - 1) × elementBonusMul
 * ★ elem ≤ 1 에는 절대 적용되지 않는다 (×0.5 · ×1 불변, §9.6).
 * ★ elementBonusMul 의 기본값은 1.0 이다 (§3.1 — resonance 미보유).
 */
export function elementTerm(matrix, attacker, defender, elementBonusMul) {
  const elem = elementMul(matrix, attacker, defender);
  if (elem > 1) return 1 + (elem - 1) * elementBonusMul;
  return elem;
}

/**
 * §7.7 — 히트 피드백 tier. 상성의 **원시 matrix 셀**(∈ {0.5, 1, 2})을 3중 감각의 이름으로 사상한다:
 *   ×2 → 'super' (효과적) · ×1 → 'neutral' (보통) · ×0.5 → 'resist' (반감).
 * ★ resonance(k)는 여기 **안 들어온다** — tier 는 「상성의 종류」지 증폭된 실효 배율이 아니다
 *   (§7.7 표는 ×2/×1/×0.5 세 열이 전부다. resonance 로 ×2.5가 나와도 tier 는 여전히 super).
 * ★ elementMul 이 배율의 **단일 소스**다(§3.1-3항과 같은 셀). 미지 속성은 그 안에서 에러(폴백 금지).
 * ★ 비교는 `> 1` / `< 1` — matrix 는 {0.5,1,2}만 담으므로 부동소수 동치 위험이 없다.
 */
export function hitTier(matrix, attacker, defender) {
  const m = elementMul(matrix, attacker, defender);
  if (m > 1) return 'super';
  if (m < 1) return 'resist';
  return 'neutral';
}

/** §4.2 — 투자 가능 속성인가. 노말은 투자축이 아니다 */
export function isInvestable(elements, element) {
  return elements.investable.indexOf(element) >= 0;
}


/**
 * §8.2 ③(v1.10 ㉔) — 테마 밖 속성의 HP 배율. 사용자(2026-09-05): 「늪은 풀이 메인이니까 풀 몹은 3방, 다른 속성은 2방 —
 *   환경과 같은 속성이면 지금대로, 아닌 속성은 조금 더 약하게」. 테마 속성·노말(속성 없음)·최종(테마 없음)은 1.
 *   잡몹 HP 의 단일 입구(enemies.enemyHp · midboss 소환)가 같이 부른다. 보스·중간보스는 대상이 아니다(§8.9·§8.11 자기 HP 곡선).
 */
export function offThemeHpMul(data, stageElement, element) {
  if (stageElement === null || element === stageElement || element === 'normal') return 1;
  return data.stages.theme.offThemeHpMul;
}
