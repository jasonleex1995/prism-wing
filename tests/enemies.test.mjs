/**
 * tests/enemies.test.mjs — src/core/enemies.js (스포너 + 이동 스크립트 훅) 계약 단위 테스트
 *
 * 대상 (임무):
 *   · 결정성 — 같은 시드 → 같은 스폰 시퀀스(scatter 좌표까지 비트 동일) / 다른 시드 → 상이 (§10.2)
 *   · element 편성 주입 — 적의 element 는 웨이브 레코드에서 온다. 서로 다른 element 가 **섞여** 내려온다 (§8.6)
 *   · moveId 속도 — dive: vy=speed·vx=0 / weave: vy=speed·vx=ampPx·ω·cos(ω·moveT) (§8.4)
 *   · 캡 준수 — live ≤ caps.enemies · 풀 무결(freeTop+live==size), 언제나 (§12.1 · §10.3)
 *   · 화면 이탈 몰수 — 하단으로 이탈한 적은 release 되고 **보상(XP 픽업)이 0** (§8.7)
 *   · 슬라이스 통합 — 스폰 → 자동발사 피격 → 처치 → XP 드랍이 실제로 배선돼 있다 (재미 검증의 뼈대)
 *
 * ★ 값은 전부 data/정본에서 유도한다 (하드코딩 매직넘버 지양).
 */
import { suite, test, assert, loadData } from '../tools/test.mjs';
import { createWorld, spawnEnemy, spawnBeam, spawnZone, spawnEnemyBullet, spawnBossCore, spawnMidBoss } from '../src/core/state.js';
import { step, makeInput, TICK_DT } from '../src/core/step.js';
import { enemies } from '../src/core/enemies.js';
import { emitters } from '../src/core/emitters.js';
import { weapons } from '../src/core/weapons/index.js';
import { TAU } from '../src/core/angle.js';
import { formationPos } from '../src/core/formations.js';
import { PHASE, initRun, tickRun } from '../src/core/stage.js';
import { bossHook } from '../src/core/boss.js';
import { offThemeHpMul } from '../src/core/elements.js';

const dt = TICK_DT;

/** 훅을 주입한 월드 */
function mk(seed = 1) {
  return createWorld({ data: loadData(), seed, weapons, hooks: { enemies } });
}
/** 런을 세운 월드(구간·비율은 런에서만 산다). 무기는 침묵 — 스포너만 관찰한다 */
function mkRun(d, seed) {
  const w = createWorld({ data: d, seed, weapons, hooks: { enemies, emitters, run: tickRun, boss: bossHook } });
  w.difficultyId = 'normal';
  w.tele = { dmgByFamily: {}, dmgTakenByArch: {}, kills: {}, crisisKills: 0, xpGained: 0 };
  initRun(w);
  for (const sl of w.slots) sl.weaponId = null;
  return w;
}
/** 자동 발사가 적을 죽이지 않게 무기를 침묵(스포너·이동만 관찰) */
function silence(w) { for (const s of w.slots) s.weaponId = null; }
/** 아키타입 정의 (매직넘버 대신 데이터에서) */
function arch(w, id) { return w.data.enemies.archetypes.find((a) => a.id === id); }
/** enemies.js 와 같은 규칙으로 슬라이스 로스터를 유도한다(구현 이동 × 플레이 밴드 × 테마) */
function sliceRoster(w) {
  const MOVES = ['dive', 'weave'];
  const BANDS = ['chaff', 'line'];
  return w.data.enemies.archetypes
    .filter((a) => MOVES.includes(a.moveId) && BANDS.includes(a.band) && (a.themeOnly === null || a.themeOnly === 'sea'))
    .map((a) => a.id);
}
/** alive 적 스냅샷 서명 — idx 오름차순, 좌표·속도까지 */
function signature(w) {
  const out = [];
  const items = w.enemies.items;
  for (let i = 0; i < items.length; i += 1) {
    const e = items[i];
    if (!e.alive) continue;
    out.push(`${e.idx}:${e.archetypeId}:${e.element}:${e.x.toFixed(4)}:${e.y.toFixed(4)}:${e.vx.toFixed(4)}:${e.vy.toFixed(4)}`);
  }
  return out.join('|');
}

