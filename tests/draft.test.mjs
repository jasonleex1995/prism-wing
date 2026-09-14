/**
 * tests/draft.test.mjs — §11.1 드래프트 계약
 *
 * 정본 계약 (design/CANON.md §11.1):
 *   - 카테고리를 먼저 뽑지 않는다. 유효 후보 **전체**를 가중치 목록으로 만들고 비복원 optionCount 장 추첨.
 *   - weight = categoryWeights[cat] × modifier
 *   - 유효성 필터: 만석 newWeapon 전체 제외 · 보유무기 newWeapon 제외 · 속성 상한 · 죽은 투자 차단
 *   - 보장: 첫 드래프트 속성 · guaranteeNewWeaponUntilSlots · 피티(elementCardPity)
 *   - 동시 보장 추첨 순서 = [elementLevel, newWeapon] (v1.4 확정)
 *   - 보장 카테고리에 유효 후보 0 → 보장 소멸 (v1.4)
 *   - 리롤: 3장 전체 재추첨, 이전 3장 그 드래프트 동안 제외
 *
 * ★ 값(가중치·피티·상한)은 전부 meta.draft / rules.player 에서 유도.
 */

import { suite, test, assert, loadData } from '../tools/test.mjs';
import { createWorld, giveWeapon, levelUpWeapon, givePassive } from '../src/core/state.js';
import { investElement } from '../src/core/stance.js';
import {
  candidates, buildDraft, applyCard,
} from '../src/core/draft.js';

const SEED = 0x5EED1234;

function mkWorld(seed = SEED) {
  return createWorld({ data: loadData(), seed, weapons: {}, startWeaponId: 'forward' });
}

function keysOf(cards) { return cards.map((c) => c.key); }
function catCount(list, cat) { return list.filter((c) => c.category === cat).length; }
function findCat(list, cat) { return list.find((c) => c.category === cat); }

