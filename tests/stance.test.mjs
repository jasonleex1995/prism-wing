/**
 * tests/stance.test.mjs — §4 속성·스탠스 계약
 *
 * 정본 계약 (design/CANON.md):
 *   §4.2  투자 — investable [fire water grass] · elementCapPerElement 4 · elementCapTotal 6
 *   §4.3  부여 — 스탠스 속성 투자 N → **슬롯 1..N** 무기가 그 속성, 나머지 무속성(normal)
 *   §4.3  노말 스탠스 = N 0 강제 / 쿨다운 0 / 다음 틱 즉시
 *   §4.4  stampFor — spawn = 생성 각인 불변 / live = 매 적용 재평가
 *
 * ★ 값은 전부 data 에서 유도한다 (하드코딩 매직넘버 지양).
 * ★ 회귀 #6: 부여는 **슬롯 순서 앞 N개만** — "어떤 무기냐"가 아니라 "몇 번째 슬롯이냐".
 */

import { suite, test, assert, loadData } from '../tools/test.mjs';
import { createWorld, giveWeapon } from '../src/core/state.js';
import {
  investmentOf, investTotal, stampCount, recomputeStamps,
  requestStance, investElement, stampFor, NORMAL,
} from '../src/core/stance.js';

const SEED = 0xC0FFEE;

/** forward 만 든 fresh 월드 (createWorld 가 startWeapon=forward 를 슬롯0에 넣는다) */
function mkWorld() {
  return createWorld({ data: loadData(), seed: SEED, weapons: {}, startWeaponId: 'forward' });
}

/** 슬롯을 weaponSlots 개 전부 채운다 (forward + 나머지 아무거나) */
function fillSlots(world) {
  const ids = world.data.weapons.weapons.map((w) => w.id);
  for (let i = 0; i < ids.length && world.slots.some((s) => s.weaponId === null); i += 1) {
    if (world.slots.some((s) => s.weaponId === ids[i])) continue;
    giveWeapon(world, ids[i]);
  }
}

suite('stance/investment', () => {
  test('노말은 투자축이 아니다 → 언제나 0 (§4.3 N 0 강제)', () => {
    const w = mkWorld();
    assert.eq(investmentOf(w, NORMAL), 0, '노말 투자 = 0');
  });

  test('투자축 밖의 속성은 throw (§4.2)', () => {
    const w = mkWorld();
    assert.throws(() => investmentOf(w, 'plasma'), '어휘 밖 속성은 던진다');
  });

  test('investTotal = investable 3축 합', () => {
    const w = mkWorld();
    const [FIRE, WATER] = w.data.elements.investable;
    assert.eq(investTotal(w), 0, '시작 투자 합 0');
    investElement(w, FIRE);
    investElement(w, FIRE);
    investElement(w, WATER);
    assert.eq(investTotal(w), 3, '불2 물1 → 합 3');
    assert.eq(investmentOf(w, FIRE), 2, '불 = 2');
    assert.eq(investmentOf(w, WATER), 1, '물 = 1');
  });
});

