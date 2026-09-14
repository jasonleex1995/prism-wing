/**
 * tests/weapons.test.mjs — forward · fan · seeker 의 정본(§9.5) 계약 단위 테스트.
 *
 * 원칙(MEMORY ★★): 값은 데이터/정본에서 유도한다(하드코딩 매직넘버 지양).
 *   eff 는 recomputeEff 로 주입한다. 양성 + 경계 + 음성 + 회귀를 모두 건다.
 *
 * 커버:
 *   forward — 볼리 주기 = cooldownSec / spreadDeg 균등·대칭 / jitterDeg(rng.pattern·결정적)
 *             / 진화 on↔off 격리(램프는 evolved 에서만·비진화는 a2 불변)
 *             / i-frame 엣지 리셋(회귀: 피격 직후 그 한 틱)
 *   fan     — arcDeg 균등 / onExpire 는 evolved 일 때만 폭발 / 반경 경계
 *             / onExpire 정확히 1회(회귀 ④: release 경로 LIFO 재사용에도 탄당 1회)
 *   seeker  — 유도(각 오차 감소) / turnRate 클램프(정확히 turnRateDegSec·dt) / retarget
 *             (evolved=온-킬 즉시 / 비evolved=주기 전 직진) / distinct 타겟(evolved)
 *   boomerang — 투척 주기 / pierce -1·hitCooldownSec(두 번 벤다) / OUT→RETURN 전환 / 회수(age→lifetime)
 *             / 체인 리턴 경유 격리(evolved)
 *   ★ 리터럴 계약 — 다섯 파일 소스 파싱: 주석·문자열 제거 후 숫자 리터럴 ⊆ {0,1,-1,0.5,2}
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { suite, test, assert, loadData } from '../tools/test.mjs';
import {
  createWorld, recomputeEff, giveWeapon, levelUpWeapon, spawnPlayerBullet, spawnEnemy, spawnEnemyBullet,
} from '../src/core/state.js';
import { step, makeInput, TICK_DT, killEnemy } from '../src/core/step.js';
import { weapons } from '../src/core/weapons/index.js';
import forward from '../src/core/weapons/forward.js';
import fan from '../src/core/weapons/fan.js';
import seeker from '../src/core/weapons/seeker.js';
import boomerang from '../src/core/weapons/boomerang.js';
import aura from '../src/core/weapons/aura.js';
import nova from '../src/core/weapons/nova.js';
import lance from '../src/core/weapons/lance.js';
import { DEG2RAD, wrapAngle } from '../src/core/angle.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEAPONS_DIR = join(HERE, '..', 'src', 'core', 'weapons');
const dt = TICK_DT;

// ── 헬퍼 ────────────────────────────────────────────────────────────────
function mkWorld(seed = 1) {
  return createWorld({ data: loadData(), seed, weapons, hooks: { enemies: null, emitters: null }, startWeaponId: 'forward' });
}
function slotOf(world, family) {
  for (let i = 0; i < world.slots.length; i += 1) if (world.slots[i].family === family) return world.slots[i];
  return null;
}
/** family 무기를 원하는 level/evolved 로 세팅한 슬롯 + 갱신된 eff 를 돌려준다 */
function setup(world, family, level, evolved) {
  if (slotOf(world, family) === null) giveWeapon(world, family);
  const s = slotOf(world, family);
  s.level = level;
  s.evolved = !!evolved;
  s.cooldownT = 0; s.a0 = 0; s.a1 = 0; s.a2 = 0;
  s.effDirty = true;
  return { s, eff: recomputeEff(world, s) };
}
/** alive 플레이어 탄을 풀 인덱스 오름차순으로 (= 발사 순서) */
function liveBullets(world) {
  const out = [];
  const it = world.playerBullets.items;
  for (let i = 0; i < it.length; i += 1) if (it[i].alive) out.push(it[i]);
  return out;
}
/** 화면 위(0,-v)를 0도로 한 진행 각(도). 오른쪽 = +, 왼쪽 = − */
function headingDeg(b) { return Math.atan2(b.vx, -b.vy) / DEG2RAD; }
/** eff 로 볼리 1발분 스폰이 일어난 틱 인덱스 목록 (live 증가 = 볼리) */
function volleyTicks(mod, world, s, eff, ticks) {
  const ev = [];
  let prev = world.playerBullets.live;
  for (let t = 0; t < ticks; t += 1) {
    mod.update(world, s, eff, dt);
    if (world.playerBullets.live > prev) ev.push(t);
    prev = world.playerBullets.live;
  }
  return ev;
}
function addEnemy(world, x, y, element = 'normal', archetype = 'drifter') {
  const def = loadData().enemies.archetypes.find((a) => a.id === archetype);
  return spawnEnemy(world, archetype, element, x, y, def.hp, false);
}

