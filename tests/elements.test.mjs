/**
 * tests/elements.test.mjs — §4.1 상성 (LOCKED) · §3.1-3항 상성항
 *
 * 단언 대상:
 *   - elementMul: 4×4 매트릭스 전 16셀 = data/elements.json 실제 값과 비트 대조.
 *   - 상성 순환: 물>불>풀>물 (×2), 역방향 ×0.5 (S25 순환 불변).
 *   - 노말은 행·열 전부 ×1.
 *   - 미지 속성 → throw (§4.1 폴백 금지, §9.3 정신).
 *   - elementTerm: elem>1 만 resonance(k) 증폭 · ×1·×0.5 는 k와 무관하게 불변.
 *   - isInvestable.
 */
import { suite, test, assert, loadData } from '../tools/test.mjs';
import { elementMul, elementTerm, hitTier, isInvestable } from '../src/core/elements.js';

const d = loadData();
const M = d.elements.matrix;
const ORDER = d.elements.order;          // ["normal","fire","water","grass"]
const INVEST = d.elements.investable;    // ["fire","water","grass"]

// ── 4×4 전셀 대조 ──────────────────────────────────────────────────────────
suite('elements.matrix.fullTable', () => {
  test('16셀 전부 elementMul == data/elements.json matrix[att][def]', () => {
    let cells = 0;
    for (const att of ORDER) {
      for (const def of ORDER) {
        assert.eq(elementMul(M, att, def), M[att][def], `matrix[${att}][${def}]`);
        cells += 1;
      }
    }
    assert.eq(cells, 16, '4×4 = 16셀 전수');
  });

  test('모든 값 ∈ {0.5, 1.0, 2.0} (S25 값역)', () => {
    for (const att of ORDER) {
      for (const def of ORDER) {
        const v = M[att][def];
        assert.ok(v === 0.5 || v === 1.0 || v === 2.0, `matrix[${att}][${def}]=${v} ∈ {0.5,1,2}`);
      }
    }
  });
});

// ── 노말 축 (항상 ×1) ──────────────────────────────────────────────────────
suite('elements.normal', () => {
  test('노말 행 전부 ×1 (노말 공격은 상성 없음)', () => {
    for (const def of ORDER) assert.eq(elementMul(M, 'normal', def), 1.0, `normal→${def}`);
  });

  test('노말 열 전부 ×1 (노말 방어는 상성 없음)', () => {
    for (const att of ORDER) assert.eq(elementMul(M, att, 'normal'), 1.0, `${att}→normal`);
  });
});

// ── 상성 순환 (S25) ────────────────────────────────────────────────────────
suite('elements.cycle', () => {
  test('물>불>풀>물: 유리 방향 = ×2', () => {
    assert.eq(elementMul(M, 'water', 'fire'), 2.0, '물→불 ×2');
    assert.eq(elementMul(M, 'fire', 'grass'), 2.0, '불→풀 ×2');
    assert.eq(elementMul(M, 'grass', 'water'), 2.0, '풀→물 ×2');
  });

  test('역방향 = ×0.5 (순환 불변: [x][y]==2 ⟺ [y][x]==0.5)', () => {
    assert.eq(elementMul(M, 'fire', 'water'), 0.5, '불→물 ×0.5');
    assert.eq(elementMul(M, 'grass', 'fire'), 0.5, '풀→불 ×0.5');
    assert.eq(elementMul(M, 'water', 'grass'), 0.5, '물→풀 ×0.5');
  });

  test('순환 불변식 전수: [x][y]==2 ⟺ [y][x]==0.5 (노말 제외 3×3)', () => {
    for (const x of INVEST) {
      for (const y of INVEST) {
        if (elementMul(M, x, y) === 2.0) {
          assert.eq(elementMul(M, y, x), 0.5, `순환쌍 ${x}↔${y}`);
        }
      }
    }
  });

  test('동속성 자기 대결 = ×1', () => {
    for (const e of ORDER) assert.eq(elementMul(M, e, e), 1.0, `${e}→${e}`);
  });
});

// ── 폴백 금지 (§4.1 · §9.3) ────────────────────────────────────────────────
suite('elements.noFallback', () => {
  test('미지 공격 속성 → throw (조용한 ×1 아님)', () => {
    assert.throws(() => elementMul(M, 'lightning', 'fire'), '미지 공격 속성은 에러');
  });

  test('미지 방어 속성 → throw', () => {
    assert.throws(() => elementMul(M, 'fire', 'poison'), '미지 방어 속성은 에러');
  });
});

