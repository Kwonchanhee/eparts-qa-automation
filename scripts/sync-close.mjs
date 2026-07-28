// Issue/PR close 이벤트가 워크플로우로 들어오면 실행.
// 환경변수로 issue URL(또는 PR URL)을 받고, Firestore에서 매칭되는 qa_report를 찾아 done으로 마킹.
//
// 사용법 (GitHub Actions workflow에서):
//   env:
//     ISSUE_URL: ${{ github.event.issue.html_url }}
//     PR_URL: ${{ github.event.pull_request.html_url }}

import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const PROJECT_ID = 'e-parts-a2f29';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function main() {
  const serviceAccountJson = JSON.parse(requireEnv('FIREBASE_SERVICE_ACCOUNT_JSON'));
  const issueUrl = process.env.ISSUE_URL || '';
  const prUrl = process.env.PR_URL || '';
  const eventAction = process.env.EVENT_ACTION || 'closed'; // closed / merged
  const eventBody = process.env.EVENT_BODY || '';

  initializeApp({
    credential: cert(serviceAccountJson),
    projectId: PROJECT_ID,
  });
  const db = getFirestore();

  // PR body에서 이슈 번호(=이슈 URL)를 추출해서 조회 정확도 향상
  // 조회 전략: issueUrl 매칭 우선, 없으면 PR body에서 issue url 추출
  let anchorUrl = issueUrl;
  if (!anchorUrl && eventBody) {
    const match = eventBody.match(/https:\/\/github\.com\/[\w-]+\/[\w.-]+\/issues\/\d+/);
    if (match) anchorUrl = match[0];
  }
  if (!anchorUrl) {
    console.log('No anchor URL to match. Exiting.');
    return;
  }

  const snap = await db
    .collection('qa_reports')
    .where('claudeSession.issueUrl', '==', anchorUrl)
    .get();

  if (snap.empty) {
    console.log(`No qa_report matched: ${anchorUrl}`);
    return;
  }

  const patch = {
    'claudeSession.lastLog':
      eventAction === 'merged'
        ? `PR 머지 완료: ${prUrl || '(url 없음)'}`
        : `Issue closed. (${eventAction})`,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (eventAction === 'merged' || eventAction === 'closed') {
    patch.status = eventAction === 'merged' ? 'done' : 'needs_review';
    if (prUrl) patch['claudeSession.prUrl'] = prUrl;
  }

  for (const doc of snap.docs) {
    await doc.ref.update(patch);
    console.log(`[ok] synced ${doc.id} → status=${patch.status ?? '(unchanged)'}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