// ══════════════════════════════════════════════════════════════════════════
// forward
// ══════════════════════════════════════════════════════════════════════════
suite('weapons/forward', () => {
  test('볼리 주기 = cooldownSec (첫 발 즉시, 이후 간격)', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'forward', 1, false);   // count 1 · burstCount 1
    const ev = volleyTicks(forward, w, s, eff, 90);
    assert.eq(ev[0], 0, '첫 볼리는 첫 틱에 즉시');
    assert.gte(ev.length, 2, '90틱(1.5s) 안에 최소 2볼리');
    const gap = ev[1] - ev[0];
    assert.near(gap * dt, eff.cooldownSec, dt * 2, '볼리 간격 = cooldownSec');
  });

  test('한 볼리 = count 발 (경계: count 1 → 산포 없이 정확히 1발)', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'forward', 1, false);
    assert.eq(eff.count, 1, 'Lv1 count = 1');
    forward.update(w, s, eff, dt);
    assert.eq(w.playerBullets.live, 1, 'count 만큼 스폰');
  });

  test('spreadDeg 균등·대칭 (count 2 → ±spreadDeg/2, 간격 = spreadDeg)', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'forward', 5, false);   // Lv5: count 2 · spreadDeg 6
    assert.eq(eff.count, 2, 'Lv5 count = 2');
    assert.gt(eff.spreadDeg, 0, 'Lv5 spreadDeg > 0');
    eff.jitterDeg = 0;                                  // 산포만 격리 (jitter 제거)
    forward.update(w, s, eff, dt);
    const b = liveBullets(w);
    assert.eq(b.length, 2, '볼리 = 2발');
    const d0 = headingDeg(b[0]); const d1 = headingDeg(b[1]);
    assert.near(d0, -eff.spreadDeg / 2, 1e-6, '첫 발 = −spreadDeg/2');
    assert.near(d1, +eff.spreadDeg / 2, 1e-6, '둘째 발 = +spreadDeg/2');
    assert.near(d1 - d0, eff.spreadDeg, 1e-6, '두 발 간격 = spreadDeg');
  });

  test('jitterDeg: |편차| ≤ jitterDeg 이고 rng.pattern 이라 결정적', () => {
    const wa = mkWorld(777); const a = setup(wa, 'forward', 1, false);
    assert.gt(a.eff.jitterDeg, 0, 'Lv1 jitterDeg > 0 (양성 경로)');
    forward.update(wa, a.s, a.eff, dt);
    const ba = liveBullets(wa)[0];
    assert.lte(Math.abs(headingDeg(ba)), a.eff.jitterDeg + 1e-9, '편차 ≤ jitterDeg');
    // 같은 시드 → 같은 jitter (rng.pattern 결정성)
    const wb = mkWorld(777); const b = setup(wb, 'forward', 1, false);
    forward.update(wb, b.s, b.eff, dt);
    assert.eq(headingDeg(liveBullets(wb)[0]), headingDeg(ba), '동일 시드 = 동일 jitter');
  });

  test('경계: jitterDeg 0 → 정확히 정면(vx = 0)', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'forward', 1, false);
    eff.jitterDeg = 0;
    forward.update(w, s, eff, dt);
    assert.near(liveBullets(w)[0].vx, 0, 1e-9, '산포·jitter 0 = 정면');
  });

  test('진화 격리: evolved 는 램프로 가속, 비evolved 는 램프 스크래치(a2) 불변', () => {
    // 비진화: 같은 창에서 a2 는 절대 변하지 않는다 (i-frame 을 걸어도)
    const wn = mkWorld();
    const n = setup(wn, 'forward', 1, false);
    wn.player.iframeSec = wn.data.rules.player.iframeSec;   // 진화라면 리셋을 유발할 신호
    for (let t = 0; t < 200; t += 1) forward.update(wn, n.s, n.eff, dt);
    assert.eq(n.s.a2, 0, '비evolved 는 a2(램프)를 건드리지 않는다');
    const nCount = liveBullets(wn).length;

    // 진화: 피격 없이 연사하면 램프가 차서 같은 창에서 볼리 수가 더 많다
    const we = mkWorld();
    const e = setup(we, 'forward', 1, true);
    we.player.iframeSec = 0;
    let eCount = 0; let prev = 0;
    for (let t = 0; t < 200; t += 1) {
      forward.update(we, e.s, e.eff, dt);
      if (we.playerBullets.live > prev) eCount += 1;
      prev = we.playerBullets.live;
    }
    assert.gt(e.s.a2, 0, 'evolved 는 램프 a2 가 찬다');
    assert.gt(eCount, nCount, '가속으로 evolved 볼리 수 > 비evolved');
  });

  test('회귀(i-frame 엣지): 피격 직후 그 한 틱에만 램프 리셋', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'forward', 1, true);
    const full = eff.evoRampSec;
    // 피격 순간: iframeSec = rules.player.iframeSec → iframeSec + dt ≥ iframeSec → 리셋
    s.a2 = full;
    w.player.iframeSec = w.data.rules.player.iframeSec;
    forward.update(w, s, eff, dt);
    assert.eq(s.a2, 0, '피격 엣지에서 a2 리셋');

    // 음성: i-frame 이 남아 흐르는 중(피격 아님) → 리셋 안 됨, 오히려 램프가 찬다
    s.a2 = 0;
    w.player.iframeSec = 0.1;                 // 0.1 + dt < 1.0 → 엣지 아님
    forward.update(w, s, eff, dt);
    assert.near(s.a2, dt, 1e-9, 'i-frame 잔여 중엔 리셋 없이 dt 만큼 램프');
  });

  test('음성: 계약 밖 targetMode 는 소리내어 실패 (§9.3 폴백 금지)', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'forward', 1, false);
    eff.targetMode = 'nearest';
    assert.throws(() => forward.update(w, s, eff, dt), '계약 밖 targetMode → throw');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// fan
