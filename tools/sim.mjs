/**
 * tools/sim.mjs — 헤드리스 시뮬레이터 / 인증기 (§10.4 · §13.1.1)
 *
 * ★ 재사용 방식 (§10.4): 이 파일은 `../src/core/step.js` 를 **그대로 import** 한다. 렌더·오디오·DOM 은
 *   애초에 core 에 없으므로 **스텁조차 필요 없다.** 루프는 `while (!world.over) step(world, botInput(...))`
 *   — rAF 도 시계도 없이 게임시간만 흐른다. 그래서 «시뮬이 인증한 것 = 출시되는 것»이 성립한다.
 *
 * 두 모드 (§10.4.1 — 이 분리가 없으면 "보스당 격파율"과 "런 클리어율"이 같은 지표로 오인된다):
 *   run       — 런 클리어율. 봇은 정상(죽는다). 3 정책축(draft × farm × stance) 직교 (v1.5: shop 축 폐지).
 *   dpsProbe  — 보스 i 를 3분 안에 격파할 **화력이 있는가**. 봇 무적, 회피 로직은 그대로.
 *               셀 = (보스, 스테이지) 쌍 = 3 + 24 + 1 = 28 셀 (§10.4.2).
 *
 * 산출물 (`tools/report/`, 밸런싱·공정성 인증의 근거물 — §10.4.3):
 *   summary.json · weapons.csv · elements.csv · bosses.csv · stages.csv · deaths.csv
 *
 * 사용:
 *   node tools/sim.mjs --runs 200                 # run 모드, 텔레메트리 출력
 *   node tools/sim.mjs --probe --runs 20          # dpsProbe (셀당 runs)
 *   node tools/sim.mjs --certify                  # 임계값 판정, 실패 시 exit 1
 *   옵션: --seed N · --out DIR · --quiet · --policy k=v,k=v · --difficulty id
 *
 * ★ 정직성 원칙: 아직 측정하지 않는 지표는 **null 로 내보낸다.** check.mjs 는 null 을 «미측정»으로
 *   읽어 그 게이트를 STUB 으로 남긴다 — 측정 안 한 것을 통과로 위장하지 않는다.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { validate, MANIFEST } from '../src/core/schema.mjs';
import { sectionOf } from '../src/core/terrain.js';   // ㉜ 구간별 텔레메트리
import { createWorld } from '../src/core/state.js';
import { step, TICK_DT } from '../src/core/step.js';
import { weapons } from '../src/core/weapons/index.js';
import { enemies } from '../src/core/enemies.js';
import { emitters } from '../src/core/emitters.js';
import { bossHook } from '../src/core/boss.js';
import { initRun, tickRun, advanceStage, applyStageClearHeal, PHASE } from '../src/core/stage.js';
import { buildDraft, buildTraitDraft, applyCard } from '../src/core/draft.js';
import { setBotPolicy, botInput, botDraftPick } from '../src/core/bot.js';
import { tally } from '../src/core/score.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// ---------------------------------------------------------------------------
// 데이터 · 텔레메트리
// ---------------------------------------------------------------------------
export function loadData() {
  const raw = {};
  for (const n of MANIFEST) raw[n] = JSON.parse(readFileSync(join(ROOT, 'data', `${n}.json`), 'utf8'));
  return validate(raw);
}

/** 한 런의 계측기. core 의 sink(noteDamage·addKill·pickups)가 여기에 적립한다. */
function makeTele() {
  return {
    dmgByFamily: Object.create(null),
    dmgTakenByArch: Object.create(null),
    kills: Object.create(null),
    crisisKills: 0,
    xpGained: 0,
    // v1.10 ㉜ 구간별 — 키 = `${포지션}:${구간}` (early·midboss·crisis·boss · 그 밖은 페이즈 이름). 피격량·체류 초·진입 레벨
    dmgTakenBySection: Object.create(null),
    secBySection: Object.create(null),
    levelAtSection: Object.create(null),
    sectionKey,
  };
}

/** 구간 키 — terrain.sectionOf 의 구간 어휘(§8.19) + 페이즈. 런 밖(슬라이스)은 'slice'. */
function sectionKey(world) {
  const run = world.run;
  if (run === undefined) return 'slice';
  const sec = sectionOf(world);
  return `${run.stageIndex}:${sec === null ? run.phase : sec}`;
}

function sum(obj) {
  let s = 0;
  for (const k of Object.keys(obj)) s += obj[k];
  return s;
}
function median(a) {
  if (a.length === 0) return null;
  const b = a.slice().sort((x, y) => x - y);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}
function stddev(a) {
  if (a.length < 2) return 0;
  const mu = a.reduce((s, v) => s + v, 0) / a.length;
  const v = a.reduce((s, x) => s + (x - mu) * (x - mu), 0) / (a.length - 1);   // 표본 표준편차
  return Math.sqrt(v);
}