suite('stance/imbue-slots', () => {
  // ★ 핵심 시나리오: 불2·물1·풀0
  test('불2 물1 풀0 — 불 스탠스는 슬롯1·2만 불, 3·4 무속성 (§4.3 · 회귀 #6)', () => {
    const w = mkWorld();
    fillSlots(w);
    const [FIRE, WATER] = w.data.elements.investable;
    investElement(w, FIRE);
    investElement(w, FIRE);   // 불 = 2
    investElement(w, WATER);  // 물 = 1

    assert.eq(requestStance(w, FIRE), true, '불 스탠스 전환 성공');
    assert.eq(stampCount(w), 2, 'N = 불 투자 = 2');
    assert.eq(w.slots[0].stampElement, FIRE, '슬롯1 = 불');
    assert.eq(w.slots[1].stampElement, FIRE, '슬롯2 = 불');
    assert.eq(w.slots[2].stampElement, NORMAL, '슬롯3 = 무속성');
    assert.eq(w.slots[3].stampElement, NORMAL, '슬롯4 = 무속성');
  });

  test('같은 투자에서 물 스탠스 = 슬롯1만 물 (N=1)', () => {
    const w = mkWorld();
    fillSlots(w);
    const [FIRE, WATER] = w.data.elements.investable;
    investElement(w, FIRE);
    investElement(w, FIRE);
    investElement(w, WATER);
    requestStance(w, WATER);
    assert.eq(stampCount(w), 1, 'N = 물 투자 = 1');
    assert.eq(w.slots[0].stampElement, WATER, '슬롯1 = 물');
    assert.eq(w.slots[1].stampElement, NORMAL, '슬롯2 = 무속성');
    assert.eq(w.slots[2].stampElement, NORMAL, '슬롯3 = 무속성');
  });

  test('투자 0 속성 스탠스(풀) = 전부 무속성 (N=0)', () => {
    const w = mkWorld();
    fillSlots(w);
    const [FIRE, , GRASS] = w.data.elements.investable;
    investElement(w, FIRE);
    requestStance(w, GRASS);   // 풀 투자 0
    assert.eq(stampCount(w), 0, 'N = 풀 투자 = 0');
    for (let i = 0; i < w.slots.length; i += 1) {
      assert.eq(w.slots[i].stampElement, NORMAL, `슬롯${i + 1} 무속성`);
    }
  });

  test('노말 스탠스 = N 0 강제, 전부 무속성 (§4.3)', () => {
    const w = mkWorld();
    fillSlots(w);
    const [FIRE] = w.data.elements.investable;
    investElement(w, FIRE);
    investElement(w, FIRE);
    requestStance(w, FIRE);          // 먼저 불로
    assert.eq(requestStance(w, NORMAL), true, '노말 전환 성공');
    assert.eq(stampCount(w), 0, '노말 N = 0');
    for (let i = 0; i < w.slots.length; i += 1) {
      assert.eq(w.slots[i].stampElement, NORMAL, `슬롯${i + 1} 무속성`);
    }
  });

  test('빈 슬롯도 자리를 차지한다 — N > 보유무기수여도 슬롯1..N 각인 (§4.3)', () => {
    // 무기 1개(forward)만, 불 투자 2 → 빈 슬롯2도 불로 각인된다
    const w = mkWorld();
    const [FIRE] = w.data.elements.investable;
    investElement(w, FIRE);
    investElement(w, FIRE);
    requestStance(w, FIRE);
    assert.eq(w.slots[0].weaponId !== null, true, '슬롯1 = forward');
    assert.eq(w.slots[1].weaponId, null, '슬롯2 = 비어 있음');
    assert.eq(w.slots[0].stampElement, FIRE, '슬롯1 불');
    assert.eq(w.slots[1].stampElement, FIRE, '빈 슬롯2도 불 각인');
  });

  test('recomputeStamps 는 현재 스탠스로 재계산한다', () => {
    const w = mkWorld();
    fillSlots(w);
    const [FIRE, WATER] = w.data.elements.investable;
    investElement(w, WATER);
    investElement(w, WATER);   // 물 = 2
    w.player.stance = WATER;   // 직접 세팅 후 재계산 (재계산의 순수성 확인)
    recomputeStamps(w);
    assert.eq(w.slots[0].stampElement, WATER, '슬롯1 물');
    assert.eq(w.slots[1].stampElement, WATER, '슬롯2 물');
    assert.eq(w.slots[2].stampElement, NORMAL, '슬롯3 무속성');
  });
});

