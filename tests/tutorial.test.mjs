/**
 * tests/tutorial.test.mjs — §6.7(v1.10 ㊴ · ㊻ 6스텝) 튜토리얼의 계약.
 *
 * 커버:
 *   · 데이터 — 스텝 id 고유 · 목표 어휘 닫힘 · 문구가 있다 · 어휘가 전부 쓰인다
 *   · 진행   — 각 목표가 «실제로» 충족되면 다음 스텝으로 간다(전 스텝을 스크립트로 통과)
 *   · 이어짐 — ② 가 남긴 경험치를 ③ 이 쓴다 · ④ 는 빌드를 초기화한다 · ② 에서는 구슬이 끌려오지 않는다
 *   · 안전   — 죽지 않는다 · 표적/경험치가 떨어지면 다시 놓아 준다(막히지 않는다)
 *   · 봉인   — 보스 스텝은 «층»이다: 열린 모듈 → 보호막 모듈 → 코어
 */

import { suite, test, assert, loadData } from '../tools/test.mjs';
import { createWorld, giveWeapon } from '../src/core/state.js';
import { step, makeInput, TICK_DT, killEnemy } from '../src/core/step.js';
import { buildDraft, applyCard } from '../src/core/draft.js';
import { weapons } from '../src/core/weapons/index.js';
import { emitters } from '../src/core/emitters.js';
import { initRun } from '../src/core/stage.js';
import { hitEnemy } from '../src/core/damage.js';
import { stampFor } from '../src/core/stance.js';
import { makeTutorialState, tickTutorial, tutorialStep, GOALS } from '../src/core/tutorial.js';

function mk() {
  const data = loadData();
  const world = createWorld({
    data, seed: 1, weapons,
    hooks: { enemies: null, emitters, run: tickTutorial, boss: null },
    startWeaponId: data.tutorial.startWeaponId,
  });
  initRun(world);
  world.tut = makeTutorialState();
  return world;
}
function tick(w, n, input) { for (let i = 0; i < n; i += 1) { w.over = false; step(w, input || makeInput(), TICK_DT); } }
function stepIndex(w, id) { return w.data.tutorial.steps.findIndex((s) => s.id === id); }
function at(w, id) { w.tut.i = stepIndex(w, id); w.tut.entered = false; tick(w, 1); }

suite('tutorial — 데이터 (§6.7 ㊻)', () => {
  test('스텝 id 고유 · 목표 어휘 닫힘 · 문구 1~3줄 · 어휘가 전부 쓰인다', () => {
    const d = loadData();
    const steps = d.tutorial.steps;
    assert.eq(steps.length, 6, '6스텝 (사용자 확정)');
    const ids = new Set();
    const kinds = new Set();
    for (const s of steps) {
      assert.eq(ids.has(s.id), false, `중복 없음: ${s.id}`);
      ids.add(s.id);
      assert.ok(GOALS.indexOf(s.goal.kind) >= 0, `목표 어휘: ${s.goal.kind}`);
      kinds.add(s.goal.kind);
      assert.ok(s.lines.length >= 1 && s.lines.length <= 3, `${s.id}: 문구 ${s.lines.length}줄`);
      assert.ok(s.title.length > 0, `${s.id}: 제목이 있다`);
    }
    for (const k of GOALS) assert.ok(kinds.has(k), `죽은 목표 어휘 없음: ${k}`);
  });
});

