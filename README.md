# Rofan AI Helper
로판 AI(`https://rofan.ai`) 전용 Chrome/Edge 확장 프로그램입니다. 데이터는 서버로 보내지 않고 `chrome.storage.local`에 저장합니다.
현재 버전: `0.20.0`
현재 목표는 “목록을 편하게 보고, 플레이/메모/평점/숨김 기록을 로컬에서 관리하는 보조 도구”입니다. 아직 사이트 DOM에 맞춰 조정 중인 기능이 있으므로 아래 상태표를 기준으로 하나씩 바로잡으면 됩니다.

## 설치/갱신
1. Chrome 또는 Edge에서 `chrome://extensions`를 엽니다.
2. `개발자 모드`를 켭니다.
3. 처음 설치라면 `압축해제된 확장 프로그램을 로드`를 누르고 이 폴더를 선택합니다.
4. 이미 설치했다면 확장 카드의 새로고침 버튼을 누릅니다.
5. 열려 있던 `rofan.ai` 탭도 새로고침합니다.

## 파일
- `manifest.json`: 확장 프로그램 설정
- `src/content.js`: 로판 AI 페이지에 기능을 붙이는 본체
- `src/styles.css`: Helper UI와 테마 CSS
- `rofan-ai-helper.zip`: 현재 폴더를 압축한 배포용 파일

## 개발 메모
- 사이트는 Next.js 기반이며 `#__NEXT_DATA__`에 캐릭터 데이터가 들어오는 페이지가 있습니다.