// ---------------------------------------------------------------------------
// 런 드라이버 — main.js 의 상태 기계를 렌더 없이 그대로 재현한다
// ---------------------------------------------------------------------------
/**
 * 결정 지점의 소유자가 드라이버라는 §10.4 의 계약을 지킨다:
 *   전투(스폰·보스·페이즈)는 순수 core 가, 드래프트/상점/컨티뉴는 여기가 소화한다.
 */
export function driveRun(data, seed, opts) {
  const o = opts === undefined ? {} : opts;
  const world = createWorld({
    data, seed, weapons,
    hooks: { enemies, emitters, run: tickRun, boss: bossHook },
  });
  world.difficultyId = o.difficulty === undefined ? 'normal' : o.difficulty;
  world.tele = makeTele();
  initRun(world);
  if (o.policy !== undefined) setBotPolicy(world, o.policy);

  const invincible = o.invincible === true;

  const r = {
    seed,
    won: false,
    stagesCleared: 0,
    deathCause: null,
    gameTime: 0,
    levelUps: 0,
    picks: { newWeapon: 0, weaponLevel: 0, passive: 0, elementLevel: 0 },
    weaponsOwned: [],
    elementPicks: Object.create(null),
    bossKillSec: [],          // 스테이지별 보스 격파 소요(초)
    bossTimerLeft: [],        // §10.4.3 stagePar — 격파 시점의 타이머 잔여
    bossUptime: [],           // 보스전 중 실제로 피해를 넣은 시간 비율(uptimeRef 실측)
    themeOrder: null,
    // §11.1(v1.6) 시작 무기는 매 런 추첨 → «전역 상수»가 아니라 «런의 속성»이다.
    startFamily: world.slots[0].family,
    score: 0,
    tele: world.tele,
    capHits: null,
  };

  const maxTicks = Math.floor((o.maxGameSec === undefined ? 3000 : o.maxGameSec) / TICK_DT);
  let bossStartT = 0;
  let bossDmgTicks = 0;
  let bossTicks = 0;
  let lastDmgTotal = 0;
  let prevPhase = world.run.phase;

  for (let t = 0; t < maxTicks; t += 1) {
    // ── 결정 지점 1: 드래프트(게임 클럭 정지) ────────────────────────────
    while (world.draftQueue > 0 && !world.over) {
      const draft = buildDraft(world);
      const i = botDraftPick(world, draft);
      const card = draft.cards[i];
      if (card !== undefined) {
        // ★ 카드 식별 필드는 `category` 다(`kind` 아님) — 이 오독이 픽/속성 텔레메트리를 전부 죽였다.
        r.picks[card.category] = (r.picks[card.category] === undefined ? 0 : r.picks[card.category]) + 1;
        if (card.category === 'elementLevel') {
          r.elementPicks[card.element] = (r.elementPicks[card.element] === undefined ? 0 : r.elementPicks[card.element]) + 1;
        }
      }
      applyCard(world, draft.cards[i]);
      r.levelUps += 1;
    }

    // ── 결정 지점 2: 스테이지 클리어 → 회복 → 다음 스테이지 (v1.5: 상점 폐지) ────
    if (world.run.phase === PHASE.STAGE_CLEAR) {
      // §11.6(v1.10 ⑲) 특성 3택 — 봇은 회복 묶음 우선(botDraftPick)
      while (world.traitQueue > 0) {
        const td = buildTraitDraft(world);
        if (td.cards.length === 0) { world.traitQueue = 0; break; }
        applyCard(world, td.cards[botDraftPick(world, td)]);
      }
      applyStageClearHeal(world);
      r.stagesCleared += 1;
      advanceStage(world);
      prevPhase = world.run.phase;
      continue;
    }

    // ── 보스 페이즈 계측 (uptime · 격파 시간) ─────────────────────────────
    if (world.run.phase === PHASE.BOSS && prevPhase !== PHASE.BOSS) {
      bossStartT = world.time; bossDmgTicks = 0; bossTicks = 0; lastDmgTotal = sum(world.tele.dmgByFamily);
    }
    prevPhase = world.run.phase;

    if (invincible) { world.player.hp = world.player.hpMax; world.player.iframeSec = 1; }

    step(world, botInput(world, TICK_DT), TICK_DT);
    r.gameTime = world.time;
    {                                                        // ㉜ 구간 체류 시간·진입 레벨
      const sk = sectionKey(world);
      const te = world.tele;
      te.secBySection[sk] = (te.secBySection[sk] === undefined ? 0 : te.secBySection[sk]) + TICK_DT;
      if (te.levelAtSection[sk] === undefined) te.levelAtSection[sk] = world.player.level;
    }

    if (world.run.phase === PHASE.BOSS) {
      bossTicks += 1;
      const now = sum(world.tele.dmgByFamily);
      if (now > lastDmgTotal) bossDmgTicks += 1;
      lastDmgTotal = now;
    }

    // 보스 격파 순간(= run.cleared 소화 직후 STAGE_CLEAR 로 넘어가기 전에 잔여 타이머를 읽는다)
    if (world.run.phase === PHASE.STAGE_CLEAR && r.bossKillSec.length === r.stagesCleared) {
      r.bossKillSec.push(world.time - bossStartT);
      r.bossTimerLeft.push(world.run.bossTimer);
      r.bossUptime.push(bossTicks > 0 ? bossDmgTicks / bossTicks : 0);
    }

    if (world.over) {
      // v1.5 — 컨티뉴 폐지: 사망 = 즉시 종료(원데스).
      // ★ 최종(finale) 격파는 STAGE_CLEAR 로 안 가고 곧장 won+over → 6번째 보스가 STAGE_CLEAR-게이트
      //   텔레메트리에서 누락되고 stagesCleared 도 5 에 멈춘다. 여기서 최종 스테이지를 집계한다.
      if (world.run.won && r.bossKillSec.length === r.stagesCleared) {
        r.bossKillSec.push(world.time - bossStartT);
        r.bossTimerLeft.push(world.run.bossTimer);
        r.bossUptime.push(bossTicks > 0 ? bossDmgTicks / bossTicks : 0);
        r.stagesCleared += 1;
      }
      break;
    }
  }

  r.won = world.run.won;
  r.deathCause = world.run.deathCause;
  r.themeOrder = world.run.order.slice();
  r.capHits = { ...world.capHits };
  r.score = tally(world).total;
  for (const s of world.slots) if (s.weaponId !== null) r.weaponsOwned.push(s.family);
  r.evolvedCount = world.slots.reduce((n, s) => n + (s.evolved ? 1 : 0), 0);
  r.maxWeaponLevel = world.slots.reduce((mx, s) => (s.weaponId !== null && s.level > mx ? s.level : mx), 0);
  return r;
}

