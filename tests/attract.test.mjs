/**
 * tests/attract.test.mjs — §6.5(v1.10 ㊿-s) 어트랙트: 타이틀 무입력 → 봇 쇼케이스 런이 «언제 끝나는가».
 *   입력(키·클릭)으로 끝나는 부분은 드라이버(main.js)의 몫이라 여기서는 core 의 판정(stage.attractOver)만 본다.
 *   설정 키가 살아 있는지(죽은 키 금지)는 check.mjs S63 이 본다.
 */
import { suite, test, assert, loadData } from '../tools/test.mjs';
import { createWorld } from '../src/core/state.js';
import { step, TICK_DT } from '../src/core/step.js';
import { weapons } from '../src/core/weapons/index.js';
import { enemies } from '../src/core/enemies.js';
import { emitters } from '../src/core/emitters.js';
import { bossHook } from '../src/core/boss.js';
import { initRun, tickRun, attractOver, PHASE } from '../src/core/stage.js';
import { setBotPolicy, botInput, botDraftPick } from '../src/core/bot.js';
import { buildDraft, applyCard } from '../src/core/draft.js';

function mk(seed = 11) {
  const d = loadData();
  const w = createWorld({ data: d, seed, weapons, hooks: { run: tickRun, enemies, emitters, boss: bossHook }, difficulty: d.meta.flow.attract.difficulty });
  initRun(w);
  return w;
}

suite('attract/끝나는 때 §6.5 ㊿-s', () => {
  test('잡몹 페이즈에서 살아 있으면 계속 · 사망이면 끝', () => {
    const w = mk();
    assert.eq(w.run.phase, PHASE.MOB, '전제: 런은 잡몹 페이즈로 시작한다');
    assert.eq(attractOver(w), false, '잡몹 페이즈 · 생존 = 계속');
    w.over = true;
    assert.eq(attractOver(w), true, '사망 = 끝 (결과 화면 없이 타이틀로)');
  });

  test('endAfterMobPhase 면 잡몹 페이즈를 벗어나는 순간 끝 — 끄면 보스전도 이어서 보여준다', () => {
    const w = mk();
    assert.eq(w.data.meta.flow.attract.endAfterMobPhase, true, '전제: 데이터는 잡몹 페이즈만 보여준다');
    for (const ph of [PHASE.BOSS_INTRO, PHASE.BOSS, PHASE.STAGE_CLEAR]) {
      w.run.phase = ph;
      assert.eq(attractOver(w), true, `${ph} = 끝 (스포일러 방지 · 루프 길이)`);
    }
    // 끈 데이터(복제본 — 공유 캐시를 건드리지 않는다)에서는 보스전도 계속이다
    const d2 = structuredClone(loadData());
    d2.meta.flow.attract.endAfterMobPhase = false;
    const w2 = createWorld({ data: d2, seed: 11, weapons, hooks: { run: tickRun, enemies, emitters, boss: bossHook }, difficulty: d2.meta.flow.attract.difficulty });
    initRun(w2);
    w2.run.phase = PHASE.BOSS;
    assert.eq(attractOver(w2), false, 'endAfterMobPhase=false 면 보스전까지 이어서 보여준다');
    w2.over = true;
    assert.eq(attractOver(w2), true, '그래도 사망이면 끝');
  });

  test('봇 쇼케이스 런 = 잡몹 페이즈를 끝까지(보스 등장 순간) 보여 주거나 그 전에 죽어서 끝난다 · 봇이 실제로 움직인다 (결정적 · 시드 고정)', () => {
    // ★ 검토: «잡몹 페이즈 + 10초 안에 끝난다»만 보면 페이즈 타이머가 늘 채워 줘서 무엇을 망가뜨려도 통과했다.
    const w = mk(7);
    setBotPolicy(w, { farm: 'maxFarm', draft: 'generalist' });
    const mobSec = w.data.stages.phase.mobPhaseSec;
    const limit = Math.round((mobSec + 10) / TICK_DT);
    const x0 = w.player.x;
    let maxDx = 0;
    let t = 0;
    while (t < limit && !attractOver(w)) {
      step(w, botInput(w, TICK_DT), TICK_DT);
      t += 1;
      maxDx = Math.max(maxDx, Math.abs(w.player.x - x0));
      while (w.draftQueue > 0 && !w.over) { const dr = buildDraft(w); applyCard(w, dr.cards[botDraftPick(w, dr)]); }   // 드라이버처럼 봇이 고른다
    }
    const sec = t * TICK_DT;
    assert.ok(attractOver(w), `잡몹 페이즈 + 10초 안에 끝났다 (${sec.toFixed(1)}초)`);
    if (w.over) {
      assert.lt(sec, mobSec, '사망이면 잡몹 페이즈 안에서 끝났다');
    } else {
      assert.eq(w.run.phase, PHASE.BOSS_INTRO, '살아서 끝나면 = 보스 등장 순간 — 위기 구간 같은 중간에서 끊기지 않는다');
      assert.lte(Math.abs(sec - mobSec), TICK_DT * 2, `잡몹 페이즈 길이(${mobSec}초)만큼 보여 줬다 (${sec.toFixed(2)}초)`);
    }
    assert.gt(maxDx, 40, `봇 입력이 기체를 움직였다 (최대 가로 이동 ${maxDx.toFixed(0)}px)`);
  });
});
