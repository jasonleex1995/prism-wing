/**
 * src/core/tutorial.js — 튜토리얼 (§6.7, v1.10 ㊴ 신설 · ㊻ 6스텝 재작성)
 *
 * ★ 사용자(2026-09-05): 「게임이 익숙하지 않은 사람들이 게임과 키에 익숙할 수 있게 튜토리얼 스테이지를 구성하려고 해.
 *   적을 되게 쉽게 구성해서 한번 체험할 수 있게.」 — **읽는 설명이 아니라 «해 보는» 순서**다.
 * ★ ㊻(2026-09-06) 사용자 재작성: 6스텝 · 문장도 사용자가 준 그대로. 스텝끼리 «이어진다» —
 *   ② 에서 잡은 적이 남긴 경험치를 ③ 에서 먹고, ④ 는 그 사이 고른 카드를 **초기화**해 속성만 보이게 한다.
 *
 * 구조 — 스텝 목록은 `data/tutorial.json` 이 소유한다(§9.2 매니페스트 11번째 파일). 이 모듈은 «규칙»만 갖는다:
 *   ① 스텝에 들어가면 그 스텝의 판을 짠다 — 잔여 적 정리 · (reset 이면) 빌드 초기화 · grant · spawn
 *   ② 매 틱 목표(goal)를 재고, 충족되면 다음 스텝으로 — 목표 어휘는 닫혀 있다(GOALS, schema·check 가 강제)
 *   ③ **막히지 않는다** — 표적이 떨어지면 다시 놓고, 경험치가 없으면 다시 뿌린다
 *   ④ **죽지 않는다** — HP 가 safeHpFloor 아래로 내려가면 가득 채운다
 *
 * ★ 스테이지 디렉터(stage.tickRun)를 쓰지 않는다 — 페이즈·웨이브·보스 스폰이 전부 스테이지의 규칙이기 때문이다.
 *   그 자리에 이 함수가 `hooks.run` 으로 들어간다(같은 계약: (world, dt), 고정 틱). 적 이동·적 사격·충돌·드래프트는
 *   전부 평소의 step 이 그대로 처리한다 — «튜토리얼 전용 게임»이 아니라 같은 게임의 얇은 진행자다.
 */

import { spawnEnemy, spawnBossCore, spawnBossPart, spawnPickup, giveWeapon, givePassive, recomputeStats } from './state.js';
import { terrainUnder } from './terrain.js';
import { investElement } from './stance.js';
import { TERRAIN_KINDS } from './schema.mjs';

/** §6.7 — 목표 어휘(닫힘). schema.mjs · check.mjs 가 같은 목록을 갖는다(독립 사본). */
export const GOALS = ['move', 'clear', 'level', 'superHit', 'terrain', 'boss'];

const REFILL_SEC = 1.5;      // 표적·경험치가 다 떨어지고 이만큼 지나면 다시 놓는다(구조 상수 — 밸런스 값 아님)
const XP_REFILL = 3;         // 재보급 구슬 수

export function makeTutorialState() {
  return {
    i: 0,                 // 현재 스텝
    t: 0,                 // 그 스텝에 머문 게임초
    entered: false,       // 이 스텝의 판을 이미 짰는가
    movedPx: 0,           // move 목표 누적
    lastX: 0, lastY: 0,
    superEls: [],         // superHit 목표 — ×2 를 «맞은 적의 속성» 집합(불·물·풀 셋을 다 치려면 스탠스를 돌려야 한다)
    superFlag: [],        // 개체마다 «이미 셌는가» 래치(죽어도 셈이 되돌아가지 않는다)
    kinds: [],            // terrain 목표 — **머물러 본** 지형 종(㊿-z5: 밟기 → 머물기)
    dwellT: [],           // 지형 종마다 누적으로 머문 게임초 — terrainDwellSec 를 넘겨야 kinds 에 든다
    ids: [],              // 이 스텝이 놓은 개체(idx, gen)
    refillT: 0,
    doneT: 0,             // 마지막 스텝을 끝낸 뒤의 «완료» 표시 시간
    done: false,          // 전 스텝 완료 + 완료 표시까지 끝
  };
}

