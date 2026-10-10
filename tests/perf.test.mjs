/**
 * tests/perf.test.mjs — v1.10 ㊿-zl 렌더 최적화가 «그림을 바꾸지 않는다»는 계약.
 *   사용자(2026-10-10) 테스터 제보 「중간중간 게임이 끊긴다」 → 화면은 그대로 두고 한 프레임의 일만 줄인다.
 *
 *   ① §9.4.1 hud.panelCacheDirtyOnly — 좌우 패널은 입력이 바뀔 때만 다시 그린다.
 *      · 캐시에 그린 글자 = drawPanels 가 직접 그린 글자(같은 문자열 · 같은 논리 좌표 · 같은 순서)
 *      · 입력이 그대로면 다시 그리지 않는다(찍기 2회뿐) · 입력 하나만 바뀌어도 다시 그린다
 *      · 캐시 = 본 캔버스와 같은 크기 · 같은 변환 한 장, «같은 자리»로 1:1 복사(소수 배율에서도 정수 기기 픽셀) · 못 만들면 직접 그린다
 *        (패널 폭만큼 잘라 옮긴 좌표로 그렸더니 배율 1.25 에서 글자 일부가 다른 서브픽셀 칸에 떨어졌다 — 브라우저 실측 1,372px)
 *   ② 경험치 구슬 = fill 1회(구슬 수와 무관)
 *   ③ rgba 색 문자열 = 캐시(같은 입력 = 같은 문자열) · 알파는 8비트 칸 · NaN 은 숨기지 않는다
 */
import { suite, test, assert, loadData } from '../tools/test.mjs';
import { createWorld, giveWeapon, givePassive, applyTrait, spawnPickup } from '../src/core/state.js';
import { weapons } from '../src/core/weapons/index.js';
import { enemies } from '../src/core/enemies.js';
import { emitters } from '../src/core/emitters.js';
import { tickRun, initRun } from '../src/core/stage.js';
import { bossHook } from '../src/core/boss.js';
import { resolvePalette, drawWorld, makeInterp, makeFx, rgba } from '../src/render/draw.js';
import { drawPanels, drawPanelsCached, makePanelCache } from '../src/render/hud.js';

