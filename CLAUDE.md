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
| 테마 (시스템·라이트·다크, `<head>`에서 먼저 로드) | `html[data-theme]` | `js/theme.js` (`IAS.theme`) |
| 상단 바 + 알림 (종, 안 읽음 숫자, 알림 패널, 프로필 사진 버튼) | `.topbar` `.ibtn` `.badge` `.avatar` `.notif-panel` `.notif-item` `.has-topbar` | `js/topbar.js` (`IAS.topbar.mount`) |

## 화면 계획
- 홈: 위젯 그리드 + 앱 아이콘 그리드. 폰/태블릿 세로는 위아래, 태블릿 가로(`min-width: 900px` + landscape)는 좌우.
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
