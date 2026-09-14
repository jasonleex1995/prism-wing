/**
 * tests/damage.test.mjs — §3.1 플레이어→적 · §3.2 적→플레이어
 *
 * 단언 대상:
 *   §3.1  5항 구조 (base · dmgMul · elem · gate · final) + 1항 지역 배율 3종(폐쇄 목록).
 *         - base = w.dmg × Π(지역 배율)  (localMul 이 falloff·rearBias·evoSecondaryDmgMul 의 곱)
 *         - dmgMul = 1 + Σ(패시브 dmgMul)  → ★가산 풀 1회 적용 (곱연산 폭주 방지, 회귀)
 *         - elem  : elementTerm 위임 (elem>1 만 resonance 증폭)
 *         - (㉘) 게이트 항 없음 — 코어 무적은 hitEnemy 의 sealedNow(하드 게이트)
 *   §3.2  taken = ceil( max( raw − defense , raw × damageFloorRatio ) )
 *         - 실측(정본): defense 8 기준 소형탄 8→2, 레이저 22→14.
 *         - 25% 하한 → 무적화 불가.
 */
import { suite, test, assert, loadData } from '../tools/test.mjs';
import { playerToEnemy, enemyToPlayer } from '../src/core/damage.js';
import { elementMul } from '../src/core/elements.js';

const d = loadData();
const M = d.elements.matrix;
const FLOOR = d.rules.player.damageFloorRatio;        // 0.25 (§3.2)
const DEF_BASE = d.rules.player.defenseBase;          // 0

// 중립 ctx: 상성·풀·게이트 전부 항등 → base 만 남는다
function neutralCtx() {
  return { matrix: M, dmgMulSum: 0, elementBonusMul: 1.0 };
}
const NON_CORE = { element: 'normal', isCore: false, aliveArmorPartCount: 0 };

// ── §3.1-1항: base = w.dmg × Π(지역 배율) ──────────────────────────────────
suite('damage.playerToEnemy.base', () => {
  test('전 항 항등이면 final == w.dmg', () => {
    assert.eq(playerToEnemy(neutralCtx(), 50, 1, 'normal', NON_CORE), 50, 'base 단독');
  });

  test('localMul 이 base 를 선형 스케일 (지역 배율 자리)', () => {
    assert.eq(playerToEnemy(neutralCtx(), 40, 0.5, 'normal', NON_CORE), 20, '×0.5 falloff');
    assert.eq(playerToEnemy(neutralCtx(), 40, 1.30, 'normal', NON_CORE), 52, '×1.30 rearBias');
  });

  test('★지역 배율 3종은 곱으로 합성되어 1항 안에서 곱해진다 (falloff·rearBias·evoSecondaryDmgMul)', () => {
    // 호출자가 Π(지역 배율)을 만들어 localMul 로 넘긴다
    const falloff = 0.5, rearBias = 1.30, evoSecondaryDmgMul = 0.5;
    const localMul = falloff * rearBias * evoSecondaryDmgMul;
    const dmg = 100;
    assert.near(playerToEnemy(neutralCtx(), dmg, localMul, 'normal', NON_CORE),
      dmg * localMul, 1e-9, 'base = dmg × Π(3종)');
  });
});

// ── §3.1-2항: dmgMul 가산 풀 ────────────────────────────────────────────────
suite('damage.playerToEnemy.dmgMul', () => {
  test('dmgMul = 1 + Σ(dmgMul)', () => {
    const ctx = neutralCtx(); ctx.dmgMulSum = 0.30;
    assert.near(playerToEnemy(ctx, 100, 1, 'normal', NON_CORE), 130, 1e-9, '1+0.30');
  });

  test('★회귀: 가산 풀은 1회만 적용 — (1+a+b) ≠ (1+a)(1+b) (곱연산 폭주 방지)', () => {
    const a = 0.15, b = 0.21; // 정본 warhead values 중 두 값
    const ctx = neutralCtx(); ctx.dmgMulSum = a + b;
    const additive = playerToEnemy(ctx, 100, 1, 'normal', NON_CORE);
    assert.near(additive, 100 * (1 + a + b), 1e-9, '가산: 1+a+b');
    assert.ne(additive, 100 * (1 + a) * (1 + b), '곱연산 스택이 아니다');
  });

  test('Σ = 0 → dmgMul 항등', () => {
    assert.eq(playerToEnemy(neutralCtx(), 77, 1, 'normal', NON_CORE), 77, '증가 없음');
  });
});

// ── §3.1-3항: elem (elementTerm 위임) ──────────────────────────────────────
suite('damage.playerToEnemy.elem', () => {
  test('상성 ×2/×1/×0.5 가 그대로 곱해진다 (matrix 위임)', () => {
    // water→fire = ×2
    assert.eq(elementMul(M, 'water', 'fire'), 2.0, '전제: 물→불 ×2');
    assert.eq(playerToEnemy(neutralCtx(), 100, 1, 'water', { element: 'fire', isCore: false, aliveArmorPartCount: 0 }), 200, '×2');
    // fire→water = ×0.5
    assert.eq(playerToEnemy(neutralCtx(), 100, 1, 'fire', { element: 'water', isCore: false, aliveArmorPartCount: 0 }), 50, '×0.5');
    // normal→fire = ×1
    assert.eq(playerToEnemy(neutralCtx(), 100, 1, 'normal', { element: 'fire', isCore: false, aliveArmorPartCount: 0 }), 100, '×1');
  });

  test('resonance k: elem>1 만 증폭 (elem = 1 + (elem-1)k)', () => {
    const ctx = neutralCtx(); ctx.elementBonusMul = 1.5; // ×2 → ×2.5
    assert.near(playerToEnemy(ctx, 100, 1, 'water', { element: 'fire', isCore: false, aliveArmorPartCount: 0 }), 250, 1e-9, '×2→×2.5');
  });

  test('★resonance 는 ×0.5·×1 에 절대 안 걸린다 (k 무관)', () => {
    const ctx = neutralCtx(); ctx.elementBonusMul = 3.0; // 극단 k
    // ×0.5 불변
    assert.eq(playerToEnemy(ctx, 100, 1, 'fire', { element: 'water', isCore: false, aliveArmorPartCount: 0 }), 50, '×0.5 불변');
    // ×1 불변
    assert.eq(playerToEnemy(ctx, 100, 1, 'normal', { element: 'fire', isCore: false, aliveArmorPartCount: 0 }), 100, '×1 불변');
  });
});

