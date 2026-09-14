/**
 * tests/difficulty.test.mjs — §11.3 난이도 (v1.10 ㊿ · ㊿-q) · §2.7 스턴 게이팅 · §2.1 순삭 불가.
 *
 * 정본 계약:
 *   난이도는 «적 체력»이다(hpMul) — 그리고 state.difficultyHpMul 이 **유일한 문**이다:
 *   잡몹·중간보스·보스 코어·보스 파트 네 스포너 전부가 이 문을 지난다. 하나라도 빠지면
 *   그 적만 난이도를 안 탄다 = 조용한 구멍.
 *   ㊿-q: 난이도는 «적 공격력»이기도 하다(enemyDmgMul) — 문은 step.applyHit 하나이고 탄·몸통·장판·빔 네 피해원이
 *     전부 그리로 모인다. 기준선은 hpMul 과 반대로 «가장 쉬운 난이도»(노멀 ×1)다. 배율은 «정확히 한 번» 걸린다.
 *   §2.7: 난이도 < stunMinDifficulty 면 스턴 탄 이미터는 발사 시점에 침묵한다 — 값이 아니라 «실제로 안 쏘는가»를 본다
 *     (㊿-p 까지 값 검사만 있었고 읽는 코드가 0 이라 노멀에서도 스턴 탄이 나갔다).
 *   §2.1: 가장 어려운 난이도에서도 «가장 큰 한 방» 2회로는 만피가 죽지 않는다(S60 ⑩ 의 실동작 짝).
 *   ★ 난이도 id 를 하드코딩하지 않는다 — 표(meta.difficulty)를 읽는다. 「디재스터」가 그래서 죽었다.
 */

import { suite, test, assert, loadData } from '../tools/test.mjs';
import {
  createWorld, spawnEnemy, spawnMidBoss, spawnBossCore, spawnBossPart, spawnEnemyBullet, spawnZone, spawnBeam,
  difficultyHpMul, difficultyEnemyDmgMul, difficultyAllowsStun,
} from '../src/core/state.js';
import { step, makeInput, TICK_DT, applyHit } from '../src/core/step.js';
import { enemyToPlayer } from '../src/core/damage.js';
import { weapons } from '../src/core/weapons/index.js';
import { enemies } from '../src/core/enemies.js';
import { emitters } from '../src/core/emitters.js';
import { bossHook } from '../src/core/boss.js';
import { initRun, tickRun } from '../src/core/stage.js';

function mkWorld(difficulty) {
  const w = createWorld({
    data: loadData(), seed: 1, weapons, difficulty,
    hooks: { run: tickRun, enemies, emitters, boss: bossHook },
  });
  initRun(w);
  return w;
}
/** 런·스포너·이미터 없는 맨 월드 — 스테이지 곡선(mobBulletDmgScale)이 끼지 않아 난이도 배율 하나만 보인다 */
function mkBare(difficulty) {
  const w = createWorld({ data: loadData(), seed: 1, weapons, hooks: {}, startWeaponId: 'forward', difficulty });
  for (const s of w.slots) s.weaponId = null;      // 자동 발사가 탄·적을 지우지 않게
  return w;
}
/** 표에 실재하는 난이도 id (stunMinDifficulty 같은 스칼라 키는 뺀다) */
function tierIds() {
  const d = loadData().meta.difficulty;
  return Object.keys(d).filter((k) => d[k] !== null && typeof d[k] === 'object');
}

