// GitHub Actions cron으로 5분마다 실행.
// prod_deploy_requests 컬렉션의 pending 요청을 처리:
// 지정된 qa_report의 commits[]를 각 웹 레포의 production 브랜치로 cherry-pick + push
// 성공 시 qa_report.deployedToProd = true

import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PROJECT_ID = "e-parts-a2f29";

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
        validReports.push({ id, data: rd });
        for (const c of rd.commits ?? []) {
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
          results.push({ repo, ok: false, err: "clone failed: " + clone.err });
          continue;
        }
        run("git", ["config", "user.email", "qa-automation@eparts.biz"], repoDir);
        run("git", ["config", "user.name", "E-Parts QA Automation"], repoDir);
        run("git", ["fetch", "origin", "main"], repoDir);

        const cherryFailed = [];
        for (const c of commits) {
          console.log(`  → cherry-pick ${c.sha.slice(0, 7)}`);
          const cp = tryRun("git", ["cherry-pick", "-x", c.sha], repoDir);
          if (!cp.ok) {
            console.log(`    ✗ conflict/error: ${cp.err.split("\n")[0]}`);
            tryRun("git", ["cherry-pick", "--abort"], repoDir);
            cherryFailed.push({ sha: c.sha, reportId: c.reportId, err: cp.err.split("\n")[0] });
          }
        }

        if (cherryFailed.length > 0) {
          results.push({ repo, ok: false, err: `${cherryFailed.length} cherry-pick 실패`, failed: cherryFailed });
          continue;
        }

        const push = tryRun("git", ["push", "origin", "production"], repoDir);
        if (!push.ok) {
          results.push({ repo, ok: false, err: "push failed: " + push.err.split("\n").slice(-3).join(" ") });
          continue;
        }
        results.push({ repo, ok: true, commitCount: commits.length });
      }

      const allOk = results.every((r) => r.ok);
      const summary = results.map((r) => `${r.repo.split("/")[1]}: ${r.ok ? "✓ " + r.commitCount + "건" : "✗ " + r.err}`).join("\n");

      if (allOk) {
        for (const r of validReports) {
          await db.collection("qa_reports").doc(r.id).update({
            deployedToProd: true,
            deployedToProdAt: FieldValue.serverTimestamp(),
            "claudeSession.lastLog": "프로덕션 배포 요청됨. production 브랜치 push 완료.",
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        await reqDoc.ref.update({
          status: "done",
          completedAt: FieldValue.serverTimestamp(),
          lastLog: summary,
        });
        console.log(`\n✓ Request ${reqDoc.id} DONE`);
      } else {
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
