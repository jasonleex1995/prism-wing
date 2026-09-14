/**
 * tools/study.mjs — 대규모 난이도 통계 (v1.7 신설)
 *
 * ★ 무엇을 하는가: 체력 무한 비행기로 «스테이지 시나리오»를 대량으로 돌려, 난이도를 만드는
 *   요소들을 «교차»로 본다 — 테마(지형) × 스테이지 × 시작 무기 × 레벨.
 *
 * ★ 사용자 확정 조건:
 *   · 비행기는 무적이되 피격은 전부 센다 (죽어서 표본이 끊기지 않게)
 *   · 보스 타이머 만료 = 사망이 아니라 «통과» (후반 스테이지도 표본이 잡히게)
 *   · 각 스테이지는 지정 레벨·빌드로 «시작»한다 — 레벨링이 안 돼서 못 잡는 일이 없게
 *
 * ★ 판정: 피격을 «강제»(반응 시점에 어디로 달려도 맞았다 = 설계 결함)와 «실수»로 가른다.
 *   설계 철학 ①완벽하면 무피격 ②실수하면 피격 ③뒤로 갈수록 길이 줄어든다 (tools/dodge.mjs 와 같은 기준)
 *
 * 사용: node tools/study.mjs --runs 8000 --shard 0/12 --out report/study-0.jsonl
 *   샤드로 갈라 여러 프로세스가 나눠 돌린다. 합산은 --merge 로.
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, MANIFEST } from '../src/core/schema.mjs';   // 매니페스트 = 단일 소유자(v1.10 ⑳: 9파일 하드코딩이 traits.json 뒤로 깨져 있었다)
import { makeCtx, escapeDirs, trackMotion } from './lib/escape.mjs';
import { createWorld, giveWeapon, levelUpWeapon, givePassive, recomputeStats } from '../src/core/state.js';
import { enemies } from '../src/core/enemies.js';
import { emitters } from '../src/core/emitters.js';
import { tickRun, initRun, advanceStage, PHASE } from '../src/core/stage.js';
import { bossHook } from '../src/core/boss.js';
import { step } from '../src/core/step.js';
import { weapons } from '../src/core/weapons/index.js';
import { botInput } from '../src/core/bot.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DT = 1 / 60;

/** 이미터를 id 로 집는다 — 없으면 조용히 넘어가지 않고 터뜨린다(§9.3). */
function emitterOf(raw, id) {
  const e = raw.enemies.emitters.find((x) => x.id === id);
  if (e === undefined) throw new Error(`study: 미지의 이미터 "${id}"`);
  return e;
}

/**
 * A/B 팔 — 한 번에 손잡이 «하나»만 돌린다. data/*.json 은 건드리지 않고
 * 메모리에서만 고친 뒤 validate 를 통과시킨다 — 스키마 위반은 여기서도 에러다.
 */
const ARMS = {
  base() {},
  magma(raw) { emitterOf(raw, 'magmaZone').activeSec = 1.2; },
  siren(raw) {
    const src = raw.bullets.bullets.find((b) => b.id === 'driftHoming');
    if (src === undefined) throw new Error('study: driftHoming 이 없다');
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = 'sirenShard';
    copy.turnRateDegSec = 0;
    copy.homingSec = 0;
    raw.bullets.bullets.push(copy);
    emitterOf(raw, 'sirenRing').bulletId = 'sirenShard';
  },
  frost(raw) { emitterOf(raw, 'frostWall').gapWidthPx = 100; },
  // 동시 개체를 정본 원래값으로 되돌린다 — 런타임이 «실제로 읽는» 유일한 새떼 상한이다.
  //   (crisisWaveResidualMax 는 런타임이 읽지 않으므로 데이터로 실험할 수 없다.)
  swarm(raw) { raw.rules.fairness.swarmConcurrentMax = 70; },
  // bogSpiral 을 패치 전 값으로 되돌린다 — 「더 어려워졌는데 더 공정해지진 않았다」의 검증용.
  bogrevert(raw) {
    const e = emitterOf(raw, 'bogSpiral');
    e.count = 10; e.everySec = 7.0; e.durationSec = 2.0;
  },
};


export function loadData(arm) {
  const raw = {};
  for (const n of MANIFEST) raw[n] = JSON.parse(readFileSync(join(ROOT, 'data', `${n}.json`), 'utf8'));
  const fn = ARMS[arm || 'base'];
  if (fn === undefined) throw new Error(`study: 미지의 팔 "${arm}"`);
  fn(raw);
  return validate(raw);
}

