/**
 * tests/weapons3.test.mjs — v1.10 ㉟ 신설 5종(미사일·체인 라이트닝·빔·핀볼·스파이럴)의 정본 계약.
 *
 * 커버:
 *   미사일   — 정면 발사 · 소멸(적 접촉·수명) 자리에서 blastRadius 안 전 적 피해 · 진화 자탄(evoClusterCount, 다시 안 갈라진다)
 *   체인     — 즉발 · acquireRadius 안 최근접에서 chainRangePx 로 chainCount 홉 · 홉마다 chainDmgMul · 한 볼리에 같은 적 1회
 *   빔       — hitCooldownSec 마다 표적에 dmg · 표적 유지 · 관통(같은 직선 뒤 적) · 진화 갈래
 *   핀볼     — 벽 반사(bounceLeft -1) · 재히트 · 진화 멀티볼(반사마다 +1, evoMaxBalls 상한)
 *   스파이럴 — x 가 amp 안에서 진동 · 줄기 위상 분할 · 진화 진폭·수명
 *   공통     — 전 무기가 레지스트리·드래프트 후보에 있다 · 계열별 후보 수 > 칸 수 · 훅 H5/H6
 */

import { suite, test, assert, loadData, baselineDifficulty } from '../tools/test.mjs';
import { createWorld, recomputeEff, giveWeapon, spawnEnemy, givePassive } from '../src/core/state.js';
import { step, makeInput, TICK_DT } from '../src/core/step.js';
import { weapons } from '../src/core/weapons/index.js';
import { candidates } from '../src/core/draft.js';
import { investElement, recomputeStamps } from '../src/core/stance.js';

const dt = TICK_DT;
function mkWorld(seed = 1) {
  return createWorld({ data: loadData(), seed, weapons, hooks: { enemies: null, emitters: null }, startWeaponId: 'forward',
    difficulty: baselineDifficulty() });
}
function slotOf(world, family) { for (const s of world.slots) if (s.family === family) return s; return null; }
function setup(world, family, level, evolved) {
  if (slotOf(world, family) === null) giveWeapon(world, family);
  for (const s of world.slots) if (s.weaponId !== null && s.family !== family) { s.weaponId = null; s.family = ''; }
  const s = slotOf(world, family);
  s.level = level; s.evolved = !!evolved; s.cooldownT = 0; s.a0 = 0; s.a1 = 0; s.a2 = 0; s.effDirty = true;
  return [s, recomputeEff(world, s)];
}
function live(world, family) { const out = []; for (const b of world.playerBullets.items) if (b.alive && b.family === family) out.push(b); return out; }
function tick(w, n) { for (let i = 0; i < n; i += 1) { w.player.hp = w.player.hpMax; step(w, makeInput(), dt); } }
const dummy = (w, x, y, hp = 1e6) => spawnEnemy(w, 'drifter', 'normal', x, y, hp, false);

