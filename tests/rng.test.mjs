/**
 * tests/rng.test.mjs — §10.2 시드 RNG 계약
 *
 * 단언 대상:
 *   - 결정성 (L1): 같은 시드 → 비트 동일 수열. 다른 시드 → 상이.
 *   - 9스트림 독립 (동결): makeStreams가 9종 전부 만든다 · 스트림 간 상태 공유 없음 ·
 *     ★ 회귀: 한 스트림에 draw를 추가해도 다른 스트림이 밀리지 않는다 (이전 인증 무효화 방지).
 *   - 분포 sanity: f∈[0,1) · int∈[lo,hi] 양끝포함 · weighted 인덱스/음성 · pick · shuffle 순열.
 *   - hash32: 결정적 · 이름 민감 · 시드 민감 · uint32.
 */
import { suite, test, assert } from '../tools/test.mjs';
import { makeStreams, makeRng, stream, hash32, RNG_STREAMS, seedHex } from '../src/core/rng.js';

// ── hash32 ───────────────────────────────────────────────────────────────
suite('rng.hash32', () => {
  test('결정적: 같은 (seed,name) → 같은 값', () => {
    assert.eq(hash32(12345, 'draft'), hash32(12345, 'draft'), '동일 입력 = 동일 출력');
    assert.eq(hash32(0, 'theme'), hash32(0, 'theme'));
  });

  test('이름 민감: 다른 name → 다른 값 (스트림 분리의 근거)', () => {
    const s = 777;
    assert.ne(hash32(s, 'draft'), hash32(s, 'spawn'), 'draft ≠ spawn');
    assert.ne(hash32(s, 'theme'), hash32(s, 'boss'), 'theme ≠ boss');
  });

  test('시드 민감: 다른 seed → 다른 값', () => {
    assert.ne(hash32(1, 'draft'), hash32(2, 'draft'), 'seed 1 ≠ seed 2');
  });

  test('uint32 반환: 정수 · [0, 2^32) · >>>0 불변', () => {
    for (const name of RNG_STREAMS) {
      const h = hash32(0xdeadbeef, name);
      assert.ok(Number.isInteger(h), `${name}: 정수`);
      assert.gte(h, 0, `${name}: >= 0`);
      assert.lt(h, 2 ** 32, `${name}: < 2^32`);
      assert.eq(h, h >>> 0, `${name}: uint32 정규형`);
    }
  });

  test('음수 시드도 >>>0 처리되어 결정적 (main.js가 uint32로 주입)', () => {
    // hash32 내부가 (seed>>>0)로 정규화 → -1 과 0xffffffff 는 같은 스트림
    assert.eq(hash32(-1, 'draft'), hash32(0xffffffff, 'draft'), '-1 ≡ 0xffffffff');
  });
});

// ── 골든 벡터 (L0) ─────────────────────────────────────────────────────────
//  ★ 아래 «결정성» 스위트는 전부 구현을 **자기 자신과** 비교한다 — 같은 시드로 두 번 뽑아
//    같은지 보는 식이라, PRNG 를 실제로 고쳐도(예: 믹싱의 `a + b` → `a - b`, warmup 12 → 11)
//    전부 통과한다. 실측으로 확인된 사각지대다.
//    비트열 자체를 리터럴로 못박아야 «결정론적이다」가 아니라 «이 수열이다»가 지켜진다.
//    이 값들이 깨지면 = 세이브된 시드가 다른 런을 만든다 = 인증 결과가 무효다.
//    의도적으로 PRNG 를 바꿀 때만 아래 리터럴을 갱신할 것.
suite('rng.golden', () => {
  test('makeRng(424242) 첫 8 u32 = 고정 비트열', () => {
    const r = makeRng(424242);
    const want = [2833839457, 2826496713, 200798350, 3835731397,
                  4175686688, 2378452902, 1146866796, 3686963372];
    for (let i = 0; i < want.length; i += 1) assert.eq(r.u32(), want[i], `u32[${i}]`);
  });

  test('makeRng(7) 첫 4 f() = 고정 비트열', () => {
    const r = makeRng(7);
    const want = [0.9808979157824069, 0.9695635808166116, 0.609822355909273, 0.08055529906414449];
    for (let i = 0; i < want.length; i += 1) assert.eq(r.f(), want[i], `f[${i}]`);
  });

  test('hash32(20260822, 스트림 9종) = 고정값 (스트림 분기 자체를 고정 — v1.10 ⑦ terrain 추가)', () => {
    const want = [587995892, 977572039, 4166709955, 3508841613,
                  1403557567, 3818239070, 145623808, 4082211005, 3750226928];
    assert.eq(RNG_STREAMS.length, want.length, '스트림 9종');
    for (let i = 0; i < want.length; i += 1) {
      assert.eq(hash32(20260822, RNG_STREAMS[i]), want[i], `hash32(${RNG_STREAMS[i]})`);
    }
  });

  test('stream(99,"spawn") 첫 4 u32 = 고정 비트열', () => {
    const r = stream(99, 'spawn');
    const want = [1143139963, 1075343509, 109659853, 2706370141];
    for (let i = 0; i < want.length; i += 1) assert.eq(r.u32(), want[i], `u32[${i}]`);
  });
});

