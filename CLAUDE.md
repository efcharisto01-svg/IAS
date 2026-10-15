# IAS 그룹웨어 작업 규칙

## 공용 부품 규칙 (가장 중요)
- 화면을 만들 때는 `css/glass.css`와 `js/*.js`에 정리된 **공용 부품만 가져다 쓴다.**
- 공용에 없는 부품·스타일·애니메이션이 필요하면 **새로 만들지 말고 먼저 사용자에게 물어본다.** 승인받은 뒤에만 공용에 추가한다.
- 화면 전용 `<style>`에는 배치(레이아웃)만 둔다. 색·크기·모션 값은 `:root` 토큰을 쓴다.

## 현재 공용 부품
| 부품 | CSS | JS |
|---|---|---|
| 유리 표면 | `.glass` | |
| 입력창 | `.field` `.invalid` `.trailing` | |
| 검색 드롭박스 | `.field.combo` `.combo-list` `.combo-opt` | `js/combobox.js` (`IAS.combo`) |
| 버튼 | `.btn` `.btn-primary` `.btn-glass` | |
| 둥근 스크롤바 | `.scroll-glass` (스크롤되는 모든 영역에 사용) | |
| 헤더게시판 (헤더 고정, 모든 칼럼 정렬: 오름→내림→원상복귀) | `.hboard` `.hboard-head` `.hboard-body` `.hboard-row` | `js/list.js` (`IAS.sortable`, `IAS.stickyShadow`) |
| 모션 | `.rise` `.shake` `.spinner` | |
| 로그인 확인·권한·로그아웃 | | `js/auth.js` (`IAS.auth.require`, `can`, `logout`) |
| 기기 알림 (Web Push, 서비스 워커) | (프로필 > 알림 설정의 스위치) | `js/push.js` (`IAS.push`), `sw.js` |
| 프로필 패널 (사진, 내 정보, 알림·화면 설정, 로그인한 기기, 로그아웃) | `.profile-panel` `.pview` `.me-card` `.me-photo` `.menu-group` `.menu-row` `.switch` `.segmented` `.pf-field` `.dev-row` `.toast` | `js/profile.js` (`IAS.profile.attach`, 상단 바가 자동으로 붙임) |
| 홈 화면 (위젯 그리드 + 앱 아이콘 그리드, 수정 모드·폴더·크기 조절 바) | `.home` `.widgets` `.widget` `.apps` `.app` `.fico` `.edit-x` `.splitter` `.sheet` `.folder-panel` | `js/home.js`, `js/widgets.js` (`IAS.widgets.define`) |
| 테마 (시스템·라이트·다크, `<head>`에서 먼저 로드) | `html[data-theme]` | `js/theme.js` (`IAS.theme`) |
| 상단 바 + 알림 (종, 안 읽음 숫자, 알림 패널, 프로필 사진 버튼) | `.topbar` `.ibtn` `.badge` `.avatar` `.notif-panel` `.notif-item` `.has-topbar` | `js/topbar.js` (`IAS.topbar.mount`) |
| 게시판 부품 (여러 줄 입력, 목록 작은 표시, 본문, 첨부 한 줄, 댓글) | `.textarea` `.tag`(`.req` `.pin` `.cnt`) `.post-body` `.attach`(`.nm` `.sz` `.rm`) `.cmt` | |

## 화면 계획
- 홈(구현됨, `home.html`): 위젯 그리드 + 앱 아이콘 그리드. 폰/태블릿 세로는 위아래로 이어서 한 번에 스크롤, 태블릿 가로(`min-width: 900px` + landscape)는 좌우 + 가운데 크기 조절 바. 배치는 사용자별로 서버에 저장(`/api/me/layout`).
- 시안과 구조도는 아티팩트로 먼저 보여 주고 확정 후 구현한다.

## 서버 (Node.js 22 + SQLite, 외부 패키지 없음)
- 실행 `npm start` (기본 포트 3000, DB는 `data/ias.db`, 개발용 데모 계정 자동 생성: 회사 acme / admin·kim·newbie / `Demo1234!`). 테스트 `npm test`.
- 환경변수: `PORT`, `IAS_DB`, `IAS_PUSH_SUBJECT`, `IAS_VAPID_PRIVATE`(선택), `IAS_SECURE=1`(https), `IAS_TRUST_PROXY=1`(프록시 뒤), `IAS_SEED_DEMO=0`(데모 계정 끄기, 운영에서는 반드시 끈다).
- 로그인은 HttpOnly 쿠키 세션. 세션 값은 DB에 해시로만 저장. 비밀번호는 scrypt.
- 계정 5회 실패 시 5분 잠금, IP별 실패 제한, 모든 POST는 JSON + 같은 출처만 허용.