/** 현재 스텝 정의 (없으면 null = 끝) */
export function tutorialStep(world) {
  const steps = world.data.tutorial.steps;
  const tu = world.tut;
  return tu.i < steps.length ? steps[tu.i] : null;
}

/** 스텝의 적을 놓는다. 아레나 가운데 기준 좌우 대칭 · 난수 0(§10.2 — 튜토리얼은 매번 같아야 배울 수 있다). */
function spawnStepEnemies(world, st) {
  const tu = world.tut;
  const cfg = world.data.tutorial;
  const a = world.data.rules.view.arena;
  const arch = world.data.enemies.archetypes;
  let total = 0;
  for (let k = 0; k < st.spawn.length; k += 1) total += st.spawn[k].count;
  let n = 0;
  for (let k = 0; k < st.spawn.length; k += 1) {
    const sp = st.spawn[k];
    let def = null;
    for (let i = 0; i < arch.length; i += 1) if (arch[i].id === sp.archetypeId) { def = arch[i]; break; }
    if (def === null) throw new Error(`tutorial: 미지의 아키타입 "${sp.archetypeId}" (§6.7)`);
    for (let m = 0; m < sp.count; m += 1) {
      const x = a.x + a.w / 2 + (n - (total - 1) / 2) * cfg.spawnGapPx;
      const e = spawnEnemy(world, def.id, sp.element, x, cfg.spawnYPx, Math.max(1, def.hp * cfg.hpMul), false);
      if (e !== null) { e.vy = 0; e.vx = 0; tu.ids.push(e.idx, e.gen); tu.superFlag.push(false); }
      n += 1;
    }
  }
}

/** ㊻ 보스 스텝 — 코어 1 + 모듈 2. **층이 다르다**: 모듈 A(열림) → 모듈 B(보호막) → 코어. §8.11 의 sealLayer 규칙 그대로. */
function spawnStepBoss(world) {
  const tu = world.tut;
  const cfg = world.data.tutorial;
  const a = world.data.rules.view.arena;
  const b = world.data.bosses.bosses.find((x) => x.tier === 'stage');
  if (b === undefined) throw new Error('tutorial: tier "stage" 보스가 없다 (§6.7)');
  const cx = a.x + a.w / 2;
  const cy = cfg.spawnYPx + 40;
  const core = spawnBossCore(world, b.id, b.core, b.core.hp * cfg.hpMul * 0.25, cx, cy);
  if (core !== null) { core.sealedNow = true; tu.ids.push(core.idx, core.gen); tu.superFlag.push(false); }
  const mods = b.parts.filter((p) => p.partType === 'armament').slice(0, 2);
  for (let k = 0; k < mods.length; k += 1) {
    const p = spawnBossPart(world, b.id, mods[k], mods[k].hp * cfg.hpMul * 0.25, cx, cy);
    if (p !== null) {
      p.sealLayer = k + 1;                 // 1 = 먼저 부술 것, 2 = 그때까지 보호막
      p.sealedNow = k > 0;
      tu.ids.push(p.idx, p.gen); tu.superFlag.push(false);
    }
  }
}

/** ㊻ 지형 스텝 — 세 종을 한 번에 놓는다(늪 둔화 · 빙원 미끄러움 · 화산 과열). «다양하게 체험»이 목표다. */
function placeStepTerrain(world) {
  const a = world.data.rules.view.arena;
  const p = world.player;
  const r = world.data.rules.terrain.radiusPx;
  for (let k = 0; k < TERRAIN_KINDS.length; k += 1) {
    const t = world.terrain.alloc();
    if (t === null) return;
    t.kind = k;
    t.radius = r;
    t.x = a.x + a.w * (k + 1) / (TERRAIN_KINDS.length + 1);
    t.y = p.y - 150;
    t.fadeT = -1;
  }
}

