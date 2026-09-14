/**
 * tests/bot.test.mjs — 결정적 AI 플레이어(src/core/bot.js), §10.2 · §10.4.1.
 *
 * 정본 계약:
 *   - 8번째 스트림 `bot` 만 소비한다 → theme/draft/spawn/… 시퀀스를 흔들지 않는다(독립 스트림).
 *   - 출력은 makeInput() 모양(불리언 상태). 게임과 같은 입구로 들어간다.
 *   - 같은 시드·같은 정책 = 같은 입력 시퀀스(헤드리스 재현성의 전제).
 *   - stance 'static' 은 절대 전환하지 않는다(stanceValue 게이트의 대조군).
 *   - forceNoElement 프로브는 속성 카드를 고르지 않는다.
 */

import { suite, test, assert, loadData } from '../tools/test.mjs';
import { createWorld, spawnEnemy, spawnEnemyBullet } from '../src/core/state.js';
import { step, makeInput, TICK_DT } from '../src/core/step.js';
import { weapons } from '../src/core/weapons/index.js';
import { enemies } from '../src/core/enemies.js';
import { emitters } from '../src/core/emitters.js';
import { bossHook } from '../src/core/boss.js';
import { initRun, tickRun } from '../src/core/stage.js';
import { botInput, botDraftPick, setBotPolicy, rollSeg } from '../src/core/bot.js';

function mkWorld(seed = 1, difficulty) {
  const w = createWorld({
    data: loadData(), seed, weapons, difficulty,
    hooks: { run: tickRun, enemies, emitters, boss: bossHook },
  });
  initRun(w);
  return w;
}
function snap(i) {
  return `${i.left ? 1 : 0}${i.right ? 1 : 0}${i.up ? 1 : 0}${i.down ? 1 : 0}`
    + `${i.stanceNormal ? 1 : 0}${i.stanceFire ? 1 : 0}${i.stanceWater ? 1 : 0}${i.stanceGrass ? 1 : 0}`;
}

suite('bot/결정성 · 스트림', () => {
  test('같은 시드 → 같은 입력 시퀀스', () => {
    function seq(seed) {
      const w = mkWorld(seed);
      const def = loadData().enemies.archetypes.find((a) => a.id === 'drifter');
      spawnEnemy(w, 'drifter', 'water', 600, 200, def.hp, false);
      const out = [];
      for (let t = 0; t < 120; t += 1) out.push(snap(botInput(w, TICK_DT)));
      return out.join('|');
    }
    assert.eq(seq(5), seq(5), '동일 시드 = 동일 입력');
  });

  test('봇은 rng.bot 만 소비한다 — 다른 스트림을 흔들지 않는다 (§10.2 독립)', () => {
    const a = mkWorld(7);
    const before = `${a.rng.spawn.f()},${a.rng.draft.f()},${a.rng.pattern.f()}`;
    const b = mkWorld(7);
    for (let t = 0; t < 300; t += 1) botInput(b, TICK_DT);      // 봇을 300틱 돌린 뒤
    const after = `${b.rng.spawn.f()},${b.rng.draft.f()},${b.rng.pattern.f()}`;
    assert.eq(before, after, '봇 추첨이 spawn/draft/pattern 을 이동시키지 않는다');
  });

  test('출력은 makeInput 모양의 불리언 8필드', () => {
    const w = mkWorld();
    const i = botInput(w, TICK_DT);
    for (const k of ['left', 'right', 'up', 'down', 'stanceNormal', 'stanceFire', 'stanceWater', 'stanceGrass']) {
      assert.eq(typeof i[k], 'boolean', `${k} 는 불리언`);
    }
  });
});

