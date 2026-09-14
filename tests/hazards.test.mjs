/**
 * tests/hazards.test.mjs — §8.5 zone(장판) · laser(빔) 인프라 (step.hazards + state.spawnZone/spawnBeam).
 *
 * 정본 계약:
 *   - 피해는 **적용 1회 = dmg**이며 i-frame 이 게이트한다("zone 의 dps 는 존재하지 않는다", §8.5).
 *   - 수명(activeSec)이 다하면 반납. 새 풀 없이 zones/telegraphs 풀을 재사용한다(§12.1 S2).
 *   - fromPlayer 장판(무기 A2)은 플레이어를 때리지 않는다.
 *   - 빔은 원점에서 a 방향 **반직선** — 뒤쪽·폭 밖은 맞지 않는다.
 */

import { suite, test, assert, loadData } from '../tools/test.mjs';
import { createWorld, spawnZone, spawnBeam, giveWeapon, spawnEnemyBullet } from '../src/core/state.js';
import { step, makeInput, TICK_DT } from '../src/core/step.js';
import { foldWall } from '../src/core/bot.js';
import { weapons } from '../src/core/weapons/index.js';

function mkWorld(seed = 1) { return createWorld({ data: loadData(), seed, weapons, hooks: {} }); }
function liveBeams(w) { let n = 0; for (const t of w.telegraphs.items) if (t.alive && t.kind === 'laser') n += 1; return n; }

suite('hazards/zone 장판 (§8.5)', () => {
  test('안에 있으면 피격, 그리고 i-frame 이 게이트한다(적용 1회 · dps 없음)', () => {
    const w = mkWorld(); const p = w.player;
    const z = spawnZone(w, p.x, p.y, 60, 10, 1.0, false);
    assert.ok(z, '장판 스폰');
    assert.eq(w.zones.live, 1, '장판 1개');
    p.iframeSec = 0;
    const hp0 = p.hp;
    step(w, makeInput(), TICK_DT);
    assert.lt(p.hp, hp0, '장판 안 = 피격');
    const hp1 = p.hp;
    step(w, makeInput(), TICK_DT);
    assert.eq(p.hp, hp1, 'i-frame 게이트 — 연속 틱에 추가 피해 없음');
  });

  test('반경 밖은 무피격', () => {
    const w = mkWorld(); const p = w.player;
    spawnZone(w, p.x + 500, p.y, 40, 10, 1.0, false);
    p.iframeSec = 0;
    const hp0 = p.hp;
    step(w, makeInput(), TICK_DT);
    assert.eq(p.hp, hp0, '반경 밖 = 무피격');
  });

  test('activeSec 경과 후 반납', () => {
    const w = mkWorld();
    spawnZone(w, 0, 0, 40, 10, 0.2, false);
    assert.eq(w.zones.live, 1, '살아있음');
    for (let t = 0; t < 20; t += 1) step(w, makeInput(), TICK_DT);   // 0.33s > 0.2s
    assert.eq(w.zones.live, 0, 'activeSec 후 반납');
  });

  test('fromPlayer 장판은 플레이어를 때리지 않는다 (무기 A2 용도)', () => {
    const w = mkWorld(); const p = w.player;
    spawnZone(w, p.x, p.y, 60, 10, 1.0, true);
    p.iframeSec = 0;
    const hp0 = p.hp;
    step(w, makeInput(), TICK_DT);
    assert.eq(p.hp, hp0, '플레이어 장판은 플레이어에게 무해');
  });

  test('§8.5 mortar 퓨즈 — warnSec 동안 무해, 그 뒤 폭발 피해, warnSec+activeSec 에 반납', () => {
    const w = mkWorld(); const p = w.player;
    const warnSec = 0.5, activeSec = 0.3;
    spawnZone(w, p.x, p.y, 60, 10, activeSec, false, '', warnSec);   // 발밑 퓨즈 폭탄(warnSec 9번째 인자)
    const hp0 = p.hp;
    for (let t = 0; t < 18; t += 1) { p.iframeSec = 0; step(w, makeInput(), TICK_DT); }   // ~0.30s < warnSec
    assert.eq(p.hp, hp0, '퓨즈 동안 무해(회피 창)');
    assert.eq(w.zones.live, 1, '폭발 전이라 살아있음');
    for (let t = 0; t < 15; t += 1) { p.iframeSec = 0; step(w, makeInput(), TICK_DT); }   // ~0.55s > warnSec
    assert.lt(p.hp, hp0, '퓨즈 경과 후 = 폭발 피해');
    for (let t = 0; t < 30; t += 1) step(w, makeInput(), TICK_DT);                         // > warnSec+activeSec
    assert.eq(w.zones.live, 0, 'warnSec+activeSec 후 반납');
  });
});

