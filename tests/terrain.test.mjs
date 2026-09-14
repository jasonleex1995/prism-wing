/**
 * tests/terrain.test.mjs — 지형 장판 (§8.21, v1.10 ⑦)의 정본 계약.
 *
 * 커버:
 *   스폰   — MOB 에서 everySec 마다, 무대에 난이도별 상한 미만일 때, 아레나 안 x · 위에서 들어온다 / 최종 스테이지는 3종 가방(mixed — 무작위 순서, 3개마다 전부)
 *   흐름   — scrollSpeedPx 로 내려가고 아레나 아래로 나가면 반납 / advanceStage 가 무대를 비운다
 *   효과   — slow: 안에서 둔화(status.slowMoveSpeedMul) · 밖으로 나가면 다음 틱에 풀림
 *            inertia: 안에서 방향을 뒤집으면 vx 가 «서서히» 뒤집힌다(tau) · 밖에서는 즉시
 *            heat: fullSec 만에 차고 → stallSec 스턴 → 0 · 밖에서 coolSec 에 식는다 · 스턴 중엔 안 찬다
 *   무해   — 어느 지형 안에 서 있어도 HP 가 줄지 않는다(피해 0 = 사용자 결정 「유틸 방해」)
 *   저항   — 패시브 «자세 안정기»(terrainResist)가 세 지형의 효과를 (1 − Σ) 배로 줄이고 Lv10 은 면역 · 탄의 둔화는 그대로 (§8.21 ⑥ v1.10 ⑳·㉑)
 *   결정성 — 같은 시드 = 같은 위치(rng.terrain)
 */

import { suite, test, assert, loadData } from '../tools/test.mjs';
import { createWorld, givePassive } from '../src/core/state.js';
import { step, makeInput, TICK_DT } from '../src/core/step.js';
import { weapons } from '../src/core/weapons/index.js';
import { initRun, tickRun, advanceStage, PHASE } from '../src/core/stage.js';
import { terrainUnder, sectionOf, T_SLOW, T_INERTIA, T_HEAT } from '../src/core/terrain.js';
import { enemies } from '../src/core/enemies.js';
import { bossHook, wipeFrontY } from '../src/core/boss.js';
import { spawnEnemy, spawnEnemyBullet } from '../src/core/state.js';
import { TERRAIN_KINDS, TERRAIN_MIXED } from '../src/core/schema.mjs';

const dt = TICK_DT;

/** 적·발사 없이 런 시계만 흐르는 세계 — 지형과 플레이어만 본다 */
function mkRun(seed, stageId, pos = 0, difficulty = undefined) {
  // ㉚ 시작 무기를 벌컨으로 못박는다 — 추첨 무기가 리턴이면 짝 «자세 안정기» Lv1 이 딸려 와 저항 0 전제가 깨진다
  const w = createWorld({ data: loadData(), seed, weapons, startWeaponId: 'forward', difficulty, hooks: { enemies: null, emitters: null, run: tickRun, boss: null } });
  initRun(w);
  w.run.order[pos] = stageId;
  w.run.stageIndex = pos;
  w.player.hp = 1e9; w.player.hpMax = 1e9;
  return w;
}
function live(w) { return w.terrain.items.filter((t) => t.alive); }
function tick(w, n, input = makeInput()) { for (let i = 0; i < n; i += 1) step(w, input, dt); }
/** 첫 장판이 화면 가운데쯤 올 때까지 흘리고, 플레이어를 그 중심에 세운다 */
function standInFirst(w) {
  for (let i = 0; i < 60 * 30; i += 1) {
    step(w, makeInput(), dt);
    const t = live(w)[0];
    if (t && t.y > 200) { w.player.x = t.x; w.player.y = t.y; return t; }
  }
  throw new Error('지형이 안 온다');
}

