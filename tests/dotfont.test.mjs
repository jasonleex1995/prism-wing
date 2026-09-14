/**
 * tests/dotfont.test.mjs — §7.9.1(v1.10 ㊿-z) 도트 폰트.
 *   글자판이 격자를 지키는지는 check.mjs S66 이 센다. 여기서는 **찍히는 것**을 본다 —
 *   칸이 글자판 그대로 나오는가 · 외곽선이 «글자 밖 한 겹»인가 · 기울여도 칸이 격자에 남는가 ·
 *   맞춤(가운데 · 왼쪽) · 없는 글자가 조용히 사라지지 않는가 · 기록장이 없어도 안 터지는가.
 */
import { suite, test, assert, loadData } from '../tools/test.mjs';
import { BODY, LOGO, dotScale, dotWidth, dotText, dotLogo, unknownChars } from '../src/render/dotfont.js';

/** 그려진 사각형을 그대로 받아 적는 가짜 컨텍스트. */
function recorder() {
  const rects = [];
  const ctx = {
    fillStyle: '#000',
    fillRect(x, y, w, h) { rects.push({ x, y, w, h, s: ctx.fillStyle, i: rects.length }); },
  };
  return { ctx, rects };
}
/** 사각형들을 «칸»으로 되돌린다(배율 1 기준). style 을 주면 그 색만. */
function cells(rects, style) {
  const out = new Map();
  for (const r of rects) {
    if (style !== undefined && r.s !== style) continue;
    for (let i = 0; i < r.w; i += 1) out.set(`${r.x + i},${r.y}`, r.i);
  }
  return out;
}
/** 글자판이 말하는 켜진 칸. */
function glyphCells(font, ch, x0, y0) {
  const set = new Set();
  const rows = font.glyphs[ch].split('|');
  for (let ry = 0; ry < font.h; ry += 1) {
    for (let rx = 0; rx < font.w; rx += 1) if (rows[ry][rx] === '#') set.add(`${x0 + rx},${y0 + ry}`);
  }
  return set;
}
const sorted = (it) => [...it].sort().join(' ');

