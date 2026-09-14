/**
 * «피할 수 있는 길» 판정 — 계측 4벌의 단일 진실 원천.
 *
 *   판정은 src/core/step.js 의 «실제 피격»과 일치해야 한다. 어긋나면 통계 전체가 거짓이 된다.
 *   적대 검증(에이전트 9)이 초판의 결함 넷을 실측으로 잡아냈고, 이 판은 그것을 고친 것이다:
 *
 *   ① 터널링 — 서브스텝 0.08초는 게임 틱(0.0167초)의 4.8배다. 한 스텝에 17.9px 이동하는데
 *      최소 충돌 지름이 14.4px 이라 위험물이 «표본 사이»를 지나갔다. 실측 거짓안전 6.39%.
 *      → 점 표본을 버리고 «휩쓸기»로 바꾼다. 구간을 선분 대 선분으로 풀면 틈이 원리적으로 없다.
 *   ② 보스·중간보스를 정지물로 봤다 — 그 개체들은 vx/vy 를 «쓰지 않는다»(midboss.js:136 이 0 을
 *      넣고 :145 가 좌표를 직접 가산 · boss.js:92 주석). 돌진(dashSpeed 300)이 0.8초에 240px 다.
 *      → trackMotion 이 매 틱 좌표를 캐시해 유한차분 속도를 만든다.
 *   ③ weave·anchor 의 «순간 사인속도»를 등속으로 폈다 — 접선을 따라 날아간다.
 *      → 닫힌 형태로 구간 끝점을 정확히 구하고, 구간 안에서만 선형으로 잇는다.
 *   ④ i-frame 을 통째로 무시했다 — 무적(1.0초)이 지평(0.8초)보다 길어서, 실제로는 맞을 수 없는데
 *      「길이 0」이라 보고했다. 실측 「길0」 표본의 68%가 무적 중이었다.
 *      ★ ①②③ 과 «반대 방향» 오차라 총계에서 서로를 가린다 — 사후 보정이 불가능한 이유다.
 *   ⑥ 적 감속(e.slowSec)을 무시했다 — 내 바라지가 늦춘 적을 45% 더 멀리 보냈다(무기 A/B 오염).
 *   ⑦ 반사탄을 아레나 끝(720)으로 접었다 — step 은 v1.10 ㊿-t 부터 반사 벽(world.walls = 아레나 − HP·XP 띠)에서, 탄 반경만큼
 *      안쪽에서 튄다. 바닥선 근처에서 되튀어 오는 탄을 못 보고 맞는 길을 «안전»으로 셌다(검토 실측: 하단 300 표본 중 55 불일치 —
 *      강제 피격이 «실수»로 잡힌다). → bulletAt 이 봇과 같은 접기(bot.foldWall)를 같은 벽 · 같은 여백으로 쓴다(S65 ④).
 */

import { foldWall } from '../../src/core/bot.js';

export const DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0],
  [0.7071, -0.7071], [-0.7071, -0.7071], [0.7071, 0.7071], [-0.7071, 0.7071]];
const SEGS = 10;                 // 구간 수 — 휩쓸기라 «구간 안»에 틈이 없다(점 표본이 아니다)
const TAU = Math.PI * 2;
const ANCHOR_SWAY_HZ = 0.35;     // enemies.js:34 와 같은 값이어야 한다

/** 아키타입 조회표 — 적 엔티티는 moveId 를 들고 있지 않으므로 여기서 유도한다(core 무수정). */
export function makeCtx(d) {
  const bounce = Object.create(null);
  const weave = Object.create(null);
  const anchor = Object.create(null);
  for (let i = 0; i < d.enemies.archetypes.length; i += 1) {
    const a = d.enemies.archetypes[i];
    const mp = a.moveParams || {};
    if (a.moveId === 'bounce') bounce[a.id] = 1;
    else if (a.moveId === 'weave' && typeof mp.ampPx === 'number' && typeof mp.freqHz === 'number') {
      weave[a.id] = { amp: mp.ampPx, w: TAU * mp.freqHz };
    } else if (a.moveId === 'anchor') {
      anchor[a.id] = { sway: typeof mp.swayAmpPx === 'number' ? mp.swayAmpPx : 0,
        leave: typeof mp.leaveAfterSec === 'number' ? mp.leaveAfterSec : 0 };
    }
  }
  return { bounce, weave, anchor, fd: null, slowMul: d.rules.status.slowMoveSpeedMul };
}