suite('terrain — 스폰·흐름 (§8.21)', () => {
  test('MOB 에서 everySec 마다 스폰, 무대 상한(난이도 표), x 는 아레나 안, y 는 위에서', () => {
    const w = mkRun(3, 'bog');
    const tr = w.data.rules.terrain; const a = w.data.rules.view.arena;
    tick(w, 1);
    assert.eq(live(w).length, 1, '첫 틱에 하나 (terrainNextT 0)');
    const t0 = live(w)[0];
    assert.ok(t0.x >= a.x + t0.radius && t0.x <= a.x + a.w - t0.radius, 'x 가 아레나 안');
    assert.lt(t0.y, a.y, '위에서 들어온다');
    assert.eq(t0.radius, tr.radiusPx, '반지름 = rules.terrain.radiusPx');
    assert.eq(t0.kind, TERRAIN_KINDS.indexOf('slow'), 'bog = slow');
    tick(w, Math.round(tr.everySec / dt) + 2);
    assert.eq(live(w).length, 2, 'everySec 뒤 둘');
    tick(w, Math.round(tr.everySec / dt) * 6);
    assert.lte(live(w).length, w.data.meta.difficulty[w.difficultyId].terrainMaxOnScreen, '무대 상한(난이도 표)');
    assert.gte(live(w).length, 2, '흐르며 계속 있다');
  });

  test('★ 무대 상한은 난이도가 정한다 (㊿-w) — 노멀 < 하드 < 헬, 그리고 헬이 실제로 더 깔린다', () => {
    // 사용자(2026-09-12) 「난이도가 높아질수록 장판이 더 많아졌으면 좋겠어(노말 3~4 · 하드 4~5 · 헬 6~8)」
    const md = loadData().meta.difficulty;
    assert.ok(md.normal.terrainMaxOnScreen < md.hard.terrainMaxOnScreen && md.hard.terrainMaxOnScreen < md.hell.terrainMaxOnScreen,
      `난이도가 오르면 상한도 오른다 (${md.normal.terrainMaxOnScreen} · ${md.hard.terrainMaxOnScreen} · ${md.hell.terrainMaxOnScreen})`);
    const peak = (id) => {
      const w = mkRun(3, 'bog', 0, id);
      let m = 0;
      for (let i = 0; i < Math.round(90 / dt); i += 1) { tick(w, 1); m = Math.max(m, live(w).length); }
      return m;
    };
    for (const id of ['normal', 'hard', 'hell']) {
      assert.eq(peak(id), md[id].terrainMaxOnScreen, `${id}: 무대가 상한까지 찬다(그리고 넘지 않는다)`);
    }
  });

  test('scrollSpeedPx 로 내려가고 아레나 아래로 나가면 반납된다', () => {
    const w = mkRun(3, 'bog');
    const tr = w.data.rules.terrain; const a = w.data.rules.view.arena;
    tick(w, 1);
    const t = live(w)[0]; const y0 = t.y;
    tick(w, 60);
    assert.near(t.y - y0, tr.scrollSpeedPx, 1.5, '1초에 scrollSpeedPx 만큼');
    const need = Math.ceil(((a.y + a.h + t.radius) - t.y) / tr.scrollSpeedPx / dt) + 3;
    const gen = t.gen;
    tick(w, need);
    assert.ok(!t.alive || t.gen !== gen, '아래로 나가면 반납');
  });

  test('최종 스테이지(mixed)는 3종이 «가방»으로 나온다 — 3개마다 전부 한 번씩, 순서는 시드마다 다르다 · advanceStage 는 무대를 비운다', () => {
    /** 놓인 순서대로 종을 기록한다(풀 인덱스는 재사용될 수 있으니 gen:idx 로 새 것을 가른다) */
    function observe(w, want) {
      const seen = []; const known = new Set();
      for (let i = 0; i < 60 * 60 && seen.length < want; i += 1) {
        step(w, makeInput(), dt);
        for (const t of live(w)) { const key = `${t.gen}:${w.terrain.items.indexOf(t)}`; if (!known.has(key)) { known.add(key); seen.push(t.kind); } }
      }
      return seen;
    }
    const w = mkRun(3, 'bog', 4);
    w.run.order[5] = 'finale';
    tick(w, 60 * 8);
    assert.gt(live(w).length, 0, '스테이지 5(bog)엔 지형이 있다');
    assert.ok(live(w).every((t) => t.kind === T_SLOW), 'bog 는 slow 만');
    w.player.heat = 0.7;
    advanceStage(w);
    assert.eq(live(w).length, 0, '전이에서 비운다');
    assert.eq(w.player.heat, 0, '열도 0');
    assert.eq(w.run.terrainBagN, 0, '가방은 비어서 시작(다음에 섞는다)');
    const st = w.data.stages.stages.find((x) => x.id === 'finale');
    assert.eq(st.terrainKind, TERRAIN_MIXED, 'finale = mixed (§8.21 ③)');
    const seen = observe(w, 6);
    assert.eq(seen.length, 6, `60초 안에 6개 (실제 ${seen.length})`);
    const all = TERRAIN_KINDS.map((_, i) => i).join(',');
    assert.eq(seen.slice(0, 3).sort().join(','), all, '첫 3개 = 3종 전부');
    assert.eq(seen.slice(3, 6).sort().join(','), all, '다음 3개 = 3종 전부');
    // 순서는 시드가 정한다 — 여러 시드에서 첫 가방의 순서가 전부 같지는 않다(고정 순환이 아니다)
    const orders = new Set();
    for (let seed = 1; seed <= 6; seed += 1) {
      const w2 = mkRun(seed, 'finale', 5);
      orders.add(observe(w2, 3).join(','));
    }
    assert.gt(orders.size, 1, `시드마다 순서가 다르다 (${[...orders].join(' | ')})`);
  });

  test('결정성 — 같은 시드 = 같은 위치, 다른 시드 = 다른 위치 (rng.terrain)', () => {
    const xs = (seed) => { const w = mkRun(seed, 'glacier'); tick(w, 60 * 12); return live(w).map((t) => Math.round(t.x)).join(','); };
    assert.eq(xs(9), xs(9), '같은 시드');
    assert.ne(xs(9), xs(10), '다른 시드');
  });
});

