/* 공용 부품 목록 화면(components.html). 서버 데이터 없이 정적 예시만 그린다. */
(function () {
  const root = document.getElementById('root');
  const ico = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  function sec(title, cls, demo, use) {
    const s = document.createElement('section'); s.className = 'glass sec';
    const h = document.createElement('h2'); h.textContent = title; const sm = document.createElement('small'); sm.textContent = cls; h.appendChild(sm);
    const d = document.createElement('div'); d.className = 'demo'; d.innerHTML = demo; // 정적 예시만
    s.append(h, d);
    if (use) { const c = document.createElement('code'); c.className = 'use'; c.textContent = use; s.appendChild(c); }
    root.appendChild(s); return d;
  }

  sec('버튼', '.btn .btn-primary .btn-glass .btn-danger .btn-text .btn-sm .btn-icon', `
    <button class="btn btn-primary">기본 (파랑)</button>
    <button class="btn btn-glass">보조 (유리)</button>
    <button class="btn btn-danger">삭제 (위험)</button>
    <button class="btn btn-text">글자 버튼</button>
    <div class="btn-row"><button class="btn btn-primary btn-sm">작게</button><button class="btn btn-glass btn-sm">작게</button><button class="btn btn-glass btn-icon" aria-label="추가">${ico}</button><button class="btn btn-primary" disabled>비활성</button></div>
    <div class="btn-row even"><button class="btn btn-glass">취소</button><button class="btn btn-primary">저장</button></div>`,
  '<button class="btn btn-primary">  · 폭 자동: btn-auto / 작게: btn-sm / 둥근 아이콘: btn-icon\n<div class="btn-row [end|even]"> 로 나란히 놓기');

  sec('입력창·폼', '.field .textarea .select .label .hint .errmsg .check .switch', `
    <div><label class="label">이름</label><label class="field"><input placeholder="입력"></label><div class="hint">도움말은 .hint</div></div>
    <div><label class="label">오류 상태</label><label class="field invalid"><input value="잘못된 값"></label><div class="errmsg">오류 문구는 .errmsg</div></div>
    <div><label class="label">여러 줄</label><textarea class="textarea compact" placeholder="내용"></textarea></div>
    <div><label class="label">선택</label><select class="select"><option>하나</option><option>둘</option></select></div>
    <div class="cluster"><label class="check"><input type="checkbox" checked> 체크</label><label class="check"><input type="radio" name="r" checked> 라디오</label><label class="check"><input type="radio" name="r"> 라디오</label></div>`,
  '검색 드롭박스는 .field.combo + js/combobox.js (IAS.combo)');

  sec('알림 박스 · 상태', '.alert .state .denied .skeleton .spinner.dark .progress', `
    <div class="alert"><span><b>안내</b> 계속 떠 있는 설명</span></div>
    <div class="alert ok">저장했습니다</div><div class="alert warn">곧 만료됩니다</div><div class="alert err">저장하지 못했습니다</div>
    <div class="state">표시할 내용이 없습니다</div>
    <div><span class="skeleton"></span><span class="skeleton w60"></span><span class="skeleton w40"></span></div>
    <div class="cluster"><span class="spinner dark"></span><span class="muted">불러오는 중</span></div>
    <div class="progress" style="--v:62%"></div>`,
  '진행 막대 값은 style="--v:62%"');

  sec('칩 · 탭 · 쪽 번호 · 경로 · 태그', '.chip .tabs .tab .pager .crumbs .tag', `
    <div class="cluster"><button class="chip on">전체</button><button class="chip">공지</button><button class="chip">자료</button></div>
    <div class="tabs" role="tablist"><button class="tab" role="tab" aria-selected="true">개요</button><button class="tab" role="tab" aria-selected="false">댓글</button><button class="tab" role="tab" aria-selected="false">기록</button></div>
    <div class="pager"><button disabled>‹</button><button aria-current="page">1</button><button>2</button><button>3</button><button>›</button></div>
    <nav class="crumbs"><a href="home.html">홈</a><a href="board.html">게시판</a><span>글 보기</span></nav>
    <div class="cluster"><span class="tag">분류</span><span class="tag req">필독</span><span class="tag pin">공지</span><span class="tag cnt">[3]</span></div>`,
  '칩 켜짐은 aria-pressed="true" 또는 .on, 탭은 aria-selected, 현재 쪽은 aria-current="page"');

  sec('게시판 ① 헤더게시판 (큰 목록, 칼럼 정렬)', '.hboard + IAS.sortable', '<div class="muted">board.html · log.html 에서 실제로 쓰는 형태. 헤더 고정, 모든 칼럼 정렬.</div>', '자세한 사용법은 js/list.js 상단 주석');

  sec('게시판 ② 카드형 (사진·갤러리·사람)', '.cboard .ccard', `
    <div class="cboard">
      <a class="ccard" href="#"><div class="thumb"></div><div class="body"><div class="ti">카드 제목은 두 줄까지 보이고 넘치면 줄입니다</div><div class="meta">홍길동 · 오늘</div></div></a>
      <a class="ccard" href="#"><div class="thumb"></div><div class="body"><div class="ti">두 번째 카드</div><div class="meta">김철수 · 어제</div></div></a>
      <a class="ccard" href="#"><div class="thumb"></div><div class="body"><div class="ti">세 번째 카드</div><div class="meta">이영희 · 3일 전</div></div></a>
    </div>`, '썸네일: <div class="thumb" style="background-image:url(...)"> (사진이 없으면 회색)');

  sec('게시판 ③ 줄 목록 (설정·간단 목록)', '.lboard .lrow', `
    <div class="glass lboard">
      <a class="lrow" href="#"><div class="grow"><div class="ti">첫 번째 항목</div><div class="sub">보조 설명</div></div><span class="end">3건</span></a>
      <a class="lrow" href="#"><div class="grow"><div class="ti">두 번째 항목</div><div class="sub">보조 설명</div></div><span class="end">어제</span></a>
    </div>`);

  sec('표 · 항목-값', '.table .kv', `
    <table class="table"><thead><tr><th>이름</th><th>부서</th><th class="num">건수</th></tr></thead><tbody><tr><td>홍길동</td><td>영업</td><td class="num">12</td></tr><tr><td>김철수</td><td>개발</td><td class="num">8</td></tr></tbody></table>
    <dl class="kv"><dt>이름</dt><dd>홍길동</dd><dt>이메일</dt><dd>hong@example.com</dd></dl>`,
  '정렬이 필요한 큰 목록은 표 대신 헤더게시판');

  sec('토스트 · 확인창 · 대화상자', 'IAS.ui.toast / confirm / modal  (js/ui.js)', `
    <div class="btn-row"><button class="btn btn-glass btn-sm" id="t1">토스트</button><button class="btn btn-glass btn-sm" id="t2">오류 토스트</button><button class="btn btn-danger btn-sm" id="t3">확인창</button><button class="btn btn-primary btn-sm" id="t4">대화상자</button></div>`,
  "IAS.ui.toast('저장했습니다'); IAS.ui.toast('실패', 'err');\nif (await IAS.ui.confirm({ title:'삭제할까요?', text:'…', ok:'삭제', danger:true })) {…}\nconst close = IAS.ui.modal(node);  // Esc·바깥 클릭으로 닫힘");

  sec('그 밖에 이미 있는 것', '위쪽 CLAUDE.md 표 참고', '<div class="muted">유리 표면 .glass · 둥근 스크롤바 .scroll-glass · 모션 .rise .shake · 상단 바 IAS.topbar · 프로필 .menu-group .menu-row .switch .segmented · 홈 위젯 · 게시판 본문 .post-body .attach .cmt</div>');

  const $ = (id) => document.getElementById(id);
  $('t1').onclick = () => IAS.ui.toast('저장했습니다');
  $('t2').onclick = () => IAS.ui.toast('저장하지 못했습니다', 'err');
  $('t3').onclick = async () => { const ok = await IAS.ui.confirm({ title: '삭제할까요?', text: '되돌릴 수 없습니다.', ok: '삭제', danger: true }); IAS.ui.toast(ok ? '삭제했습니다' : '취소했습니다'); };
  $('t4').onclick = () => { const w = document.createElement('div'); const h = document.createElement('h2'); h.textContent = '대화상자'; const p = document.createElement('p'); p.textContent = '직접 만든 내용을 넣을 수 있습니다.'; const b = document.createElement('button'); b.className = 'btn btn-primary'; b.textContent = '닫기'; w.append(h, p, b); const close = IAS.ui.modal(w); b.onclick = close; };
  $('themeL').onclick = () => IAS.theme.apply('light');
  $('themeD').onclick = () => IAS.theme.apply('dark');
  $('themeS').onclick = () => IAS.theme.apply('system');
})();