/** 결정적 난수 — 시나리오 조합을 시드에서 유도한다(런 자체의 rng 와 분리). */
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 회피 판정은 tools/lib/escape.mjs 가 소유한다 — 4벌 복사본이 갈라지지 않게. */
let CTX = null;
function ctxOf(d) { if (CTX === null) CTX = makeCtx(d); return CTX; }


/**
 * 지정 레벨·빌드를 «심는다». 레벨링이 안 돼서 못 잡는 일이 없게 하는 것이 목적이다(사용자 지시).
 *   무기 레벨 · 신규 무기 · 패시브 · 속성 투자를 시나리오 난수로 다양하게 섞는다.
 *   ★ 드래프트를 흉내 내는 것이 아니라 «도달했을 법한 상태»를 직접 세운다 — 그래야 조합이 고르게 퍼진다.
 */
export function seedBuild(w, d, rnd, level) {
  const elems = d.weapons.weapons.filter((x) => x.slotClass === 'element').map((x) => x.id);
  const utils = d.weapons.weapons.filter((x) => x.slotClass === 'utility').map((x) => x.id);
  const passives = d.passives.passives.map((x) => x.id);
  const picks = Math.max(0, level - 1);            // Lv1 은 시작 무기만
  const eSlots = d.rules.player.elementSlots;
  const wSlots = d.rules.player.weaponSlots;
  const pSlots = d.rules.player.passiveSlots;
  for (let i = 0; i < picks; i += 1) {
    const r = rnd();
    if (r < 0.42) {                                 // 무기 레벨업
      const owned = [];
      for (let k = 0; k < w.slots.length; k += 1) if (w.slots[k].weaponId !== null && w.slots[k].level < 8) owned.push(k);
      if (owned.length > 0) { levelUpWeapon(w, owned[Math.floor(rnd() * owned.length)]); continue; }
    }
    if (r < 0.62) {                                 // 신규 무기
      let nE = 0; let nU = 0;
      for (let k = 0; k < w.slots.length; k += 1) if (w.slots[k].weaponId !== null) { if (k < eSlots) nE += 1; else nU += 1; }
      const pool = (nE < eSlots && (rnd() < 0.5 || nU >= wSlots - eSlots)) ? elems : utils;
      // ★ 이미 든 무기는 다시 주지 않는다. giveWeapon 은 중복을 막지 않는다 — 막는 것은
      //   드래프트(§11.1 「이미 보유한 무기는 newWeapon 후보에서 제외」)이고 우리는 그걸 우회한다.
      //   중복이 생기면 두 슬롯이 같은 family 를 갖고, drone.js 의 위성 순번 k 가
      //   anchorOffsets 길이를 넘겨 런타임에 던진다(실측 — 이 하네스가 그렇게 죽었다).
      const have = Object.create(null);
      for (let k2 = 0; k2 < w.slots.length; k2 += 1) if (w.slots[k2].weaponId !== null) have[w.slots[k2].weaponId] = 1;
      const free = pool.filter((x) => have[x] !== 1);
      if (free.length === 0) continue;
      const id = free[Math.floor(rnd() * free.length)];
      if (giveWeapon(w, id) >= 0) continue;
    }
    if (r < 0.88) {                                 // 패시브
      const id = passives[Math.floor(rnd() * passives.length)];
      if (givePassive(w, id)) continue;
      if (w.passives.length < pSlots) continue;
    }
    // 속성 투자 — 실패 시 폴백으로도 쓴다
    const inv = d.elements.investable;
    const e = inv[Math.floor(rnd() * inv.length)];
    const cap = d.rules.player.elementCapPerElement;
    let tot = 0;
    for (const k of inv) tot += w.player.invest[k];
    if (w.player.invest[e] < cap && tot < d.rules.player.elementCapTotal) w.player.invest[e] += 1;
  }
  w.player.level = level;
  recomputeStats(w);
  for (let k = 0; k < w.slots.length; k += 1) w.slots[k].effDirty = true;
}