suite('terrain — 효과 (§8.21 · §2.2 · §2.7)', () => {
  test('slow — 안에서 둔화(status.slowMoveSpeedMul), 밖으로 나가면 다음 틱에 풀린다', () => {
    const w = mkRun(3, 'bog');
    const rp = w.data.rules.player; const mul = w.data.rules.status.slowMoveSpeedMul;
    const t = standInFirst(w);
    assert.eq(terrainUnder(w, w.player.x, w.player.y), T_SLOW, '장판 안');
    const inp = makeInput(); inp.right = true;
    tick(w, 3, inp);
    assert.gt(w.player.slowSec, 0, '둔화 상태');
    assert.near(Math.abs(w.player.vx), rp.moveSpeed * mul, 1e-6, '속도 = 기준 × 둔화 (이동 속도 배율은 없다 — v1.10 ⑳)');
    // 밖으로
    w.player.x = t.x + t.radius + 200; w.player.y = 600;
    tick(w, 2, inp);
    assert.eq(terrainUnder(w, w.player.x, w.player.y), -1, '밖');
    assert.eq(w.player.slowSec, 0, '풀렸다');
    assert.near(Math.abs(w.player.vx), rp.moveSpeed, 1e-6, '속도 정상 = moveSpeed 고정');
  });

  test('inertia — 안에서 방향을 뒤집으면 vx 가 서서히 뒤집힌다(responseTauSec), 밖에서는 즉시', () => {
    const w = mkRun(4, 'glacier');
    const tr = w.data.rules.terrain;
    const t = standInFirst(w);
    assert.eq(terrainUnder(w, w.player.x, w.player.y), T_INERTIA, '장판 안');
    const right = makeInput(); right.right = true;
    const left = makeInput(); left.left = true;
    tick(w, 30, right);                          // 오른쪽으로 충분히
    w.player.x = t.x; w.player.y = t.y;          // 장판 중심에 다시 (관찰용)
    const v0 = w.player.vx;
    assert.gt(v0, 0, '오른쪽 속도');
    step(w, left, dt);
    assert.gt(w.player.vx, 0, '한 틱 뒤에도 아직 오른쪽 (관성)');
    let n = 1;
    while (w.player.vx > 0 && n < 600) { w.player.x = t.x; w.player.y = t.y; step(w, left, dt); n += 1; }
    const expect = Math.log(2) * tr.inertia.responseTauSec / dt;    // tau·ln2 만에 0 을 지난다
    assert.ok(Math.abs(n - expect) <= 3, `뒤집히는 데 ${n}틱 ≈ tau·ln2 = ${expect.toFixed(1)}틱`);
    // 밖에서는 즉시
    w.player.x = t.x + t.radius + 200; w.player.y = 600;
    tick(w, 5, right);
    step(w, left, dt);
    assert.lt(w.player.vx, 0, '밖에서는 한 틱에 뒤집힌다 (moveResponseTau 0)');
  });

  test('heat — fullSec 에 차서 stallSec 스턴 후 0 · 스턴 중엔 안 찬다 · 밖에서 coolSec 에 식는다', () => {
    const w = mkRun(5, 'volcano');
    const tr = w.data.rules.terrain;
    const t = standInFirst(w);
    assert.eq(terrainUnder(w, w.player.x, w.player.y), T_HEAT, '장판 안');
    let stunAt = -1; let n = 0;
    while (stunAt < 0 && n < 600) { w.player.x = t.x; w.player.y = t.y; step(w, makeInput(), dt); n += 1; if (w.player.stunSec > 0) stunAt = n; }
    assert.ok(stunAt > 0, '정지가 온다');
    assert.ok(Math.abs(stunAt * dt - tr.heat.fullSec) <= 2 * dt, `fullSec(${tr.heat.fullSec}) 만에 정지 (실제 ${(stunAt * dt).toFixed(2)})`);
    assert.near(w.player.stunSec, tr.heat.stallSec, 1e-6, '정지 길이 = stallSec');
    assert.eq(w.player.heat, 0, '정지 순간 열 0');
    w.player.x = t.x; w.player.y = t.y; step(w, makeInput(), dt);
    assert.eq(w.player.heat, 0, '스턴 중엔 안 찬다');
    // 밖에서 식는다
    let m = 0; while (w.player.stunSec > 0 && m < 200) { w.player.x = t.x; w.player.y = t.y; step(w, makeInput(), dt); m += 1; }
    w.player.x = t.x; w.player.y = t.y; tick(w, 30);                // 0.5초 → heat ≈ 1/3
    const h = w.player.heat;
    assert.gt(h, 0.2, '다시 찬다');
    w.player.x = t.x + t.radius + 200; w.player.y = 600;
    tick(w, Math.round(tr.heat.coolSec * h / dt) + 2);
    assert.eq(w.player.heat, 0, 'coolSec × 열 만에 식는다');
  });

  test('무해 — 세 지형 어디에 서 있어도 HP 가 줄지 않는다 (피해 0)', () => {
    for (const id of ['bog', 'glacier', 'volcano']) {
      const w = mkRun(6, id);
      w.player.hp = 100; w.player.hpMax = 100;
      const t = standInFirst(w);
      for (let i = 0; i < 60 * 12; i += 1) { w.player.x = t.x; w.player.y = t.y; step(w, makeInput(), dt); }
      assert.eq(w.player.hp, 100, `${id}: 12초 서 있어도 HP 100`);
    }
  });
});

