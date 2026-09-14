/**
 * tools/test.mjs — 모듈 단위 테스트 러너 (의존성 0, node 내장만)
 *
 * 사용법:  node tools/test.mjs            (전체)
 *          node tools/test.mjs stance     (이름에 'stance' 포함된 파일만)
 *
 * 규약:
 *   - tests/*.test.mjs 를 전부 로드한다. 각 파일은 test()/suite() 를 import 해서 등록한다.
 *   - core 는 순수하므로 여기서 data/*.json 을 fs 로 읽어 validate() 후 주입한다
 *     (core 는 fs/fetch 를 모른다 — 그 규약을 테스트도 지킨다).
 *   - 실패 = exit 1. 하나라도 vacuous(assert 0개)면 그 테스트를 FAIL 처리한다.
 *
 * ★ 원칙: 테스트가 버그를 잡으면 **코드를 고친다**(테스트가 틀린 게 아니라면).
 *         테스트를 약하게 고쳐서 초록불을 만들지 않는다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// ── 등록소 ──────────────────────────────────────────────────────────────
const suites = [];
let current = null;
export function suite(name, fn) {
  current = { name, tests: [] };
  suites.push(current);
  fn();
  current = null;
}
export function test(name, fn) {
  const bucket = current ? current.tests : (suites._loose || (suites._loose = { name: '(loose)', tests: [] }, suites.push(suites._loose), suites._loose)).tests;
  bucket.push({ name, fn });
}

// ── 단언 (assert 카운트를 세어 vacuous 방지) ────────────────────────────
let _asserts = 0;
export function resetAsserts() { _asserts = 0; }
export function assertCount() { return _asserts; }
function fail(msg) { throw new Error(msg); }
export const assert = {
  ok(v, m = 'expected truthy') { _asserts++; if (!v) fail(m); },
  eq(a, b, m) { _asserts++; if (!Object.is(a, b)) fail(`${m || 'eq'}: ${fmt(a)} !== ${fmt(b)}`); },
  ne(a, b, m) { _asserts++; if (Object.is(a, b)) fail(`${m || 'ne'}: both ${fmt(a)}`); },
  near(a, b, eps = 1e-9, m) { _asserts++; if (!(Math.abs(a - b) <= eps)) fail(`${m || 'near'}: |${a} - ${b}| > ${eps}`); },
  lt(a, b, m) { _asserts++; if (!(a < b)) fail(`${m || 'lt'}: ${a} !< ${b}`); },
  lte(a, b, m) { _asserts++; if (!(a <= b)) fail(`${m || 'lte'}: ${a} !<= ${b}`); },
  gt(a, b, m) { _asserts++; if (!(a > b)) fail(`${m || 'gt'}: ${a} !> ${b}`); },
  gte(a, b, m) { _asserts++; if (!(a >= b)) fail(`${m || 'gte'}: ${a} !>= ${b}`); },
  finite(v, m) { _asserts++; if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${m || 'finite'}: ${fmt(v)}`); },
  throws(fn, m) { _asserts++; let threw = false; try { fn(); } catch { threw = true; } if (!threw) fail(m || 'expected throw'); },
  deepEq(a, b, m) { _asserts++; if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${m || 'deepEq'}: ${fmt(a)} !== ${fmt(b)}`); },
};
function fmt(v) { try { return typeof v === 'object' ? JSON.stringify(v) : String(v); } catch { return String(v); } }

// ── 데이터 로딩 (core 규약: 검증된 객체를 주입) ─────────────────────────
import { validate, MANIFEST } from '../src/core/schema.mjs';
let _data = null;
export function loadData() {
  if (_data) return _data;
  const raw = {};
  for (const name of MANIFEST) raw[name] = JSON.parse(readFileSync(join(ROOT, 'data', `${name}.json`), 'utf8'));
  _data = validate(raw); // §9.3 — 위반이면 여기서 throw
  return _data;
}

/**
 * §11.3(v1.10 ㊿) — «저작값 그대로»가 나오는 난이도 = hpMul 이 1 인 난이도(= 가장 어려운 것).
 *   저작값(bosses[].hp · curve.*)이 곧 그 난이도의 값이고 쉬운 난이도는 그 할인이므로,
 *   「hp = 저작값 × 곡선」을 주장하는 테스트는 **이 난이도의 월드**에서 봐야 한다.
 *   ★ 상수로 박지 않는다 — 표를 읽는다(난이도 이름이 또 바뀌어도 테스트는 안 깨진다).
 *   ★ ㊿-q: «적 공격력»은 반대쪽이다 — enemyDmgMul 의 기준선은 가장 «쉬운» 난이도(1)다. 그래서 「받는 피해 = 저작값」을
 *     주장하는 테스트는 이 헬퍼(헬 월드 = 피해 ×1.5)가 아니라 기본 난이도(normal) 월드를 쓴다.
 */
export function baselineDifficulty() {
  const d = loadData().meta.difficulty;
  for (const k of Object.keys(d)) if (d[k] !== null && typeof d[k] === 'object' && d[k].hpMul === 1) return k;
  throw new Error('test: hpMul === 1 인 난이도가 없다 (§11.3 ②)');
}

// ── 실행 ────────────────────────────────────────────────────────────────
async function main() {
  const filter = process.argv[2];
  const dir = join(HERE, '..', 'tests');
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort(); } catch { files = []; }
  if (filter) files = files.filter((f) => f.includes(filter));
  for (const f of files) await import(pathToFileURL(join(dir, f)).href);

  let pass = 0, failCount = 0, vacuous = 0;
  const fails = [];
  for (const s of suites) {
    for (const t of s.tests) {
      resetAsserts();
      const label = `${s.name} › ${t.name}`;
      try {
        await t.fn();
        if (assertCount() === 0) { vacuous++; failCount++; fails.push(`[VACUOUS] ${label} — 단언 0개`); }
        else pass++;
      } catch (e) {
        failCount++;
        fails.push(`[FAIL] ${label}\n        ${e && e.message ? e.message : e}`);
      }
    }
  }
  const total = pass + failCount;
  console.log('─'.repeat(70));
  for (const line of fails) console.log(line);
  if (fails.length) console.log('─'.repeat(70));
  console.log(`테스트 ${total}개 · 통과 ${pass} · 실패 ${failCount}${vacuous ? ` (vacuous ${vacuous})` : ''} · 파일 ${files.length}`);
  console.log(failCount === 0 ? '✓ 전 모듈 테스트 통과' : '✗ 실패 있음');
  process.exit(failCount === 0 ? 0 : 1);
}
main();
