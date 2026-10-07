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

## 화면 계획
- 홈: 위젯 그리드 + 앱 아이콘 그리드. 폰/태블릿 세로는 위아래, 태블릿 가로(`min-width: 900px` + landscape)는 좌우.
- 시안과 구조도는 아티팩트로 먼저 보여 주고 확정 후 구현한다.