/**
 * 매 «틱» 호출한다 — 보스·중간보스처럼 vx/vy 를 쓰지 않고 좌표를 직접 옮기는 개체의
 * 속도를 유한차분으로 만든다. 이걸 부르지 않으면 그 개체들은 정지물로 외삽된다.
 */
export function trackMotion(w, ctx, dt) {
  const en = w.enemies.items;
  if (ctx.fd === null) {
    const n = en.length;
    ctx.fd = { gen: new Int32Array(n), x: new Float64Array(n), y: new Float64Array(n),
      vx: new Float64Array(n), vy: new Float64Array(n) };
  }
  const f = ctx.fd;
  for (let i = 0; i < en.length; i += 1) {
    const e = en[i];
    if (!e.alive) { f.gen[i] = -1; continue; }
    if (f.gen[i] !== e.gen) { f.gen[i] = e.gen; f.x[i] = e.x; f.y[i] = e.y; f.vx[i] = 0; f.vy[i] = 0; continue; }
    f.vx[i] = (e.x - f.x[i]) / dt; f.vy[i] = (e.y - f.y[i]) / dt;
    f.x[i] = e.x; f.y[i] = e.y;
  }
}

/** 삼각파 접기 — 적 기체 bounce 이동의 닫힌 형태(enemies.js — 아레나 좌우를 반경만큼 안쪽에서 튄다). 탄은 bulletAt(bot.foldWall)이 접는다. */
function foldSpan(v, lo, hi) {
  const span = hi - lo;
  if (span <= 0) return lo;
  const period = span * 2;
  let u = (v - lo) % period;
  if (u < 0) u += period;
  return lo + (u <= span ? u : period - u);
}

/** §2.2 상한 — player.moveSpeed 고정(v1.10 ⑳·㉑: 배율은 어디에도 없다). 스턴이면 한 픽셀도 못 움직인다. 지형 둔화의 «깊이»(저항)는
 *  계측이 모른다 — 봇은 지형을 모르므로(§8.21 ⑤) 탄의 둔화 배율로 보수적으로 잰다. */
export function playerSpeed(w, d) {
  const p = w.player;
  if (p.stunSec > 0) return 0;
  let v = d.rules.player.moveSpeed;
  if (p.slowSec > 0) v *= d.rules.status.slowMoveSpeedMul;
  return v;
}

/**
 * 두 선분(각각 등속)의 최근접 거리가 반경 이하인가 — «휩쓸기» 판정.
 *   A = 시작 상대위치, B = 상대속도. |A + B·s| 의 최소를 s∈[s0, s1] 에서 찾는다.
 *   s0 을 두는 이유: 무적이 구간 «도중»에 끝나면 그 이후만 유효하다.
 */
function sweptHit(ax, ay, bx, by, r, s0, s1) {
  let s = s0;
  const bb = bx * bx + by * by;
  if (bb > 1e-12) {
    s = -(ax * bx + ay * by) / bb;
    if (s < s0) s = s0; else if (s > s1) s = s1;
  }
  const dx = ax + bx * s;
  const dy = ay + by * s;
  return dx * dx + dy * dy <= r * r;
}

/** 적의 미래 위치 — 이동 동사별 닫힌 형태. m = 감속 배율. */
function enemyAt(e, ctx, at, m, arena, out) {
  const wv = ctx.weave[e.archetypeId];
  if (wv !== undefined) {                                   // enemies.js:323 — 사인 «속도»의 적분
    out.x = e.x + m * wv.amp * (Math.sin(wv.w * (e.moveT + at)) - Math.sin(wv.w * e.moveT));
    out.y = e.y + e.vy * m * at;
    return;
  }
  const an = ctx.anchor[e.archetypeId];
  if (an !== undefined && e.mp0 === 1 && (e.moveT - e.mp1) < an.leave) {
    const held = e.moveT - e.mp1;                            // enemies.js:348 — 체류 중 좌우 왕복
    const w2 = TAU * ANCHOR_SWAY_HZ;
    out.x = e.x + m * an.sway * (Math.sin(w2 * (held + at)) - Math.sin(w2 * held));
    out.y = e.y;
    return;
  }
  let ex = e.x + e.vx * m * at;
  if (ctx.bounce[e.archetypeId] === 1) ex = foldSpan(ex, arena.x + e.radius, arena.x + arena.w - e.radius);
  out.x = ex;
  out.y = e.y + e.vy * m * at;
}

const _p0 = { x: 0, y: 0 };
const _p1 = { x: 0, y: 0 };