// ★ v1.5 — 상점 시뮬(doShop)은 폐지됐다: 경제 제거.

// ---------------------------------------------------------------------------
// dpsProbe — (보스, 스테이지) 셀의 «화력이 되는가»
// ---------------------------------------------------------------------------
/**
 * §10.4.2 — 프로브는 열거다(추첨이 아니다). 셀을 직접 세운다: 그 스테이지에 그 보스를 놓고,
 *   무적 봇이 bossTimerSec 안에 코어를 격파하는지 본다. 사망은 판정 대상이 아니다.
 */
export function probeCells(data) {
  const cells = [];
  const stages = data.stages.stages.filter((s) => s.id !== data.stages.themeDraw.finalStageId);
  const intro = stages.filter((s) => s.introOk);
  for (let stage = 1; stage <= 6; stage += 1) {
    if (stage === 1) for (const s of intro) cells.push({ bossId: s.bossId, stage });
    else if (stage === 6) cells.push({ bossId: data.stages.stages.find((s) => s.id === data.stages.themeDraw.finalStageId).bossId, stage });
    else for (const s of stages) cells.push({ bossId: s.bossId, stage });
  }
  return cells;
}

/**
 * 한 프로브 런: 잡몹 페이즈를 정상으로 흘려 성장시킨 뒤(=화력의 근거) 보스만 붙여 격파 여부를 본다.
 *   ★ 성장 없이 보스만 붙이면 «Lv1 로 보스를 잡는가»를 묻게 되어 게이트의 의미가 바뀐다.
 */
export function probeRun(data, seed, cell, opts) {
  const o = opts === undefined ? {} : opts;
  const world = createWorld({
    data, seed, weapons,
    hooks: { enemies, emitters, run: tickRun, boss: bossHook },
  });
  world.difficultyId = o.difficulty === undefined ? 'normal' : o.difficulty;
  world.tele = makeTele();
  initRun(world);
  setBotPolicy(world, o.policy === undefined ? { farm: 'maxFarm' } : o.policy);

  // 셀이 지정한 스테이지·보스로 무대를 세운다(열거이므로 추첨 결과를 덮어쓴다)
  world.run.stageIndex = cell.stage - 1;
  const stageOfBoss = data.stages.stages.find((s) => s.bossId === cell.bossId);
  world.run.order[world.run.stageIndex] = stageOfBoss.id;

  const ph = data.stages.phase;
  const growSec = ph.mobPhaseSec;
  const maxTicks = Math.floor((growSec + ph.bossTimerSec + 30) / TICK_DT);

  let killed = false;
  let killSec = null;
  let bossTicks = 0;
  let dmgTicks = 0;
  let lastDmg = 0;
  let bossStart = 0;

  for (let t = 0; t < maxTicks; t += 1) {
    while (world.draftQueue > 0) {
      const draft = buildDraft(world);
      applyCard(world, draft.cards[botDraftPick(world, draft)]);
    }
    // 무적 — 프로브는 «화력»만 묻는다(§10.4.1)
    world.player.hp = world.player.hpMax;
    world.player.iframeSec = 1;
    world.over = false;

    if (world.run.phase === PHASE.BOSS && bossStart === 0) {
      bossStart = world.time;
      lastDmg = sum(world.tele.dmgByFamily);
    }
    step(world, botInput(world, TICK_DT), TICK_DT);

    if (world.run.phase === PHASE.BOSS) {
      bossTicks += 1;
      const now = sum(world.tele.dmgByFamily);
      if (now > lastDmg) dmgTicks += 1;
      lastDmg = now;
    }
    if (world.run.phase === PHASE.STAGE_CLEAR || world.run.won) { killed = true; killSec = world.time - bossStart; break; }
    if (world.run.deathCause === 'timeout') break;      // 타이머 만료 = 화력 부족 = 불통과(사망은 판정 대상이 아니다)
  }
  return { killed, killSec, uptime: bossTicks > 0 ? dmgTicks / bossTicks : 0 };
}

