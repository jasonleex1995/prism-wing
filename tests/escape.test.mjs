/**
 * tests/escape.test.mjs — tools/lib/escape.mjs(«피할 수 있는 길» 계측 — dodge · study · blame · pressure)의 반사탄 외삽.
 *
 *   ★ v1.10 ㊿-t — step 은 반사 벽(world.walls = 아레나 − HP·XP 띠)에서, 탄 반경만큼 안쪽에서 튄다. 계측이 아레나 끝(720)으로
 *     접으면 바닥선 근처에서 «되튀어 오는 탄»을 못 보고 맞는 길을 «안전»으로 센다 — 강제 피격이 «실수»로 잡힌다
 *     (검토 실측: 하단 300 표본 중 55 불일치). 이 파일은 계측의 예측이 실제 궤적 · 실제 피격과 같은지를 본다.
 */

import { suite, test, assert, loadData } from '../tools/test.mjs';
import { createWorld, spawnEnemyBullet } from '../src/core/state.js';
import { step, makeInput, TICK_DT } from '../src/core/step.js';
import { weapons } from '../src/core/weapons/index.js';
import { bulletAt, escapeDirs, makeCtx, DIRS } from '../tools/lib/escape.mjs';

const data = loadData();
function mkWorld() { return createWorld({ data, seed: 1, weapons, hooks: {} }); }

