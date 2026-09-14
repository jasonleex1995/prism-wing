/**
 * src/core/terrain.js — 지형 장판 (§8.21, v1.10 ⑦ 신설 · 순수 core 모듈)
 *
 * 사용자 결정(2026-09-04): 「공격이 아니라 **유틸을 방해하는** 지형 — 늪 웅덩이는 느리게, 빙원은 가속도가 붙고,
 *   화산은 갑자기 과열돼서 멈춘다」. 그래서 이 장판은 **피해 0** 이다 — 피해 장판은 적 공격(magmaZone·mortar)이
 *   이미 한다(§8.5). 기계는 3종이고 **속성당 하나**, 테마는 겉모습만 다르다(§7.13):
 *     slow    (풀 — 늪·숲)  : 안에 있으면 둔화 = status.slowMoveSpeedMul (기존 둔화 상태를 «매 틱 갱신»해 쓴다, 새 키 0)
 *     inertia (물 — 빙원·바다): 안에서는 이동 응답이 rules.terrain.inertia.responseTauSec 로 미끄러진다(§2.2 의 «항은 존재하고
 *                             값이 0» 이던 지수 스무딩을 지형이 켠다)
 *     heat    (불 — 화산·사막): 안에 있는 동안 player.heat 가 fullSec 에 차고, 다 차면 stallSec 스턴(§2.7) 후 0. 밖에서는 coolSec 에 식는다
 *
 * 소유: 스폰 시각표·위치(rng.terrain) · 흐름(scrollSpeedPx, 위 → 아래) · 반납(아레나 아래로 나가면) · 「플레이어가 어느
 *   장판 안인가」의 술어(terrainUnder). 효과의 «적용»은 step.movePlayer 가 한다(이동의 단일 소유자, §2.2).
 * ★ 결정성 — rng 는 `terrain` 스트림만 쓴다(x 위치). 시각표는 run.terrainNextT(게임초). 핫패스 0 alloc.
 * ★ 지형이라 예고가 없다 — 피해가 없으니 §2.1 ① 의 대상이 아니고, 항상 보인다(§12.3 레이어 1).
 */

import { TERRAIN_KINDS, TERRAIN_MIXED, SECTIONS } from './schema.mjs';
import { difficultyTerrainCap } from './state.js';   // §8.21 ④(v1.10 ㊿-w) 무대 상한 = 난이도 표

export const T_SLOW = 0;
export const T_INERTIA = 1;
export const T_HEAT = 2;

/** 현재 스테이지 엔트리(stage.js 를 import 하지 않는다 — 순환). */
function stageOf(world) {
  const id = world.run.order[world.run.stageIndex];
  const list = world.data.stages.stages;
  for (let i = 0; i < list.length; i += 1) if (list[i].id === id) return list[i];
  throw new Error(`terrain: 미지의 스테이지 id "${id}" (§9.9)`);
}

/** 지형 종 → 인덱스. 폴백 금지(§9.3). */
function kindIndex(kind) {
  const k = TERRAIN_KINDS.indexOf(kind);
  if (k < 0) throw new Error(`terrain: 미지의 terrainKind "${kind}" (§8.21)`);
  return k;
}

/**
 * §8.21 ③ 이 스테이지가 «다음에 놓을» 종 — 테마 스테이지는 그 테마의 하나. finale(`mixed`, v1.10 ⑳·㉑)은 3종이
 *   **무작위 순서**로 나오되 «3개마다 전부 한 번씩»이다 — 가방(bag): 비면 3종을 rng.terrain 으로 섞어 채우고 하나씩 꺼낸다
 *   (§8.2 의 속성 가방과 같은 문법). 사용자(2026-09-05): 「최종이니까 3종이 다 랜덤하게 나오는 게 좋겠다」. 고정 순환은
 *   외워지고, 순수 무작위는 한 종이 안 나오는 런을 만든다 — 가방이 둘 다 피한다. 보스 등장 무리 3개 = 하나씩 전부(순서만 무작위).
 *   null = 지형 없음(-1). 결정적(rng.terrain 스트림).
 */