/** 호출을 기록하는 2D 컨텍스트 — 칠은 안 하고 «무엇을 어떤 상태로 불렀나»만 남긴다. save/restore 깊이도 센다. */
function recCtx() {
  const state = { font: '16px sans-serif', textAlign: 'left', textBaseline: 'alphabetic', fillStyle: '#000', strokeStyle: '#000',
    lineWidth: 1, globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: true };
  const stack = [];
  const rec = { texts: [], images: [], transforms: [], fills: [], calls: 0, depth: () => stack.length, state };
  const target = {
    canvas: { width: 1280, height: 720 },
    save: () => { stack.push({ ...state }); },
    restore: () => { if (stack.length) Object.assign(state, stack.pop()); },
    measureText: (t) => ({ width: String(t).length * 8 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillText: (t, x, y) => { rec.texts.push(`${t}@${x},${y}`); },
    drawImage: (img, ...a) => { rec.images.push({ img, a, smoothing: state.imageSmoothingEnabled }); },
    setTransform: (...a) => { rec.transforms.push(a); },
    fill: () => { rec.fills.push(state.fillStyle); },
  };
  const ctx = new Proxy(target, {
    get(t, k) { if (k in t) { rec.calls += 1; return t[k]; } if (k in state) return state[k]; return () => { rec.calls += 1; }; },
    set(t, k, v) { state[k] = v; return true; },
  });
  return { ctx, rec };
}

/** 오프스크린 캔버스 흉내 — getContext 가 기록 컨텍스트를 준다. made 에 만든 것을 모은다. */
function canvasFactory(made) {
  return (w, h) => {
    const r = recCtx();
    const c = { width: w, height: h, getContext: () => r.ctx, rec: r.rec };
    made.push(c);
    return c;
  };
}

function mkW() {
  const w = createWorld({ data: loadData(), seed: 5, weapons, hooks: { enemies, emitters, run: tickRun, boss: bossHook }, startWeaponId: 'forward' });
  initRun(w);
  for (const id of ['orbit', 'missile', 'drone']) giveWeapon(w, id);
  givePassive(w, 'study');
  applyTrait(w, 'lifesteal');
  return w;
}

const layerTexts = (made) => made.flatMap((c) => c.rec.texts);

suite('perf — §9.4.1 패널 캐시 (㊿-zl)', () => {
  test('캐시에 그린 글자 = drawPanels 가 직접 그린 글자 (문자열 · 논리 좌표 · 순서) · 본 캔버스엔 바탕 + 찍기 2회뿐', () => {
    const w = mkW();
    const pal = resolvePalette(w.data.rules);
    const direct = recCtx();
    drawPanels(direct.ctx, w, pal);
    const made = [];
    const main = recCtx();
    drawPanelsCached(main.ctx, w, pal, makePanelCache(canvasFactory(made)), 1);
    assert.eq(made.length, 1, '캐시는 한 장(본 캔버스와 같은 크기)');
    assert.deepEq(layerTexts(made), direct.rec.texts, '같은 글자가 같은 자리에 같은 순서로');
    assert.gt(direct.rec.texts.length, 40, `패널 글자 ${direct.rec.texts.length}줄 (vacuous 아님)`);
    assert.eq(main.rec.texts.length, 0, '본 캔버스에는 글자를 직접 쓰지 않는다');
    assert.eq(main.rec.images.length, 2, '본 캔버스에는 캐시 두 장을 찍는다');
    assert.eq(main.rec.depth(), 0, 'save/restore 균형');
    assert.eq(main.rec.state.globalAlpha, 1, 'globalAlpha 원상');
    assert.eq(main.rec.state.imageSmoothingEnabled, true, '찍은 뒤 이미지 스무딩 원상(restore)');
    assert.ok(main.rec.images.every((im) => im.smoothing === false), '찍을 때는 스무딩 없이(1:1 기기 픽셀)');
  });

  test('입력이 그대로면 다시 그리지 않는다 — 다음 프레임은 찍기 2회뿐', () => {
    const w = mkW();
    const pal = resolvePalette(w.data.rules);
    const made = [];
    const cache = makePanelCache(canvasFactory(made));
    const main = recCtx();
    drawPanelsCached(main.ctx, w, pal, cache, 2);
    const n0 = layerTexts(made).length;
    for (let i = 0; i < 5; i += 1) drawPanelsCached(main.ctx, w, pal, cache, 2);
    assert.eq(layerTexts(made).length, n0, '캐시에 새로 그린 글자 0');
    assert.eq(main.rec.images.length, 12, '6 프레임 × 찍기 2회');
    assert.eq(made.length, 1, '캔버스를 새로 만들지 않는다');
  });

  test('패널 입력이 하나라도 바뀌면 다시 그린다 — 스탠스 · 투자 · 무기 레벨 · 진화 · 패시브 · 특성 · 쉴드', () => {
    const w = mkW();
    const pal = resolvePalette(w.data.rules);
    const made = [];
    const cache = makePanelCache(canvasFactory(made));
    const main = recCtx();
    const frame = () => { const before = layerTexts(made).length; drawPanelsCached(main.ctx, w, pal, cache, 1); return layerTexts(made).length > before; };
    frame();
    assert.eq(frame(), false, '그대로면 안 그린다');
    const changes = [
      ['스탠스', () => { w.player.stance = w.player.stance === 'fire' ? 'water' : 'fire'; }],
      ['속성 투자', () => { w.player.invest.grass += 1; }],
      ['무기 레벨', () => { w.slots[1].level += 1; }],
      ['진화', () => { w.slots[1].evolved = !w.slots[1].evolved; }],
      ['각인', () => { w.slots[0].stampElement = w.slots[0].stampElement === 'fire' ? 'normal' : 'fire'; }],
      ['패시브 레벨', () => { givePassive(w, 'study'); }],
      ['새 패시브', () => { givePassive(w, 'overclock'); }],
      ['특성', () => { applyTrait(w, 'shield'); }],
      ['쉴드 준비', () => { w.traitState.shieldReady = !w.traitState.shieldReady; }],
      ['새 무기', () => { giveWeapon(w, 'lance'); }],
    ];
    for (const [name, change] of changes) {
      change();
      assert.eq(frame(), true, `${name}이(가) 바뀐 프레임은 다시 그린다`);
      assert.eq(frame(), false, `${name} 다음 프레임은 다시 안 그린다`);
    }
  });

  test('소수 배율(1.25)에서도 같은 자리로 1:1 — 정수 기기 픽셀 · 본 캔버스와 같은 크기 · 같은 변환 · 패널 안쪽만', () => {
    const w = mkW();
    const pal = resolvePalette(w.data.rules);
    const v = w.data.rules.view;
    const made = [];
    const main = recCtx();
    const dpr = 1.25;
    drawPanelsCached(main.ctx, w, pal, makePanelCache(canvasFactory(made)), dpr);
    const [C] = made;
    assert.eq(C.width, Math.round(v.logicalW * dpr), '캐시 폭 = 본 캔버스 백킹스토어 폭');
    assert.eq(C.height, Math.round(v.logicalH * dpr), '캐시 높이 = 본 캔버스 백킹스토어 높이');
    assert.ok(C.rec.transforms.some((t) => t.join() === [dpr, 0, 0, dpr, 0, 0].join()), '캐시 안의 변환 = 본 캔버스와 같은 (dpr, 0, 0, dpr, 0, 0)');
    assert.eq(main.rec.images.length, 2, '좌 · 우 두 사각형');
    const right = v.arena.x + v.arena.w;
    for (const im of main.rec.images) {
      const [sx, sy, sw, sh, dx, dy, dw, dh] = im.a;
      assert.ok([sx, sy, sw, sh].every(Number.isInteger), `원본 사각형이 정수 기기 픽셀 (${im.a.join(',')})`);
      assert.ok(sx === dx && sy === dy && sw === dw && sh === dh, '«같은 자리»로 1:1 — 늘리거나 옮기지 않는다');
      const lx0 = sx / dpr; const lx1 = (sx + sw) / dpr;
      const leftSide = lx0 < v.panelLeftW;
      if (leftSide) {
        assert.ok(lx0 <= 16 && lx1 >= v.panelLeftW - 16, `좌 사각형이 패널 내용 영역을 덮는다 (${lx0.toFixed(1)}~${lx1.toFixed(1)})`);
        assert.ok(lx1 <= v.panelLeftW - 1, '좌 사각형은 경계선(349)을 덮지 않는다');
      } else {
        assert.ok(lx0 >= right + 1, '우 사각형은 경계선(930)을 덮지 않는다');
        assert.ok(lx0 <= right + 16 && lx1 >= v.logicalW - 16, `우 사각형이 패널 내용 영역을 덮는다 (${lx0.toFixed(1)}~${lx1.toFixed(1)})`);
      }
    }
  });

  test('배율이 바뀌면 캐시를 새로 만든다 · 캔버스를 못 만들면 직접 그린다 · 키가 꺼지면 직접 그린다', () => {
    const w = mkW();
    const pal = resolvePalette(w.data.rules);
    const made = [];
    const cache = makePanelCache(canvasFactory(made));
    const main = recCtx();
    drawPanelsCached(main.ctx, w, pal, cache, 1);
    drawPanelsCached(main.ctx, w, pal, cache, 2);
    assert.eq(made.length, 2, '배율 1 → 2 = 캔버스를 새로 한 장');
    const none = recCtx();
    drawPanelsCached(none.ctx, w, pal, makePanelCache(() => null), 2);
    const direct = recCtx();
    drawPanels(direct.ctx, w, pal);
    assert.deepEq(none.rec.texts, direct.rec.texts, '캐시를 못 만들면 drawPanels 와 똑같이 직접 그린다');
    const off = recCtx();
    const d2 = { ...w.data, rules: { ...w.data.rules, hud: { ...w.data.rules.hud, panelCacheDirtyOnly: false } } };
    drawPanelsCached(off.ctx, { ...w, data: d2 }, pal, makePanelCache(canvasFactory([])), 2);
    assert.deepEq(off.rec.texts, direct.rec.texts, 'hud.panelCacheDirtyOnly = false 면 직접 그린다');
  });
});

suite('perf — ㊿-zl 경험치 구슬 일괄 그리기', () => {
  test('구슬이 5개든 120개든 구슬 fill 은 같은 횟수 — 한 경로 · 한 번', () => {
    const countXpFills = (nPickups) => {
      const w = mkW();
      const a = w.data.rules.view.arena;
      for (let i = 0; i < nPickups; i += 1) spawnPickup(w, 'xp', 1 + (i % 7), a.x + 30 + (i * 37) % (a.w - 60), a.y + 80 + (i * 53) % (a.h - 200));
      const pal = resolvePalette(w.data.rules);
      const { ctx, rec } = recCtx();
      drawWorld(ctx, w, pal, makeFx(w), makeInterp(w), 1);
      return { fills: rec.fills.filter((s) => s === pal.pickup.xp).length, live: w.pickups.live };
    };
    const few = countXpFills(5);
    const many = countXpFills(120);
    assert.gt(many.live, 100, `구슬이 실제로 깔렸다 (${many.live})`);
    assert.eq(many.fills, few.fills, `구슬 fill 횟수가 구슬 수와 무관 (5개 ${few.fills} · ${many.live}개 ${many.fills})`);
  });
});

suite('perf — ㊿-zl rgba 색 문자열 캐시', () => {
  test('같은 입력 = 같은 문자열 · 알파는 8비트 칸 · 0 미만/1 초과는 자른다 · NaN 은 숨기지 않는다', () => {
    const a = rgba('#FFC93C', 0.35);
    assert.ok(a === rgba('#FFC93C', 0.35), '두 번째 호출은 캐시의 같은 문자열');
    const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(a);
    assert.ok(m !== null, `형식 rgba(r,g,b,a) — ${a}`);
    assert.deepEq([Number(m[1]), Number(m[2]), Number(m[3])], [255, 201, 60], 'RGB 는 hex 그대로');
    assert.eq(Math.round(Number(m[4]) * 255), Math.round(0.35 * 255), '알파의 8비트 값이 원래 알파와 같다');
    assert.eq(rgba('#FFC93C', 1), 'rgba(255,201,60,1)', '알파 1');
    assert.eq(rgba('#FFC93C', 1.7), 'rgba(255,201,60,1)', '1 초과는 1');
    assert.eq(rgba('#FFC93C', -0.2), 'rgba(255,201,60,0)', '0 미만은 0');
    assert.ok(rgba('#FFC93C', NaN).includes('NaN'), 'NaN 알파는 그대로 새어 나간다 — 잘못된 색을 숨기지 않는다');
  });
});
