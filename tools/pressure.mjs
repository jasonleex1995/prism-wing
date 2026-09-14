/**
 * tools/pressure.mjs — «비행기 없이 적만» 압박 계측 (v1.7 신설)
 *
 * ★ 왜 별도 도구인가: tools/sim.mjs 는 **봇이 플레이한 결과**를 잰다. 그래서 수치가 나쁠 때
 *   「설계가 문제인가, 봇이 못하는 것인가」를 가를 수 없다. 이 도구는 무기를 통째로 비우고
 *   이동도 0 으로 고정해 **적이 만드는 압박만** 남긴다 — 봇 실력이라는 변수가 사라진다.
 *
 * ★ 재는 것:
 *   A 스폰·엘리트·개성 보유 수 · 초당 신규탄 · 초당 피해량 · 동시 최대치
 *   B 밴드 구성 (일반 웨이브 / 위기 웨이브 분리)
 *   C 가만히 서 있을 때 생존 시간 (i-frame 정상 — §2.1 관대함 보장 포함)
 *   D «숨 쉴 곳» = 1초 안에 탄도 몸통도 닿지 않는 칸의 비율 (아레나 전체 기준)
 *   E ★ «갈 수 있는 안전한 곳» — D 의 결함을 고친 것.
 *     안전한 칸이 «탄막 반대편»에 있으면 못 간다. 난이도의 실체는 «안전한 면적»이 아니라
 *     «지금 내 자리에서 닿을 수 있는 안전한 곳이 있는가»다(사용자 지적).
 *     예: 적이 일자로 내려오며 일자로 쏘면 아레나의 90% 가 비어 있어도 피할 구석이 없다.
 *
 * ★ 함정 두 개(둘 다 실제로 밟았다):
 *   ① 풀은 객체를 재사용한다 — 객체 동일성으로 세면 과소집계된다. 키는 `${idx}:${gen}` 다.
 *      (이걸 틀렸을 때 「동시 탄 110개인데 초당 신규 0.7발」이라는 불가능한 수치가 나왔다)
 *   ② «숨 쉴 곳»에서 적 **몸통**을 빼면 안 된다. 탄만 세면 91~97% 가 안전하다는
 *      잘못된 그림이 나온다 — 이 게임의 압박은 상당 부분 접촉이다.
 *
 * 사용: node tools/pressure.mjs [--seeds N]
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, MANIFEST } from '../src/core/schema.mjs';   // 매니페스트 = 단일 소유자(v1.10 ⑳: 9파일 하드코딩이 traits.json 뒤로 깨져 있었다)
import { makeCtx, escapeDirs as escapeShared } from './lib/escape.mjs';
import { createWorld } from '../src/core/state.js';
import { enemies } from '../src/core/enemies.js';
import { emitters } from '../src/core/emitters.js';
import { tickRun, initRun, advanceStage } from '../src/core/stage.js';
import { bossHook } from '../src/core/boss.js';
import { step, makeInput } from '../src/core/step.js';
import { weapons } from '../src/core/weapons/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DT = 1 / 60;
const HORIZON = 1.0;      // «숨 쉴 곳» 판정 지평: 1초 안에 닿는가
const GRID = 24;

function loadData() {
  const raw = {};
  for (const n of MANIFEST) raw[n] = JSON.parse(readFileSync(join(ROOT, 'data', `${n}.json`), 'utf8'));
  return validate(raw);
}

/** 무기를 비우고 목표 스테이지까지 진행한 월드. */
function makeProbeWorld(d, stageIdx, seed) {
  const w = createWorld({ data: d, seed, weapons, hooks: { enemies, emitters, run: tickRun, boss: bossHook } });
  w.difficultyId = 'normal';
  w.tele = { dmgByFamily: Object.create(null), dmgTakenByArch: Object.create(null), kills: Object.create(null), crisisKills: 0, xpGained: 0 };
  initRun(w);
  // ★ 적을 죽이지 않아야 «순수 압박»이 남는다
  for (const sl of w.slots) { sl.weaponId = null; sl.family = ''; sl.level = 0; sl.evolved = false; sl.effDirty = true; }
  for (let k = 0; k < stageIdx; k += 1) advanceStage(w);
  return w;
}

