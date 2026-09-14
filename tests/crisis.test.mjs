/**
 * tests/crisis.test.mjs — §8.10 위기 세션(새떼) 편성·속성·웨이브 정지.
 *
 * 정본 계약 (v1.10 ⑥ 새떼 반복):
 *   - 한 사이클 = crisisSubWaves(6) 파 · crisisCycleSec 초. 총량 = round(crisisTotal × swarmTotalScale[포지션]).
 *   - 편성 = 서브웨이브 몸 수 count 중 round(count × shooterRatio[포지션]) 이 crisisShooterId, 나머지 crisisBodyId (봉지).
 *   - crisisSwarmLoop — 페이즈 끝까지 사이클을 반복한다(격파로 앞당긴 위기가 비지 않는다).
 *   - 속성 = themePure(전부 테마) | finaleRotating(1·2 물 → 3·4 불 → 5·6 풀, §8.16) — 사이클마다 같은 회전.
 *   - crisisSuspendsWaves — 위기 중 정상 웨이브 정지(정본 true).
 */

import { suite, test, assert, loadData, baselineDifficulty } from '../tools/test.mjs';
import { createWorld } from '../src/core/state.js';
import { step, makeInput, TICK_DT } from '../src/core/step.js';
import { weapons } from '../src/core/weapons/index.js';
import { enemies } from '../src/core/enemies.js';
import { emitters } from '../src/core/emitters.js';
import { bossHook } from '../src/core/boss.js';
import { initRun, tickRun, PHASE } from '../src/core/stage.js';

function mkCrisisWorld(seed, stageId, pos) {
  const w = createWorld({ data: loadData(), seed, weapons, difficulty: baselineDifficulty(),
    hooks: { run: tickRun, enemies, emitters, boss: bossHook } });
  initRun(w);
  w.run.order[pos] = stageId;
  w.run.stageIndex = pos;
  w.run.phase = PHASE.MOB;
  w.run.crisis = true;
  w.run.crisisAtSec = w.data.stages.phase.crisisStartSec;   // v1.10 — 새떼의 원점은 «실제 시작 시각»이다
  return w;
}
function swarmStats(w) {
  let chaff = 0; let lancer = 0; const elems = new Set();
  for (const e of w.enemies.items) {
    if (!e.alive || !e.archetypeId.startsWith('swarm')) continue;
    elems.add(e.element);
    if (e.archetypeId === 'swarmLancer') lancer += 1; else chaff += 1;
  }
  return { chaff, lancer, total: chaff + lancer, elems: [...elems].sort() };
}

