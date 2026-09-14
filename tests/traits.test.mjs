/**
 * tests/traits.test.mjs — 특성 (§11.6, v1.10 ⑲ · ㉒)의 정본 계약.
 *
 * 커버:
 *   구슬   — 스테이지 보스 코어 격파 → 금색 구슬(kind 'trait') 이 자석으로 날아와 먹히면 traitQueue+1 · 그동안 STAGE_CLEAR 는 기다린다
 *            최종(테마 없음)은 구슬 없음
 *   드래프트 — 항상 세 특성 전부(데이터 순서, 무작위 없음) · 카드가 현재 레벨과 다음 값을 든다 · applyCard 가 레벨 +1 · traitQueue 소비
 *            · maxLevel 이면 그 카드는 빠진다 · 다섯 번 고르면 레벨 합 = 5
 *   흡혈 게이트 — HP 가 hpMax × hpRatio(0.5) 이하일 때만 듣는다 (㉗ 페널티)
 *   효과   — 자연 재생(레벨마다 초당 HP ↑) · 흡혈(실제로 깎은 HP × %, 오버킬 제외, 보스에도) · 쉴드(레벨마다 주기 ↓, 피격 1회 무효 + 재충전)
 *   봇     — 자연 재생을 올린다
 */

import { suite, test, assert, loadData, baselineDifficulty } from '../tools/test.mjs';
import { createWorld, spawnEnemy, applyTrait, giveWeapon } from '../src/core/state.js';
import { step, makeInput, TICK_DT, killEnemy, applyHit } from '../src/core/step.js';
import { weapons } from '../src/core/weapons/index.js';
import { bossHook } from '../src/core/boss.js';
import { initRun, tickRun, traitPickupAlive, PHASE } from '../src/core/stage.js';
import { buildTraitDraft, applyCard } from '../src/core/draft.js';
import { botDraftPick } from '../src/core/bot.js';
import { hitEnemy } from '../src/core/damage.js';

const dt = TICK_DT;

function mkRun(seed, stageId, pos = 0, hooks = { enemies: null, emitters: null, run: tickRun, boss: bossHook }) {
  const w = createWorld({ data: loadData(), seed, weapons, hooks, difficulty: baselineDifficulty() });
  initRun(w);
  if (stageId) w.run.order[pos] = stageId;
  w.run.stageIndex = pos;
  w.player.hp = 100; w.player.hpMax = 100;
  return w;
}
function tick(w, n, input = makeInput()) { for (let i = 0; i < n; i += 1) step(w, input, dt); }
function core(w) { for (const e of w.enemies.items) if (e.alive && e.isBoss && e.isCore) return e; return null; }
function traitPickups(w) { return w.pickups.items.filter((q) => q.alive && q.kind === 'trait'); }
function def(w, id) { return w.data.traits.traits.find((t) => t.id === id); }

suite('traits — 구슬 (§11.6)', () => {
  test('스테이지 보스 코어 격파 → 금색 구슬이 자석으로 날아와 먹히면 traitQueue 가 1 오르고, 그때까지 STAGE_CLEAR 를 기다린다', () => {
    const w = mkRun(3, 'sea', 0);
    w.run.phase = PHASE.BOSS; w.run.bossSpawned = false; w.run.bossTimer = w.data.stages.phase.bossTimerSec;
    tick(w, 2);
    const c = core(w);
    assert.ne(c, null, '보스가 섰다');
    w.player.x = c.x; w.player.y = c.y + 300;               // 구슬이 «날아올» 거리
    killEnemy(w, c);
    assert.eq(traitPickups(w).length, 1, '구슬 하나');
    assert.eq(traitPickups(w)[0].magnet, true, '자석이 켜져 있다');
    assert.eq(traitPickupAlive(w), true);
    tick(w, 1);
    assert.eq(w.run.phase, PHASE.BOSS, '구슬이 살아 있는 동안은 아직 BOSS (STAGE_CLEAR 대기)');
    let n = 0; while (traitPickupAlive(w) && n < 600) { tick(w, 1); n += 1; }
    assert.ok(n < 600, `구슬이 날아와 먹힌다 (${(n * dt).toFixed(2)}초)`);
    assert.eq(w.traitQueue, 1, '먹으면 traitQueue 1');
    tick(w, 2);
    assert.eq(w.run.phase, PHASE.STAGE_CLEAR, '그다음 STAGE_CLEAR');
  });

  test('최종(테마 없음)에서는 구슬이 없다', () => {
    const w = mkRun(3, 'finale', 5);
    w.run.phase = PHASE.BOSS; w.run.bossSpawned = false; w.run.bossTimer = w.data.stages.phase.bossTimerSec;
    tick(w, 2);
    const c = core(w);
    assert.ne(c, null, '최종 보스');
    killEnemy(w, c);
    assert.eq(traitPickups(w).length, 0, '최종은 구슬 0');
  });
});

