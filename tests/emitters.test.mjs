/**
 * tests/emitters.test.mjs — src/core/emitters.js (적 공격 발사 훅) 계약 단위 테스트
 *
 * 대상 (임무 그룹 A):
 *   · 결정성 — 같은 시드 → 같은 적-탄 시퀀스(좌표·속도까지 비트 동일) / 다른 시드 → 상이 (§10.2)
 *   · firstDelaySec + telegraphSec 준수 — 그 리드 전에는 **탄이 하나도 없다** (§7.4/§12.4 공정성)
 *   · 케이던스 — 첫 볼리 뒤 everySec 마다 다음 볼리 (§8.5 메트로놈)
 *   · 방향 — straight 는 아래(+y), aimed 는 leadSec 예측 플레이어 방향 (§8.5/§9.9.2)
 *   · 개수 — 한 볼리 = emitter.count 발 (§8.5)
 *   · 공정성 상한 — 탄 속력 == emitter.speed 이고 ≤ fairness.max(Aimed)BulletSpeed (§12.4, 지어내지 않음)
 *   · attack:null 은 절대 안 쏜다 (drifter·swarmChaff)
 *   · 통합 — 스폰 → 자동발사 침묵 시 적이 실제로 탄을 쏘고 플레이어를 맞힌다 (긴박감의 뼈대)
 *
 * ★ 값은 전부 data/정본에서 유도한다. emitters(w, dt) 를 직접 불러 발사만 관찰하거나(탄 미이동 =
 *   누적 카운트가 쉽다), step() 으로 이동·충돌까지 태운다.
 */
import { suite, test, assert, loadData } from '../tools/test.mjs';
import { createWorld, spawnEnemy } from '../src/core/state.js';
import { step, makeInput, TICK_DT } from '../src/core/step.js';
import { enemies } from '../src/core/enemies.js';
import { emitters } from '../src/core/emitters.js';
import { weapons } from '../src/core/weapons/index.js';
import { initRun, tickRun, PHASE } from '../src/core/stage.js';
import { bossHook } from '../src/core/boss.js';

const dt = TICK_DT;

/** emitters 훅만 (스포너 없음 — 직접 주입한 개체만 관찰) */
function mkSolo(seed = 1) {
  return createWorld({ data: loadData(), seed, weapons, hooks: { emitters } });
}
/** 스포너 + 이미터 (통합/결정성) — ★ v1.10 ㉔: 스테이지 1(포지션 0)은 «아예 안 쏜다»(shooterRatio 0)이므로 런을 세워 포지션 1 에서 본다 */
function mkFull(seed = 1) {
  const w = createWorld({ data: loadData(), seed, weapons, hooks: { enemies, emitters, run: tickRun, boss: bossHook } });
  initRun(w);
  w.run.order[1] = 'sea'; w.run.stageIndex = 1; w.run.phase = PHASE.MOB;
  return w;
}
function arch(w, id) { return w.data.enemies.archetypes.find((a) => a.id === id); }
function emit(w, id) { return w.data.enemies.emitters.find((e) => e.id === id); }
function silence(w) { for (const s of w.slots) s.weaponId = null; }
function centerTop(w) {
  const a = w.data.rules.view.arena;
  return { x: a.x + a.w / 2, y: a.y + 120 };
}
/** alive 적탄 스냅샷 서명 */
function bulletSig(w) {
  const out = [];
  const it = w.enemyBullets.items;
  for (let i = 0; i < it.length; i += 1) {
    const b = it[i];
    if (!b.alive) continue;
    out.push(`${b.idx}:${b.bulletId}:${b.x.toFixed(4)}:${b.y.toFixed(4)}:${b.vx.toFixed(4)}:${b.vy.toFixed(4)}`);
  }
  return out.join('|');
}