suite('difficulty/표 §11.3', () => {
  test('난이도는 셋이고 다섯 열이 순증 · 발사 주기는 줄지 않는다', () => {
    const d = loadData().meta.difficulty;
    const ids = tierIds();
    assert.eq(ids.length, 3, '난이도 셋 (튜토리얼은 난이도가 아니다)');
    // ㊿ — 저작값(bosses.json·stages.curve)은 «가장 어려운 난이도»의 값이다. 쉬운 난이도는 그 할인.
    assert.eq(d[ids[ids.length - 1]].hpMul, 1, '가장 어려운 난이도가 기준선 — hpMul 1');
    for (let i = 0; i < ids.length - 1; i += 1) assert.gt(1, d[ids[i]].hpMul, `${ids[i]}: hpMul < 1`);
    // ㊿-q — 피해는 반대쪽 끝이 기준선이다. 저작 피해 = 노멀 피해(§2.1 산술의 자리).
    assert.eq(d[ids[0]].enemyDmgMul, 1, '가장 쉬운 난이도가 공격력 기준선 — enemyDmgMul 1');
    // ㊿-z6 — 발사 주기도 반대쪽 끝이 기준선이다(저작한 everySec = 노멀의 주기).
    assert.eq(d[ids[0]].enemyFireRateMul, 1, '가장 쉬운 난이도가 발사 주기 기준선 — enemyFireRateMul 1');
    for (const col of ['speed', 'scoreMul', 'hpMul', 'enemyDmgMul', 'terrainMaxOnScreen']) {
      for (let i = 1; i < ids.length; i += 1) {
        assert.gt(d[ids[i]][col], d[ids[i - 1]][col], `${col}: ${ids[i]} > ${ids[i - 1]}`);
      }
    }
    // ㊿-z6 — 이 열만 «같아도 된다». 사용자가 하드·헬을 같은 ×1.2 로 정했다(발사 주기는 회피 가능성의 바닥이다).
    //   대신 줄어들면 «더 어려운 난이도가 더 느리게 쏜다»가 되므로 막는다.
    for (let i = 1; i < ids.length; i += 1) {
      assert.gte(d[ids[i]].enemyFireRateMul, d[ids[i - 1]].enemyFireRateMul,
        `enemyFireRateMul: ${ids[i]} >= ${ids[i - 1]} (같아도 되지만 줄면 안 된다)`);
    }
    assert.gt(d[ids[1]].enemyFireRateMul, d[ids[0]].enemyFireRateMul, '노멀보다는 빨라진다 — 안 그러면 열이 죽는다');
  });

  test('㊿-z6 발사 주기 — 같은 적이 하드에서 더 자주 쏜다 (흡혈을 깎는 대신 맞는 «빈도»를 올린다)', () => {
    // 같은 적 · 같은 시간 · 같은 씨앗. 다른 것은 난이도뿐이다.
    //   센 것은 «볼리 수»(e.emitPhase)다 — 탄 수는 캡·화면 밖 소멸이 섞여 주기를 흐린다.
    //   적은 제자리에 묶는다(아레나 밖으로 나가 사라지면 세다 말게 된다).
    const volleys = (difficulty) => {
      //   mkBare 는 훅이 비어 있다(스테이지 곡선을 빼려고) — 발사만 돌게 이미터 훅 하나를 단다
      const w = createWorld({ data: loadData(), seed: 1, weapons, hooks: { emitters }, startWeaponId: 'forward', difficulty });
      for (const sl of w.slots) sl.weaponId = null;
      const e = spawnEnemy(w, 'spitter', 'fire', w.data.rules.view.arena.x + 100, 140);
      for (let t = 0; t < 60 * 10; t += 1) {          // 10초
        step(w, makeInput(), TICK_DT);
        e.x = w.data.rules.view.arena.x + 100; e.y = 140; e.hp = e.hpMax;
      }
      return e.emitPhase;
    };
    const nNormal = volleys('normal');
    const nHard = volleys('hard');
    const mul = loadData().meta.difficulty.hard.enemyFireRateMul;
    assert.gt(nNormal, 3, `전제: 노멀에서도 여러 번 쏜다 (${nNormal}발)`);
    // 시계를 배속하는 방식이라 볼리 수가 배율만큼 는다(첫 발의 유예·텔레그래프가 섞여 경계에서 ±1)
    assert.gte(nHard, Math.floor(nNormal * mul) - 1, `하드가 노멀의 ×${mul} 만큼 쏜다 (노멀 ${nNormal} · 하드 ${nHard})`);
    assert.lte(nHard, Math.ceil(nNormal * mul) + 1, `배율보다 더 쏘지는 않는다 (노멀 ${nNormal} · 하드 ${nHard})`);
    // 헬은 하드와 «같은» 배율이므로 볼리 수도 같아야 한다 — 사용자가 정한 그대로다
    assert.eq(volleys('hell'), nHard, '헬은 하드와 같은 발사 주기(사용자 결정) — 달라지면 표와 화면이 어긋난다');
  });

  test('난이도 항목의 열은 여섯뿐이다 — 죽은 키가 없다 (㊿-c · ㊿-q · ㊿-w)', () => {
    // 화면에서 「진화 무기 N개 이상」을 빼자 evolutionsExpected 는 읽는 곳이 0 이 됐다 → 삭제했다.
    const d = loadData().meta.difficulty;
    for (const id of tierIds()) {
      assert.eq(Object.keys(d[id]).sort().join(','), 'enemyDmgMul,enemyFireRateMul,hpMul,scoreMul,speed,terrainMaxOnScreen', `${id}: 열 다섯`);
    }
  });

  test('미지 난이도는 소리내어 실패한다 (폴백 금지)', () => {
    const w = mkWorld('nope');
    assert.throws(() => difficultyHpMul(w), '미지 난이도 → throw (체력)');
    assert.throws(() => difficultyEnemyDmgMul(w), '미지 난이도 → throw (공격력)');
    assert.throws(() => difficultyAllowsStun(w), '미지 난이도 → throw (스턴)');
  });
});

