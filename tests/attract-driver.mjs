/**
 * tests/attract-driver.mjs — §6.5(v1.10 ㊿-s) 어트랙트 «드라이버» 검사기. 러너가 직접 부르지 않는 도우미다(*.test.mjs 가 아니다).
 *   tests/attract-driver.test.mjs 가 **자식 프로세스**로 돌린다 — 브라우저 흉내 전역(window · document · rAF · performance · fetch · 캔버스)을
 *   깔고 src/main.js 를 실제로 부팅한 뒤, 시계를 손으로 돌리며 **화면에 그려진 것만** 본다(글자 · 카드 테두리 굵기 — 블랙박스, main.js 에 검사용 구멍을 내지 않는다).
 *   왜: main.js 는 브라우저 전용이라 core 테스트가 닿지 않고, 소스 조각 검사(S63)는 «endAttract 가 attract 를 안 끈다»·«끝 깃발이 안 지워진다»
 *   같은 흐름 결함은 못 보면서 따옴표·줄바꿈만 바뀌어도 깨졌다(검토).
 * usage: node tests/attract-driver.mjs <flow | small | demo | death>   ·   env PRISM_META_PATCH = data/meta.json 위에 덮어쓸 JSON
 * 출력: 마지막 줄 = 측정값 JSON 한 줄(판정은 테스트 파일이 한다)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCEN = process.argv[2] || 'flow';
const readJson = (rel) => JSON.parse(readFileSync(ROOT + rel, 'utf8'));
const rules = readJson('data/rules.json');
const meta = readJson('data/meta.json');
const merge = (dst, src) => {
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && dst[k] !== null && typeof dst[k] === 'object') merge(dst[k], v);
    else dst[k] = v;
  }
  return dst;
};
if (process.env.PRISM_META_PATCH) merge(meta, JSON.parse(process.env.PRISM_META_PATCH));

// ── 가짜 브라우저 ────────────────────────────────────────────────────────────
const winListeners = {};
const docListeners = {};
let clock = 1000;
let raf = null;
const texts = [];
// ㊿-z 도트 글자는 fillRect 로 찍히므로 화면을 «글자»로 읽을 창이 ctx.dotTrace 하나다(§7.9.1).
//   Array 를 상속해야 dotfont 의 Array.isArray 검사를 통과한다. push 를 가로채 두 곳에 나눠 담는다:
//   texts(프레임 안의 그린 순서 — 겹침 판정용) · allDot(판 전체에서 한 번이라도 그린 문자열 전수).
const allDot = new Set();
class DotSink extends Array {
  push(...a) { for (const x of a) { allDot.add(String(x)); texts.push(String(x)); } return 0; }
}
const dotSink = new DotSink();
let strokes = [];
let errors = 0;
const errorSamples = [];
console.error = (...a) => {
  errors += 1;
  if (errorSamples.length < 3) errorSamples.push(a.map((x) => (x && x.stack) || String(x)).join(' ').slice(0, 400));
};
Date.now = () => 1700000000000;   // 시드 = Date.now() ^ performance.now() — 둘 다 고정해 판을 재현한다
const state2d = { globalAlpha: 1, globalCompositeOperation: 'source-over', lineWidth: 1, font: '10px sans-serif',
  fillStyle: '#000', strokeStyle: '#000', textAlign: 'left', textBaseline: 'alphabetic' };
const canvas = { width: 0, height: 0, style: {}, hidden: false };
const ctx = new Proxy({
  canvas,
  measureText: (t) => ({ width: String(t).length * 8 }),
  fillText: (t) => { texts.push(String(t)); },
  dotTrace: dotSink,      // ㊿-z 도트 글자가 남기는 기록장 — texts 로 흘려보내 «그린 순서»를 보존하고, 따로 전수도 모은다
  strokeRect: (x, y, w, h) => { strokes.push({ w, h, lw: state2d.lineWidth }); },
  createLinearGradient: () => ({ addColorStop() {} }),
  createRadialGradient: () => ({ addColorStop() {} }),
  getLineDash: () => [],
}, {
  get(t, k) { if (k in t) return t[k]; if (k in state2d) return state2d[k]; return () => {}; },
  set(t, k, v) { state2d[k] = v; return true; },
});
canvas.getContext = () => ctx;
const fatalEl = { textContent: '', hidden: true };
Object.defineProperty(globalThis, 'performance', { value: { now: () => clock }, configurable: true, writable: true });
globalThis.requestAnimationFrame = (fn) => { raf = fn; };
globalThis.window = globalThis;
globalThis.innerWidth = 1280;
globalThis.innerHeight = 720;
globalThis.devicePixelRatio = 1;
globalThis.addEventListener = (type, fn) => { (winListeners[type] ||= []).push(fn); };
globalThis.document = {
  title: 'PRISM WING',
  hidden: false,
  getElementById: (id) => (id === 'game' ? canvas : fatalEl),
  addEventListener: (type, fn) => { (docListeners[type] ||= []).push(fn); },
};
Object.defineProperty(globalThis, 'location', { value: { search: SCEN === 'demo' ? '?demo' : '' }, configurable: true, writable: true });
globalThis.fetch = async (url) => {
  const p = fileURLToPath(url);
  const body = p.endsWith('/data/meta.json') ? meta : JSON.parse(readFileSync(p, 'utf8'));
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
};

// ── 시계 · 입력 · 화면 판독 ──────────────────────────────────────────────────────
// 너무 긴 프레임은 PLAY 가 남은 시간을 버린다(나선형 죽음 방지) — 배속 1 에서 안 버리는 가장 긴 프레임. 더 빠른 난이도에선 게임 시간이 조금 덜 흐른다(판정엔 영향 없음)
const FAST = Math.min(rules.loop.maxFrameGapMs, rules.loop.maxStepsPerFrame * (1000 / 60)) - 0.001;
const B = rules.input.bindings;
const BOUND = new Set(Object.values(B).flat());
const UNBOUND_DIGIT = ['Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'].find((c) => !BOUND.has(c));
function frame(dt = FAST) { clock += dt; texts.length = 0; strokes.length = 0; raf(clock); }   // ㊿-z 배열을 갈아끼우지 않는다(ctx.dotTrace 가 이 배열을 쥐고 있다)
const has = (s) => texts.some((t) => t.includes(s));
const TAG = 'AUTO PLAY';                       // ㊿-x 어트랙트 표시(항상) — 아래 줄 PRESS ANY KEY 는 깜빡인다
const BLINK = 'PRESS ANY KEY';
const isTitle = () => has('PRISM WING') && has('[SPACE/ENTER] START');      // ㊿-z 메뉴 문구는 영어다(§7.9.1) · Enter 도 확정 키다
const isDemo = () => has(TAG);
const isAutoDraft = () => has('LEVEL UP') && has('데모 — 봇이 고르는 중');
const isHumanDraft = () => has('LEVEL UP') && has('1 / 2 / 3 선택');
const isPause = () => has('일시정지');
const isDifficulty = () => has('TUTORIAL');
const isSmall = () => has('창이 너무 작습니다');
const cursorBorders = () => strokes.filter((s) => s.h > 300 && s.lw === 3).length;   // 드래프트 카드 테두리 중 «고른» 굵기
function fire(map, type, extra = {}) {
  const e = { type, code: '', key: '', repeat: false, isTrusted: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault() {}, ...extra };
  for (const fn of map[type] || []) fn(e);
}
const keyDown = (code, extra) => fire(winListeners, 'keydown', { code, key: code, ...extra });
const keyUp = (code, extra) => fire(winListeners, 'keyup', { code, key: code, ...extra });
function press(code) { keyDown(code); frame(16); keyUp(code); frame(16); }
/** 조건이 설 때까지 프레임을 돌린다 → 걸린 ms, 못 서면 -1 */
function until(pred, maxMs, dt = FAST) {
  const t0 = clock;
  while (clock - t0 < maxMs) { frame(dt); if (pred()) return clock - t0; }
  return -1;
}

