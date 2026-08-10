// Issue/PR close 이벤트가 워크플로우로 들어오면 실행.
// - Firestore qa_report 상태 업데이트 (needs_review or done)
// - PR merge 시 이메일 자동 발송 (관리자 확인 요청)

import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import nodemailer from 'nodemailer';

const PROJECT_ID = 'e-parts-a2f29';
const NOTIFY_EMAILS = ['byungwook5958@gmail.com', 'chkwon147@naver.com'];
const ADMIN_WEB_URL = 'https://e-parts-a2f29.web.app';
const DEV_URLS = {
  user: 'https://dev.e-parts.biz',
  seller: 'https://dev-seller.e-parts.biz',
  master: 'https://dev-master.e-parts.biz',
};

function devUrlFor(source, origUrl) {
  const base = DEV_URLS[source] ?? DEV_URLS.user;
  if (!origUrl) return base;
  try {
    const u = new URL(origUrl);
    return base + u.pathname + u.search + u.hash;
  } catch {
    return base;
  }
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendReviewEmail(docId, report, extraLog) {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailPass) {
    console.log('[email] GMAIL_USER/GMAIL_APP_PASSWORD 미설정 — 이메일 스킵');
    return;
  }
  const link = `${ADMIN_WEB_URL}/report/?id=${encodeURIComponent(docId)}`;
  const devLink = devUrlFor(report.source, report.url);
  const subject = `[E-Parts QA] 처리 완료 확인 요청: ${report.title}`;
  const text = `${report.title}\n\n${extraLog}\n\nDEV 확인: ${devLink}\nQA 관리: ${link}`;
  const html = `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Apple SD Gothic Neo', sans-serif; color: #111; max-width: 560px; margin: 0 auto; padding: 20px;">
  <div style="background: #00B207; color: #fff; padding: 16px 20px; border-radius: 10px 10px 0 0; font-weight: 700; font-size: 18px;">
    ✓ QA 자동 처리 완료 알림
  </div>
  <div style="border: 1px solid #E5E7EB; border-top: 0; border-radius: 0 0 10px 10px; padding: 20px;">
    <p style="margin: 0 0 12px 0;">Claude가 자동 처리한 QA 이슈가 배포되었습니다. 실제 반영 여부를 확인해 주세요.</p>
    <table style="border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px;">
      <tr><td style="padding: 6px 0; color: #6B7280; width: 80px;">제목</td><td style="padding: 6px 0; font-weight: 600;">${escapeHtml(report.title)}</td></tr>
      <tr><td style="padding: 6px 0; color: #6B7280;">출처</td><td style="padding: 6px 0;">${escapeHtml(report.source)} 웹</td></tr>
      <tr><td style="padding: 6px 0; color: #6B7280;">카테고리</td><td style="padding: 6px 0;">${escapeHtml(report.category)}</td></tr>
    </table>
    <div style="background: #F9FAFB; padding: 12px 14px; border-radius: 6px; border-left: 3px solid #00B207; margin: 16px 0; font-size: 13px;">
      ${escapeHtml(extraLog)}
    </div>
    <div style="text-align: center; margin: 24px 0; display: flex; flex-direction: column; gap: 10px;">
      <a href="${devLink}" style="display: inline-block; background: #0EA5E9; color: #fff !important; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px;">
        🌐 DEV 웹에서 실제 결과 확인
      </a>
      <a href="${link}" style="display: inline-block; background: #00B207; color: #fff !important; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px;">
        ✓ QA 관리 (처리완료/다시요청)
      </a>
    </div>
    <div style="font-size: 12px; color: #6B7280; text-align: center; word-break: break-all;">
      DEV: <a href="${devLink}" style="color: #0EA5E9;">${devLink}</a><br>
      QA관리: <a href="${link}" style="color: #0EA5E9;">${link}</a>
    </div>
    <hr style="border: none; border-top: 1px solid #F1F5F9; margin: 20px 0;">
    <div style="font-size: 12px; color: #6B7280;">
      DEV에서 확인 후:<br>
      · 문제 없음 → QA 관리에서 <b>처리완료</b> + <b>🚀 프로덕션 배포</b> 페이지에서 최종 배포<br>
      · 수정이 부족함 → QA 관리 상세에서 <b>다시 요청</b> 입력하고 재처리 요청<br>
      · 완전히 되돌리기 → <b>↩︎ 이 수정만 되돌리기</b>
    </div>
  </div>
</body></html>`;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: gmailUser, pass: gmailPass },
  });
  await transporter.sendMail({
    from: `E-Parts QA <${gmailUser}>`,
    to: NOTIFY_EMAILS.join(', '),
    subject,
    text,
    html,
  });
  console.log(`[email] 발송 완료: ${NOTIFY_EMAILS.join(', ')}`);
}