// ── 결정성 (L1) ────────────────────────────────────────────────────────────
suite('rng.determinism', () => {
  test('같은 시드 → u32 수열 비트 동일', () => {
    const a = makeRng(424242), b = makeRng(424242);
    for (let i = 0; i < 64; i += 1) assert.eq(a.u32(), b.u32(), `draw ${i}`);
  });

  test('같은 시드 → f 수열 비트 동일', () => {
    const a = makeRng(9), b = makeRng(9);
    for (let i = 0; i < 32; i += 1) assert.eq(a.f(), b.f(), `f ${i}`);
  });

  test('다른 시드 → 수열 상이 (첫 draw부터)', () => {
    const a = makeRng(1).u32(), b = makeRng(2).u32();
    assert.ne(a, b, 'seed 1 vs 2 첫 u32');
  });

  test('stream(master,name) == makeRng(hash32(master,name))', () => {
    const master = 55;
    const viaStream = stream(master, 'draft');
    const viaRng = makeRng(hash32(master, 'draft'));
    for (let i = 0; i < 16; i += 1) assert.eq(viaStream.u32(), viaRng.u32(), `draw ${i}`);
  });

  test('makeStreams 결정적: 같은 master → 스트림별 수열 동일', () => {
    const A = makeStreams(2026), B = makeStreams(2026);
    for (const name of RNG_STREAMS) {
      for (let i = 0; i < 8; i += 1) assert.eq(A[name].u32(), B[name].u32(), `${name}[${i}]`);
    }
  });
});

// ── 9스트림 독립 (동결) ─────────────────────────────────────────────────────
suite('rng.streams.independence', () => {
  test('makeStreams는 9종 전부를 만든다 (동결 목록 = RNG_STREAMS — v1.10 ⑦ terrain)', () => {
    assert.eq(RNG_STREAMS.length, 9, '스트림 9종 동결(8 + terrain)');
    const s = makeStreams(1);
    for (const name of RNG_STREAMS) {
      assert.ok(typeof s[name] === 'object' && typeof s[name].u32 === 'function', `${name} 존재`);
    }
  });

  test('스트림 간 상태 공유 없음: 한 스트림 소비가 다른 스트림 출력을 바꾸지 않는다', () => {
    // A: draft를 20회 소비한 뒤 spawn 첫 값
    const A = makeStreams(31337);
    for (let i = 0; i < 20; i += 1) A.draft.u32();
    const spawnAfterDraftDraws = A.spawn.u32();
    // B: spawn을 바로 뽑는다
    const B = makeStreams(31337);
    const spawnFresh = B.spawn.u32();
    assert.eq(spawnAfterDraftDraws, spawnFresh, 'spawn은 draft 소비량과 무관 (독립)');
  });

  test('★회귀: 한 스트림에 draw 추가 → 다른 7 스트림 수열 비트 불변 (이전 인증 무효화 방지)', () => {
    // bot 스트림(인간 런 draw 0회)을 나중에 여러 번 draw해도 나머지가 밀리지 않음이 핵심 근거.
    const control = makeStreams(8);
    const expected = {};
    for (const name of RNG_STREAMS) {
      if (name === 'bot') continue;
      expected[name] = [control[name].u32(), control[name].u32(), control[name].u32()];
    }
    // 이번엔 bot을 먼저 마구 draw한 뒤 나머지를 뽑는다
    const perturbed = makeStreams(8);
    for (let i = 0; i < 100; i += 1) perturbed.bot.u32();
    for (const name of RNG_STREAMS) {
      if (name === 'bot') continue;
      for (let i = 0; i < 3; i += 1) {
        assert.eq(perturbed[name].u32(), expected[name][i], `${name}[${i}] bot 교란에 불변`);
      }
    }
  });

  test('9스트림은 서로 다른 수열을 낸다 (같은 master에서도 이름별 분기)', () => {
    const s = makeStreams(2026);
    const firsts = RNG_STREAMS.map((n) => s[n].u32());
    const uniq = new Set(firsts);
    assert.eq(uniq.size, RNG_STREAMS.length, '8 스트림 첫 draw 전부 상이');
  });
});

