// GitHub Actions에서 cron으로 5분마다 실행.
// Firestore에서 `claudeSession.startedAt`은 있지만 `claudeSession.issueUrl`은 없는
// qa_reports 문서를 찾아 GitHub Issue를 만들고 issueUrl을 다시 기록한다.

import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { Octokit } from '@octokit/rest';

const PROJECT_ID = 'e-parts-a2f29';

const REPO_BY_SOURCE = {
  user: { owner: 'byungwook5958-creator', repo: 'E-PARTS_FE-main' },
  seller: { owner: 'byungwook5958-creator', repo: 'E-PARTS-ADMIN-FE-main' },
  master: { owner: 'byungwook5958-creator', repo: 'E-PARTS-MASTER-ADMIN-FE-main' },
};

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function main() {
  const serviceAccountJson = JSON.parse(requireEnv('FIREBASE_SERVICE_ACCOUNT_JSON'));
  const githubToken = requireEnv('CLAUDE_ISSUE_PAT');

  initializeApp({
    credential: cert(serviceAccountJson),
    projectId: PROJECT_ID,
  });
  const db = getFirestore();
  const octokit = new Octokit({ auth: githubToken });

  const snap = await db
    .collection('qa_reports')
    .where('status', '==', 'in_progress')
    .get();

  let dispatched = 0;
  let skipped = 0;

  for (const doc of snap.docs) {
    const data = doc.data();

    const target = REPO_BY_SOURCE[data.source];
    if (!target) {
      console.error(`[skip] unknown source: ${data.source} (doc ${doc.id})`);
      skipped++;
      continue;
    }

    // === stuck 감지 ===
    // Claude가 이슈에 finish 코멘트를 남겼지만 PR 없이 open 상태로 끝난 경우 (예: 코드 변경 없음/저장소 미스매치).
    // 방치하면 in_progress로 무한 대기. 관리자가 즉시 확인할 수 있도록 needs_review로 강제 승격 + 안내 로그.
    // pending re-request가 있으면 이 감지를 건너뛴다 (재요청이 우선 dispatch되어야 함).
    if (
      data.claudeSession?.issueUrl &&
      !data.claudeSession?.prUrl &&
      (data.rerequests ?? []).every((r) => r.status !== 'pending')
    ) {
      const issueNumber = Number(data.claudeSession.issueUrl.split('/').pop());
      try {
        const { data: comments } = await octokit.issues.listComments({
          owner: target.owner,
          repo: target.repo,
          issue_number: issueNumber,
          per_page: 30,
        });
        // 마지막 dispatch (재요청 or 최초) 이후에 새로 달린 Claude finish 코멘트를 찾는다.
        const rerequests = data.rerequests ?? [];
        const lastDispatchAt =
          rerequests
            .map((r) => r.dispatchedAt?.toMillis?.() ?? 0)
            .reduce((a, b) => Math.max(a, b), 0) ||
          data.claudeSession?.startedAt?.toMillis?.() ||
          0;
        const finishCandidates = comments.filter(
          (c) =>
            c.user?.login === 'claude' &&
            /Claude finished/.test(c.body || '') &&
            new Date(c.created_at).getTime() > lastDispatchAt,
        );
        if (finishCandidates.length > 0) {
          const last = finishCandidates[finishCandidates.length - 1];
          // 코드 변경 없이 finish한 시그니처 (heuristic).
          const noChangeSignals = [
            '변경할 코드가 없',
            '변경할 게 없',
            '별도 커밋은 진행하지 않',
            '별도 커밋은 필요하지 않',
            '수정할 코드가 없',
            '추가로 변경할 코드가 없',
            '이 저장소',
            '이 프론트엔드',
            '이 프로젝트에서는',
            'no code changes',
            'no changes needed',
          ];
          const looksNoChange = noChangeSignals.some((s) => (last.body || '').includes(s));
          const shortBody = (last.body || '').replace(/\s+/g, ' ').slice(0, 180);
          await doc.ref.update({
            status: 'needs_review',
            'claudeSession.lastLog': looksNoChange
              ? `⚠️ Claude가 자동 처리 불가로 판단 (코드 변경 없음). GitHub 이슈 코멘트 확인 필요: ${shortBody}...`
              : `Claude 응답 완료 (PR 없음). GitHub 이슈 코멘트 확인: ${shortBody}...`,
            updatedAt: FieldValue.serverTimestamp(),
          });
          console.log(`[stuck-promoted] ${doc.id} → needs_review (${looksNoChange ? 'no-change' : 'finish-no-pr'})`);
          dispatched++;
          continue;
        }
      } catch (err) {
        console.error(`[stuck-check] ${doc.id}: ${err.message}`);
      }
    }

    // === 재요청 처리 ===
    // rerequests 배열에 status='pending'인 항목이 있고, issueUrl이 이미 있으면
    // 해당 이슈에 @claude 코멘트로 재요청 메시지 추가
    const rerequests = data.rerequests ?? [];
    const pendingRerequests = rerequests.filter((r) => r.status === 'pending');
    if (pendingRerequests.length > 0 && data.claudeSession?.issueUrl) {
      const issueNumber = Number(data.claudeSession.issueUrl.split('/').pop());
      for (const rer of pendingRerequests) {
        try {
          await octokit.issues.createComment({
            owner: target.owner,
            repo: target.repo,
            issue_number: issueNumber,
            body: `@claude\n\n**재요청 (rerequest)**\n\n${rer.message}\n\n---\n(QA 관리 웹의 "다시 요청" 버튼을 통해 전달됨)`,
          });
        } catch (err) {
          console.error(`[rerequest] failed for ${doc.id}: ${err.message}`);
        }
      }
      // pending → dispatched로 마킹 (배열 안에서는 serverTimestamp 못 씀, Timestamp.now() 사용)
      const now = Timestamp.now();
      const updatedRerequests = rerequests.map((r) =>
        r.status === 'pending'
          ? { ...r, status: 'dispatched', dispatchedAt: now }
          : r
      );
      // arrayUnion으로는 update 불가, 통째로 대체
      await doc.ref.update({
        rerequests: updatedRerequests,
        'claudeSession.lastLog': `${pendingRerequests.length}건 재요청 @claude 코멘트 전달됨`,
        updatedAt: FieldValue.serverTimestamp(),
      });
      console.log(`[rerequest] dispatched ${pendingRerequests.length} for ${doc.id}`);
      dispatched++;
      continue;
    }

    // === 최초 dispatch ===
    if (!data.claudeSession?.startedAt) continue;
    if (data.claudeSession?.issueUrl) {
      skipped++;
      continue; // 이미 dispatch됨
    }

    const body = renderIssueBody({ ...data, id: doc.id });
    try {
      const { data: issue } = await octokit.issues.create({
        owner: target.owner,
        repo: target.repo,
        title: `[QA] ${data.title}`,
        body,
        labels: ['qa-auto', `category-${data.category}`],
      });
      await doc.ref.update({
        'claudeSession.issueUrl': issue.html_url,
        'claudeSession.lastLog': `GitHub Issue #${issue.number} 생성 완료. Claude 응답 대기...`,
        updatedAt: FieldValue.serverTimestamp(),
      });
      console.log(`[ok] dispatched ${doc.id} → ${issue.html_url}`);
      dispatched++;
    } catch (err) {
      console.error(`[err] failed to dispatch ${doc.id}:`, err.message);
      await doc.ref.update({
        'claudeSession.lastLog': `Issue 생성 실패: ${err.message}`,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  }

  console.log(`Done. dispatched=${dispatched}, skipped=${skipped}, scanned=${snap.size}`);
}

function renderIssueBody({ id, title, description, category, source, url, userAgent, reporter }) {
  return `> QA 관리 웹에서 자동 생성된 이슈입니다. 상단 관리자 액션을 통해 Claude에 지시된 작업입니다.

## 요약
${title}

## 카테고리
- source: **${source}** web
- category: **${category}**
${reporter ? `- reporter: ${reporter}\n` : ''}

## 상세 설명
${description || '(없음)'}

## 발생 위치
- URL: ${url || '(없음)'}
- User-Agent: \`${userAgent || '(없음)'}\`

## Firestore 참조
- Document ID: \`${id}\`
- Collection: \`qa_reports\`

---

@claude
이 이슈를 분석하고 필요한 변경을 구현한 뒤 PR을 열어주세요.
- 재현부터 시작해 주세요. 재현이 안 되면 필요한 정보를 코멘트로 요청해 주세요.
- PR 설명에 이 이슈 번호를 참조해 주세요 (자동 close).
- 커밋 메시지는 관례에 맞게 (feat/fix/chore) 접두사를 붙여 주세요.
`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
