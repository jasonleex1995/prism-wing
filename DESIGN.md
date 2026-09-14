# PRISM WING — 프로젝트 입구

> ⚠️ **이 문서는 스펙이 아니라 안내판이다.** 값·규칙의 유일한 진실은 **[`design/CANON.md`](design/CANON.md)**이고,
> 값의 유일한 거처는 **[`data/*.json`](data/)**이다. 이 문서에는 **숫자를 적지 않는다.**

## 한 줄 소개

**PRISM WING** — 종스크롤 비행 슈팅 게임 · 오락실 로그라이트

> 포켓몬스터와 같이 상성을 고려한 속성 공격으로 적을 깨고,
> 뱀파이어 서바이버즈와 같이 «선택»으로 무기를 성장시키며,
> 로그라이크와 같이 스테이지마다 중간보스·보스가 랜덤인
> **194X식 비행 슈팅 게임.**

완전 오프라인 · 무API · 바닐라 JS. **의존성 0 · 빌드 스텝 0.**

- **플레이**: <https://jasonleex1995.github.io/projects/nan2026/>
- **블로그 페이지**: [`/projects/prism-wing/`](../prism-wing/) — 사이트 레이아웃 안에 iframe으로 임베드한다.
  게임 엔진 자체는 이 폴더(`/projects/nan2026/`)에 그대로 있고, 그 경로를 바꾸면 임베드가 깨진다.

## 상태

| 영역 | 상태 |
|---|---|
| 설계 (`design/CANON.md` v1.7) | ✅ 확정 — 충돌하면 **언제나 정본이 옳다** |
| 데이터 (`data/*.json` 11종) | ✅ 완료 — 빈칸 0 |
| 게임 코드 (`src/` 38파일) | ✅ 완료 — 브라우저 플레이 가능 |
| 정적 검증 (`tools/check.mjs`) | ✅ exit 0 — VIOLATION 0 · CANON 0 · AMBIGUOUS 0 · STUB 20 · SKIP 0 |
| 단위 테스트 (`tools/test.mjs`) | ✅ 541 / 541 |
| 밸런싱 시뮬 (`tools/sim.mjs`) | ✅ 동작 — 헤드리스 셀프플레이(`src/core/bot.js`) |

## 폴더 지도

| 경로 | 내용 |
|---|---|
| [`index.html`](index.html) | 유일한 엔트리. `<script type="module" src="src/main.js">` 하나뿐 |
| [`src/`](src/) | 게임 코드 — `core/`(순수 로직 · 무기 14종) · `render/`(draw · hud) · `main.js`(루프·입력·오디오) |
| [`data/`](data/) | ★ **값의 유일한 거처** — rules · elements · weapons · passives · bullets · enemies · bosses · stages · meta · traits · tutorial |
| [`design/`](design/) | [`CANON.md`](design/CANON.md) **정본 (v1.7, ~6,700행)** — 값·규칙·공식·스키마·검증 게이트의 **단일 소유자**. 설계 문서는 이것 하나뿐이다 |
| [`tests/`](tests/) | 모듈 단위 테스트 33파일 |
| [`tools/`](tools/) | `check.mjs`(정적 게이트 전수(S1~S66 · S33·S40·S46·S48·S52·S53 은 삭제)) · `test.mjs`(테스트 러너) · `sim.mjs`(헤드리스 밸런싱 시뮬) |

## 로컬에서 돌리기

ES 모듈은 `file://`에서 동작하지 않는다. **반드시 서버로 연다.**

```bash
cd projects/nan2026
python3 -m http.server 8000   # http://localhost:8000/
```

- `?demo=1` — 봇이 자동으로 시연 플레이를 한다(고정 시드). 일반 플레이에는 영향 없음.
- 조작: **이동 = 방향키** · **속성 스탠스 = QWER** · **드래프트 선택 = 1/2/3** · **확정/진행 = Space 또는 Enter** · 음소거 = M · 옵션 = O.
  데스크톱 키보드 전용 (터치·모바일 미지원, 확정).

## 고칠 때의 절대 원칙

1. **개발 중 설계 결정 0** — 막히면 그것은 정본의 결함이다. 즉석에서 정하지 말고 정본을 고쳐라.
2. **밸런싱은 오직 숫자만** — `data/*.json`의 값만 바꾼다. 값을 바꾸려고 `.js`를 여는 순간 정본 실패.
   - 정본의 표에 인쇄된 값을 바꾸면 **정본의 표도 함께 고친다** (둘이 갈라지면 실패).
3. **바꾼 뒤엔 반드시 아래 둘 다 exit 0**을 확인한다.

```bash
cd projects/nan2026
node tools/check.mjs   # 정적 게이트 전수(S1~S66) — 데이터가 정본을 지키는지
node tools/test.mjs    # 단위 테스트 541개 — 코드가 계약을 지키는지
```