// ---------------------------------------------------------------------------
// 집계
// ---------------------------------------------------------------------------
function aggregate(data, runs, meta) {
  const n = runs.length;
  const cleared = runs.filter((r) => r.won);
  const dmgShare = Object.create(null);
  const lethal = Object.create(null);
  const weaponPicks = Object.create(null);
  const elementPicks = Object.create(null);        // 전 런 — elements.csv 진단용
  const elementPicksCleared = Object.create(null);  // 클리어 런만 — §13.1.1 밴딩용
  const kills = Object.create(null);
  // ★ A층(enemyConcurrentMax·swarmConcurrentMax 등 defer)은 코어가 카운터 없이 break 로 처리해
  //   **집계할 원천이 없다**. 0 으로 내보내면 「A층 초과 0건」이라는 거짓 증명이 되므로 null 로 둔다
  //   (같은 파일 uptimeRef 와 동일한 처분 — 못 재는 것은 PASS 가 아니라 UNMEASURED 다).
  const capA = null;
  let capB = 0;

  for (const r of runs) {
    for (const k of Object.keys(r.tele.dmgTakenByArch)) {
      lethal[k] = (lethal[k] === undefined ? 0 : lethal[k]) + r.tele.dmgTakenByArch[k];
    }
    for (const k of Object.keys(r.tele.kills)) kills[k] = (kills[k] === undefined ? 0 : kills[k]) + r.tele.kills[k];
    for (const f of r.weaponsOwned) weaponPicks[f] = (weaponPicks[f] === undefined ? 0 : weaponPicks[f]) + 1;
    for (const e of Object.keys(r.elementPicks)) {
      elementPicks[e] = (elementPicks[e] === undefined ? 0 : elementPicks[e]) + r.elementPicks[e];
    }
    for (const k of Object.keys(r.capHits)) capB += r.capHits[k];
  }
  // 무기 «승리 지분» = 클리어 런의 패밀리별 피해 지분 평균 (§13.1.1)
  const winShare = Object.create(null);
  for (const r of cleared) {
    const tot = sum(r.tele.dmgByFamily);
    if (tot <= 0) continue;
    for (const f of Object.keys(r.tele.dmgByFamily)) {
      winShare[f] = (winShare[f] === undefined ? 0 : winShare[f]) + r.tele.dmgByFamily[f] / tot;
    }
  }
  for (const f of Object.keys(winShare)) winShare[f] /= Math.max(1, cleared.length);
  // §13.1.1 — 속성 «승리 지분» 의 분모도 무기와 같이 **클리어 런**이다.
  //   v1.5까지 이 집계가 전 런(실패 포함)을 돌아, 클리어 0인 빌드에서도 숫자가 나와
  //   그게 dominance 밴드를 통과/실패시켰다(형제 지표 weaponWinShare 와 비대칭).
  for (const r of cleared) {
    for (const e of Object.keys(r.elementPicks)) {
      elementPicksCleared[e] = (elementPicksCleared[e] === undefined ? 0 : elementPicksCleared[e]) + r.elementPicks[e];
    }
  }
  for (const r of runs) {
    const tot = sum(r.tele.dmgByFamily);
    if (tot <= 0) continue;
    for (const f of Object.keys(r.tele.dmgByFamily)) {
      dmgShare[f] = (dmgShare[f] === undefined ? 0 : dmgShare[f]) + r.tele.dmgByFamily[f] / tot;
    }
  }
  for (const f of Object.keys(dmgShare)) dmgShare[f] /= n;

  // 테마별 클리어율(finale 제외) — themeOrder[0..4] 가 실제 배정된 테마다
  const themeRuns = Object.create(null);
  const themeWins = Object.create(null);
  for (const r of runs) {
    for (let i = 0; i < r.themeOrder.length - 1; i += 1) {
      const id = r.themeOrder[i];
      themeRuns[id] = (themeRuns[id] === undefined ? 0 : themeRuns[id]) + 1;
      if (r.stagesCleared > i) themeWins[id] = (themeWins[id] === undefined ? 0 : themeWins[id]) + 1;
    }
  }
  const themeClear = Object.create(null);
  for (const id of Object.keys(themeRuns)) themeClear[id] = themeWins[id] === undefined ? 0 : themeWins[id] / themeRuns[id];

  const timeouts = runs.filter((r) => r.deathCause === 'timeout').length;
  const hpDeaths = runs.filter((r) => r.deathCause === 'hp').length;
  // §11.1(v1.6) — startWeaponId 는 폐지됐다. 시작 무기가 런마다 다르므로 이 지표는
  //   «클리어 런 각각에서, 그 런이 들고 시작한 무기가 낸 피해 지분» 의 평균이다.
  //   v1.5 까지는 전역 상수 forward 하나로 읽었다 — 그대로 두면 undefined 색인이라
  //   지표가 조용히 null 로 죽는다. 죽은 게이트는 통과가 아니다.
  let swSum = 0;
  let swRuns = 0;
  for (const cr of cleared) {
    const tot = sum(cr.tele.dmgByFamily);
    if (tot <= 0) continue;
    const d = cr.tele.dmgByFamily[cr.startFamily];
    swSum += (d === undefined ? 0 : d) / tot;
    swRuns += 1;
  }
  const startWeaponShare = swRuns === 0 ? null : swSum / swRuns;

  return {
    runs: n,
    policy: meta.policy,
    difficulty: meta.difficulty,
    runClearRate: cleared.length / n,
    bossTimeoutRate: timeouts / n,
    hpDeathRate: hpDeaths / n,
    meanStagesCleared: runs.reduce((s, r) => s + r.stagesCleared, 0) / n,
    medianLevelUps: median(runs.map((r) => r.levelUps)),
    maxLevelUps: Math.max(...runs.map((r) => r.levelUps)),
    medianXpGained: median(runs.map((r) => r.tele.xpGained)),
    medianScore: median(runs.map((r) => r.score)),
    bossKillSecMedian: median(runs.flatMap((r) => r.bossKillSec)),
    stageParMedian: median(runs.flatMap((r) => r.bossTimerLeft)),
    uptimeMeasured: median(runs.flatMap((r) => r.bossUptime)),
    weaponDamageShare: dmgShare,
    weaponWinShare: winShare,
    weaponPickCounts: weaponPicks,
    startWeaponDamageShare: startWeaponShare,
    elementPickCounts: elementPicks,
    elementPickCountsCleared: elementPicksCleared,
    archetypeLethality: lethal,
    kills,
    crisisKillsMedian: median(runs.map((r) => r.tele.crisisKills)),
    themeClearRate: themeClear,
    themeClearStddev: stddev(Object.values(themeClear)),
    capHitsA: capA,
    capHitsB: capB,
  };
}