// ── 분포 sanity ────────────────────────────────────────────────────────────
suite('rng.distribution', () => {
  const N = 4000;

  test('f() ∈ [0,1) 전부 · 평균 ~0.5', () => {
    const r = makeRng(101);
    let sum = 0, lo = Infinity, hi = -Infinity;
    for (let i = 0; i < N; i += 1) {
      const v = r.f();
      assert.gte(v, 0, `f >= 0 @${i}`);
      assert.lt(v, 1, `f < 1 @${i}`);
      sum += v; if (v < lo) lo = v; if (v > hi) hi = v;
    }
    const mean = sum / N;
    assert.gt(mean, 0.45, `평균 상향 (got ${mean})`);
    assert.lt(mean, 0.55, `평균 하향 (got ${mean})`);
    assert.lt(lo, 0.05, '최솟값이 0 부근까지 내려감');
    assert.gt(hi, 0.95, '최댓값이 1 부근까지 올라감');
  });

  test('int(lo,hi) ∈ [lo,hi] 양끝 포함 · 양 끝값 모두 등장', () => {
    const r = makeRng(202);
    let sawLo = false, sawHi = false;
    for (let i = 0; i < N; i += 1) {
      const v = r.int(3, 7);
      assert.gte(v, 3, 'lo 포함');
      assert.lte(v, 7, 'hi 포함');
      assert.ok(Number.isInteger(v), '정수');
      if (v === 3) sawLo = true;
      if (v === 7) sawHi = true;
    }
    assert.ok(sawLo, '하한 3 등장');
    assert.ok(sawHi, '상한 7 등장 (int는 양 끝 포함)');
  });

  test('int(k,k) → 항상 k (단일값 구간)', () => {
    const r = makeRng(5);
    for (let i = 0; i < 10; i += 1) assert.eq(r.int(4, 4), 4, '단일값');
  });

  test('range(lo,hi) ∈ [lo,hi)', () => {
    const r = makeRng(303);
    for (let i = 0; i < N; i += 1) {
      const v = r.range(-2, 5);
      assert.gte(v, -2, 'range >= lo');
      assert.lt(v, 5, 'range < hi');
    }
  });

  test('weighted: 결정 가중치 [0,1,0] → 항상 인덱스 1', () => {
    const r = makeRng(404);
    for (let i = 0; i < 50; i += 1) assert.eq(r.weighted([0, 1, 0]), 1, '유일 양수 슬롯');
  });

  test('weighted: 총합 ≤ 0 → -1 (빈 배열 · 전부 0)', () => {
    const r = makeRng(1);
    assert.eq(r.weighted([]), -1, '빈 배열');
    assert.eq(r.weighted([0, 0, 0]), -1, '전부 0');
  });

  test('weighted: 반환 인덱스는 항상 양수 가중 슬롯 · 유효 범위', () => {
    const r = makeRng(505);
    const w = [2, 0, 5, 0, 1]; // 인덱스 1,3은 절대 안 뽑혀야
    for (let i = 0; i < N; i += 1) {
      const idx = r.weighted(w);
      assert.gte(idx, 0, '유효 인덱스');
      assert.lt(idx, w.length, '범위 내');
      assert.gt(w[idx], 0, `가중치 0인 슬롯(${idx})은 뽑히지 않는다`);
    }
  });

  test('weighted: 비율 근사 (가중 8:2 → 대략 8:2)', () => {
    const r = makeRng(606);
    let c0 = 0;
    for (let i = 0; i < N; i += 1) if (r.weighted([8, 2]) === 0) c0 += 1;
    const p0 = c0 / N;
    assert.gt(p0, 0.72, `~0.8 상향 (got ${p0})`);
    assert.lt(p0, 0.88, `~0.8 하향 (got ${p0})`);
  });

  test('pick: 항상 배열 원소를 반환 · 모든 원소가 도달 가능', () => {
    const r = makeRng(707);
    const arr = ['a', 'b', 'c', 'd'];
    const seen = new Set();
    for (let i = 0; i < N; i += 1) {
      const v = r.pick(arr);
      assert.ok(arr.indexOf(v) >= 0, '배열 원소');
      seen.add(v);
    }
    assert.eq(seen.size, arr.length, '전 원소 도달');
  });

  test('shuffle: 같은 multiset을 보존 (순열)', () => {
    const r = makeRng(808);
    const src = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const out = r.shuffle(src.slice());
    assert.eq(out.length, src.length, '길이 보존');
    assert.deepEq([...out].sort((x, y) => x - y), src, '원소 집합 보존');
  });

  test('shuffle: 결정적 (같은 시드 → 같은 순열)', () => {
    const a = makeRng(9).shuffle([0, 1, 2, 3, 4, 5]);
    const b = makeRng(9).shuffle([0, 1, 2, 3, 4, 5]);
    assert.deepEq(a, b, '동일 시드 = 동일 셔플');
  });
});

// ── seedHex (§2.6 8자리 hex) ───────────────────────────────────────────────
suite('rng.seedHex', () => {
  test('8자리 0패딩 hex', () => {
    assert.eq(seedHex(0), '00000000', '0 패딩');
    assert.eq(seedHex(255), '000000ff', '작은 값 패딩');
    assert.eq(seedHex(0xdeadbeef), 'deadbeef', '풀 폭');
    assert.eq(seedHex(-1), 'ffffffff', 'uint32 정규화');
  });
});
