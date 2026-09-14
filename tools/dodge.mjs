/**
 * tools/dodge.mjs — «피할 수 있었는가» 계측 (v1.7 신설)
 *
 * ★ 설계 철학 (사용자 확정):
 *   ① 완벽한 컨트롤이면 «원칙상» 안 맞아야 한다 → **강제 피격은 0 이어야 한다**
 *   ② 조금이라도 잘못 고르거나 컨트롤이 꼬이면 맞아야 한다 → 여유는 얇아야 한다
 *   ③ 난이도 = «피할 길의 수»가 줄어드는 것. 스테이지가 오를수록 단조 감소해야 한다
 *
 * ★ 방법: 체력 무한(무적) 봇을 돌려 «죽지 않게» 하되 피격은 전부 센다. 그러면 런이 끝까지
 *   가므로 후반 스테이지도 표본이 잡힌다. 각 피격을 두 갈래로 가른다:
 *     · 강제(forced)  — 그 시점에 «어디로 달려도» 맞았다 → 설계 결함
 *     · 실수(avoidable) — 빠져나갈 길이 있었는데 못 갔다 → 봇(또는 사람)의 실수
 *   가르는 기준은 «반응 지연» 뒤의 상태다. 맞는 순간이 아니라, 사람이 손을 쓸 수 있었던
 *   마지막 순간(reactionSec 이전)에 길이 있었는가를 본다.
 *
 * ★ 「피할 길」의 정의: 8방향으로 최대 속도로 horizonSec 초 달려, 경로 «전체»가 안전한 방향의 수.
 *   면적이 아니라 경로다 — 안전한 칸이 탄막 건너편이면 갈 수 없다(사용자 지적).
 *
 * 사용: node tools/dodge.mjs [--seeds N] [--reaction 0.25] [--horizon 0.8]
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, MANIFEST } from '../src/core/schema.mjs';   // 매니페스트 = 단일 소유자(v1.10 ⑳: 9파일 하드코딩이 traits.json 뒤로 깨져 있었다)
import { makeCtx, escapeDirs, trackMotion } from './lib/escape.mjs';
import { createWorld } from '../src/core/state.js';
import { enemies } from '../src/core/enemies.js';
import { emitters } from '../src/core/emitters.js';
import { tickRun, initRun, advanceStage, PHASE } from '../src/core/stage.js';
import { bossHook } from '../src/core/boss.js';
import { step } from '../src/core/step.js';
import { weapons } from '../src/core/weapons/index.js';
import { botInput, botDraftPick } from '../src/core/bot.js';
import { buildDraft, applyCard } from '../src/core/draft.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DT = 1 / 60;

export function loadData() {
  const raw = {};
  for (const n of MANIFEST) raw[n] = JSON.parse(readFileSync(join(ROOT, 'data', `${n}.json`), 'utf8'));
  return validate(raw);
}

let CTX = null;
function ctxOf(d) { if (CTX === null) CTX = makeCtx(d); return CTX; }

/**
 * 한 런을 끝까지 돌린다(무적이라 죽지 않는다). 스테이지별로 피격을 «강제/실수»로 가른다.
 *   ★ escapeDirs 는 비싸므로 SAMPLE 틱마다 표본을 뜨고, 피격 시 «반응 지연 이전»의 표본을 본다.
 *     맞는 순간이 아니라 손을 쓸 수 있었던 마지막 순간이 판정의 기준이다.
 */
