/**
 * §7.9.1 도트 폰트 (v1.10 ㊿-z) — 메뉴 화면의 글자는 «픽셀을 직접 찍은 글자»로 그린다.
 *
 * 왜 있는가: 정본 §7.9 는 **웹폰트를 금지**한다(오프라인·저용량). 그래서 오락실 표기를 내려고
 *   시스템 글꼴을 작게 그린 뒤 확대하면 획이 서로 붙어 뭉개진다 — 작을수록 심하고, 한글은 못 읽을
 *   정도가 된다(사용자(2026-09-12) 「픽셀 아트가 좀 뭉개지는 느낌이 드는데 · 글자가 작을수록 뭉개지는게 아쉬워」).
 *   폰트 «파일»을 받아오지 않고 글자 모양을 **이 파일이 직접 들고** fillRect 로 찍으면, 몇 배로 키워도
 *   픽셀이 정확하다 — 금지된 것은 «받아오는 폰트»이지 «찍는 글자»가 아니다.
 *   대신 찍어 둔 것은 **영문 대문자·숫자·기호뿐**이라, 도트로 가는 화면의 문구는 영어다
 *   (사용자(2026-09-12) 「종스크롤 비행 슈팅 게임이 한글이라서 그런거면, 전반적으로 다 영어로 바꿔보는건 어때?」).
 *   한글이 «가르치는» 화면(튜토리얼 · 무기/특성/보스 이름 · 스테이지 배너 · 결과 내역)은 그대로 시스템 글꼴이다.
 *
 * 두 벌이다:
 *   BODY 5×7  — 메뉴 본문. 획 1칸. 크기는 **기존 글자 크기 토큰에서 파생**한다(dotScale) — 새 값을 만들지 않는다.
 *   LOGO 8×10 — 제목 전용. 획 2칸 + 검은 외곽선 한 겹 + 베벨(윗줄 밝게 · 아랫줄 어둡게) + 기울임.
 *     가늘고 균일한 5×7 을 제목에 그대로 쓰면 LED 간판처럼 얌전해진다
 *     (사용자(2026-09-12) 「픽셀이 조금 너무 귀여운 느낌 · 1941 이나 약간 mega man 같은 거친 느낌」).
 *
 * 이 파일에 값은 없다 — 배율·기울기·베벨 세기는 전부 rules.visual.dot 이 소유하고 호출자가 넘긴다(§9.3).
 */

/** 5×7 본문 글자. 한 줄이 5칸, 7줄. '#' = 켜진 칸. */
const BODY_GLYPHS = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#',
  B: '####.|#...#|#...#|####.|#...#|#...#|####.',
  C: '.###.|#...#|#....|#....|#....|#...#|.###.',
  D: '####.|#...#|#...#|#...#|#...#|#...#|####.',
  E: '#####|#....|#....|####.|#....|#....|#####',
  F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.###.|#...#|#....|#.###|#...#|#...#|.###.',
  H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  I: '#####|..#..|..#..|..#..|..#..|..#..|#####',
  J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..',
  K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#',
  L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#...#|#...#|#...#|#...#',
  N: '#...#|##..#|#.#.#|#..##|#...#|#...#|#...#',
  O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
  P: '####.|#...#|#...#|####.|#....|#....|#....',
  Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#',
  R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.',
  T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
  V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
  W: '#...#|#...#|#...#|#...#|#.#.#|##.##|#...#',
  X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..',
  Z: '#####|....#|...#.|..#..|.#...|#....|#####',
  0: '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.',
  1: '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
  2: '.###.|#...#|....#|...#.|..#..|.#...|#####',
  3: '####.|....#|....#|.###.|....#|....#|####.',
  4: '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.',
  5: '#####|#....|####.|....#|....#|#...#|.###.',
  6: '..##.|.#...|#....|####.|#...#|#...#|.###.',
  7: '#####|....#|...#.|..#..|.#...|.#...|.#...',
  8: '.###.|#...#|#...#|.###.|#...#|#...#|.###.',
  9: '.###.|#...#|#...#|.####|....#|...#.|.##..',
  '.': '.....|.....|.....|.....|.....|..##.|..##.',
  ',': '.....|.....|.....|.....|..##.|..##.|.#...',
  ':': '.....|..##.|..##.|.....|..##.|..##.|.....',
  '-': '.....|.....|.....|#####|.....|.....|.....',
  '+': '.....|..#..|..#..|#####|..#..|..#..|.....',
  '/': '....#|....#|...#.|..#..|.#...|#....|#....',
  '(': '..##.|.#...|.#...|.#...|.#...|.#...|..##.',
  ')': '.##..|...#.|...#.|...#.|...#.|...#.|.##..',
  '[': '.###.|.#...|.#...|.#...|.#...|.#...|.###.',
  ']': '.###.|...#.|...#.|...#.|...#.|...#.|.###.',
  '%': '##..#|##..#|...#.|..#..|.#...|#..##|#..##',
  '!': '..#..|..#..|..#..|..#..|..#..|.....|..#..',
  '?': '.###.|#...#|....#|...#.|..#..|.....|..#..',
  "'": '..#..|..#..|.....|.....|.....|.....|.....',
  '×': '.....|#...#|.#.#.|..#..|.#.#.|#...#|.....',
  '·': '.....|.....|.....|..#..|.....|.....|.....',
  ' ': '.....|.....|.....|.....|.....|.....|.....',
};

