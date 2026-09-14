/**
 * tests/angle.test.mjs — §D1 각도 유틸 (도→라디안 · wrapAngle)
 *
 * 단언 대상:
 *   - DEG2RAD = Math.PI/180 (180도 = π, 90도 = π/2, 0도 = 0).
 *   - TAU = 2π.
 *   - wrapAngle: 결과 항상 ∈ [-π, π] · 경계(±π 유지) · 다중 바퀴 감기 · 이미 범위 내면 불변.
 */
import { suite, test, assert } from '../tools/test.mjs';
import { DEG2RAD, TAU, wrapAngle } from '../src/core/angle.js';

const PI = Math.PI;

// ── 상수 ───────────────────────────────────────────────────────────────────
suite('angle.constants', () => {
  test('DEG2RAD = π/180', () => {
    assert.eq(DEG2RAD, PI / 180, '변환 상수');
  });

  test('도→라디안 대표값', () => {
    assert.near(180 * DEG2RAD, PI, 1e-12, '180도 = π');
    assert.near(90 * DEG2RAD, PI / 2, 1e-12, '90도 = π/2');
    assert.near(360 * DEG2RAD, TAU, 1e-12, '360도 = 2π');
    assert.eq(0 * DEG2RAD, 0, '0도 = 0');
  });

  test('TAU = 2π (한 바퀴)', () => {
    assert.eq(TAU, PI * 2, '2π');
  });
});

// ── wrapAngle ──────────────────────────────────────────────────────────────
suite('angle.wrapAngle', () => {
  test('범위 내 값은 불변', () => {
    for (const a of [0, 0.5, -0.5, 1, -1, PI / 2, -PI / 2, 3]) {
      assert.eq(wrapAngle(a), a, `${a} 불변`);
    }
  });

  test('경계 ±π 는 유지된다 (while이 등호에서 멈춤)', () => {
    assert.eq(wrapAngle(PI), PI, '+π 유지');
    assert.eq(wrapAngle(-PI), -PI, '-π 유지');
  });

  test('π 를 살짝 넘으면 음의 쪽으로 감긴다', () => {
    assert.near(wrapAngle(PI + 0.1), -PI + 0.1, 1e-12, 'π+0.1 → -π+0.1');
  });

  test('-π 를 살짝 밑돌면 양의 쪽으로 감긴다', () => {
    assert.near(wrapAngle(-PI - 0.1), PI - 0.1, 1e-12, '-π-0.1 → π-0.1');
  });

  test('2π 배수 감기 (한 바퀴 = 항등)', () => {
    assert.near(wrapAngle(TAU + 0.5), 0.5, 1e-12, '2π+0.5 → 0.5');
    assert.near(wrapAngle(0.5 - TAU), 0.5, 1e-12, '0.5-2π → 0.5');
  });

  test('다중 바퀴 (3π → π, -3π → -π)', () => {
    assert.near(wrapAngle(3 * PI), PI, 1e-12, '3π → π');
    assert.near(wrapAngle(-3 * PI), -PI, 1e-12, '-3π → -π');
    assert.near(wrapAngle(5 * PI + 0.3), PI + 0.3 - TAU, 1e-12, '5π+0.3 감김');
  });

  test('불변식: 임의 각을 감으면 결과 ∈ [-π, π]', () => {
    let checks = 0;
    for (let i = -50; i <= 50; i += 1) {
      const a = i * 0.37; // 무리수 비슷한 스텝으로 경계를 촘촘히 훑음
      const w = wrapAngle(a);
      assert.gte(w, -PI, `wrap(${a}) >= -π`);
      assert.lte(w, PI, `wrap(${a}) <= π`);
      checks += 1;
    }
    assert.gt(checks, 100, '샘플 충분');
  });

  test('불변식: 감긴 각은 원각과 2π 정수배만큼만 차이난다 (동치 보존)', () => {
    for (const a of [10.3, -7.9, 100.0, -0.001, 6.5]) {
      const w = wrapAngle(a);
      const k = Math.round((a - w) / TAU);
      assert.near(a - w, k * TAU, 1e-9, `${a}: 차이 = 2π 정수배`);
    }
  });
});