suite('crisis/§8.10 새떼', () => {
  test('한 사이클 총량 = round(crisisTotal × swarmTotalScale) · 공격형 = 서브웨이브마다 round(count × shooterRatio) (전 포지션)', () => {
    const d = loadData(); const ph = d.stages.phase; const sc = d.stages.curve.swarmTotalScale; const ratio = d.stages.curve.shooterRatio;
    for (let pos = 0; pos < sc.length; pos += 1) {
      const w = mkCrisisWorld(1, pos === 5 ? 'finale' : 'sea', pos);
      w.run.phaseT = ph.crisisStartSec + ph.crisisCycleSec - 1e-6;     // 한 사이클(6파)까지만 캐치업
      enemies(w, TICK_DT);
      const st = swarmStats(w);
      const want = Math.round(ph.crisisTotal * sc[pos]);
      let planSum = 0;
      for (let i = 0; i < w.spawner.crisisPlan.length; i += 1) planSum += w.spawner.crisisPlan[i];
      assert.eq(planSum, want, `pos${pos}(scale ${sc[pos]}) 사이클 계획 합`);
      // 한 틱에 6파를 캐치업하면 새떼 상한(swarmConcurrentMax)이 자를 수 있다 — 실제 플레이는 1.5초 간격이라 안 걸린다
      const cap = d.rules.fairness.swarmConcurrentMax;
      assert.eq(st.total, Math.min(want, cap), `pos${pos} 스폰 = min(총량, 상한 ${cap})`);
      if (want <= cap) {
        // 공격형 수 = Σ_서브웨이브 round(plan × ratio)
        let wantShoot = 0;
        for (let i = 0; i < w.spawner.crisisPlan.length; i += 1) wantShoot += Math.round(w.spawner.crisisPlan[i] * ratio[pos]);
        assert.eq(st.lancer, wantShoot, `pos${pos} 공격형 = Σ round(count × ${ratio[pos]})`);
        // v1.10 ㉔(사용자): 스테이지 1 의 위기는 «아예 안 쏜다» — ratio 0 이면 공격형 0, 그 뒤부터 > 0
        if (ratio[pos] === 0) assert.eq(st.lancer, 0, `pos${pos} 공격형 0 (ratio 0)`);
        else assert.gt(st.lancer, 0, `pos${pos} 공격형 > 0`);
        if (ratio[pos] < 0.5) assert.gt(st.chaff, st.lancer, `pos${pos} 몸이 다수 (ratio ${ratio[pos]})`);
      }
    }
  });

  test('공격형 지분 ≈ curve.shooterRatio[포지션] (정상 웨이브와 같은 곡선 — 서브웨이브 반올림 이내)', () => {
    const d = loadData(); const ph = d.stages.phase; const ratio = d.stages.curve.shooterRatio;
    for (let pos = 0; pos < 6; pos += 1) {
      const w = mkCrisisWorld(2, pos === 5 ? 'finale' : 'glacier', pos);
      // 서브웨이브 하나만 낸다(상한에 안 걸리게) — 지분은 그 파의 round(count × ratio) / count
      w.run.phaseT = ph.crisisStartSec;
      enemies(w, TICK_DT);
      const st = swarmStats(w);
      const count = w.spawner.crisisPlan[0];
      assert.eq(st.total, count, `pos${pos} 첫 파 몸 수 = 계획 ${count}`);
      assert.eq(st.lancer, Math.round(count * ratio[pos]), `pos${pos} 공격형 = round(${count} × ${ratio[pos]})`);
    }
  });

  test('crisisSwarmLoop — 사이클이 페이즈 끝까지 반복된다 · false 면 정확히 crisisSubWaves 파', () => {
    const d = loadData(); const ph = d.stages.phase;
    assert.eq(ph.crisisSwarmLoop, true, '정본: 새떼 반복');
    const w = mkCrisisWorld(3, 'sea', 2);
    w.run.phaseT = ph.crisisStartSec + ph.crisisCycleSec * 2.5;        // 2.5 사이클
    enemies(w, TICK_DT);
    assert.eq(w.spawner.crisisSpawned, Math.floor(2.5 * ph.crisisSubWaves) + 1, '2.5 사이클 = 15파 + 진행 중 1파');
    // ★ loadData() 는 캐시된 «같은 객체»다 — 값을 바꾸면 반드시 원복한다(다음 테스트로 샌다)
    const w2 = mkCrisisWorld(3, 'sea', 2);
    const saved = w2.data.stages.phase.crisisSwarmLoop;
    try {
      w2.data.stages.phase.crisisSwarmLoop = false;
      w2.run.phaseT = ph.crisisStartSec + ph.crisisCycleSec * 2.5;
      enemies(w2, TICK_DT);
      assert.eq(w2.spawner.crisisSpawned, ph.crisisSubWaves, '반복이 꺼지면 6파에서 멈춘다');
      const scale = d.stages.curve.swarmTotalScale[2];
      const cap = d.rules.fairness.swarmConcurrentMax;                 // 한 틱 캐치업은 상한에 걸릴 수 있다
      assert.eq(swarmStats(w2).total, Math.min(Math.round(ph.crisisTotal * scale), cap), '한 사이클 총량 (상한 초과 스폰 없음)');
    } finally {
      w2.data.stages.phase.crisisSwarmLoop = saved;
    }
  });

  test('themePure = 전부 테마 속성 (sea → 물)', () => {
    const d = loadData(); const ph = d.stages.phase;
    const w = mkCrisisWorld(1, 'sea', 0);
    w.run.phaseT = ph.crisisStartSec + ph.crisisCycleSec;
    enemies(w, TICK_DT);
    assert.deepEq(swarmStats(w).elems, ['water'], 'sea 위기 = 전부 물 (정답 스탠스의 페이오프)');
  });

  test('finaleRotating = 서브웨이브 1·2 물 → 3·4 불 → 5·6 풀 — 둘째 사이클도 같은 회전', () => {
    const d = loadData(); const ph = d.stages.phase;
    const interval = ph.crisisCycleSec / ph.crisisSubWaves;
    const want = ['water', 'water', 'fire', 'fire', 'grass', 'grass'];
    // 한 틱에 k+1 파를 캐치업하면 새떼 상한이 뒤 파를 잘라 속성이 안 보인다 — 이 테스트는 «회전»만 보므로 상한을 잠시 푼다(원복)
    const fa = d.rules.fairness; const savedCap = fa.swarmConcurrentMax;
    try {
      fa.swarmConcurrentMax = 100000;
      for (let k = 0; k < ph.crisisSubWaves * 2; k += 1) {
        const w = mkCrisisWorld(1, 'finale', 5);
        // 서브웨이브 창의 **중간점**을 쓴다 — 경계 정각은 부동소수로 floor 가 한쪽으로 떨어진다
        w.run.phaseT = ph.crisisStartSec + (k + 0.5) * interval;     // k+1 파까지 캐치업
        enemies(w, TICK_DT);
        assert.ok(swarmStats(w).elems.includes(want[k % ph.crisisSubWaves]), `서브웨이브 ${k + 1} 속성에 ${want[k % ph.crisisSubWaves]} 포함`);
      }
    } finally {
      fa.swarmConcurrentMax = savedCap;
    }
  });

  test('crisisSuspendsWaves — true(정본): 위기 중 정상 웨이브 0, 그래도 새떼가 무대를 채운다 · false: 웨이브도 흐른다', () => {
    const d = loadData(); const ph = d.stages.phase;
    assert.eq(ph.crisisSuspendsWaves, true, '정본: 위기 = 새떼만 (§8.19 v1.10 ⑥)');
    function run(suspend, sec) {
      const w = mkCrisisWorld(2, 'sea', 0);
      const saved = w.data.stages.phase.crisisSuspendsWaves;        // 캐시 공유 — 원복 필수
      w.data.stages.phase.crisisSuspendsWaves = suspend;
      try {
        w.run.phaseT = ph.crisisStartSec;
        w.player.hp = 1e9; w.player.hpMax = 1e9;
        let minSwarmLive = Infinity;
        for (let t = 0; t < Math.round(sec / TICK_DT); t += 1) {
          step(w, makeInput(), TICK_DT);
          if (w.run.phaseT > ph.crisisStartSec + 5) {                 // 5초 뒤부터는 늘 새떼가 있다
            let live = 0;
            for (const e of w.enemies.items) if (e.alive && e.archetypeId.startsWith('swarm')) live += 1;
            if (live < minSwarmLive) minSwarmLive = live;
          }
        }
        assert.eq(w.run.crisis, true, '위기가 유지된다(sticky)');
        return { waves: w.spawner.wavesSpawned, minSwarmLive };
      } finally {
        w.data.stages.phase.crisisSuspendsWaves = saved;
      }
    }
    const a = run(true, 30);
    assert.eq(a.waves, 0, 'true 면 위기 중 정상 웨이브 0');
    assert.gt(a.minSwarmLive, 10, '30초 내내 새떼가 무대에 있다(반복) — 최저 동시 > 10');
    // false 면 정상 웨이브도 흐르지만, 새떼가 위협 예산(threatLive < enemyConcurrentMax)을 나눠 쓰니 드물다
    assert.gt(run(false, 30).waves, 0, 'false 면 정상 웨이브도 흐른다');
  });

  test('결정성: 같은 시드·포지션 → 같은 편성', () => {
    const d = loadData(); const ph = d.stages.phase;
    function run() {
      const w = mkCrisisWorld(7, 'sea', 2);
      w.run.phaseT = ph.crisisStartSec + ph.crisisCycleSec;
      enemies(w, TICK_DT);
      const st = swarmStats(w);
      return `${st.chaff}/${st.lancer}`;
    }
    assert.eq(run(), run(), '동일 시드 = 동일 편성');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('crisis · v1.10 ㉘ — 위기에도 엘리트가 선다 (§8.6 · §8.10)', () => {
  test('포지션 0(확률 0)은 엘리트 0 · 확률 > 0 인 포지션은 자격 몸(line 밴드 화살)에서만 엘리트 · 새떼 몸(chaff)은 절대 아니다', () => {
    const d = loadData();
    const el = d.rules.elite;
    const chance = d.stages.curve.elitePerWaveChance;
    for (const pos of [0, 2, 4]) {
      const w = mkCrisisWorld(5, pos === 5 ? 'finale' : 'bog', pos);
      w.run.phaseT = d.stages.phase.crisisStartSec;
      w.player.hp = 1e9; w.player.hpMax = 1e9;
      for (const s of w.slots) s.weaponId = null;
      const seen = new Map();
      for (let i = 0; i < 60 * 18; i += 1) {
        step(w, makeInput(), TICK_DT);
        for (const e of w.enemies.items) if (e.alive && !e.isBoss && e.midBossId === '') seen.set(`${e.gen}:${e.idx}`, e);
      }
      let elites = 0; let total = 0;
      for (const e of seen.values()) {
        total += 1;
        if (!e.elite) continue;
        elites += 1;
        const a = d.enemies.archetypes.find((x) => x.id === e.archetypeId);
        assert.ok(el.bandAllowed.includes(a.band), `${e.archetypeId}(${a.band}) 는 엘리트 자격 밴드`);
        assert.ok(el.elementAllowed.includes(e.element), '자격 속성');
        assert.ok(e.radius > a.radius, '엘리트는 크다(sizeMult)');
      }
      assert.gt(total, 100, `pos${pos}: 새떼가 많이 나왔다 (${total})`);
      if (chance[pos] === 0) assert.eq(elites, 0, `pos${pos}: 확률 0 → 엘리트 0`);
      else assert.gt(elites, 0, `pos${pos}: 확률 ${chance[pos]} → 엘리트 > 0 (실제 ${elites}/${total})`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('crisis · v1.10 ㉜ — 위기 체력 배율 curve.crisisHpScale (§8.10)', () => {
  test('새떼 HP = archetype.hp × band.hpMult × enemyHpScale[pos] × offThemeHpMul × crisisHpScale[pos] · 초기 벽은 무관', () => {
    const d = loadData();
    const cu = d.stages.curve;
    assert.eq(cu.crisisHpScale[0], 1, '포지션 0 = 1');
    for (const pos of [0, 3, 5]) {
      const w = mkCrisisWorld(3, pos === 5 ? 'finale' : 'bog', pos);
      w.run.phaseT = d.stages.phase.crisisStartSec;
      enemies(w, TICK_DT);
      const st = w.data.stages.stages.find((x) => x.id === (pos === 5 ? 'finale' : 'bog'));
      let checked = 0;
      for (const e of w.enemies.items) {
        if (!e.alive || e.isBoss || e.midBossId !== '') continue;
        const a = d.enemies.archetypes.find((x) => x.id === e.archetypeId);
        const off = (st.element === null || e.element === st.element || e.element === 'normal') ? 1 : d.stages.theme.offThemeHpMul;
        const want = a.hp * d.enemies.bands[a.band].hpMult * cu.enemyHpScale[pos] * off * cu.crisisHpScale[pos] * (e.elite ? d.rules.elite.hpMult : 1);
        assert.near(e.hpMax, want, 1e-9, `pos${pos} ${e.archetypeId}${e.elite ? '*' : ''}: HP ${e.hpMax} = ${want}`);
        checked += 1;
      }
      assert.gte(checked, 20, `pos${pos}: 새떼를 검사했다 (${checked})`);
    }
    // 초기 벽(위기 아님)은 배율을 안 탄다 — 포지션 5 도입종 HP 에 crisisHpScale 이 없다
    const w2 = mkCrisisWorld(4, 'finale', 5);
    w2.run.crisis = false; w2.run.crisisAtSec = -1; w2.run.phaseT = 0;
    enemies(w2, TICK_DT);
    const dd = d.enemies.archetypes.find((x) => x.id === 'drifter');
    const body = w2.enemies.items.find((e) => e.alive && e.archetypeId === 'drifter');
    assert.ok(body !== undefined, '도입종이 섰다');
    assert.near(body.hpMax, dd.hp * d.enemies.bands[dd.band].hpMult * cu.enemyHpScale[5], 1e-9, '초기 벽 HP 에는 crisisHpScale 없음');
  });
});