/** 한 시나리오 = «한 스테이지의 몹 구간». 보스 타이머 만료는 통과로 처리한다. */
function runScenario(d, sc) {
  const w = createWorld({ data: d, seed: sc.runSeed, weapons,
    hooks: { enemies, emitters, run: tickRun, boss: bossHook }, startWeaponId: sc.startWeapon });
  w.difficultyId = 'normal';
  w.tele = { dmgByFamily: Object.create(null), dmgTakenByArch: Object.create(null), kills: Object.create(null), crisisKills: 0, xpGained: 0 };
  initRun(w);
  const rnd = mulberry(sc.buildSeed);
  seedBuild(w, d, rnd, sc.level);
  // 목표 스테이지까지 «건너뛴다» — 우리가 재려는 것은 그 판의 몹 구간이다
  for (let k = 0; k < sc.stage - 1; k += 1) advanceStage(w);
  const rp = d.rules.player;
  const theme = w.run.order[w.run.stageIndex];
  // A/B 에서는 대상 테마만 돌린다 — 나머지는 시뮬레이션 자체를 건너뛴다(비용 1/6).
  if (sc.only !== null && theme !== sc.only) return null;
  const SAMPLE = 30;                                // 0.5초마다 회피 표본
  const backTicks = Math.round(sc.reaction / DT);
  const ring = [];
  const out = { hits: 0, forced: 0, forcedP: 0, dirsPSum: 0, zeroP: 0, dirsSum: 0, dirsN: 0, zero: 0, kills: 0, spawn: 0, exit: 0, sec: 0, maxEn: 0, endLive: 0 };
  const seen = new Set();
  let guard = 0;
  for (let t = 0; t < 60 * 200; t += 1) {
    if (w.over) break;
    if (w.run && w.run.phase !== PHASE.MOB) break;   // 몹 구간만
    w.player.hp = w.player.hpMax;                    // 무적
    trackMotion(w, ctxOf(d), DT);                    // 보스·중간보스는 vx/vy 를 쓰지 않는다
    w.draftQueue = 0;                                // 빌드는 이미 심었다 — 중간 성장은 변수에서 뺀다
    if (t % SAMPLE === 0) {
      const dirs = escapeDirs(w, d, sc.horizon, ctxOf(d));
      const dirsP = escapeDirs(w, d, sc.horizon, ctxOf(d), undefined, undefined, undefined, false);   // 탄·빔·장판만
      ring.push([t, dirs, dirsP]);
      if (ring.length > 40) ring.shift();
      out.dirsSum += dirs; out.dirsN += 1;
      if (dirs === 0) out.zero += 1;
      out.dirsPSum += dirsP; if (dirsP === 0) out.zeroP += 1;
    }
    let live = 0;
    const en = w.enemies.items;
    for (let i = 0; i < en.length; i += 1) {
      const e = en[i];
      if (!e.alive || !e.archetypeId) continue;
      live += 1;
      const k = `${e.idx}:${e.gen}`;
      if (!seen.has(k)) { seen.add(k); out.spawn += 1; }
    }
    if (live > out.maxEn) out.maxEn = live;
    out.endLive = live;                              // 마지막 틱의 생존 수 — 이탈 계산에서 뺀다
    const before = w.player.hit;
    step(w, botInput(w, DT), DT);
    out.sec += DT;
    guard += 1;
    if (w.player.hit && !before) {
      out.hits += 1;
      const want = t - backTicks;
      let d0 = null;
      for (let k = ring.length - 1; k >= 0; k -= 1) if (ring[k][0] <= want) { d0 = ring[k][1]; break; }
      if (d0 === 0) out.forced += 1;
      let p0 = null;
      for (let k = ring.length - 1; k >= 0; k -= 1) if (ring[k][0] <= want) { p0 = ring[k][2]; break; }
      if (p0 === 0) out.forcedP += 1;                 // 탄·빔·장판만으로 막혔던 «진짜» 강제
    }
  }
  out.kills = Object.values(w.tele.kills).reduce((a, b) => a + b, 0);
  // ★ 이탈 = 스폰 - 처치 - «끝날 때 살아있던 것». 잔차로만 두면 화면에 남아있던 적까지
  //   이탈로 세어 비율이 부풀려진다(구 지표는 상한이었지 실측이 아니었다).
  out.exit = Math.max(0, out.spawn - out.kills - out.endLive);
  out.theme = theme;
  out.ticks = guard;
  return out;
}