/** 8×10 제목 전용 글자. 획이 2칸이다. 제목에 쓰는 글자만 있다 — P R I S M W N G + 빈칸. */
const LOGO_GLYPHS = {
  P: '#######.|########|##....##|##....##|########|#######.|##......|##......|##......|##......',
  R: '#######.|########|##....##|##....##|########|#######.|##..##..|##...##.|##....##|##....##',
  I: '########|########|...##...|...##...|...##...|...##...|...##...|...##...|########|########',
  S: '.#######|########|##......|##......|#######.|.#######|......##|......##|########|#######.',
  M: '##....##|###..###|########|########|##.##.##|##.##.##|##....##|##....##|##....##|##....##',
  W: '##....##|##....##|##....##|##....##|##.##.##|##.##.##|########|########|###..###|##....##',
  N: '##....##|###...##|####..##|#####.##|##.#####|##..####|##...###|##....##|##....##|##....##',
  G: '.#######|########|##......|##......|##..####|##..####|##....##|##....##|########|.#######',
  '?': '.######.|########|##....##|......##|....####|...###..|...##...|........|...##...|...##...',
  ' ': '........|........|........|........|........|........|........|........|........|........',
};

export const BODY = { w: 5, h: 7, gap: 1, glyphs: BODY_GLYPHS };
export const LOGO = { w: 8, h: 10, gap: 1, glyphs: LOGO_GLYPHS };

/**
 * 글자 크기 토큰(px) → 도트 배율. 새 값을 만들지 않으려고 **기존 rules.hud.font*Px 에서 파생**한다:
 * 한 글자의 높이가 곧 그 토큰이 되도록 h 로 나눈다. 16px → ×2 · 20px → ×3 · 26px → ×4 · 40px → ×6.
 */
export function dotScale(fontPx, font) {
  const f = font || BODY;
  return Math.max(1, Math.round(fontPx / f.h));
}

/**
 * 글자열을 칸 격자로 펼친다. 기울임은 **줄마다 정수 칸**만큼 민다 — 소수로 밀면 칸이 격자를 벗어나
 * 외곽선을 정확히 셀 수 없다(외곽선 = 「빈칸인데 이웃이 켜져 있다」로 구한다).
 * cell[ry][rx] = 그 칸을 켠 글자의 번호, 빈칸은 -1.
 */
/**
 * 그 글자의 줄들. 없으면 «?» 로, «?» 도 없으면 빈 글자로 떨어진다 —
 * 제목은 매 프레임 그려지므로 여기서 예외가 나면 화면이 통째로 검어진다(§6.5 가 기록한 그 사고).
 */
function glyphRows(font, ch) {
  const src = font.glyphs[ch] !== undefined ? font.glyphs[ch]
    : (font.glyphs['?'] !== undefined ? font.glyphs['?'] : font.glyphs[' ']);
  if (typeof src !== 'string') return new Array(font.h).fill('.'.repeat(font.w));
  const rows = src.split('|');
  return rows.length === font.h ? rows : new Array(font.h).fill('.'.repeat(font.w));
}

function layout(font, text, slant) {
  const chars = Array.from(String(text).toUpperCase());
  const lean = slant || 0;
  const shiftOf = ry => Math.round((font.h - 1 - ry) * lean);
  let maxShift = 0;
  for (let ry = 0; ry < font.h; ry += 1) {
    const s = shiftOf(ry);
    if (s > maxShift) maxShift = s;
  }
  const span = chars.length === 0 ? 0 : chars.length * (font.w + font.gap) - font.gap;
  const cols = Math.max(1, span + maxShift);
  const cell = [];
  for (let ry = 0; ry < font.h; ry += 1) cell.push(new Array(cols).fill(-1));
  for (let i = 0; i < chars.length; i += 1) {
    const rows = glyphRows(font, chars[i]);
    const x0 = i * (font.w + font.gap);
    for (let ry = 0; ry < font.h; ry += 1) {
      const line = rows[ry];
      const sx = x0 + shiftOf(ry);
      for (let rx = 0; rx < font.w; rx += 1) if (line[rx] === '#') cell[ry][sx + rx] = i;
    }
  }
  return { cell, cols, rows: font.h };
}

function litAt(lay, rx, ry) {
  if (ry < 0 || ry >= lay.rows || rx < 0 || rx >= lay.cols) return -1;
  return lay.cell[ry][rx];
}

/** 외곽선 칸 = 스스로는 비었는데 여덟 이웃 중 하나라도 켜진 칸. 글자 밖으로 한 칸 나간다. */
function isEdge(lay, rx, ry) {
  if (litAt(lay, rx, ry) >= 0) return false;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      if (litAt(lay, rx + dx, ry + dy) >= 0) return true;
    }
  }
  return false;
}