export function runOne(d, seed, opt) {
  const w = createWorld({ data: d, seed, weapons, hooks: { enemies, emitters, run: tickRun, boss: bossHook } });
  w.difficultyId = 'normal';
  w.tele = { dmgByFamily: Object.create(null), dmgTakenByArch: Object.create(null), kills: Object.create(null), crisisKills: 0, xpGained: 0 };
  initRun(w);
  const SAMPLE = 6;                                   // 0.1초마다 표본
  const backTicks = Math.max(1, Math.round(opt.reaction / DT));
  const ring = [];                                    // [tick, dirs]
  const per = [];
  for (let i = 0; i < 6; i += 1) per.push({ hits: 0, forced: 0, dirsSum: 0, dirsN: 0, zero: 0, sec: 0 });
  let guard = 0;
  for (let t = 0; t < opt.maxTicks; t += 1) {
    if (w.over) break;
    while (w.draftQueue > 0 && !w.over) {
      const dr = buildDraft(w);
      const card = dr.cards[botDraftPick(w, dr)];
      if (card === undefined) break;
      applyCard(w, card);
      guard += 1;
      if (guard > 500) break;
    }
    // ★ 보스를 건너뛴다. 무적이어도 보스 타이머(timerExpire "kill")가 런을 끝내므로,
    //   그냥 두면 스테이지 3 까지밖에 표본이 안 잡힌다. 우리가 재려는 것은 «몹 구간의
    //   회피 가능성 곡선»이므로 보스전은 대상이 아니다 — 몹 구간이 끝나면 다음 판으로 넘긴다.
    if (w.run && w.run.phase !== PHASE.MOB) {
      if ((w.run.stageIndex || 0) >= 5) break;        // 6판까지 봤으면 끝
      advanceStage(w);
      continue;
    }
    const si = (w.run && w.run.stageIndex) || 0;
    const bucket = per[Math.min(5, si)];
    // ★ 무적 — 죽지 않게 두되 «맞은 것»은 센다. 그래야 후반 스테이지도 표본이 잡힌다.
    w.player.hp = w.player.hpMax;
    trackMotion(w, ctxOf(d), DT);
    if (t % SAMPLE === 0) {
      const dirs = escapeDirs(w, d, opt.horizon, ctxOf(d));
      ring.push([t, dirs]);
      if (ring.length > 64) ring.shift();
      bucket.dirsSum += dirs; bucket.dirsN += 1;
      if (dirs === 0) bucket.zero += 1;
    }
    const before = w.player.hit;
    step(w, botInput(w, DT), DT);
    bucket.sec += DT;
    if (w.player.hit && !before) {
      bucket.hits += 1;
      // 반응 지연 이전의 표본을 찾는다 — 그때 길이 없었으면 «강제»다
      const want = t - backTicks;
      let d0 = null;
      for (let k = ring.length - 1; k >= 0; k -= 1) if (ring[k][0] <= want) { d0 = ring[k][1]; break; }
      if (d0 === 0) bucket.forced += 1;
    }
  }
  return per;
}

function pct(x) { return `${(x * 100).toFixed(1)}%`; }

function main() {
  const argv = process.argv.slice(2);
  const arg = (k, dflt) => { const i = argv.indexOf(k); return i >= 0 ? Number(argv[i + 1]) : dflt; };
  const nSeeds = arg('--seeds', 24);
  const opt = {
    reaction: arg('--reaction', 0.25),      // 사람의 반응 지연(초) — 이 이전에 길이 있었어야 «피할 수 있었다»
    horizon: arg('--horizon', 0.8),         // 회피 판정 지평(초)
    maxTicks: arg('--ticks', 60 * 60 * 12), // 12분 상한
  };
  const d = loadData();
  const line = (s) => process.stdout.write(`${s}\n`);
  line('─'.repeat(78));
  line(`회피 계측 — 무적 봇 ${nSeeds}런 · 반응지연 ${opt.reaction}초 · 지평 ${opt.horizon}초`);
  line('  강제 = 반응 시점에 «어디로 달려도» 맞았다(설계 결함) · 실수 = 길이 있었는데 못 갔다');
  line('─'.repeat(78));
  const agg = [];
  for (let i = 0; i < 6; i += 1) agg.push({ hits: 0, forced: 0, dirsSum: 0, dirsN: 0, zero: 0, sec: 0 });
  for (let s = 1; s <= nSeeds; s += 1) {
    const per = runOne(d, s, opt);
    for (let i = 0; i < 6; i += 1) {
      agg[i].hits += per[i].hits; agg[i].forced += per[i].forced;
      agg[i].dirsSum += per[i].dirsSum; agg[i].dirsN += per[i].dirsN;
      agg[i].zero += per[i].zero; agg[i].sec += per[i].sec;
    }
  }
  line('스테이지  체류(초)  피격   강제   강제비율   평균 피할길(0~8)  «길 0» 표본');
  for (let i = 0; i < 6; i += 1) {
    const a = agg[i];
    if (a.dirsN === 0) { line(`   ${i + 1}      (표본 없음)`); continue; }
    line(`   ${i + 1}    ${a.sec.toFixed(0).padStart(7)}  ${String(a.hits).padStart(5)}  ${String(a.forced).padStart(5)}   ${pct(a.hits ? a.forced / a.hits : 0).padStart(7)}     ${(a.dirsSum / a.dirsN).toFixed(2).padStart(6)}        ${pct(a.zero / a.dirsN).padStart(7)}`);
  }
  line('');
  line('★ 철학 대조 (사용자 확정)');
  const zeros = agg.filter((a) => a.dirsN > 0);
  const anyForced = zeros.some((a) => a.forced > 0);
  line(`  ① 완벽하면 안 맞아야 한다 → 강제 피격 0 : ${anyForced ? '✗ 위반 — 강제 피격이 있다' : '✓'}`);
  const dirs = zeros.map((a) => a.dirsSum / a.dirsN);
  let mono = true;
  for (let i = 1; i < dirs.length; i += 1) if (dirs[i] > dirs[i - 1] + 0.15) mono = false;
  line(`  ③ 뒤로 갈수록 길이 «줄어든다» : ${mono ? '✓' : '✗ 위반 — 중간에 늘어나는 구간이 있다'}  [${dirs.map((x) => x.toFixed(2)).join(' → ')}]`);
  line('─'.repeat(78));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
