/**
 * src/core/rng.js
 *
 * 정본 v1.4 구현 절:
 *   §10.2  시드 RNG — sfc32, 정수 연산만 → 모든 엔진에서 비트 동일
 *   §10.2  독립 스트림 9종 (동결): theme draft spawn elite drop pattern boss bot terrain(v1.10 ⑦)
 *   §10.3  L1 콘텐츠 결정성 — "RNG가 정수 연산뿐"이 엔진 무관 보장의 근거
 *   §9.1   core 순수성 — 금지 식별자 0, core 밖 import 0
 *
 * 마스터 시드는 core 바깥(main.js)에서 생성해 주입한다 (§10.2).
 * 이 파일은 시드를 만들지 않는다 — 만들 수단(시계)이 core에 없다.
 */

/** §10.2 — 독립 스트림 9종. 동결(v1.10 ⑦ terrain 추가). */
export const RNG_STREAMS = ['theme', 'draft', 'spawn', 'elite', 'drop', 'pattern', 'boss', 'bot', 'terrain'];   // v1.10 ⑦ terrain(§8.21 지형 장판 위치)

const TWO_POW_32 = 4294967296;

/**
 * §10.2 — 문자열 이름 → uint32. FNV-1a + murmur3 fmix32 확산.
 * 정수 연산만. 부동소수 경로가 없으므로 엔진 간 비트 동일.
 */
export function hash32(seed, name) {
  let h = ((seed >>> 0) ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < name.length; i += 1) {
    h = (h ^ name.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h >>> 0;
}

/** 시드 1워드 → sfc32 상태 4워드. splitmix32, 정수 연산만. */
function expand(seed) {
  let s = seed >>> 0;
  const out = [0, 0, 0, 0];
  for (let i = 0; i < 4; i += 1) {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    out[i] = (z ^ (z >>> 15)) >>> 0;
  }
  return out;
}

/**
 * §10.2 — makeRng(seed) → { u32, f, range, int, pick, weighted, shuffle }
 *
 * ★ 상태 전이(sfc32)는 정수 연산만 쓴다. f()의 나눗셈은 상태를 건드리지 않는 순수 사상이며
 *   2^32 로 나누는 것은 모든 IEEE754 엔진에서 정확하다(2의 거듭제곱 나눗셈 = 지수만 감소).
 */
export function makeRng(seed) {
  const st = expand(seed);
  let a = st[0] | 0;
  let b = st[1] | 0;
  let c = st[2] | 0;
  let d = st[3] | 0;

  /** sfc32 1스텝 → uint32 */
  const u32 = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = ((c << 21) | (c >>> 11)) | 0;
    c = (c + t) | 0;
    return t >>> 0;
  };

  // 웜업 — 시드의 저엔트로피 비트가 초기 출력에 새지 않게 한다.
  for (let i = 0; i < 12; i += 1) u32();

  /** [0, 1) 실수 */
  const f = () => u32() / TWO_POW_32;

  /** [lo, hi) 실수 */
  const range = (lo, hi) => lo + (hi - lo) * f();

  /** [lo, hi] 정수 (양 끝 포함) */
  const int = (lo, hi) => lo + Math.floor((hi - lo + 1) * f());

  /** 배열에서 균등 1개. 인덱스 오름차순 세계에서만 쓴다 (§10.3) */
  const pick = (arr) => arr[Math.floor(arr.length * f())];

  /**
   * 가중 추첨 → **인덱스**를 돌려준다 (총합 ≤ 0이면 -1).
   * ★ §10.2(v1.4) 확정 — 시그니처는 `weighted(weights[])`(가중치 배열, 인덱스 오름차순)다.
   *   v1.3의 `weighted(map)`은 §10.3의 「Map/Set 순회 금지」(순회 순서 비결정)와 자기모순이었고
   *   정본이 배열로 고쳐 닫았다 — 순회는 인덱스 오름차순, 결정성 규칙과 정합.
   */
  const weighted = (weights) => {
    let total = 0;
    for (let i = 0; i < weights.length; i += 1) total += weights[i];
    if (!(total > 0)) return -1;
    let r = f() * total;
    for (let i = 0; i < weights.length; i += 1) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  };

  /** Fisher-Yates. 제자리, 내림차순 인덱스 — 순서가 유일하게 결정된다 */
  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor((i + 1) * f());
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  };

  return { u32, f, range, int, pick, weighted, shuffle };
}

/** §10.2 — stream(masterSeed, name) → makeRng(hash32(masterSeed, name)) */
export function stream(masterSeed, name) {
  return makeRng(hash32(masterSeed, name));
}

/**
 * §10.2 — 마스터 시드 하나에서 8 스트림을 만든다. 스트림 간 상태 공유 없음.
 * ★ 한 스트림에 draw를 추가해도 다른 스트림이 밀리지 않는다 (이전 인증이 무효가 되지 않는 근거).
 */
export function makeStreams(masterSeed) {
  const seed = masterSeed >>> 0;
  return {
    theme: stream(seed, 'theme'),
    draft: stream(seed, 'draft'),
    spawn: stream(seed, 'spawn'),
    elite: stream(seed, 'elite'),
    drop: stream(seed, 'drop'),
    pattern: stream(seed, 'pattern'),
    boss: stream(seed, 'boss'),
    bot: stream(seed, 'bot'),
    terrain: stream(seed, 'terrain'),   // v1.10 ⑦ — §8.21 지형 장판의 x 위치
  };
}

/** §2.6 — 시드는 결과 화면에 8자리 hex로 표시된다 */
export function seedHex(masterSeed) {
  const s = (masterSeed >>> 0).toString(16);
  return '00000000'.slice(s.length) + s;
}