function nextKind(world, st) {
  if (st.terrainKind === null) return -1;
  if (st.terrainKind !== TERRAIN_MIXED) return kindIndex(st.terrainKind);
  const run = world.run;
  const bag = run.terrainBag;
  if (run.terrainBagN === 0) {
    for (let i = 0; i < TERRAIN_KINDS.length; i += 1) bag[i] = i;
    for (let i = TERRAIN_KINDS.length - 1; i > 0; i -= 1) {           // Fisher–Yates (rng.terrain)
      const j = Math.floor(world.rng.terrain.f() * (i + 1));
      const tmp = bag[i]; bag[i] = bag[j]; bag[j] = tmp;
    }
    run.terrainBagN = TERRAIN_KINDS.length;
  }
  run.terrainBagN -= 1;
  return bag[run.terrainBagN];
}

/**
 * §8.19 ① 의 구간 이름 — 지형 스폰 허용(rules.terrain.spawnIn)의 정의역. 슬라이스(런 없음)는 null.
 *   MOB: 위기면 'crisis' · 첫 중간보스 전이면 'early'(배수 포함) · 그 사이 'midboss'. BOSS_INTRO/BOSS: 'boss'. 그 밖 null.
 */
export function sectionOf(world) {
  const run = world.run;
  if (run === undefined) return null;
  if (run.phase === 'BOSS_INTRO' || run.phase === 'BOSS') return SECTIONS[3];
  if (run.phase !== 'MOB') return null;
  if (run.crisis) return SECTIONS[2];
  const mbAt = world.data.stages.phase.midBossAtSec[run.stageIndex];
  if (Array.isArray(mbAt) && mbAt.length > 0 && run.phaseT < mbAt[0]) return SECTIONS[0];
  return SECTIONS[1];
}

/** 한 장판을 놓는다(공용). null = 풀 소진(caps.terrain rejectSpawn). */
function place(world, kind, x, y) {
  const t = world.terrain.alloc();
  if (t === null) return null;
  t.kind = kind; t.radius = world.data.rules.terrain.radiusPx; t.x = x; t.y = y; t.fadeT = -1;
  return t;
}

/**
 * ★ 훅 진입점 — stage.tickRun 이 매 고정 틱 부른다(페이즈 무관: 흐름·반납·페이드는 늘, 스폰은 허용 구간에서만).
 *   (1) 흐름 — 모든 장판이 scrollSpeedPx 로 내려간다. 아레나 아래로 완전히 나가면 반납. 페이드 중이면 fadeSec 뒤 반납.
 *   (2) 스폰 — 현재 구간 ∈ rules.terrain.spawnIn(v1.10 ⑧: 위기 제외 — 186px/s 무리 속의 둔화·정지는 확정 피격이라
 *       §2.1 ① 을 깬다), terrainKind ≠ null, everySec 마다, 무대에 «난이도별 상한»(state.difficultyTerrainCap — 난이도 표가 소유한다) 미만일 때.
 *       x = 아레나 안 균일(rng.terrain), y = spawnLineY − radius (위에서 «들어온다»).
 */
