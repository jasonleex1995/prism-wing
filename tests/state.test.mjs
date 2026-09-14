/**
 * tests/state.test.mjs — src/core/state.js 계약 단위 테스트
 *
 * 대상 (임무):
 *   · 사전할당 풀: alloc/release 대칭 · 누수 0 · gen 증가 · free 스택 무결 (§10.3 · §12.1)
 *   · spawn* 필드 사상 + 캡 초과 정책 (rejectSpawn/defer/merge, §12.1)
 *   · xpToNext = §9.9 poly, float **무반올림** (§13.5 누적 26,450 검산)
 *   · recomputeEff: levels[] 부분 오버라이드 누적 + 훅 H1~H4 + H3 클램프 (§9.6.1)
 *   · give/levelUp/swap/givePassive + recomputeStats (hp 델타 회복, elementBonusMul 대입)
 *
 * 값은 전부 정본/데이터에서 유도한다 (하드코딩 매직넘버 지양).
 */
import { suite, test, assert, loadData, baselineDifficulty } from '../tools/test.mjs';
import { makePool, createWorld, recomputeStats, recomputeEff, giveWeapon, levelUpWeapon, givePassive, spawnPlayerBullet, spawnEnemy, spawnPickup, spawnEnemyBullet, xpToNext, familyDmgMul } from '../src/core/state.js';
import { weapons } from '../src/core/weapons/index.js';
import { killEnemy } from '../src/core/step.js';

function mk(seed = 1) {
  return createWorld({ data: loadData(), seed, weapons, startWeaponId: 'forward', difficulty: baselineDifficulty() });
}
/** 풀 불변식: free 스택 + live == size, 언제나 (§10.3 무결) */
function poolIntact(p) {
  return p.freeTop + p.live === p.size && p.live >= 0 && p.freeTop >= 0 && p.freeTop <= p.size;
}

