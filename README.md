# QA → Claude 자동화 파이프라인

## 개요

1. QA 관리 웹에서 **작업 시작** 클릭 → Firestore `qa_reports/{id}.claudeSession.startedAt` 세팅
2. GitHub Actions **qa-poller** (5분마다 실행) → Firestore 폴링 → 새 세션 발견 시 처리
3. 폴러가 어느 레포에 이슈를 만들어야 할지 판단 (source 필드 기준):
   - `source: 'user'`  → `byungwook5958-creator/E-PARTS_FE-main`
   - `source: 'seller'` → `byungwook5958-creator/E-PARTS-ADMIN-FE-main`
   - `source: 'master'` → `byungwook5958-creator/E-PARTS-MASTER-ADMIN-FE-main`
4. `@claude` 멘션 포함한 이슈 생성 → 기존 Claude Code Action이 반응
5. 폴러가 Firestore에 `issueUrl` 기록, `claudeSession.lastLog: 'GitHub Issue 생성됨'`
6. Issue closed/PR merged 이벤트 웹훅 → **qa-syncer** 워크플로우 → Firestore status를 `done`으로

## 필요 시크릿 (GitHub Secrets)

각 워커 레포에 등록:

- `FIREBASE_SERVICE_ACCOUNT_JSON` — Firebase Admin SDK JSON (전체 JSON을 그대로 붙여넣기)
- `CLAUDE_ISSUE_PAT` — 3개 대상 레포에 issue write 권한이 있는 GitHub PAT
- `ANTHROPIC_API_KEY` — Claude Code Action이 이미 쓰고 있는 그것

## 배포 방법

폴러 자체를 어디에 놓을지 두 가지:

**A. 별도 자동화 레포** (`byungwook5958-creator/eparts-qa-automation` — 신설)
- 장점: 관심사 분리, 한 레포에서 관리
- 단점: 새 레포 생성 필요

**B. 3개 웹 레포 중 아무곳** (예: master admin)
- 장점: 즉시 배포 가능
- 단점: 관심사 혼합

여기 `qa-automation/` 폴더가 A안 준비 상태입니다.
