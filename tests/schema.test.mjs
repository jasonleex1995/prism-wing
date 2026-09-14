/**
 * tests/schema.test.mjs — §9.2·§9.3 로더 계약 (schema.mjs)
 *
 * 정본 계약 (design/CANON.md):
 *   §9.2  매니페스트 = 정확히 9개, 닫힘 (여분 파일도 에러, 누락도 에러)
 *   §9.3  schemaVersion 필수/일치 · **미지 키 = 에러** · **누락 키 = 에러(폴백 금지)**
 *         · 참조 무결성 · 동결 어휘(vocab)
 *
 * ★ validate() 는 위반이 하나라도 있으면 throw, 정상이면 같은 객체를 돌려준다.
 * ★ loadData() 는 캐시된 공유 객체이므로 매 테스트 JSON 딥클론 후 변조한다 (오염 방지).
 */

import { suite, test, assert, loadData } from '../tools/test.mjs';
import { validate, MANIFEST, SCHEMA_VERSION } from '../src/core/schema.mjs';

/** 검증 통과본의 딥클론 (변조용). loadData 는 이미 validate 를 통과한 상태 */
function clone() { return JSON.parse(JSON.stringify(loadData())); }

suite('schema/positive', () => {
  test('정상 11파일은 통과하고 같은 객체를 돌려준다 (§9.3 · v1.10 ⑲ traits · ㊴ tutorial)', () => {
    const raw = clone();
    const out = validate(raw);
    assert.eq(out, raw, 'validate 는 입력 객체를 그대로 반환');
    assert.eq(MANIFEST.length, 11, '매니페스트 = 11개 (rules·elements·weapons·passives·bullets·enemies·bosses·stages·meta·traits·tutorial)');
  });
});

suite('schema/schemaVersion', () => {
  test('schemaVersion 불일치 → throw (§9.3)', () => {
    const raw = clone();
    raw.meta.schemaVersion = SCHEMA_VERSION + 1;
    assert.throws(() => validate(raw), '버전 불일치는 던진다');
  });

  test('schemaVersion 누락 → throw (§9.3 모든 파일 루트 필수)', () => {
    const raw = clone();
    delete raw.bullets.schemaVersion;
    assert.throws(() => validate(raw), '버전 누락은 던진다');
  });
});

suite('schema/manifest', () => {
  test('매니페스트 밖의 여분 파일 → throw (§9.2 닫힘)', () => {
    const raw = clone();
    raw.bonus = { schemaVersion: SCHEMA_VERSION };
    assert.throws(() => validate(raw), '여분 파일은 던진다');
  });

  test('매니페스트 파일 누락 → throw (§9.2)', () => {
    const raw = clone();
    delete raw.bosses;
    assert.throws(() => validate(raw), '파일 누락은 던진다');
  });
});

suite('schema/unknown-and-missing-keys', () => {
  test('미지 키 → throw (§9.3 — 인쇄 블록에 자리 없음)', () => {
    const raw = clone();
    raw.elements.bogusKey = 1;
    assert.throws(() => validate(raw), '미지 키는 던진다');
  });

  test('중첩 미지 키(rules.loop) → throw (§9.3)', () => {
    const raw = clone();
    raw.rules.loop.bogus = true;
    assert.throws(() => validate(raw), '중첩 미지 키도 던진다');
  });

  test('누락 키 → throw, 폴백 금지 (§9.3)', () => {
    const raw = clone();
    delete raw.rules.player.hpMax;
    assert.throws(() => validate(raw), '누락 키는 던진다 (기본값으로 때우지 않는다)');
  });
});

suite('schema/references', () => {
  // §11.1(v1.6) startWeaponId 는 폐지됐다(시작 무기는 매 런 추첨). 그 자리를 지키던
  //   참조 검사를 «폐지 키가 되살아나면 잡는다» 로 바꾼다 — 되살아난 키를 닫힌-키
  //   규칙이 잡지 못하면 데이터가 조용히 무시되는 채로 통과한다.
  test('폐지된 startWeaponId 가 되살아나면 → throw (§9.3 닫힌 키)', () => {
    const raw = clone();
    raw.rules.player.startWeaponId = 'forward';       // 존재하는 무기라도 키 자체가 없다
    assert.throws(() => validate(raw), '폐지 키는 값이 멀쩡해도 던진다');
  });

  test('잘못된 참조 stages[].bossId → throw (§9.3)', () => {
    const raw = clone();
    raw.stages.stages[0].bossId = 'nope';
    assert.throws(() => validate(raw), '없는 보스 참조는 던진다');
  });
});

suite('schema/frozen-vocab', () => {
  test('rules.player.startStance 가 4속성 밖이면 throw (§4.1 vocab)', () => {
    const raw = clone();
    raw.rules.player.startStance = 'plasma';
    assert.throws(() => validate(raw), '어휘 밖 스탠스는 던진다');
  });

  test('elements.order 가 Q W E R 순서를 어기면 throw (§4.1)', () => {
    const raw = clone();
    const o = raw.elements.order;
    [o[1], o[2]] = [o[2], o[1]];          // 불↔물 순서 뒤집기
    assert.throws(() => validate(raw), '표 순서 위반은 던진다');
  });

  test('elements.investable 에 normal 이 섞이면 throw (§4.2)', () => {
    const raw = clone();
    raw.elements.investable = ['normal', ...raw.elements.investable];
    assert.throws(() => validate(raw), '노말은 투자축이 아니다');
  });

  test('weapons 가 정확히 12행이 아니면 throw (§9.5)', () => {
    const raw = clone();
    raw.weapons.weapons.pop();
    assert.throws(() => validate(raw), '11행은 던진다');
  });
});

suite('schema/fairness', () => {
  test('playerWeaponsExempt 가 true 가 아니면 throw (§9.5)', () => {
    const raw = clone();
    raw.rules.fairness.playerWeaponsExempt = false;
    assert.throws(() => validate(raw), '공정성 면제 플래그 위반은 던진다');
  });
});