suite('stance/switch', () => {
  test('같은 스탠스로의 전환은 무시된다 (false)', () => {
    const w = mkWorld();
    assert.eq(requestStance(w, w.player.stance), false, '동일 스탠스 = false');
  });

  test('어휘 밖 속성으로의 전환은 throw (§4.1)', () => {
    const w = mkWorld();
    assert.throws(() => requestStance(w, 'plasma'), '어휘 밖은 던진다');
  });

  test('쿨다운이 남아 있으면 전환 무시 (구조는 존재, 값은 0)', () => {
    const w = mkWorld();
    const [FIRE] = w.data.elements.investable;
    w.player.stanceCooldown = 1;                 // 인위적으로 굳힘
    assert.eq(requestStance(w, FIRE), false, '쿨다운 중 = false');
    assert.eq(w.player.stance, NORMAL, '스탠스 불변');
  });

  test('전환 성공 시 쿨다운은 data 의 stanceSwitchCooldown (=0)', () => {
    const w = mkWorld();
    const [FIRE] = w.data.elements.investable;
    requestStance(w, FIRE);
    assert.eq(w.player.stanceCooldown, w.data.rules.player.stanceSwitchCooldown, '쿨다운 = data 값');
  });
});

suite('stance/invest-caps', () => {
  test('노말 투자(+1) 카드는 존재하지 않는다 → investElement(normal) throw (§4.2)', () => {
    const w = mkWorld();
    assert.throws(() => investElement(w, NORMAL), '노말 투자는 던진다');
  });

  test('개별 상한 elementCapPerElement 에서 멈춘다 (§4.2)', () => {
    const w = mkWorld();
    const [FIRE] = w.data.elements.investable;
    const cap = w.data.rules.player.elementCapPerElement;
    let ok = 0;
    for (let i = 0; i < cap; i += 1) if (investElement(w, FIRE)) ok += 1;
    assert.eq(ok, cap, `상한까지 ${cap}회 성공`);
    assert.eq(investElement(w, FIRE), false, '개별 상한 초과 = false');
    assert.eq(investmentOf(w, FIRE), cap, '값은 상한에 고정');
  });

  test('합계 상한 elementCapTotal 에서 멈춘다 (§4.2)', () => {
    const w = mkWorld();
    const [FIRE, WATER, GRASS] = w.data.elements.investable;
    const total = w.data.rules.player.elementCapTotal;
    const per = w.data.rules.player.elementCapPerElement;
    // 돌아가며 합계 상한까지 채운다 (v1.10 ⑱: 합계 12 = 3 × 4 — 전 속성 만렙이 «가능»하다)
    const cyc = [FIRE, WATER, GRASS];
    let n = 0;
    for (let i = 0; n < total && i < total * 2; i += 1) { if (investElement(w, cyc[i % 3])) n += 1; }
    assert.eq(investTotal(w), total, `합계 = ${total}`);
    assert.eq(investElement(w, FIRE), false, '합계 상한 초과 = false');
    if (total === 3 * per) for (const e of cyc) assert.eq(w.player.invest[e], per, `${e} 만렙 ${per}`);
  });
});

suite('stance/stampFor', () => {
  test('spawn 모드 = 생성 각인 불변 (각인 세탁 방지 §4.4)', () => {
    const w = mkWorld();
    const [FIRE, WATER] = w.data.elements.investable;
    w.slots[0].stampElement = FIRE;              // 슬롯의 현재 각인 = 불
    // spawn 개체는 생성 시각인(WATER)을 그대로 쓴다 — 슬롯 각인이 바뀌어도 불변
    assert.eq(stampFor(w, 0, 'spawn', WATER), WATER, 'spawn = 생성값');
  });

  test('live 모드 = 슬롯의 현재 각인을 재평가 (orbit·aura §4.4)', () => {
    const w = mkWorld();
    const [FIRE, WATER] = w.data.elements.investable;
    w.slots[0].stampElement = FIRE;
    // live 는 생성값(WATER)을 무시하고 슬롯의 지금 각인(FIRE)을 읽는다
    assert.eq(stampFor(w, 0, 'live', WATER), FIRE, 'live = 현재 슬롯 각인');
  });
});
