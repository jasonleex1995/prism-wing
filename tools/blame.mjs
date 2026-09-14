/**
 * 「길이 막힌 순간, 무엇이 막았는가」 — 강제 피격의 원인을 지형별로 «지목»한다.
 *
 *   손잡이를 추측해서 A/B 로 때리는 방식은 세 번 다 빗나갔다(magma·siren·frost 전부 유의차 없음).
 *   추측 대신 직접 센다: 회피 방향이 좁아진 순간마다 8 방향 각각을 «누가» 막았는지 귀속시킨다.
 *
 *   node tools/blame.mjs --theme volcano --runs 300
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld } from '../src/core/state.js';
import { enemies } from '../src/core/enemies.js';
import { emitters } from '../src/core/emitters.js';
import { tickRun, initRun, advanceStage, PHASE } from '../src/core/stage.js';
import { bossHook } from '../src/core/boss.js';
import { step } from '../src/core/step.js';
import { weapons } from '../src/core/weapons/index.js';
import { botInput } from '../src/core/bot.js';
import { loadData, makeScenario, seedBuild } from './study.mjs';
import { makeCtx, escapeDirs, trackMotion } from './lib/escape.mjs';

const DT = 1 / 60;


function main() {
  const argv = process.argv.slice(2);
  const val = (k, dv) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : dv; };
  const want = val('--theme', null);
  const wantStage = val('--stage', null) === null ? null : Number(val('--stage', null));
  const runs = Number(val('--runs', 300));
  const d = loadData('base');
  const ctx = makeCtx(d);
  const blame = Object.create(null);
  let tight = 0; let samples = 0; let used = 0;

  for (let idx = 0; used < runs && idx < runs * 40; idx += 1) {
    const sc = makeScenario(d, idx);
    const w = createWorld({ data: d, seed: sc.runSeed, weapons,
      hooks: { enemies, emitters, run: tickRun, boss: bossHook }, startWeaponId: sc.startWeapon });
    w.difficultyId = 'normal';
    w.tele = { dmgByFamily: Object.create(null), dmgTakenByArch: Object.create(null), kills: Object.create(null), crisisKills: 0, xpGained: 0 };
    initRun(w);
    seedBuild(w, d, (() => { let a = sc.buildSeed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })(), sc.level);
    for (let k = 0; k < sc.stage - 1; k += 1) advanceStage(w);
    if (wantStage !== null && sc.stage !== wantStage) continue;
    if (want !== null && w.run.order[w.run.stageIndex] !== want) continue;
    used += 1;
    for (let t = 0; t < 60 * 200; t += 1) {
      if (w.over) break;
      if (w.run && w.run.phase !== PHASE.MOB) break;
      w.player.hp = w.player.hpMax; w.draftQueue = 0;
      trackMotion(w, ctx, DT);
      if (t % 30 === 0) { samples += 1; if (escapeDirs(w, d, sc.horizon, ctx, blame) <= 2) tight += 1; }
      step(w, botInput(w, DT), DT);
    }
  }
  const L = (s) => process.stdout.write(`${s}\n`);
  const tot = Object.values(blame).reduce((a, b) => a + b, 0);
  L('─'.repeat(64));
  L(`막은 주체 — 테마 ${want ?? '전체'} · 스테이지 ${wantStage ?? '전체'} · ${used}판 · 좁아진 순간 ${tight}/${samples} (${(tight / samples * 100).toFixed(2)}%)`);
  L('─'.repeat(64));
  for (const [k, v] of Object.entries(blame).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    L(`  ${k.padEnd(30)} ${String(v).padStart(6)}  ${(v / tot * 100).toFixed(1)}%`);
  }
  L('─'.repeat(64));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