// ══════════════════════════════════════════════════════════════════════════
suite('weapons/fan', () => {
  test('arcDeg 균등 배치 (양 끝 ±arcDeg/2, 인접 간격 균일)', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'fan', 1, false);       // count 3 · arcDeg 40
    assert.gte(eff.count, 3, 'fan 은 다발');
    fan.update(w, s, eff, dt);
    const b = liveBullets(w).map(headingDeg);
    assert.eq(b.length, eff.count, 'count 만큼');
    assert.near(b[0], -eff.arcDeg / 2, 1e-6, '첫 발 = −arcDeg/2');
    assert.near(b[b.length - 1], +eff.arcDeg / 2, 1e-6, '끝 발 = +arcDeg/2');
    const stepD = eff.arcDeg / (eff.count - 1);
    for (let i = 1; i < b.length; i += 1) {
      assert.near(b[i] - b[i - 1], stepD, 1e-6, `간격 균일 @${i}`);
    }
  });

  test('경계: 최대 레벨 다발도 균등 (Lv8 count·arcDeg)', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'fan', 8, true);
    fan.update(w, s, eff, dt);
    const b = liveBullets(w).map(headingDeg);
    assert.eq(b.length, eff.count, 'Lv8 count 만큼');
    const stepD = eff.arcDeg / (eff.count - 1);
    for (let i = 1; i < b.length; i += 1) assert.near(b[i] - b[i - 1], stepD, 1e-6, `간격 균일 @${i}`);
  });

  test('onExpire 폭발은 evolved 일 때만 (반경 안 적에 피해)', () => {
    // evolved: 반경 안 적 hp 감소
    const we = mkWorld();
    const e = setup(we, 'fan', 8, true);
    const be = spawnPlayerBullet(we, e.s, e.eff, 600, 400, 0, 0, 1);
    const near = addEnemy(we, 600 + e.eff.evoBlastRadius * 0.5, 400);   // 반경 안
    const hp0 = near.hp;
    fan.onExpire(we, e.s, e.eff, be);
    assert.lt(near.hp, hp0, 'evolved 폭발 → 반경 안 적 피해');

    // 비evolved: 같은 배치라도 폭발 없음
    const wn = mkWorld();
    const n = setup(wn, 'fan', 7, false);              // Lv7: 진화 전
    const bn = spawnPlayerBullet(wn, n.s, n.eff, 600, 400, 0, 0, 1);
    const stay = addEnemy(wn, 605, 400);
    const shp = stay.hp;
    fan.onExpire(wn, n.s, n.eff, bn);
    assert.eq(stay.hp, shp, '비evolved 는 폭발하지 않는다');
  });

  test('경계: evoBlastRadius 밖의 적은 폭발에 무피해', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'fan', 8, true);
    const b = spawnPlayerBullet(w, s, eff, 600, 400, 0, 0, 1);
    const far = addEnemy(w, 600 + eff.evoBlastRadius + 30, 400);        // 반경 밖 (적 반경 감안 여유)
    const hp0 = far.hp;
    fan.onExpire(w, s, eff, b);
    assert.eq(far.hp, hp0, '반경 밖 = 무피해');
  });

  test('회귀④: release 경로가 onExpire 를 탄당 정확히 1회 (LIFO 재사용에도)', () => {
    // fan 을 계수 래퍼로 감싼 레지스트리로 월드를 만든다 → 모듈 진입 횟수를 직접 센다
    let calls = 0;
    const wrappedFan = { update: fan.update, onExpire(...a) { calls += 1; return fan.onExpire(...a); } };
    const reg = { forward: weapons.forward, fan: wrappedFan, seeker: weapons.seeker };
    const w = createWorld({ data: loadData(), seed: 3, weapons: reg, hooks: { enemies: null, emitters: null }, startWeaponId: 'forward' });

    giveWeapon(w, 'fan');
    const s = slotOf(w, 'fan');
    while (s.level < 8) levelUpWeapon(w, s.index);      // Lv8 = 진화
    const eff = recomputeEff(w, s);
    s.cooldownT = 1e9;                                  // 이 창에서 fan 자동발사 봉쇄 (수동 탄만 만료 측정)

    const K = 5;
    for (let i = 0; i < K; i += 1) spawnPlayerBullet(w, s, eff, 600, 400, 0, 0, 1);
    assert.eq(w.playerBullets.live, K, 'K 발 수동 스폰');

    // lifetime 만큼 스텝 → 모든 fan 탄이 release 경로로 소멸
    for (let t = 0; t < 200; t += 1) step(w, makeInput(), dt);

    // fan 탄이 전부 사라졌는지 (forward 자동탄은 family 로 구분되어 무관)
    let fanLive = 0;
    for (const it of w.playerBullets.items) if (it.alive && it.family === 'fan') fanLive += 1;
    assert.eq(fanLive, 0, '모든 fan 탄 release');
    assert.eq(calls, K, 'onExpire 는 탄당 정확히 1회 (누락·중복 없음)');
  });

  test('음성: 계약 밖 targetMode 는 throw', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'fan', 1, false);
    eff.targetMode = 'nearest';
    assert.throws(() => fan.update(w, s, eff, dt), '계약 밖 targetMode → throw');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// seeker
