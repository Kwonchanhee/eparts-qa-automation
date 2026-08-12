// GitHub Actions cron 및 데몬 workflow_dispatch로 실행.
// prod_deploy_requests의 pending 요청을 처리:
//   1) 각 web repo에 지정된 QA의 commits[]를 production 브랜치로 cherry-pick
//   2) 실패 시 main→production merge fallback (C안)
//   3) push 성공 시에만 qa_report.deployedToProd = true (A안 — 옵티미스틱 제거)
//   4) 배포 완료 이메일 발송 (B안)

import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import nodemailer from "nodemailer";

const PROJECT_ID = "e-parts-a2f29";
const NOTIFY_EMAILS = ["byungwook5958@gmail.com", "chkwon147@naver.com"];
const ADMIN_WEB_URL = "https://e-parts-a2f29.web.app";
const DEV_URLS = {
  user: "https://dev.e-parts.biz",
  seller: "https://dev-seller.e-parts.biz",
  master: "https://dev-master.e-parts.biz",
};
const PROD_URLS = {
  user: "https://e-parts.biz",
  seller: "https://seller.e-parts.biz",
  master: "https://master.e-parts.biz",
};

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(" ")} ${cwd ? "(in " + cwd + ")" : ""}`);
  return execFileSync(cmd, args, { cwd, stdio: "pipe", encoding: "utf-8" });
}

function tryRun(cmd, args, cwd) {
  try {
    return { ok: true, out: run(cmd, args, cwd) };
  } catch (err) {
    return { ok: false, out: err.stdout?.toString() ?? "", err: err.stderr?.toString() ?? err.message };
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function sendDeployEmail(reports) {
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailPass) {
    console.log("[email] GMAIL_USER/GMAIL_APP_PASSWORD 미설정 — 프로덕 배포 이메일 스킵");
    return;
  }
  const subject = `[E-Parts] 프로덕션 배포 완료 (${reports.length}건)`;
  const rows = reports
    .map((r) => {
      const prodUrl = PROD_URLS[r.source] ?? PROD_URLS.user;
      const qaUrl = `${ADMIN_WEB_URL}/report/?id=${encodeURIComponent(r.id)}`;
      return `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #F1F5F9;">${escapeHtml(r.source)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #F1F5F9;">${escapeHtml(r.title)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #F1F5F9;"><a href="${prodUrl}" style="color:#0EA5E9">${prodUrl}</a></td>
        <td style="padding:6px 8px;border-bottom:1px solid #F1F5F9;"><a href="${qaUrl}" style="color:#0EA5E9">상세</a></td>
      </tr>`;
    })
    .join("");
  const text = `프로덕션 배포 완료 (${reports.length}건)\n\n` +
    reports.map((r) => `- [${r.source}] ${r.title} → ${PROD_URLS[r.source] ?? PROD_URLS.user}`).join("\n");
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111;max-width:640px;margin:0 auto;padding:20px;">
    <div style="background:#059669;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0;font-weight:700;font-size:18px;">
      🚀 프로덕션 배포 완료 (${reports.length}건)
    </div>
    <div style="border:1px solid #E5E7EB;border-top:0;border-radius:0 0 10px 10px;padding:20px;">
      <p style="margin:0 0 12px 0;">아래 QA 이슈가 프로덕션에 배포됐습니다.</p>
      <table style="border-collapse:collapse;width:100%;font-size:13px;">
        <thead><tr style="background:#F9FAFB;">
          <th style="text-align:left;padding:8px;border-bottom:1px solid #E5E7EB;">웹</th>
          <th style="text-align:left;padding:8px;border-bottom:1px solid #E5E7EB;">제목</th>
          <th style="text-align:left;padding:8px;border-bottom:1px solid #E5E7EB;">프로덕션</th>
          <th style="text-align:left;padding:8px;border-bottom:1px solid #E5E7EB;">QA</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:16px;font-size:12px;color:#6B7280;">
        QA 관리: <a href="${ADMIN_WEB_URL}" style="color:#0EA5E9">${ADMIN_WEB_URL}</a>
      </p>
    </div>
  </body></html>`;
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: gmailUser, pass: gmailPass },
  });
  await transporter.sendMail({
    from: `E-Parts QA <${gmailUser}>`,
    to: NOTIFY_EMAILS.join(", "),
    subject,
    text,
    html,
  });
  console.log(`[email] 프로덕 배포 완료 이메일 발송: ${NOTIFY_EMAILS.join(", ")}`);
}