/** 시나리오 조합 — 시드에서 결정적으로 유도한다. 샤드가 겹치지 않게 전역 인덱스로 뽑는다. */
export function makeScenario(d, idx) {
  const rnd = mulberry(0x9E3779B9 ^ idx);
  const elems = d.weapons.weapons.filter((x) => x.slotClass === 'element').map((x) => x.id);
  const stage = 1 + (idx % 6);                       // 6판을 고르게 — 나머지는 난수
  // ★ 스테이지에 «어울리는» 레벨을 심는다. 레벨링이 병목이 되지 않게(사용자 지시).
  //   폭을 둬서 「그 판을 저레벨로 만났을 때」도 표본에 들어가게 한다.
  const base = [6, 11, 16, 21, 26, 31][stage - 1];
  const level = Math.max(1, base + Math.floor(rnd() * 9) - 4);
  return {
    idx,
    stage,
    level,
    startWeapon: elems[Math.floor(rnd() * elems.length)],
    runSeed: 1 + Math.floor(rnd() * 1000000),
    buildSeed: 1 + Math.floor(rnd() * 1000000),
    reaction: 0.25,
    horizon: 0.8,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const has = (k) => argv.indexOf(k) >= 0;
  const val = (k, dflt) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : dflt; };

  if (has('--merge')) { merge(val('--merge', 'report')); return; }

  const runs = Number(val('--runs', 1000));
  const shardStr = val('--shard', '0/1');
  const [si, sn] = shardStr.split('/').map(Number);
  const outPath = val('--out', join(ROOT, 'tools', 'report', `study-${si}.jsonl`));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, '');
  const arm = val('--patch', 'base');
  const only = val('--only', null);                    // 이 테마만 잰다(없으면 전부)
  const d = loadData(arm);
  const t0 = Date.now();
  const buf = [];
  for (let n = 0; n < runs; n += 1) {
    const idx = si + n * sn;                          // 샤드끼리 겹치지 않는 전역 인덱스
    const sc = makeScenario(d, idx);
    sc.only = only;
    const r = runScenario(d, sc);
    if (r === null) continue;                         // 대상 테마가 아니다
    buf.push(JSON.stringify({
      idx, stage: sc.stage, theme: r.theme, weapon: sc.startWeapon, level: sc.level,
      hits: r.hits, forced: r.forced, forcedP: r.forcedP, dirsP: r.dirsN ? +(r.dirsPSum / r.dirsN).toFixed(3) : null, zeroP: r.dirsN ? +(r.zeroP / r.dirsN).toFixed(4) : null, dirs: r.dirsN ? +(r.dirsSum / r.dirsN).toFixed(3) : null,
      zero: r.dirsN ? +(r.zero / r.dirsN).toFixed(4) : null,
      kills: r.kills, spawn: r.spawn, exit: r.exit, endLive: r.endLive, sec: +r.sec.toFixed(1), maxEn: r.maxEn,
    }));
    if (buf.length >= 200) { appendFileSync(outPath, `${buf.join('\n')}\n`); buf.length = 0; }
    if ((n + 1) % 500 === 0) {
      const el = (Date.now() - t0) / 1000;
      process.stderr.write(`  shard ${si}: ${n + 1}/${runs} · ${el.toFixed(0)}s · 남은 ${((el / (n + 1)) * (runs - n - 1)).toFixed(0)}s\n`);
    }
  }
  if (buf.length > 0) appendFileSync(outPath, `${buf.join('\n')}\n`);
  process.stderr.write(`  shard ${si}: 완료 ${runs}판 · ${((Date.now() - t0) / 1000).toFixed(0)}s → ${outPath}\n`);
}