async function main() {
  await import(pathToFileURL(ROOT + 'src/main.js').href);
  for (let i = 0; i < 2000 && raf === null && fatalEl.hidden; i += 1) await new Promise((r) => setTimeout(r, 2));
  if (raf === null) return { fatal: fatalEl.textContent || 'rAF 가 걸리지 않았다' };
  const out = { fastMs: FAST };

  if (SCEN === 'flow') {
    frame(16);
    out.bootTitle = isTitle();
    const baseTitle = globalThis.document.title;
    // ① 무입력 attractIdleSec → 데모 (부팅 = 시계 0) · 탭 제목에 시드가 안 붙는다
    const t1 = until(isDemo, 60000);
    out.demoStartMs = t1 < 0 ? -1 : clock - 1000;
    out.demoTabTitleClean = globalThis.document.title === baseTitle;
    //   ㊿-z4 — 플레이 중 한 프레임의 글자 전부. 좌 패널이 «설명»을 다시 달지 않는지 본다(§5.6).
    for (let q = 0; q < 30; q += 1) frame(16);
    out.playTexts = texts.slice();
    // ② 데모 드래프트 — 사람 안내가 안 뜨고 · 커서가 한 장에 있고 · 데모 표시가 오버레이 위에 · 체류 = draftDwellSec ÷ 배속
    //    (대기 중인 레벨업이 없는 마지막 드래프트를 8ms 프레임으로 잰다)
    let humanDraftInDemo = false;
    const t2 = until(() => { if (isHumanDraft()) humanDraftInDemo = true; return (isAutoDraft() && !has('대기 중인 레벨업')) || !isDemo(); }, 90000);
    out.dwellMs = -1;
    out.tagOverDraft = false;
    out.cursorShown = false;
    if (t2 >= 0 && isAutoDraft()) {
      out.tagOverDraft = texts.lastIndexOf(TAG) > texts.indexOf('LEVEL UP');
      out.cursorShown = cursorBorders() === 1;
      const t0 = clock;
      out.blinkOn = 0; out.blinkOff = 0;        // ㊿-x 드래프트(월드 시계 정지) 중에도 실시간으로 깜빡이는가
      while (isAutoDraft() && clock - t0 < 5000) { frame(8); if (has(BLINK)) out.blinkOn += 1; else out.blinkOff += 1; }
      out.dwellMs = clock - t0;
    }
    out.humanDraftInDemo = humanDraftInDemo;
    // ③ 사람이 «누르지 않은» 입력은 데모를 못 끝낸다 — 수정 키 단독 · 게임이 안 쓰는 키와의 조합(Cmd+Shift+4) · blur · focus · 탭 숨김/복귀
    until(() => isDemo() && !has('LEVEL UP'), 30000);
    keyDown('MetaLeft', { key: 'Meta', metaKey: true }); frame(16);
    keyDown('ShiftLeft', { key: 'Shift', metaKey: true, shiftKey: true }); frame(16);
    keyDown(UNBOUND_DIGIT, { key: '$', metaKey: true, shiftKey: true }); frame(16);
    keyUp(UNBOUND_DIGIT, { key: '$' }); keyUp('ShiftLeft', { key: 'Shift' }); keyUp('MetaLeft', { key: 'Meta' }); frame(16);
    out.modifierKeepsDemo = isDemo() && !isPause();
    fire(winListeners, 'blur'); frame(16); frame(16);
    out.blurKeepsDemo = isDemo() && !isPause();
    fire(winListeners, 'focus');
    globalThis.document.hidden = true; fire(docListeners, 'visibilitychange');
    globalThis.document.hidden = false; fire(docListeners, 'visibilitychange');
    frame(16); frame(16);
    out.returnKeepsDemo = isDemo();
    // ④ 아무 키 = 다음 프레임에 타이틀
    keyDown('KeyA'); frame(16);
    out.keyExitsToTitle = isTitle() && !isDemo();
    const exitAt = clock;
    keyUp('KeyA'); frame(16);
    // ⑤ 다음 데모는 다시 attractIdleSec 뒤 — 스스로 금방 끝나지 않는다 · 클릭으로도 끝난다
    const t5 = until(isDemo, 60000);
    out.nextDemoAfterMs = t5 < 0 ? -1 : clock - exitAt;
    out.demoSurvives3s = until(() => !isDemo(), 3000, 16) < 0;
    fire(winListeners, 'pointerdown'); frame(16);
    out.clickExitsToTitle = isTitle() && !isDemo();
    // ⑥ 게임 키가 섞인 조합은 입력 — Ctrl 단독은 아니지만 Ctrl+Esc 는 타이틀(일시정지가 아니다)
    until(isDemo, 60000);
    until(() => isDemo() && !has('LEVEL UP'), 30000);
    keyDown('ControlLeft', { key: 'Control', ctrlKey: true }); frame(16);
    out.ctrlAloneKeepsDemo = isDemo();
    keyDown(B.pause, { key: 'Escape', ctrlKey: true }); frame(16); frame(16);
    out.ctrlEscExitsToTitle = isTitle() && !isDemo() && !isPause();
    keyUp(B.pause, { key: 'Escape' }); keyUp('ControlLeft', { key: 'Control' }); frame(16);
    // ⑥' 게임 키는 «물리 키(e.code)»로 가른다 — Ctrl+Space 는 key ' ' · code Space 라 key 로 가르면 놓친다(검토: 배너만 건너뛰고 데모가 남았다)
    until(isDemo, 60000);
    keyDown(B.grab, { key: ' ', ctrlKey: true }); frame(16); frame(16);
    out.ctrlSpaceExitsToTitle = isTitle() && !isDemo() && !isDifficulty();
    keyUp(B.grab, { key: ' ' }); frame(16);
    // ⑦ 누른 채 끝낸 Space 는 타이틀에서 «시작»으로 새지 않는다 · 새로 누르면 난이도 화면 · 거기선 25초 무입력에도 데모가 안 뜬다 · Esc 로 돌아온다
    until(isDemo, 60000);
    keyDown(B.grab); frame(16); frame(16); frame(16);
    out.heldSpaceStaysTitle = isTitle();
    keyUp(B.grab); frame(16);
    press(B.grab);
    out.freshSpaceOpensDifficulty = isDifficulty();
    out.difficultyLines = texts.filter((t) => t.includes('SPEED'));   // ㊿-u 난이도 메뉴 줄(속도 · 적 공격 · 점수) · ㊿-z 영어
    out.difficultyTexts = texts.slice();                             // ㊿-u 난이도 화면의 글자 전부(체력 배율이 어디에도 없어야 한다)
    out.difficultyIdleNoDemo = until(() => isDemo() || !isDifficulty(), 25000, 100) < 0 && isDifficulty();
    press(B.pause);
    out.escBackToTitle = isTitle();
    // ㊿-z 옵션 화면도 도트·영어다 — 여기서 한 번 들렀다 나와야 그 화면의 글자들이 dotStrings 전수에 들어온다
    press('KeyO'); frame(16);
    out.optionsShown = has('OPTIONS');
    press(B.pause); frame(16);
    out.optionsEscBackToTitle = isTitle();
    // ⑧ 데모가 스스로 끝나면(사망 · 잡몹 페이즈 끝) 결과 화면 없이 타이틀 — 입력 없이 끝났어도 다음 데모는 다시 attractIdleSec 뒤
    until(isDemo, 60000);
    const t8 = until(() => !isDemo(), 400000);
    out.naturalEndMs = t8;
    out.naturalEndTitle = t8 >= 0 && isTitle();
    const endAt = clock;
    const t8b = until(isDemo, 60000);
    out.afterEndNextDemoMs = t8b < 0 ? -1 : clock - endAt;
    keyDown('KeyA'); frame(16); keyUp('KeyA'); frame(16);
    // ⑨ 사람 판 — 드래프트는 입력을 기다린다 · 일시정지는 25초 무입력에도 데모로 안 바뀐다
    press(B.grab);
    press(B.grab);
    const t9 = until(() => isHumanDraft() || isAutoDraft(), 120000);
    out.humanDraftSeen = t9 >= 0 && isHumanDraft();
    out.humanDraftWaits = out.humanDraftSeen && until(() => !isHumanDraft(), 3000, 50) < 0;
    // 드래프트는 고르고(드래프트 중 Esc 는 무시된다), 일시정지가 뜰 때까지 Esc — 판마다 드래프트가 열리는 순간이 달라도 흔들리지 않게(검토)
    for (let i = 0; i < 60 && !isPause(); i += 1) { if (has('LEVEL UP')) press(B.draftPick[0]); else press(B.pause); }
    out.pauseShown = isPause();
    out.pauseHolds25s = out.pauseShown && until(() => isDemo() || !isPause(), 25000, 100) < 0 && isPause();
  } else if (SCEN === 'small') {
    frame(16);
    until(isDemo, 60000);
    until(() => isDemo() && !has('LEVEL UP'), 30000);
    out.demoRunning = isDemo();
    globalThis.innerWidth = rules.view.minViewportW - 100; frame(16);
    out.smallShown = isSmall();
    globalThis.innerWidth = 1280; frame(16);
    out.restoredTitle = isTitle() && !isDemo();
    until(() => false, 3000, 50);
    out.stillTitle3s = isTitle() && !isPause() && !has('LEVEL UP');
  } else if (SCEN === 'demo') {
    let tag = false; let human = false;
    const watch = () => { if (isDemo()) tag = true; if (isHumanDraft()) human = true; };
    const t = until(() => { watch(); return isAutoDraft() && !has('대기 중인 레벨업'); }, 60000);
    out.tabTitle = globalThis.document.title;
    out.autoDraftDwellMs = -1;
    if (t >= 0) { const t0 = clock; while (isAutoDraft() && clock - t0 < 5000) frame(8); out.autoDraftDwellMs = clock - t0; }
    until(() => { watch(); return false; }, 20000);
    out.tagSeen = tag; out.humanDraftSeen = human;
  } else if (SCEN === 'death') {
    frame(16);
    until(isDemo, 60000);
    const t = until(() => !isDemo(), 400000);
    out.endMs = t;
    out.endTitle = t >= 0 && isTitle();
    const endAt = clock;
    const t2 = until(isDemo, 60000);
    out.afterEndNextDemoMs = t2 < 0 ? -1 : clock - endAt;
  } else {
    return { fatal: `미지의 시나리오 ${SCEN}` };
  }
  out.dotStrings = [...allDot];   // ㊿-z 이 판에서 도트로 찍은 문자열 전수 — 「?」로 새는 글자가 없어야 한다(§7.9.1)
  out.errors = errors;
  out.errorSamples = errorSamples;
  return out;
}

main().then(
  (out) => process.stdout.write(`${JSON.stringify(out)}\n`, () => process.exit(0)),
  (err) => process.stdout.write(`${JSON.stringify({ fatal: String((err && err.stack) || err).slice(0, 600) })}\n`, () => process.exit(1)),
);