async function main() {
  const serviceAccountJson = JSON.parse(requireEnv("FIREBASE_SERVICE_ACCOUNT_JSON"));
  const gitToken = requireEnv("CLAUDE_ISSUE_PAT");

  initializeApp({ credential: cert(serviceAccountJson), projectId: PROJECT_ID });
  const db = getFirestore();

  const reqSnap = await db
    .collection("prod_deploy_requests")
    .where("status", "==", "pending")
    .get();

  if (reqSnap.empty) {
    console.log("No pending prod deploy requests.");
    return;
  }

  for (const reqDoc of reqSnap.docs) {
    const req = reqDoc.data();
    const reportIds = req.reportIds ?? [];
    console.log(`\n>>> Processing request ${reqDoc.id} with ${reportIds.length} reports`);

    await reqDoc.ref.update({
      status: "running",
      lastLog: "cherry-pick 시작",
      startedAt: FieldValue.serverTimestamp(),
    });

    try {
      const commitsByRepo = new Map();
      const validReports = [];
      for (const id of reportIds) {
        const r = await db.collection("qa_reports").doc(id).get();
        if (!r.exists) continue;
        const rd = r.data();
        // 커밋 없는 QA는 배포 대상 아님 (프론트에서 필터로 걸러야 함, 안전장치)
        if ((rd.commits ?? []).length === 0) {
          console.log(`  skip ${id} (커밋 없음 — 배포 대상 아님)`);
          continue;
        }
        validReports.push({ id, data: rd });
        for (const c of rd.commits) {
          if (!commitsByRepo.has(c.repo)) commitsByRepo.set(c.repo, []);
          commitsByRepo.get(c.repo).push({ sha: c.sha, message: c.message, reportId: id });
        }
      }

      const tmpBase = mkdtempSync(path.join(tmpdir(), "prod-deploy-"));
      const results = [];

      for (const [repo, commits] of commitsByRepo.entries()) {
        console.log(`\n[repo] ${repo} — ${commits.length} commits`);
        const repoDir = path.join(tmpBase, repo.replace(/[^\w]/g, "_"));

        const cloneUrl = "https://x-access-token:" + gitToken + "@github.com/" + repo + ".git";
        const clone = tryRun("git", ["clone", "--branch", "production", cloneUrl, repoDir]);
        if (!clone.ok) {
          results.push({ repo, ok: false, method: "clone", err: "clone failed: " + clone.err });
          continue;
        }
        run("git", ["config", "user.email", "qa-automation@eparts.biz"], repoDir);
        run("git", ["config", "user.name", "E-Parts QA Automation"], repoDir);
        run("git", ["fetch", "origin", "main"], repoDir);

        // === 1차: cherry-pick 시도 ===
        const cherryFailed = [];
        for (const c of commits) {
          console.log(`  → cherry-pick ${c.sha.slice(0, 7)}`);
          const cp = tryRun("git", ["cherry-pick", "-x", "--allow-empty", c.sha], repoDir);
          if (!cp.ok) {
            const firstLine = cp.err.split("\n")[0];
            // 이미 반영된 커밋 (nothing to commit) 은 skip으로 처리
            if (cp.err.includes("nothing to commit") || cp.err.includes("previous cherry-pick is now empty")) {
              console.log(`    ↷ 이미 반영됨 — skip`);
              tryRun("git", ["cherry-pick", "--skip"], repoDir);
            } else {
              console.log(`    ✗ conflict/error: ${firstLine}`);
              tryRun("git", ["cherry-pick", "--abort"], repoDir);
              cherryFailed.push({ sha: c.sha, reportId: c.reportId, err: firstLine });
            }
          }
        }

        let method = "cherry-pick";

        // === 2차: cherry-pick 실패 시 main → production merge fallback (C안) ===
        if (cherryFailed.length > 0) {
          console.log(`  ⚠︎ cherry-pick 실패 ${cherryFailed.length}건 → main 병합 fallback 시도`);
          const merge = tryRun("git", ["merge", "origin/main", "--no-edit"], repoDir);
          if (!merge.ok) {
            tryRun("git", ["merge", "--abort"], repoDir);
            results.push({
              repo,
              ok: false,
              method: "merge-fallback",
              err: `cherry-pick + merge 둘 다 실패. cherry-pick 실패=${cherryFailed.length}건, merge 실패=${merge.err.split("\n")[0]}`,
            });
            continue;
          }
          method = "merge-fallback";
          console.log(`    ✓ main 병합 성공`);
        }

        // === push ===
        const push = tryRun("git", ["push", "origin", "production"], repoDir);
        if (!push.ok) {
          results.push({ repo, ok: false, method, err: "push failed: " + push.err.split("\n").slice(-3).join(" ") });
          continue;
        }
        results.push({ repo, ok: true, method, commitCount: commits.length });
      }

      const allOk = results.length > 0 && results.every((r) => r.ok);
      const summary = results
        .map((r) => {
          const short = r.repo.split("/")[1];
          if (r.ok) return `${short}: ✓ ${r.commitCount}건 (${r.method})`;
          return `${short}: ✗ ${r.err}`;
        })
        .join("\n");

      if (allOk) {
        // === A안: push 성공 후에만 dep=true 마킹 ===
        const emailReports = [];
        for (const r of validReports) {
          await db.collection("qa_reports").doc(r.id).update({
            deployedToProd: true,
            deployedToProdAt: FieldValue.serverTimestamp(),
            "claudeSession.lastLog": `프로덕션 배포 완료 (${summary}).`,
            updatedAt: FieldValue.serverTimestamp(),
          });
          emailReports.push({ id: r.id, title: r.data.title, source: r.data.source });
        }
        await reqDoc.ref.update({
          status: "done",
          completedAt: FieldValue.serverTimestamp(),
          lastLog: summary,
        });
        console.log(`\n✓ Request ${reqDoc.id} DONE`);

        // === B안: 프로덕션 배포 완료 이메일 ===
        try {
          await sendDeployEmail(emailReports);
        } catch (err) {
          console.error("[email] 프로덕 배포 이메일 실패:", err.message);
        }
      } else {
        // 실패 시 dep=false 유지 (원래 false였으니 그대로), 요청만 failed 마킹
        await reqDoc.ref.update({
          status: "failed",
          completedAt: FieldValue.serverTimestamp(),
          lastLog: summary,
        });
        console.log(`\n✗ Request ${reqDoc.id} FAILED\n${summary}`);
      }
    } catch (err) {
      console.error("Fatal:", err);
      await reqDoc.ref.update({
        status: "failed",
        lastLog: "치명적 오류: " + err.message,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