## 사용권한 규칙
- **앱과 위젯은 항상 같이 만들고, 만들 때 권한 항목(resource id)도 함께 정한다.** 화면마다 `kind`(`app`/`widget`)와 id를 하나씩 가진다.
- 권한 = 역할(role_grants) + 사용자별 예외(user_grants, `allow=0` 차단이 우선). `*`는 전체 허용.
- 화면 표시는 `IAS.auth.can(me, 'app', id)`로 가리고, **실제 차단은 서버 API에서 반드시 다시 확인한다.**
- 계정은 회사 관리자 등록, 엑셀 일괄 등록, SSO 세 가지를 지원할 계획 (아직 미구현).

## 알림 규칙
- 모든 로그인 후 화면은 `IAS.topbar.mount({ title, me })`로 상단 바를 쓴다. 종의 숫자는 안 읽은 알림 수, 패널은 "전체 N건 · 안 읽음 M건".
- 알림 보내기는 서버 `notify(db, { tenantId, userId, app, source, title, body, link })` (`server/notifications.js`). `app`은 보낸 앱의 권한 id이고, 그 앱을 쓸 수 없는 사용자에게는 보이지도 세어지지도 않는다. `null`이면 시스템 알림. `link`는 같은 사이트의 `.html` 페이지만 허용.
- 알림을 누르면 읽음 처리 후 `link` 화면으로 이동. 새 알림은 30초마다 서버에 확인(탭이 숨겨져 있으면 멈춤). 60일이 지난 알림은 서버가 자동 삭제(시작 시 + 6시간마다).
- 기기 알림(Web Push): 프로필 > 알림 설정에서 사용자가 기기마다 켠다. `notify()`가 저장한 알림은 그 사용자의 켜 둔 기기에도 암호화해서 보낸다(권한 없는 앱의 알림은 보내지 않음). 화면이 떠 있고 포커스가 있으면 기기 알림 대신 종만 갱신한다.
- 알림이 화면에 떠 있는 시간(예: 30초)은 우리가 정하지 않고 **브라우저와 OS 설정을 따른다.** 개인별 초 설정 화면은 만들지 않는다.
- 로그아웃하면 그 기기의 기기 알림 구독을 해제한다(공용 컴퓨터 보호). 같은 브라우저를 다른 사용자가 켜면 구독이 그 사용자로 옮겨진다.
- 운영: 기기 알림은 HTTPS에서만 동작(개발은 localhost 가능). `IAS_PUSH_SUBJECT=mailto:담당자메일`을 설정하고, VAPID 키(DB `server_settings`)를 바꾸면 모든 기기가 다시 켜야 하므로 DB 백업에 포함한다. 아이폰은 홈 화면에 추가한 뒤에만 가능.

## 프로필·개인 설정 규칙
- 모든 로그인 후 화면은 `<head>`에 `js/theme.js`를 넣어 깜빡임 없이 테마를 적용한다(시스템/라이트/다크, 계정에 저장).
- 본인이 고치는 정보는 이메일과 전화번호뿐. 이름·부서·직책은 회사 관리자가 관리한다(서버가 무시함).
- 프로필 사진: 브라우저가 512px 정사각 JPEG로 줄여 올리고, 서버는 JPEG/PNG/WebP 형식과 1MB 이하만 DB에 저장. 같은 회사 사람의 사진만 `/api/users/:id/photo`로 볼 수 있다.
- 앱별 알림 끄기: 서버 `server/apps.js`의 `registerApp({ id, name })`로 앱을 등록하면 프로필 > 알림 설정에 자동으로 나타난다. 꺼 둔 앱의 알림은 만들어지지 않는다(`notify()`가 `null` 반환). 시스템 알림은 끌 수 없다.
- 로그인한 기기: `/api/me/sessions`로 목록, 기기별 로그아웃, 다른 모든 기기 로그아웃(현재 기기는 항상 유지).