suite('escape — 계측의 반사탄 외삽 = 실제 궤적 (§1.1 ㊿-t 반사 벽)', () => {
  test('bulletAt 이 step 의 실제 위치와 오차 0 — 경기장 안 · 바닥선 근처 · HP·XP 띠 안에서 난 탄', () => {
    for (const [label, sx, sy, svx, svy] of [['경기장 안', 120, 300, 230, 190], ['바닥선 근처에서 아래로', 300, 640, -140, 115], ['HP·XP 띠 안(벽 밖)에서 위로', 420, 700, 160, -330]]) {
      const w = mkWorld();
      w.player.iframeSec = 1e9;                     // 탄이 기체에 먹혀 사라지지 않게 — 궤적만 본다
      const a = w.data.rules.view.arena;
      const b = spawnEnemyBullet(w, 'ricochet', a.x + sx, a.y + sy, svx, svy, '');
      const snap = { x: b.x, y: b.y, vx: b.vx, vy: b.vy, bounceLeft: b.bounceLeft, radius: b.radius };
      const out = { x: 0, y: 0 };
      let worst = 0; let ticks = 0; let floorBounces = 0;
      for (let t = 1; t <= 300; t += 1) {
        const vyBefore = b.vy;
        step(w, makeInput(), TICK_DT);
        if (!b.alive) break;
        if (vyBefore > 0 && b.vy < 0) floorBounces += 1;
        bulletAt(w, snap, t * TICK_DT, out);
        worst = Math.max(worst, Math.abs(out.x - b.x), Math.abs(out.y - b.y));
        ticks = t;
      }
      assert.gt(ticks, 60, `${label}: 1초 넘게 따라갔다 (${ticks}틱)`);
      assert.gt(floorBounces, 0, `${label}: 전제 — 바닥선에서 실제로 되튀었다`);
      assert.lt(worst, 1e-6, `${label}: 계측의 예측 = 실제 궤적 (최대 오차 ${worst.toExponential(2)})`);
    }
  });

  test('반사하지 않는 탄은 직선 그대로(바닥선에서 튀지 않는다)', () => {
    const w = mkWorld();
    const a = w.data.rules.view.arena;
    const b = spawnEnemyBullet(w, 'pelletS', a.x + 300, a.y + 600, 0, 200, '');
    const out = { x: 0, y: 0 };
    bulletAt(w, b, 1, out);
    assert.eq(b.bounceLeft, 0, '전제: 반사 예산 0');
    assert.lt(Math.abs(out.y - (b.y + b.vy)), 1e-9, '1초 뒤 = 직선 위치');
  });

  test('escapeDirs — 바닥선에서 되튀어 오는 탄이 막는 길을 «막힘»으로 센다 (실제 피격과 같은 판정)', () => {
    const H = 0.8;
    const ctx = makeCtx(data);
    const setupW = () => {
      const w = mkWorld();
      w.player.x = 640; w.player.y = 600; w.player.iframeSec = 0;
      spawnEnemyBullet(w, 'ricochet', 640, 650, 0, 130, '');   // 기체 50px 아래에서 바닥선으로 — 되튀어 기체 쪽으로 돌아온다
      return w;
    };
    const blocked = [];
    for (let k = 0; k < DIRS.length; k += 1) {
      const w = setupW();
      const inp = makeInput();
      const [dx, dy] = DIRS[k];
      inp.left = dx < 0; inp.right = dx > 0; inp.up = dy < 0; inp.down = dy > 0;
      let hit = false;
      for (let t = 0; t < Math.round(H / TICK_DT); t += 1) { step(w, inp, TICK_DT); if (w.player.iframeSec > 0) { hit = true; break; } }
      blocked.push(hit);
    }
    const realSafe = blocked.filter((h) => !h).length;
    assert.ok(blocked[1], `전제: 아래(DIRS[1])로 가면 되튀어 오는 탄에 실제로 맞는다 (${blocked.map((h) => (h ? '×' : '○')).join('')})`);
    assert.eq(realSafe, 7, `전제: 나머지 7방향은 실제로 안전하다 (${blocked.map((h) => (h ? '×' : '○')).join('')})`);
    assert.eq(escapeDirs(setupW(), data, H, ctx), realSafe, '계측의 안전한 길 수 = 실제 — 아레나 끝(720)으로 접으면 «아래»를 안전으로 센다');
  });

  test('bulletAt — 반경 여백(벽선과 튀는 선 사이)에서 난 탄: 바깥으로 가면 튀지 않고 나가고, 안으로 가면 여백을 지나 들어온다 (네 벽 · 2차 검토)', () => {
    const r = data.bullets.bullets.find((x) => x.id === 'ricochet').radius;
    const wl = mkWorld().walls;
    const cx = wl.x + wl.w / 2; const cy = wl.y + wl.h / 2;
    const cases = [];
    for (const [side, x, y, nx, ny] of [['왼쪽', wl.x + r / 2, cy, -1, 0], ['오른쪽', wl.x + wl.w - r / 2, cy, 1, 0],
      ['위', cx, wl.y + r / 2, 0, -1], ['바닥', cx, wl.y + wl.h - r / 2, 0, 1]]) {
      cases.push([`${side} 여백 → 바깥`, x, y, nx * 60 + ny * 23, ny * 60 + nx * 23]);
      cases.push([`${side} 여백 → 안`, x, y, -nx * 60 + ny * 23, -ny * 60 + nx * 23]);
    }
    for (const [label, x, y, vx, vy] of cases) {
      const w = mkWorld();
      w.player.iframeSec = 1e9;
      const b = spawnEnemyBullet(w, 'ricochet', x, y, vx, vy, '');
      const snap = { x: b.x, y: b.y, vx: b.vx, vy: b.vy, bounceLeft: b.bounceLeft, radius: b.radius };
      const out = { x: 0, y: 0 };
      let worst = 0; let ticks = 0;
      for (let t = 1; t <= 240; t += 1) {
        step(w, makeInput(), TICK_DT);
        if (!b.alive) break;
        bulletAt(w, snap, t * TICK_DT, out);
        worst = Math.max(worst, Math.abs(out.x - b.x), Math.abs(out.y - b.y));
        ticks = t;
      }
      assert.gt(ticks, 10, `${label}: 여백을 지날 만큼 따라갔다 (${ticks}틱)`);
      assert.lt(worst, 1e-6, `${label}: 계측의 예측 = 실제 궤적 (최대 오차 ${worst.toExponential(2)})`);
    }
  });
});