// §8.5/§9.6(v1.7) 벽 반사 — 이 테스트가 지키는 것은 «반사가 일어난다»가 아니라
//   «봇의 닫힌 형태 외삽이 실제 궤적과 일치한다»이다. 어긋나면 봇이 탄 속으로 피하고,
//   그 위에서 잰 시뮬 수치 전체가 밸런스 판단의 근거로 썩는다.
suite('bounce/벽 반사 (§8.5 v1.7)', () => {
  test('적 탄이 반사 벽에서 되튄다 — 컬링 경계가 아니라 «벽»에서', () => {
    const w = mkWorld();
    const a = w.data.rules.view.arena;
    const b = spawnEnemyBullet(w, 'ricochet', a.x + 20, a.y + 200, -300, 0, '');
    assert.ok(b, '반사탄 스폰');
    assert.eq(b.bounceLeft, -1, 'ricochet 은 무제한 반사(S43)');
    for (let t = 0; t < 30; t += 1) step(w, makeInput(), TICK_DT);
    assert.ok(b.alive, '벽에서 사라지지 않는다');
    assert.gt(b.vx, 0, '★ 왼쪽 벽에서 되튀어 속도 부호가 뒤집혔다');
    assert.gte(b.x, w.walls.x + b.radius, '벽 안으로 되접혔다 — 가장자리가 벽 안이고, 파고든 채 들러붙지 않는다');
  });

  test('반사 예산 0 인 탄은 안 튀고 그대로 나간다 (기본값 = 현행 동작)', () => {
    const w = mkWorld();
    const a = w.data.rules.view.arena;
    const b = spawnEnemyBullet(w, 'pelletS', a.x + 20, a.y + 200, -300, 0, '');
    assert.eq(b.bounceLeft, 0, '미선언 = 0');
    for (let t = 0; t < 30; t += 1) step(w, makeInput(), TICK_DT);
    assert.ok(!b.alive || b.vx < 0, '되튀지 않는다(그대로 나가 컬링)');
  });

  test('★ 봇의 반사탄 예측(bot.foldWall)이 실제 궤적과 일치한다 (§10.4) — 벽 안에서 난 탄 · 벽 밖(화면 위 · HP·XP 띠)에서 나 들어오는 탄 모두', () => {
    for (const [label, sx, sy, svx, svy] of [['경기장 안', 100, 150, 260, 170], ['상단 띠 안(경기장)에서 위로', 480, 20, 150, -230],
      ['화면 위(벽 밖)에서 아래로', 220, -20, -210, 240], ['HP·XP 띠 안(벽 밖)에서 위로', 330, 700, 180, -260]]) {
      const w = mkWorld();
      w.player.iframeSec = 1e9;                     // 탄이 기체에 먹혀 사라지지 않게 — 궤적만 본다
      const a = w.data.rules.view.arena;
      const wl = w.walls;
      const b = spawnEnemyBullet(w, 'ricochet', a.x + sx, a.y + sy, svx, svy, '');
      const r = b.radius;                           // ㊿-t 탄은 제 반경만큼 안쪽에서 튄다 — 봇은 스냅샷 bwr(= 탄 반경)로 같은 여백을 쓴다
      const x0 = b.x; const y0 = b.y; const vx = b.vx; const vy = b.vy;
      let worst = 0; let ticks = 0;
      for (let t = 1; t <= 300; t += 1) {
        step(w, makeInput(), TICK_DT);
        if (!b.alive) break;
        const T = t * TICK_DT;
        ticks = t;
        worst = Math.max(worst,
          Math.abs(foldWall(x0 + vx * T, x0, wl.x + r, wl.x + wl.w - r) - b.x),
          Math.abs(foldWall(y0 + vy * T, y0, wl.y + r, wl.y + wl.h - r) - b.y));
      }
      assert.gt(ticks, 60, `${label}: 1초 넘게 따라갔다 (${ticks}틱)`);
      assert.lt(worst, 1e-6, `${label}: 봇의 예측과 실제 궤적의 오차가 0 이다 — 봇이 반사탄을 정확히 피한다`);
    }
  });

  test('★ 반사 벽(㊿-t) — 아래는 HP·XP 띠 위 바닥선 · 위와 좌우는 아레나 끝(상단 띠는 경기장) · 탄은 가장자리가 벽에 닿는 순간 되튄다', () => {
    const w = mkWorld();
    w.player.iframeSec = 1e9;
    const a = w.data.rules.view.arena;
    const v = w.data.rules.view;
    const wl = w.walls;
    const floorLine = a.y + a.h - v.bandHpH - v.bandXpH;
    assert.eq(wl.y + wl.h, floorLine, '아래 벽 = HP 띠 위(바닥선)');
    assert.eq(wl.y, a.y, '위 벽 = 아레나 끝 — 상단 띠는 반투명 오버레이(적이 날아들고 표적이 된다)라 벽이 아니다');
    assert.eq(wl.x, a.x, '왼쪽 벽 = 아레나 끝(패널 경계)');
    assert.eq(wl.x + wl.w, a.x + a.w, '오른쪽 벽 = 아레나 끝(패널 경계)');
    const SPEED = 120;
    const down = spawnEnemyBullet(w, 'ricochet', a.x + 150, floorLine - 40, 0, SPEED, '');
    const up = spawnEnemyBullet(w, 'ricochet', a.x + 450, a.y + 90, 0, -SPEED, '');
    const r = down.radius;
    assert.gt(r, 0, '전제: 반경이 있는 탄');
    let maxY = -Infinity; let minY = Infinity; let flippedDown = false; let flippedUp = false;
    for (let t = 0; t < 60; t += 1) {
      step(w, makeInput(), TICK_DT);
      if (down.alive) { maxY = Math.max(maxY, down.y); if (down.vy < 0) flippedDown = true; }
      if (up.alive) { minY = Math.min(minY, up.y); if (up.vy > 0) flippedUp = true; }
    }
    assert.ok(flippedDown && flippedUp, '둘 다 되튀었다');
    const oneTick = SPEED * TICK_DT;               // 넘은 틱에 되접으므로 가장자리는 벽에서 한 틱 이동 이내까지 온다
    assert.lte(maxY + r, floorLine, `아래로 가던 탄의 가장자리가 바닥선을 안 넘었다 — HP 바를 덮지 않는다 (최대 y ${maxY.toFixed(1)} + 반경 ${r} ≤ ${floorLine})`);
    assert.gt(maxY + r, floorLine - oneTick - 1e-9, `가장자리가 바닥선에 닿을 때 튀었다 — 더 앞에서 미리 튀지 않는다 (최대 y ${maxY.toFixed(1)} + 반경 ${r})`);
    assert.gte(minY - r, a.y, `위로 가던 탄의 가장자리가 화면 위를 안 넘었다 (최소 y ${minY.toFixed(1)})`);
    assert.lt(minY, a.y + v.bandTopH, `위로 가던 탄은 상단 띠 안까지 들어갔다 — 상단 띠는 경기장이다 (최소 y ${minY.toFixed(1)} < ${a.y + v.bandTopH})`);
  });

  test('★ 반경 여백(벽선과 튀는 선 사이)에서 난 반사탄 — 네 벽 모두: 바깥으로 가면 튀지 않고 나가고, 안으로 가면 여백을 지나 들어온다 (봇의 접기 = 실제 궤적)', () => {
    // 2차 검토: «안에서 넘을 때만»의 비교를 튀는 선이 아니라 벽선에 대도 초록이었다 — 기존 표본은 여백을 한 틱 안에 건넜다.
    //   느린 탄을 여백 한가운데(벽선에서 반경/2)에 두어 여러 틱을 여백 안에서 보내게 한다.
    const r = loadData().bullets.bullets.find((x) => x.id === 'ricochet').radius;
    const wl = mkWorld().walls;
    const cx = wl.x + wl.w / 2; const cy = wl.y + wl.h / 2;
    const S = 60; const ALONG = 23;                 // 벽 쪽 속도 · 벽을 따라가는 속도(px/s)
    const cases = [];
    for (const [side, x, y, nx, ny] of [['왼쪽', wl.x + r / 2, cy, -1, 0], ['오른쪽', wl.x + wl.w - r / 2, cy, 1, 0],
      ['위', cx, wl.y + r / 2, 0, -1], ['바닥', cx, wl.y + wl.h - r / 2, 0, 1]]) {
      cases.push([`${side} 여백 → 바깥`, x, y, nx * S + ny * ALONG, ny * S + nx * ALONG]);
      cases.push([`${side} 여백 → 안`, x, y, -nx * S + ny * ALONG, -ny * S + nx * ALONG]);
    }
    for (const [label, x, y, svx, svy] of cases) {
      const w = mkWorld();
      w.player.iframeSec = 1e9;                     // 탄이 기체에 먹혀 사라지지 않게 — 궤적만 본다
      const b = spawnEnemyBullet(w, 'ricochet', x, y, svx, svy, '');
      const x0 = b.x; const y0 = b.y; const vx = b.vx; const vy = b.vy; const rr = b.radius;
      let worst = 0; let ticks = 0;
      for (let t = 1; t <= 240; t += 1) {
        step(w, makeInput(), TICK_DT);
        if (!b.alive) break;
        const T = t * TICK_DT;
        ticks = t;
        worst = Math.max(worst,
          Math.abs(foldWall(x0 + vx * T, x0, wl.x + rr, wl.x + wl.w - rr) - b.x),
          Math.abs(foldWall(y0 + vy * T, y0, wl.y + rr, wl.y + wl.h - rr) - b.y));
      }
      assert.gt(ticks, 10, `${label}: 여백을 지날 만큼 따라갔다 (${ticks}틱)`);
      assert.lt(worst, 1e-6, `${label}: 봇의 접기 = 실제 궤적 (최대 오차 ${worst.toExponential(2)})`);
    }
  });

  test('기체 이동 영역 ⊂ 반사 벽 − 반사 무기 탄이 가질 수 있는 최대 반경 — 가장자리에서 바깥으로 던진 공도 반드시 튄다 (2 · 3차 검토)', () => {
    const w = mkWorld();
    const hooks = w.data.rules.passiveHooks;
    const cap = w.data.rules.render.playerBulletMaxRadiusPx;   // H3 — 패시브로 커진 반경의 상한(판정 · 렌더 공통, state.recomputeEff)
    let maxR = 0;
    for (const wp of w.data.weapons.weapons) {
      const rows = [wp.base];
      if (Array.isArray(wp.levels)) rows.push(...wp.levels);
      else if (wp.levels && typeof wp.levels === 'object') rows.push(...Object.values(wp.levels));
      if (wp.evolution) { rows.push(wp.evolution); if (wp.evolution.params) rows.push(wp.evolution.params); }
      if (!rows.some((row) => row && typeof row.bounceLeft === 'number' && row.bounceLeft !== 0)) continue;
      for (const row of rows) if (row && typeof row.projRadius === 'number') maxR = Math.max(maxR, row.projRadius);
      // ★ 저작 반경만 보면 안 된다 — 이 무기의 패시브 훅 목록에 projRadius 가 들면 반경이 H3 상한까지 자란다(3차 검토:
      //   리턴 주석의 옛 목록 ["outRangePx", "projRadius"] 대로 데이터를 «고치면» 튀는 선이 기체 아래 한계 위로 올라간다)
      const h = hooks[wp.family] || {};
      if (Object.values(h).some((v) => v === 'projRadius' || (Array.isArray(v) && v.includes('projRadius')))) maxR = Math.max(maxR, cap);
    }
    assert.gt(maxR, 0, '전제: 반사하는 무기(핀볼 · 리턴)의 탄 반경을 찾았다');
    const bd = w.bounds; const wl = w.walls;
    const inner = { minX: wl.x + maxR, maxX: wl.x + wl.w - maxR, minY: wl.y + maxR, maxY: wl.y + wl.h - maxR };
    assert.ok(bd.minX >= inner.minX && bd.maxX <= inner.maxX && bd.minY >= inner.minY && bd.maxY <= inner.maxY,
      `이동 영역 x ${bd.minX}..${bd.maxX} · y ${bd.minY}..${bd.maxY} ⊂ 튀는 선 x ${inner.minX}..${inner.maxX} · y ${inner.minY}..${inner.maxY} (반경 ${maxR}) — 아니면 가장자리에서 바깥으로 던진 공이 튀지 않고 나간다`);
  });

  test('벽 밖(HP·XP 띠 · 화면 위)에서 생긴 반사탄은 순간이동하지 않는다 — 들어올 때까지는 직선, 바깥으로 가면 그대로 나간다', () => {
    const w = mkWorld();
    w.player.iframeSec = 1e9;
    const a = w.data.rules.view.arena;
    const wl = w.walls;
    const floorLine = wl.y + wl.h;
    const inward = spawnEnemyBullet(w, 'ricochet', a.x + 200, floorLine + 20, 0, -300, '');   // HP·XP 띠 안 → 위로(들어온다)
    const outward = spawnEnemyBullet(w, 'ricochet', a.x + 400, floorLine + 20, 0, 300, '');   // HP·XP 띠 안 → 아래로(나간다)
    const above = spawnEnemyBullet(w, 'ricochet', a.x + 300, a.y - 20, 0, 300, '');          // 화면 위 → 아래로(들어온다)
    const y0in = inward.y; const vin = inward.vy; const y0out = outward.y; const y0ab = above.y; const vab = above.vy;
    step(w, makeInput(), TICK_DT);
    assert.ok(inward.vy < 0 && Math.abs(inward.y - (y0in + vin * TICK_DT)) < 1e-9, 'HP·XP 띠 안에서 안쪽으로 가는 탄 = 직선 그대로(벽 안으로 되접히지 않는다)');
    assert.ok(outward.vy > 0 && outward.y > y0out, 'HP·XP 띠 안에서 바깥으로 가는 탄 = 튀지 않고 나간다');
    assert.ok(above.vy > 0 && Math.abs(above.y - (y0ab + vab * TICK_DT)) < 1e-9, '화면 위에서 안쪽으로 가는 탄 = 직선 그대로');
  });
});