/** 한 줄을 훑으며 «같은 값이 이어지는 구간»을 한 번의 fillRect 로 찍는다. */
function paintRow(ctx, x0, y, px, from, to, valueAt, styleOf) {
  let run = 0;
  let runVal = null;
  for (let rx = from; rx <= to; rx += 1) {
    const v = rx === to ? null : valueAt(rx);
    if (v !== null && v === runVal) { run += 1; continue; }
    if (run > 0) {
      ctx.fillStyle = styleOf(runVal);
      ctx.fillRect(Math.round(x0 + (rx - run) * px), Math.round(y), Math.ceil(run * px), Math.ceil(px));
    }
    run = v === null ? 0 : 1;
    runVal = v;
  }
}

function paint(ctx, lay, x0, y0, px, styleOf, outline) {
  if (outline !== null && outline !== undefined) {
    for (let ry = -1; ry <= lay.rows; ry += 1) {
      paintRow(ctx, x0, y0 + ry * px, px, -1, lay.cols + 1,
        rx => (isEdge(lay, rx, ry) ? 1 : null), () => outline);
    }
  }
  for (let ry = 0; ry < lay.rows; ry += 1) {
    paintRow(ctx, x0, y0 + ry * px, px, 0, lay.cols + 1,
      rx => { const v = litAt(lay, rx, ry); return v < 0 ? null : v; }, i => styleOf(i, ry));
  }
}

function channels(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** 어둡게 — 베벨의 아랫줄. */
function shade(hex, f) {
  const c = channels(hex);
  return `rgb(${Math.round(c[0] * f)},${Math.round(c[1] * f)},${Math.round(c[2] * f)})`;
}
/** 밝게(흰쪽으로) — 베벨의 윗줄. */
function tint(hex, f) {
  const c = channels(hex);
  const up = v => Math.round(v + (255 - v) * f);
  return `rgb(${up(c[0])},${up(c[1])},${up(c[2])})`;
}

/**
 * 그린 문자열을 «컨텍스트가 내밀어 준 기록장»에 남긴다. 실제 브라우저의 2D 컨텍스트에는 이 배열이 없으므로
 * 프로덕션에서는 아무 일도 일어나지 않는다(비용 0). 도트 글자는 fillRect 로 찍히기 때문에
 * 화면을 «글자»로 판독해야 하는 쪽(어트랙트 드라이버)이 들여다볼 창이 이것 하나다 — §7.9.1.
 */
function trace(ctx, text) {
  if (Array.isArray(ctx.dotTrace)) ctx.dotTrace.push(String(text));
}

/** 배율 s 로 찍었을 때 이 글자열이 차지하는 논리 픽셀 너비. 자리 계산용. */
export function dotWidth(text, scale, font, slant) {
  return layout(font || BODY, text, slant || 0).cols * scale;
}

/**
 * 본문 글자. cy 는 **세로 가운데**다(mText 와 같다).
 * opts.left 를 주면 그 x 에서 왼쪽 맞춤으로 찍고, 없으면 cx 기준 가운데 맞춤이다.
 * opts.outline 을 주면 한 칸 두께 외곽선을 두른다 — 플레이 화면 위에 얹는 글자(어트랙트)에 쓴다.
 */
export function dotText(ctx, text, cx, cy, scale, color, opts) {
  const o = opts === undefined ? {} : opts;
  trace(ctx, text);
  const lay = layout(BODY, text, 0);
  const w = lay.cols * scale;
  const x0 = o.left === undefined ? Math.round(cx - w / 2) : Math.round(o.left);
  const y0 = Math.round(cy - BODY.h * scale / 2);
  paint(ctx, lay, x0, y0, scale, () => color, o.outline === undefined ? null : o.outline);
  return w;
}

/**
 * 제목. 글자마다 다른 색(4속성 색이 돌아간다 — 「프리즘 = 4속성의 색」)을 쓰고,
 * 윗줄은 밝게 · 아랫줄 둘은 어둡게 찍어 입체를 만든다. 외곽선은 전체를 한 겹 두른다.
 */
export function dotLogo(ctx, text, cx, cy, scale, opts) {
  trace(ctx, text);
  const lay = layout(LOGO, text, opts.slant);
  const w = lay.cols * scale;
  const x0 = Math.round(cx - w / 2);
  const y0 = Math.round(cy - LOGO.h * scale / 2);
  const styleOf = (i, ry) => {
    const base = opts.colors[i % opts.colors.length];
    if (ry === 0) return tint(base, opts.topTint);
    if (ry >= LOGO.h - 2) return shade(base, opts.bottomShade);
    return base;
  };
  paint(ctx, lay, x0, y0, scale, styleOf, opts.outline);
  return w;
}

/** 이 글자열에서 찍을 수 없는 글자들. 게이트·테스트가 「?」로 조용히 새는 것을 막는 데 쓴다. */
export function unknownChars(text, font) {
  const f = font || BODY;
  const out = [];
  const chars = Array.from(String(text).toUpperCase());
  for (let i = 0; i < chars.length; i += 1) {
    if (f.glyphs[chars[i]] === undefined && out.indexOf(chars[i]) < 0) out.push(chars[i]);
  }
  return out;
}