suite('weapons3 · 공통 (§9.5 ㉟)', () => {
  test('레지스트리 = weapons.json 전 행 · 드래프트 newWeapon 후보에 신설 무기가 온다 · 시작 무기 풀 = 속성 무기 전부', () => {
    const w = mkWorld();
    const ids = w.data.weapons.weapons.map((x) => x.id);
    // ★ 개수는 데이터가 소유한다 — 무기를 더하거나 빼도(㊵ 스파이럴 삭제) 이 테스트는 «레지스트리 = 데이터»만 본다
    assert.gt(ids.length, 8, `무기 ${ids.length}종`);
    assert.eq(Object.keys(weapons).length, ids.length, '레지스트리 = weapons.json 행 수');
    for (const id of ids) assert.ok(weapons[id] !== undefined && typeof weapons[id].update === 'function', `${id} 모듈`);
    const cs = candidates(w).filter((c) => c.category === 'newWeapon').map((c) => c.weaponId);
    for (const id of ['missile', 'chain', 'beam', 'pinball']) assert.ok(cs.includes(id), `${id} 후보`);   // ㊵ 스파이럴 삭제
    const elem = w.data.weapons.weapons.filter((x) => x.slotClass === 'element').length;
    const util = w.data.weapons.weapons.filter((x) => x.slotClass === 'utility').length;
    assert.eq(elem + util, ids.length, '모든 무기는 속성 또는 무속성이다');
    const rp = w.data.rules.player;
    assert.gt(elem, rp.elementSlots, `속성 무기 ${elem}종 > 속성 칸 ${rp.elementSlots} (고를 여지가 있다)`);
    assert.gt(util, rp.weaponSlots - rp.elementSlots, `무속성 ${util}종 > 유틸 칸 ${rp.weaponSlots - rp.elementSlots}`);
  });

  test('H5 추진기·H6 장기 배터리 — speedKeys/durationKeys 만 곱한다 (미사일 탄속·수명 · 체인은 무효)', () => {
    const w = mkWorld();
    const [sm, e0] = setup(w, 'missile', 1, false);
    const base = w.data.weapons.weapons.find((x) => x.id === 'missile').base;
    assert.eq(e0.projSpeed, base.projSpeed, '패시브 전 = 저작값');
    for (let k = 0; k < 5; k += 1) { givePassive(w, 'booster'); givePassive(w, 'battery'); }
    sm.effDirty = true; const e1 = recomputeEff(w, sm);
    assert.near(e1.projSpeed, base.projSpeed * (1 + w.stats.projSpeedMul), 1e-9, '탄속 ×(1+Σ)');
    assert.near(e1.lifetimeSec, base.lifetimeSec * (1 + w.stats.durationMul), 1e-9, '수명 ×(1+Σ)');
    const w2 = mkWorld(); const [sc, c0] = setup(w2, 'chain', 1, false);
    for (let k = 0; k < 5; k += 1) { givePassive(w2, 'booster'); givePassive(w2, 'battery'); }
    sc.effDirty = true; const c1 = recomputeEff(w2, sc);
    assert.eq(c1.chainRangePx, c0.chainRangePx, '체인엔 무효(키가 없다)');
  });
});

suite('weapons3 · 미사일', () => {
  test('정면으로 날고, 적에 닿아 소멸하는 자리에서 blastRadius 안 전 적이 피해 · 진화면 자탄이 퍼지고 자탄은 다시 안 갈라진다', () => {
    const w = mkWorld();
    const [s, eff] = setup(w, 'missile', 1, false);
    eff.count = 1;                       // ㊳ — 미사일 기본 발사 수가 2로 저작됐다. 이 테스트가 보는 것은 «폭발의 산술»이라 1발로 고정한다.
    const p = w.player;
    const a = dummy(w, p.x, p.y - 200); const b = dummy(w, p.x + eff.blastRadius * 0.7, p.y - 200); const far = dummy(w, p.x + eff.blastRadius * 3, p.y - 200);
    tick(w, Math.round(1.6 / dt));
    assert.lt(a.hp, 1e6, '직격 적 피해'); assert.lt(b.hp, 1e6, '반경 안 이웃도 피해'); assert.eq(far.hp, 1e6, '반경 밖은 무피해');
    assert.near((1e6 - a.hp), 2 * (1e6 - b.hp), 1e-9, '직격 = 탄 + 폭발(2배) · 이웃 = 폭발만');
    const w2 = mkWorld(); const [s2, eff2] = setup(w2, 'missile', 8, true);
    dummy(w2, w2.player.x, w2.player.y - 200);
    let seenChild = 0; let childLife = -1;
    for (let i = 0; i < Math.round(3 / dt); i += 1) { tick(w2, 1); for (const bb of live(w2, 'missile')) if (bb.s0 === 1) { seenChild += 1; childLife = bb.lifetimeSec; } }
    assert.gt(seenChild, 0, '자탄이 나왔다'); assert.near(childLife, eff2.lifetimeSec * 0.5, 1e-9, '자탄 수명 = 절반');
    void s; void s2;
  });

  test('㊲ 패밀리별 피해 스탯 — 충격파(areaDmgMul)는 미사일의 직격·폭발 둘 다 ×(1+v), 벌컨 탄엔 무효 · 고압(beamDmgMul)은 랜스만', () => {
    const run = (fam, passive, n) => {
      const w = mkWorld(); const [sl0] = setup(w, fam, 1, false);
      for (let k = 0; k < n; k += 1) givePassive(w, passive);
      for (const sl of w.slots) sl.effDirty = true;
      const eff = recomputeEff(w, sl0);
      if (fam === 'missile') eff.count = 1;      // ㊳ 산개(spreadDeg)로 단일 표적을 빗나가지 않게 1발 고정(재계산 뒤에 덮는다)
      const t = dummy(w, w.player.x, w.player.y - 200);
      tick(w, Math.round(1.6 / dt));
      return [1e6 - t.hp, eff];
    };
    const v = (id, n) => loadData().passives.passives.find((p) => p.id === id).values[n - 1];
    const [m0] = run('missile', 'shockwave', 0); const [m5] = run('missile', 'shockwave', 5);
    assert.gt(m0, 0, '미사일 기준 피해'); assert.near(m5 / m0, 1 + v('shockwave', 5), 1e-9, '미사일 피해 ×(1 + 충격파 Lv5)');
    const [f0] = run('forward', 'shockwave', 0); const [f5] = run('forward', 'shockwave', 5);
    assert.near(f5, f0, 1e-9, '벌컨 탄은 충격파 무관');
    const [f0b] = run('forward', 'highvolt', 0); const [f5b] = run('forward', 'highvolt', 5);
    assert.near(f5b, f0b, 1e-9, '벌컨 탄은 고압 무관(탄 무기엔 피해 패시브가 없다)');
    const [l0] = run('lance', 'highvolt', 0); const [l5] = run('lance', 'highvolt', 5);
    assert.gt(l0, 0, '랜스 기준 피해'); assert.near(l5 / l0, 1 + v('highvolt', 5), 1e-6, '랜스 피해 ×(1 + 고압 Lv5)');
    const [l0s] = run('lance', 'shockwave', 0); const [l5s] = run('lance', 'shockwave', 5);
    assert.near(l5s, l0s, 1e-9, '랜스는 충격파 무관');
  });
});