// ---------------------------------------------------------------------------
// CSV 산출
// ---------------------------------------------------------------------------
function csv(rows) {
  return rows.map((r) => r.join(',')).join('\n') + '\n';
}
function writeReports(outDir, summary, runs, probe) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  const wRows = [['family', 'pickCount', 'damageShare', 'winShare']];
  const fams = Object.keys(weapons);
  for (const f of fams) {
    wRows.push([f, summary.run.weaponPickCounts[f] || 0,
      (summary.run.weaponDamageShare[f] || 0).toFixed(6), (summary.run.weaponWinShare[f] || 0).toFixed(6)]);
  }
  writeFileSync(join(outDir, 'weapons.csv'), csv(wRows));

  const eRows = [['element', 'pickCount']];
  for (const e of Object.keys(summary.run.elementPickCounts)) eRows.push([e, summary.run.elementPickCounts[e]]);
  writeFileSync(join(outDir, 'elements.csv'), csv(eRows));

  const dRows = [['cause', 'count']];
  dRows.push(['hp', runs.filter((r) => r.deathCause === 'hp').length]);
  dRows.push(['timeout', runs.filter((r) => r.deathCause === 'timeout').length]);
  dRows.push(['won', runs.filter((r) => r.won).length]);
  writeFileSync(join(outDir, 'deaths.csv'), csv(dRows));

  const sRows = [['runSeed', 'stagesCleared', 'levelUps', 'score', 'deathCause']];
  for (const r of runs) sRows.push([r.seed, r.stagesCleared, r.levelUps, r.score, r.deathCause || (r.won ? 'won' : 'incomplete')]);
  writeFileSync(join(outDir, 'stages.csv'), csv(sRows));

  const bRows = [['bossId', 'stage', 'passRate', 'killSecMedian', 'uptimeMedian']];
  if (probe !== null) for (const c of probe.cells) bRows.push([c.bossId, c.stage, c.passRate.toFixed(4), c.killSecMedian === null ? '' : c.killSecMedian.toFixed(2), c.uptime.toFixed(4)]);
  writeFileSync(join(outDir, 'bosses.csv'), csv(bRows));
}