// ── elementTerm: resonance (§3.1-3항) ──────────────────────────────────────
suite('elements.elementTerm', () => {
  test('elem>1 : k=1.0 기본 → 배율 불변 (resonance 미보유)', () => {
    // elem = 1 + (2-1)*1.0 = 2.0
    assert.near(elementTerm(M, 'water', 'fire', 1.0), 2.0, 1e-12, '×2, k=1 불변');
  });

  test('elem>1 : k로 증폭 (elem = 1 + (elem-1)*k)', () => {
    // 정본 §3.1: resonance k ∈ [1.10 .. 1.50] → 유효 배율 ×2.1 .. ×2.5
    const resonance = d.passives.passives.find((p) => p.id === 'resonance');
    const kMax = resonance.values[resonance.values.length - 1]; // 데이터에서 유도 (매직넘버 금지)
    const k = kMax;
    const expected = 1 + (2.0 - 1) * k;
    assert.near(elementTerm(M, 'water', 'fire', k), expected, 1e-12, `×2 → ×${expected}`);
    // 계약 상한 확인: k=1.5 → ×2.5
    assert.near(elementTerm(M, 'water', 'fire', 1.5), 2.5, 1e-12, 'k=1.5 → ×2.5');
  });

  test('★elem==1 : k와 무관하게 ×1 불변 (증폭 절대 안 걸림)', () => {
    for (const k of [1.0, 1.5, 3.0, 100.0]) {
      assert.eq(elementTerm(M, 'normal', 'fire', k), 1.0, `×1 불변 @k=${k}`);
      assert.eq(elementTerm(M, 'fire', 'fire', k), 1.0, `동속성 ×1 불변 @k=${k}`);
    }
  });

  test('★elem==0.5 : k와 무관하게 ×0.5 불변 (약점 증폭 금지)', () => {
    for (const k of [1.0, 1.5, 3.0, 100.0]) {
      assert.eq(elementTerm(M, 'fire', 'water', k), 0.5, `×0.5 불변 @k=${k}`);
    }
  });

  test('elementTerm도 미지 속성 → throw (elementMul 위임)', () => {
    assert.throws(() => elementTerm(M, 'void', 'fire', 1.0), '미지 속성 전파');
  });
});

// ── hitTier: §7.7 히트 피드백 3중 감각의 tier 분류 ─────────────────────────
suite('elements.hitTier (§7.7)', () => {
  test('16셀 전부 matrix 값과 정합: ×2→super · ×1→neutral · ×0.5→resist', () => {
    let cells = 0;
    for (const att of ORDER) {
      for (const def of ORDER) {
        const m = M[att][def];
        const expected = m > 1 ? 'super' : m < 1 ? 'resist' : 'neutral';
        assert.eq(hitTier(M, att, def), expected, `hitTier(${att},${def}) [mul=${m}]`);
        cells += 1;
      }
    }
    assert.eq(cells, 16, '4×4 전수');
  });

  test('상성 순환의 세 tier — 물>불(super) · 그 역(resist) · 동속성(neutral)', () => {
    assert.eq(hitTier(M, 'water', 'fire'), 'super', '물→불 ×2');
    assert.eq(hitTier(M, 'fire', 'water'), 'resist', '불→물 ×0.5 (역방향)');
    assert.eq(hitTier(M, 'fire', 'fire'), 'neutral', '동속성 ×1');
  });

  test('노말 스탬프는 어느 방어에도 neutral (투자 0 = 색이 거짓말 안 함, I-2)', () => {
    for (const def of ORDER) assert.eq(hitTier(M, 'normal', def), 'neutral', `normal→${def}`);
  });

  test('resonance(k)와 무관 — tier 는 원시 상성이지 증폭값이 아니다 (elementMul 단일 소스)', () => {
    // hitTier 는 k 인자를 받지 않는다: super 판정은 원시 셀(×2)에서 온다.
    assert.eq(hitTier(M, 'water', 'fire'), 'super', 'k 없이도 super');
  });

  test('미지 속성 → throw (elementMul 위임 · 폴백 금지)', () => {
    assert.throws(() => hitTier(M, 'plasma', 'fire'), '미지 공격 속성 전파');
  });
});

// ── 투자/속성 판정 (§4.2 · §4.1) ───────────────────────────────────────────
suite('elements.membership', () => {
  test('isInvestable: 불·물·풀 = true, 노말 = false (투자축 아님)', () => {
    assert.ok(isInvestable(d.elements, 'fire'), '불 투자 가능');
    assert.ok(isInvestable(d.elements, 'water'), '물 투자 가능');
    assert.ok(isInvestable(d.elements, 'grass'), '풀 투자 가능');
    assert.ok(!isInvestable(d.elements, 'normal'), '노말은 투자축 아님');
    assert.ok(!isInvestable(d.elements, 'lightning'), '미지 속성 false');
  });

  test('isInvestable 목록 = data.investable 정확히 (normal 불포함, 3종)', () => {
    assert.eq(INVEST.length, 3, '투자 3종');
    assert.ok(INVEST.indexOf('normal') < 0, 'normal 불포함');
  });


  test('order = [normal, fire, water, grass] (§4.1 키 순서 동결)', () => {
    assert.deepEq(ORDER, ['normal', 'fire', 'water', 'grass'], 'Q W E R 순');
  });
});