async function main() {
  const serviceAccountJson = JSON.parse(requireEnv('FIREBASE_SERVICE_ACCOUNT_JSON'));
  const issueUrl = process.env.ISSUE_URL || '';
  const prUrl = process.env.PR_URL || '';
  const eventAction = process.env.EVENT_ACTION || 'closed'; // closed / merged
  const eventBody = process.env.EVENT_BODY || '';
  // 프로덕션 배포용: 머지된 PR의 커밋 SHA + 제목 (워크플로우에서 세팅)
  const prMergeSha = process.env.PR_MERGE_SHA || '';
  const prTitle = process.env.PR_TITLE || '';
  const prNumber = process.env.PR_NUMBER || '';
  const repoFullName = process.env.REPO_FULL_NAME || '';

  initializeApp({
    credential: cert(serviceAccountJson),
    projectId: PROJECT_ID,
  });
  const db = getFirestore();

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

  // PR merge → needs_review (관리자 확인 대기)
  // Issue closed (PR 없이) → needs_review 유지
  const isMerged = eventAction === 'merged';
  const patch = {
    status: 'needs_review',
    'claudeSession.lastLog': isMerged
      ? `Claude가 처리한 PR이 머지되어 자동 배포 완료. 관리자 확인 요청.`
      : `이슈가 닫혔습니다. (${eventAction})`,
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (prUrl) patch['claudeSession.prUrl'] = prUrl;

  // 디버그: env 값 로그
  console.log(`[env] eventAction=${eventAction} isMerged=${isMerged} prMergeSha=${prMergeSha ? prMergeSha.slice(0,8) : '(empty)'} prTitle=${prTitle ? prTitle.slice(0,40) : '(empty)'} repoFullName=${repoFullName || '(empty)'}`);

  // 머지된 PR이면 commits[] 배열에 자동 추가 (프로덕션 배포 페이지 리스트에 뜨게)
  // prMergeSha가 없으면 PR API에서 fetch (auto-merge squash 시 이벤트 페이로드에 종종 누락)
  let mergeSha = prMergeSha;
  if (isMerged && !mergeSha && prUrl && repoFullName) {
    const m = prUrl.match(/\/pull\/(\d+)/);
    if (m) {
      try {
        const { Octokit } = await import('@octokit/rest');
        const gh = new Octokit({ auth: process.env.CLAUDE_ISSUE_PAT });
        const [owner, repo] = repoFullName.split('/');
        const { data } = await gh.pulls.get({ owner, repo, pull_number: Number(m[1]) });
        mergeSha = data.merge_commit_sha;
        console.log(`[env] fetched mergeSha=${mergeSha ? mergeSha.slice(0,8) : '(null)'} from GitHub API`);
      } catch (err) {
        console.error('[env] PR SHA fetch 실패:', err.message);
      }
    }
  }

  if (isMerged && mergeSha && repoFullName) {
    const commitObj = {
      repo: repoFullName,
      sha: mergeSha,
      message: prTitle || `PR #${prNumber} merge`,
      createdAt: Timestamp.now(),
    };
    if (prUrl) commitObj.url = `https://github.com/${repoFullName}/commit/${mergeSha}`;
    patch.commits = FieldValue.arrayUnion(commitObj);
  }

  for (const doc of snap.docs) {
    await doc.ref.update(patch);
    console.log(`[ok] synced ${doc.id} → status=${patch.status}${patch.commits ? ' + commit 기록' : ''}`);

    if (isMerged) {
      try {
        await sendReviewEmail(doc.id, doc.data(), patch['claudeSession.lastLog']);
      } catch (err) {
        console.error('[email] 발송 실패:', err.message);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