suite('difficulty/체력 배율 §11.3', () => {
  test('difficultyHpMul 이 표의 hpMul 을 그대로 준다', () => {
    const d = loadData().meta.difficulty;
    for (const id of tierIds()) assert.eq(difficultyHpMul(mkWorld(id)), d[id].hpMul, `${id}`);
  });

  test('네 스포너 전부가 hpMul 을 탄다 — 잡몹·중간보스·보스 코어·보스 파트', () => {
    const data = loadData();
    const ids = tierIds();
    const hi = ids[0];                              // 저작값과 «다른» 난이도(할인 쪽)로 배율이 실제로 걸리는지 본다
    const mul = data.meta.difficulty[hi].hpMul;
    const arch = data.enemies.archetypes[0];
    const mb = data.bosses.bosses.find((b) => b.tier === 'mid');
    const bs = data.bosses.bosses.find((b) => Array.isArray(b.parts) && b.parts.length > 0);

    const cases = [
      ['잡몹', (w) => spawnEnemy(w, arch.id, 'normal', 600, 200, 1000, false, false)],
      ['중간보스', (w) => spawnMidBoss(w, mb, 'fire', 1000, 600, 200)],
      ['보스 코어', (w) => spawnBossCore(w, bs.id, bs.core, 1000, 600, 200)],
      ['보스 파트', (w) => spawnBossPart(w, bs.id, bs.parts[0], 1000, 600, 200)],
    ];
    for (const [name, spawn] of cases) {
      const base = spawn(mkWorld(ids[ids.length - 1]));
      const disc = spawn(mkWorld(hi));
      assert.eq(base.hp, 1000, `${name}: 가장 어려운 난이도 = 저작값 그대로`);
      assert.near(disc.hp, 1000 * mul, 1e-6, `${name}: hp × hpMul`);
      assert.eq(disc.hpMax, disc.hp, `${name}: hpMax 도 같이 움직인다 (체력바가 거짓말하지 않는다)`);
    }
  });

  test('엘리트 배율과 난이도 배율은 «곱»으로 함께 걸린다', () => {
    const data = loadData();
    const ids = tierIds();
    const hi = ids[0];
    const el = data.rules.elite.hpMult;
    const mul = data.meta.difficulty[hi].hpMul;
    const arch = data.enemies.archetypes[0];
    const e = spawnEnemy(mkWorld(hi), arch.id, 'normal', 600, 200, 1000, true, false);
    assert.near(e.hp, 1000 * el * mul, 1e-6, '엘리트 × 난이도');
  });
});