// ══════════════════════════════════════════════════════════════════════════
suite('weapons/seeker', () => {
  /** 위로 나는 seeker 탄 1발을 만들어 target 에 고정한다 (steer 격리를 위해 update 발사는 봉쇄) */
  function armed(w, level, evolved, enemy) {
    const { s, eff } = setup(w, 'seeker', level, evolved);
    s.cooldownT = 1e9;                                 // steer 만 돌리고 volley 는 막는다
    const b = spawnPlayerBullet(w, s, eff, enemy.x, enemy.y + 200, 0, -eff.projSpeed, 1); // 위로
    b.target = enemy.idx; b.targetGen = enemy.gen; b.s0 = eff.retargetSec;
    return { s, eff, b };
  }

  test('유도: 스티어 1틱이 타겟 쪽으로 각 오차를 줄인다', () => {
    const w = mkWorld();
    const en = addEnemy(w, 700, 400);
    const { s, eff, b } = armed(w, 1, false, en);
    b.x = en.x - 150;                                  // 탄을 옆으로 → 위로 날며 타겟은 위-오른쪽(각 오차 존재)
    const err0 = Math.abs(wrapAngle(Math.atan2(en.y - b.y, en.x - b.x) - Math.atan2(b.vy, b.vx)));
    assert.gt(err0, 0, '초기 각 오차 존재 (유도할 여지)');
    seeker.update(w, s, eff, dt);
    const err1 = Math.abs(wrapAngle(Math.atan2(en.y - b.y, en.x - b.x) - Math.atan2(b.vy, b.vx)));
    assert.lt(err1, err0, '각 오차 감소 = 유도');
  });

  test('turnRate 클램프: 큰 각차에서 회전량 = 정확히 turnRateDegSec·dt', () => {
    const w = mkWorld();
    // 탄은 위(−90°)로, 타겟은 정확히 오른쪽(0°) → 각차 90° ≫ maxTurn → 클램프
    const en = addEnemy(w, 700, 400);
    const { s, eff, b } = armed(w, 1, false, en);
    b.x = en.x - 100; b.y = en.y; b.vx = 0; b.vy = -eff.projSpeed;   // 타겟은 dx=+100, dy=0 (오른쪽)
    const before = Math.atan2(b.vy, b.vx);
    seeker.update(w, s, eff, dt);
    const after = Math.atan2(b.vy, b.vx);
    const turned = wrapAngle(after - before);
    const maxTurn = eff.turnRateDegSec * DEG2RAD * dt;
    assert.near(turned, maxTurn, 1e-9, '회전량 = turnRateDegSec·dt (초과 금지)');
  });

  test('retarget(evolved): 타겟 사망 즉시 다른 적으로 재조준', () => {
    const w = mkWorld();
    const a = addEnemy(w, 700, 400);
    const bEn = addEnemy(w, 720, 410);                 // 대체 후보
    const { s, eff, b } = armed(w, 3, true, a);        // evolved → retargetOnKill
    assert.eq(b.target, a.idx, '초기 타겟 = A');
    killEnemy(w, a);                                   // A 사망
    seeker.update(w, s, eff, dt);
    assert.ne(b.target, a.idx, 'A 를 더는 겨누지 않는다');
    assert.gte(b.target, 0, '새 타겟 확보');
    assert.ok(w.enemies.items[b.target].alive, '새 타겟은 살아있는 적');
    assert.eq(b.targetGen, w.enemies.items[b.target].gen, 'targetGen 동기화');
  });

  test('음성(비evolved): 타겟이 죽어도 주기 전엔 즉시 재조준하지 않는다', () => {
    const w = mkWorld();
    const a = addEnemy(w, 700, 400);
    addEnemy(w, 720, 410);
    const { s, eff, b } = armed(w, 3, false, a);       // 비evolved
    b.s0 = eff.retargetSec;                            // 주기 아직 안 참
    const vx0 = b.vx; const vy0 = b.vy;
    killEnemy(w, a);
    seeker.update(w, s, eff, dt);
    assert.eq(b.target, a.idx, '재조준 없이 stale 타겟 유지');
    assert.eq(b.vx, vx0, '놓친 타겟 = 직진(속도 불변) vx');
    assert.eq(b.vy, vy0, '놓친 타겟 = 직진(속도 불변) vy');
  });

  test('distinct 타겟: evolved 다발은 서로 다른 적을, 비evolved 는 같은 최근접을 겨눈다', () => {
    // evolved: 2발이 서로 다른 적 (플레이어 640,664 기준 acquireRadius 210 안 — v1.5 시커 하향 반영)
    const we = mkWorld();
    const a = addEnemy(we, 660, 500);
    const b = addEnemy(we, 665, 502);
    const e = setup(we, 'seeker', 3, true);            // Lv3 count 2 · evolved distinct
    assert.eq(e.eff.count, 2, 'Lv3 count = 2');
    e.s.cooldownT = 0;
    seeker.update(we, e.s, e.eff, dt);
    const shots = liveBullets(we);
    assert.eq(shots.length, 2, '2발 발사');
    assert.ne(shots[0].target, shots[1].target, 'evolved → 서로 다른 타겟');
    assert.gte(Math.min(shots[0].target, shots[1].target), 0, '둘 다 유효 타겟');

    // 비evolved: 2발이 같은 최근접을 겨눈다
    const wn = mkWorld();
    addEnemy(wn, 660, 500); addEnemy(wn, 665, 502);
    const n = setup(wn, 'seeker', 3, false);
    n.s.cooldownT = 0;
    seeker.update(wn, n.s, n.eff, dt);
    const sn = liveBullets(wn);
    assert.eq(sn[0].target, sn[1].target, '비evolved → 동일 최근접');
  });

  test('음성: 계약 밖 targetMode 는 throw (§9.5 nearest 만)', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'seeker', 1, false);
    eff.targetMode = 'lowestHp';
    assert.throws(() => seeker.update(w, s, eff, dt), '미구현 targetMode → throw');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// boomerang (리턴) — 나갔다 돌아온다 · 두 번 벤다(pierce -1·hitCooldownSec) · 체인 리턴
// ══════════════════════════════════════════════════════════════════════════
suite('weapons/boomerang', () => {
  /** moveBullets 를 흉내내 궤적을 전진시키는 미니 적분 (steer 격리용) */
  function integrate(world, ticks, s, eff) {
    for (let t = 0; t < ticks; t += 1) {
      boomerang.update(world, s, eff, dt);
      const it = world.playerBullets.items;
      for (let i = 0; i < it.length; i += 1) { const b = it[i]; if (b.alive) { b.x += b.vx * dt; b.y += b.vy * dt; } }
    }
  }

  test('투척 주기 = cooldownSec, 던진 탄은 pierce -1·hitCooldownSec 을 실어 두 번 벤다', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'boomerang', 1, false);
    assert.eq(eff.count, 1, 'Lv1 count 1');
    const ev = volleyTicks(boomerang, w, s, eff, 150);
    assert.eq(ev[0], 0, '첫 투척 즉시');
    const b = liveBullets(w)[0];
    assert.eq(b.pierceLeft, -1, '무제한 관통(pierce -1) = 왕복 재타격의 전제');
    assert.near(b.hitCooldownSec, eff.hitCooldownSec, 1e-9, 'hitCooldownSec 실림 = collide 재타격 게이트');
  });

  test('나갔다 돌아온다: 원점서 outRangePx 벗어나면 귀환 국면 전환', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'boomerang', 1, false);
    s.cooldownT = 1e9;                                    // 재투척 봉쇄 (탄 1발만 관찰)
    const p = w.player;
    const b = spawnPlayerBullet(w, s, eff, p.x, p.y, 0, -eff.projSpeed, 1);
    b.s0 = 0; b.s1 = p.x; b.s2 = p.y;
    boomerang.update(w, s, eff, dt);
    assert.eq(b.s0, 0, '원점 근처 = 아직 나가는 중(OUT)');
    assert.lt(b.vy, 0, 'OUT = 위로 직진 (vy<0)');
    integrate(w, 200, s, eff);                            // 원점서 충분히 멀어지도록 전진
    assert.eq(b.s0, 1, 'outRangePx 초과 → 귀환(RETURN) 전환');
  });

  test('귀환 도달 = 회수: 플레이어 근처의 귀환 탄은 age→lifetime (moveBullets 가 반납)', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'boomerang', 1, false);
    s.cooldownT = 1e9;
    const p = w.player;
    const b = spawnPlayerBullet(w, s, eff, p.x, p.y - eff.projRadius * 0.5, 0, -eff.projSpeed, 1); // 플레이어 반경 내
    b.s0 = 1; b.s1 = 0;                                   // 이미 귀환·경유 없음
    assert.lt(b.age, b.lifetimeSec, '아직 만료 전 (양성 경로)');
    boomerang.update(w, s, eff, dt);
    assert.eq(b.age, b.lifetimeSec, '플레이어 도달 → age=lifetime');
  });

  test('진화 격리(체인 리턴): evolved 귀환은 최근접 적을 경유(target 확보), 비evolved 는 곧장 플레이어로', () => {
    const we = mkWorld();
    const e = setup(we, 'boomerang', 5, true);            // Lv5 evolved
    e.s.cooldownT = 1e9;
    const p = we.player;
    const en = addEnemy(we, p.x + 120, p.y - 40);
    const b = spawnPlayerBullet(we, e.s, e.eff, p.x, p.y - 200, 0, -e.eff.projSpeed, 1);
    b.s0 = 1; b.s1 = e.eff.evoChainCount; b.s2 = -1; b.target = -1; b.targetGen = -1; // s2=-1 = 실제 RETURN 진입 상태
    boomerang.update(we, e.s, e.eff, dt);
    assert.gte(b.target, 0, 'evolved 귀환은 경유 적을 확보한다');
    assert.eq(b.target, en.idx, '최근접 적을 경유 타겟으로');

    const wn = mkWorld();
    const n = setup(wn, 'boomerang', 5, false);
    n.s.cooldownT = 1e9;
    const pn = wn.player;
    addEnemy(wn, pn.x + 120, pn.y - 40);
    const bn = spawnPlayerBullet(wn, n.s, n.eff, pn.x, pn.y - 200, 0, -n.eff.projSpeed, 1);
    bn.s0 = 1; bn.s1 = 0; bn.target = -1; bn.targetGen = -1;
    boomerang.update(wn, n.s, n.eff, dt);
    assert.eq(bn.target, -1, '비evolved 는 경유 타겟을 잡지 않는다 (직귀환)');
  });

  test('체인 진행(회귀): 방금 경유한 적을 제외하고 다음 적으로 — 한 적 붕괴 방지', () => {
    // 회귀 — 재획득이 직전 적을 제외하지 않으면 아직 rr 안인 같은 적에 evoChainCount 를 몰아
    //   ~3틱만에 소진해 체인이 한 적으로 붕괴했다. s2(직전 경유 적) 제외로 다음 적으로 진행.
    const w = mkWorld();
    const e = setup(w, 'boomerang', 8, true);            // Lv8 evolved (evoChainCount 3)
    e.s.cooldownT = 1e9;
    const p = w.player;
    const A = addEnemy(w, p.x, p.y - 100);               // 가까운 적
    const B = addEnemy(w, p.x + 220, p.y - 100);         // 멀리 떨어진 다른 적
    const b = spawnPlayerBullet(w, e.s, e.eff, A.x, A.y, 0, e.eff.returnSpeed, 1); // A 의 rr 안
    b.s0 = 1; b.s1 = e.eff.evoChainCount; b.s2 = -1; b.target = -1; b.targetGen = -1;

    boomerang.update(w, e.s, e.eff, dt);                 // 1틱: A 경유(도달)
    assert.eq(b.s2, A.idx, 'A 를 경유했음을 기억(s2=A)');
    assert.eq(b.s1, e.eff.evoChainCount - 1, '경유 카운트 정확히 1 감소 (이중감소 없음)');

    boomerang.update(w, e.s, e.eff, dt);                 // 2틱: 재획득 — A 제외 → B
    assert.eq(b.target, B.idx, '직전 적(A) 제외 → 다음 적(B)로 진행 (한 적 재붕괴 없음)');
  });

  test('음성: 계약 밖 targetMode 는 소리내어 실패 (§9.3 폴백 금지)', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'boomerang', 1, false);
    eff.targetMode = 'nearest';
    assert.throws(() => boomerang.update(w, s, eff, dt), '계약 밖 targetMode → throw');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// aura · nova · lance (인라인 피해 3종)