suite('hazards/laser 빔 (§8.5)', () => {
  test('빔 경로 위면 피격', () => {
    const w = mkWorld(); const p = w.player;
    // 플레이어 위 200px 원점에서 아래(+y, a=π/2)로 → 플레이어가 경로상
    const b = spawnBeam(w, p.x, p.y - 200, Math.PI / 2, 20, 15, 1.0, -1);
    assert.ok(b, '빔 스폰');
    assert.eq(liveBeams(w), 1, '빔 1개');
    p.iframeSec = 0;
    const hp0 = p.hp;
    step(w, makeInput(), TICK_DT);
    assert.lt(p.hp, hp0, '빔 경로 = 피격');
  });

  // §9.5(v1.7) 오빗 차폐 — 「펄스필드는 탄은 막는데 빔은 못 막는다」의 답.
  //   ★ 이 테스트가 있어야 하는 이유: 순수 기하로 구현하면 차단 창이 0.08~0.15초인데 빔 활성은
  //     0.5~2.2초라 «실측 0%»가 나온다. 컴파일되고 게이트를 통과해도 아무 일도 안 일어나는
  //     장식이 되는 것이다. 그래서 「피해가 실제로 줄었는가」를 못박는다.
  //   ★ 공전체를 손으로 옮기면 안 된다 — 같은 스텝의 orbit.place() 가 궤도로 되돌린다.
  //     링 «위상»(slot.a0)으로 제어해야 결정적이다.
  test('오빗 공전체가 빔 원점과 나 사이에 서면 피해가 준다 (§9.5 차폐)', () => {
    // 빔은 플레이어 200px 위 원점에서 아래로 → 선분은 플레이어 «바로 위» 수직선이다.
    //   a0 = -π/2 → 0번 공전체가 정확히 그 위에 선다(막힘). a0 = 0 → 좌우로 비킨다(열림).
    const run = (phase) => {
      const w = mkWorld(); const p = w.player;
      const si = giveWeapon(w, 'orbit');
      for (let t = 0; t < 20; t += 1) step(w, makeInput(), TICK_DT);
      w.slots[si].a0 = phase;
      spawnBeam(w, p.x, p.y - 200, Math.PI / 2, 20, 40, 1.0, -1);
      p.iframeSec = 0;
      const hp0 = p.hp;
      step(w, makeInput(), TICK_DT);
      return hp0 - p.hp;
    };
    const f = mkWorld().data.rules.fairness;
    assert.gt(f.beamBlockRadiusPx, 0, '판정 폭이 있다(전제)');
    assert.gt(f.beamBlockRatio, 0, '감산이 있다(전제)');

    const open = run(0);
    const blocked = run(-Math.PI / 2);
    assert.gt(open, 0, '막지 않으면 맞는다(전제)');
    assert.lt(blocked, open, '★ 공전체가 선분 위에 있으면 피해가 «실제로» 준다');
    assert.gt(blocked, 0, '감산이지 무효화가 아니다 — §2.1 관대함(영구 무효 없음)');
  });

  test('빔 뒤쪽(원점 반대편)은 무피격 — 반직선이다', () => {
    const w = mkWorld(); const p = w.player;
    spawnBeam(w, p.x, p.y + 100, Math.PI / 2, 20, 15, 1.0, -1);   // 원점이 플레이어 아래, 방향은 아래
    p.iframeSec = 0;
    const hp0 = p.hp;
    step(w, makeInput(), TICK_DT);
    assert.eq(p.hp, hp0, '빔 뒤쪽 = 무피격');
  });

  test('빔 폭 밖(옆)은 무피격', () => {
    const w = mkWorld(); const p = w.player;
    spawnBeam(w, p.x + 300, p.y - 200, Math.PI / 2, 20, 15, 1.0, -1);
    p.iframeSec = 0;
    const hp0 = p.hp;
    step(w, makeInput(), TICK_DT);
    assert.eq(p.hp, hp0, '폭 밖 = 무피격');
  });

  test('activeSec 경과 후 반납', () => {
    const w = mkWorld();
    spawnBeam(w, 0, 0, 0, 20, 15, 0.2, -1);
    assert.eq(liveBeams(w), 1, '빔 살아있음');
    for (let t = 0; t < 20; t += 1) step(w, makeInput(), TICK_DT);
    assert.eq(liveBeams(w), 0, 'activeSec 후 반납');
  });
});