/** ㊻ 빌드 초기화 — ③ 에서 고른 카드가 ④ 의 «속성이 보인다»를 흐린다(사용자). 시작 무기 하나만 남긴다. */
function resetLoadout(world) {
  for (let i = 0; i < world.slots.length; i += 1) {
    const s = world.slots[i];
    s.weaponId = null; s.family = null; s.level = 0; s.evolved = false;
    s.cooldownT = 0; s.a0 = 0; s.a1 = 0; s.a2 = 0; s.a3 = 0; s.effDirty = true;
  }
  for (let i = 0; i < world.passives.length; i += 1) { world.passives[i].id = null; world.passives[i].level = 0; }
  //   ★ ㊿-z7 — 슬롯을 비우면 «그 슬롯이 낳은 것»이 주인을 잃는다. 날아가던 탄은 맞는 순간 b.slot 으로 자기 무기를
  //   되묻고(step.applyHit 의 familyDmgMul), 비운 슬롯의 family 는 null 이라 passiveHooks[null] 에서 통째로 죽는다 —
  //   사용자 제보(2026-09-12) 「튜토리얼을 실행하는데 에러가 떴어 — Cannot read properties of undefined (reading 'dmgStat')」.
  //   드론도 family 로 계속 쏜다: 남겨 두면 «없는 무기»가 일한다. 그래서 초기화는 낳은 것까지 거둔다.
  for (const b of world.playerBullets.items) if (b.alive) world.playerBullets.release(b);
  for (const dr of world.drones.items) if (dr.alive) world.drones.release(dr);
  //   ★ ㊿-z8 — 예고(telegraph)도 무기가 낳는다. step.hazards 는 **'laser'(적 빔)만** 소유하고
  //   나머지 kind 는 «만든 무기»가 수명·반납을 쥔다. 바라지의 'strike'·'barrageHit' 가 그것이라,
  //   슬롯을 비우면 거둘 사람이 사라져 화면에 점선 원이 영구히 박히고 캡 한 칸을 영영 먹는다.
  //   더 나쁜 것: 나중에 바라지를 다시 집으면 그 낡은 예고가 예고 시간을 한 번도 안 타고 «즉발»한다(검토 재현).
  for (const tg of world.telegraphs.items) if (tg.alive && tg.kind !== 'laser') world.telegraphs.release(tg);
  recomputeStats(world);
  const i = giveWeapon(world, world.data.tutorial.startWeaponId);
  // §11.1 ㉚ — 시작 무기의 짝 패시브 Lv1 은 «새 판»의 일부다(createWorld 와 같은 규칙). 초기화가 그 규칙까지 지운다면 초기화가 아니다.
  if (i >= 0) givePassive(world, world.weaponDefs[world.slots[i].family].evolution.requiresPassive.id);
  world.draftQueue = 0;
}

function enterStep(world) {
  const tu = world.tut;
  const st = tutorialStep(world);
  tu.entered = true;
  tu.t = 0; tu.refillT = 0;
  tu.ids.length = 0; tu.superFlag.length = 0; tu.kinds.length = 0; tu.superEls.length = 0;
  tu.dwellT.length = 0;
  for (let k = 0; k < TERRAIN_KINDS.length; k += 1) tu.dwellT.push(0);
  tu.movedPx = 0; tu.lastX = world.player.x; tu.lastY = world.player.y;
  if (st === null) return;

  // 스텝은 «깨끗한 판»에서 시작한다 — 앞 스텝의 적·탄·지형이 다음 가르침을 흐린다. (경험치 구슬은 ③ 이 쓰므로 남긴다)
  for (const e of world.enemies.items) if (e.alive) world.enemies.release(e);
  for (const b of world.enemyBullets.items) if (b.alive) world.enemyBullets.release(b);
  for (const t of world.terrain.items) if (t.alive) world.terrain.release(t);

  if (st.reset) resetLoadout(world);
  // grant — 속성 투자. ★ investElement 로만 준다(그 함수만이 §4.3 각인 재계산을 부른다).
  //   ㊻ 세 속성에 1씩 — 투자가 없는 속성으로 스탠스를 바꾸면 각인이 «무속성»이라 ×2 가 나오지 않는다(실측). 「바꿔서 공격」의 전제다.
  if (st.grant !== null) for (let k = 0; k < st.grant.invest.length; k += 1) investElement(world, st.grant.invest[k]);

  spawnStepEnemies(world, st);
  if (st.goal.kind === 'boss') spawnStepBoss(world);
  if (st.goal.kind === 'terrain') placeStepTerrain(world);
}