suite('tutorial — 진행 (§6.7 ㊻)', () => {
  test('여섯 스텝을 목표 충족으로 전부 통과한다 (스크립트)', () => {
    const w = mk();
    const guard = 60 * 600;
    let t = 0;
    while (!w.tut.done && t < guard) {
      const s = tutorialStep(w);
      if (s === null) { tick(w, 1); t += 1; continue; }        // 완료 표시 대기
      const k = s.goal.kind;
      if (k === 'move') {
        const inp = makeInput(); inp.left = t % 20 < 10; inp.right = !inp.left;
        tick(w, 1, inp);
      } else if (k === 'clear') {
        for (const e of w.enemies.items) if (e.alive) killEnemy(w, e);
        tick(w, 1);
      } else if (k === 'level') {
        //   ★ ㊿-z8 — 예전에는 여기서 w.player.level 을 «대입»해 넘겼다. 그러면 레벨업이 큐를 안 쌓아
        //   **드래프트가 한 번도 안 열리고**, 슬롯 1 이상이 영영 비어 있었다. 실제 플레이는 카드를 뽑아
        //   여러 슬롯을 채운 채 ④(초기화)로 들어간다 — 그 차이가 «주인 잃은 탄» 결함을 테스트에서 가렸다.
        //   그냥 돌리면 앞 스텝의 처치가 남긴 구슬이 자석에 빨려 들어와 레벨이 «진짜로» 오른다.
        tick(w, 1);
      } else if (k === 'superHit') {
        // «속성을 바꿔서» — 아직 ×2 를 못 낸 속성을 골라, 그 속성을 이기는 스탠스로 바꾸고 그 적 아래에 선다
        const BEATS = { grass: 'fire', fire: 'water', water: 'grass' };   // 공격 스탠스 → 먹잇감
        const want = w.enemies.items.find((x) => x.alive && w.tut.superEls.indexOf(x.element) < 0);
        const inp = makeInput();
        if (want) {
          const need = BEATS[want.element];
          if (w.player.stance !== need) { inp.stanceFire = need === 'fire'; inp.stanceWater = need === 'water'; inp.stanceGrass = need === 'grass'; }
          w.player.x = want.x;
        }
        tick(w, 1, inp);
      } else if (k === 'terrain') {
        const ter = w.terrain.items.find((x) => x.alive && w.tut.kinds.indexOf(x.kind) < 0);
        if (ter) { w.player.x = ter.x; w.player.y = ter.y; }
        tick(w, 1);
      } else if (k === 'boss') {
        for (const e of w.enemies.items) if (e.alive && !e.sealedNow) killEnemy(w, e);
        tick(w, 1);
      } else throw new Error(`테스트가 모르는 목표: ${k}`);
      //   레벨업 큐가 쌓이면 사람처럼 카드를 뽑는다 — 슬롯이 여럿 차야 ④ 의 초기화가 «여러 슬롯»을 비운다
      let guard2 = 0;
      while (w.draftQueue > 0 && guard2 < 20) { const dr = buildDraft(w); applyCard(w, dr.cards[0]); guard2 += 1; }
      //   ㊿-z8 불변식 — 살아 있는 플레이어 탄은 언제나 «무기가 든» 슬롯을 가리킨다.
      //   비운 슬롯을 가리키는 탄은 맞는 순간 familyDmgMul 에서 렌더를 죽인다(사용자 제보).
      for (const b of w.playerBullets.items) {
        if (!b.alive) continue;
        assert.ok(w.slots[b.slot] !== undefined && w.slots[b.slot].family !== null,
          `t=${t}: 살아 있는 탄이 빈 슬롯 ${b.slot} 을 가리킨다 — 맞는 순간 familyDmgMul 이 죽는다`);
      }
      t += 1;
    }
    assert.eq(w.tut.done, true, `전 스텝 통과 (스텝 ${w.tut.i}/6, ${(t / 60).toFixed(0)}초)`);
  });

  test('② 자동 공격 — 구슬이 끌려오지 않는다(경험치는 ③ 의 몫)', () => {
    const w = mk();
    at(w, 'autofire');
    for (const e of w.enemies.items) if (e.alive) killEnemy(w, e);
    tick(w, 5);
    assert.gt(w.pickups.live, 0, '구슬이 떨어졌다');
    const rp = w.data.rules.player;
    const mag = rp.magnetRadius * (1 + w.stats.areaMul);
    tick(w, 120);
    for (const q of w.pickups.items) {
      if (!q.alive) continue;
      assert.eq(q.magnet, false, '자석이 꺼져 있다');
      const d = Math.hypot(q.x - w.player.x, q.y - w.player.y);
      assert.ok(d >= mag, `구슬이 자석 반경 밖에 있다 (${d.toFixed(0)} ≥ ${mag.toFixed(0)})`);
    }
    assert.eq(w.player.level, 1, '아직 레벨업하지 않았다');
  });

  test('③ 레벨업 — 앞 스텝이 남긴 구슬을 그대로 쓴다(새 적을 놓지 않는다) · 없으면 다시 뿌린다', () => {
    const w = mk();
    at(w, 'autofire');
    for (const e of w.enemies.items) if (e.alive) killEnemy(w, e);
    tick(w, 5);
    const orbs = w.pickups.live;
    assert.gt(orbs, 0, '구슬이 있다');
    at(w, 'levelup');
    assert.eq(w.pickups.live, orbs, '구슬은 그대로 남는다');
    assert.eq(w.enemies.items.filter((e) => e.alive).length, 0, '새 적을 놓지 않는다');
    // 구슬을 전부 없애면 다시 뿌려 준다(막히지 않는다)
    for (const q of w.pickups.items) if (q.alive) w.pickups.release(q);
    tick(w, Math.ceil(2.0 / TICK_DT));
    assert.gt(w.pickups.live, 0, '재보급됐다');
  });

  test('④ 속성 바꾸기 — 빌드를 초기화하고 세 속성 적을 놓는다', () => {
    const w = mk();
    at(w, 'levelup');
    // 레벨업으로 받은 것을 흉내낸다: 무기 하나 더 + 패시브 하나
    const before = w.slots.filter((s) => s.weaponId !== null).length;
    assert.eq(before, 1, '시작은 무기 1');
    at(w, 'stance');
    assert.eq(w.slots.filter((s) => s.weaponId !== null).length, 1, '초기화 뒤에도 무기는 하나');
    assert.eq(w.slots[0].level, 1, 'Lv1 로 되돌아왔다');
    assert.eq(w.passives.filter((p) => p.id !== null).length, 1, '초기화 뒤 패시브는 시작 짝 하나뿐');
    const els = new Set(w.enemies.items.filter((e) => e.alive).map((e) => e.element));
    for (const el of ['fire', 'water', 'grass']) assert.ok(els.has(el), `${el} 적이 있다`);
    assert.eq(w.player.invest.fire, 1, '불 투자 1(각인이 내려간다)');
    assert.eq(w.data.tutorial.steps[stepIndex(w, 'stance')].goal.value, 3, '세 속성 전부에 ×2 를 내야 넘어간다 — 그래야 «바꿔서» 공격하게 된다');
  });

  test('㊿-z7 빌드 초기화는 «낳은 것»까지 거둔다 — 날아가던 탄이 주인 잃은 슬롯을 되묻지 않는다', () => {
    // 재현: ④(속성 바꾸기)는 빌드를 초기화한다. 그 순간 살아 있던 플레이어 탄은 b.slot 으로 자기 무기를 되묻는데,
    //   비운 슬롯의 family 가 null 이라 passiveHooks[null].dmgStat 에서 렌더가 통째로 죽었다(사용자 제보).
    const w = mk();
    at(w, 'autofire');
    tick(w, 120);                                   // 2초 — 자동 발사로 탄이 난다
    assert.gt(w.playerBullets.live, 0, '전제: 살아 있는 플레이어 탄이 있다');
    const slotOfLive = w.playerBullets.items.filter((b) => b.alive).map((b) => b.slot);
    assert.gt(slotOfLive.length, 0, '전제: 그 탄들은 슬롯을 가리킨다');
    // ㊿-z8 — 예고도 무기가 낳는다. 바라지를 쥐여 예고를 하나 띄워 둔 채 초기화에 들어간다.
    giveWeapon(w, 'barrage');
    for (let g = 0; g < 400 && w.telegraphs.live === 0; g += 1) tick(w, 1);
    assert.gt(w.telegraphs.live, 0, '전제: 바라지 예고가 떠 있다');
    at(w, 'stance');                                // 여기서 resetLoadout 이 슬롯을 비운다
    assert.eq(w.playerBullets.live, 0, '초기화가 날아가던 탄을 거둔다 — 주인 없는 탄이 남지 않는다');
    assert.eq(w.drones.live, 0, '드론도 거둔다 — 남으면 «없는 무기»가 계속 쏜다');
    // step.hazards 는 'laser'(적 빔)만 소유한다 — 나머지 kind 는 만든 무기가 소유하므로 같이 거둬야 한다.
    assert.eq(w.telegraphs.items.filter((t) => t.alive && t.kind !== 'laser').length, 0,
      '무기가 낳은 예고도 거둔다 — 주인 없는 예고가 남지 않는다');
    // 적을 세워 두고 한참 돌려도 안 터진다(맞는 순간이 그 죽던 자리였다)
    tick(w, 240);
    assert.ok(true, '초기화 뒤 계속 돌려도 예외가 없다');
  });

  test('㊿-z8 지형 «없음»의 센티널은 -1 이다 — null 로 비교하면 지형 밖에서 dwellT 가 NaN 이 된다', () => {
    // terrain.terrainUnder 는 «없음»을 -1 로 돌려준다(step.js 도 -1 로 읽는다). null 로 비교하면
    //   지형 «밖»에서도 매 틱 가지가 통과해 dwellT[-1] 이 NaN 이 되고, 배열에 "-1" 프로퍼티가 눌러앉는다.
    //   지금은 NaN 이 비교를 삼켜 결과가 우연히 맞지만, -1 이 유효 인덱스가 되는 날 바로 오작동한다.
    const w = mk();
    at(w, 'terrain');
    const far = w.data.rules.view.arena;
    for (let t = 0; t < 180; t += 1) {                 // 3초 — 어떤 장판에도 안 닿는 자리에서
      w.player.x = far.x + 8; w.player.y = far.y + far.h - 8;
      tick(w, 1);
    }
    assert.eq(w.tut.dwellT.length, 3, '지형 종 수만큼만 있다');
    assert.eq(w.tut.dwellT.some(Number.isNaN), false, `NaN 이 없다 (${JSON.stringify(w.tut.dwellT)})`);
    assert.eq(Object.keys(w.tut.dwellT).join(','), '0,1,2', '음수 인덱스 프로퍼티가 안 생긴다');
    assert.eq(w.tut.kinds.length, 0, '지형 밖에서는 아무 종도 안 세어진다');
  });

  test('⑤ 지형 — 세 종이 한 번에 놓이고, 세 종에 «머물러야» 넘어간다 (㊿-z5: 스쳐 가면 안 센다)', () => {
    const w = mk();
    at(w, 'terrain');
    const kinds = new Set(w.terrain.items.filter((t) => t.alive).map((t) => t.kind));
    assert.eq(kinds.size, 3, '둔화·미끄러움·과열이 다 있다');
    const idx = stepIndex(w, 'terrain');
    const list = w.terrain.items.filter((t) => t.alive);
    const dwell = w.data.tutorial.terrainDwellSec;
    const secs = (n) => Math.ceil(n / TICK_DT);
    // ① 세 종을 다 «스쳐 가도» 안 넘어간다 — 효과는 있는 동안에 드러난다
    for (const t of list) { w.player.x = t.x; w.player.y = t.y; tick(w, secs(dwell * 0.4)); }
    assert.eq(w.tut.i, idx, `세 종을 스쳐 가기만 하면(각 ${(dwell * 0.4).toFixed(1)}초) 안 넘어간다`);
    assert.eq(w.tut.kinds.length, 0, '머문 시간이 모자란 종은 세지 않는다');
    // ② 한 종에만 오래 머물러도 안 넘어간다
    w.player.x = list[0].x; w.player.y = list[0].y;
    tick(w, secs(dwell + 0.2));
    assert.eq(w.tut.kinds.length, 1, '머문 종 하나가 세어진다');
    assert.eq(w.tut.i, idx, '한 종만으로는 안 넘어간다');
    // ③ 나머지 종에도 머물면 넘어간다(최소 체류는 ①②에서 이미 지났다 — 넘어가는 순간 kinds 는 다음 스텝 것으로 비워진다)
    for (const t of list) { w.player.x = t.x; w.player.y = t.y; tick(w, secs(dwell + 0.2)); }
    assert.gt(w.tut.i, idx, '세 종에 머물고 최소 체류도 지나면 넘어간다');
  });

  test('㊿-z5 최소 체류 — 목표를 일찍 채워도 minSec 전에는 안 넘어간다 (안내를 읽을 시간)', () => {
    const d = loadData();
    // 모든 스텝에 «읽을 시간»이 있어야 한다 — 0 이면 그 스텝은 목표만 채우면 글이 스쳐 지나간다.
    //   기능이 데이터에서 조용히 꺼지는 것을 막는다(값을 0 으로 눕히면 ㊿-z5 는 없던 일이 된다).
    for (const st of d.tutorial.steps) {
      assert.gt(st.minSec, 0, `${st.id}.minSec > 0 — 안내가 있는 스텝에는 읽을 시간이 있다`);
      assert.gte(st.minSec, st.lines.length, `${st.id}.minSec 은 최소 줄 수(${st.lines.length})만큼 — 한 줄에 1초는 준다`);
    }
    assert.gt(d.tutorial.steps.find((s) => s.id === 'levelup').minSec, 0,
      '레벨업 스텝엔 최소 체류가 있다 — 경험치가 저절로 빨려 들어와 설명을 읽기 전에 끝났다(사용자)');
    // 이동 스텝 — 목표(움직인 거리)를 «직접» 채워 두고 시간만 본다.
    //   실제로 걸어서 채우면 아레나 벽에 막혀 거리가 안 나온다 — 여기서 재려는 것은 이동이 아니라 «시간»이다.
    const idx = stepIndex(mk(), 'move');
    const minSec = d.tutorial.steps[idx].minSec;
    const w = mk();
    at(w, 'move');
    w.tut.movedPx = d.tutorial.steps[idx].goal.value + 1;   // 목표는 이미 채웠다
    tick(w, Math.floor(minSec / TICK_DT) - 4);
    assert.eq(w.tut.i, idx, `목표를 채웠어도 minSec(${minSec}초) 전에는 안 넘어간다`);
    tick(w, 8);
    assert.gt(w.tut.i, idx, '최소 체류가 지나면 넘어간다');
  });

  test('㊿-z8 튜토리얼 보스는 특성 구슬을 안 떨군다 — 쓸 수 없는 보상은 보상이 아니다', () => {
    const w = mk();
    at(w, 'boss');
    const c = w.enemies.items.find((e) => e.alive && e.isCore);
    assert.ok(c !== undefined, '전제: 코어가 있다');
    for (const m of w.enemies.items) if (m.alive && m.isBoss && !m.isCore) killEnemy(w, m);
    tick(w, 2);
    killEnemy(w, c);
    tick(w, 60);
    // 특성 3택은 PHASE.STAGE_CLEAR 에서만 열린다 — 튜토리얼의 run.phase 는 끝까지 MOB 이라 먹어도 아무 일이 없다
    assert.eq(w.pickups.items.filter((q) => q.alive && q.kind === 'trait').length, 0, '금색 구슬이 안 나온다');
    assert.eq(w.traitQueue, 0, '먹을 것이 없으니 큐도 안 쌓인다');
  });

  test('⑥ 보호막 — 열린 모듈 → 보호막 모듈 → 코어의 «층»이다', () => {
    const w = mk();
    at(w, 'boss');
    const mods = w.enemies.items.filter((e) => e.alive && e.isBoss && !e.isCore);
    const core = w.enemies.items.find((e) => e.alive && e.isCore);
    assert.eq(mods.length, 2, '모듈 2기');
    assert.ok(core !== undefined, '코어가 있다');
    const open = mods.find((m) => !m.sealedNow);
    const shielded = mods.find((m) => m.sealedNow);
    assert.ok(open !== undefined && shielded !== undefined, '하나는 열려 있고 하나는 보호막');
    assert.eq(core.sealedNow, true, '코어는 봉인');
    const ctx = { matrix: w.data.elements.matrix, dmgMulSum: 0, elementBonusMul: 1 };
    const stamp = stampFor(w, 0, 'spawn', 'normal');
    assert.eq(hitEnemy(w, ctx, 'forward', 9999, 1, stamp, shielded, 0), 0, '보호막 모듈은 피해 0');
    assert.gt(hitEnemy(w, ctx, 'forward', 1, 1, stamp, open, 0), 0, '열린 모듈은 맞는다');
    killEnemy(w, open);
    tick(w, 2);
    assert.eq(shielded.sealedNow, false, '앞 모듈이 죽으면 보호막이 풀린다');
    assert.eq(core.sealedNow, true, '코어는 아직 봉인');
    killEnemy(w, shielded);
    tick(w, 2);
    assert.eq(core.sealedNow, false, '모듈이 전부 죽으면 코어가 열린다');
  });

  test('죽지 않는다 — HP 가 safeHpFloor 아래로 내려가면 가득 채운다', () => {
    const w = mk();
    at(w, 'autofire');
    w.player.hp = 1;
    tick(w, 2);
    assert.eq(w.player.hp, w.player.hpMax, 'safeHpFloor 아래 = 가득 회복');
    assert.eq(w.over, false, '사망 없음');
  });
});