// ══════════════════════════════════════════════════════════════════════════
suite('weapons/aura', () => {
  // ★ v1.10 ㊿-p·㊿-r — 감속은 레벨마다 5%p 씩 오르고(Lv1 5% → Lv7 35%) 진화 구간 Lv8~10 은 곡선 +15%p(→ Lv10 65%). 값은 데이터가 소유하므로 테스트도 데이터를 읽는다.
  test('base(펄스필드) = 반경 안 적 «탄과 기체»를 느리게, 지우지 않음·무피해 (§9.5)', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'aura', 1, false);
    const p = w.player;
    const inB = spawnEnemyBullet(w, 'pelletS', p.x, p.y - eff.radius * 0.5, 0, 100);
    const outB = spawnEnemyBullet(w, 'pelletS', p.x, p.y - eff.radius * 2, 0, 100);
    const en = addEnemy(w, p.x, p.y - eff.radius * 0.5);     // 반경 안 적
    const out = addEnemy(w, p.x, p.y - eff.radius * 3);      // 반경 밖 적
    const heavy = addEnemy(w, p.x + 4, p.y - eff.radius * 0.5);   // 반경 안 «중장갑»(§8.17)
    heavy.ccImmune = true;
    const h0 = en.hp;
    aura.update(w, s, eff, dt);
    assert.near(inB.slowMul, eff.slowMul, 1e-9, `반경 안 적 탄 = ×${eff.slowMul}`);
    assert.eq(outB.slowMul, 1, '반경 밖 적 탄 = 원속도');
    assert.near(en.fieldSlowMul, eff.slowMul, 1e-9, `★ 반경 안 «기체»도 ×${eff.slowMul} (㊿-p)`);
    assert.eq(out.fieldSlowMul, 1, '반경 밖 기체 = 원속도');
    assert.eq(heavy.fieldSlowMul, 1, '★ 중장갑(ccImmune)은 구역의 «기체» 감속을 무시한다 — 바라지·노바와 같은 규칙 (§8.17 · ㊿-q)');
    assert.eq(inB.alive, true, '탄을 지우지 않는다 (남는다)');
    assert.eq(en.hp, h0, 'base 는 적에게 무피해 (순수 제어)');
  });

  // ★ 조용한 사고 방어 — 구역을 벗어난 적이 «영원히 느린 채» 남으면 아무도 모른다.
  //   탄의 slowMul 과 같은 규약이어야 한다: 매 틱 세팅 → 소비 → 1 로 되돌림(step.moveBullets 가 소유).
  test('구역을 벗어나면 원속도로 돌아온다 — 배율은 매 틱 되돌려진다 (㊿-p)', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'aura', 10, false);
    const p = w.player;
    const en = addEnemy(w, p.x, p.y - eff.radius * 0.5);
    aura.update(w, s, eff, dt);
    assert.near(en.fieldSlowMul, eff.slowMul, 1e-9, '구역 안 = 감속');
    step(w, makeInput(), dt);                          // moveBullets 가 소비하고 1 로 되돌린다
    assert.eq(en.fieldSlowMul, 1, '★ 한 틱 뒤 배율이 1 로 돌아온다 (누적·잔류 없음)');
    en.x = p.x + eff.radius * 3;                        // 구역 밖으로
    aura.update(w, s, eff, dt);
    assert.eq(en.fieldSlowMul, 1, '구역 밖 = 원속도');
  });

  test('감속이 레벨마다 계속 오르고, 진화 칸(Lv8)에서 한 단계 더 오른다 — Lv10 65% (㊿-p · ㊿-r)', () => {
    const d = loadData();
    const w = d.weapons.weapons.find((x) => x.family === 'aura');
    const c = []; let v = w.base.slowMul;
    for (let i = 0; i < 10; i += 1) { if (w.levels[i].slowMul !== undefined) v = w.levels[i].slowMul; c.push(v); }
    assert.eq(c.length, 10, '10 레벨');
    for (let i = 1; i < 10; i += 1) assert.gt(c[i - 1], c[i], `Lv${i + 1} 이 Lv${i} 보다 강한 감속 (계속 상승)`);
    // 사용자(2026-09-11): 「a + 진화 + 15%로 그러면 가자!」 — 곡선은 레벨마다 5%p, 진화 구간(Lv8~10)은 그 곡선 + 15%p
    for (let i = 0; i < 7; i += 1) assert.near(c[i], 1 - 0.05 * (i + 1), 1e-9, `Lv${i + 1} = 감속 ${5 * (i + 1)}%`);
    for (let i = 7; i < 10; i += 1) assert.near(c[i], 1 - 0.05 * (i + 1) - 0.15, 1e-9, `Lv${i + 1}(진화) = 곡선 ${5 * (i + 1)}% + 15%p`);
    assert.near(c[9], 0.35, 1e-9, 'Lv10 = ×0.35 (감속 65%)');
    assert.eq(Object.prototype.hasOwnProperty.call(w.evolution.params, 'evoSlowMul'), false,
      '★ evoSlowMul 은 없다 — 곡선을 «대신»해 Lv8~10 칸을 죽이던 키(㊿-r 삭제)');
  });

  // ★ v1.10 ㊿-o — 진화는 «완전 정지»가 아니라 «더 강한 감속»이다. ㊿-r 부터 그 값은 레벨 칸(Lv8~10)이 직접 갖는다.
  //   정지 반경이 기체 히트박스(4px)보다 크면 탄이 도달할 수 없다 = 반경이 얼마든 무적 장치다
  //   (사용자 2026-09-08: 「펄스 필드가 진화해버리면 모든 탄이 멈춰서 게임이 너무 쉬워져」).
  test('진화(싱귤래리티, Lv8) = 반경 안 적 탄이 «기어간다» — 멈추지는 않는다, 무피해, 진화 직전(Lv7)보다 강하다', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'aura', 8, true);            // 진화 = Lv8 = 한 단계 더 오른 감속 + 끌어당김
    const p = w.player;
    const inB = spawnEnemyBullet(w, 'pelletS', p.x, p.y - eff.radius * 0.5, 0, 100);
    const en = addEnemy(w, p.x, p.y - 1);
    const h0 = en.hp;
    aura.update(w, s, eff, dt);
    assert.near(inB.slowMul, eff.slowMul, 1e-9, `진화(Lv8): 반경 안 = ×${eff.slowMul} (레벨 칸의 값)`);
    assert.gt(inB.slowMul, 0, '★ 0 이 아니다 — 탄은 여전히 «온다»(무적 장치 금지)');
    assert.eq(en.hp, h0, '진화도 무피해(순수 제어)');
    const w2 = mkWorld();
    const su = setup(w2, 'aura', 7, false);
    const b2 = spawnEnemyBullet(w2, 'pelletS', w2.player.x, w2.player.y - 1, 0, 100);
    aura.update(w2, su.s, su.eff, dt);
    assert.lt(inB.slowMul, b2.slowMul, `진화(Lv8)가 진화 직전 Lv7(×${b2.slowMul}) 보다 강한 감속이다`);
  });

  test('진화 격리(싱귤래리티): evolved 만 chaff 를 끌어당긴다', () => {
    const p0 = (evolved) => {
      const w = mkWorld();
      const { s, eff } = setup(w, 'aura', 1, evolved);
      const e = addEnemy(w, w.player.x + 60, w.player.y - 10);
      const before = e.x;
      for (let t = 0; t < 30; t += 1) aura.update(w, s, eff, dt);
      return before - e.x;                                    // 플레이어 쪽(왼쪽)으로 당겨진 거리
    };
    assert.gt(p0(true), 0, 'evolved 는 끌어당긴다');
    assert.eq(p0(false), 0, '비evolved 는 위치를 건드리지 않는다');
  });
});