// ── §3.1-4항: gate (코어 소프트 게이트) ────────────────────────────────────
suite('damage.playerToEnemy.gate', () => {
  test('(㉘) 식에 게이트 항이 없다 — 코어든 아니든 playerToEnemy 는 같은 값 (코어 무적은 hitEnemy 의 sealedNow 가 소유)', () => {
    const a = { element: 'normal', isCore: false };
    const c = { element: 'normal', isCore: true };
    assert.eq(playerToEnemy(neutralCtx(), 100, 1, 'normal', a), 100, '비코어');
    assert.eq(playerToEnemy(neutralCtx(), 100, 1, 'normal', c), 100, '코어(열린 상태로 도달한 것)도 같은 식');
  });
});

// ── §3.1: 5항 전체 합성 ─────────────────────────────────────────────────────
suite('damage.playerToEnemy.composed', () => {
  test('final = base × dmgMul × elem (전 항 비항등 — ㉘ 게이트 항 없음)', () => {
    const ctx = { matrix: M, dmgMulSum: 0.30, elementBonusMul: 1.5 };
    const dmg = 80, localMul = 0.5;
    const target = { element: 'fire', isCore: true };
    const stamp = 'water'; // water→fire = ×2, resonance k=1.5 → ×2.5
    const base = dmg * localMul;             // 40
    const dmgMul = 1 + 0.30;                  // 1.30
    const elemBase = elementMul(M, stamp, target.element); // 2.0
    const elem = 1 + (elemBase - 1) * 1.5;    // 2.5
    const expected = base * dmgMul * elem;
    assert.near(playerToEnemy(ctx, dmg, localMul, stamp, target), expected, 1e-9, '3항 곱');
  });

  test('결과는 float — 반올림 없이 누산 (§3.1-6항)', () => {
    // ×0.5 falloff × dmg 25 = 12.5 (정수 아님)
    const v = playerToEnemy(neutralCtx(), 25, 0.5, 'normal', NON_CORE);
    assert.near(v, 12.5, 1e-12, 'float 유지');
    assert.ok(!Number.isInteger(v), '반올림 안 함');
  });
});


// ── §3.2: 적 → 플레이어 ─────────────────────────────────────────────────────
suite('damage.enemyToPlayer', () => {
  const rulesP = d.rules.player; // damageFloorRatio 소유

  test('★정본 실측: 방어력 8 기준 소형탄 8 → 2', () => {
    // max(8-8, 8×0.25) = max(0, 2) = 2, ceil = 2
    assert.eq(enemyToPlayer(rulesP, { defense: 8 }, 8), 2, '칩딜 4배 감소');
  });

  test('★정본 실측: 방어력 8 기준 레이저 22 → 14', () => {
    // max(22-8, 22×0.25) = max(14, 5.5) = 14, ceil = 14
    assert.eq(enemyToPlayer(rulesP, { defense: 8 }, 22), 14, '큰 탄 36% 감소');
  });

  test('정액 감산: defense 만큼 정확히 뺀다 (하한 위)', () => {
    // raw 30, def 8 → 22 > 30×0.25=7.5 → 22
    assert.eq(enemyToPlayer(rulesP, { defense: 8 }, 30), 22, 'raw - defense');
  });

  test('25% 하한: 정액 감산이 하한 밑으로 내려가면 하한이 이긴다', () => {
    // raw 8, def 8 → max(0, 2) = 2 (하한 승)
    assert.eq(enemyToPlayer(rulesP, { defense: 8 }, 8), 8 * FLOOR, '하한 = raw×0.25');
  });

  test('★무적화 불가: 방어력 ≫ raw 여도 taken ≥ ceil(raw×0.25) > 0', () => {
    assert.eq(enemyToPlayer(rulesP, { defense: 9999 }, 8), 2, '거대 방어도 하한 통과');
    assert.gt(enemyToPlayer(rulesP, { defense: 9999 }, 100), 0, '항상 양수');
  });

  test('ceil: 소수 피해는 올림 (하한이 소수를 낼 때)', () => {
    // raw 10, def 8 → max(2, 2.5) = 2.5 → ceil 3
    assert.eq(enemyToPlayer(rulesP, { defense: 8 }, 10), 3, 'ceil(2.5)=3');
  });

  test('기본 방어력 0 → taken = ceil(raw) (감산 없음)', () => {
    // max(raw-0, raw×0.25) = raw
    assert.eq(enemyToPlayer(rulesP, { defense: DEF_BASE }, 8), 8, 'def 0 → 원본 전량');
    assert.eq(enemyToPlayer(rulesP, { defense: 0 }, 22), 22, 'def 0 레이저');
  });

  test('damageFloorRatio 는 데이터에서 온다 (매직넘버 아님)', () => {
    assert.eq(FLOOR, 0.25, '§3.2 하한 25%');
  });
});