suite('terrain — 저항 패시브 «자세 안정기» (§8.21 ⑥ v1.10 ⑳·㉑)', () => {
  /** 저항 패시브를 n 레벨 «더» 올리고 배율 (1 − Σ) 을 돌려준다 — 값은 데이터에서 */
  function raise(w, n) {
    const ps = w.data.passives;
    const def = ps.passives.find((x) => x.stat === 'terrainResist');
    assert.ok(def !== undefined, 'terrainResist 를 쓰는 패시브가 있다');
    for (let k = 0; k < n; k += 1) assert.ok(givePassive(w, def.id), `${def.id} +1`);
    const lv = w.passives.find((x) => x.id === def.id).level;
    assert.near(w.stats.terrainResist, def.values[lv - 1], 1e-9, `Σ = Lv${lv} 값`);
    return 1 - def.values[lv - 1];
  }
  const MID = 5;

  test('Lv10 = 면역 — 값이 정확히 1.00 (사용자 결정: 상한은 100%)', () => {
    const w = mkRun(3, 'bog');
    const def = w.data.passives.passives.find((x) => x.stat === 'terrainResist');
    assert.eq(def.values[w.data.passives.maxLevel - 1], 1, '만렙 = 1.00');
    for (let i = 1; i < def.values.length; i += 1) assert.gt(def.values[i], def.values[i - 1], '단조 증가');
  });

  test('slow — 둔화 «깊이»가 (1 − Σ) 배로 준다 · 면역이면 정속 · 탄의 둔화(slowSec 직접)는 그대로', () => {
    const w = mkRun(3, 'bog');
    const rp = w.data.rules.player; const mul = w.data.rules.status.slowMoveSpeedMul;
    const tm = raise(w, MID);
    const t = standInFirst(w);
    const inp = makeInput(); inp.right = true;
    tick(w, 3, inp);
    assert.eq(terrainUnder(w, w.player.x, w.player.y), T_SLOW, '장판 안');
    assert.near(Math.abs(w.player.vx), rp.moveSpeed * (1 - (1 - mul) * tm), 1e-6, `속도 = 기준 × (1 − (1 − ${mul}) × ${tm.toFixed(2)})`);
    raise(w, w.data.passives.maxLevel - MID);                       // 만렙까지
    w.player.x = t.x; w.player.y = t.y; tick(w, 3, inp);
    assert.near(Math.abs(w.player.vx), rp.moveSpeed, 1e-6, '면역 = 정속');
    // 밖에서 탄의 둔화 — 지형 저항의 대상이 아니다
    w.player.x = t.x + t.radius + 200; w.player.y = 600;
    tick(w, 2, inp);
    w.player.slowSec = 1.0;
    step(w, inp, dt);
    assert.near(Math.abs(w.player.vx), rp.moveSpeed * mul, 1e-6, '탄 둔화는 전부 받는다');
    // ★ ㊿-zc — 빠져 있던 경우: «탄에 맞아 둔화된 채 장판 «안»에» 있을 때.
    //   예전 코드는 «지금 장판 위인가»로만 갈라서, 늪에 들어서면 저항이 탄의 둔화까지 깎아 줬다 —
    //   즉 **둔화 지형에 들어가면 더 빨라졌다**(면역이면 사실상 무둔화). 저항은 «지형» 저항이다.
    for (let k = 0; k < 3; k += 1) {
      w.player.x = t.x; w.player.y = t.y;
      w.player.slowSec = 1.0;                     // 탄이 건 둔화(한 틱보다 길다 = 지형에서 온 것이 아니다)
      step(w, inp, dt);
    }
    assert.eq(terrainUnder(w, w.player.x, w.player.y), T_SLOW, '전제: 장판 «안»이다');
    assert.near(Math.abs(w.player.vx), rp.moveSpeed * mul, 1e-6,
      '장판 안이어도 탄의 둔화는 깎이지 않는다 — 들어갔다고 빨라지지 않는다');
  });

  test('㊿-zc 면역(Lv10)이면 둔화 배지도 안 켜진다 — 안 느려지는데 표시만 켜지면 화면이 거짓말한다', () => {
    const w = mkRun(3, 'bog');
    raise(w, w.data.passives.maxLevel);
    const t = standInFirst(w);
    const inp = makeInput(); inp.right = true;
    for (let k = 0; k < 5; k += 1) { w.player.x = t.x; w.player.y = t.y; step(w, inp, dt); }
    assert.eq(terrainUnder(w, w.player.x, w.player.y), T_SLOW, '전제: 장판 안');
    assert.near(Math.abs(w.player.vx), w.data.rules.player.moveSpeed, 1e-6, '정속(면역)');
    assert.eq(w.player.slowSec, 0, '둔화 타이머가 안 선다 — HUD 배지의 근거가 곧 이 값이다');
  });

  //  ★ ㊿-ze5 — 판별식의 «경계». ㊿-zc 는 「지형은 한 틱(dt)만 채운다」는 성질을 **값 비교**로 썼는데,
  //    탄 둔화도 감쇠하다 dt 아래로 내려오면서 같은 값을 지나간다 — 그 두 틱 동안 저항이 탄 둔화를 깎았다.
  //    ㊿-ze4 가 tmul > 0 을 더해 «면역»만 막았고 저항 Lv1~9 는 그대로였다(검토 실측: 2.5초 둔화가 148틱).
  //    이제 값이 아니라 **순서**로 가른다 — 지형 보충 «직전»에 남아 있던 시간이 곧 탄이 건 몫이다.
  test('㊿-ze5 «탄» 둔화는 장판 위에서도 끝까지 온전하다 — 저항 레벨과 무관하게 지속시간이 그대로다', () => {
    const w0 = mkRun(3, 'bog');
    const rp = w0.data.rules.player; const mul = w0.data.rules.status.slowMoveSpeedMul;
    const SLOWED = rp.moveSpeed * mul;
    const DUR = 2.5;
    const WANT = Math.round(DUR / dt);                      // 탄 둔화가 온전히 걸려야 하는 틱 수
    //  저항 전 레벨 + 면역까지 — 「경계」는 레벨을 가리지 않는다
    for (const lv of [1, 5, w0.data.passives.maxLevel - 1, w0.data.passives.maxLevel]) {
      const w = mkRun(3, 'bog');
      raise(w, lv);
      const t = standInFirst(w);
      const inp = makeInput(); inp.right = true;
      w.player.slowSec = DUR;
      let full = 0; let onTile = 0;
      for (let k = 0; k < WANT + 20; k += 1) {
        w.player.x = t.x; w.player.y = t.y;                 // ★ 장판은 스크롤한다 — 매 틱 따라붙는다
        if (terrainUnder(w, w.player.x, w.player.y) === T_SLOW) onTile += 1;
        step(w, inp, dt);
        if (Math.abs(Math.abs(w.player.vx) - SLOWED) < 1e-6) full += 1;
      }
      assert.gt(onTile, WANT, `Lv${lv}: 내내 둔화 장판 «위»였다(전제 — ${onTile}틱)`);
      assert.eq(full, WANT,
        `★ Lv${lv}: 탄 둔화 ${DUR}초 = ${WANT}틱이 장판 위에서도 온전하다 (실측 ${full}틱) — 저항은 «지형» 저항이다`);
    }
  });

  test('inertia — τ 가 (1 − Σ) 배로 짧아진다 · 면역이면 즉시 뒤집힌다', () => {
    const w = mkRun(4, 'glacier');
    const tr = w.data.rules.terrain;
    const tm = raise(w, MID);
    const t = standInFirst(w);
    const right = makeInput(); right.right = true;
    const left = makeInput(); left.left = true;
    tick(w, 30, right);
    w.player.x = t.x; w.player.y = t.y;
    assert.gt(w.player.vx, 0, '오른쪽');
    let n = 0;
    while (w.player.vx > 0 && n < 600) { w.player.x = t.x; w.player.y = t.y; step(w, left, dt); n += 1; }
    const expect = Math.log(2) * tr.inertia.responseTauSec * tm / dt;
    assert.ok(Math.abs(n - expect) <= 2, `뒤집히는 데 ${n}틱 ≈ τ·tm·ln2 = ${expect.toFixed(1)}틱`);
    raise(w, w.data.passives.maxLevel - MID);
    w.player.x = t.x; w.player.y = t.y; tick(w, 5, right);
    w.player.x = t.x; w.player.y = t.y; step(w, left, dt);
    assert.lt(w.player.vx, 0, '면역 = 한 틱에 뒤집힌다');
  });

  test('heat — 충전이 (1 − Σ) 배로 느려진다 · 면역이면 영영 안 찬다', () => {
    const w = mkRun(5, 'volcano');
    const tr = w.data.rules.terrain;
    const tm = raise(w, MID);
    const t = standInFirst(w);
    let stunAt = -1; let n = 0;
    while (stunAt < 0 && n < 60 * 20) { w.player.x = t.x; w.player.y = t.y; step(w, makeInput(), dt); n += 1; if (w.player.stunSec > 0) stunAt = n; }
    assert.ok(stunAt > 0, '정지가 온다');
    const expect = tr.heat.fullSec / tm;
    assert.ok(Math.abs(stunAt * dt - expect) <= 2 * dt, `fullSec/(1−Σ) = ${expect.toFixed(2)}s 만에 정지 (실제 ${(stunAt * dt).toFixed(2)})`);
    let m = 0; while (w.player.stunSec > 0 && m < 200) { w.player.x = t.x; w.player.y = t.y; step(w, makeInput(), dt); m += 1; }
    raise(w, w.data.passives.maxLevel - MID);
    w.player.heat = 0;
    for (let i = 0; i < 60 * 10; i += 1) { w.player.x = t.x; w.player.y = t.y; step(w, makeInput(), dt); }
    assert.eq(w.player.heat, 0, '면역 = 10초 서 있어도 열 0');
    assert.eq(w.player.stunSec, 0, '정지 없음');
  });

  test('이동 속도 배율은 어휘에 없다 — stats 에 moveSpeedMul 이 없고 자석은 moveSpeed 그대로', () => {
    const w = mkRun(7, 'bog');
    assert.eq(w.stats.moveSpeedMul, undefined, 'stats.moveSpeedMul 없음');
    assert.ok(!w.data.passives.stats.includes('moveSpeedMul'), 'passives.stats 에 없음');
    assert.ok(w.data.passives.passives.every((x) => x.stat !== 'moveSpeedMul'), '어느 패시브도 안 쓴다');
  });
});