suite('weapons/nova', () => {
  test('intervalSec 주기로 반경 안을 폭발시킨다', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'nova', 1, false);
    const p = w.player;
    const near = addEnemy(w, p.x, p.y - eff.radius * 0.5);
    const far = addEnemy(w, p.x, p.y - eff.radius * 2);
    const n0 = near.hp; const f0 = far.hp;
    nova.update(w, s, eff, dt);
    assert.lt(near.hp, n0, '반경 안 = 폭발 피해');
    assert.eq(far.hp, f0, '반경 밖 = 무피해');
  });

  // §9.5(v1.7) 「확산 링이 적 탄을 지운다」는 폐기됐다 — 오빗 진화(이지스)와 동사가 겹쳤다.
  //   진화의 값은 이제 «더 오래 굳는다»(evoActionSlowSec)다. 테스트 «이름»도 함께 바꾼다:
  //   삭제된 기능을 이름이 계속 주장하면 그 자리가 다음 사람이 의미를 발명하는 자리가 된다.
  test('진화(슈퍼노바): 2단 링이 더 멀리 닿고, 닿은 적이 더 오래 굳는다', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'nova', 8, true);
    const p = w.player;
    assert.gt(eff.evoRing2Radius, eff.radius, '2단 링이 더 크다');
    assert.gt(eff.evoActionSlowSec, eff.actionSlowSec, '진화 감속이 더 길다');
    const outer = addEnemy(w, p.x, p.y - (eff.radius + eff.evoRing2Radius) * 0.5);
    const o0 = outer.hp;
    nova.update(w, s, eff, dt);
    assert.lt(outer.hp, o0, '1단 밖·2단 안의 적도 맞는다');
    assert.eq(outer.actionSlowSec, eff.evoActionSlowSec, '2단 링의 적은 진화 감속을 받는다');
  });

  test('행동 감속: ccImmune 인 적에게는 안 걸리고, 피해는 그대로 들어간다 (§8.17)', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'nova', 1, false);
    const p = w.player;
    const norm = addEnemy(w, p.x, p.y - 10);
    const immune = addEnemy(w, p.x + 12, p.y - 10);
    immune.ccImmune = true;
    const h0 = immune.hp;
    nova.update(w, s, eff, dt);
    assert.eq(norm.actionSlowSec, eff.actionSlowSec, '일반 적 = 감속 걸림');
    assert.eq(immune.actionSlowSec, 0, 'ccImmune = 감속 무효');
    assert.lt(immune.hp, h0, '★ 제어만 무효다 — 피해는 그대로 들어간다');
  });
});