suite('draft/candidates', () => {
  test('보유 무기는 newWeapon 후보에서 제외 → forward 영영 안 나옴 (§11.1)', () => {
    const w = mkWorld();
    const cand = candidates(w);
    const newW = cand.filter((c) => c.category === 'newWeapon');
    const nWeapons = w.data.weapons.weapons.length;
    assert.eq(newW.length, nWeapons - 1, '보유 1개(forward) 제외 → N-1 종');
    assert.eq(newW.some((c) => c.weaponId === w.data.rules.player.startWeaponId), false,
      'forward 는 newWeapon 후보에 없다');
  });

  test('newWeapon 가중치 = categoryWeights.newWeapon × newWeaponSlotScale[보유-1] (§11.1)', () => {
    const w = mkWorld();
    const d = w.data.meta.draft;
    const nWeapons = 1;                              // forward 만
    const expect = d.categoryWeights.newWeapon * d.newWeaponSlotScale[nWeapons - 1];
    const c = findCat(candidates(w), 'newWeapon');
    assert.eq(c.weight, expect, `가중치 = ${expect}`);
  });

  test('elementLevel 첫 투자 가중치 = elementLevel × elementFirstLevelBonus (§11.1)', () => {
    const w = mkWorld();
    const d = w.data.meta.draft;
    const c = findCat(candidates(w), 'elementLevel');
    assert.eq(c.weight, d.categoryWeights.elementLevel * d.elementFirstLevelBonus, '첫 투자 보너스 반영');
  });

  test('passive 신규 가중치 = passive × passiveNewBonus (§11.1)', () => {
    const w = mkWorld();
    const d = w.data.meta.draft;
    const owned = new Set(w.passives.filter((p) => p.id !== null).map((p) => p.id));   // ㉚ 시작 짝 패시브 1개
    const cs = candidates(w).filter((x) => x.category === 'passive');
    const c = cs.find((x) => !owned.has(x.passiveId));
    assert.eq(c.weight, d.categoryWeights.passive * d.passiveNewBonus, '신규 패시브 보너스');
    const o = cs.find((x) => owned.has(x.passiveId));
    assert.eq(o.weight, d.categoryWeights.passive, '보유 패시브(시작 짝)는 보너스 없음');
  });

  test('㊲ 미보유 무기 분류 패시브는 «유효한 무기»가 있어야 나온다 — 기체 4 는 항상, 보유(Lv≥1)한 뒤엔 계속 (§11.1)', () => {
    const w = mkWorld();                                  // forward(탄) 만 보유 · 시작 짝 overclock Lv1
    const ids = (x) => new Set(x.filter((c) => c.category === 'passive').map((c) => c.passiveId));
    let got = ids(candidates(w));
    for (const id of ['autoload', 'coating', 'booster', 'battery']) assert.ok(got.has(id), `탄 패시브 ${id} 등장(벌컨 보유)`);
    for (const id of ['bulkhead', 'stabilizer', 'study', 'resonance']) assert.ok(got.has(id), `기체 패시브 ${id} 는 항상`);
    for (const id of ['highvolt', 'lens', 'coil', 'shockwave', 'orbitext']) assert.eq(got.has(id), false, `${id} 는 유효한 무기가 없어 미등장`);
    giveWeapon(w, 'beam');                                // 빔 무기가 생기면 빔 패시브 2 가 열린다
    got = ids(candidates(w));
    assert.ok(got.has('highvolt') && got.has('lens'), '빔 보유 → 고압·집속 렌즈 등장');
    assert.eq(got.has('coil'), false, '범위 무기 없음 → 코일 여전히 미등장');
    giveWeapon(w, 'missile');                             // 미사일 = 탄이지만 폭발이 범위 훅(areaKeys·areaDmgMul)
    got = ids(candidates(w));
    assert.ok(got.has('coil') && got.has('shockwave'), '미사일 보유 → 확장 코일·충격파 등장');
    assert.eq(got.has('orbitext'), false, '궤도 무기 없음 → 궤도 확장 미등장');
    // 보유한 분류 패시브는 그 분류 무기가 없어도 계속 나온다(레벨업) — 새 월드에서 강제로 orbitext 를 들려 본다
    const w2 = mkWorld(); givePassive(w2, 'orbitext');
    assert.ok(ids(candidates(w2)).has('orbitext'), '보유(Lv1) 궤도 확장은 궤도 무기 없이도 레벨업 카드로 나온다');
  });

  test('Lv7 진화 카드는 짝 패시브 Lv3 이 있어야 등장한다 (§9.5 v1.5 뱀서식)', () => {
    const w = mkWorld();
    const d = w.data.meta.draft;
    for (let i = 0; i < 6; i += 1) levelUpWeapon(w, 0);   // forward Lv1 → Lv7
    // 짝 패시브(overclock) 없이는 진화(Lv8) 카드가 나오지 않는다 → 무기는 Lv7 에서 멈춘다
    let c = candidates(w).find((x) => x.category === 'weaponLevel' && x.weaponId === 'forward');
    assert.eq(c, undefined, '짝 패시브 없으면 Lv8 진화 카드 미등장');
    // overclock 을 Lv3 까지 투자하면 진화 카드가 등장한다
    for (let i = 0; i < 3; i += 1) givePassive(w, 'overclock');
    c = candidates(w).find((x) => x.category === 'weaponLevel' && x.weaponId === 'forward');
    assert.eq(c.isEvolution, true, 'Lv7→Lv8 = 진화 (짝 패시브 Lv3 충족)');
    assert.eq(c.weight, d.categoryWeights.weaponLevel * d.weaponLevelEvolutionBonus, '진화 보너스 가중치');
  });

  test('무기 4칸 만석 → newWeapon 카테고리 전체 제외 (§11.1)', () => {
    const w = mkWorld();
    const ids = w.data.weapons.weapons.map((x) => x.id);
    for (let i = 0; i < ids.length && w.slots.some((s) => s.weaponId === null); i += 1) {
      if (!w.slots.some((s) => s.weaponId === ids[i])) giveWeapon(w, ids[i]);
    }
    assert.eq(catCount(candidates(w), 'newWeapon'), 0, '만석이면 newWeapon 후보 0');
  });

  test('죽은 투자 차단 — 속성 레벨 ≥ 보유 무기 수면 그 속성 제외 (§11.1)', () => {
    const w = mkWorld();                       // 무기 1개
    const [FIRE] = w.data.elements.investable;
    investElement(w, FIRE);                     // 불 = 1 ≥ 보유(1) → 불 제외
    const els = candidates(w).filter((c) => c.category === 'elementLevel').map((c) => c.element);
    assert.eq(els.indexOf(FIRE), -1, '불(레벨1 ≥ 무기1)은 후보에서 빠진다');
    assert.gt(els.length, 0, '물·풀(레벨0)은 여전히 후보');
  });

  test('후보 키는 전부 고유 (비복원 추첨의 전제)', () => {
    const w = mkWorld();
    const ks = keysOf(candidates(w));
    assert.eq(new Set(ks).size, ks.length, '중복 키 없음');
  });
});