suite('difficulty/공격력 배율 §11.3 ㊿-q', () => {
  test('difficultyEnemyDmgMul 이 표의 enemyDmgMul 을 그대로 준다', () => {
    const d = loadData().meta.difficulty;
    for (const id of tierIds()) assert.eq(difficultyEnemyDmgMul(mkBare(id)), d[id].enemyDmgMul, `${id}`);
  });

  test('네 피해원 전부가 배율을 «정확히 한 번» 탄다 — 탄·몸통·장판·빔 (문은 applyHit 하나)', () => {
    const data = loadData();
    const ids = tierIds();
    // 가장 큰 무상태 탄 · 몸통 피해가 있는 첫 아키타입 — 값은 데이터에서 온다
    const bul = data.bullets.bullets.filter((b) => b.status === null).sort((a, b) => b.dmg - a.dmg)[0];
    const arch = data.enemies.archetypes.find((a) => a.contactDmg > 0);
    assert.ok(bul !== undefined && arch !== undefined, '전제: 탄·몸통 피해원이 데이터에 있다');
    // ★ 기댓값은 «스폰된 개체의 dmg»가 아니라 «저작값»에서 계산한다 — 스폰에서 배율을 한 번 더 곱하는 사고(이중 적용)는
    //   개체의 dmg 를 읽으면 자기 자신과 비교하게 되어 안 보인다(㊿-q 검토에서 발견).
    const ZONE = 12;
    const BEAM = 22;
    const paths = [
      ['탄', bul.dmg, (w) => spawnEnemyBullet(w, bul.id, w.player.x, w.player.y, 0, 0)],
      ['몸통', arch.contactDmg, (w) => spawnEnemy(w, arch.id, 'normal', w.player.x, w.player.y, 1e6, false, false)],
      ['장판', ZONE, (w) => spawnZone(w, w.player.x, w.player.y, 60, ZONE, 1.0, false)],
      ['빔', BEAM, (w) => spawnBeam(w, w.player.x, w.player.y - 200, Math.PI / 2, 20, BEAM, 1.0, -1)],
    ];
    for (const [name, authored, spawn] of paths) {
      const taken = [];
      for (const id of ids) {
        const w = mkBare(id);
        const p = w.player;
        p.iframeSec = 0;
        const hp0 = p.hp;
        spawn(w);
        step(w, makeInput(), TICK_DT);
        const got = hp0 - p.hp;
        assert.eq(got, enemyToPlayer(data.rules.player, p, authored * data.meta.difficulty[id].enemyDmgMul),
          `${name} @ ${id}: 받은 피해 = §3.2(저작 ${authored} × enemyDmgMul) — 배율은 정확히 한 번`);
        taken.push(got);
      }
      for (let i = 1; i < taken.length; i += 1) {
        assert.gt(taken[i], taken[i - 1], `${name}: ${ids[i]} 가 ${ids[i - 1]} 보다 아프다`);
      }
    }
  });

  test('§2.1 순삭 불가 — 가장 어려운 난이도에서도 «가장 큰 한 방» 2회로는 만피가 죽지 않는다 (S60 ⑩ 의 실동작)', () => {
    const data = loadData();
    const ids = tierIds();
    const top = ids[ids.length - 1];
    const el = data.rules.elite;
    // 한 방은 «스폰된» 값으로 잰다 — 스테이지 곡선이 가장 높은 스테이지에서 각 이미터가 실제로 만드는 피해
    //   (탄은 곡선을 그대로 · 빔·장판은 1 로 클램프 — 스포너가 계산한다. ㊿-q 2차 검토: 저작값만 보면 곡선이 올린 탄을 놓친다)
    const curve = data.stages.curve.mobBulletDmgScale;
    const probe = mkBare(top);
    probe.run = { stageIndex: curve.indexOf(Math.max(...curve)) };
    const bulletDmg = Object.fromEntries(data.bullets.bullets.map((b) => [b.id, b.dmg]));
    let maxSpawn = 0;
    for (const em of data.enemies.emitters) {
      let dmg;
      if (em.type === 'zone' || em.type === 'mortar') {
        const z = spawnZone(probe, 0, 0, 10, em.dmg, 1, false, 'probe'); dmg = z.dmg; probe.zones.release(z);
      } else if (em.type === 'laser' || em.type === 'sweep') {
        const t = spawnBeam(probe, 0, 0, 0, 10, bulletDmg[em.bulletId], 1, -1, 'probe'); dmg = t.dmg; probe.telegraphs.release(t);
      } else {
        const b = spawnEnemyBullet(probe, em.bulletId, 0, 0, 0, 0, 'probe'); dmg = b.dmg; probe.enemyBullets.release(b);
      }
      if (dmg > maxSpawn) maxSpawn = dmg;
    }
    let maxBody = data.enemies.archetypes.reduce(
      (m, a) => Math.max(m, a.contactDmg * (el.bandAllowed.includes(a.band) ? el.contactDmgMul : 1)), 0);
    for (const b of data.bosses.bosses) {
      for (const o of [b, b.core].concat(Array.isArray(b.parts) ? b.parts : [])) {
        if (o && typeof o.contactDmg === 'number' && o.contactDmg > maxBody) maxBody = o.contactDmg;
      }
    }
    assert.gt(maxSpawn, 0, '전제: 이미터 피해가 있다');
    assert.gt(maxBody, 0, '전제: 몸통 피해가 있다');
    for (const [name, raw] of [['스폰된 한 방', maxSpawn], ['몸통', maxBody]]) {
      const w = mkBare(top);
      const p = w.player;
      assert.eq(p.hp, p.hpMax, '전제: 만피');
      for (let k = 0; k < 2; k += 1) { p.iframeSec = 0; applyHit(w, raw, ''); }
      assert.gt(p.hp, 0, `${name} ${raw} × ${data.meta.difficulty[top].enemyDmgMul} 두 번 → 아직 산다 (남은 hp ${p.hp})`);
    }
  });
});