/** 이 스텝이 놓은 개체 중 살아 있는 수 (idx·gen 쌍 — 풀 재사용에 속지 않는다) */
function aliveOfStep(world) {
  const tu = world.tut;
  const items = world.enemies.items;
  let n = 0;
  for (let k = 0; k < tu.ids.length; k += 2) {
    const e = items[tu.ids[k]];
    if (e.alive && e.gen === tu.ids[k + 1]) n += 1;
  }
  return n;
}

function coreOfStep(world) {
  const tu = world.tut;
  const items = world.enemies.items;
  for (let k = 0; k < tu.ids.length; k += 2) {
    const e = items[tu.ids[k]];
    if (e.alive && e.gen === tu.ids[k + 1] && e.isCore) return e;
  }
  return null;
}

function goalMet(world, st) {
  const tu = world.tut;
  switch (st.goal.kind) {
    case 'move': return tu.movedPx >= st.goal.value;
    case 'clear': return aliveOfStep(world) === 0;
    case 'level': return world.player.level >= st.goal.value;
    case 'superHit': return tu.superEls.length >= st.goal.value;
    case 'terrain': return tu.kinds.length >= st.goal.value;
    case 'boss': return coreOfStep(world) === null && tu.ids.length > 0;
    default: throw new Error(`tutorial: 미지의 목표 "${st.goal.kind}" (§6.7)`);
  }
}

/** ㊻ 「경험치를 아직 먹지 않는다」 — pickup:false 인 스텝에서는 자석을 끄고 구슬을 자석 반경 밖으로 밀어 둔다. */
function parkPickups(world) {
  const p = world.player;
  const rp = world.data.rules.player;
  const mag = rp.magnetRadius * (1 + world.stats.areaMul) + 8;
  for (const q of world.pickups.items) {
    if (!q.alive) continue;
    q.magnet = false;
    const dx = q.x - p.x; const dy = q.y - p.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < mag) {
      const ux = d > 0 ? dx / d : 0;
      const uy = d > 0 ? dy / d : -1;
      q.x = p.x + ux * mag;
      q.y = p.y + uy * mag;
    }
  }
}

