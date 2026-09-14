/**
 * 대응 비교 — 같은 시나리오(idx)를 손잡이 하나만 바꿔 돌린 두 결과를 «짝지어» 잰다.
 *
 *   비대응 비교는 시나리오 간 분산에 신호가 묻힌다. 같은 idx 끼리 빼면 그 분산이
 *   통째로 상쇄되므로, 훨씬 적은 표본으로 같은 결론에 닿는다.
 *
 *   node tools/pair.mjs --base tools/report --arm tools/report-magma --theme volcano
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function readRows(dir, theme) {
  const by = new Map();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const ln of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (ln === '') continue;
      const r = JSON.parse(ln);
      if (theme !== null && r.theme !== theme) continue;
      by.set(r.idx, r);
    }
  }
  return by;
}

/** log C(n,k) — 큰 n 에서도 안전하게 */
function logChoose(n, k) {
  let s = 0;
  for (let i = 1; i <= k; i += 1) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/**
 * 짝지은 포아송 카운트 비교. 총합 a+b 를 고정하면 b ~ Binom(a+b, 0.5) 이므로
 * 양측 이항검정으로 «한쪽으로 쏠렸는지»를 잰다.
 */
function binomP(a, b) {
  const n = a + b;
  if (n === 0) return 1;
  const lo = Math.min(a, b);
  let p = 0;
  for (let k = 0; k <= lo; k += 1) p += Math.exp(logChoose(n, k) - n * Math.LN2);
  return Math.min(1, 2 * p);
}

function main() {
  const argv = process.argv.slice(2);
  const val = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const theme = val('--theme', null);
  const base = readRows(val('--base', 'tools/report'), theme);
  const arm = readRows(val('--arm', null), theme);

  let n = 0; let bf = 0; let af = 0; let bh = 0; let ah = 0;
  let bz = 0; let az = 0; let bk = 0; let ak = 0;
  const dd = [];
  for (const [idx, a] of arm) {
    const b = base.get(idx);
    if (b === undefined) throw new Error(`pair: 기준선에 idx ${idx} 가 없다 — 샤딩이 어긋났다`);
    n += 1;
    bf += b.forced; af += a.forced; bh += b.hits; ah += a.hits;
    bk += b.kills; ak += a.kills;
    if (b.dirs !== null && a.dirs !== null) { dd.push(a.dirs - b.dirs); bz += b.zero; az += a.zero; }
  }
  if (n === 0) throw new Error('pair: 짝지어진 판이 없다');

  const mean = dd.reduce((s, x) => s + x, 0) / dd.length;
  const sd = Math.sqrt(dd.reduce((s, x) => s + (x - mean) ** 2, 0) / (dd.length - 1));
  const se = sd / Math.sqrt(dd.length);
  const t = mean / se;

  const L = (s) => process.stdout.write(`${s}\n`);
  L('─'.repeat(70));
  L(`대응 비교 — 테마 ${theme ?? '전체'} · 짝지은 판 ${n}`);
  L('─'.repeat(70));
  L(`강제 피격   기준 ${bf}  →  실험 ${af}   (${af - bf >= 0 ? '+' : ''}${af - bf})   p=${binomP(bf, af).toFixed(4)}`);
  L(`피격 총계   기준 ${bh}  →  실험 ${ah}   (${((ah / bh - 1) * 100).toFixed(1)}%)`);
  L(`강제 비율   기준 ${(bh ? bf / bh * 100 : 0).toFixed(2)}%  →  실험 ${(ah ? af / ah * 100 : 0).toFixed(2)}%`);
  L(`평균 피할길 짝지은 차이 ${mean >= 0 ? '+' : ''}${mean.toFixed(4)} ± ${se.toFixed(4)} (t=${t.toFixed(2)})`);
  L(`「길0」     기준 ${(bz / dd.length).toFixed(4)}  →  실험 ${(az / dd.length).toFixed(4)}`);
  L(`처치        기준 ${bk}  →  실험 ${ak}   (${((ak / bk - 1) * 100).toFixed(1)}%)`);
  L('─'.repeat(70));
  L('  p < 0.05 이면 «우연으로 보기 어렵다» · t 의 절댓값 2 이상이면 길 변화가 유의하다');
  L('─'.repeat(70));
}

main();