suite('weapons3 · 체인 라이트닝', () => {
  test('즉발 — 최근접에서 chainRangePx 로 chainCount 홉, 홉마다 chainDmgMul, 한 볼리에 같은 적은 1회 · 진화는 홉 ×evoChainCountMul', () => {
    const w = mkWorld();
    const [s, eff] = setup(w, 'chain', 1, false);
    const p = w.player;
    const y = p.y - 150;
    const es = []; for (let i = 0; i < 6; i += 1) es.push(dummy(w, p.x + i * (eff.chainRangePx * 0.8), y));
    tick(w, 1);
    const hit = es.filter((e) => e.hp < 1e6);
    assert.eq(hit.length, eff.chainCount, `${eff.chainCount} 마리`);
    for (let i = 0; i + 1 < hit.length; i += 1) assert.ok(1e6 - hit[i + 1].hp < 1e6 - hit[i].hp, `홉 ${i + 1} 피해 < 홉 ${i}`);
    assert.near((1e6 - hit[1].hp) / (1e6 - hit[0].hp), eff.chainDmgMul, 1e-9, '감쇠 = chainDmgMul');
    assert.eq(w.chainFx.count, eff.chainCount, '선분 링 = 이번 틱의 홉 수(렌더가 이 프레임에 읽는다, 다음 step 이 비운다)');
    const w2 = mkWorld(); const [s2, eff2] = setup(w2, 'chain', 8, true);
    // 한 줄(세로)로 세운다 — 탐욕 최근접 경로가 «되돌아오지 않고» 끝까지 이어지게(격자는 모서리에서 끊긴다)
    const es2 = []; const gap = eff2.chainRangePx * 0.6;
    for (let i = 0; i < 12; i += 1) es2.push(dummy(w2, w2.player.x, w2.player.y - 100 - i * gap * 0.5));
    tick(w2, 1);
    assert.eq(es2.filter((e) => e.hp < 1e6).length, Math.round(eff2.chainCount * eff2.evoChainCountMul), '진화 홉 수');
    void s; void s2;
  });

  //  ㊿-zc — 갈라짐의 계약은 **한 적 한 번**이다. 한때 갈래가 잠금을 되돌려 놓아서, 두 번째 줄기가
  //  첫 줄기의 다음 표적을 가로채고 첫 줄기가 그 적을 또 때렸다(홉 10 · 맞은 적 9 = 한 마리가 두 번).
  //  ★ 이 테스트는 «갈라짐이 실제로 일어났음»을 먼저 증명한다 — 안 그러면 분기 없는 한 줄기를 보고 통과한다(공허 통과 = 위반).
  test('갈라짐(폭풍)은 한 적을 두 번 때리지 않는다 — 홉 수 = 피해 입은 서로 다른 적의 수', () => {
    const w = mkWorld();
    const [s, eff] = setup(w, 'chain', 8, true);
    assert.eq(eff.evoForkOnSuper, true, '이 테스트의 전제 = 상성 갈라짐');
    //  각인은 슬롯 앞에서부터 «투자한 수»만큼 내려온다 — 체인이 몇 번 칸이든 닿게 충분히 투자한다(§4.3).
    const [FIRE] = w.data.elements.investable;
    for (let i = 0; i <= s.index; i += 1) investElement(w, FIRE);
    w.player.stance = FIRE; recomputeStamps(w);
    assert.eq(s.stampElement, FIRE, '체인 슬롯에 각인이 닿았다');
    const p = w.player;
    const R = eff.chainRangePx;
    //  불 → 풀 = 상성 ×2 → 홉마다 갈라진다. 서로 전부 사거리 안인 «한 줌»으로 세워 갈래가 겹칠 판을 만든다.
    const es = [];
    for (let i = 0; i < 9; i += 1) {
      es.push(spawnEnemy(w, 'drifter', 'grass', p.x + ((i % 3) - 1) * R * 0.30, p.y - 120 - Math.floor(i / 3) * R * 0.30, 1e9, false));
    }
    tick(w, 1);
    const fx = w.chainFx;
    const hops = fx.count;
    assert.ok(hops > 0, '한 번은 쳤다');
    //  ① 갈라짐이 실제로 일어났는가 — 갈래는 «같은 시작점»에서 두 선분이 나간다(한 줄기면 경로라 시작점이 전부 다르다).
    let shared = 0;
    for (let i = 0; i < hops; i += 1) {
      for (let j = i + 1; j < hops; j += 1) {
        if (fx.buf[i].x1 === fx.buf[j].x1 && fx.buf[i].y1 === fx.buf[j].y1) shared += 1;
      }
    }
    assert.ok(shared > 0, '갈라짐이 실제로 일어났다(같은 점에서 두 선분)');
    //  ② 그래도 한 적은 한 번 — 홉 하나당 서로 다른 적 하나.
    const hit = es.filter((e) => e.hp < 1e9);
    assert.eq(hit.length, hops, '홉 수 = 피해 입은 서로 다른 적의 수(한 적을 두 번 때리면 적 수가 모자란다)');
  });
});