/** ★ 훅 진입점 — step 이 매 고정 틱 부른다(hooks.run 자리). 스테이지 디렉터의 자리를 대신한다. */
export function tickTutorial(world, dt) {
  const tu = world.tut;
  if (tu.done) return;
  const cfg = world.data.tutorial;
  const p = world.player;

  if (!tu.entered) enterStep(world);
  const st = tutorialStep(world);
  if (st === null) {                                   // 전 스텝 통과 — 잠깐 «완료»를 보여주고 끝낸다
    tu.doneT += dt;
    if (tu.doneT >= cfg.completeHoldSec) tu.done = true;
    return;
  }
  tu.t += dt;

  // 튜토리얼에서는 죽지 않는다 — 연습에 사망은 없다.
  if (p.hp <= p.hpMax * cfg.safeHpFloor) p.hp = p.hpMax;
  world.over = false;

  if (!st.pickup) parkPickups(world);

  // 목표 누적 — 이동 거리 · ×2 히트(개체별 래치) · 지형 종
  tu.movedPx += Math.abs(p.x - tu.lastX) + Math.abs(p.y - tu.lastY);
  tu.lastX = p.x; tu.lastY = p.y;
  {
    const items = world.enemies.items;
    for (let k = 0; k < tu.ids.length; k += 2) {
      const f = k >> 1;
      if (tu.superFlag[f]) continue;
      const e = items[tu.ids[k]];
      if (e.gen === tu.ids[k + 1] && e.dmgSuper > 0) {
        tu.superFlag[f] = true;
        if (tu.superEls.indexOf(e.element) < 0) tu.superEls.push(e.element);   // ㊻ «속성을 바꿔서» = 서로 다른 속성에 ×2
      }
    }
  }
  // ㊿-z5 사용자(2026-09-12) 「지형 효과를 다 체험하기도 전에 다음 단계로 끝나」 —
  //   스쳐 지나가기만 해도 세던 것을 **머문 시간**으로 바꾼다. 감속 · 관성 · 열은 «들어간 순간»이 아니라
  //   «있는 동안»에 드러나므로, terrainDwellSec 을 채운 종만 목표로 센다.
  //   ★ 「없음」의 센티널은 -1 이다(terrain.terrainUnder · step.js 도 -1 로 읽는다) — null 로 비교하면
  //   지형 «밖»에서도 매 틱 이 가지가 통과해 dwellT[-1] 이 NaN 이 된다(㊿-z8 검토에서 잡혔다).
  const kind = terrainUnder(world, p.x, p.y);
  if (kind >= 0) {
    tu.dwellT[kind] += dt;
    if (tu.dwellT[kind] >= cfg.terrainDwellSec && tu.kinds.indexOf(kind) < 0) tu.kinds.push(kind);
  }

  // 코어 봉인 — §8.13 하드 게이트와 같은 규칙(모듈이 하나라도 살아 있으면 코어 무적) + §8.11 층 봉인(낮은 층이 살아 있으면 위층은 무적)
  const core = coreOfStep(world);
  if (core !== null) {
    const items = world.enemies.items;
    let mods = 0;
    let minLayer = Infinity;
    for (let k = 0; k < tu.ids.length; k += 2) {
      const e = items[tu.ids[k]];
      if (!e.alive || e.gen !== tu.ids[k + 1] || !e.isBoss || e.isCore) continue;
      mods += 1;
      if (e.sealLayer < minLayer) minLayer = e.sealLayer;
    }
    for (let k = 0; k < tu.ids.length; k += 2) {
      const e = items[tu.ids[k]];
      if (!e.alive || e.gen !== tu.ids[k + 1] || !e.isBoss || e.isCore) continue;
      e.sealedNow = e.sealLayer > minLayer;
    }
    core.sealedNow = mods > 0;
  }

  // ★ 막히지 않는다 — 표적이 필요한 스텝인데 다 죽었거나, 경험치가 필요한데 하나도 없으면 다시 놓아 준다.
  const needTargets = st.spawn.length > 0 && st.goal.kind !== 'clear' && aliveOfStep(world) === 0;
  const needXp = st.goal.kind === 'level' && world.pickups.live === 0;
  if (needTargets || needXp) {
    tu.refillT += dt;
    if (tu.refillT >= REFILL_SEC) {
      tu.refillT = 0;
      if (needTargets) spawnStepEnemies(world, st);
      if (needXp) {
        const a = world.data.rules.view.arena;
        for (let k = 0; k < XP_REFILL; k += 1) {
          spawnPickup(world, 'xp', 4, a.x + a.w * (k + 1) / (XP_REFILL + 1), cfg.spawnYPx);
        }
      }
    }
  } else tu.refillT = 0;

  // ㊿-z5 사용자 「경험치 관련 설명을 읽기도 전에 끝난달까나?」 —
  //   목표를 일찍 채워도 minSec 만큼은 머문다. 안내가 읽히지 않으면 안내가 아니다.
  if (goalMet(world, st) && tu.t >= st.minSec) {
    tu.i += 1;
    tu.entered = false;
  }
}
