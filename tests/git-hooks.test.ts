import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Milestone 2: Git Hooks and Automation Verification', () => {
  let tempRepoDir: string;
  const projectHooksDir = path.resolve('.githooks');

  beforeAll(() => {
    tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-hooks-test-'));
    // Initialize temporary disposable repository
    execSync('git init', { cwd: tempRepoDir });
    execSync('git config user.name "Test Runner"', { cwd: tempRepoDir });
    execSync('git config user.email "test@runner.local"', { cwd: tempRepoDir });
    execSync('git branch -M main', { cwd: tempRepoDir });

    // Copy .githooks into temporary repository
    const targetHooks = path.join(tempRepoDir, '.githooks');
    fs.mkdirSync(targetHooks, { recursive: true });
    for (const f of fs.readdirSync(projectHooksDir)) {
      const src = path.join(projectHooksDir, f);
      const dst = path.join(targetHooks, f);
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, 0o755);
    }
    execSync('git config --local core.hooksPath .githooks', { cwd: tempRepoDir });
  });

  afterAll(() => {
    if (tempRepoDir && fs.existsSync(tempRepoDir)) {
      fs.rmSync(tempRepoDir, { recursive: true, force: true });
    }
  });

  it('1. pre-commit blocks staged conflict markers while leaving index unchanged', () => {
    // Create a file with conflict marker
    const badFile = path.join(tempRepoDir, 'bad-file.txt');
    fs.writeFileSync(badFile, 'line 1\n<<<<<<< HEAD\nconflict\n=======\nresolution\n>>>>>>> branch\n');
    execSync('git add bad-file.txt', { cwd: tempRepoDir });

    // Attempt commit - should fail due to pre-commit hook
    const commitRes = spawnSync('git', ['commit', '-m', 'bad commit'], {
      cwd: tempRepoDir,
      encoding: 'utf8',
    });

    expect(commitRes.status).not.toBe(0);
    expect(commitRes.stdout + commitRes.stderr).toContain('conflict marker');

    // Index is unchanged: bad-file.txt is still staged
    const status = execSync('git status --porcelain', { cwd: tempRepoDir, encoding: 'utf8' });
    expect(status).toContain('A  bad-file.txt');

    // Clean up
    execSync('git rm -f bad-file.txt', { cwd: tempRepoDir });
  });

  it('2. unstaged fix does not hide staged failure', () => {
    const file = path.join(tempRepoDir, 'partial.txt');
    // 1. Write conflict marker and stage it
    fs.writeFileSync(file, '<<<<<<< HEAD\nconflict\n');
    execSync('git add partial.txt', { cwd: tempRepoDir });

    // 2. Overwrite in working tree with clean content WITHOUT staging
    fs.writeFileSync(file, 'clean content without conflict\n');

    // Attempt commit: pre-commit must check staged version and fail!
    const commitRes = spawnSync('git', ['commit', '-m', 'should fail on staged'], {
      cwd: tempRepoDir,
      encoding: 'utf8',
    });

    expect(commitRes.status).not.toBe(0);
    expect(commitRes.stdout + commitRes.stderr).toContain('conflict marker');

    // Clean up
    execSync('git rm -f partial.txt', { cwd: tempRepoDir });
  });

  it('3. pre-push detects delete-only refs and exits cleanly without running tests', () => {
    const prePushScript = path.join(tempRepoDir, '.githooks', 'pre-push');
    // Simulate git passing delete ref to pre-push stdin:
    // refs/heads/feature-branch 0000000000000000000000000000000000000000 refs/heads/feature-branch 1234567890123456789012345678901234567890
    const deleteStdin = 'refs/heads/feature-branch 0000000000000000000000000000000000000000 refs/heads/feature-branch 1234567890123456789012345678901234567890\n';

    const res = spawnSync(prePushScript, [], {
      cwd: tempRepoDir,
      input: deleteStdin,
      encoding: 'utf8',
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Delete-only push detected');
  });

  it('4. doctor verification reports healthy repository status', () => {
    const doctorRes = spawnSync('node', ['scripts/doctor.mjs'], {
      encoding: 'utf8',
    });
    expect(doctorRes.status).toBe(0);
    expect(doctorRes.stdout).toContain('All environment and repository checks passed!');
  });
});