suite('bot/정책', () => {
  test("stance 'static' 은 전환 키를 절대 내지 않는다 (stanceValue 대조군)", () => {
    const w = mkWorld(3);
    setBotPolicy(w, { stance: 'static' });
    const def = loadData().enemies.archetypes.find((a) => a.id === 'drifter');
    for (const el of ['fire', 'water', 'grass']) spawnEnemy(w, 'drifter', el, 600, 200, def.hp, false);
    let switches = 0;
    for (let t = 0; t < 600; t += 1) {
      const i = botInput(w, TICK_DT);
      if (i.stanceFire || i.stanceWater || i.stanceGrass) switches += 1;
    }
    assert.eq(switches, 0, 'static 은 속성 스탠스로 전환하지 않는다');
  });

  test("stance 'greedyNearest' 는 최근접 적을 ×2 로 때리는 스탠스로 전환한다", () => {
    const w = mkWorld(3);
    setBotPolicy(w, { stance: 'greedyNearest' });
    const def = loadData().enemies.archetypes.find((a) => a.id === 'drifter');
    spawnEnemy(w, 'drifter', 'fire', w.player.x, w.player.y - 60, def.hp, false);   // 불 → 물이 정답
    let sawWater = false;
    for (let t = 0; t < 600 && !sawWater; t += 1) if (botInput(w, TICK_DT).stanceWater) sawWater = true;
    assert.ok(sawWater, '불 적에 물 스탠스를 요청한다');
  });

  test('forceNoElement 프로브는 속성 카드를 고르지 않는다', () => {
    const w = mkWorld(2);
    setBotPolicy(w, { forceNoElement: true, draft: 'elementRush' });
    const draft = { cards: [
      { category: 'elementLevel', key: 'e' },
      { category: 'weaponLevel', key: 'w' },
    ] };
    assert.eq(draft.cards[botDraftPick(w, draft)].category, 'weaponLevel', '속성 카드를 건너뛴다');
  });

  test('draft 정책이 선호 카테고리를 바꾼다', () => {
    const cards = [
      { category: 'passive', key: 'p' },
      { category: 'elementLevel', key: 'e' },
      { category: 'newWeapon', key: 'n', weaponId: 'fan' },
    ];
    const w1 = mkWorld(1); setBotPolicy(w1, { draft: 'generalist' });
    assert.eq(cards[botDraftPick(w1, { cards })].category, 'newWeapon', 'generalist = 무기 슬롯 먼저');
    const w2 = mkWorld(1); setBotPolicy(w2, { draft: 'elementRush' });
    assert.eq(cards[botDraftPick(w2, { cards })].category, 'elementLevel', 'elementRush = 속성 먼저');
  });
  // ★ v1.5 — shop 정책 테스트 폐지(경제 제거).
});

suite('bot/회피', () => {
  test('다가오는 탄을 피해 이동한다', () => {
    const w = mkWorld(4);
    const p = w.player;
    // 플레이어 바로 위에서 정면으로 내려오는 탄
    spawnEnemyBullet(w, 'pelletS', p.x, p.y - 120, 0, 260);
    let moved = false;
    for (let t = 0; t < 60 && !moved; t += 1) {
      const i = botInput(w, TICK_DT);
      if (i.left || i.right || i.up || i.down) moved = true;
    }
    assert.ok(moved, '위협이 있으면 움직인다');
  });

  test('난이도가 높을수록 반응이 느려진다 (배속 → 봇 반응 지연, §10.4.1)', () => {
    // «눈 감는 창»(world.bot.decideT = reactionSec)의 길이를 직접 본다 — 첫 botInput 호출이 창을 연다.
    //   ★ ㊿-q 검토: 예전엔 삭제된 'disaster' 를 비교했고(표에 없는 난이도 = speed 1 → «같은 값 ≥ 같은 값»),
    //     재는 것도 «첫 이동 틱»이었다 — 그런데 첫 호출이 곧바로 위협을 지각해 두 난이도 모두 0틱에 움직였다(0 vs 0).
    //     즉 이 테스트는 지연을 한 번도 잰 적이 없었다. 창의 길이는 봇 상태가 직접 말한다.
    //   같은 시드 = 같은 지터 draw 이므로 배속이 큰 쪽의 창이 «엄격히» 길어야 한다(250±80ms × 60틱 × speed 반올림).
    const d = loadData().meta.difficulty;
    const ids = Object.keys(d).filter((k) => d[k] !== null && typeof d[k] === 'object');
    const lo = ids[0];
    const hi = ids[ids.length - 1];
    assert.gt(d[hi].speed, d[lo].speed, `전제: ${hi} 의 배속이 ${lo} 보다 크다`);
    function reactWindowSec(difficulty) {
      const w = mkWorld(8, difficulty);
      botInput(w, TICK_DT);
      return w.bot.decideT;
    }
    assert.gt(reactWindowSec(hi), reactWindowSec(lo), `${hi} 의 눈 감는 창이 ${lo} 보다 길다`);
  });
});