/**
 * 적 탄의 at 초 뒤 위치 → out. 반사탄(bounceLeft ≠ 0)은 step.bounceOffWalls 와 «같은 벽 · 같은 여백 · 같은 규칙»으로 접는다(⑦ · v1.10 ㊿-t):
 *   구간 = w.walls 를 탄 반경만큼 줄인 것, 접기 = bot.foldWall(벽 밖에서 난 탄은 들어올 때까지 직선).
 *   tests/escape.test.mjs 가 실제 궤적 · 실제 피격과 같은지 본다.
 */
export function bulletAt(w, bu, at, out) {
  let x = bu.x + bu.vx * at;
  let y = bu.y + bu.vy * at;
  if (bu.bounceLeft !== 0) {
    const wl = w.walls;
    const r = bu.radius;
    x = foldWall(x, bu.x, wl.x + r, wl.x + wl.w - r);
    y = foldWall(y, bu.y, wl.y + r, wl.y + wl.h - r);
  }
  out.x = x;
  out.y = y;
}

/**
 * 8방향 중 «경로 전체»가 horizon 초 동안 안전한 방향의 수 (0..8).
 * blame 이 주어지면 막은 주체를 누적한다. ox/oy 로 기체 아닌 임의 지점을 잴 수 있다(pressure).
 */
/**
 * bodies=false 이면 적 «몸통»을 차단물에서 뺀다 — v1.10 사용자 결정: 초기 구간의 몸은 «쏴서 길을 내는
 *   자원»이고 철학 ①(완벽하면 안 맞는다)은 «탄·빔·장판»에 한정한다. 몸 포함 지표는 «밀도»를, 몸 제외 지표는
 *   «공정성»을 잰다. 둘을 나란히 내야 서로를 가리지 않는다.
 */