// ─────────────────────────────────────────────────────────────────────────
suite('state · pool (§10.3 · §12.1)', () => {
  test('alloc 순서 = 0,1,2… · gen 증가 · live 증가', () => {
    const p = makePool(3, (i) => ({ tag: i }));
    assert.eq(p.size, 3, 'size');
    assert.eq(p.freeTop, 3, '초기 freeTop = size');
    assert.eq(p.live, 0, '초기 live 0');
    const a = p.alloc();
    assert.eq(a.idx, 0, 'pop 순서 0');
    assert.eq(a.gen, 1, 'alloc 시 gen++ (0→1)');
    assert.ok(a.alive, 'alloc 후 alive');
    assert.eq(p.live, 1, 'live 1');
    const b = p.alloc();
    const c = p.alloc();
    assert.eq(b.idx, 1, 'pop 순서 1');
    assert.eq(c.idx, 2, 'pop 순서 2');
    assert.ok(poolIntact(p), '풀 무결');
  });

  test('만석 alloc → null (재활용 금지 계약의 근거)', () => {
    const p = makePool(2, () => ({}));
    p.alloc(); p.alloc();
    assert.eq(p.alloc(), null, '여유 없으면 null');
    assert.eq(p.live, 2, 'null 반환은 live 를 늘리지 않는다');
    assert.ok(poolIntact(p), '풀 무결');
  });

  test('release 대칭 · 재사용 시 gen 재증가 · 누수 0', () => {
    const p = makePool(3, () => ({}));
    const a = p.alloc(); const b = p.alloc(); const c = p.alloc();
    p.release(b);
    assert.ok(!b.alive, 'release 후 !alive');
    assert.eq(p.live, 2, 'live 감소');
    assert.ok(poolIntact(p), 'release 후 무결');
    const e = p.alloc();
    assert.eq(e, b, 'LIFO 재사용 = 방금 반환한 슬롯');
    assert.eq(e.gen, 2, '재사용 시 gen 재증가 (idx 같아도 다른 개체)');
    // 전부 반환 → 누수 0
    p.release(a); p.release(c); p.release(e);
    assert.eq(p.live, 0, '전부 반환 → live 0');
    assert.eq(p.freeTop, 3, 'freeTop = size (누수 0)');
    assert.ok(poolIntact(p), '무결');
  });

  test('release 멱등 — !alive 재반환은 무해 (스택 오염 없음)', () => {
    const p = makePool(2, () => ({}));
    const a = p.alloc();
    p.release(a);
    const topBefore = p.freeTop; const liveBefore = p.live;
    p.release(a);                 // 두 번째 release
    assert.eq(p.freeTop, topBefore, 'freeTop 불변 (이중 반환 무시)');
    assert.eq(p.live, liveBefore, 'live 불변');
    assert.ok(poolIntact(p), '무결 — free 스택 오염 없음');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('state · xpToNext (§9.9 · §13.5)', () => {
  test('poly: L→L+1 = base × L^exp', () => {
    const w = mk();
    const { base, exp } = w.data.meta.xp;
    assert.near(xpToNext(w, 1), base * Math.pow(1, exp), 1e-12, 'L1');
    assert.near(xpToNext(w, 10), base * Math.pow(10, exp), 1e-9, 'L10');
    assert.eq(xpToNext(w, 1), base, 'L1 = base');
  });

  test('float — 레벨별 반올림이 없다', () => {
    const w = mk();
    const v = xpToNext(w, 10);        // 6×10^1.32 = 125.357…
    assert.ne(v, Math.round(v), '반올림된 정수가 아니다');
    assert.ne(v, Math.floor(v), '내림된 값도 아니다');
  });

  test('§13.5 누적 검산 Σ_{L=1}^{53} = 26,450 (연속 합)', () => {
    const w = mk();
    let sum = 0;
    for (let L = 1; L <= 53; L += 1) sum += xpToNext(w, L);
    assert.eq(Math.round(sum), 26450, '누적 XP(Lv54) 반올림 = 26,450');
    // 반올림 누산이었다면 이 연속 합이 어긋난다 → float 독법의 회귀 가드
    assert.ne(sum, Math.round(sum), '합 자체는 정수가 아니다 (float 누산)');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('state · spawn* 필드 + 캡 정책 (§12.1)', () => {
  test('spawnPlayerBullet 필드 사상 + hitEpoch 세대 교체', () => {
    const w = mk();
    const slot = w.slots[0];                       // forward
    const eff = recomputeEff(w, slot);
    const b = spawnPlayerBullet(w, slot, eff, 500, 400, 10, -20, 1);
    assert.eq(b.family, 'forward', 'family');
    assert.eq(b.slot, slot.index, 'slot index');
    assert.eq(b.dmg, eff.dmg, 'dmg = eff.dmg');
    assert.eq(b.radius, eff.projRadius, 'radius = eff.projRadius');
    assert.eq(b.pierceLeft, eff.pierce, 'pierceLeft = eff.pierce');
    assert.eq(b.element, slot.stampElement, 'element = 슬롯 각인 (§4.4 spawn)');
    assert.eq(b.stampMode, w.data.weapons.weapons.find((x) => x.family === 'forward').elementStampMode, 'stampMode = 무기 정의');
    assert.eq(b.x, 500, 'x'); assert.eq(b.vy, -20, 'vy');
    const e1 = b.hitEpoch;
    w.playerBullets.release(b);
    const b2 = spawnPlayerBullet(w, slot, eff, 0, 0, 0, 0, 1);
    assert.eq(b2, b, 'LIFO 재사용');
    assert.eq(b2.hitEpoch, e1 + 1, 'spawn 마다 hitEpoch +1 (배열 클리어 불필요)');
  });

  test('spawnPlayerBullet 초과 = rejectSpawn (null + capHits)', () => {
    const w = mk();
    const slot = w.slots[0];
    const eff = recomputeEff(w, slot);
    const cap = w.data.rules.caps.playerBullets;
    // 풀을 정확히 채운다 (createWorld 직후 playerBullets 는 비어 있다)
    let ok = 0;
    for (let i = 0; i < cap; i += 1) if (spawnPlayerBullet(w, slot, eff, 0, 0, 0, 0, 1) !== null) ok += 1;
    assert.eq(ok, cap, '캡까지 전부 성공');
    const over = spawnPlayerBullet(w, slot, eff, 0, 0, 0, 0, 1);
    assert.eq(over, null, '초과 spawn = null (오래된 것 재활용 금지)');
    assert.eq(w.capHits.playerBullet, 1, 'capHits.playerBullet 발화 1');
  });

  test('spawnEnemy — element 주입 + 엘리트 접두 배율 (§8.6)', () => {
    const w = mk();
    const def = w.data.enemies.archetypes.find((a) => a.id === 'columnAnt');
    const el = w.data.rules.elite;
    const normal = spawnEnemy(w, 'columnAnt', 'fire', 100, 200, def.hp, false);
    assert.eq(normal.element, 'fire', 'element 는 편성이 주입한다 (아키타입 필드 아님)');
    assert.eq(normal.hp, def.hp, '비엘리트 hp = 전달값');
    assert.eq(normal.radius, def.radius, '비엘리트 radius');
    assert.ok(!normal.elite, '비엘리트 플래그');
    const elite = spawnEnemy(w, 'columnAnt', 'water', 100, 200, def.hp, true);
    assert.eq(elite.hp, def.hp * el.hpMult, '엘리트 hp ×hpMult');
    assert.eq(elite.hpMax, elite.hp, 'hpMax = hp');
    assert.eq(elite.radius, def.radius * el.sizeMult, '엘리트 radius ×sizeMult');
    assert.eq(elite.contactDmg, def.contactDmg * el.contactDmgMul, '엘리트 contactDmg ×mul');
    // §8.6 — xp 는 스테이지 XP 배율(curve.xpScale)도 탄다. 런이 없는 월드 = 포지션 0.
    const xpS = w.data.stages.curve.xpScale[0];
    assert.near(elite.xp, def.xp * el.xpMult * xpS, 1e-9, '엘리트 xp ×mul ×xpScale');
    assert.eq(elite.coin, el.coin, '엘리트 coin = elite.coin (확정)');
  });

  test('spawnEnemy 초과 = defer (null + capHits) · 미지 아키타입 throw', () => {
    const w = mk();
    const cap = w.data.rules.caps.enemies;
    for (let i = 0; i < cap; i += 1) assert.ok(spawnEnemy(w, 'drifter', 'normal', 0, 0, 6, false) !== null, 'i');
    assert.eq(spawnEnemy(w, 'drifter', 'normal', 0, 0, 6, false), null, '초과 = null (defer)');
    assert.eq(w.capHits.enemy, 1, 'capHits.enemy 발화 1');
    assert.throws(() => spawnEnemy(mk(), 'no-such', 'normal', 0, 0, 6, false), '미지 아키타입 throw (폴백 금지)');
  });

  test('spawnEnemyBullet — hitRadius = radius×hitboxScale · status 사상 (§2.3)', () => {
    const w = mk();
    const pel = w.data.bullets.bullets.find((b) => b.id === 'pelletS');
    const b = spawnEnemyBullet(w, 'pelletS', 300, 300, 0, 120);
    assert.eq(b.dmg, pel.dmg, 'dmg');
    assert.eq(b.radius, pel.radius, 'radius');
    assert.near(b.hitRadius, pel.radius * pel.hitboxScale, 1e-12, 'hitRadius = radius × hitboxScale');
    assert.eq(b.status, null, 'pelletS status null');
    const hex = w.data.bullets.bullets.find((b2) => b2.id === 'hexBolt');
    const hb = spawnEnemyBullet(w, 'hexBolt', 0, 0, 0, 0);
    assert.eq(hb.status, hex.status, 'hexBolt status = slow');
    assert.eq(hb.statusDurationSec, hex.statusDurationSec, 'statusDuration 사상');
    assert.throws(() => spawnEnemyBullet(w, 'no-bullet', 0, 0, 0, 0), '미지 탄 throw');
  });

  test('spawnPickup 초과 = merge (손실 0 — 값을 최근접에 합산)', () => {
    const w = mk();
    const cap = w.data.rules.caps.pickups;
    for (let i = 0; i < cap; i += 1) assert.ok(spawnPickup(w, 'xp', 1, 0, 0) !== null, 'fill');
    const merged = spawnPickup(w, 'xp', 5, 0, 0);   // 만석 → 최근접 동종에 합산
    assert.eq(merged, w.pickups.items[0], '최근접(동점 = 낮은 인덱스) 픽업 반환');
    assert.eq(merged.value, 6, '값 합산 1 + 5 = 6 (손실 0)');
    assert.eq(w.capHits.pickup, 1, 'capHits.pickup 발화 1');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('state · recomputeEff 훅 (§9.6.1)', () => {
  test('levels[] 부분 오버라이드 누적 — base 가 아니라 src 를 읽는다 (문면 결함 회귀)', () => {
    const w = mk();
    const i = giveWeapon(w, 'seeker');
    const s = w.slots[i];
    for (let k = 0; k < 4; k += 1) levelUpWeapon(w, i);   // Lv1 → Lv5
    const e5 = recomputeEff(w, s);
    assert.eq(e5.count, 3, 'seeker Lv5 count = 3 (levels[4]) — base 1 이 아니다');
    for (let k = 0; k < 2; k += 1) levelUpWeapon(w, i);   // → Lv7
    s.effDirty = true;
    const e7 = recomputeEff(w, s);
    assert.eq(e7.pierce, 1, 'seeker Lv7 pierce = 1 (levels[6]) — 증발하지 않는다');
    // ★ 하드코딩 대신 데이터에서 «해소»한다(튜닝에 강함): Lv7 의 dmg = base ∪ levels[0..6] 중 마지막으로 정의된 값.
    //   특정 행(levels[5])이 dmg 를 갖는다고 가정하면 밸런스 재저작(㊳ 곡선 기울이기)에서 깨진다 — 규칙을 검사하지 값을 검사하지 않는다.
    const sk = w.data.weapons.weapons.find((x) => x.id === 'seeker');
    let wantDmg = sk.base.dmg;
    for (let L = 0; L < 7; L += 1) if (typeof sk.levels[L].dmg === 'number') wantDmg = sk.levels[L].dmg;
    assert.eq(e7.dmg, wantDmg, `Lv7 dmg = ${wantDmg} (levels[0..6] 의 마지막 dmg 오버라이드가 상속된다)`);
  });

  test('forward levels[4] = {count:2, spreadDeg:6} 누적 (양성)', () => {
    const w = mk();
    const s = w.slots[0];                                 // forward Lv1
    for (let k = 0; k < 4; k += 1) levelUpWeapon(w, 0);   // → Lv5
    s.effDirty = true;
    const e = recomputeEff(w, s);
    assert.eq(e.count, 2, 'Lv5 count 2');
    assert.eq(e.spreadDeg, 6, 'Lv5 spreadDeg 6');
    // 값이 아니라 «상속 규칙»을 검사한다 — base ∪ levels[0..4] 의 마지막 dmg 오버라이드(㊳ 밸런스 재저작에 강하다)
    const fw = w.data.weapons.weapons.find((x) => x.id === 'forward');
    let wantDmg5 = fw.base.dmg;
    for (let L = 0; L < 5; L += 1) if (typeof fw.levels[L].dmg === 'number') wantDmg5 = fw.levels[L].dmg;
    assert.eq(e.dmg, wantDmg5, `Lv5 dmg = ${wantDmg5} (levels[0..4] 의 마지막 오버라이드 상속)`);
  });

  test('H1 fireRateMul — 주기 = base / (1 + fireRateMul)', () => {
    const w = mk();
    const s = w.slots[0];
    const base = w.data.weapons.weapons.find((x) => x.family === 'forward').base.cooldownSec;
    w.stats.fireRateMul = 1;                              // 발사 속도 ×2 → 주기 ½
    s.effDirty = true;
    const e = recomputeEff(w, s);
    assert.near(e.cooldownSec, base / 2, 1e-12, 'cooldownSec /(1+1)');
  });

  test('H2 areaMul — areaKeys 만 ×(1+areaMul): 범위 무기(노바 반경·미사일 폭발)만 커지고 벌컨 탄·산포·오빗 궤도는 불변 (㊲ 코일 = 범위 전용)', () => {
    const w = mk();
    const s = w.slots[0];                                 // forward — areaKeys [] (㉚)
    const baseR = w.data.weapons.weapons.find((x) => x.family === 'forward').base.projRadius;
    w.stats.areaMul = 0.5;
    s.effDirty = true;
    const e = recomputeEff(w, s);
    assert.eq(e.projRadius, baseR, '벌컨 탄 크기 불변 (코일 무효)');
    assert.eq(e.jitterDeg, 1.5, 'jitterDeg(산포) 는 areaKeys 밖 → 불변');
    const oi = giveWeapon(w, 'orbit');
    const ob = w.data.weapons.weapons.find((x) => x.family === 'orbit').base;
    const eo = recomputeEff(w, w.slots[oi]);
    assert.eq(eo.orbitRadius, ob.orbitRadius, '오빗 궤도는 코일 밖(㊲ 궤도 확장의 것)');
    const mi = giveWeapon(w, 'missile');
    const mb = w.data.weapons.weapons.find((x) => x.family === 'missile').base;
    const em = recomputeEff(w, w.slots[mi]);
    assert.near(em.blastRadius, mb.blastRadius * 1.5, 1e-12, '미사일 폭발 반경 ×1.5 (범위 훅)');
    assert.eq(em.projRadius, mb.projRadius, '미사일 탄 자체는 불변');
  });

  test('H8 orbitMul(궤도 확장) — orbitKeys(오빗 궤도·구체·공전 속도 / 옵션 사거리)만 ×(1+orbitMul) (㊲)', () => {
    const w = mk();
    const oi = giveWeapon(w, 'orbit');
    const ob = w.data.weapons.weapons.find((x) => x.family === 'orbit').base;
    w.stats.orbitMul = 0.5;
    w.slots[oi].effDirty = true;
    const eo = recomputeEff(w, w.slots[oi]);
    assert.near(eo.orbitRadius, ob.orbitRadius * 1.5, 1e-12, '오빗 궤도 ×1.5');
    assert.near(eo.angularSpeedDegSec, ob.angularSpeedDegSec * 1.5, 1e-12, '공전 속도 ×1.5');
    assert.near(eo.projRadius, Math.min(ob.projRadius * 1.5, w.data.rules.render.playerBulletMaxRadiusPx), 1e-12, '구체도 ×1.5 (클램프 안)');
    const di = giveWeapon(w, 'drone');
    const db = w.data.weapons.weapons.find((x) => x.family === 'drone').base;
    const ed = recomputeEff(w, w.slots[di]);
    assert.near(ed.droneRangePx, db.droneRangePx * 1.5, 1e-12, '옵션 사거리 ×1.5');
    assert.eq(ed.projSpeed, db.projSpeed, '옵션 탄속은 탄 훅(추진기) 밖 → 불변');
    w.slots[0].effDirty = true;
    assert.eq(recomputeEff(w, w.slots[0]).projRadius, w.data.weapons.weapons.find((x) => x.family === 'forward').base.projRadius, '벌컨 무관');
  });

  test('H7 beamAreaMul(집속 렌즈) — beamKeys(빔 폭·사거리 / 체인 도약·탐지)만 ×(1+beamAreaMul) · 탄 무기 무관 (㊲)', () => {
    const w = mk();
    w.stats.beamAreaMul = 0.25;
    const bi = giveWeapon(w, 'beam');
    const bb = w.data.weapons.weapons.find((x) => x.family === 'beam').base;
    const eb = recomputeEff(w, w.slots[bi]);
    assert.near(eb.beamWidthPx, bb.beamWidthPx * 1.25, 1e-12, '빔 폭 ×1.25');
    assert.near(eb.rangePx, bb.rangePx * 1.25, 1e-12, '빔 사거리 ×1.25');
    const ci = giveWeapon(w, 'chain');
    const cb = w.data.weapons.weapons.find((x) => x.family === 'chain').base;
    const ec = recomputeEff(w, w.slots[ci]);
    assert.near(ec.chainRangePx, cb.chainRangePx * 1.25, 1e-12, '체인 도약 거리 ×1.25');
    assert.near(ec.acquireRadius, cb.acquireRadius * 1.25, 1e-12, '체인 탐지 반경 ×1.25');
    w.slots[0].effDirty = true;
    const ef = recomputeEff(w, w.slots[0]);
    assert.eq(ef.projRadius, w.data.weapons.weapons.find((x) => x.family === 'forward').base.projRadius, '벌컨 무관');
  });

  test('H3 projRadius 클램프 = render.playerBulletMaxRadiusPx (오빗 구체 — 궤도 확장으로 키워도)', () => {
    const w = mk();
    const oi = giveWeapon(w, 'orbit');
    const s = w.slots[oi];
    const maxR = w.data.rules.render.playerBulletMaxRadiusPx;
    w.stats.orbitMul = 5;                                 // 7 × 6 = 42 → 클램프
    s.effDirty = true;
    const e = recomputeEff(w, s);
    assert.eq(e.projRadius, maxR, 'projRadius 클램프 10');
  });

  test('pierceAdd — pierceApplies true 만 적용 (forward +, orbit 무효)', () => {
    const w = mk();
    w.stats.pierceAdd = 2;
    const s0 = w.slots[0];                                // forward: pierceApplies true, base pierce 0
    s0.effDirty = true;
    assert.eq(recomputeEff(w, s0).pierce, 2, 'forward pierce 0 + 2');
    const oi = giveWeapon(w, 'orbit');                    // orbit: pierceApplies false, base 에 pierce 없음
    const so = w.slots[oi];
    const eo = recomputeEff(w, so);
    assert.eq(eo.pierce, undefined, 'orbit 은 pierceApplies false → pierce 미생성 (NaN 오염 없음)');
  });

  test('H4 countKey — null 이면 무효 (aura), 아니면 +projCountAdd (forward)', () => {
    const w = mk();
    w.stats.projCountAdd = 3;
    const s0 = w.slots[0];                                // forward countKey "count", base 1
    s0.effDirty = true;
    assert.eq(recomputeEff(w, s0).count, 1 + 3, 'forward count 1 + 3');
    const ai = giveWeapon(w, 'aura');                     // aura countKey null
    const ea = recomputeEff(w, w.slots[ai]);
    assert.eq(ea.count, undefined, 'aura 는 countKey null → count 미생성');
  });

  test('진화 시 evolution.params 합집합 + areaKeys (nova evoRing2Radius) · 팬의 evoBlastRadius 는 코일 밖(㉚)', () => {
    const w = mk();
    const i = giveWeapon(w, 'nova');
    const s = w.slots[i];
    for (let k = 0; k < 7; k += 1) levelUpWeapon(w, i);   // Lv1 → Lv8 = evolved
    assert.ok(s.evolved, 'Lv8 = evolved');
    const ep = w.data.weapons.weapons.find((x) => x.family === 'nova').evolution.params;
    w.stats.areaMul = 1;                                  // ×2
    s.effDirty = true;
    const e = recomputeEff(w, s);
    assert.near(e.evoRing2Radius, ep.evoRing2Radius * 2, 1e-12, 'evoRing2Radius (진화 전용) ×(1+areaMul)');
    assert.eq(e.evoSecondaryDmgMul, ep.evoSecondaryDmgMul, 'evoSecondaryDmgMul 합집합 (areaKeys 아님 → 불변)');
    const fi = giveWeapon(w, 'fan'); const fs = w.slots[fi];
    for (let k = 0; k < 7; k += 1) levelUpWeapon(w, fi);
    const fp = w.data.weapons.weapons.find((x) => x.family === 'fan').evolution.params;
    assert.eq(recomputeEff(w, fs).evoBlastRadius, fp.evoBlastRadius, '팬 폭발 반경은 코일 무효(㉚)');
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('state · 성장 give/levelUp/swap/passive', () => {
  test('giveWeapon — 가장 앞의 빈 슬롯에 append, 만석 = -1', () => {
    const w = mk();                                       // slot0 = forward (startWeapon)
    assert.eq(w.slots[0].family, 'forward', '시작 무기');
    // §11.1(v1.6) 슬롯은 계열로 나뉜다 — 속성 0..eSlots-1 · 유틸 eSlots..weaponSlots-1 (v1.10 ⑱: 4 + 2 = 6).
    const eSlots = w.data.rules.player.elementSlots;
    const nSlots = w.data.rules.player.weaponSlots;
    assert.eq(giveWeapon(w, 'fan'), 1, '속성 append slot1');
    assert.eq(giveWeapon(w, 'seeker'), 2, '속성 append slot2');
    if (eSlots > 3) assert.eq(giveWeapon(w, 'lance'), 3, '속성 append slot3');
    assert.eq(giveWeapon(w, 'boomerang'), -1, `속성 ${eSlots}칸 만석 → -1 (유틸칸으로 새지 않는다)`);
    assert.eq(giveWeapon(w, 'orbit'), eSlots, '유틸은 유틸칸 첫 자리');
    assert.eq(giveWeapon(w, 'aura'), eSlots + 1, '유틸 append');
    assert.eq(nSlots - eSlots, 2, '유틸 2칸');
    assert.eq(giveWeapon(w, 'nova'), -1, '유틸 2칸 만석 → -1');
    assert.throws(() => giveWeapon(w, 'no-weapon'), '미지 무기 throw');
  });

  test('levelUpWeapon — Lv8 에서 evolved, Lv9·10 은 진화체 강화, Lv10 종료, 빈 슬롯 throw (v1.10 ⑱)', () => {
    const w = mk();
    for (let k = 1; k < 8; k += 1) { assert.ok(levelUpWeapon(w, 0), `Lv${k}→${k + 1}`); if (k < 7) assert.eq(w.slots[0].evolved, false, `Lv${k + 1} 은 아직 진화 전`); }
    assert.eq(w.slots[0].level, 8, 'Lv8 도달');
    assert.ok(w.slots[0].evolved, 'Lv8 = evolved');
    assert.ok(levelUpWeapon(w, 0), 'Lv9 (진화체 강화)');
    assert.ok(levelUpWeapon(w, 0), 'Lv10');
    assert.eq(w.slots[0].level, 10, 'Lv10 도달');
    assert.ok(w.slots[0].evolved, '여전히 evolved');
    assert.eq(levelUpWeapon(w, 0), false, 'Lv10 에서 종료 (Lv11 없음)');
    assert.throws(() => levelUpWeapon(w, 5), '빈 슬롯 레벨업 throw');
  });

  test('시작 시 시작 무기의 진화 짝 패시브가 Lv1 로 있다 (㉚)', () => {
    const w = mk();                                       // forward → overclock
    const req = w.data.weapons.weapons.find((x) => x.id === 'forward').evolution.requiresPassive;
    assert.eq(w.passives[0].id, req.id, `slot0 = 짝 패시브 ${req.id}`);
    assert.eq(w.passives[0].level, 1, 'Lv1');
    assert.eq(w.passives.filter((p) => p.id !== null).length, 1, '딱 하나');
    // 추첨 시작(무기 미지정)도 같다 — 그 무기의 짝
    const w2 = createWorld({ data: loadData(), seed: 7, weapons });
    const sw = w2.slots.find((sl) => sl.weaponId !== null);
    const req2 = w2.data.weapons.weapons.find((x) => x.id === sw.weaponId).evolution.requiresPassive;
    assert.eq(w2.passives[0].id, req2.id, `추첨 시작 무기 ${sw.weaponId} 의 짝 ${req2.id}`);
  });

  test('givePassive — 획득/레벨업 같은 카테고리, maxLevel 상한, 만석 = false', () => {
    const w = mk();                                       // slot0 = overclock(시작 짝, ㉚)
    const maxL = w.data.passives.maxLevel;
    assert.ok(givePassive(w, 'highvolt'), '신규 획득');
    assert.eq(w.passives[1].id, 'highvolt', 'slot1 = highvolt');
    assert.eq(w.passives[1].level, 1, 'Lv1');
    for (let k = 1; k < maxL; k += 1) assert.ok(givePassive(w, 'highvolt'), `Lv${k}→${k + 1}`);
    assert.eq(w.passives[1].level, maxL, 'maxLevel 도달');
    assert.eq(givePassive(w, 'highvolt'), false, 'maxLevel 초과 = false');
    // 만석 채우고 신규 = false — 칸수는 rules 에서 끌어온다(하드코딩 금지)
    const nSlots = w.data.rules.player.passiveSlots;
    const others = ['coil', 'coating', 'autoload', 'resonance', 'study'];
    for (let k = 0; k < nSlots - 2; k += 1) assert.ok(givePassive(w, others[k]), `채움 ${others[k]}`);
    assert.eq(w.passives.length, nSlots, `${nSlots}칸 만석`);
    assert.eq(givePassive(w, 'stabilizer'), false, '만석 + 미보유 신규 = false');
  });

  test('recomputeStats — maxHpAdd 는 hpMax 를 올리고 그 델타만큼만 hp 회복', () => {
    const w = mk();
    const base = w.data.rules.player.hpMax;
    assert.eq(w.player.hpMax, base, '시작 hpMax = base 100');
    assert.eq(w.player.hp, base, '시작 hp = full');
    givePassive(w, 'bulkhead');                           // maxHpAdd 6
    const add1 = w.data.passives.passives.find((p) => p.id === 'bulkhead').values[0];
    assert.eq(w.player.hpMax, base + add1, 'hpMax += 6');
    assert.eq(w.player.hp, base + add1, 'full 이었으므로 델타만큼 회복 → full 유지');
    // 손상 후 레벨업 → **델타만** 회복 (풀피 아님)
    w.player.hp = 50;
    givePassive(w, 'bulkhead');                           // maxHpAdd 6 → 12
    const add2 = w.data.passives.passives.find((p) => p.id === 'bulkhead').values[1];
    assert.eq(w.player.hpMax, base + add2, 'hpMax = 100 + 12');
    assert.eq(w.player.hp, 50 + (add2 - add1), 'hp += (신규 델타 6) = 56, 풀피 아님');
  });

  test('recomputeStats — elementBonusMul 은 대입(k), 나머지는 가산 풀', () => {
    const w = mk();
    assert.eq(w.stats.elementBonusMul, 1, '기본 k = 1 (곱의 항등원)');
    assert.eq(w.stats.beamDmgMul, 0, '기본 가산항 0');
    givePassive(w, 'resonance');                          // elementBonusMul values[0] = 1.10
    const v = w.data.passives.passives.find((p) => p.id === 'resonance').values[0];
    assert.eq(w.stats.elementBonusMul, v, 'k 는 대입 (1 + 1.10 이 아니다)');
    givePassive(w, 'highvolt');
    const d = w.data.passives.passives.find((p) => p.id === 'highvolt').values[0];
    assert.eq(w.stats.beamDmgMul, d, 'beamDmgMul 가산 풀 = 0.10');
    // ㊲ familyDmgMul — dmgStat 이 고른 스탯만 (빔 = beamDmgMul · 탄 = 0 · 미사일/노바 = areaDmgMul)
    assert.eq(familyDmgMul(w, 'lance'), d, '랜스 = beamDmgMul');
    assert.eq(familyDmgMul(w, 'forward'), 0, '벌컨 = 피해 패시브 없음');
    givePassive(w, 'shockwave');
    const sv = w.data.passives.passives.find((p) => p.id === 'shockwave').values[0];
    assert.eq(familyDmgMul(w, 'missile'), sv, '미사일 = areaDmgMul');
    assert.eq(familyDmgMul(w, 'nova'), sv, '노바 = areaDmgMul');
    assert.eq(familyDmgMul(w, 'aura'), 0, '펄스필드 = 피해 없음');
    assert.throws(() => { const x = mk(); x.passives[0] = { id: 'ghost', level: 1 }; recomputeStats(x); }, '미지 패시브 throw');
  });
});

// §2.6(v1.7) — 「화면 밖에서 적이 죽으면 경험치를 못 먹는다」(플레이 피드백).
//   이탈 몰수(§8.7)와는 다른 문제다: 그건 «안 죽인 것»의 보상이고, 이건 «죽인 것»의 보상이다.
//   죽였는데 못 먹는 것은 규칙이 아니라 사고다.
suite('state · 픽업은 «닿을 수 있는 곳»에 떨어진다 (§2.6 v1.7)', () => {
  test('아레나 가장자리·바깥에서 죽어도 픽업은 이동 가능 영역 안이다', () => {
    const w = mk();
    const b = w.bounds;
    const a = w.data.rules.view.arena;
    const spots = [
      [a.x + 2, a.y + 2], [a.x + a.w - 2, a.y + a.h - 2],
      [a.x - 40, a.y + 300], [a.x + a.w / 2, a.y + a.h + 30],
    ];
    for (const [x, y] of spots) {
      const e = spawnEnemy(w, 'drifter', 'normal', x, y, 1, false, false);
      killEnemy(w, e);
      const live = w.pickups.items.filter((q) => q.alive);
      const q = live[live.length - 1];
      assert.ok(q !== undefined, '픽업이 생겼다');
      assert.ok(q.x >= b.minX && q.x <= b.maxX, `x 가 이동 가능 영역 안 (${q.x})`);
      assert.ok(q.y >= b.minY && q.y <= b.maxY, `y 가 이동 가능 영역 안 (${q.y})`);
    }
  });
});