// ─────────────────────────────────────────────────────────────────────────
suite('emitters · firstDelaySec + telegraphSec 리드 (§7.4/§12.4 — 예고 없는 발사 없음)', () => {
  test('그 리드 전에는 탄이 0발, 첫 발사는 정확히 그 시점의 첫 틱', () => {
    const w = mkSolo(3);
    const p = centerTop(w);
    const def = arch(w, 'spitter');
    const em = emit(w, def.attack.emitterId);
    const firstFire = def.attack.firstDelaySec + em.telegraphSec + em.offsetSec;
    spawnEnemy(w, 'spitter', 'grass', p.x, p.y, def.hp, false);

    let ageAtFirst = -1;
    let age = 0;
    for (let i = 0; i < 600; i += 1) {
      const before = w.enemyBullets.live;
      emitters(w, dt);            // 탄을 움직이지 않음 → 누적. age 는 emitters 안에서 +dt
      age += dt;
      // 리드 전에는 절대 발사 없음 (firstDelaySec 준수보다 강한 주장)
      if (age < firstFire - 1e-9) assert.eq(w.enemyBullets.live, 0, `age ${age.toFixed(3)} < 리드 ${firstFire}: 탄 0`);
      if (before === 0 && w.enemyBullets.live > 0 && ageAtFirst < 0) ageAtFirst = age;
    }
    assert.gte(ageAtFirst, firstFire - 1e-9, '첫 발사 age ≥ firstDelaySec+telegraphSec (텔레그래프 리드 보존)');
    assert.lt(ageAtFirst, firstFire + dt + 1e-9, '첫 발사는 리드를 넘긴 **첫** 틱 (지연 없음)');
    assert.gte(ageAtFirst, def.attack.firstDelaySec - 1e-9, 'firstDelaySec 준수(그 자체보다 늦게)');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('emitters · mortar 박격포 (§8.5 v1.5 — 표적 착탄 + 퓨즈)', () => {
  test('개체 자리가 아니라 «플레이어 표적»에 warnSec=fuseSec 장판을 놓는다', () => {
    const w = mkSolo(5);
    const a = w.data.rules.view.arena;
    const p = w.player;
    p.x = a.x + a.w * 0.3; p.y = a.y + a.h * 0.7; p.vx = 0; p.vy = 0;   // 표적(정지)
    const em = emit(w, 'hulkZone');
    assert.eq(em.type, 'mortar', 'hulkZone = mortar');
    const def = arch(w, 'mortarHulk');
    const ex = a.x + a.w * 0.6, ey = a.y + 120;                         // 개체는 다른 자리
    spawnEnemy(w, 'mortarHulk', 'fire', ex, ey, def.hp, false);
    for (let i = 0; i < 600 && w.zones.live === 0; i += 1) emitters(w, dt);
    assert.eq(w.zones.live, 1, '박격포 착탄 = 장판 1개');
    const z = w.zones.items.find((zz) => zz.alive);
    assert.near(z.x, p.x, 1e-6, '착탄 x = 플레이어 표적(개체 자리 아님)');
    assert.near(z.y, p.y, 1e-6, '착탄 y = 플레이어 표적');
    assert.near(z.warnSec, em.fuseSec, 1e-9, 'warnSec = fuseSec(퓨즈)');
    assert.gt(Math.abs(z.x - ex), 50, '개체 자리와 다르다(표적 착탄)');
  });

  test('이동 중인 플레이어는 진행 방향 앞(leadSec 예측)으로 착탄한다', () => {
    const w = mkSolo(6);
    const a = w.data.rules.view.arena;
    const p = w.player;
    p.x = a.x + a.w * 0.5; p.y = a.y + a.h * 0.5; p.vx = 120; p.vy = 0;  // 오른쪽 이동
    const em = emit(w, 'hulkZone');
    const def = arch(w, 'mortarHulk');
    spawnEnemy(w, 'mortarHulk', 'fire', p.x, a.y + 120, def.hp, false);
    for (let i = 0; i < 600 && w.zones.live === 0; i += 1) { emitters(w, dt); }  // p.vx 유지(step 없음)
    const z = w.zones.items.find((zz) => zz.alive);
    assert.near(z.x, p.x + p.vx * em.leadSec, 1e-6, '착탄 = 현재 위치 + 속도×leadSec');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('emitters · 개수 · 케이던스 (§8.5 — 메트로놈)', () => {
  test('한 볼리 = emitter.count 발, everySec 뒤 다음 볼리', () => {
    const w = mkSolo(4);
    const p = centerTop(w);
    const def = arch(w, 'spitter');
    const em = emit(w, def.attack.emitterId);
    assert.eq(em.repeat, 1, '전제: 잡몹 이미터는 repeat==1 (S30)');
    assert.eq(em.restSec, 0, '전제: 잡몹 이미터는 restSec==0 (S30)');
    spawnEnemy(w, 'spitter', 'grass', p.x, p.y, def.hp, false);

    const firstFire = def.attack.firstDelaySec + em.telegraphSec + em.offsetSec;
    // 첫 볼리 직후까지
    let age = 0;
    while (age < firstFire + dt) { emitters(w, dt); age += dt; }
    assert.eq(w.enemyBullets.live, em.count, `첫 볼리 = count(${em.count})발`);

    // everySec 를 더 돌리면 두 번째 볼리 (탄은 이동 안 하니 누적)
    const target = age + em.everySec;
    while (age < target + dt) { emitters(w, dt); age += dt; }
    assert.eq(w.enemyBullets.live, em.count * 2, `everySec(${em.everySec}) 뒤 두 번째 볼리 → 2×count`);
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('emitters · 방향 · 공정성 속력 (§8.5 · §12.4)', () => {
  test('straight(spitter) — 전탄 아래로(+y), 속력 == emitter.speed ≤ maxBulletSpeed', () => {
    const w = mkSolo(5);
    const p = centerTop(w);
    const def = arch(w, 'spitter');
    const em = emit(w, def.attack.emitterId);
    const cap = w.data.rules.fairness.maxBulletSpeed;
    assert.lte(em.speed, cap, 'data: straight speed ≤ maxBulletSpeed (지어내지 않음)');
    spawnEnemy(w, 'spitter', 'grass', p.x, p.y, def.hp, false);
    for (let i = 0; i < 300 && w.enemyBullets.live === 0; i += 1) emitters(w, dt);
    let n = 0;
    const it = w.enemyBullets.items;
    for (let i = 0; i < it.length; i += 1) {
      const b = it[i];
      if (!b.alive) continue;
      n += 1;
      assert.gt(b.vy, 0, '아래로(+y)');
      assert.near(Math.hypot(b.vx, b.vy), em.speed, 1e-6, '속력 == emitter.speed (회전은 크기 보존)');
    }
    assert.eq(n, em.count, `count(${em.count})발 발사됨`);
  });

  test('aimed(hexer) — leadSec 예측 플레이어 방향, 속력 ≤ maxAimedBulletSpeed', () => {
    const w = mkSolo(6);
    silence(w);
    const a = w.data.rules.view.arena;
    const def = arch(w, 'hexer');
    const em = emit(w, def.attack.emitterId);
    const capA = w.data.rules.fairness.maxAimedBulletSpeed;
    assert.lte(em.speed, capA, 'data: aimed speed ≤ maxAimedBulletSpeed');
    // 플레이어를 hexer 의 아래-오른쪽에 고정
    const ex = a.x + a.w * 0.3;
    const ey = a.y + 120;
    w.player.x = a.x + a.w * 0.7; w.player.y = a.y + a.h - 60; w.player.vx = 0; w.player.vy = 0;
    spawnEnemy(w, 'hexer', 'water', ex, ey, def.hp, false);
    for (let i = 0; i < 400 && w.enemyBullets.live === 0; i += 1) emitters(w, dt);
    const it = w.enemyBullets.items;
    let seen = false;
    for (let i = 0; i < it.length; i += 1) {
      const b = it[i];
      if (!b.alive) continue;
      seen = true;
      assert.gt(b.vy, 0, '플레이어가 아래에 있으니 아래로 향한다');
      assert.gt(b.vx, 0, '플레이어가 오른쪽에 있으니 오른쪽으로 향한다 (조준)');
      assert.near(Math.hypot(b.vx, b.vy), em.speed, 1e-6, '속력 == aimed speed');
    }
    assert.ok(seen, 'hexer 가 실제로 조준탄을 쐈다');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('emitters · attack:null 은 안 쏜다 (§8.5)', () => {
  test('drifter · swarmChaff 는 아무리 돌려도 탄 0', () => {
    for (const id of ['drifter', 'swarmChaff']) {
      const w = mkSolo(8);
      const p = centerTop(w);
      const def = arch(w, id);
      assert.eq(def.attack, null, `전제: ${id}.attack == null`);
      spawnEnemy(w, id, 'normal', p.x, p.y, def.hp, false);
      for (let i = 0; i < 1200; i += 1) emitters(w, dt);
      assert.eq(w.enemyBullets.live, 0, `${id} 는 발사하지 않는다`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
/**
 * ★ §8.19 도입 침묵 — 첫 introQuietWaves[0] 개 웨이브는 «쏘지 않는» 도입종이다.
 *   아래 두 결정성 테스트는 무기를 침묵시킨 채(silence) 도므로 아무도 죽지 않는다 →
 *   waveClearAdvance 가 안 걸려 웨이브가 waveIntervalSec 간격으로만 넘어가고,
 *   첫 «쏘는» 웨이브가 도입 침묵 뒤로 밀린다(실측 8.0초 → 36.5초).
 *   ★ 틱 예산을 다른 매직넘버로 바꾸지 않고 «데이터에서 유도»한다 — 곡선을 고쳐도 안 깨진다.
 *   +2 웨이브 여유: 로스터 라운드로빈이 도입 직후 자리에 무공격 종을 다시 놓을 수 있다
 *   v1.10: 도입 침묵은 «비율»로 대체됐다 — 첫 웨이브부터 공격형이 섞인다.
 */
function ticksToFirstFire(w) {
  // v1.10 비율 모델 — 포지션 1 부터 공격형이 웨이브 0 부터 섞인다(shooterRatio[1] > 0). 두 웨이브 + 발사 유예면 충분하다.
  const iv = w.data.stages.phase.waveIntervalSec;
  return Math.ceil((2 * iv + 6) * 60);
}

suite('emitters · 결정성 (§10.2)', () => {
  test('같은 시드 → 같은 적-탄 시퀀스 (좌표·속도 비트 동일)', () => {
    const a = mkFull(20260718);
    const b = mkFull(20260718);
    silence(a); silence(b);
    const sa = []; const sb = [];
    const N = ticksToFirstFire(a);                 // §8.19 고요 창을 넘긴다(데이터에서 유도)
    for (let i = 0; i < N; i += 1) {
      step(a, makeInput(), dt); step(b, makeInput(), dt);
      if (i % 60 === 0) { sa.push(bulletSig(a)); sb.push(bulletSig(b)); }
    }
    // ★ 비교한 «시퀀스 자체»에 탄이 들어 있었는지 본다 — 마지막 틱의 순간값(live)은 볼리 사이에
    //   0 이 될 수 있어 공허 통과/오탐 둘 다 낸다. 이 형태가 원래 의도(0행 아님)보다 강하다.
    assert.ok(sa.some((r) => r.length > 0), '적이 실제로 탄을 쐈다 (비교한 시퀀스가 0행 아님)');
    assert.deepEq(sa, sb, '같은 시드 = 비트 동일한 적-탄 시퀀스');
  });

  test('다른 시드 → 상이 (스폰이 rng.spawn 을 타므로 탄 위치가 갈린다)', () => {
    const a = mkFull(11); const b = mkFull(29);
    silence(a); silence(b);
    const sa = []; const sb = [];
    const N = ticksToFirstFire(a);                 // §8.19 고요 창을 넘긴다(데이터에서 유도)
    for (let i = 0; i < N; i += 1) {
      step(a, makeInput(), dt); step(b, makeInput(), dt);
      if (i % 60 === 0) { sa.push(bulletSig(a)); sb.push(bulletSig(b)); }
    }
    assert.ok(sa.some((r) => r.length > 0) && sb.some((r) => r.length > 0), '양쪽 다 쏨 (비교한 시퀀스 기준)');
    assert.ne(JSON.stringify(sa), JSON.stringify(sb), '다른 시드 = 다른 탄 시퀀스');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('emitters · 통합 (긴박감의 뼈대: 스폰 → 발사 → 피격)', () => {
  test('무기를 침묵시키면 적 탄이 실제로 플레이어를 맞힌다', () => {
    const w = mkFull(7);
    silence(w);                                    // 적이 살아남아 계속 쏜다
    const hp0 = w.player.hp;
    let sawBullet = false;
    for (let i = 0; i < 3600; i += 1) {
      step(w, makeInput(), dt);
      if (w.enemyBullets.live > 0) sawBullet = true;
    }
    assert.ok(sawBullet, '적이 탄을 쐈다');
    assert.lt(w.player.hp, hp0, '적 탄이 플레이어 HP 를 실제로 깎았다 (§2.3 충돌 배선 확인)');
  });
});