function safeFraction(w, d) {
  const b = w.bounds;
  const rp = d.rules.player;
  let safe = 0;
  let tot = 0;
  for (let gx = 0; gx < GRID; gx += 1) {
    for (let gy = 0; gy < GRID; gy += 1) {
      const px = b.minX + (gx + 0.5) * (b.maxX - b.minX) / GRID;
      const py = b.minY + (gy + 0.5) * (b.maxY - b.minY) / GRID;
      tot += 1;
      let hit = false;
      for (const e of w.enemies.items) {                 // ★ 몸통을 빼면 그림이 통째로 틀린다
        if (!e.alive) continue;
        if (nearestWithin(px, py, e.x, e.y, e.vx, e.vy, rp.hitboxRadius + e.radius)) { hit = true; break; }
      }
      if (!hit) {
        for (const bu of w.enemyBullets.items) {
          if (!bu.alive) continue;
          if (nearestWithin(px, py, bu.x, bu.y, bu.vx, bu.vy, rp.hitboxRadius + bu.hitRadius)) { hit = true; break; }
        }
      }
      if (!hit) safe += 1;
    }
  }
  return safe / tot;
}

let CTX = null;
function ctxOf(d) { if (CTX === null) CTX = makeCtx(d); return CTX; }

/** 회피 판정은 tools/lib/escape.mjs 가 소유한다 — 이 도구는 «기체 없이 임의 지점»을 잰다. */
function escapeDirs(w, d, px, py) { return escapeShared(w, d, HORIZON, ctxOf(d), undefined, px, py); }

/** 등속 근사로 [0, HORIZON] 안의 최근접이 r 안에 드는가 (가속·유도는 보수적으로 무시). */
function nearestWithin(px, py, ox, oy, ovx, ovy, r) {
  const rx = ox - px;
  const ry = oy - py;
  const vv = ovx * ovx + ovy * ovy;
  let t = vv > 0 ? -(rx * ovx + ry * ovy) / vv : 0;
  if (t < 0) t = 0; else if (t > HORIZON) t = HORIZON;
  const dx = rx + ovx * t;
  const dy = ry + ovy * t;
  return dx * dx + dy * dy <= r * r;
}

/** A·B·D — 한 스테이지의 몹 구간을 통째로 돌며 압박을 잰다. */
function probe(d, stageIdx, seed) {
  const w = makeProbeWorld(d, stageIdx, seed);
  const p = w.player;
  const a = d.rules.view.arena;
  const inp = makeInput();
  const bandOf = Object.create(null);
  for (const x of d.enemies.archetypes) bandOf[x.id] = x.band;
  const st = {
    spawn: 0, elite: 0, trait: 0, shots: 0, dmg: 0, ticks: 0,
    maxEn: 0, maxBul: 0, maxTele: 0,
    band: Object.create(null),
    wave: { spawn: 0, band: Object.create(null) },
    cris: { spawn: 0, band: Object.create(null) },
    safeSum: 0, safeN: 0, safeWorst: 1, safeCrisisWorst: 1,
    reachSum: 0, reachWorst: 1, trapped: 0,   // §E 갈 수 있는 안전한 곳 · trapped = 하나도 없던 표본
  };
  const seenE = new Set();      // ★ 키 = `${idx}:${gen}` — 풀 재사용 때문에 객체로 세면 안 된다
  const seenB = new Set();
  for (let t = 0; t < d.stages.phase.mobPhaseSec * 60; t += 1) {
    p.x = a.x + a.w / 2; p.y = a.y + a.h * 0.85;      // 가만히 서 있는다
    p.hp = p.hpMax;                                    // 압박만 재므로 죽지 않는다(C 가 따로 잰다)
    step(w, inp, DT);
    st.ticks += 1;
    if (w.run && w.run.phase !== 'MOB') break;
    let liveE = 0; let liveB = 0; let liveT = 0;
    for (const e of w.enemies.items) {
      if (!e.alive) continue;
      liveE += 1;
      const k = `${e.idx}:${e.gen}`;
      if (seenE.has(k)) continue;
      seenE.add(k);
      st.spawn += 1;
      if (e.elite) st.elite += 1;
      if (e.hitFloorSec > 0 || e.pierceCost > 1 || e.ccImmune) st.trait += 1;
      const b = bandOf[e.archetypeId] || 'boss';
      st.band[b] = (st.band[b] || 0) + 1;
      const bucket = (w.run && w.run.crisis) ? st.cris : st.wave;
      bucket.spawn += 1;
      bucket.band[b] = (bucket.band[b] || 0) + 1;
    }
    for (const b of w.enemyBullets.items) {
      if (!b.alive) continue;
      liveB += 1;
      const k = `${b.idx}:${b.gen}`;
      if (seenB.has(k)) continue;
      seenB.add(k);
      st.shots += 1;
      st.dmg += b.dmg;
    }
    for (const tg of w.telegraphs.items) if (tg.alive) liveT += 1;
    if (liveE > st.maxEn) st.maxEn = liveE;
    if (liveB > st.maxBul) st.maxBul = liveB;
    if (liveT > st.maxTele) st.maxTele = liveT;
    if (t % 30 === 0) {                                // 0.5초마다 «숨 쉴 곳» 표본
      const f = safeFraction(w, d);
      st.safeSum += f; st.safeN += 1;
      if (f < st.safeWorst) st.safeWorst = f;
      if (w.run && w.run.crisis && f < st.safeCrisisWorst) st.safeCrisisWorst = f;
      const dirs = escapeDirs(w, d, p.x, p.y);
      st.reachSum += dirs / 8;
      if (dirs / 8 < st.reachWorst) st.reachWorst = dirs / 8;
      if (dirs === 0) st.trapped += 1;
    }
  }
  st.sec = st.ticks / 60;
  return st;
}