/** 샤드 결과를 합쳐 통계를 낸다. */
function merge(dir) {
  const base = resolve(ROOT, dir);
  const rows = [];
  for (const f of readdirSync(base)) {
    if (!f.startsWith('study-') || !f.endsWith('.jsonl')) continue;
    for (const l of readFileSync(join(base, f), 'utf8').split('\n')) {
      if (l.trim() !== '') rows.push(JSON.parse(l));
    }
  }
  const line = (s) => process.stdout.write(`${s}\n`);
  if (rows.length === 0) { line('표본 0 — 먼저 샤드를 돌려라'); return; }
  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  const grp = (keyFn) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      let a = m.get(k);
      if (a === undefined) { a = { n: 0, hits: 0, forced: 0, forcedP: 0, dirsP: 0, zeroP: 0, dirs: 0, dirsN: 0, zero: 0, kills: 0, spawn: 0, sec: 0, exit: 0, maxEn: 0 }; m.set(k, a); }
      a.n += 1; a.hits += r.hits; a.forced += r.forced; a.kills += r.kills; a.spawn += r.spawn; a.sec += r.sec;
      a.exit += r.exit; if (r.maxEn > a.maxEn) a.maxEn = r.maxEn;
      a.forcedP += (r.forcedP || 0);
      if (r.dirs !== null) { a.dirs += r.dirs; a.dirsN += 1; a.zero += r.zero; a.dirsP += (r.dirsP || 0); a.zeroP += (r.zeroP || 0); }
    }
    return m;
  };
  const show = (title, m, cols) => {
    line('');
    line(title);
    line(`${cols.padEnd(14)}  판수    피격/분   강제%   탄강제%   평균길   탄평균길  「길0」  탄「길0」  처치율`);
    const keys = [...m.keys()].sort();
    for (const k of keys) {
      const a = m.get(k);
      const perMin = a.sec > 0 ? a.hits / (a.sec / 60) : 0;
      line(`${String(k).padEnd(14)} ${String(a.n).padStart(6)} ${perMin.toFixed(1).padStart(8)} `
        + `${pct(a.hits ? a.forced / a.hits : 0).padStart(7)} ${pct(a.hits ? a.forcedP / a.hits : 0).padStart(8)} `
        + `${(a.dirsN ? a.dirs / a.dirsN : 0).toFixed(2).padStart(8)} ${(a.dirsN ? a.dirsP / a.dirsN : 0).toFixed(2).padStart(8)} `
        + `${pct(a.dirsN ? a.zero / a.dirsN : 0).padStart(7)} ${pct(a.dirsN ? a.zeroP / a.dirsN : 0).padStart(8)} ${pct(a.spawn ? a.kills / a.spawn : 0).padStart(8)}`);
    }
  };
  /**
   * «상대 적이 적절한가» — 잡히지 않고 화면을 빠져나간 적의 비율이 핵심이다.
   * 이탈이 많으면 그 구간의 적은 «맷집이 과하거나 너무 빠르거나» 둘 중 하나다.
   */
  const showEnemy = (title, m, cols) => {
    line('');
    line(title);
    line(`${cols.padEnd(14)}  판수   스폰/분   처치율   이탈률   동시최대   피격/처치`);
    for (const k of [...m.keys()].sort()) {
      const a = m.get(k);
      const spawnMin = a.sec > 0 ? a.spawn / (a.sec / 60) : 0;
      line(`${String(k).padEnd(14)} ${String(a.n).padStart(6)} ${spawnMin.toFixed(1).padStart(8)} `
        + `${pct(a.spawn ? a.kills / a.spawn : 0).padStart(8)} ${pct(a.spawn ? a.exit / a.spawn : 0).padStart(8)} `
        + `${String(a.maxEn).padStart(9)} ${(a.kills ? a.hits / a.kills : 0).toFixed(3).padStart(10)}`);
    }
  };

  line('═'.repeat(78));
  line(`대규모 난이도 통계 — 표본 ${rows.length.toLocaleString()} 판 (무적 · 보스 타이머 통과 · 레벨 심음)`);
  line('  강제% = 피격 중 «반응 시점에 어디로 달려도 맞았던» 비율 (설계 결함)');
  line('  평균길 = 8방향 중 경로 전체가 안전한 방향의 수 (0~8)');
  line('═'.repeat(78));
  show('■ 스테이지별', grp((r) => `S${r.stage}`), '스테이지');
  show('■ 지형(테마)별', grp((r) => r.theme), '테마');
  show('■ 시작 무기별', grp((r) => r.weapon), '무기');
  show('■ 레벨대별', grp((r) => `Lv${Math.floor(r.level / 5) * 5}~`), '레벨');
  line('');
  line('■ 스테이지 × 지형 — 「길0」 비율 (난이도 사각지대 찾기)');
  const themes = [...new Set(rows.map((r) => r.theme))].sort();
  line(`        ${themes.map((t) => String(t).slice(0, 7).padStart(8)).join('')}`);
  for (let s = 1; s <= 6; s += 1) {
    const cells = themes.map((t) => {
      const sub = rows.filter((r) => r.stage === s && r.theme === t && r.dirs !== null);
      if (sub.length === 0) return '     —  ';
      const z = sub.reduce((a, r) => a + r.zero, 0) / sub.length;
      return pct(z).padStart(8);
    });
    line(`  S${s}   ${cells.join('')}`);
  }
  showEnemy('■ 적 적절성 — 스테이지별', grp((r) => `S${r.stage}`), '스테이지');
  showEnemy('■ 적 적절성 — 지형별', grp((r) => r.theme), '테마');
  line('');
  line('■ 레벨 × 스테이지 — 처치율 (레벨링이 병목인지 확인)');
  const lvs = [...new Set(rows.map((r) => Math.floor(r.level / 5) * 5))].sort((x, y) => x - y);
  line(`        ${lvs.map((v) => `Lv${v}~`.padStart(8)).join('')}`);
  for (let st = 1; st <= 6; st += 1) {
    const cells = lvs.map((v) => {
      const sub = rows.filter((r) => r.stage === st && Math.floor(r.level / 5) * 5 === v);
      const sp = sub.reduce((a, r) => a + r.spawn, 0);
      if (sp === 0) return '     —  ';
      return pct(sub.reduce((a, r) => a + r.kills, 0) / sp).padStart(8);
    });
    line(`  S${st}   ${cells.join('')}`);
  }
  line('═'.repeat(78));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