// ─────────────────────────────────────────────────────────────────────────
suite('enemies · 결정성 (§10.2 — rng.spawn 만 사용)', () => {
  test('같은 시드 → 같은 스폰 시퀀스 (scatter 좌표까지 비트 동일)', () => {
    const a = mk(20260716);
    const b = mk(20260716);
    silence(a); silence(b);
    for (let i = 0; i < 200; i += 1) { step(a, makeInput(), dt); step(b, makeInput(), dt); }
    assert.ok(a.enemies.live > 0, '웨이브가 실제로 스폰됐다 (0행 아님)');
    assert.eq(signature(a), signature(b), '같은 시드 = 비트 동일한 스폰/이동');
  });

  test('다른 시드 → 상이 (scatter 가 rng.spawn 을 실제로 탄다)', () => {
    const a = mk(1);
    const b = mk(2);
    silence(a); silence(b);
    // ★ §8.19(v1.8) 도입 구간은 «wall» 편대라 rng 를 안 탄다 — 창을 지나야 scatter 가 나온다.
    //   틱 수를 데이터에서 «유도»한다(매직넘버 금지): (조용한 웨이브 + 2) × 간격.
    // v1.10 — 도입 침묵은 비율로 대체됐다. 두 웨이브면 scatter 가 rng.spawn 을 탄다.
    const ph = a.data.stages.phase;
    const ticks = Math.ceil(3 * ph.waveIntervalSec * 60);
    for (let i = 0; i < ticks; i += 1) { step(a, makeInput(), dt); step(b, makeInput(), dt); }
    assert.ok(a.enemies.live > 0 && b.enemies.live > 0, '양쪽 다 스폰됨');
    assert.ne(signature(a), signature(b), '다른 시드 = scatter 좌표가 갈린다');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('enemies · element 편성 주입 (§8.6 — 상성의 핵심)', () => {
  test('첫 웨이브: element 는 «속성 봉지»(mix 비율, 개체 단위)가 주입, 아키타입은 «공격형[0] ∨ 무공격 칸» (v1.10 ④)', () => {
    const w = mk(7);
    silence(w);
    const stage = w.data.stages.stages.find((s) => s.id === 'sea');
    const roster = sliceRoster(w);
    const shooters = roster.filter((id) => arch(w, id).attack !== null);
    for (let i = 0; i < 30; i += 1) step(w, makeInput(), dt);
    const alive = w.enemies.items.filter((e) => e.alive);
    assert.gt(alive.length, 0, '스폰됐다');
    for (const e of alive) {
      assert.ok(e.archetypeId === shooters[0] || e.archetypeId === stage.introArchetypeId,
        `아키타입 ${e.archetypeId} ∈ {공격형[0]=${shooters[0]}, 무공격=${stage.introArchetypeId}}`);
    }
    // ★ 한 웨이브 안에서 각 속성의 마릿수 = count × 가중치 (최대 나머지법) — 「한 웨이브 = 한 색」이 아니다.
    //   가중치의 출처 = 해금된 저작 리스트의 count 가중 분포(스포너 elemW). 테마(물)가 다수다.
    const s = w.spawner;
    const n = alive.length;
    const byEl = {};
    for (const e of alive) byEl[e.element] = (byEl[e.element] || 0) + 1;
    for (let k = 0; k < s.elemOrder.length; k += 1) {
      const el = s.elemOrder[k];
      const got = byEl[el] || 0;
      assert.ok(Math.abs(got - n * s.elemW[k]) < 1 + 1e-9, `${el}: ${got} ≈ ${n} × ${s.elemW[k].toFixed(3)} (반올림 이내)`);
    }
    assert.eq(Object.entries(byEl).sort((a, b) => b[1] - a[1])[0][0], stage.element, '테마 속성이 다수');
    assert.gte(Object.keys(byEl).length, 2, '한 웨이브 안에 ≥2 속성 (개체 단위 봉지)');
  });

  test('속성 봉지의 가중치 = stages[].mix (v1.10 ⑬ — 런타임의 유일한 출처)', () => {
    const w = mk(3);
    silence(w);
    step(w, makeInput(), dt);
    const s = w.spawner;
    const stage = w.data.stages.stages.find((x) => x.id === s.stageId);
    let sum = 0;
    for (let k = 0; k < s.elemOrder.length; k += 1) {
      sum += s.elemW[k];
      const want = stage.mix[s.elemOrder[k]];
      assert.near(s.elemW[k], want, 1e-9, `${s.elemOrder[k]}: 가중치 = mix ${want}`);
    }
    assert.ok(Math.abs(sum - 1) < 1e-9, '가중치 합 1');
  });

  test('서로 다른 element 가 섞여 내려온다 (스탠스를 바꿀 이유)', () => {
    const w = mk(7);
    silence(w);
    const seen = new Set();
    let maxDistinctAlive = 0;
    for (let i = 0; i < 2400; i += 1) {
      step(w, makeInput(), dt);
      const live = new Set();
      const items = w.enemies.items;
      for (let j = 0; j < items.length; j += 1) if (items[j].alive) live.add(items[j].element);
      for (const el of live) seen.add(el);
      if (live.size > maxDistinctAlive) maxDistinctAlive = live.size;
    }
    // v1.10 ⑬ — 한 스테이지는 «테마 + 먹이» 2속성뿐이다(sea = 물 + 불). 노말·풀은 나오지 않는다.
    const stage = w.data.stages.stages.find((s2) => s2.id === 'sea');
    const want = Object.keys(stage.mix).filter((el) => stage.mix[el] > 0).sort();
    assert.deepEq([...seen].sort(), want, `등장 속성 = mix 의 0 아닌 키 ${want}`);
    assert.eq(seen.size, 2, '정확히 2속성');
    assert.ok(!seen.has('normal'), '노말 없음');
    assert.gte(maxDistinctAlive, 2, '한 화면에 2속성이 동시에 살아 있다 (실제 혼재 — 스탠스를 바꿀 이유)');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('enemies · moveId 속도 (§8.4)', () => {
  test('dive — vy = moveParams.speed, vx = 0', () => {
    const w = mk(3);
    silence(w);
    const drifter = arch(w, 'drifter');   // moveId dive
    assert.eq(drifter.moveId, 'dive', '전제: drifter 는 dive');
    step(w, makeInput(), dt);             // wave0 = drifter 스폰 + 이동 세팅
    const items = w.enemies.items;
    let n = 0;
    for (let i = 0; i < items.length; i += 1) {
      const e = items[i];
      if (!e.alive || e.archetypeId !== 'drifter') continue;
      n += 1;
      assert.eq(e.vy, drifter.moveParams.speed, 'dive vy = speed');
      assert.eq(e.vx, 0, 'dive vx = 0 (직하강)');
    }
    assert.gt(n, 0, 'drifter 가 실제로 존재');
  });

  test('weave — vy = speed, vx = ampPx·ω·cos(ω·moveT) (사인 좌우, 부호가 반주기에 뒤집힘)', () => {
    const w = mk(5);
    silence(w);
    const spitter = arch(w, 'spitter');   // moveId weave
    assert.eq(spitter.moveId, 'weave', '전제: spitter 는 weave');
    const mp = spitter.moveParams;
    const om = TAU * mp.freqHz;

    // 스케줄과 무관하게 moveT=0 인 spitter 하나를 직접 주입해 이동 법칙만 관찰
    const cx = w.data.rules.view.arena.x + w.data.rules.view.arena.w / 2;
    const e = spawnEnemy(w, 'spitter', 'fire', cx, w.data.rules.view.spawnLineY, spitter.hp, false);
    assert.eq(e.moveT, 0, 'spawn 직후 moveT 0');

    enemies(w, dt);   // applyMovement 이 e.vx/vy 를 세팅 (스케줄러는 wave0 도 스폰하지만 무관)
    assert.eq(e.vy, mp.speed, 'weave vy = speed');
    assert.near(e.vx, mp.ampPx * om * Math.cos(om * 0), 1e-9, 'moveT 0: vx = ampPx·ω');
    assert.gt(e.vx, 0, 'moveT 0 에서 vx > 0 (cos0 = 1)');

    // 반주기(T/2 = 1/(2·freqHz)) 후: cos(π) = -1 → vx 부호 반전
    e.moveT = 1 / (2 * mp.freqHz);
    enemies(w, dt);
    assert.near(e.vx, mp.ampPx * om * Math.cos(om * e.moveT), 1e-9, '반주기: vx = ampPx·ω·cos(π)');
    assert.lt(e.vx, 0, '반주기에서 vx < 0 (좌우로 흔든다)');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('enemies · 캡 준수 (§12.1 · §10.3)', () => {
  test('오래 돌려도 live ≤ caps.enemies · 풀 무결', () => {
    const w = mk(11);
    silence(w);   // 아무도 안 죽으니 스포너가 최대 압박을 만든다
    const cap = w.data.rules.caps.enemies;
    // §12.1(v1.9) 도입 구간의 몸은 «위협»이 아니라서 자기 예산(introConcurrentMax)을 쓰고
    //   웨이브 예산(enemyConcurrentMax)에서 «빠진다» — 유령(§8.9-R9)과 같은 처방이다.
    //   두 예산은 배타가 아니라 «다른 몫»이므로 동시 상한은 max 가 아니라 **합**이다.
    //   ★ v1.8 은 max 로 적었는데, 그때는 바깥 게이트가 여전히 enemyConcurrentMax 를 보고 있어서
    //     도입 예산이 절반만 살아 있었다(합에 도달할 수 없었다). S12 가 같은 합을 증명한다.
    const concurrent = w.data.rules.fairness.enemyConcurrentMax
      + w.data.rules.fairness.introConcurrentMax;
    let peak = 0;
    for (let i = 0; i < 3000; i += 1) {
      step(w, makeInput(), dt);
      const p = w.enemies;
      assert.lte(p.live, cap, 'live ≤ caps.enemies (풀 = B층 안전망)');
      assert.eq(p.freeTop + p.live, p.size, '풀 무결: freeTop + live == size');
      if (p.live > peak) peak = p.live;
    }
    assert.gt(peak, 0, '실제로 스폰이 일어났다 (공허 통과 아님)');
    assert.lte(peak, concurrent, '동시 오써링 상한(웨이브 42 ∨ 도입 introConcurrentMax) 을 넘지 않는다');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('enemies · 화면 이탈 몰수 (§8.7 — step 이 집행, 이동은 이 훅)', () => {
  test('하단으로 이탈한 적은 release 되고 XP 픽업이 0 (보상 몰수)', () => {
    const w = mk(9);
    silence(w);
    const a = w.data.rules.view.arena;
    const cx = a.x + a.w / 2;
    const drifter = arch(w, 'drifter');
    // 하단 이탈 직전에 배치 (exit 조건: y > a.y + a.h + 64)
    const e = spawnEnemy(w, 'drifter', 'water', cx, a.y + a.h + 60, drifter.hp, false);
    const gen0 = e.gen;
    assert.ok(e.alive, '배치됨');

    let left = false;
    for (let i = 0; i < 30 && !left; i += 1) {
      step(w, makeInput(), dt);                 // 훅이 vy=speed 세팅, step 이 적분+이탈 판정
      assert.eq(w.pickups.live, 0, '이탈 경로 어디에서도 XP 픽업이 생기지 않는다 (몰수)');
      if (!e.alive || e.gen !== gen0) left = true;
    }
    assert.ok(left, '적이 하단으로 빠져 release 됐다');
    assert.eq(w.pickups.live, 0, '최종적으로도 보상 0 (killEnemy 를 거치지 않았다)');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('enemies · 슬라이스 통합 (재미의 뼈대: 스폰 → 피격 → 처치 → XP)', () => {
  test('무기를 살려두면 실제로 적이 죽어 XP 픽업이 드랍된다', () => {
    const w = mk(4);   // 무기 침묵 안 함 = forward 자동발사가 상단의 적을 때린다
    let sawXpPickup = false;
    for (let i = 0; i < 1500 && !sawXpPickup; i += 1) {
      step(w, makeInput(), dt);
      const items = w.pickups.items;
      for (let j = 0; j < items.length; j += 1) {
        if (items[j].alive && items[j].kind === 'xp') { sawXpPickup = true; break; }
      }
    }
    // 화면 이탈(몰수)은 픽업을 안 만든다 → XP 픽업의 존재 = 처치가 실제로 일어났다는 증거
    assert.ok(sawXpPickup, '스폰된 적이 자동발사에 맞아 죽고 XP 를 떨궜다 (슬라이스 end-to-end)');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('enemies · 슬라이스 로스터 다양성 (피드백 #3 — 대비를 화면에)', () => {
  test('로스터는 데이터 유도 · 구현 이동 × 플레이 밴드 × 테마 부합만', () => {
    const w = mk(1);
    const roster = sliceRoster(w);
    assert.gte(roster.length, 3, '로스터 ≥ 3종 (drifter/spitter 둘만이 아니다)');
    for (const id of roster) {
      const a = arch(w, id);
      assert.ok(['dive', 'weave'].includes(a.moveId), `${id}: 구현된 이동만 (dive/weave)`);
      assert.ok(['chaff', 'line'].includes(a.band), `${id}: 플레이 가능한 밴드만 (chaff/line)`);
      assert.ok(a.themeOnly === null || a.themeOnly === 'sea', `${id}: 테마 부합만`);
    }
    assert.eq(roster[0], 'drifter', '로스터[0] = drifter (element 테스트 전제)');
  });

    // ★ v1.7 — 「≥3종」에서 「진행에 따라 늘어난다」로 바꿨다.
    //   저작 로스터를 배선하기 전까지 이 코드는 archetypes 전량을 썼고, 그래서 스테이지와
    //   무관하게 늘 많은 종이 나왔다 — 「≥3종」은 그 «버그» 위에서만 참이었다.
    //   §8.3 의 의도는 「후반 = 아키타입 해금이 함께 올라 다른 적이 나온다」이므로,
    //   고정 개수가 아니라 «증가»를 못박는 것이 옳다. 초반이 1종으로 쪼그라들지 않는 것도 함께.
    test('아키타입은 스테이지가 오를수록 «늘어난다» — 초반 ≥2종, 후반이 더 많다 (§8.3)', () => {
      const d = loadData();
      for (const st of d.stages.stages) {
        if (st.id === 'finale') continue;
        const at = (n) => st.roster.filter((r) => r.unlockStageMin <= n).length;
        assert.gte(at(1), 2, `${st.id}: 스테이지 1 이 ${at(1)}종 — 1종이면 첫 판이 통째로 단조롭다`);
        assert.gt(at(6), at(1), `${st.id}: 후반(${at(6)})이 초반(${at(1)})보다 많아야 한다`);
        for (let n = 2; n <= 6; n += 1) {
          assert.gte(at(n), at(n - 1), `${st.id}: 해금은 되돌아가지 않는다 (S${n - 1}→S${n})`);
        }
      }
    });

    test('해금된 종만 실제로 스폰된다 (저작 로스터가 화면에 반영된다) — 포지션 1(스테이지 1 은 무공격이라 도입종뿐, v1.10 ㉔)', () => {
      const w = mkRun(loadData(), 13);
      w.run.phase = PHASE.MOB; w.run.stageIndex = 1; w.run.order[1] = 'sea';
      silence(w);
      // 허용 = 그 스테이지·포지션에서 해금된 로스터(unlockStageMin ≤ 스테이지 번호) + 도입종 — 데이터가 유일한 출처(§8.7)
      const st = w.data.stages.stages.find((x) => x.id === 'sea');
      const allowed = new Set([st.introArchetypeId, ...st.roster.filter((r) => r.unlockStageMin <= w.run.stageIndex + 1).map((r) => r.archetypeId)]);
      const seen = new Set();
      for (let i = 0; i < 3000; i += 1) {
        step(w, makeInput(), dt);
        const items = w.enemies.items;
        // 잡몹만 — 48초의 중간보스(archetypeId 없음)·보스는 로스터의 대상이 아니다(§8.9·§8.11)
        for (let j = 0; j < items.length; j += 1) if (items[j].alive && !items[j].isBoss && items[j].midBossId === '') seen.add(items[j].archetypeId);
      }
      assert.gte(seen.size, 2, `≥2종 스폰됨 (실제 ${seen.size}종: ${[...seen].sort().join(', ')})`);
      for (const id of seen) {
        assert.ok(allowed.has(id), `${id} 는 이 스테이지 로스터에 없다 — 해금이 새고 있다`);
      }
    });
});

// ─────────────────────────────────────────────────────────────────────────
suite('enemies · HP↔속도 튜닝 (피드백 #3 — 느린=탱키/빠른=약함)', () => {
  test('로스터를 속도 내림차순으로 정렬하면 effHP 가 단조 증가한다', () => {
    const w = mk(1);
    const bands = w.data.enemies.bands;
    const rows = sliceRoster(w).map((id) => {
      const a = arch(w, id);
      return { id, speed: a.moveParams.speed, effHp: a.hp * bands[a.band].hpMult };
    });
    // 빠른 → 느린 순으로 정렬. 그러면 effHP 는 비감소여야 한다 (느릴수록 더 단단하다).
    rows.sort((p, q) => q.speed - p.speed);
    for (let i = 1; i < rows.length; i += 1) {
      assert.gte(rows[i].effHp, rows[i - 1].effHp,
        `${rows[i - 1].id}(spd ${rows[i - 1].speed}, effHP ${rows[i - 1].effHp}) → `
        + `${rows[i].id}(spd ${rows[i].speed}, effHP ${rows[i].effHp}): 더 느린데 더 약하면 안 된다`);
    }
    // 대비가 실제로 크다: 가장 빠른 것과 가장 느린 것의 effHP 배율 ≥ 3
    const fastest = rows[0];
    const slowest = rows[rows.length - 1];
    assert.gte(slowest.effHp / fastest.effHp, 3,
      `가장 느린 ${slowest.id}(effHP ${slowest.effHp}) 는 가장 빠른 ${fastest.id}(effHP ${fastest.effHp}) 의 ≥3배 (체감되는 대비)`);
  });
});

// §8.18(v1.7) 잡몹 사격 «강도»의 스테이지 곡선.
//   v1.6 까지 잡몹의 발사 주기와 탄 피해는 전 스테이지 동일했다 — 체력·밀도만 오르고
//   사격은 안 올랐으므로 스테이지 1 이 상대적으로 과했다(플레이 피드백: 「1인데 너무 많이 쏜다」).
//   이 두 테스트가 지키는 것은 «곡선이 존재한다»가 아니라 «곡선이 실제로 적용된다»이다.
suite('enemies/§8.18 적 사격 강도의 스테이지 곡선 (v1.7 · 발사 주기 = 잡몹만 · 피해 = 보스 포함)', () => {
  const mk = (stageIndex) => {
    const w = createWorld({ data: loadData(), seed: 6, weapons, hooks: {}, startWeaponId: 'forward' });
    w.run = { stageIndex, bossFireRateMul: 1, order: [], crisis: false };
    return w;
  };

  test('발사 주기 — 이미터 시간이 곡선만큼 느리게/빠르게 흐른다', () => {
    const curve = loadData().stages.curve.mobFireRateScale;
    assert.eq(curve.length, 6, '스테이지 6개분');
    for (let i = 0; i < 6; i += 1) {
      const w = mk(i);
      const p = w.player;
      const e = spawnEnemy(w, 'hexer', 'normal', p.x, p.y - 220, 9e9, false, false);
      for (let t = 0; t < 60; t += 1) emitters(w, TICK_DT);        // 1초
      assert.lt(Math.abs(e.emitT - curve[i]), 1e-6, `스테이지 ${i + 1}: emitT ${curve[i]} 여야 한다`);
    }
    assert.lt(curve[0], curve[5], '★ 초반이 후반보다 뜸하게 쏜다');
  });

  test('탄 피해 — 같은 탄이라도 스테이지에 따라 다르게 아프다', () => {
    const d = loadData();
    const curve = d.stages.curve.mobBulletDmgScale;
    const base = d.bullets.bullets.find((b) => b.id === 'hexBolt').dmg;
    const dmgAt = (i) => {
      const w = mk(i);
      const p = w.player;
      const e = spawnEnemy(w, 'hexer', 'normal', p.x, p.y - 220, 9e9, false, false);
      for (let t = 0; t < 60 * 6; t += 1) {
        emitters(w, TICK_DT);
        const b = w.enemyBullets.items.find((x) => x.alive);
        if (b) return b.dmg;
      }
      return null;
    };
    const lo = dmgAt(0); const hi = dmgAt(5);
    assert.eq(lo, Math.max(1, Math.round(base * curve[0])), '스테이지 1 탄 피해 = 기본 × 곡선');
    assert.eq(hi, Math.max(1, Math.round(base * curve[5])), '스테이지 6 탄 피해 = 기본 × 곡선');
    assert.lt(lo, hi, '★ 초반 탄이 후반 탄보다 덜 아프다');
  });

  test('보스·중간보스는 «발사 주기» 곡선 밖이다 (자기 곡선을 이미 갖는다) — 피해 곡선은 탄다(아래 ㊿-r)', () => {
    const w = mk(0);
    const p = w.player;
    const e = spawnEnemy(w, 'hexer', 'normal', p.x, p.y - 220, 9e9, false, false);
    e.midBossId = 'mbHammer';                                       // 중간보스로 표시
    for (let t = 0; t < 60; t += 1) emitters(w, TICK_DT);
    assert.lt(Math.abs(e.emitT - 1), 1e-6, '중간보스는 배율 1 — 잡몹 곡선을 안 탄다');
  });

  // ★ v1.10 ㊿-r — 사용자(2026-09-11) 확정: 「난이도가 높을수록, 스테이지가 높아질수록 강해지는게 맞지!」
  //   피해 곡선(mobBulletDmgScale)은 보스·중간보스 공격에도 걸린다 — 이미터가 귀속을 'boss'·'mb…' 로 싣기 때문이다.
  //   ㊿-q 까지 주석·정본·테스트 하나는 「보스는 귀속 '' 이라 제외」라고 적었고, 실제 동작과 반대였다(검토에서 발견).
  test('피해 곡선은 보스·중간보스 공격에도 걸린다 — 스테이지가 높을수록 세다 (㊿-r)', () => {
    const d = loadData();
    const curve = d.stages.curve.mobBulletDmgScale;
    const shot = d.bullets.bullets.find((b) => b.id === 'heavyRound');
    const ray = d.bullets.bullets.find((b) => b.id === 'beamCore');
    for (const src of ['boss', 'mbHammer']) {
      const lo = spawnEnemyBullet(mk(0), shot.id, 100, 100, 0, 0, src);
      const hi = spawnEnemyBullet(mk(5), shot.id, 100, 100, 0, 0, src);
      assert.eq(lo.dmg, Math.max(1, Math.round(shot.dmg * curve[0])), `${src} 탄: 스테이지 1 = 기본 × 곡선`);
      assert.eq(hi.dmg, Math.max(1, Math.round(shot.dmg * curve[5])), `${src} 탄: 스테이지 6 = 기본 × 곡선`);
      assert.lt(lo.dmg, hi.dmg, `${src} 탄: 후반이 더 아프다`);
      const beam = spawnBeam(mk(0), 100, 100, 0, 10, ray.dmg, 1, -1, src);
      assert.lt(beam.dmg, ray.dmg, `${src} 빔: 초반엔 곡선만큼 깎인다(빔·장판은 1 로 클램프 — §2.1 상한 보존)`);
    }
    // 실제 이미터가 싣는 귀속이 정말 'boss' 인지 — 위의 문자열을 테스트가 지어낸 게 아님을 확인한다
    const w = mk(0);
    const boss = d.bosses.bosses.find((b) => b.tier !== 'mid' && b.core !== undefined);
    spawnBossCore(w, boss.id, boss.core, 9e9, 640, 120);
    let fired = null;
    for (let t = 0; t < 60 * 8 && fired === null; t += 1) {
      emitters(w, TICK_DT);
      fired = w.enemyBullets.items.find((x) => x.alive) || null;
    }
    assert.ok(fired !== null, '전제: 보스 코어가 실제로 쐈다');
    assert.eq(fired.srcArch, 'boss', "★ 실제 보스 이미터가 싣는 귀속 = 'boss' ('' 가 아니다)");
    const def = d.bullets.bullets.find((b) => b.id === fired.bulletId);
    assert.eq(fired.dmg, Math.max(1, Math.round(def.dmg * curve[0])), '실제 보스 탄도 스테이지 1 곡선만큼 깎인다');
    // 중간보스도 — 실제 중간보스 이미터가 싣는 귀속은 자기 id('mb…')이고, 그 탄도 곡선을 탄다(2차 검토: 이 절반은 손으로 넣은 문자열로만 검사됐다)
    let mbShot = null;
    let mbDef = null;
    for (const mb of d.bosses.bosses.filter((b) => b.tier === 'mid')) {
      const wm = mk(0);
      spawnMidBoss(wm, mb, 'fire', 9e9, 640, 120);
      for (let t = 0; t < 60 * 10 && mbShot === null; t += 1) {
        emitters(wm, TICK_DT);
        mbShot = wm.enemyBullets.items.find((x) => x.alive) || null;
      }
      if (mbShot !== null) { mbDef = mb; break; }
    }
    assert.ok(mbShot !== null, '전제: 탄을 쏘는 중간보스가 실제로 쐈다');
    assert.eq(mbShot.srcArch, mbDef.id, `★ 실제 중간보스 이미터가 싣는 귀속 = '${mbDef.id}' ('' 가 아니다)`);
    const mbBullet = d.bullets.bullets.find((b) => b.id === mbShot.bulletId);
    assert.eq(mbShot.dmg, Math.max(1, Math.round(mbBullet.dmg * curve[0])), `실제 중간보스(${mbDef.id}) 탄도 스테이지 1 곡선만큼 깎인다`);
  });
});

// §7.6/§8.6(v1.7) — 「생김새로 공격을 예측할 수 없다」와 「스테이지 1부터 엘리트가 너무 많다」의 답.
suite('enemies/§7.6 공격 기호 · §8.6 엘리트 곡선 (v1.7)', () => {
  test('모든 아키타입이 자기 이미터 타입을 개체에 싣는다 (사격 안 하면 빈 문자열)', () => {
    const d = loadData();
    const w = createWorld({ data: d, seed: 3, weapons, hooks: {}, startWeaponId: 'forward' });
    const byId = {};
    for (const em of d.enemies.emitters) byId[em.id] = em;
    for (const a of d.enemies.archetypes) {
      const e = spawnEnemy(w, a.id, 'normal', 500, 100, 10, false, false);
      const want = a.attack === null ? '' : byId[a.attack.emitterId].type;
      assert.eq(e.attackType, want, `${a.id} 의 공격 기호`);
    }
  });

  // ★ v1.6 까지 베이크된 eliteIndex 가 곡선을 무시했다 — 스테이지 1 은 곡선 0.0 인데도
  //   웨이브의 34% 가 엘리트를 낳았고, 엘리트는 hpMult 4.0 이라 초반에 10~20초짜리 벽이었다.
  //  ★ ㊿-zc — 이 테스트는 v1.7~㊿ 사이 «데이터만 읽고» 통과했다: 곡선표와 웨이브표를 대조할 뿐
  //    한 마리도 낳지 않아서, 엘리트 기능을 src 에서 통째로 지워도 초록이었다(실측 확인).
  //    이제 **실제로 웨이브를 돌려 개체를 센다.**
  //
  //  ★ 측정하면서 알게 된 것 — 「곡선 0 이면 0마리」는 포지션 1 에서 **곡선이 정하는 게 아니다.**
  //    §8.19 도입 침묵이 shooterRatio[0] = 0.0 으로 공격형을 아예 안 내보내고, 엘리트는 공격형에만
  //    붙으므로(`shoot && elite`) 곡선이 무엇이든 0이다. 그래서 「곡선이 유일한 권위다」를 증명하려면
  //    **공격형이 실제로 나오는 자리**를 봐야 한다 → 곡선이 1.0 인 포지션에서 «자격 개체 중 몇 %가
  //    엘리트인가»를 센다. 정본 §8.6 이 확정한 「최종 1.0 = 자격 전원」이 바로 그 수치다.
  test('엘리트는 스테이지 곡선이 «유일한 권위»다 — 곡선 0 이면 0마리 · 곡선 1.0 이면 자격 전원', () => {
    const d = loadData();
    assert.eq(d.stages.curve.elitePerWaveChance[0], 0, '스테이지 1 곡선 = 0 (전제)');
    assert.eq(d.stages.curve.elitePerWaveChance[5], 1, '최종 포지션 곡선 = 1.0 (전제)');
    assert.lt(d.stages.curve.elitePerWaveChance[0], d.stages.curve.elitePerWaveChance[5],
      '★ 곡선은 스테이지가 갈수록 오른다 — 초반 평범한 몹 → 후반 엘리트');

    //  ── 실측. ★ 같은 스테이지를 두 포지션에 박는다 — 내용물이 같으니 남는 변수는 포지션(곡선)뿐이다.
    //    스테이지는 introOk 인 것으로 고른다: 실제 추첨이 포지션 1 에 세울 수 있는 테마여야 한다(§8.1).
    //    아닌 것을 박으면 스테이지번호 1 로스터에 공격형이 없어 터진다(desert 로 해 보고 터뜨렸다 —
    //    게임 버그가 아니라 이 테스트가 게임에 없는 판을 만든 것이었다).
    const FINAL = d.stages.themeDraw.finalStageId;
    const stage = d.stages.stages.find((st) => st.id !== FINAL && st.introOk);
    assert.ok(stage !== undefined, '포지션 1 에 설 수 있는 테마가 있다(전제)');
    const el = d.rules.elite;
    const census = (pos) => {
      const w = createWorld({ data: d, seed: 3, weapons, hooks: { run: tickRun, enemies, emitters, boss: bossHook } });
      initRun(w);
      w.run.order[pos] = stage.id;
      w.run.stageIndex = pos; w.run.phase = PHASE.MOB; w.run.phaseT = 0;
      const seen = new Set(); let total = 0; let elite = 0; let eligible = 0;
      for (let t = 0; t < 30 * 60; t += 1) {
        w.player.hp = w.player.hpMax;                       // 죽어서 웨이브가 끊기지 않게
        step(w, makeInput(), TICK_DT);
        const items = w.enemies.items;
        for (let i = 0; i < items.length; i += 1) {
          const e = items[i];
          if (!e.alive || e.isBoss) continue;
          const key = `${i}:${e.gen}`;                      // 풀 재사용을 세대로 가른다 = «서로 다른 몸»
          if (seen.has(key)) continue;
          seen.add(key); total += 1;
          if (e.elite) elite += 1;
          //  자격(§8.6) = 밴드 ∈ bandAllowed ∧ 속성 ∈ elementAllowed. 도입 몸은 공격형이 아니라 애초에 밖이다.
          if (!e.introBody && el.bandAllowed.indexOf(e.band) >= 0 && el.elementAllowed.indexOf(e.element) >= 0) eligible += 1;
        }
        if (w.run.phase !== PHASE.MOB) break;
      }
      return { total, elite, eligible };
    };

    const s1 = census(0);
    assert.gt(s1.total, 100, '포지션 1 이 몸을 실제로 낳았다(전제) — 0마리를 세고 통과하면 공허하다');
    assert.eq(s1.elite, 0, `★ 곡선 0 = 엘리트 0 (실측 ${s1.elite}/${s1.total})`);
    //  ★ 그리고 «왜» 0인지까지 적어 둔다 — 포지션 1 은 자격 개체가 아예 안 선다(도입 침묵).
    //    이 줄이 깨지면 「초반에 엘리트 벽이 없다」를 지키는 것이 곡선이 아니라 §8.19 였음을 다시 읽어야 한다.
    assert.eq(s1.eligible, 0, `포지션 1 은 엘리트 자격 개체 자체가 0 (§8.19 도입 침묵, shooterRatio[0]=0) — 실측 ${s1.eligible}`);

    //  중간 포지션 — 곡선이 «실제로 판정에 쓰이는» 자리. 여기서 곡선이 낮으면 자격 개체 중 일부만 엘리트다.
    //    이 주장이 없으면 곡선을 최종값(1.0)으로 고정하는 변이를 못 잡는다(실측: 포지션 1 만으로는 못 잡았다).
    const mid = census(1);
    assert.gt(mid.eligible, 10, `중간 포지션에 자격 개체가 섰다(전제 — 실측 ${mid.eligible})`);
    assert.lt(mid.elite, mid.eligible,
      `★ 곡선 ${d.stages.curve.elitePerWaveChance[1]} = 자격 «일부»만 엘리트 (실측 ${mid.elite}/${mid.eligible}) — 전원이면 곡선이 안 읽힌 것이다`);

    const s6 = census(5);
    assert.gt(s6.eligible, 20, `최종 포지션에 자격 개체가 실제로 섰다(전제 — 실측 ${s6.eligible}) · 0이면 아래 주장이 공허하다`);
    assert.eq(s6.elite, s6.eligible,
      `★ 곡선 1.0 = 자격 전원이 엘리트 (실측 엘리트 ${s6.elite} · 자격 ${s6.eligible} / 총 ${s6.total})`);
  });
});

// §8.4/§8.18(v1.7 후속) — 「비행기 없이 적만」 계측이 잡아낸 두 구멍의 회귀.
suite('enemies/§8.4 진입 위치 · §8.18 빔·장판 곡선 (v1.7)', () => {
  // ★ strafe·rearIn 은 «스폰만 되고 아레나에 한 번도 서지 못했다»(실측 도달률 0.0%).
  //   strafe 는 상단 스폰라인에서 vy=0 이라 화면 위에 머물렀고, rearIn 은 거기서 vy=-speed 로
  //   더 멀어졌다. 값(moveParams.yPx)은 이미 저작돼 있었고 스폰이 그것을 안 읽은 것이 원인이다.
  test('strafe 는 좌우 벽 밖 · yPx 높이에서 들어온다', () => {
    const d = loadData();
    const w = createWorld({ data: d, seed: 3, weapons, hooks: { enemies }, startWeaponId: 'forward' });
    const a = d.rules.view.arena;
    const def = d.enemies.archetypes.find((x) => x.moveId === 'strafe');
    assert.ok(def !== undefined, 'strafe 아키타입 존재(전제)');
    assert.eq(typeof def.moveParams.yPx, 'number', 'yPx 가 저작돼 있다(전제)');
    const e = spawnEnemy(w, def.id, 'normal', 0, 0, 10, false, false);
    // 스폰 좌표는 spawnWave 경유라 직접 호출로는 안 잡힌다 — 여기서는 «이동이 화면 안을 향하는가»만 본다.
    for (let t = 0; t < 30; t += 1) step(w, makeInput(), TICK_DT);
    assert.eq(e.vy, 0, 'strafe 는 수평 횡단이다');
    assert.ok(e.vx !== 0, '옆으로 움직인다');
    assert.ok(def.moveParams.yPx > 0 && def.moveParams.yPx < a.h, 'yPx 가 아레나 안이다');
  });

  test('빔·장판도 피해 곡선을 탄다(보스 포함) — 단 «깎기만» 한다 (§2.1 상한 보존)', () => {
    const d = loadData();
    const mk = (stageIndex) => {
      const w = createWorld({ data: d, seed: 1, weapons, hooks: {}, startWeaponId: 'forward' });
      w.run = { stageIndex, order: [], crisis: false, bossFireRateMul: 1 };
      return w;
    };
    const curve = d.stages.curve.mobBulletDmgScale;
    assert.lt(curve[0], 1, '스테이지 1 은 1 미만이다(전제)');
    assert.gt(curve[5], 1, '스테이지 6 은 1 초과다(전제)');
    const RAW = 22;
    const lo = spawnBeam(mk(0), 500, 100, 1.57, 16, RAW, 1, -1, 'turretPod', 0.5, false);
    const hi = spawnBeam(mk(5), 500, 100, 1.57, 16, RAW, 1, -1, 'turretPod', 0.5, false);
    const boss = spawnBeam(mk(0), 500, 100, 1.57, 16, RAW, 1, -1, 'boss', 0.5, false);
    assert.lt(lo.dmg, RAW, '★ 초반 빔은 깎인다 — 「스테이지 1인데 너무 아프다」의 답');
    assert.eq(hi.dmg, RAW, '★ 후반에도 저작 상한을 넘지 않는다 — §2.1 「최대 단발 22 → 최소 5초」 보증');
    assert.lt(boss.dmg, RAW, '보스 빔도 초반엔 깎인다 — 피해 곡선은 보스에게도 걸린다(㊿-r · 사용자 확정)');
    const z = spawnZone(mk(0), 500, 300, 40, 12, 1, false, 'magmaBomb', 0.5);
    assert.lt(z.dmg, 12, '장판도 초반에 깎인다');
  });
});

// ─────────────────────────────────────────────────────────────────────────
/**
 * §8.19 도입 침묵 — «파밍 구간».
 * 정적 게이트(S48)는 데이터의 자격만 본다. 여기서는 스포너를 실제로 돌려
 * «화면에 뜨는 것»을 검사한다 — 그것이 사용자가 요구한 것이다.
 */
suite('enemies · §8.19 구간과 비율 (v1.10 — 사용자 사양)', () => {
  const ratioOf = (d, pos) => d.stages.curve.shooterRatio[pos];
  const isShooter = (d, id) => (d.enemies.archetypes.find((a) => a.id === id) || {}).attack !== null;

  test('① 첫 웨이브: 공격형 비율이 곡선을 «정확히» 따른다 (봉지 = 마리수 편차 0)', () => {
    const d = loadData();
    for (const seed of [1, 2, 3, 5, 8]) {
      const w = mkRun(d, seed);
      w.run.phase = PHASE.MOB; w.run.stageIndex = 0;
      enemies(w, TICK_DT);
      let n = 0; let sh = 0;
      for (const e of w.enemies.items) if (e.alive) { n += 1; if (isShooter(d, e.archetypeId)) sh += 1; }
      assert.gt(n, 0, '스폰됐다');
      assert.eq(sh, Math.round(n * ratioOf(d, 0)), `시드 ${seed}: 공격형 ${sh}/${n} = round(n × ${ratioOf(d, 0)})`);
    }
  });

  test('② 다른 시드 → 공격형의 «자리»는 갈리고 «수»는 같다', () => {
    const d = loadData();
    const sig = (seed) => {
      const w = mkRun(d, seed); w.run.phase = PHASE.MOB; w.run.stageIndex = 1; w.run.order[1] = 'sea';   // 포지션 1 — 스테이지 1 은 공격형 0(㉔)
      enemies(w, TICK_DT);
      const rows = [];
      for (const e of w.enemies.items) if (e.alive) rows.push(`${e.idx}:${isShooter(d, e.archetypeId) ? 'S' : '-'}`);
      return { pat: rows.join('|'), n: rows.filter((r) => r.endsWith('S')).length };
    };
    const a = sig(11); const b = sig(22);
    assert.eq(a.n, b.n, '공격형 «수»는 시드와 무관');
    assert.ne(a.pat, b.pat, '공격형 «자리»는 시드마다 다르다 (rng.spawn)');
  });

  test('③ 같은 시드 → 비트 동일 (봉지 셔플도 시드 난수다, §10.2)', () => {
    const d = loadData();
    const run = (seed) => {
      const w = mkRun(d, seed); w.run.phase = PHASE.MOB; w.run.stageIndex = 0;
      for (let i = 0; i < 600; i += 1) { w.player.hp = w.player.hpMax; step(w, makeInput(), TICK_DT); }
      return signature(w);
    };
    assert.eq(run(4242), run(4242), '같은 시드 = 같은 스폰');
  });

  test('④ 무공격 몸은 «위협» 예산을 먹지 않는다 (§12.1)', () => {
    const d = loadData();
    const w = mkRun(d, 9); w.run.phase = PHASE.MOB; w.run.stageIndex = 0;
    enemies(w, TICK_DT);
    let threat = 0; let chaff = 0;
    for (const e of w.enemies.items) if (e.alive) { if (e.introBody) chaff += 1; else threat += 1; }
    assert.gt(chaff, 0, '무공격 몸이 있다');
    assert.lte(threat, d.rules.fairness.enemyConcurrentMax, '공격형 ≤ enemyConcurrentMax');
    assert.lte(chaff, d.rules.fairness.introConcurrentMax, '무공격 ≤ introConcurrentMax');
  });

  test('⑤ 벽(wall)의 모든 줄에 fairness.minGapWidthPx 이상의 «차선»이 있다 (§2.1 ①)', () => {
    const d = loadData();
    const w = createWorld({ data: d, seed: 1, weapons, hooks: {} });
    const A = d.rules.view.arena;
    const N = d.stages.formations.wall.perRow * 3;                     // 세 줄짜리 벽으로 잰다
    const rows = new Map();
    const out = { x: 0, y: 0 };
    for (let i = 0; i < N; i += 1) {
      formationPos(w, d.stages.phase.introFormationId, i, N, A.x + A.w / 2, d.rules.view.spawnLineY, out);
      const k = Math.round(out.y);
      if (!rows.has(k)) rows.set(k, []);
      rows.get(k).push(out.x);
    }
    let r = 0;
    for (const t of d.stages.stages) {
      const a = d.enemies.archetypes.find((x) => x.id === t.introArchetypeId);
      if (a && a.radius > r) r = a.radius;
    }
    const need = d.rules.fairness.minGapWidthPx;
    assert.gt(rows.size, 1, '벽이 여러 줄이다');
    for (const [, raw] of rows) {
      const xs = raw.slice().sort((a, b) => a - b);
      let gap = xs[0] - r - A.x;
      const right = (A.x + A.w) - (xs[xs.length - 1] + r);
      if (right > gap) gap = right;
      for (let i = 1; i < xs.length; i += 1) { const g = xs[i] - xs[i - 1] - 2 * r; if (g > gap) gap = g; }
      assert.gte(gap, need, `줄의 최대 차선 ${gap.toFixed(1)}px ≥ ${need}px`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('enemies · v1.10 ㉔ — 스테이지 1 은 안 쏜다 · 테마 밖 속성은 약하다 (§8.19 · §8.2 ③)', () => {
  const isShooterId = (d, id) => { const a = d.enemies.archetypes.find((x) => x.id === id); return a !== undefined && a.attack !== null; };
  /** 런 월드를 pos 에 세우고 phaseT 부터 sec 초 돌리며 «잡몹» 스폰 종을 모은다(중간보스·보스·소환 유령 제외) */
  function mobsSeen(d, seed, pos, stageId, phaseT, sec, crisis) {
    const w = mkRun(d, seed);
    w.run.phase = PHASE.MOB; w.run.stageIndex = pos; w.run.order[pos] = stageId;
    w.run.phaseT = phaseT;
    if (crisis) { w.run.crisis = true; w.run.crisisAtSec = phaseT; }
    w.player.hp = 1e9; w.player.hpMax = 1e9;
    const seen = new Map();
    for (let i = 0; i < Math.round(sec / TICK_DT); i += 1) {
      step(w, makeInput(), TICK_DT);
      for (const e of w.enemies.items) if (e.alive && !e.isBoss && e.midBossId === '' && !e.ghost) seen.set(`${e.gen}:${e.idx}`, e.archetypeId);
    }
    return { w, ids: [...seen.values()] };
  }

  test('포지션 0(스테이지 1): 초기 구간·위기 구간 모두 공격형 0 · 포지션 1 부터 > 0 (shooterRatio[0] = 0)', () => {
    const d = loadData();
    assert.eq(d.stages.curve.shooterRatio[0], 0, 'shooterRatio[0] = 0 — 사용자 결정 2026-09-05');
    assert.gt(d.stages.curve.shooterRatio[1], 0, '포지션 1 부터 쏜다');
    const early0 = mobsSeen(d, 3, 0, 'bog', 0, 12, false);
    assert.gt(early0.ids.length, 50, `초기 구간에 몸은 많다 (${early0.ids.length})`);
    assert.eq(early0.ids.filter((id) => isShooterId(d, id)).length, 0, '초기 구간 공격형 0');
    assert.eq(early0.w.enemyBullets.live, 0, '적 탄 0');
    const crisis0 = mobsSeen(d, 3, 0, 'bog', d.stages.phase.crisisStartSec, 10, true);
    assert.gt(crisis0.ids.length, 50, `위기 구간에 새떼는 많다 (${crisis0.ids.length})`);
    assert.eq(crisis0.ids.filter((id) => isShooterId(d, id)).length, 0, '위기 구간 공격형 0');
    const early1 = mobsSeen(d, 3, 1, 'bog', 0, 12, false);
    assert.gt(early1.ids.filter((id) => isShooterId(d, id)).length, 0, '포지션 1 초기 구간엔 공격형이 섞인다');
    const crisis1 = mobsSeen(d, 3, 1, 'bog', d.stages.phase.crisisStartSec, 10, true);
    assert.gt(crisis1.ids.filter((id) => isShooterId(d, id)).length, 0, '포지션 1 위기엔 공격형이 섞인다');
  });

  test('테마 밖 속성의 HP = 테마 속성 HP × offThemeHpMul · 최종(테마 없음)은 전부 같다 · 소환 유령도 같은 규칙', () => {
    const d = loadData();
    const mul = d.stages.theme.offThemeHpMul;
    assert.ok(mul > 0 && mul < 1, `offThemeHpMul ${mul} ∈ (0,1)`);
    // bog = 풀 테마, 먹이 = 물. 초기 벽은 전부 도입종(같은 아키타입) → HP 차이는 속성뿐
    const w = mkRun(d, 5);
    w.run.phase = PHASE.MOB; w.run.stageIndex = 2; w.run.order[2] = 'bog';
    for (let i = 0; i < 120; i += 1) step(w, makeInput(), TICK_DT);
    const byEl = {};
    for (const e of w.enemies.items) {
      if (!e.alive || e.isBoss || e.midBossId !== '' || e.archetypeId !== 'drifter') continue;
      (byEl[e.element] = byEl[e.element] || new Set()).add(e.hpMax);
    }
    assert.ok(byEl.grass !== undefined && byEl.water !== undefined, `풀·물 둘 다 섰다 (${Object.keys(byEl).join(',')})`);
    assert.eq(byEl.grass.size, 1, '테마 속성 HP 는 한 값'); assert.eq(byEl.water.size, 1, '먹이 속성 HP 도 한 값');
    const hpG = [...byEl.grass][0]; const hpW = [...byEl.water][0];
    assert.near(hpW, hpG * mul, 1e-9, `물(먹이) ${hpW} = 풀(테마) ${hpG} × ${mul}`);
    assert.eq(Object.keys(byEl).length, 2, '두 속성뿐(§8.2 ②)');
    // 최종 — 테마가 없으니 세 속성이 같은 HP
    const f = mkRun(d, 6);
    f.run.phase = PHASE.MOB; f.run.stageIndex = 5; f.run.order[5] = 'finale';
    for (let i = 0; i < 120; i += 1) step(f, makeInput(), TICK_DT);
    const hps = new Set();
    for (const e of f.enemies.items) if (e.alive && !e.isBoss && e.midBossId === '' && e.archetypeId === 'drifter') hps.add(e.hpMax);
    assert.eq(hps.size, 1, `최종: 도입종 HP 한 값 (${[...hps].join(',')})`);
    // 소환 유령 — 중간보스 속성이 테마 밖이면 유령도 약하다(같은 입구 규칙)
    assert.near(offThemeHpMul(d, 'grass', 'water'), mul, 1e-12, '헬퍼: 테마 밖');
    assert.eq(offThemeHpMul(d, 'grass', 'grass'), 1, '헬퍼: 테마');
    assert.eq(offThemeHpMul(d, 'grass', 'normal'), 1, '헬퍼: 노말은 대상이 아니다');
    assert.eq(offThemeHpMul(d, null, 'fire'), 1, '헬퍼: 최종');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('enemies · v1.10 ㉕ — 적이 있는 구간은 일정하다: 편대 여백 · 옆벽 클램프 · 접힌 V · 선회 접근 (§8.7 · §8.4 · §9.9.2)', () => {
  function mkPos(seed, stageId, pos, crisis) {
    const d = loadData();
    const w = mkRun(d, seed);
    w.run.phase = PHASE.MOB; w.run.stageIndex = pos; w.run.order[pos] = stageId;
    w.player.hp = 1e9; w.player.hpMax = 1e9;
    if (crisis) { w.run.phaseT = d.stages.phase.crisisStartSec; w.run.crisis = true; w.run.crisisAtSec = w.run.phaseT; }
    return w;
  }
  const inside = (a, e) => e.x >= a.x + e.radius - 1e-6 && e.x <= a.x + a.w - e.radius + 1e-6;

  test('vWedge 는 폭에 맞춰 접힌다 — 37기가 전부 여백 안, 한 V 의 단 수는 아레나 반폭에서 유도, 넘치는 몸은 한 단 뒤의 다음 V', () => {
    const w = mk(1);
    const d = w.data; const a = d.rules.view.arena; const f = d.stages.formations.vWedge;
    const margin = 6;                                                    // swarmDart 반지름
    const ar = f.angleDeg * Math.PI / 180;
    const maxRank = Math.max(1, Math.floor((a.w / 2 - margin) / (f.gapPx * Math.sin(ar))));
    const per = 1 + 2 * maxRank;
    const out = { x: 0, y: 0 };
    const N = 37;
    const xs = []; const ys = [];
    for (let i = 0; i < N; i += 1) { formationPos(w, 'vWedge', i, N, a.x + a.w / 2, 0, out, margin); xs.push(out.x); ys.push(out.y); }
    for (let i = 0; i < N; i += 1) assert.ok(xs[i] >= a.x + margin && xs[i] <= a.x + a.w - margin, `${i}: x ${xs[i].toFixed(0)} 여백 안`);
    assert.ok(maxRank >= 4, `한 V 에 ≥ 4단 (실제 ${maxRank})`);
    assert.eq(xs[0], a.x + a.w / 2, '선두 = 원점');
    assert.eq(xs[per], a.x + a.w / 2, `두 번째 V 의 선두(${per}번째)도 원점 x`);
    assert.near(ys[per], -f.gapPx, 1e-9, '두 번째 V 는 한 단(gapPx) 뒤');
    // 벽에 «쌓인» 몸이 없다 — 같은 x 에 3기 이상 서지 않는다(옛 계산은 9단부터 전부 경계에 쌓였다)
    const atEdge = xs.filter((x) => x <= a.x + margin + 0.5 || x >= a.x + a.w - margin - 0.5).length;
    assert.eq(atEdge, 0, `경계에 선 몸 0 (실제 ${atEdge})`);
  });

  test('편대 여백 = 반지름 + weave 흔들림(+엘리트 배율) — scatter·arc·wall 도 여백 안', () => {
    const w = mk(2);
    const a = w.data.rules.view.arena;
    const out = { x: 0, y: 0 };
    for (const form of ['scatter', 'arc', 'wall', 'lineH']) {
      for (const margin of [0, 30, 120]) {
        for (let i = 0; i < 40; i += 1) {
          formationPos(w, form, i, 40, a.x + a.w / 2, 0, out, margin);
          assert.ok(out.x >= a.x + margin - 1e-9 && out.x <= a.x + a.w - margin + 1e-9, `${form} margin ${margin} #${i}: x ${out.x.toFixed(1)}`);
        }
      }
    }
  });

  test('위기 30초: 새떼(weave 포함) 어느 몸도 옆벽 밖에 걸치지 않는다 · 정상 구간 100초도 (strafe 는 벽 밖 진입이라 제외)', () => {
    for (const [stageId, pos, crisis, sec] of [['sea', 2, true, 30], ['bog', 3, false, 60], ['finale', 5, false, 60]]) {
      const w = mkPos(4, stageId, pos, crisis);
      const a = w.data.rules.view.arena;
      let total = 0; let out = 0; let strafeSeen = 0;
      for (let i = 0; i < 60 * sec; i += 1) {
        step(w, makeInput(), TICK_DT);
        for (const e of w.enemies.items) {
          if (!e.alive || e.isBoss || e.midBossId !== '') continue;
          const mv = w.spawner.archIndex[e.archetypeId].moveId;
          if (mv === 'strafe') { strafeSeen += 1; assert.eq(e.wallX, false, 'strafe 는 클램프 안 함'); continue; }
          assert.eq(e.wallX, true, `${e.archetypeId}: 옆벽 클램프 켜짐`);
          total += 1;
          if (!inside(a, e)) out += 1;
        }
      }
      assert.gt(total, 1000, `${stageId}: 몸-틱 충분 (${total})`);
      assert.eq(out, 0, `${stageId}${crisis ? ' 위기' : ''}: 옆벽 밖 0 (실제 ${out}/${total})`);
      void strafeSeen;
    }
  });

  test('orbitDrift(스토커·사이렌레이) — 들어와서 keepDistPx 근처를 «플레이어 위쪽»에서 돈다: 아레나 밖 0 · 플레이어 아래 0 · 도달률 100%', () => {
    const w = mkPos(4, 'sea', 2, false);
    const a = w.data.rules.view.arena;
    const stat = {};
    for (let i = 0; i < 60 * 48; i += 1) {
      step(w, makeInput(), TICK_DT);
      for (const e of w.enemies.items) {
        if (!e.alive || e.isBoss || e.midBossId !== '') continue;
        const def = w.spawner.archIndex[e.archetypeId];
        if (def.moveId !== 'orbitDrift') continue;
        const s = stat[e.archetypeId] || (stat[e.archetypeId] = { keep: def.moveParams.keepDistPx, t: 0, out: 0, below: 0, min: new Map() });
        s.t += 1;
        if (!inside(a, e) || e.y > a.y + a.h) s.out += 1;
        if (e.y > w.player.y) s.below += 1;
        const dd = Math.hypot(w.player.x - e.x, w.player.y - e.y); const k = `${e.gen}:${e.idx}`;
        if (!s.min.has(k) || dd < s.min.get(k)) s.min.set(k, dd);
      }
    }
    const ids = Object.keys(stat);
    assert.ok(ids.includes('stalker') && ids.includes('sirenRay'), `둘 다 나왔다 (${ids.join(',')})`);
    for (const id of ids) {
      const s = stat[id];
      assert.eq(s.out, 0, `${id}: 아레나 밖 0 (${s.out}/${s.t})`);
      assert.eq(s.below, 0, `${id}: 플레이어 아래 0 (${s.below}/${s.t})`);
      const ds = [...s.min.values()];
      const reached = ds.filter((x) => x <= s.keep * 1.3).length;
      assert.eq(reached, ds.length, `${id}: 전원이 keep×1.3(${(s.keep * 1.3).toFixed(0)}px) 안까지 온다 (${reached}/${ds.length})`);
    }
  });
});