export function escapeDirs(w, d, horizon, ctx, blame, ox, oy, bodies) {
  const useBodies = bodies !== false;
  const p = w.player;
  const b = w.bounds;
  const arena = d.rules.view.arena;
  const hitR = d.rules.player.hitboxRadius;
  const dt = horizon / SEGS;
  const stepPx = playerSpeed(w, d) * dt;
  // ★ 무적 — 이 시각 이전에는 «무엇에도» 맞지 않는다(step.js:569 가 무조건 반환). 임의 지점 측정은 제외.
  const iframe = (ox === undefined && oy === undefined) ? p.iframeSec : 0;

  const N = DIRS.length;
  const px = new Float64Array(N);
  const py = new Float64Array(N);
  const tag = new Array(N).fill(null);
  const sx = ox === undefined ? p.x : ox;
  const sy = oy === undefined ? p.y : oy;
  for (let k = 0; k < N; k += 1) { px[k] = sx; py[k] = sy; }

  const en = w.enemies.items;
  const eb = w.enemyBullets.items;
  const zs = w.zones.items;
  const ts = w.telegraphs.items;
  const fd = ctx.fd;

  for (let t = 1; t <= SEGS; t += 1) {
    const at0 = (t - 1) * dt;
    const at1 = t * dt;
    if (at1 <= iframe) {                                    // 이 구간은 통째로 무적 안 — 위협 판정 생략
      for (let k = 0; k < N; k += 1) {
        if (tag[k] !== null) continue;
        let nx = px[k] + DIRS[k][0] * stepPx; let ny = py[k] + DIRS[k][1] * stepPx;
        if (nx < b.minX) nx = b.minX; else if (nx > b.maxX) nx = b.maxX;
        if (ny < b.minY) ny = b.minY; else if (ny > b.maxY) ny = b.maxY;
        px[k] = nx; py[k] = ny;
      }
      continue;
    }
    const s0 = iframe > at0 ? (iframe - at0) : 0;            // 구간 도중 무적이 끝나면 그 뒤만 본다

    for (let k = 0; k < N; k += 1) {
      if (tag[k] !== null) continue;
      const x0 = px[k]; const y0 = py[k];
      let x1 = x0 + DIRS[k][0] * stepPx; let y1 = y0 + DIRS[k][1] * stepPx;
      if (x1 < b.minX) x1 = b.minX; else if (x1 > b.maxX) x1 = b.maxX;
      if (y1 < b.minY) y1 = b.minY; else if (y1 > b.maxY) y1 = b.maxY;
      const pvx = (x1 - x0) / dt; const pvy = (y1 - y0) / dt;

      for (let i = 0; useBodies && i < en.length && tag[k] === null; i += 1) {
        const e = en[i];
        if (!e.alive) continue;
        const m = e.slowSec > 0 ? ctx.slowMul : 1;           // step.js:309 — 감속된 적은 덜 간다
        if (fd !== null && fd.gen[i] === e.gen && e.vx === 0 && e.vy === 0
            && (fd.vx[i] !== 0 || fd.vy[i] !== 0)) {         // 보스·중간보스 — 좌표를 직접 옮긴다
          _p0.x = e.x + fd.vx[i] * at0; _p0.y = e.y + fd.vy[i] * at0;
          _p1.x = e.x + fd.vx[i] * at1; _p1.y = e.y + fd.vy[i] * at1;
        } else { enemyAt(e, ctx, at0, m, arena, _p0); enemyAt(e, ctx, at1, m, arena, _p1); }
        const r = hitR + e.radius;
        if (sweptHit(_p0.x - x0, _p0.y - y0, (_p1.x - _p0.x) / dt - pvx, (_p1.y - _p0.y) / dt - pvy, r, s0, dt)) {
          tag[k] = `몸:${e.midBossId !== '' ? `중간보스(${e.midBossId})` : (e.archetypeId || (e.isBoss || e.isCore ? '보스' : '?'))}`;
        }
      }

      for (let i = 0; i < eb.length && tag[k] === null; i += 1) {
        const bu = eb[i];
        if (!bu.alive) continue;
        bulletAt(w, bu, at0, _p0); bulletAt(w, bu, at1, _p1);   // ⑦ 반사탄 = step 과 같은 벽 · 같은 여백(v1.10 ㊿-t)
        const r = hitR + bu.hitRadius;
        if (sweptHit(_p0.x - x0, _p0.y - y0, (_p1.x - _p0.x) / dt - pvx, (_p1.y - _p0.y) / dt - pvy, r, s0, dt)) {
          tag[k] = `탄:${bu.bulletId}${bu.srcArch === '' ? '' : `←${bu.srcArch}`}`;
        }
      }

      for (let i = 0; i < zs.length && tag[k] === null; i += 1) {
        const z = zs[i];
        if (!z.alive || z.fromPlayer) continue;
        // 활성 창이 이 구간과 겹치는가 — 장판은 움직이지 않는다(state.js:178, vx/vy 없음)
        if (z.age + at1 < z.warnSec || z.age + at0 >= z.warnSec + z.activeSec) continue;
        const lo = Math.max(s0, z.warnSec - z.age - at0);
        const r = z.radius + hitR;
        if (sweptHit(z.x - x0, z.y - y0, -pvx, -pvy, r, lo < 0 ? 0 : lo, dt)) {
          tag[k] = `장판:${z.srcArch === '' ? '?' : z.srcArch}`;
        }
      }

      for (let i = 0; i < ts.length && tag[k] === null; i += 1) {
        const tg = ts[i];
        if (!tg.alive || tg.kind !== 'laser') continue;
        const age = tg.age + at1;
        if (age < tg.warnSec || age >= tg.durSec) continue;
        let ang = tg.a;
        if (tg.aStart !== tg.aEnd) {
          const act = tg.durSec - tg.warnSec;
          const prog = act > 0 ? Math.min(1, (age - tg.warnSec) / act) : 1;
          ang = tg.aStart + (tg.aEnd - tg.aStart) * prog;
        }
        const ux = Math.cos(ang); const uy = Math.sin(ang);
        const lim = tg.r * 0.5 + hitR;
        for (let q = 0; q <= 2 && tag[k] === null; q += 1) {   // 구간을 3점으로 훑는다(빔은 반직선)
          const f = q * 0.5;
          const qx = x0 + (x1 - x0) * f; const qy = y0 + (y1 - y0) * f;
          const rx = qx - tg.x; const ry = qy - tg.y;
          if (rx * ux + ry * uy < 0) continue;
          if (Math.abs(rx * uy - ry * ux) <= lim) tag[k] = `빔:${tg.srcArch === '' ? '?' : tg.srcArch}`;
        }
      }

      px[k] = x1; py[k] = y1;
    }
  }

  let ok = 0;
  for (let k = 0; k < N; k += 1) if (tag[k] === null) ok += 1;
  if (blame !== undefined && ok <= 2) {
    for (let k = 0; k < N; k += 1) if (tag[k] !== null) blame[tag[k]] = (blame[tag[k]] || 0) + 1;
  }
  return ok;
}