suite('difficulty/스턴 게이팅 §2.7', () => {
  test('stunMinDifficulty 미달이면 스턴 이미터가 «실제로» 침묵하고, 이상이면 쏜다 — 다른 이미터는 그대로', () => {
    const data = loadData();
    const md = data.meta.difficulty;
    const ids = tierIds();
    const minRank = ids.indexOf(md.stunMinDifficulty);
    assert.gt(minRank, 0, '전제: 스턴이 막히는 난이도가 적어도 하나 있다');
    // 스턴 탄을 쏘는 보스 부위를 데이터에서 찾는다 (S13: 보스 부위 patternSet[2] 에만 산다)
    const stunBullets = new Set(data.bullets.bullets.filter((b) => b.status === 'stun').map((b) => b.id));
    const stunEm = new Set(data.enemies.emitters.filter((em) => stunBullets.has(em.bulletId)).map((em) => em.id));
    const sites = [];
    for (const b of data.bosses.bosses) {
      for (const part of (Array.isArray(b.parts) ? b.parts : [])) {
        const ps = Array.isArray(part.patternSet) ? part.patternSet[2] : undefined;
        if (ps !== undefined && ps.emitterIds.some((id) => stunEm.has(id))) sites.push([b, part]);
      }
    }
    assert.gt(sites.length, 0, '전제: 스턴 이미터를 가진 보스 부위가 있다');
    const ticks = Math.round(12 / TICK_DT);          // 텔레그래프 1.6초 + 악절 한 바퀴를 넉넉히 덮는다
    for (const [boss, part] of sites) {
      for (let r = 0; r < ids.length; r += 1) {
        const w = mkWorld(ids[r]);
        const e = spawnBossPart(w, boss.id, part, 1e9, 600, 200);
        e.phase = 2;                                  // 페이즈 3 — 스턴 이미터의 거처
        spawnBossCore(w, boss.id, boss.core, 1e9, 600, 120);   // 같은 보스의 «스턴이 아닌» 이미터(대조군)
        for (let t = 0; t < ticks; t += 1) emitters(w, TICK_DT);
        let stun = 0; let other = 0;
        for (const b of w.enemyBullets.items) {
          if (!b.alive) continue;
          if (b.status === 'stun') stun += 1; else other += 1;
        }
        const label = `${boss.id}/${part.id} @ ${ids[r]}`;
        if (r < minRank) assert.eq(stun, 0, `${label}: 스턴 탄 0발 — 침묵 (치환 없음)`);
        else assert.gt(stun, 0, `${label}: 스턴 탄을 쏜다`);
        assert.gt(other, 0, `${label}: 스턴이 아닌 이미터는 난이도와 무관하게 쏜다`);
        assert.eq(difficultyAllowsStun(w), r >= minRank, `${label}: difficultyAllowsStun`);
      }
    }
  });
});