suite('weapons/lance', () => {
  test('정면 빔 안의 적만, 가까운 순으로 pierce 마리까지', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'lance', 1, false);
    const p = w.player;
    const inline = [];
    for (let k = 0; k < eff.pierce + 2; k += 1) inline.push(addEnemy(w, p.x, p.y - 40 - k * 30));
    const side = addEnemy(w, p.x + eff.beamWidthPx * 2 + 40, p.y - 60);   // 빔 폭 밖
    const s0 = side.hp;
    lance.update(w, s, eff, dt);
    let hit = 0;
    for (const e of inline) if (e.hp < e.hpMax) hit += 1;
    assert.eq(hit, eff.pierce, `정확히 pierce(${eff.pierce}) 마리만 꿴다`);
    assert.eq(side.hp, s0, '빔 폭 밖 = 무피해');
    assert.lt(inline[0].hp, inline[0].hpMax, '가장 가까운 적이 포함된다');
  });

  test('사거리 밖은 맞지 않는다', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'lance', 1, false);
    const p = w.player;
    const far = addEnemy(w, p.x, p.y - eff.rangePx - 60);
    const f0 = far.hp;
    lance.update(w, s, eff, dt);
    assert.eq(far.hp, f0, 'rangePx 밖 = 무피해');
  });

  test('진화(레일건): 사거리 밖·pierce 초과도 전부 꿴다', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'lance', 8, true);
    const p = w.player;
    const list = [];
    for (let k = 0; k < eff.pierce + 3; k += 1) list.push(addEnemy(w, p.x, p.y - 40 - k * 40));
    lance.update(w, s, eff, dt);
    let hit = 0;
    for (const e of list) if (e.hp < e.hpMax) hit += 1;
    assert.eq(hit, list.length, '무제한 관통 — 줄 선 전부');
  });

  test('음성: 계약 밖 targetMode 는 throw', () => {
    const w = mkWorld();
    const { s, eff } = setup(w, 'lance', 1, false);
    eff.targetMode = 'nearest';
    assert.throws(() => lance.update(w, s, eff, dt), '계약 밖 targetMode → throw');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 리터럴 계약 (§9.1) — check.mjs S1 스캐너를 재현해 소스에서 직접 검증
// ══════════════════════════════════════════════════════════════════════════
suite('weapons/리터럴 계약 §9.1', () => {
  const ALLOWED = new Set(['0', '1', '-1', '0.5', '2']);
  // check.mjs stripStringsAndComments 와 동일
  function strip(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace(/`(?:\\.|[^`\\])*`/g, '""')
      .replace(/'(?:\\.|[^'\\])*'/g, '""')
      .replace(/"(?:\\.|[^"\\])*"/g, '""');
  }
  function literals(file) {
    const code = strip(readFileSync(join(WEAPONS_DIR, file), 'utf8'));
    const out = [];
    for (const m of code.matchAll(/(?<![\w$.])-?\d+(?:\.\d+)?\b/g)) out.push(m[0]);
    return out;
  }

  for (const file of ['forward.js', 'fan.js', 'seeker.js', 'boomerang.js', 'aura.js', 'nova.js',
    'lance.js', 'orbit.js', 'barrage.js', 'drone.js']) {
    test(`${file}: 숫자 리터럴 ⊆ {0,1,-1,0.5,2}`, () => {
      const lits = literals(file);
      assert.gt(lits.length, 0, '스캐너가 실제로 리터럴을 봤다 (vacuous 아님)');
      const bad = lits.filter((l) => !ALLOWED.has(l));
      assert.deepEq(bad, [], `허용 밖 리터럴 없음 (발견: ${bad.join(', ')})`);
    });
  }
});
