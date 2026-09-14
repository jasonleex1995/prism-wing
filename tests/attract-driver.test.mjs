/**
 * tests/attract-driver.test.mjs — §6.5(v1.10 ㊿-s) 어트랙트 «드라이버»(src/main.js)를 실제로 부팅해서 본다.
 *   core 판정(stage.attractOver)은 tests/attract.test.mjs, 설정값 · 키 읽힘 · 화면으로 안 보이는 배선 넷은 check.mjs S63 이 본다.
 *   이 파일은 그 사이 — 시작 · 끝(키 · 클릭 · 게임 키 조합) · 끝 깃발 · 무입력 시계 · blur · 수정 키 · 창 크기 · 일시정지 · 난이도 화면 ·
 *   사람 드래프트 · ?demo — 를 **화면에 그려진 것**으로 본다. 가짜 전역을 깔아야 하므로 tests/attract-driver.mjs 를 **자식 프로세스**로 돌린다.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { suite, test, assert, loadData } from '../tools/test.mjs';
import { unknownChars } from '../src/render/dotfont.js';   // ㊿-z 화면에 찍힌 글자가 「?」로 새지 않는지

const DRIVER = fileURLToPath(new URL('./attract-driver.mjs', import.meta.url));

function drive(scenario, patch) {
  const env = { ...process.env };
  if (patch) env.PRISM_META_PATCH = JSON.stringify(patch);
  else delete env.PRISM_META_PATCH;
  const r = spawnSync(process.execPath, [DRIVER, scenario], { encoding: 'utf8', env, timeout: 60000, maxBuffer: 1 << 24 });
  const line = (r.stdout || '').trim().split('\n').pop() || '';
  let out = null;
  try { out = JSON.parse(line); } catch { out = null; }
  assert.ok(out !== null && r.status === 0 && out.fatal === undefined,
    `드라이버(${scenario})가 끝까지 돌았다 — exit ${r.status} · ${line.slice(0, 300)} ${(r.stderr || '').slice(0, 300)}`);
  assert.eq(out.errors, 0, `드라이버(${scenario}) 프레임 오류 0 — ${JSON.stringify(out.errorSamples)}`);
  return out;
}

suite('attract/드라이버(main.js 부팅) §6.5 ㊿-s', () => {
  test('시작 · 드래프트 · 끝 — 20초 무입력 → 데모 · 체류 = draftDwellSec ÷ 배속 · 사람이 안 누른 입력은 못 끝낸다 · 키 · 클릭 · Ctrl+Esc = 타이틀 · 다음 데모는 다시 20초 뒤 · 스스로 끝나면 결과 화면 없이 타이틀 · 난이도 화면 · 일시정지는 데모로 안 바뀐다', () => {
    const d = loadData();
    // 체류를 알아볼 수 있게 설정을 바꿔 돌린다: 하드(배속 1.1) · 0.5 게임초 → 실시간 454.5ms. 노멀(500) · 헬(400) · 1200 고정 · ÷배속 누락(500)과 모두 다르다
    // ㊿-u 검토: 적 공격 배율과 점수 배율이 세 난이도 모두 같아서(1 · 1.2 · 1.5) «점수 배율을 적 공격이라 쓴» 메뉴가 초록이었다 —
    //   점수 배율만 달리 덮어써 둘을 구별한다(점수 배율은 이 판의 흐름에 영향이 없다).
    const DIFF_PATCH = { hard: { scoreMul: 1.3 }, hell: { scoreMul: 1.7 } };
    const o = drive('flow', { flow: { attract: { difficulty: 'hard', draftDwellSec: 1.2 } }, difficulty: DIFF_PATCH });
    const idleMs = d.meta.flow.attractIdleSec * 1000;
    const wantDwell = (1.2 * 1000) / d.meta.difficulty.hard.speed;   // ㊿-x: 깜빡임 주기(1초)보다 긴 창이라 위상과 무관하게 양쪽이 잡힌다
    const aboutIdle = (v) => v >= idleMs - 50 && v <= idleMs + o.fastMs + 50;
    assert.ok(o.bootTitle, '부팅 = 타이틀');
    assert.ok(o.demoStartMs >= idleMs && o.demoStartMs <= idleMs + o.fastMs + 20, `무입력 ${idleMs}ms 에 데모가 뜬다 — 그 전엔 안 뜬다 (${o.demoStartMs.toFixed(0)}ms)`);
    assert.ok(o.demoTabTitleClean, '데모 중 탭 제목에 시드가 안 붙는다 — 사람의 판이 아니다');
    assert.lte(Math.abs(o.dwellMs - wantDwell), 12, `데모 드래프트 체류 = draftDwellSec ÷ attract.difficulty 배속 (${o.dwellMs}ms · 기대 ${wantDwell.toFixed(1)}ms)`);
    assert.ok(o.cursorShown, '데모 드래프트에 커서(3px 테두리)가 딱 한 장에 있다');
    assert.ok(o.tagOverDraft, '데모 표시가 드래프트 오버레이 «위»에 그려진다');
    // ㊿-z4 사용자 「부수적인 설명들을 모두 제거해줘」 — 좌 패널은 «지금 상태»만 말한다(§5.6).
    //   표와 보스 특성 칸은 남아야 하므로, 사라진 것과 남은 것을 같이 못 박는다(둘 다 없으면 패널이 통째로 빈 것이다).
    assert.ok(o.playTexts.length > 0, '전제: 플레이 중 한 프레임의 글자를 받았다');
    assert.ok(o.playTexts.includes('상성표') && o.playTexts.includes('보스 특성'), '좌 패널의 표와 보스 특성 칸은 남는다');
    for (const gone of ['세로 = 내 스탠스 / 가로 = 적', '적 속성 키의 오른쪽 이웃이 정답 키',
      'W(불) → E · E(물) → R · R(풀) → W', '보스를 잡으면 금색 구슬이 나온다']) {
      assert.eq(o.playTexts.includes(gone), false, `좌 패널이 「${gone}」를 설명하지 않는다`);
    }
    // ㊿-x 「PRESS ANY KEY」는 실시간으로 깜빡인다 — 월드 시계가 멈추는 드래프트 체류 중에도(양쪽 상태가 다 나온다)
    assert.ok(o.blinkOn > 0 && o.blinkOff > 0, `PRESS ANY KEY 가 깜빡인다 (보인 프레임 ${o.blinkOn} · 안 보인 프레임 ${o.blinkOff})`);
    assert.eq(o.humanDraftInDemo, false, '데모 드래프트에 «1 / 2 / 3 선택» 안내가 안 뜬다');
    assert.ok(o.modifierKeepsDemo, '수정 키 단독 · 게임이 안 쓰는 키와의 조합(Cmd+Shift+4)은 데모를 끝내지도 일시정지하지도 않는다');
    assert.ok(o.blurKeepsDemo, 'blur 는 데모를 끝내지도 일시정지하지도 않는다');
    assert.ok(o.returnKeepsDemo, 'focus · 탭 숨김/복귀는 데모를 끝내지 않는다');
    assert.ok(o.keyExitsToTitle, '아무 키 = 다음 프레임에 타이틀');
    assert.ok(aboutIdle(o.nextDemoAfterMs), `끝난 뒤 다음 데모는 다시 ${idleMs}ms 뒤 — 곧바로 이어지지 않는다 (${o.nextDemoAfterMs.toFixed(0)}ms)`);
    assert.ok(o.demoSurvives3s, '새 데모는 스스로 금방 끝나지 않는다(끝 깃발이 남아 있지 않다)');
    assert.ok(o.clickExitsToTitle, '클릭 = 타이틀');
    assert.ok(o.ctrlAloneKeepsDemo, 'Ctrl 단독은 입력이 아니다');
    assert.ok(o.ctrlEscExitsToTitle, '게임 키가 섞인 조합(Ctrl+Esc)은 입력 — «일시정지»가 아니라 타이틀');
    assert.ok(o.ctrlSpaceExitsToTitle, '게임 키는 물리 키(e.code)로 가른다 — Ctrl+Space(key « » · code Space)도 타이틀(배너 건너뛰기 · 난이도 화면이 아니다)');
    assert.ok(o.heldSpaceStaysTitle, '데모를 끝낸 Space 를 누르고 있어도 타이틀에서 «시작»으로 새지 않는다');
    assert.ok(o.freshSpaceOpensDifficulty, '새로 누른 Space = 난이도 화면');
    // ㊿-z6 난이도 메뉴 = ×속도 · ×점수 «둘뿐» (사용자 「그냥 속도랑 score 만 보여지면 좋을것 같아」).
    //   값은 meta.difficulty 가 소유한다. 적의 세기(체력·공격력·발사 주기)는 셋 다 화면에 없다.
    for (const [id, name] of [['normal', 'NORMAL'], ['hard', 'HARD'], ['hell', 'HELL']]) {   // ㊿-z 영어 표기
      const t = { ...d.meta.difficulty[id], ...(DIFF_PATCH[id] || {}) };
      if (id !== 'normal') assert.ok(t.speed !== t.scoreMul, `전제: ${name} 의 속도 ×${t.speed} ≠ 점수 ×${t.scoreMul} (두 칸이 서로를 가장할 수 없다)`);
      //   ㊿-z — 이름과 배율이 두 열로 갈라졌다. 둘 다 화면에 있어야 한다(이름만 있고 배율이 빠지면 메뉴가 아무 말도 안 한다).
      const want = `×${t.speed} SPEED · ×${t.scoreMul} SCORE`;
      assert.ok(o.difficultyTexts.includes(name), `난이도 메뉴에 「${name}」 (${o.difficultyTexts.join(' | ')})`);
      assert.ok(o.difficultyLines.includes(want), `난이도 메뉴에 「${want}」 (${o.difficultyLines.join(' | ')})`);
    }
    // ㊿-z6 — 적의 «세기»는 셋 다 숨긴다. 하나만 적으면 거짓이 되기 때문이다(공격력만 적고 발사 주기를 빼면 헬이 하드와 같아 보인다).
    for (const gone of ['ENEMY ATK', 'FIRE', 'HP']) {
      assert.eq(o.difficultyTexts.some((s) => s.includes(gone)), false, `난이도 화면에 「${gone}」 이 없다`);
    }
    // 체력 배율은 난이도 화면 «어디에도» 없다 — 메뉴 줄만 보면 따로 그린 줄(예: 「체력 ×0.81」)을 놓친다(검토)
    assert.eq(o.difficultyTexts.some((s) => s.includes('HP')), false, '체력 배율은 난이도 화면 어디에도 안 보인다(㊿-z 영어 표기에서도)');
    for (const id of ['normal', 'hard']) {
      const hp = d.meta.difficulty[id].hpMul;
      assert.eq(o.difficultyTexts.some((s) => s.includes(`×${hp}`)), false, `${id} 체력 배율 ×${hp} 가 화면에 안 보인다`);
    }
    assert.ok(o.difficultyIdleNoDemo, '난이도 화면에선 25초 무입력에도 데모가 안 뜬다 — 데모는 타이틀에서만');
    // ㊿-z 도트로 찍은 문구 전수 — 글자판에 없는 글자는 「?」로 나가고 화면을 봐야만 알게 된다(§7.9.1).
    //   타이틀 · 어트랙트 · 난이도 · 옵션을 다 거친 뒤라 이 판에 나오는 문구가 여기 다 모여 있다.
    assert.ok(o.optionsShown && o.optionsEscBackToTitle, '전제: 옵션 화면까지 들렀다 왔다(그 화면 문구도 전수에 든다)');
    assert.gte(o.dotStrings.length, 15, `도트로 찍은 문구가 모였다 (${o.dotStrings.length}개)`);
    for (const line of o.dotStrings) {
      assert.deepEq(unknownChars(line), [], `「${line}」 — 도트 글자판에 없는 글자가 없다`);
    }
    assert.ok(o.escBackToTitle, '난이도 화면에서 Esc = 타이틀');
    const maxEnd = (d.meta.flow.themeBannerSec + d.stages.phase.mobPhaseSec) * 1000 * 1.35;
    assert.ok(o.naturalEndMs >= 0 && o.naturalEndMs <= maxEnd && o.naturalEndTitle,
      `데모가 스스로 끝나면(사망 · 잡몹 페이즈 끝) 결과 화면 없이 타이틀 — 보스전까지 이어지지 않는다 (${o.naturalEndMs.toFixed(0)}ms ≤ ${maxEnd.toFixed(0)}ms)`);
    assert.ok(aboutIdle(o.afterEndNextDemoMs), `입력 없이 끝났어도 다음 데모는 다시 ${idleMs}ms 뒤 — 타이틀에 올 때마다 무입력 시계를 새로 잰다 (${o.afterEndNextDemoMs.toFixed(0)}ms)`);
    assert.ok(o.humanDraftSeen, '사람 판의 드래프트 = «1 / 2 / 3 선택» 안내(데모 안내가 새지 않는다)');
    assert.ok(o.humanDraftWaits, '사람 드래프트는 입력을 기다린다(스스로 고르지 않는다)');
    assert.ok(o.pauseShown && o.pauseHolds25s, '사람 판의 일시정지는 25초 무입력에도 데모로 바뀌지 않는다');
  });

  test('사망으로 끝난 데모도 결과 화면 없이 타이틀 — 다음 데모도 다시 20초 뒤', () => {
    const d = loadData();
    // 한 번 맞으면 죽게 해서 «사망» 길을 확실히 탄다(잡몹 페이즈 끝 길은 위 흐름 테스트가 탄다)
    const o = drive('death', { flow: { attract: { difficulty: 'normal' } }, difficulty: { normal: { enemyDmgMul: 1000000 } } });
    const idleMs = d.meta.flow.attractIdleSec * 1000;
    assert.ok(o.endMs >= 0 && o.endMs < d.stages.phase.mobPhaseSec * 1000, `잡몹 페이즈가 끝나기 전에(= 사망으로) 끝났다 (${o.endMs.toFixed(0)}ms)`);
    assert.ok(o.endTitle, '사망 → 결과 화면이 아니라 타이틀');
    assert.ok(o.afterEndNextDemoMs >= idleMs - 50 && o.afterEndNextDemoMs <= idleMs + o.fastMs + 50,
      `사망 뒤 다음 데모도 다시 ${idleMs}ms 뒤 (${o.afterEndNextDemoMs.toFixed(0)}ms)`);
  });

  test('데모 중 창이 최소 크기 밑으로 줄면 데모를 끝낸다 — 돌아오면 타이틀(일시정지 · 드래프트가 남지 않는다)', () => {
    const o = drive('small');
    assert.ok(o.demoRunning, '전제: 데모가 돌고 있다');
    assert.ok(o.smallShown, '창이 작으면 «창이 너무 작습니다»');
    assert.ok(o.restoredTitle, '창이 돌아오면 타이틀');
    assert.ok(o.stillTitle3s, '3초 뒤에도 타이틀(일시정지 · 드래프트 아님)');
  });

  test('?demo 는 그대로 — 고정 시드 · 카드 1.2초 · 데모 표시 없음 · 드래프트는 «봇이 고르는 중»', () => {
    const o = drive('demo');
    assert.eq(o.tagSeen, false, '?demo 에는 어트랙트 표시가 없다');
    assert.ok(o.autoDraftDwellMs >= 1200 && o.autoDraftDwellMs <= 1212, `?demo 드래프트 체류 1200ms (${o.autoDraftDwellMs}ms)`);
    assert.ok(/— 00000008$/.test(o.tabTitle), `?demo = 고정 시드 00000008 — 탭 제목 (${o.tabTitle})`);
    assert.eq(o.humanDraftSeen, false, '?demo 드래프트에 «1 / 2 / 3 선택» 안내가 없다');
  });
});