suite('traits — 드래프트 (§11.6 ㉒)', () => {
  test('항상 세 특성 전부, 데이터 순서 그대로 · 카드는 현재 레벨과 다음 값 · applyCard 가 레벨 +1 · traitQueue 소비', () => {
    const w = mkRun(5, 'sea', 0);
    const td = w.data.traits;
    w.traitQueue = 1;
    const d1 = buildTraitDraft(w);
    assert.eq(d1.cards.length, td.traits.length, '세 장');
    assert.deepEq(d1.cards.map((c) => c.traitId), td.traits.map((t) => t.id), '데이터 순서(무작위 없음)');
    assert.ok(d1.cards.some((c) => c.traitId === 'lifesteal'), '흡혈도 카드다(㉗ — 3택)');
    for (let i = 0; i < d1.cards.length; i += 1) {
      const c = d1.cards[i];
      assert.eq(c.category, 'trait'); assert.eq(c.level, 0, 'Lv0'); assert.eq(c.from, null, '처음엔 from 없음');
      assert.eq(c.to, td.traits[i].effect.values[0], 'to = Lv1 값'); assert.eq(c.kind, td.traits[i].effect.kind);
    }
    applyCard(w, d1.cards[1]);
    assert.eq(w.traitQueue, 0, '큐 소비');
    assert.eq(w.traits[td.traits[1].id], 1, '레벨 1');
    const d2 = buildTraitDraft(w);
    assert.eq(d2.cards.length, td.traits.length, '여전히 세 장(같은 특성을 또 고를 수 있다)');
    const c1 = d2.cards[1];
    assert.eq(c1.level, 1); assert.eq(c1.from, td.traits[1].effect.values[0]); assert.eq(c1.to, td.traits[1].effect.values[1], 'from → to = Lv1 → Lv2');
    const w2 = mkRun(5, 'sea', 0); buildTraitDraft(w2); buildTraitDraft(w2);
    assert.eq(buildTraitDraft(w2).cards.map((c) => c.traitId).join(','), td.traits.map((t) => t.id).join(','), '결정적');
  });

  test('보스를 잡아도 특성이 저절로 오르지 않는다 — 구슬을 먹고 «골라야» 오른다 (㉖ 자동 지급 폐지)', () => {
    const w = mkRun(3, 'sea', 0);
    w.run.phase = PHASE.BOSS; w.run.bossSpawned = false; w.run.bossTimer = w.data.stages.phase.bossTimerSec; tick(w, 2);
    const c = core(w); assert.ne(c, null); killEnemy(w, c);
    assert.eq(Object.values(w.traits).reduce((a, b) => a + b, 0), 0, '레벨 합 0');
    assert.eq(traitPickups(w).length, 1, '구슬은 나온다');
  });

  test('다섯 번 고르면 레벨 합 = 5 · maxLevel 인 특성은 카드에서 빠진다 · applyTrait 는 maxLevel 에서 false', () => {
    const w = mkRun(6, 'sea', 0);
    const td = w.data.traits;
    const id = td.traits[0].id;
    for (let k = 0; k < td.maxLevel; k += 1) {
      const d = buildTraitDraft(w);
      assert.ok(d.cards.some((c) => c.traitId === id), `${k + 1}번째: 아직 나온다`);
      applyCard(w, d.cards.find((c) => c.traitId === id));
    }
    assert.eq(w.traits[id], td.maxLevel, '만렙');
    assert.eq(Object.values(w.traits).reduce((a, b) => a + b, 0), td.maxLevel, '레벨 합 = 구슬 수');
    assert.ok(!buildTraitDraft(w).cards.some((c) => c.traitId === id), '만렙 특성은 카드에서 빠진다');
    assert.eq(buildTraitDraft(w).cards.length, td.traits.length - 1, '나머지 둘은 남는다');
    assert.eq(applyTrait(w, id), false, 'maxLevel 초과 = false');
    assert.throws(() => applyTrait(w, 'nope'), '미지의 id 는 던진다');
  });

  test('봇은 자연 재생을 올린다', () => {
    const w = mkRun(7, 'sea', 0);
    const d = buildTraitDraft(w);
    assert.eq(d.cards[botDraftPick(w, d)].traitId, 'regen');
  });
});

