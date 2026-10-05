import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

const exec = promisify(execFile);
const credentialHelper = fileURLToPath(new URL('../scripts/git-credential.js', import.meta.url));

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function gitRunner(workingDirectory, run) {
  if (!workingDirectory) fail(400, 'This service has no working directory');
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
  delete env.GITHUB_TOKEN;
  const git = async (args, message, options = {}) => {
    try {
      const { stdout } = await run('git', args, {
        cwd: workingDirectory, env, timeout: 120000, maxBuffer: 1024 * 1024, ...options,
      });
      return stdout.trim();
    } catch (error) {
      if (error.code === 'ENOENT') {
        const directory = await fs.stat(workingDirectory).catch(() => null);
        if (!directory?.isDirectory()) fail(400, `Working directory does not exist or is inaccessible: ${workingDirectory}`);
        fail(503, 'Git executable was not found in the NodeAdmin process PATH');
      }
      const stderr = String(error.stderr || '');
      if (/detected dubious ownership/i.test(stderr)) {
        fail(403, `Git detected dubious ownership in ${workingDirectory}. Verify its owner, then configure safe.directory for this exact path as the account running NodeAdmin`);
      }
      if (/not a git repository/i.test(stderr)) {
        fail(400, `Working directory is not a Git checkout: ${workingDirectory}. It must contain Git metadata, not just downloaded source files`);
      }
      if (error.code === 'EACCES' || /permission denied|operation not permitted/i.test(stderr)) {
        fail(403, `The NodeAdmin account lacks permission to access Git or the checkout at ${workingDirectory}`);
      }
      fail(409, message);
    }
  };
  return { git, env };
}

async function upstream(git) {
  const branch = await git(['symbolic-ref', '--short', 'HEAD'], 'Detached HEAD; switch to a branch with an upstream first');
  const remote = await git(['config', '--get', `branch.${branch}.remote`], 'Current branch has no upstream remote');
  const ref = await git(['config', '--get', `branch.${branch}.merge`], 'Current branch has no upstream branch');
  if (!remote || remote.startsWith('-') || !ref.startsWith('refs/heads/')) {
    fail(400, 'Current branch must track a remote branch');
  }
  return { remote, ref };
}

function validateRepository(value) {
  const url = typeof value === 'string' ? value.trim() : '';
  const https = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url);
  const ssh = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url);
  if (!https && !ssh) fail(400, 'Repository must use a GitHub HTTPS or SSH URL without embedded credentials');
  return { url, https };
}

async function repositoryRemote(git) {
  await git(['rev-parse', '--show-toplevel'], 'Working directory is not a Git checkout, or Git is unavailable');
  const branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], 'Cannot read the current branch').catch(() => '');
  if (branch) {
    const remote = await git(['config', '--get', `branch.${branch}.remote`], 'Cannot read the upstream remote').catch(() => '');
    if (remote && remote !== '.') {
      if (remote.startsWith('-')) fail(400, 'Invalid upstream remote');
      return remote;
    }
  }
  const remotes = (await git(['remote'], 'Cannot list Git remotes')).split(/\r?\n/).filter(Boolean);
  if (remotes.includes('origin')) return 'origin';
  if (remotes.length === 1 && !remotes[0].startsWith('-')) return remotes[0];
  fail(409, remotes.length ? 'Multiple Git remotes; configure a branch upstream or an origin remote first' : 'No Git remote configured');
}

export async function readRepository(workingDirectory, { run = exec } = {}) {
  const { git } = gitRunner(workingDirectory, run);
  const remote = await repositoryRemote(git);
  const url = await git(['remote', 'get-url', remote], 'Cannot read the upstream remote URL');
  return { remote, repository: validateRepository(url).url };
}

export async function setRepository(workingDirectory, repository, { run = exec } = {}) {
  const { url } = validateRepository(repository);
  const { git } = gitRunner(workingDirectory, run);
  const remote = await repositoryRemote(git);
  await git(['remote', 'set-url', remote, url], 'Cannot change the Git remote URL; check checkout permissions');
  return { remote, repository: url };
}

export async function pullCheckout(workingDirectory, { run = exec, token = process.env.GITHUB_TOKEN } = {}) {
  const { git, env } = gitRunner(workingDirectory, run);
  await git(['rev-parse', '--show-toplevel'], 'Working directory is not a Git checkout, or Git is unavailable');
  const changes = await git(['status', '--porcelain'], 'Cannot check the Git working tree');
  if (changes) fail(409, 'Git checkout has local changes or untracked files; commit, stash or remove them first');
  const { remote, ref } = await upstream(git);
  const url = await git(['remote', 'get-url', remote], 'Cannot read the upstream remote URL');
  const { https } = validateRepository(url);

  const authArgs = [];
  const fetchEnv = { ...env };
  if (https && token) {
    const shellQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
    authArgs.push('-c', 'credential.helper=', '-c', `credential.helper=!${shellQuote(process.execPath)} ${shellQuote(credentialHelper)}`);
    fetchEnv.GITHUB_TOKEN = token;
  }
  await git([...authArgs, 'fetch', '--no-tags', remote, ref],
    'Git fetch failed. Check network access and GitHub credentials (SSH deploy key or GITHUB_TOKEN)', { env: fetchEnv });
  await git(['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD'],
    'Local history is ahead of or diverges from upstream; reconcile it before updating');
  await git(['merge', '--ff-only', '--no-overwrite-ignore', 'FETCH_HEAD'], 'Git fast-forward failed; service was not restarted');
}