suite('weapons3 · 빔', () => {
  test('hitCooldownSec 마다 표적에 dmg · 표적을 유지한다 · 관통은 같은 직선 뒤 적 · 진화 갈래', () => {
    const w = mkWorld();
    const [s, eff] = setup(w, 'beam', 1, false);
    const p = w.player;
    const t = dummy(w, p.x, p.y - 200);
    const side = dummy(w, p.x + 180, p.y - 200);
    tick(w, Math.round(1 / dt));
    const ticks = Math.floor(1 / eff.hitCooldownSec);
    assert.ok(Math.abs((1e6 - t.hp) / eff.dmg - ticks) <= 2, `1초에 ≈ ${ticks} 회 (실제 ${(1e6 - t.hp) / eff.dmg})`);
    assert.eq(side.hp, 1e6, '두 번째 적은 count 1 이면 안 맞는다');
    assert.eq(s.a0, w.enemies.items.indexOf(t), '슬롯이 표적을 기억한다');
    // 관통 — pierce 를 주면 표적 뒤(같은 직선) 적이 맞는다
    //   ㊲ 관통 코팅은 탄 전용 — 빔의 관통은 자기 레벨(Lv3 pierce 1)에서 온다. 코팅을 줘도 빔의 pierce 는 불변.
    const w2 = mkWorld(); const [s2, eff2] = setup(w2, 'beam', 3, false);
    assert.gt(eff2.pierce, 0, 'Lv3 빔의 자체 관통 > 0');
    for (let k = 0; k < 3; k += 1) givePassive(w2, 'coating'); s2.effDirty = true; const e2 = recomputeEff(w2, s2);
    assert.eq(e2.pierce, eff2.pierce, '관통 코팅은 빔에 무효(탄 전용)');
    const near = dummy(w2, w2.player.x, w2.player.y - 150); const behind = dummy(w2, w2.player.x, w2.player.y - 260); const off = dummy(w2, w2.player.x + 90, w2.player.y - 260);
    tick(w2, 3);
    assert.lt(near.hp, 1e6); assert.lt(behind.hp, 1e6, '직선 뒤 적 관통'); assert.eq(off.hp, 1e6, '직선 밖은 무피해');
    // 진화 — 갈래
    const w3 = mkWorld(); const [s3, eff3] = setup(w3, 'beam', 8, true);
    const c = dummy(w3, w3.player.x, w3.player.y - 150); const n1 = dummy(w3, w3.player.x + eff3.evoSplitRangePx * 0.6, w3.player.y - 150);
    tick(w3, 3);
    assert.lt(n1.hp, 1e6, '갈래가 이웃을 때린다'); assert.lt(c.hp, 1e6);
    void eff; void s3;
  });
});

