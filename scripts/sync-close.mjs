// Issue/PR close 이벤트가 워크플로우로 들어오면 실행.
// - Firestore qa_report 상태 업데이트 (needs_review or done)
// - PR merge 시 이메일 자동 발송 (관리자 확인 요청)

import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import nodemailer from 'nodemailer';

const PROJECT_ID = 'e-parts-a2f29';
const NOTIFY_EMAILS = ['byungwook5958@gmail.com', 'chkwon147@naver.com'];
const ADMIN_WEB_URL = 'https://e-parts-a2f29.web.app';

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
  const subject = `[E-Parts QA] 처리 완료 확인 요청: ${report.title}`;
  const text = `${report.title}\n\n${extraLog}\n\n확인: ${link}`;
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
    <div style="text-align: center; margin: 24px 0;">
      <a href="${link}" style="display: inline-block; background: #00B207; color: #fff !important; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px;">확인하러 가기 →</a>
    </div>
    <div style="font-size: 12px; color: #6B7280; text-align: center; word-break: break-all;">
      링크가 안 열리면: <a href="${link}" style="color: #0EA5E9;">${link}</a>
    </div>
    <hr style="border: none; border-top: 1px solid #F1F5F9; margin: 20px 0;">
    <div style="font-size: 12px; color: #6B7280;">
      확인 후 문제 없으면 <b>처리완료</b>, 문제 있으면 <b>↩︎ 이 수정만 되돌리기</b> 버튼을 눌러 주세요.
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

  for (const doc of snap.docs) {
    await doc.ref.update(patch);
    console.log(`[ok] synced ${doc.id} → status=${patch.status}`);

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