// §10.4(v1.10 ㊿-t) 반사탄 예측 — 봇이 «실제로 찍은» 스냅샷으로 «실제로 쓰는» 롤아웃(rollSeg)을 돌려 첫 피격 틱이 실제 탄과 같은지 본다.
//   2차 검토: 테스트가 foldWall 을 제 인자로만 불러, 스냅샷 필드(bbounce · bwr)가 틀려도 초록이었다.
//   3차 검토: 외삽을 함수로 빼 그 함수만 재면, 롤아웃이 결과를 안 써도 초록이었다 — 그래서 롤아웃의 «답»을 잰다.
suite('bot/반사탄 예측 — 스냅샷 → 롤아웃 (§10.4 · ㊿-t 반사 벽)', () => {
  test('★ 롤아웃의 첫 피격 틱 = 실제 탄의 첫 피격 틱 — 바닥선 · 벽 반사 · 네 벽의 반경 여백 · HP·XP 띠 안에서 난 탄', () => {
    const data = loadData();
    const r = data.bullets.bullets.find((x) => x.id === 'ricochet').radius;
    const bare = () => createWorld({ data, seed: 1, weapons, hooks: {}, startWeaponId: 'forward' });   // 스테이지 훅 없는 맨 월드
    const probe = bare();
    const wl = probe.walls; const bd = probe.bounds;
    const floorLine = wl.y + wl.h; const right = wl.x + wl.w;
    const N = 120;                                   // 2초 — 맨 월드라 적 · 적 탄 · 장판이 생기지 않는다(시작 무기 forward 는 적 탄을 늦추거나 지우지 않는다)
    // [이름, 탄 x, y, vx, vy, 가상 기체 x, y, 실제로 닿는가]
    // ★ «여백 → 바깥» 표본이 벽마다 있어야 한다 — «여백 → 안» 표본만으로는 틀린 규칙(이전 위치를 벽선과 비교)이 두 번 되접혀
    //   제 궤적으로 돌아와서 첫 피격 틱이 같다(4차 망가뜨리기 실측: 위 벽에서 초록이었다).
    const cases = [
      ['바닥선에서 되튀어 돌아온다', 640, floorLine - 22, 0, 130, 640, floorLine - 72, true],
      ['비스듬히 바닥선 반사', 560, floorLine - 40, 80, 110, 624, floorLine - 60, true],
      ['오른쪽 벽에서 되튀어 돌아온다', right - 50, 300, 120, 0, right - 90, 300, true],
      ['왼쪽 여백 → 안으로 들어와 닿는다', wl.x + r / 2, 400, 60, 0, wl.x + 50, 400, true],
      ['왼쪽 여백 → 바깥(돌아오지 않는다)', wl.x + r / 2, 400, -60, 0, wl.x + 50, 400, false],
      ['위 여백 → 안으로 들어와 닿는다', 640, wl.y + r / 2, 0, 60, 640, bd.minY + 4, true],
      ['위 여백 → 바깥(돌아오지 않는다)', 600, wl.y + r / 2, 0, -60, 600, bd.minY + 4, false],
      ['HP·XP 띠 안 → 위로 들어와 닿는다', 640, floorLine + 28, 0, -140, 640, floorLine - 110, true],
      ['바닥 여백 → 바깥(돌아오지 않는다)', 640, floorLine - r / 2, 0, 60, 640, floorLine - 55, false],
      ['오른쪽 여백 → 바깥(돌아오지 않는다)', right - r / 2, 300, 60, 0, right - 50, 300, false],
    ];
    for (const [label, x, y, vx, vy, qx, qy, hits] of cases) {
      const w = bare();
      w.player.x = Math.min(Math.max(x, bd.minX), bd.maxX);   // 지각 반경 안에 두려고 실제 기체를 탄 가까이(이동 영역 안)
      w.player.y = Math.min(Math.max(y, bd.minY), bd.maxY);
      w.player.iframeSec = 1e9;                     // 탄이 기체에 먹혀 사라지지 않게
      const blt = spawnEnemyBullet(w, 'ricochet', x, y, vx, vy, '');
      botInput(w, TICK_DT);                          // 첫 입력 = 위협 스냅샷
      const b = w.bot;
      assert.eq(b.nBul, 1, `${label}: 전제 — 봇이 이 탄 1발을 찍었다`);
      assert.ok(b.nCon === 0 && b.nLas === 0, `${label}: 전제 — 탄 말고 다른 위협(몸통 · 장판 · 빔)이 없다`);
      // 스냅샷 필드를 직접 본다 — 데이터(피격 반경 비율)에 기대지 않는다(3차 검토)
      assert.ok(b.bx[0] === blt.x && b.by[0] === blt.y && b.bvx[0] === blt.vx && b.bvy[0] === blt.vy, `${label}: 스냅샷 위치 · 속도 = 탄`);
      assert.eq(b.bbounce[0], 1, `${label}: 무제한 반사탄(bounceLeft ${blt.bounceLeft})은 접기 대상`);
      assert.eq(b.bwr[0], blt.radius, `${label}: 벽 여백 = 탄의 그리는 반경(피격 반경 ${blt.hitRadius} 이 아니다)`);
      b.snapElapsed = 0;                             // 스냅샷 직후로 — 롤아웃 전역 틱 k = 실제 k틱 뒤
      const px = Math.min(Math.max(qx, bd.minX), bd.maxX);
      const py = Math.min(Math.max(qy, bd.minY), bd.maxY);
      const rr = b.br[0];
      let real = 0;
      for (let t = 1; t <= N && real === 0; t += 1) {
        step(w, makeInput(), TICK_DT);
        if (!blt.alive) break;
        const dx = px - blt.x; const dy = py - blt.y;
        if (dx * dx + dy * dy < rr * rr) real = t;
      }
      assert.eq(real > 0, hits, `${label}: 전제 — 실제 탄이 가상 기체에 ${hits ? '닿는다' : '안 닿는다'} (첫 피격 틱 ${real})`);
      assert.eq(rollSeg(w, b, px, py, 0, 0, 0, N), real, `${label}: 롤아웃의 첫 피격 틱 = 실제 (${real})`);
      // 전역 틱(startK) · 스냅샷 경과(snapElapsed)도 같은 시계다 — 10틱 뒤에서 이어 굴려도, 5틱이 이미 흘렀어도 같은 순간을 가리킨다(4차 검토)
      assert.ok(real === 0 || real > 10, `${label}: 전제 — 첫 피격이 10틱보다 뒤다 (${real})`);
      assert.eq(rollSeg(w, b, px, py, 10, 0, 0, N - 10), real, `${label}: startK 10 에서 이어 굴려도 같은 전역 틱`);
      b.snapElapsed = 5 * TICK_DT;
      assert.eq(rollSeg(w, b, px, py, 0, 0, 0, N - 5), real === 0 ? 0 : real - 5, `${label}: 스냅샷 뒤 5틱이 흘렀으면 5틱 먼저 닿는다`);
    }
    // ★ 반사하지 않는 탄은 접지 않는다 — 표본이 전부 반사탄이면 «모든 탄을 접는» 롤아웃 · «모든 탄을 반사탄으로 찍는» 스냅샷이 초록이었다(4차 검토)
    {
      const w = bare();
      w.player.iframeSec = 1e9;
      const blt = spawnEnemyBullet(w, 'pelletS', 640, floorLine - 22, 0, 130, '');
      botInput(w, TICK_DT);
      const b = w.bot;
      assert.eq(b.nBul, 1, '반사 안 하는 탄: 전제 — 봇이 이 탄 1발을 찍었다');
      assert.eq(b.bbounce[0], 0, `반사 안 하는 탄(bounceLeft ${blt.bounceLeft})은 접기 대상이 아니다`);
      b.snapElapsed = 0;
      const px = 640; const py = floorLine - 72;
      const rr = b.br[0];
      let real = 0;
      for (let t = 1; t <= N && real === 0; t += 1) {
        step(w, makeInput(), TICK_DT);
        if (!blt.alive) break;
        const dx = px - blt.x; const dy = py - blt.y;
        if (dx * dx + dy * dy < rr * rr) real = t;
      }
      assert.eq(real, 0, '반사 안 하는 탄: 전제 — 바닥선에서 튀지 않고 나가 가상 기체에 안 닿는다');
      assert.eq(rollSeg(w, b, px, py, 0, 0, 0, N), 0, '반사 안 하는 탄: 롤아웃도 안 닿는다고 본다(바닥선에서 접지 않는다)');
    }
  });
});
