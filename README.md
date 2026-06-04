# 실시간 검색어 모니터링

네이버 · ZUM · 네이트 · 다음의 실시간 데이터를 크롤링해 한 화면에서 보여주는 대시보드입니다.
(adsensefarm.kr/realtime 스타일)

## 실행

```bash
npm install
npm start
```

→ 브라우저에서 http://localhost:3000

## 데이터 출처 (실시간 크롤링)

| 칼럼 | 소스 | 비고 |
|------|------|------|
| **네이버** | 뉴스 많이 본 기사 랭킹 | 옛 '실시간 검색어'는 2021년 폐지 → 뉴스 랭킹 사용 (EUC-KR) |
| **ZUM** | 실시간 검색어 | zum.com 홈에 임베드된 `real1_id` 파싱 |
| **네이트** | 실시간 이슈 키워드 | `jsonLiveKeywordDataV1.js` (EUC-KR JSON) |
| **다음** | 주요 뉴스 | news.daum.net 헤드라인 |

> 추가 라이브러리 없이 Node 24 내장 `fetch` + `TextDecoder('euc-kr')`만 사용합니다.

## 지표 계산

- **지수**: 순위 기반 `round(10000 / rank^0.62)` — 1위=10,000
- **비중**: 해당 매체 내 지수 합 대비 비율(%)
- **5분증감**: 직전 크롤링 대비 지수 변화 (서버가 280초 캐시 → 5분 자동 갱신 주기와 정렬). 신규 진입은 지수 전체를 ▲로 표시
- **교차 키워드**: 2개 이상 매체 키워드에서 공통으로 등장하는 토큰
- **토크나이저 & 예측**: 키워드를 클릭하면 토큰을 공유하는 연관 키워드와 다음 예측 토큰 표시

## 구조

```
server.js     Express 서버 + /api/keywords (크롤링 결과 가공·캐시)
crawler.js    4개 매체 크롤러 (병렬, 일부 실패해도 나머지 반환)
public/       index.html · style.css · app.js (프론트엔드)
```

## 무료 배포 (Render)

이미 git 저장소로 초기화되어 있고 `render.yaml`이 포함되어 있습니다.

**1) GitHub에 올리기** — github.com에서 빈 저장소 생성 후, 이 폴더에서:

```bash
git remote add origin https://github.com/<내아이디>/<저장소명>.git
git push -u origin main
```

> 첫 push 시 Windows 자격증명 관리자가 GitHub 로그인 창을 띄웁니다. 이후 자동.

**2) Render 연결** — https://render.com 로그인 → **New ▸ Web Service** → 위 GitHub 저장소 선택
→ 빌드/시작 명령은 `render.yaml`에서 자동 인식 (`npm install` / `npm start`), Plan은 **Free** → **Create**.

수 분 후 `https://<서비스명>.onrender.com` 주소가 발급됩니다.

### 무료 티어 제약
- 15분간 요청이 없으면 슬립 → 다음 접속 시 ~30초 콜드스타트
- 디스크가 휘발성이라 재배포/재시작 시 `data/history.json`(시계열) 초기화 → 그 시점부터 다시 누적
- 시계열을 영구 보존하려면 외부 저장소(무료 DB 등) 연동이 필요합니다 (선택)

## 참고

- 크롤링은 대상 사이트의 HTML/엔드포인트 구조에 의존하므로, 사이트 개편 시 `crawler.js`의 셀렉터를 수정해야 할 수 있습니다.
- 포트 변경: `PORT=8080 npm start` (Render는 자동으로 `PORT` 주입)
- 시계열 적재 간격 테스트: `HISTORY_INTERVAL_SEC=10 npm start`