## 로그기록 규칙 (변경 기록 + 로그인·보안 기록)
- **변경 기록**: DB의 모든 칼럼 변경을 DB 트리거가 자동으로 남긴다. 형식은 `칼럼명(table.column) / 한글명 / 변경전 / 변경후 / 작업일시(초까지) / 변경자`. 변경전이 없던 데이터면 빈칸, 삭제했으면 변경후가 빈칸. 비밀번호 해시는 `[숨김]`, 사진 같은 이진 데이터는 `[이진 데이터 N바이트]`. 화면은 `log.html`(앱 id `audit`, 회사 관리자 전용), CSV 내려받기 가능.
- **새 테이블·칼럼을 만들면** `server/changelog.js`의 `TRACKED`에 **모든 칼럼의 한글명**과 함께 넣거나 `UNTRACKED`에 이유와 함께 넣는다. 안 하면 서버가 시작되지 않고 테스트가 실패한다(조용히 빠지는 일이 없도록).
- **작성자 기록**: 로그인한 사용자의 DB 쓰기는 반드시 `asUser(db, user, () => { ...동기 쓰기... })` 안에서 한다. 밖에서 쓰면 변경자가 "시스템"으로 남는다. 시드·마이그레이션은 `withoutLog(db, fn)`.
- 변경 기록에서 일부러 뺀 칼럼: `users.failed_count`, `users.locked_until` (잦은 변경, 로그인 기록에 남음). 일부러 뺀 테이블: `sessions`, `push_subscriptions`, `notifications`, `server_settings`, 로그 테이블 자신.
- **로그인·보안 기록**(`audit_log`): 로그인 성공/실패/잠금, 로그아웃, 비밀번호 변경, 다른 기기 로그아웃, 기기 알림 켜기/끄기, 로그 CSV 내려받기. `GET /api/admin/audit` (화면은 아직 없음). 앱이 만드는 "기록할 만한 행위"는 `record(db, { category: 'data'|'admin'|'security', event, userId, app, target, summary, data })`.
- 수정·삭제 불가: 두 로그 모두 DB 트리거로 수정을 막고, 보관 기간(3년 이상, `IAS_AUDIT_RETENTION_DAYS`, 기본 1095일)이 지난 행만 서버가 자동 삭제한다. 로그 파일(DB)은 서버 밖으로 주기적으로 복사해 둔다.
- 로그에는 비밀번호·토큰·세션 값을 절대 넣지 않는다(`sanitize`가 키 이름으로 걸러냄).

## 앱·위젯 만들기 (같이 만든다)
1. **서버**: `server/modules.js`에 `registerApp({ id, name, color, link, icon?, notifies? })`와 `registerWidget({ id, name, size, tall?, script, app })`를 추가한다. 권한 항목은 앱 `kind='app'`, 위젯 `kind='widget'`의 id. 관리자(`*`)는 자동으로 모두 받고, 일반 역할은 `role_grants`/`user_grants`로 준다.
2. **화면**: 앱 페이지(`link`)는 `IAS.auth.require()` + `IAS.topbar.mount()`를 쓰고, 서버 API는 **반드시 권한을 다시 확인**한다.
3. **위젯**: `script`에 적은 파일 `js/widgets/<이름>.js`에서 `IAS.widgets.define(id, { render(body, ctx) {...; return { stop() {} }} })`. 서버 데이터는 `textContent`/DOM으로만 그린다(`innerHTML` 금지). 카드를 누르면 앱 페이지로 이동한다.
4. **데이터**: 새 테이블은 `server/changelog.js`에 모든 칼럼의 한글명과 함께 등록, 쓰기는 `asUser()` 안에서, 필요하면 `notify()`로 알림.
5. 홈은 사용자가 쓸 수 있는 앱·위젯만 보여 주며, 새 앱은 맨 끝에 자동으로 나타나고 새 위젯은 "위젯 추가"에서 고른다.
- 현재 앱: **로그기록**(id `audit`, 위젯 `audit.recent`, 회사 관리자 전용, `log.html`), **게시판**(id `board`, 위젯 `board.recent`, `board.html`).

## 게시판 규칙 (`server/board.js`, 화면 `board.html` `post.html` `write.html` `board-manage.html`)
- 게시판은 여러 개, 각각 분류를 가진다. **읽기·쓰기·고정(공지 고정·필독) 권한은 게시판을 만들 때 역할별로 고른다.** 저장 위치는 `role_grants`의 앱 권한 id `board.read.<게시판id>`, `board.write.<게시판id>`, `board.pin.<게시판id>`. `board.manage`는 게시판 관리와 남의 글·댓글 삭제 권한. 회사 관리자(`*`)는 전부 가진다.
- 역할에 게시판 권한을 주면 서버가 그 역할에 앱 `board`와 위젯 `board.recent`도 함께 준다. 모든 API는 `board` 앱 권한 + 게시판별 권한을 서버에서 다시 확인한다.
- 글·댓글 삭제는 숨김(`status='deleted'`)이고 변경 기록에 남는다. 게시판도 지우지 않고 `hidden`으로 감춘다. 분류를 지우면 그 분류의 글은 분류 없음이 된다.
- 알림: 필독 글 → 그 게시판을 읽을 수 있는 다른 사람 모두, 댓글 → 글쓴이. 링크는 `post.html?id=N`.
- 본문은 글자만 그린다(HTML 금지): `[[img:번호]]`는 본문 사진, `https://` 주소는 링크. 사진은 브라우저가 1600px JPEG로 줄여 올린다(5MB 이하, 서버가 형식 확인). 파일은 5개·10MB·합계 30MB, 확장자 허용 목록만, 내려받기는 항상 attachment. 글에 붙지 않은 업로드는 하루 뒤 서버가 지운다.
- 게시판 화면 만들 때 추가한 공용 부품은 위 표의 "게시판 부품" 줄.