// ---------------------------------------------------------------------------
// 인증 — meta.certify 의 임계값으로 판정한다
// ---------------------------------------------------------------------------
function grade(data, summary) {
  const c = data.meta.certify;
  const rm = c.runMode;
  const out = [];
  const band = (name, v, lo, hi, note) => {
    if (v === null || v === undefined) { out.push({ name, status: 'UNMEASURED', value: null, note }); return; }
    const ok = (lo === undefined || v >= lo) && (hi === undefined || v <= hi);
    out.push({ name, status: ok ? 'PASS' : 'FAIL', value: v, min: lo, max: hi, note });
  };
  const r = summary.run;
  band('runClearRate', r.runClearRate, rm.runClearRate.min, rm.runClearRate.max);
  band('bossTimeoutRate', r.bossTimeoutRate, rm.bossTimeoutRate.min, rm.bossTimeoutRate.max);
  band('difficultySpread.hell', summary.hellRunClearRate,
    rm.difficultySpread.hellRunClearRate.min, rm.difficultySpread.hellRunClearRate.max);
  band('static.growthBudget.maxLevelUps', r.maxLevelUps, undefined, c.static.growthBudget.maxLevelUps);
  band('static.capHits', r.capHitsB, undefined, c.static.capHits.max);
  band('dominance.maxThemeClearStddev', r.themeClearStddev, undefined, rm.dominance.maxThemeClearStddev);
  band('dominance.startWeaponDamageShare', r.startWeaponDamageShare,
    rm.dominance.startWeaponDamageShare.min, rm.dominance.startWeaponDamageShare.max);

  // 지배도 — §13.1.1. v1.5 까지는 forward 를 뺀 뒤 재정규화했다: forward 가 «모든 런의
  //   시작 무기» 라 보유율이 구조적으로 1.00 이었고, 그대로 두면 밴드가 항상 실패했다.
  //   §11.1(v1.6) 시작 무기가 추첨이 되면서 그 왜곡이 사라졌다 — 어느 무기도 보장되지
  //   않으므로 **제외 없이 전 종을 재정규화**한다. 특정 무기를 계속 빼는 것은 이제
  //   근거 없는 특례이고, 지배도 검사에서 한 종을 그냥 지우는 것과 같다.
  const reNorm = (obj) => {
    const keys = Object.keys(obj);
    const tot = keys.reduce((s, k) => s + obj[k], 0);
    if (tot <= 0) return null;
    return Math.max(...keys.map((k) => obj[k] / tot));
  };
  band('dominance.maxWeaponWinShare', Object.keys(r.weaponWinShare).length > 0 ? reNorm(r.weaponWinShare) : null,
    undefined, rm.dominance.maxWeaponWinShare);
  const pickTot = Object.keys(r.weaponPickCounts)
    .reduce((s, k) => s + r.weaponPickCounts[k], 0);
  band('dominance.maxWeaponPickShare', pickTot > 0 ? reNorm(r.weaponPickCounts) : null,
    undefined, rm.dominance.maxWeaponPickShare);
  // §13.1.1 — 분모 = **클리어 런**의 총 속성 투자 픽 수. 클리어가 0이면 측정 불가(null)이며,
  //   실패 런의 픽 분포로 대신 채점하지 않는다(그건 게이트가 아니라 잡음이다).
  const elCleared = r.elementPickCountsCleared || Object.create(null);
  const elTot = Object.values(elCleared).reduce((s, v) => s + v, 0);
  band('dominance.maxElementWinShare', elTot > 0 ? Math.max(...Object.values(elCleared)) / elTot : null,
    undefined, rm.dominance.maxElementWinShare);
  // 치사 지분 — 중간보스·보스·출처불명은 분모에서도 제외한다(§13.1.1)
  const le = r.archetypeLethality;
  const leKeys = Object.keys(le).filter((k) => k !== 'other' && !k.startsWith('mb') && k !== 'boss');
  const leTot = leKeys.reduce((s, k) => s + le[k], 0);
  band('dominance.maxArchetypeLethalityShare', leTot > 0 ? Math.max(...leKeys.map((k) => le[k])) / leTot : null,
    undefined, rm.dominance.maxArchetypeLethalityShare);

  band('stanceValue', summary.stanceValueDelta, rm.stanceValue.minRunClearDeltaVsStaticStance, undefined);
  band('noDeadLuck.worstDraftPolicy', summary.worstDraftPolicyClear, rm.noDeadLuck.minRunClearWorstDraftPolicy, undefined);
  band('noDeadLuck.worstThemeOrder', summary.worstThemeClear, rm.noDeadLuck.minRunClearWorstThemeOrder, undefined);
  band('farmXpRatio', summary.farmXpRatio, rm.farmXpRatio.min, undefined);
  band('crisisKillShareWithoutCapstone', summary.crisisKillShare, rm.crisisKillShareWithoutCapstone.min, undefined);

  if (summary.probe !== null && summary.probe !== undefined) {
    const p = summary.probe;
    for (let i = 0; i < 6; i += 1) {
      band(`dpsProbe.balancedPass[${i + 1}]`, p.passByStage[i], c.dpsProbe.balancedPass.min[i], undefined);
    }
    band('dpsProbe.killTimeMedianBalanced', p.killSecMedian,
      c.dpsProbe.killTimeMedianBalanced.min, c.dpsProbe.killTimeMedianBalanced.max);
    // ★ 정직성 — 현재 uptime 은 «피해가 오른 틱의 비율»(tick-proxy)이지 §10.4.3 의 «명목 DPS 대비 실효
    //   전달률»이 아니다(느린 무기에서 크게 과소계상 → 오도하는 FAIL). 올바른 측정(명목 DPS 대비)이
    //   구현되기 전엔 **UNMEASURED** 로 남긴다. 진단용 tick-proxy 는 bosses.csv 에 그대로 남는다.
    band('dpsProbe.uptimeRef(실측)', null, c.dpsProbe.uptimeRef - 0.05, c.dpsProbe.uptimeRef + 0.05);
    // ★ 정직성 — probe 는 balanced 빌드 한 축만 돈다. specialist·noElement 축은 **측정 자체를 하지
    //   않으므로** 밴딩에서 조용히 빠져 있었고, meta.json 의 임계값 18개가 아무도 안 읽는 상태였다.
    //   측정이 구현되기 전까지 UNMEASURED 로 **출력**한다 — 빠져 있는 것과 못 잰 것은 다르다.
    for (let i = 0; i < 6; i += 1) {
      band(`dpsProbe.specialistPass[${i + 1}]`, null, c.dpsProbe.specialistPass.min[i], undefined);
    }
    for (let i = 0; i < 6; i += 1) {
      band(`dpsProbe.noElementPass[${i + 1}]`, null,
        c.dpsProbe.noElementPass.min[i], c.dpsProbe.noElementPass.max[i]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------
function runBatch(data, n, seed0, opts, onProgress) {
  const runs = [];
  for (let i = 0; i < n; i += 1) {
    runs.push(driveRun(data, seed0 + i, opts));
    if (onProgress !== undefined && (i + 1) % 25 === 0) onProgress(i + 1, n);
  }
  return runs;
}

function parseArgs(argv) {
  const a = { runs: 100, seed: 0, out: join(HERE, 'report'), certify: false, probe: false, quiet: false, difficulty: 'normal', policy: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k === '--runs') { a.runs = Number(argv[i + 1]); i += 1; }
    else if (k === '--seed') { a.seed = Number(argv[i + 1]); i += 1; }
    else if (k === '--out') { a.out = argv[i + 1]; i += 1; }
    else if (k === '--difficulty') { a.difficulty = argv[i + 1]; i += 1; }
    else if (k === '--policy') {
      for (const kv of argv[i + 1].split(',')) { const [pk, pv] = kv.split('='); a.policy[pk] = pv; }
      i += 1;
    } else if (k === '--certify') a.certify = true;
    else if (k === '--probe') a.probe = true;
    else if (k === '--quiet') a.quiet = true;
  }
  return a;
}

export function main(argv) {
  const a = parseArgs(argv);
  const data = loadData();
  const log = a.quiet ? () => {} : (...m) => console.log(...m);
  const bar = '─'.repeat(78);

  log(bar);
  log(`시뮬 — run ${a.runs} 런 · seed ${a.seed} · difficulty ${a.difficulty}`);
  log(bar);

  const baseline = runBatch(data, a.runs, a.seed, { difficulty: a.difficulty, policy: a.policy },
    (i, n) => log(`  ... ${i}/${n}`));
  const summary = { generatedBy: 'tools/sim.mjs', run: aggregate(data, baseline, { policy: 'baseline', difficulty: a.difficulty }) };

  // 축 스윕 — 인증 모드에서만(비싸다). §10.4.1: 축마다 나머지 3축은 baseline 고정.
  summary.stanceValueDelta = null;
  summary.worstDraftPolicyClear = null;
  summary.worstThemeClear = null;
  summary.farmXpRatio = null;
  summary.crisisKillShare = null;
  summary.hellRunClearRate = null;
  summary.probe = null;

  if (a.certify) {
    const sweepN = Math.max(20, Math.floor(a.runs / 4));
    log(`\n축 스윕 (축당 ${sweepN} 런)`);
    const stat = aggregate(data, runBatch(data, sweepN, a.seed + 10000, { difficulty: a.difficulty, policy: { stance: 'static' } }), {});
    summary.stanceValueDelta = summary.run.runClearRate - stat.runClearRate;
    log(`  stance static      clear ${(stat.runClearRate * 100).toFixed(1)}%`);

    let worst = 1;
    for (const dp of ['generalist', 'weaponRush', 'elementRush', 'greedyDps', 'specialist', 'random']) {
      const s = aggregate(data, runBatch(data, sweepN, a.seed + 20000, { difficulty: a.difficulty, policy: { draft: dp } }), {});
      log(`  draft ${dp.padEnd(12)} clear ${(s.runClearRate * 100).toFixed(1)}%`);
      if (s.runClearRate < worst) worst = s.runClearRate;
    }
    summary.worstDraftPolicyClear = worst;
    summary.worstThemeClear = Math.min(...Object.values(summary.run.themeClearRate));

    const maxFarm = aggregate(data, runBatch(data, sweepN, a.seed + 30000, { difficulty: a.difficulty, policy: { farm: 'maxFarm' } }), {});
    const passive = aggregate(data, runBatch(data, sweepN, a.seed + 40000, { difficulty: a.difficulty, policy: { farm: 'passive' } }), {});
    summary.farmXpRatio = passive.medianXpGained > 0 ? maxFarm.medianXpGained / passive.medianXpGained : null;
    log(`  farm maxFarm/passive XP ${maxFarm.medianXpGained.toFixed(0)} / ${passive.medianXpGained.toFixed(0)}`);

    const dis = aggregate(data, runBatch(data, sweepN, a.seed + 50000, { difficulty: 'hell', policy: {} }), {});
    summary.hellRunClearRate = dis.runClearRate;
    log(`  difficulty hell clear ${(dis.runClearRate * 100).toFixed(1)}%`);
  }

  let probe = null;
  if (a.probe || a.certify) {
    const cells = probeCells(data);
    const per = a.probe ? a.runs : Math.max(4, Math.floor(a.runs / 20));
    log(`\ndpsProbe — ${cells.length} 셀 × ${per} 런`);
    const rows = [];
    const passByStage = [0, 0, 0, 0, 0, 0];
    const cntByStage = [0, 0, 0, 0, 0, 0];
    const allKill = [];
    const allUp = [];
    for (const cell of cells) {
      let pass = 0;
      const ks = [];
      const us = [];
      for (let i = 0; i < per; i += 1) {
        const pr = probeRun(data, a.seed + i * 7 + cell.stage * 101, cell, { policy: { farm: 'maxFarm' } });
        if (pr.killed) { pass += 1; ks.push(pr.killSec); allKill.push(pr.killSec); }
        us.push(pr.uptime); allUp.push(pr.uptime);
      }
      const passRate = pass / per;
      rows.push({ bossId: cell.bossId, stage: cell.stage, passRate, killSecMedian: median(ks), uptime: median(us) });
      passByStage[cell.stage - 1] += passRate;
      cntByStage[cell.stage - 1] += 1;
      log(`  ${cell.bossId.padEnd(10)} s${cell.stage}  통과 ${(passRate * 100).toFixed(0)}%`);
    }
    probe = {
      cells: rows,
      passByStage: passByStage.map((v, i) => (cntByStage[i] > 0 ? v / cntByStage[i] : null)),
      killSecMedian: median(allKill),
      uptime: median(allUp),
    };
    summary.probe = probe;
  }

  writeReports(a.out, summary, baseline, probe);
  log(`\n산출: ${a.out}/summary.json · weapons.csv · elements.csv · bosses.csv · stages.csv · deaths.csv`);

  const r = summary.run;
  log(`\n${bar}`);
  log(`클리어율 ${(r.runClearRate * 100).toFixed(1)}%  ·  타임아웃 ${(r.bossTimeoutRate * 100).toFixed(1)}%  ·  `
    + `평균 스테이지 ${r.meanStagesCleared.toFixed(2)}  ·  레벨업 중앙값 ${r.medianLevelUps}`);
  log(`점수 중앙값 ${r.medianScore}`);
  log(bar);

  if (!a.certify) return 0;

  const results = grade(data, summary);
  log('\n인증 판정 (meta.certify)');
  log(bar);
  let fails = 0;
  let unmeasured = 0;
  for (const g of results) {
    const v = g.value === null ? '   —   ' : (typeof g.value === 'number' ? g.value.toFixed(4).padStart(8) : String(g.value));
    const bandTxt = `${g.min === undefined ? '' : `≥${g.min}`}${g.max === undefined ? '' : ` ≤${g.max}`}`.trim();
    log(`  ${g.status.padEnd(10)} ${g.name.padEnd(38)} ${v}   ${bandTxt}`);
    if (g.status === 'FAIL') fails += 1;
    if (g.status === 'UNMEASURED') unmeasured += 1;
  }
  log(bar);
  log(`요약  PASS ${results.length - fails - unmeasured} · FAIL ${fails} · UNMEASURED ${unmeasured}`);
  summary.certify = { results, fails, unmeasured };
  writeFileSync(join(a.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return fails > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('sim.mjs')) {
  process.exit(main(process.argv.slice(2)));
}