suite('draft/build', () => {
  test('optionCount 장을 서로 다른 아이템으로 낸다 (비복원 §11.1)', () => {
    const w = mkWorld();
    const dr = buildDraft(w);
    assert.eq(dr.cards.length, w.data.meta.draft.optionCount, 'optionCount 장');
    const ks = keysOf(dr.cards);
    assert.eq(new Set(ks).size, ks.length, '3장 서로 다름');
  });

  test('첫 드래프트는 속성 카드를 반드시 낸다 (guaranteeElementCardOnFirstDraft)', () => {
    const w = mkWorld();
    assert.eq(w.draftsSeen, 0, '첫 드래프트');
    const dr = buildDraft(w);
    assert.gte(catCount(dr.cards, 'elementLevel'), 1, '속성 카드 ≥ 1장');
  });

  test('동시 보장 추첨 순서 = [elementLevel, newWeapon] (v1.4 · 결정성 회귀)', () => {
    const w = mkWorld();
    // 첫 드래프트(속성 보장) + 보유 1<2(무기 보장) → 두 보장이 동시
    const dr = buildDraft(w);
    assert.eq(dr.cards[0].category, 'elementLevel', '보장 1번 = elementLevel');
    assert.eq(dr.cards[1].category, 'newWeapon', '보장 2번 = newWeapon');
  });

  test('무기 만석이면 드래프트에 newWeapon 카드가 없다 (§11.1)', () => {
    const w = mkWorld();
    const ids = w.data.weapons.weapons.map((x) => x.id);
    for (let i = 0; i < ids.length && w.slots.some((s) => s.weaponId === null); i += 1) {
      if (!w.slots.some((s) => s.weaponId === ids[i])) giveWeapon(w, ids[i]);
    }
    w.draftsSeen = 5;               // 첫 드래프트 보장 회피
    const dr = buildDraft(w);
    assert.eq(catCount(dr.cards, 'newWeapon'), 0, 'newWeapon 카드 0');
  });

  test('회귀(v1.10 ㉓ · 플레이테스트 「Lv13 에 보급 3장」) — 무기를 1개부터 만석까지 채우는 동안 후보가 있으면 폴백은 0장, 가중치는 전부 유한', () => {
    const w = mkWorld();
    const rp = w.data.rules.player;
    assert.eq(w.data.meta.draft.newWeaponSlotScale.length, rp.weaponSlots, 'newWeaponSlotScale 길이 = weaponSlots');
    const ids = w.data.weapons.weapons.map((x) => x.id);
    w.draftsSeen = 5;
    let owned = w.slots.filter((s) => s.weaponId !== null).length;
    for (;;) {
      const pool = candidates(w);
      for (const c of pool) assert.ok(Number.isFinite(c.weight) && c.weight > 0, `${c.key}: 가중치 ${c.weight} 유한·양수 (무기 ${owned}개)`);
      const dr = buildDraft(w);
      assert.eq(catCount(dr.cards, 'resupply'), 0, `무기 ${owned}개: 유효 후보 ${pool.length}개인데 폴백이 나오면 안 된다`);
      const next = ids.find((id) => !w.slots.some((s) => s.weaponId === id) && w.slots.some((s) => s.weaponId === null));
      if (next === undefined || !giveWeapon(w, next)) break;
      owned += 1;
    }
    assert.eq(owned, rp.weaponSlots, `만석(${rp.weaponSlots})까지 채웠다`);
  });
});