suite('weapons3 · 핀볼', () => {
  test('벽에 튕긴다(bounceLeft -1) · 오래 남아 재히트 · 진화 멀티볼은 반사마다 +1, evoMaxBalls 상한', () => {
    const w = mkWorld();
    const [s, eff] = setup(w, 'pinball', 1, false);
    assert.eq(eff.bounceLeft, -1, '무제한 반사'); assert.eq(eff.pierce, -1, '관통 무제한');
    let flips = 0; let prev = 0;
    for (let i = 0; i < Math.round(eff.lifetimeSec / dt) - 2; i += 1) { tick(w, 1); const b = live(w, 'pinball')[0]; if (!b) continue; const sg = b.vx >= 0 ? 1 : -1; if (prev !== 0 && sg !== prev) flips += 1; prev = sg; }
    assert.gt(flips, 0, `벽 반사 ${flips}회`);
    // ㊿-t 반사 벽 — 공의 가장자리는 HP·XP 띠(바닥선)를 안 넘고, 상단 띠(반투명 오버레이 = 경기장)에는 들어간다
    //   (사용자(2026-09-12) 「핀볼이 벽에 튕길때, 밑에 있는 HP, 경험치바를 통과?해서 반사되던데?」)
    //   ★ 짝 패시브(장기 배터리 ×3)로 수명을 늘린다 — 맨몸 Lv10(6초)은 천장을 찍고 바닥에 닿기 전에 사라져서 «바닥에서 튀는가»를
    //     못 본다(망가뜨리기 실측: 벽을 아레나로 되돌려도 이 테스트가 초록이었다 — 최대 y 는 발사 높이였을 뿐).
    const wv = mkWorld(); for (let k = 0; k < 3; k += 1) givePassive(wv, 'battery'); setup(wv, 'pinball', 10, false);
    let loY = Infinity; let hiY = -Infinity; let rad = 0; let floorBounces = 0; const prevVy = new Map();
    for (let i = 0; i < Math.round(8 / dt); i += 1) {
      tick(wv, 1);
      for (const b of wv.playerBullets.items) {
        if (!b.alive || b.family !== 'pinball') { prevVy.delete(b); continue; }
        loY = Math.min(loY, b.y); hiY = Math.max(hiY, b.y); rad = Math.max(rad, b.radius);
        const pv = prevVy.get(b);
        if (pv !== undefined && b.age > pv.age && pv.vy > 0 && b.vy < 0) floorBounces += 1;   // 같은 공이 이어서 뒤집혔다 — 풀 재사용을 반사로 세지 않는다
        prevVy.set(b, { vy: b.vy, age: b.age });
      }
    }
    assert.gt(rad, 0, '전제: 공에 반경이 있다');
    assert.gt(floorBounces, 0, `전제: 공이 바닥에서 실제로 되튀었다 (${floorBounces}회)`);
    // ★ world.walls 가 아니라 화면 배치(view)에서 띠 경계를 직접 잰다 — 벽 파생이 틀어지면(띠를 빼먹으면) 이 테스트도 같이 틀어지지 않게
    const vw = wv.data.rules.view;
    const bandTop = vw.arena.y + vw.bandTopH;
    const floorLine = vw.arena.y + vw.arena.h - vw.bandHpH - vw.bandXpH;
    assert.lte(hiY + rad, floorLine, `공의 가장자리가 HP·XP 띠로 안 들어간다 — 바를 덮지 않는다 (최대 y ${hiY.toFixed(1)} + 반경 ${rad} ≤ ${floorLine})`);
    assert.gte(loY - rad, vw.arena.y, `공의 가장자리가 화면 위를 안 넘는다 (최소 y ${loY.toFixed(1)})`);
    assert.lt(loY, bandTop, `공이 상단 띠까지 올라간다 — 상단 띠의 적에게도 닿는다 (최소 y ${loY.toFixed(1)} < ${bandTop})`);
    const w2 = mkWorld(); const [s2, eff2] = setup(w2, 'pinball', 8, true);
    let maxLive = 0;
    for (let i = 0; i < Math.round(eff2.lifetimeSec / dt); i += 1) { tick(w2, 1); const n = live(w2, 'pinball').length; if (n > maxLive) maxLive = n; }
    assert.gt(maxLive, 1, '멀티볼로 늘어난다'); assert.ok(maxLive <= eff2.evoMaxBalls, `상한 ${eff2.evoMaxBalls} (실제 ${maxLive})`);
    void s; void s2;
  });
});