/** C — 가만히 서 있을 때 몇 초 만에 죽는가. i-frame 은 정상(§2.1). */
function survive(d, stageIdx, seed) {
  const w = makeProbeWorld(d, stageIdx, seed);
  const p = w.player;
  const a = d.rules.view.arena;
  const inp = makeInput();
  let hits = 0;
  for (let t = 0; t < d.stages.phase.mobPhaseSec * 60; t += 1) {
    p.x = a.x + a.w / 2; p.y = a.y + a.h * 0.85;
    const hp0 = p.hp;
    step(w, inp, DT);
    if (p.hp < hp0) hits += 1;
    if (p.hp <= 0) return { sec: t / 60, hits, died: true };
    if (w.run && w.run.phase !== 'MOB') break;
  }
  return { sec: d.stages.phase.mobPhaseSec, hits, died: false };
}

function pct(x) { return `${(x * 100).toFixed(1)}%`; }
function bandLine(o) {
  const t = Object.keys(o).reduce((s, k) => s + o[k], 0) || 1;
  return ['chaff', 'line', 'turret', 'bruiser'].map((b) => `${b} ${Math.round((o[b] || 0) / t * 100)}%`).join(' · ');
}

function main() {
  const argv = process.argv.slice(2);
  let nSeeds = 4;
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--seeds') nSeeds = Number(argv[i + 1]);
  const seeds = [];
  for (let i = 1; i <= nSeeds; i += 1) seeds.push(i);
  const d = loadData();
  const line = (s) => process.stdout.write(`${s}\n`);
  line('─'.repeat(78));
  line(`압박 계측 — 비행기 «없이» 적만 (무기 0 · 이동 0) · 시드 ${nSeeds}개 · 몹 구간 ${d.stages.phase.mobPhaseSec}초`);
  line('─'.repeat(78));
  line('스테이지  스폰   엘리트  개성  초당탄  초당피해  동시적  동시탄  텔레');
  const rows = [];
  for (let si = 0; si < 6; si += 1) {
    const rs = seeds.map((s) => probe(d, si, s));
    const n = rs.length;
    const sum = (f) => rs.reduce((a, r) => a + f(r), 0);
    const max = (f) => Math.max(...rs.map(f));
    const band = Object.create(null); const wv = Object.create(null); const cr = Object.create(null);
    let wvN = 0; let crN = 0;
    for (const r of rs) {
      for (const k of Object.keys(r.band)) band[k] = (band[k] || 0) + r.band[k];
      for (const k of Object.keys(r.wave.band)) wv[k] = (wv[k] || 0) + r.wave.band[k];
      for (const k of Object.keys(r.cris.band)) cr[k] = (cr[k] || 0) + r.cris.band[k];
      wvN += r.wave.spawn; crN += r.cris.spawn;
    }
    const sec = sum((r) => r.sec);
    const row = {
      si, spawn: sum((r) => r.spawn) / n, elite: sum((r) => r.elite) / n, trait: sum((r) => r.trait) / n,
      shots: sum((r) => r.shots) / sec, dmg: sum((r) => r.dmg) / sec,
      maxEn: max((r) => r.maxEn), maxBul: max((r) => r.maxBul), maxTele: max((r) => r.maxTele),
      band, wv, cr, wvN: wvN / n, crN: crN / n,
      safeMean: sum((r) => r.safeSum) / sum((r) => r.safeN),
      safeWorst: Math.min(...rs.map((r) => r.safeWorst)),
      safeCrisis: Math.min(...rs.map((r) => r.safeCrisisWorst)),
      reachMean: sum((r) => r.reachSum) / sum((r) => r.safeN),
      reachWorst: Math.min(...rs.map((r) => r.reachWorst)),
      trapped: sum((r) => r.trapped) / sum((r) => r.safeN),
    };
    rows.push(row);
    line(`   ${si + 1}     ${String(Math.round(row.spawn)).padStart(4)}  ${String(Math.round(row.elite)).padStart(5)} ${String(Math.round(row.trait)).padStart(5)}  ${row.shots.toFixed(1).padStart(6)}  ${row.dmg.toFixed(1).padStart(7)}  ${String(row.maxEn).padStart(5)}  ${String(row.maxBul).padStart(6)}  ${String(row.maxTele).padStart(4)}`);
  }
  const b0 = rows[0];
  line('');
  line(`스테이지 1 대비 배수 — 스폰 ×${(rows[5].spawn / b0.spawn).toFixed(2)} · 초당탄 ×${(rows[5].shots / b0.shots).toFixed(2)} · 초당피해 ×${(rows[5].dmg / b0.dmg).toFixed(2)}`);
  line('');
  line('밴드 구성 — 일반 웨이브 / 위기 웨이브');
  for (const r of rows) {
    line(`   ${r.si + 1}: 일반 ${String(Math.round(r.wvN)).padStart(3)}기 [${bandLine(r.wv)}]`);
    line(`      위기 ${String(Math.round(r.crN)).padStart(3)}기 [${bandLine(r.cr)}]`);
  }
  line('');
  line('엘리트·개성 노출 (전체 스폰 대비)');
  for (const r of rows) line(`   ${r.si + 1}: 엘리트 ${pct(r.elite / r.spawn)} · 개성 보유 ${pct(r.trait / r.spawn)}`);
  line('');
  line('숨 쉴 곳 — 1초 안에 탄도 몸통도 «닿지 않는» 칸의 비율 (아레나 전체)');
  line('스테이지  평균    최악 순간  위기 최악');
  for (const r of rows) line(`   ${r.si + 1}     ${pct(r.safeMean).padStart(6)}  ${pct(r.safeWorst).padStart(7)}  ${pct(r.safeCrisis).padStart(8)}`);
  line('');
  line('★ 피할 «길» — 8방향으로 1초 달려 경로 전체가 안전한 방향의 비율');
  line('   (안전한 칸이 탄막 건너편이면 못 간다 — 면적이 아니라 경로를 본다)');
  line('스테이지  평균    최악 순간  «길 0개» 표본 비율');
  for (const r of rows) line(`   ${r.si + 1}     ${pct(r.reachMean).padStart(6)}  ${pct(r.reachWorst).padStart(7)}  ${pct(r.trapped).padStart(12)}`);
  line('');
  line('가만히 서 있을 때 생존 — 무기 0 · 이동 0 · HP 100 · i-frame 정상');
  line('스테이지  생존(초)  피격 수  판정');
  for (let si = 0; si < 6; si += 1) {
    const rs = seeds.map((s) => survive(d, si, s));
    const died = rs.filter((r) => r.died).length;
    const mean = rs.reduce((a, r) => a + r.sec, 0) / rs.length;
    const hits = rs.reduce((a, r) => a + r.hits, 0) / rs.length;
    line(`   ${si + 1}      ${mean.toFixed(1).padStart(6)}    ${hits.toFixed(1).padStart(5)}   ${died === 0 ? '전원 완주' : `${died}/${rs.length} 사망`}`);
  }
  line('─'.repeat(78));
}

main();