suite('draft/pity', () => {
  test('속성 카드 미등장 드래프트 → elementPity +1 (§11.1)', () => {
    const w = mkWorld();
    const [FIRE, WATER, GRASS] = w.data.elements.investable;
    investElement(w, FIRE); investElement(w, WATER); investElement(w, GRASS); // 각 1 ≥ 무기1 → 전부 차단
    w.draftsSeen = 1;               // 첫 드래프트 보장 회피
    w.elementPity = 0;
    const dr = buildDraft(w);
    assert.eq(catCount(dr.cards, 'elementLevel'), 0, '속성 후보 0 → 카드 없음');
    assert.eq(w.elementPity, 1, '피티 카운터 +1');
  });

  test('피티 임계(elementCardPity-1) → 속성 카드 강제 등장 + 카운터 리셋', () => {
    const w = mkWorld();
    const pity = w.data.meta.draft.elementCardPity;
    w.draftsSeen = 1;               // 첫 드래프트 보장이 아니라 피티 경로로
    w.elementPity = pity - 1;       // 임계
    const dr = buildDraft(w);
    assert.gte(catCount(dr.cards, 'elementLevel'), 1, '피티가 속성 카드를 강제');
    assert.eq(w.elementPity, 0, '등장했으니 리셋');
  });

  test('보장 카테고리에 유효 후보 0이면 보장은 소멸한다 (v1.4)', () => {
    const w = mkWorld();
    const [FIRE, WATER, GRASS] = w.data.elements.investable;
    investElement(w, FIRE); investElement(w, WATER); investElement(w, GRASS); // 속성 후보 전멸
    const pity = w.data.meta.draft.elementCardPity;
    w.draftsSeen = 1;
    w.elementPity = pity - 1;       // 피티가 elementLevel 을 강제하지만 후보가 없다
    const dr = buildDraft(w);
    assert.eq(dr.cards.length, w.data.meta.draft.optionCount, '빈 화면 불가 — 여전히 3장');
    assert.eq(catCount(dr.cards, 'elementLevel'), 0, '지어내지 않는다 (보장 소멸)');
    assert.eq(w.elementPity, pity, '미등장이므로 피티 계속 증가');
  });
});


suite('draft/apply', () => {
  test('첫 속성 확정 = 투자 0→1 최초 전이에서 스탠스 자동 장착 (§9.9 onboarding)', () => {
    const w = mkWorld();
    const [FIRE, WATER] = w.data.elements.investable;
    applyCard(w, { category: 'elementLevel', element: FIRE });
    assert.eq(w.player.invest[FIRE], 1, '불 투자 1');
    assert.eq(w.player.stance, FIRE, '스탠스 자동 = 불');
    // 두 번째 속성은 최초 전이가 아니므로 스탠스 유지
    applyCard(w, { category: 'elementLevel', element: WATER });
    assert.eq(w.player.invest[WATER], 1, '물 투자 1');
    assert.eq(w.player.stance, FIRE, '스탠스는 불 유지 (자동 장착은 최초 1회)');
  });

  test('newWeapon 확정은 가장 앞 빈 슬롯에 배치 (append §11.1)', () => {
    const w = mkWorld();
    applyCard(w, { category: 'newWeapon', weaponId: 'fan' });
    assert.eq(w.slots[1].weaponId, 'fan', '빈 슬롯2에 fan');
  });

  test('weaponLevel 확정은 weaponId 로 현재 슬롯을 찾아 레벨업 (§5.3 stale 슬롯 방어)', () => {
    const w = mkWorld();
    const before = w.slots[0].level;
    applyCard(w, { category: 'weaponLevel', weaponId: 'forward', slot: 99 }); // slot 인덱스가 stale 이어도
    assert.eq(w.slots[0].level, before + 1, 'weaponId 로 해소해 레벨업');
  });

  test('카드 확정은 draftsSeen +1, draftQueue -1 (§6.4)', () => {
    const w = mkWorld();
    w.draftQueue = 2;
    const seen = w.draftsSeen;
    applyCard(w, { category: 'resupply', healPct: 0.25 });
    assert.eq(w.draftsSeen, seen + 1, 'draftsSeen +1');
    assert.eq(w.draftQueue, 1, 'draftQueue -1');
  });

  test('미지 카테고리는 throw (§11.1)', () => {
    const w = mkWorld();
    assert.throws(() => applyCard(w, { category: 'bogus' }), '미지 카테고리는 던진다');
  });
});

suite('draft/determinism', () => {
  test('같은 시드 → 같은 드래프트, 다른 시드 → 다른 드래프트 (§10)', () => {
    const a = keysOf(buildDraft(mkWorld(111)).cards);
    const b = keysOf(buildDraft(mkWorld(111)).cards);
    const c = keysOf(buildDraft(mkWorld(222)).cards);
    assert.deepEq(a, b, '동일 시드 = 비트 동일');
    assert.ne(JSON.stringify(a), JSON.stringify(c), '다른 시드 = 상이 (자유 1장 이상 갈림)');
  });
});