export function terrainTick(world, dt) {
  const run = world.run;
  const tr = world.data.rules.terrain;
  const a = world.data.rules.view.arena;
  const it = world.terrain.items;
  for (let i = 0; i < it.length; i += 1) {
    const t = it[i];
    if (!t.alive) continue;
    if (t.fadeT >= 0) {
      t.fadeT += dt;
      if (t.fadeT >= tr.fadeSec) { world.terrain.release(t); continue; }
    }
    t.y += tr.scrollSpeedPx * dt;
    if (t.y - t.radius > a.y + a.h) world.terrain.release(t);
  }
  const sec = sectionOf(world);
  if (sec === null || tr.spawnIn.indexOf(sec) < 0) return;
  if (run.wipeT >= 0) return;                                   // §8.22 쓸어내기 중엔 놓지 않는다(놓자마자 지워진다)
  const st = stageOf(world);
  if (st.terrainKind === null) return;                         // 지형 없는 스테이지(어휘상 허용 — 현재 데이터엔 없다)
  if (world.time < run.terrainNextT) return;
  run.terrainNextT = world.time + tr.everySec;
  if (world.terrain.live >= difficultyTerrainCap(world)) return;   // ㊿-w 난이도가 «몇 개까지»를 정한다
  const r = tr.radiusPx;
  place(world, nextKind(world, st), a.x + r + world.rng.terrain.f() * (a.w - 2 * r), world.data.rules.view.spawnLineY - r);
}

/**
 * §8.22(v1.10 ⑧) 보스 등장 무리 — 쓸어내기가 끝난 자리에 bossEntryCount 개를 아레나 «전체»에 무작위로 놓는다
 *   (위에서 흘러오는 게 아니라 이미 놓여 있다 — 「보스가 등장하며 화면을 뒤집고 장판이 랜덤하게 생긴다」).
 *   플레이어 바로 위엔 놓지 않는다(반지름 + 40px 안이면 최대 4번 다시 뽑는다 — 시도 수가 고정이라 결정적).
 *   그 뒤 평소 주기는 everySec 뒤부터. finale(`mixed`)은 3종이 하나씩 — 슬로우·관성·과열이 한 화면에 같이 놓인다.
 */
export function terrainBurst(world) {
  const run = world.run;
  const tr = world.data.rules.terrain;
  const a = world.data.rules.view.arena;
  const st = stageOf(world);
  run.terrainNextT = world.time + tr.everySec;
  if (st.terrainKind === null) return 0;
  const r = tr.radiusPx;
  const p = world.player;
  let placed = 0;
  for (let n = 0; n < tr.bossEntryCount; n += 1) {
    let x = 0; let y = 0;
    for (let tries = 0; tries < 5; tries += 1) {
      x = a.x + r + world.rng.terrain.f() * (a.w - 2 * r);
      y = a.y + r + world.rng.terrain.f() * (a.h - 2 * r);
      const dx = x - p.x; const dy = y - p.y;
      if (dx * dx + dy * dy > (r + 40) * (r + 40)) break;
    }
    if (place(world, nextKind(world, st), x, y) !== null) placed += 1;
  }
  return placed;
}

/** §8.21 ④ 위기 시작 — 무대의 지형이 fadeSec 동안 줄어들며 사라진다. 효과는 이 순간 꺼진다(terrainUnder 가 무시). */
export function fadeTerrain(world) {
  const it = world.terrain.items;
  for (let i = 0; i < it.length; i += 1) if (it[i].alive && it[i].fadeT < 0) it[i].fadeT = 0;
}

/** 점 (x, y) 가 어느 지형 안인가 — kind 인덱스 또는 -1. 사라지는 중(fadeT ≥ 0)은 없는 것. 겹치면 «먼저 스폰된 것». 0 alloc. */
export function terrainUnder(world, x, y) {
  const it = world.terrain.items;
  for (let i = 0; i < it.length; i += 1) {
    const t = it[i];
    if (!t.alive || t.fadeT >= 0) continue;
    const dx = x - t.x; const dy = y - t.y;
    if (dx * dx + dy * dy <= t.radius * t.radius) return t.kind;
  }
  return -1;
}

/** 스테이지 전이·런 시작에서 무대를 비운다(이전 테마의 지형이 다음 테마로 넘어가지 않는다). */
export function clearTerrain(world) {
  const it = world.terrain.items;
  for (let i = 0; i < it.length; i += 1) if (it[i].alive) world.terrain.release(it[i]);
  world.run.terrainNextT = 0;
  world.run.terrainBagN = 0;                                    // finale 가방은 스테이지마다 새로 섞는다
  world.player.heat = 0;
}
