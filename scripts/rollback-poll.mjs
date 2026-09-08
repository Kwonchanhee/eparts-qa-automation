// GitHub Actions workflow_dispatch (데몬 트리거) 또는 5분 cron으로 실행.
// qa_reports에서 rollbackRequestedAt이 있고 rolledBackAt이 없는 QA를 처리:
//   1) commits[]를 repo별로 그룹핑
//   2) 각 repo를 clone → 각 커밋을 git revert → main push + main→production merge push
//   3) 성공 시 Firestore: status='rolled_back', rolledBackAt, rollbackCommits, deployedToProd=false
//
// prod-deploy-poll.mjs와 동일한 clone/push 패턴 사용.

import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PROJECT_ID = 'e-parts-a2f29';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(' ')} ${cwd ? '(in ' + cwd + ')' : ''}`);
  return execFileSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf-8' });
}

function tryRun(cmd, args, cwd) {
  try {
    return { ok: true, out: run(cmd, args, cwd) };
  } catch (err) {
    return { ok: false, out: err.stdout?.toString() ?? '', err: err.stderr?.toString() ?? err.message };
  }
}

async function main() {
  const serviceAccountJson = JSON.parse(requireEnv('FIREBASE_SERVICE_ACCOUNT_JSON'));
  const gitToken = requireEnv('CLAUDE_ISSUE_PAT');

  initializeApp({ credential: cert(serviceAccountJson), projectId: PROJECT_ID });
  const db = getFirestore();

  // rollbackRequestedAt 있고 rolledBackAt 없는 QA 조회
  const snap = await db
    .collection('qa_reports')
    .where('rollbackRequestedAt', '!=', null)
    .get();

  const pending = snap.docs.filter((d) => !d.data().rolledBackAt);
  console.log(`>>> pending rollback requests: ${pending.length}`);

  if (pending.length === 0) {
    console.log('nothing to do');
    return;
  }

  for (const doc of pending) {
    const data = doc.data();
    const qaId = doc.id;
    const commits = (data.commits ?? []).filter((c) => c?.sha && c?.repo);
    if (commits.length === 0) {
      console.log(`[skip] ${qaId} (${data.title}) — 롤백할 commits 없음`);
      await doc.ref.update({
        rolledBackAt: FieldValue.serverTimestamp(),
        'claudeSession.lastLog': '⚠️ 롤백 요청했으나 커밋 정보가 없어서 자동 처리 불가. 수동 확인 필요.',
        updatedAt: FieldValue.serverTimestamp(),
      });
      continue;
    }

    console.log(`>>> Rollback ${qaId} (${data.title}) — ${commits.length} commit(s)`);

    // repo별로 그룹핑
    const byRepo = new Map();
    for (const c of commits) {
      if (!byRepo.has(c.repo)) byRepo.set(c.repo, []);
      byRepo.get(c.repo).push(c);
    }

    const tmpBase = mkdtempSync(path.join(tmpdir(), 'rollback-'));
    const revertResults = [];
    const rollbackRecords = [];

    for (const [repo, repoCommits] of byRepo) {
      console.log(`\n[repo] ${repo} — ${repoCommits.length} commit(s) to revert`);
      const cloneDir = path.join(tmpBase, repo.replace(/[^A-Za-z0-9_-]/g, '_'));
      const cloneUrl = `https://x-access-token:${gitToken}@github.com/${repo}.git`;

      // 1) clone main
      const cloneRes = tryRun('git', ['clone', '--branch', 'main', cloneUrl, cloneDir]);
      if (!cloneRes.ok) {
        console.error(`  ✗ clone 실패: ${cloneRes.err.slice(0, 200)}`);
        revertResults.push({ repo, ok: false, err: 'clone 실패' });
        continue;
      }
      run('git', ['config', 'user.email', 'qa-automation@eparts.biz'], cloneDir);
      run('git', ['config', 'user.name', 'E-Parts QA Automation'], cloneDir);

      // 2) 각 커밋 revert (역순, 나중 커밋부터 되돌리는 게 conflict 확률 낮음)
      let allReverted = true;
      const localReverts = [];
      const orderedCommits = [...repoCommits].reverse();
      for (const c of orderedCommits) {
        console.log(`  → git revert ${c.sha.slice(0, 7)}`);
        const rev = tryRun('git', ['revert', '--no-edit', c.sha], cloneDir);
        if (!rev.ok) {
          console.error(`    ✗ revert 실패: ${rev.err.slice(0, 300)}`);
          tryRun('git', ['revert', '--abort'], cloneDir);
          allReverted = false;
          break;
        }
        const newSha = run('git', ['rev-parse', 'HEAD'], cloneDir).trim();
        localReverts.push({
          repo,
          sha: newSha.slice(0, 12),
          message: `Revert ${c.sha.slice(0, 7)} — ${c.message ?? ''}`,
          url: `https://github.com/${repo}/commit/${newSha}`,
          createdAt: Timestamp.now(),
        });
      }

      if (!allReverted) {
        revertResults.push({ repo, ok: false, err: '커밋 revert 실패' });
        continue;
      }

      // 3) main push
      const mainPush = tryRun('git', ['push', 'origin', 'main'], cloneDir);
      if (!mainPush.ok) {
        console.error(`  ✗ main push 실패: ${mainPush.err.slice(0, 300)}`);
        revertResults.push({ repo, ok: false, err: 'main push 실패' });
        continue;
      }

      // 4) main → production merge + push
      run('git', ['fetch', 'origin', 'production'], cloneDir);
      run('git', ['checkout', 'production'], cloneDir);
      const merge = tryRun('git', ['merge', '--no-edit', 'origin/main'], cloneDir);
      if (!merge.ok) {
        console.error(`  ⚠︎ production merge 실패 (main만 반영됨): ${merge.err.slice(0, 300)}`);
        // main만 push된 상태로 성공 처리 (production은 관리자가 별도 조치)
        revertResults.push({ repo, ok: true, mainOnly: true, count: localReverts.length });
        rollbackRecords.push(...localReverts);
        continue;
      }
      const prodPush = tryRun('git', ['push', 'origin', 'production'], cloneDir);
      if (!prodPush.ok) {
        console.error(`  ⚠︎ production push 실패: ${prodPush.err.slice(0, 300)}`);
        revertResults.push({ repo, ok: true, mainOnly: true, count: localReverts.length });
        rollbackRecords.push(...localReverts);
        continue;
      }
      console.log(`  ✓ ${localReverts.length}건 revert + main + production 반영`);
      revertResults.push({ repo, ok: true, count: localReverts.length });
      rollbackRecords.push(...localReverts);
    }

    // Firestore 마킹
    const allOk = revertResults.every((r) => r.ok);
    const summary = revertResults
      .map((r) => `${r.repo.split('/')[1]}: ${r.ok ? `✓ ${r.count}건${r.mainOnly ? ' (main만)' : ''}` : `✗ ${r.err}`}`)
      .join('\n');

    if (rollbackRecords.length > 0) {
      await doc.ref.update({
        status: 'rolled_back',
        deployedToProd: false,
        deployedToProdAt: null,
        rolledBackAt: FieldValue.serverTimestamp(),
        rollbackCommits: FieldValue.arrayUnion(...rollbackRecords),
        'claudeSession.lastLog': `↩︎ 자동 롤백 완료.\n${summary}`,
        updatedAt: FieldValue.serverTimestamp(),
      });
      console.log(`✓ ${qaId} → rolled_back (${rollbackRecords.length} revert 커밋)`);
    } else {
      await doc.ref.update({
        'claudeSession.lastLog': `⚠️ 롤백 실패 (모든 repo에서 revert 불가).\n${summary}\n수동 조치 필요.`,
        updatedAt: FieldValue.serverTimestamp(),
      });
      console.log(`✗ ${qaId} rollback fully failed`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