suite('dotfont/도트 폰트 §7.9.1 ㊿-z', () => {
  test('배율은 글자 크기 토큰에서 파생된다 — 새 값을 만들지 않는다', () => {
    const d = loadData();
    const h = d.rules.hud;
    // 한 글자 높이(7칸)가 그 토큰이 되도록 나눈다. 반올림이라 14·16 이 같은 배율에 오는 것은 의도된 것이다.
    assert.eq(dotScale(h.fontSmallPx), 2, `fontSmallPx ${h.fontSmallPx} → ×2`);
    assert.eq(dotScale(h.fontBodyPx), 2, `fontBodyPx ${h.fontBodyPx} → ×2`);
    assert.eq(dotScale(h.fontMediumPx), 3, `fontMediumPx ${h.fontMediumPx} → ×3`);
    assert.eq(dotScale(h.fontLargePx), 4, `fontLargePx ${h.fontLargePx} → ×4`);
    assert.eq(dotScale(h.fontHeroPx), 6, `fontHeroPx ${h.fontHeroPx} → ×6`);
    assert.gte(dotScale(1), 1, '아무리 작은 값이라도 배율은 1 밑으로 안 내려간다');
  });

  test('너비 = 글자 수 × (칸 + 사이) − 사이 한 번, 배율 곱', () => {
    assert.eq(dotWidth('A', 1), BODY.w, '한 글자는 칸 수 그대로');
    assert.eq(dotWidth('AB', 1), BODY.w * 2 + BODY.gap, '두 글자는 사이가 한 번');
    assert.eq(dotWidth('AB', 3), (BODY.w * 2 + BODY.gap) * 3, '배율은 곱하기');
    assert.eq(dotWidth('ABC', 2), dotWidth('abc', 2), '대소문자는 같은 글자다');
    const straight = dotWidth('PRISM WING', 5, LOGO, 0);
    const leaning = dotWidth('PRISM WING', 5, LOGO, 0.42);
    assert.gt(leaning, straight, '기울이면 그만큼 넓어진다 — 자리 계산이 기울기를 안 세면 로고가 가운데서 밀린다');
  });

  test('찍힌 칸 = 글자판 그대로 (배율 1 · 왼쪽 맞춤)', () => {
    const { ctx, rects } = recorder();
    dotText(ctx, 'I', 0, BODY.h / 2, 1, '#fff', { left: 0 });
    assert.eq(sorted(cells(rects).keys()), sorted(glyphCells(BODY, 'I', 0, 0)), '「I」의 칸이 글자판과 한 칸도 다르지 않다');
  });

  test('가운데 맞춤은 폭의 절반만큼 왼쪽에서 시작한다', () => {
    const { ctx, rects } = recorder();
    const w = dotWidth('AB', 2);
    dotText(ctx, 'AB', 100, 50, 2, '#fff');
    const xs = rects.map((r) => r.x);
    assert.eq(Math.min(...xs), Math.round(100 - w / 2), '왼쪽 끝 = 가운데 − 폭/2');
  });

  test('외곽선은 «글자 밖 한 겹»이다 — 글자 칸을 덮지 않고, 글자보다 먼저 그려진다', () => {
    const { ctx, rects } = recorder();
    dotText(ctx, 'I', 0, BODY.h / 2, 1, '#fff', { left: 0, outline: '#000' });
    const fill = cells(rects, '#fff');
    const edge = cells(rects, '#000');
    assert.gt(edge.size, 0, '외곽선이 실제로 그려진다');
    for (const k of edge.keys()) assert.eq(fill.has(k), false, `외곽선이 글자 칸 ${k} 를 덮지 않는다`);
    // 기대하는 외곽선 = 글자 칸의 여덟 이웃 중 글자가 아닌 칸 전부
    const want = new Set();
    for (const k of fill.keys()) {
      const [x, y] = k.split(',').map(Number);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const n = `${x + dx},${y + dy}`;
          if (!fill.has(n)) want.add(n);
        }
      }
    }
    assert.eq(sorted(edge.keys()), sorted(want), '외곽선이 여덟 이웃 한 겹과 정확히 같다');
    assert.lt(Math.max(...edge.values()), Math.min(...fill.values()), '외곽선을 먼저 그린다 — 나중이면 글자를 지운다');
  });

  test('기울여도 칸은 격자에 남는다 — 소수로 밀면 픽셀이 어긋난다', () => {
    const d = loadData();
    const dot = d.rules.visual.dot;
    const s = dot.logoScale;
    const { ctx, rects } = recorder();
    dotLogo(ctx, 'PRISM WING', 640, 200, s, {
      slant: dot.logoSlant, colors: ['#111111', '#222222', '#333333', '#444444'],
      outline: '#000000', topTint: dot.logoTopTint, bottomShade: dot.logoBottomShade,
    });
    assert.gt(rects.length, 0, '로고가 실제로 찍힌다');
    const x0 = Math.min(...rects.map((r) => r.x));
    const y0 = Math.min(...rects.map((r) => r.y));
    for (const r of rects) {
      assert.eq((r.x - x0) % s, 0, `x 가 칸 배수다 (${r.x} − ${x0})`);
      assert.eq((r.y - y0) % s, 0, `y 가 칸 배수다 (${r.y} − ${y0})`);
      assert.eq(r.h, s, '높이는 한 칸');
      assert.eq(r.w % s, 0, '너비는 칸 배수');
    }
  });

  test('로고는 윗줄·아랫줄 색이 다르다 (베벨) · 글자마다 색이 돌아간다 (프리즘)', () => {
    const d = loadData();
    const dot = d.rules.visual.dot;
    const { ctx, rects } = recorder();
    const COLORS = ['#808080', '#FF0000', '#00FF00', '#0000FF'];
    dotLogo(ctx, 'PRISM WING', 500, 200, 2, {
      slant: 0, colors: COLORS, outline: '#000000', topTint: dot.logoTopTint, bottomShade: dot.logoBottomShade,
    });
    const body = rects.filter((r) => r.s !== '#000000');
    const rows = [...new Set(body.map((r) => r.y))].sort((a, b) => a - b);
    const styleOfRow = (y) => new Set(body.filter((r) => r.y === y).map((r) => r.s));
    const top = styleOfRow(rows[0]);
    const mid = styleOfRow(rows[Math.floor(rows.length / 2)]);
    const bottom = styleOfRow(rows[rows.length - 1]);
    for (const c of top) assert.eq(mid.has(c), false, `윗줄 색 ${c} 는 가운뎃줄에 없다 — 베벨이 없으면 평평하다`);
    for (const c of bottom) assert.eq(mid.has(c), false, `아랫줄 색 ${c} 는 가운뎃줄에 없다`);
    assert.gte(mid.size, 2, '가운뎃줄에 두 가지 이상의 색 — 글자마다 속성 색이 돌아간다');
  });

  test('없는 글자는 조용히 사라지지 않는다 — 「?」로 찍히고 unknownChars 가 이름을 댄다', () => {
    assert.deepEq(unknownChars('SELECT MODE'), [], '메뉴에 쓰는 글자는 다 있다');
    assert.deepEq(unknownChars('한글'), ['한', '글'], '없는 글자를 그대로 돌려준다');
    assert.deepEq(unknownChars('가가'), ['가'], '같은 글자는 한 번만');
    assert.deepEq(unknownChars('select'), [], '소문자는 대문자로 보고 판단한다');
    const a = recorder();
    dotText(a.ctx, '한', 0, BODY.h / 2, 1, '#fff', { left: 0 });
    assert.eq(sorted(cells(a.rects).keys()), sorted(glyphCells(BODY, '?', 0, 0)), '없는 글자 자리에 「?」가 찍힌다(빈칸이 아니다)');
  });

  test('기록장은 컨텍스트가 내밀 때만 쓴다 — 없으면 아무 일도 없다', () => {
    const plain = recorder();
    dotText(plain.ctx, 'ABC', 0, 10, 2, '#fff');   // dotTrace 없음 — 터지지 않아야 한다
    assert.gt(plain.rects.length, 0, '기록장이 없어도 그리기는 그대로');
    const traced = recorder();
    traced.ctx.dotTrace = [];
    dotText(traced.ctx, 'ABC', 0, 10, 2, '#fff');
    dotLogo(traced.ctx, 'WING', 0, 40, 2, { slant: 0, colors: ['#fff'], outline: '#000', topTint: 0.5, bottomShade: 0.5 });
    assert.deepEq(traced.ctx.dotTrace, ['ABC', 'WING'], '그린 순서 그대로 남는다');
  });
});