// ══════════════════════════════════════════════════════════════════════
suite('hazards/laser 2단(§7.4 「충전이 곧 텔레그래프」)', () => {
  test('충전(warnSec) 구간은 무해, 활성(activeSec) 구간만 피해', () => {
    const w = mkWorld(); const p = w.player;
    const warnSec = 0.5; const activeSec = 0.5;
    // 플레이어 위 200px 원점에서 아래로 → 플레이어가 경로상. warnSec 동안은 안 맞아야 한다.
    spawnBeam(w, p.x, p.y - 200, Math.PI / 2, 20, 15, activeSec, -1, '', warnSec, false);
    const chargeTicks = Math.floor(warnSec / TICK_DT) - 1;
    assert.gt(chargeTicks, 0, '충전이 여러 틱이다 (vacuous 아님)');
    const hp0 = p.hp;
    for (let t = 0; t < chargeTicks; t += 1) { p.iframeSec = 0; step(w, makeInput(), TICK_DT); }
    assert.eq(p.hp, hp0, '충전 중엔 무해 — 예고 없이 즉발하지 않는다');
    p.iframeSec = 0;
    step(w, makeInput(), TICK_DT);
    step(w, makeInput(), TICK_DT);
    assert.lt(p.hp, hp0, '활성 진입 후 피해');
    // 총 수명 = warnSec + activeSec
    assert.eq(liveBeams(w), 1, '아직 활성');
    for (let t = 0; t < Math.ceil(activeSec / TICK_DT) + 1; t += 1) step(w, makeInput(), TICK_DT);
    assert.eq(liveBeams(w), 0, 'warnSec + activeSec 후 반납');
  });

  test('track=true — 충전 초반엔 추적, beamLockSec 잠금창부터 각이 멈추고 그대로 발사(§7.4 잠금창)', () => {
    const w = mkWorld(); const p = w.player;
    const lockSec = w.data.rules.fairness.beamLockSec;     // 잠금·뜸 창(회피 리드)
    const warnSec = lockSec + 0.5;                         // 추적 0.5s + 잠금 lockSec
    const ox = p.x; const oy = p.y - 200;
    const b = spawnBeam(w, ox, oy, Math.PI / 2, 20, 15, 0.5, -1, '', warnSec, true);
    p.iframeSec = 1e9;                                     // 관측 중 피격 무효(각만 본다)

    // ① 잠금창 전(충전 초반): 플레이어를 옮기면 각이 따라온다
    p.x = ox + 150;
    step(w, makeInput(), TICK_DT);
    assert.near(b.a, Math.atan2(p.y - oy, p.x - ox), 1e-6, '잠금창 전엔 추적');

    // ② 잠금창 진입 직전까지 진행 → 각 기록
    const trackUntilTicks = Math.floor((warnSec - lockSec) / TICK_DT);
    for (let t = 1; t < trackUntilTicks; t += 1) step(w, makeInput(), TICK_DT);
    const aLocked = b.a;
    // 잠금창 동안 플레이어를 크게 옮겨도 각이 안 변한다(뜸 = 회피 창)
    p.x = ox - 300;
    step(w, makeInput(), TICK_DT);
    assert.near(b.a, aLocked, 1e-9, '잠금창에선 각이 멈춘다(발사 전 뜸)');

    // ③ 활성(발사) 진입 후에도 잠긴 각 그대로
    for (let t = 0; t < Math.ceil(lockSec / TICK_DT) + 2; t += 1) step(w, makeInput(), TICK_DT);
    assert.near(b.a, aLocked, 1e-9, '발사도 잠긴 각 그대로');
  });
});