suite('traits — 효과 (§11.6 ㉒)', () => {
  test('자연 재생 — 레벨마다 초당 HP 가 values[lv-1], hpMax 에서 멈춘다', () => {
    const w = mkRun(1, 'sea', 0);
    const d = def(w, 'regen');
    for (let lv = 1; lv <= 3; lv += 1) {
      applyTrait(w, 'regen');
      w.player.hp = 50;
      tick(w, 60);
      assert.near(w.player.hp, 50 + d.effect.values[lv - 1], 0.05, `Lv${lv}: 1초에 ${d.effect.values[lv - 1]}`);
    }
    w.player.hp = 99.9; tick(w, 60);
    assert.eq(w.player.hp, 100, '상한');
  });

  test('㊿-za 흡혈은 «내가 겨눈 무기»에만 든다 — 스스로 표적을 고르는 무기는 회복이 없다', () => {
    // 사용자(2026-09-12) 「자동 무기(내가 조준하지 않아도 알아서 맞추는 무기)에서는 흡혈이 작동하지 않는다」.
    //   거처는 rules.passiveHooks[family].lifesteal 하나 — 14 패밀리가 «전부» 선언한다(닫힌 키라 빠뜨릴 수 없다).
    const d = loadData();
    const hooks = d.rules.passiveHooks;
    const fams = Object.keys(hooks);
    assert.eq(fams.length, 14, '패밀리 14종');
    for (const f of fams) assert.eq(typeof hooks[f].lifesteal, 'boolean', `${f}: 흡혈 여부를 명시한다(기본값 없음)`);
    //  갈라져 있어야 한다 — 한쪽으로 몰리면 이 축이 죽은 것이다
    const on = fams.filter((f) => hooks[f].lifesteal);
    const off = fams.filter((f) => !hooks[f].lifesteal);
    assert.gt(on.length, 0, '드는 패밀리가 있다');
    assert.gt(off.length, 0, '안 드는 패밀리가 있다');
    //  사용자가 정한 목록 그대로인가 — 바꾸려면 이 줄을 같이 바꿔야 한다(조용히 안 새게)
    assert.eq(off.slice().sort().join(','), 'aura,barrage,beam,chain,drone,pinball,seeker',
      `안 드는 패밀리 (${off.sort().join(',')})`);
    //  실제로 회복이 0 인지 — 대표로 체인(스스로 표적을 고른다)을 돌린다
    const w = mkRun(1, 'sea', 0);
    applyTrait(w, 'lifesteal');
    const t = def(w, 'lifesteal');
    for (const sl of w.slots) { sl.weaponId = null; sl.family = null; sl.level = 0; sl.effDirty = true; }
    giveWeapon(w, 'chain');
    const e = spawnEnemy(w, 'drifter', 'normal', w.player.x, w.player.y - 120, 1e6, false);
    let healed = 0;
    for (let k = 0; k < 240; k += 1) {
      e.x = w.player.x; e.y = w.player.y - 120; e.hp = 1e6;
      w.player.hp = w.player.hpMax * t.effect.hpRatio;
      const before = w.player.hp;
      w.over = false;
      step(w, makeInput(), TICK_DT);
      if (w.player.hp > before) healed += w.player.hp - before;
    }
    assert.gt(e.dmgTotal, 0, `전제: 체인이 실제로 때렸다 (${e.dmgTotal.toFixed(1)})`);
    assert.eq(healed, 0, `체인은 회복이 0 이다 (피해 ${e.dmgTotal.toFixed(1)} · 회복 ${healed})`);
  });

  test('㊿-z8 흡혈은 «탄이 닿는 경로»에서도 든다 — 이 파일이 hitEnemy 를 직접 불러서 결함을 가렸다', () => {
    // 기존 흡혈 테스트는 damage.hitEnemy 를 «직접» 부른다. 실제 플레이의 탄→적 경로는 step.collide 이고
    //   그쪽은 hitEnemy 를 안 지난다 — 그래서 포워드·시커·부메랑·드론·오빗·핀볼은 흡혈이 한 방울도 안 들었다.
    //   여기서는 **진짜 step() 을 돌려** 탄이 맞게 한다.
    const w = mkRun(1, 'sea', 0);
    applyTrait(w, 'lifesteal');
    const d = def(w, 'lifesteal');
    for (const sl of w.slots) { sl.weaponId = null; sl.family = null; sl.level = 0; sl.effDirty = true; }
    giveWeapon(w, 'forward');                                   // 탄 무기 하나만 — 이 경로가 step.collide 다
    assert.eq(w.slots.filter((sl) => sl.family !== null).length, 1, '전제: 무기가 정확히 하나(피해와 회복이 1:1 로 대응해야 한다)');
    assert.ok(w.data.rules.passiveHooks.forward.lifesteal, '전제: forward 는 흡혈이 드는 패밀리다');
    const e = spawnEnemy(w, 'drifter', 'normal', w.player.x, w.player.y - 160, 1e6, false);
    let healed = 0;
    for (let t = 0; t < 240; t += 1) {
      e.x = w.player.x; e.y = w.player.y - 160; e.hp = 1e6;     // 표적을 세워 둔다
      w.player.hp = w.player.hpMax * d.effect.hpRatio;          // 매 틱 게이트 «안쪽»으로 되돌린다
      const before = w.player.hp;
      w.over = false;
      step(w, makeInput(), TICK_DT);
      if (w.player.hp > before) healed += w.player.hp - before;
    }
    assert.gt(e.dmgTotal, 0, `전제: 탄이 실제로 맞았다 (누적 피해 ${e.dmgTotal.toFixed(1)})`);
    assert.gt(healed, 0, `탄 경로에서도 회복이 든다 (피해 ${e.dmgTotal.toFixed(1)} → 회복 ${healed.toFixed(3)})`);
    //   회복 = 실제로 깎은 HP × pct. 여유 10% — 매 틱 HP 를 게이트 안쪽으로 «되돌리는» 측정이라
    //   마지막 창의 한 발이 셈 밖에 남을 수 있다.
    const want = e.dmgTotal * d.effect.values[0];
    assert.near(healed, want, want * 0.1,
      `회복 ≈ 피해 × ${d.effect.values[0]} (피해 ${e.dmgTotal.toFixed(1)} · 회복 ${healed.toFixed(3)} · 기대 ${want.toFixed(3)})`);
  });

  test('흡혈 — HP ≤ hpMax × hpRatio 일 때만 · 실제로 깎은 HP × pct 만큼 회복 · 오버킬은 안 센다 · 보스에도 · 레벨마다 pct ↑', () => {
    const w = mkRun(1, 'sea', 0);
    const d = def(w, 'lifesteal');
    assert.ok(d.effect.hpRatio > 0 && d.effect.hpRatio <= 0.6, `hpRatio ${d.effect.hpRatio} — 게이트가 있다`);
    const ctx = w.dmgCtx; ctx.matrix = w.data.elements.matrix;
    const e = spawnEnemy(w, 'drifter', 'normal', 640, 300, 1e6, false);
    w.player.hp = 50;
    hitEnemy(w, ctx, 'forward', 10, 1, 'normal', e, 0);
    assert.eq(w.player.hp, 50, '특성 없으면 0');
    applyTrait(w, 'lifesteal');
    // ㉗ 게이트 — 50% 초과면 안 듣는다, 정확히 50% 면 듣는다
    w.player.hp = w.player.hpMax * d.effect.hpRatio + 1;
    hitEnemy(w, ctx, 'forward', 10, 1, 'normal', e, 0);
    assert.eq(w.player.hp, w.player.hpMax * d.effect.hpRatio + 1, 'HP 가 게이트 위면 회복 0');
    w.player.hp = w.player.hpMax * d.effect.hpRatio;
    const dealt = hitEnemy(w, ctx, 'forward', 10, 1, 'normal', e, 0);
    assert.near(w.player.hp, w.player.hpMax * d.effect.hpRatio + dealt * d.effect.values[0], 1e-9, `게이트 이하: 깎은 ${dealt} × ${d.effect.values[0]}`);
    w.player.hp = 50;
    hitEnemy(w, ctx, 'forward', 10, 1, 'normal', e, 0);
    assert.near(w.player.hp, 50 + dealt * d.effect.values[0], 1e-9, '50 에서 회복');
    // 오버킬 — hp 2 짜리에 큰 피해: 2 만 센다
    const small = spawnEnemy(w, 'drifter', 'normal', 600, 300, 2, false);
    w.player.hp = 50;
    hitEnemy(w, ctx, 'forward', 100, 1, 'normal', small, 0);
    assert.near(w.player.hp, 50 + 2 * d.effect.values[0], 1e-9, '오버킬 제외');
    // 레벨 ↑
    applyTrait(w, 'lifesteal');
    w.player.hp = 50;
    const dealt2 = hitEnemy(w, ctx, 'forward', 10, 1, 'normal', e, 0);
    assert.near(w.player.hp, 50 + dealt2 * d.effect.values[1], 1e-9, 'Lv2 pct');
    // 보스
    const w2 = mkRun(2, 'sea', 0); const ctx2 = w2.dmgCtx; ctx2.matrix = w2.data.elements.matrix;
    w2.run.phase = PHASE.BOSS; w2.run.bossSpawned = false; w2.run.bossTimer = w2.data.stages.phase.bossTimerSec; tick(w2, 2);
    const c = core(w2); w2.run.bossTransitionT = 0; c.hp = 1e6;
    // ㉘ 하드 게이트 — 모듈을 다 부숴야 코어가 열린다
    for (const e of w2.enemies.items) if (e.alive && e.isBoss && !e.isCore) killEnemy(w2, e);
    tick(w2, 1); c.hp = 1e6; w2.run.bossTransitionT = 0;
    applyTrait(w2, 'lifesteal'); w2.player.hp = 50;
    const b = hitEnemy(w2, ctx2, 'forward', 10, 1, 'normal', c, 0);
    assert.gt(b, 0, '보스에 피해가 든다');
    assert.near(w2.player.hp, 50 + b * d.effect.values[0], 1e-9, '보스에서도 흡혈');
    // 게이트 위에서는 안 찬다(상한이 아니라 게이트가 막는다)
    w2.player.hp = 100; hitEnemy(w2, ctx2, 'forward', 10, 1, 'normal', c, 0);
    assert.eq(w2.player.hp, 100, '만피는 그대로');
  });

  test('쉴드 생성 — everySec 뒤 쉴드 1, 피격 1회를 통째로 막고 다시 충전 · 레벨이 오르면 주기가 짧아진다', () => {
    const w = mkRun(1, 'sea', 0);
    const d = def(w, 'shield');
    applyTrait(w, 'shield');
    assert.eq(w.traitState.shieldReady, false, '처음엔 없다');
    tick(w, Math.round(d.effect.values[0] / dt) - 5);
    assert.eq(w.traitState.shieldReady, false, '아직');
    tick(w, 7);
    assert.eq(w.traitState.shieldReady, true, 'everySec 뒤 충전');
    w.player.iframeSec = 0;
    assert.eq(applyHit(w, 30, ''), true, '피격 처리됨');
    assert.eq(w.player.hp, 100, '피해 0');
    assert.eq(w.traitState.shieldReady, false, '소모');
    assert.gt(w.player.iframeSec, 0, 'i-frame 은 그대로(연타 차단)');
    w.player.iframeSec = 0;
    applyHit(w, 30, '');
    assert.lt(w.player.hp, 100, '쉴드 없으면 맞는다');
    // 레벨 ↑ → 주기 ↓
    applyTrait(w, 'shield'); applyTrait(w, 'shield');
    w.traitState.shieldT = 0; w.traitState.shieldReady = false;
    let n = 0; while (!w.traitState.shieldReady && n < 60 * 30) { step(w, makeInput(), dt); n += 1; }
    assert.ok(Math.abs(n * dt - d.effect.values[2]) <= 2 * dt, `Lv3: ${d.effect.values[2]}초 (실제 ${(n * dt).toFixed(2)})`);
    assert.lt(d.effect.values[2], d.effect.values[0], '레벨이 오르면 주기가 짧다');
  });

  test('구슬 — 코어 격파가 구슬을 만들고 먹으면 큐가 오른다 (killEnemy 경로 회귀)', () => {
    const w = mkRun(3, 'sea', 0);
    w.run.phase = PHASE.BOSS; w.run.bossSpawned = false; w.run.bossTimer = w.data.stages.phase.bossTimerSec;
    tick(w, 2);
    const c = core(w); w.player.x = c.x; w.player.y = c.y + 60;
    killEnemy(w, c);
    assert.eq(traitPickups(w).length, 1);
    let n = 0; while (traitPickupAlive(w) && n < 600) { tick(w, 1); n += 1; }
    assert.eq(w.traitQueue, 1);
  });
});