suite('terrain — 구간과 위기 페이드 (§8.21 ④ v1.10 ⑧)', () => {
  test('sectionOf — early → midboss → crisis → boss 를 시계·페이즈로 가른다', () => {
    const w = mkRun(3, 'bog');
    const ph = w.data.stages.phase; const at = ph.midBossAtSec[0];
    assert.eq(sectionOf(w), 'early', '시작 = early');
    w.run.phaseT = at[0] + 1; assert.eq(sectionOf(w), 'midboss', '첫 중간보스 뒤 = midboss');
    w.run.crisis = true; assert.eq(sectionOf(w), 'crisis', '위기 = crisis');
    w.run.phase = PHASE.BOSS_INTRO; assert.eq(sectionOf(w), 'boss', 'BOSS_INTRO = boss');
    w.run.phase = PHASE.BOSS; assert.eq(sectionOf(w), 'boss', 'BOSS = boss');
    w.run.phase = PHASE.STAGE_CLEAR; assert.eq(sectionOf(w), null, '그 밖은 null');
  });

  test('spawnIn 에 crisis 가 없다 — 위기엔 새 지형이 안 나오고, 있던 것은 fadeSec 안에 줄어들며 사라진다(효과는 즉시 꺼짐)', () => {
    const w = mkRun(3, 'bog');
    const tr = w.data.rules.terrain;
    assert.ok(tr.spawnIn.indexOf('crisis') < 0, '정본: 위기 제외');
    const t = standInFirst(w);
    assert.eq(terrainUnder(w, w.player.x, w.player.y), T_SLOW, '위기 전엔 효과');
    // 위기 강제 — 격파 앞당김 경로 대신 시계 상한으로
    w.run.phaseT = w.data.stages.phase.crisisStartSec - dt;
    step(w, makeInput(), dt);
    assert.eq(w.run.crisis, true, '위기');
    assert.ok(t.alive && t.fadeT >= 0, '남은 지형이 사라지는 중');
    assert.eq(terrainUnder(w, t.x, t.y), -1, '사라지는 중엔 효과 없음');
    const before = live(w).length;
    tick(w, Math.round(tr.fadeSec / dt) + 2);
    assert.eq(live(w).length, 0, `fadeSec 뒤 0 (전 ${before})`);
    tick(w, Math.round(tr.everySec / dt) * 3);
    assert.eq(live(w).length, 0, '위기 중 새 스폰 0');
  });
});