// ─────────────────────────────────────────────────────────────────────────
suite('weapons3 · ㊽ 자동 조준은 «맞힐 수 있는 적»만 고른다 (보호막에 붙던 회귀)', () => {
  test('봉인된 보스 부위에는 빔·체인·시커·옵션이 붙지 않는다 — 열린 표적이 있으면 그쪽을 친다', () => {
    for (const fam of ['beam', 'chain', 'seeker', 'drone']) {
      const w = mkWorld();
      const [s] = setup(w, fam, 5, false);
      const p = w.player;
      // 봉인 부위를 «더 가까이», 열린 잡몹을 조금 멀리 둔다 — 조준이 거리만 보면 봉인 쪽을 고른다
      const sealed = dummy(w, p.x, p.y - 120);
      sealed.isBoss = true; sealed.sealedNow = true; sealed.partId = 'guard'; sealed.partType = 'armament';
      const open = dummy(w, p.x, p.y - 200);
      const hpSealed = sealed.hp; const hpOpen = open.hp;
      tick(w, Math.round(2.5 / dt));
      assert.eq(sealed.hp, hpSealed, `${fam}: 봉인 부위는 무피해`);
      assert.lt(open.hp, hpOpen, `${fam}: 열린 표적을 실제로 때렸다`);
      void s;
    }
  });

  test('랜스는 보호막을 «통과»한다 — 앞을 막은 봉인 부위가 뒤의 적을 가리지 않는다', () => {
    const w = mkWorld();
    setup(w, 'lance', 5, false);
    const p = w.player;
    const sealed = dummy(w, p.x, p.y - 120);
    sealed.isBoss = true; sealed.sealedNow = true; sealed.partId = 'guard'; sealed.partType = 'armament';
    const behind = dummy(w, p.x, p.y - 240);
    const hpSealed = sealed.hp; const hpBehind = behind.hp;
    tick(w, Math.round(2.5 / dt));
    assert.eq(sealed.hp, hpSealed, '봉인 부위는 무피해');
    assert.lt(behind.hp, hpBehind, '뒤의 적은 맞는다(히트 칸을 먹지 않는다)');
  });
});