suite('boss — 등장 쓸어내기 (§8.22 v1.10 ⑧)', () => {
  /** 잡몹·탄·지형이 남은 채 잡몹 페이즈를 끝내는 세계 */
  function mkAtPhaseEnd(seed, stageId) {
    const w = createWorld({ data: loadData(), seed, weapons, hooks: { enemies, emitters: null, run: tickRun, boss: bossHook } });
    initRun(w);
    w.run.order[0] = stageId;
    w.player.hp = 1e9; w.player.hpMax = 1e9;
    const ph = w.data.stages.phase;
    w.run.phaseT = ph.mobPhaseSec - 0.5;
    w.run.crisis = true; w.run.crisisAtSec = ph.crisisStartSec;   // 위기 끝자락 — 새떼가 남아 있다
    tick(w, 20);
    // 무대에 확실히 남긴다: 위·아래에 잡몹, 탄, 지형
    const def = w.data.enemies.archetypes.find((a) => a.id === 'drifter');
    spawnEnemy(w, 'drifter', 'normal', 600, 100, def.hp, false);
    spawnEnemy(w, 'drifter', 'normal', 620, 650, def.hp, false);
    spawnEnemyBullet(w, 'pelletS', 640, 700, 0, 50);
    const t = w.terrain.alloc(); t.kind = 0; t.radius = 72; t.x = 640; t.y = 600; t.fadeT = -1;
    return w;
  }
  const mobs = (w) => w.enemies.items.filter((e) => e.alive && !e.isBoss).length;

  test('앞선이 위에서 아래로 내려가며 지나간 것만 지운다 — entryWipeSec 뒤 무대엔 보스뿐, 그 뒤 지형 무리', () => {
    const w = mkAtPhaseEnd(2, 'bog');
    const b = w.data.rules.boss; const tr = w.data.rules.terrain;
    assert.gte(mobs(w), 2, '잡몹이 남아 있다');
    // 페이즈 끝 → BOSS_INTRO + wipeT 0
    tick(w, Math.round(0.5 / dt) + 1);
    assert.eq(w.run.phase, PHASE.BOSS_INTRO, '강림 연출');
    assert.gte(w.run.wipeT, 0, '쓸어내기 시작');
    assert.gt(mobs(w), 0, '시작 직후엔 아래쪽 잡몹이 아직 산다(즉시 증발이 아니다)');
    // 중간 — 앞선 아래는 산다
    tick(w, Math.round(b.entryWipeSec * 0.4 / dt));
    const front = wipeFrontY(w);
    for (const e of w.enemies.items) if (e.alive && !e.isBoss) assert.gt(e.y, front - 1e-6, '앞선 위의 잡몹은 없다');
    let below = 0; for (const e of w.enemies.items) if (e.alive && !e.isBoss && e.y > front) below += 1;
    assert.gt(below, 0, '앞선 아래엔 아직 있다');
    // 끝 — 전부 없고 지형 무리
    tick(w, Math.round(b.entryWipeSec * 0.7 / dt) + 2);
    assert.eq(w.run.wipeT, -1, '쓸어내기 끝');
    assert.eq(mobs(w), 0, '비-보스 적 0');
    assert.eq(w.enemyBullets.live, 0, '적탄 0');
    const core = w.enemies.items.find((e) => e.alive && e.isBoss && e.isCore);
    assert.ok(core, '보스는 남는다');
    const lv = w.terrain.items.filter((t) => t.alive);
    assert.eq(lv.length, tr.bossEntryCount, `지형 무리 ${tr.bossEntryCount}개`);
    const a = w.data.rules.view.arena;
    for (const t of lv) {
      assert.ok(t.y > a.y && t.y < a.y + a.h, '아레나 «안»에 이미 놓여 있다(위에서 오지 않는다)');
      assert.ok(t.fadeT < 0, '사라지는 중이 아니다');
      const dx = t.x - w.player.x; const dy = t.y - w.player.y;
      assert.gt(dx * dx + dy * dy, (t.radius + 40) * (t.radius + 40) - 1e-6, '플레이어 바로 위엔 없다');
    }
  });

  test('보스 구간에도 평소 주기로 계속 흘러온다 (spawnIn 에 boss) · 결정성', () => {
    function run(seed) {
      const w = mkAtPhaseEnd(seed, 'volcano');
      const tr = w.data.rules.terrain; const b = w.data.rules.boss;
      tick(w, Math.round((0.5 + b.entryWipeSec) / dt) + 3);
      const burst = w.terrain.items.filter((t) => t.alive).map((t) => `${Math.round(t.x)},${Math.round(t.y)}`).join(' ');
      tick(w, Math.round((tr.everySec * 2 + 0.2) / dt));
      return { burst, liveNow: w.terrain.items.filter((t) => t.alive).length, phase: w.run.phase };
    }
    const a = run(5); const b = run(5); const c = run(6);
    assert.eq(a.burst, b.burst, '같은 시드 = 같은 무리');
    assert.ne(a.burst, c.burst, '다른 시드 = 다른 무리');
    assert.gte(a.liveNow, 1, '보스 구간에도 지형이 있다');
  });

  test('finale(mixed) — 쓸어내기 뒤 지형 무리(bossEntryCount)에 3종이 전부 선다', () => {
    const w = mkAtPhaseEnd(2, 'finale');
    w.run.order[5] = 'finale'; w.run.stageIndex = 5;
    const b = w.data.rules.boss;
    const tr = w.data.rules.terrain;
    tick(w, Math.round((0.5 + b.entryWipeSec) / dt) + 3);
    assert.eq(w.run.phase, PHASE.BOSS_INTRO, '강림');
    assert.eq(mobs(w), 0, '잡몹 0');
    const kinds = w.terrain.items.filter((t) => t.alive).map((t) => t.kind).sort();
    assert.eq(kinds.length, tr.bossEntryCount, `지형 무리 ${tr.bossEntryCount}`);
    // 가방(3종)이라 bossEntryCount ≥ 3 이면 3종이 전부 들어 있고, 넘치는 몫은 다음 가방에서 온다(어느 종이든)
    for (let k = 0; k < TERRAIN_KINDS.length; k += 1) assert.ok(kinds.includes(k), `종 ${TERRAIN_KINDS[k]} 가 무리에 있다`);
    assert.ok(tr.bossEntryCount >= TERRAIN_KINDS.length, '무리 ≥ 3 이어야 3종이 전부 선다');
  });
});
