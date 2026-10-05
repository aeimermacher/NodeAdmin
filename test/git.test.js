import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pullCheckout, readRepository, setRepository } from '../src/git.js';

function checkout({ dirty = '', url = 'https://github.com/owner/app.git', failure, remote = 'origin', remotes = ['origin'] } = {}) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes(failure)) throw new Error('secret remote output');
    let stdout = '';
    if (args[0] === 'status') stdout = dirty;
    if (args[0] === 'symbolic-ref') stdout = 'main';
    if (args[0] === 'config') stdout = args[2].endsWith('.remote') ? remote : 'refs/heads/main';
    if (args[0] === 'remote') stdout = args.length === 1 ? remotes.join('\n') : url;
    return { stdout };
  };
  return { calls, run };
}

test('fetches the configured upstream and fast-forwards before returning', async () => {
  const { calls, run } = checkout();
  await pullCheckout('/apps/api', { run, token: '' });
  assert.deepEqual(calls.slice(-3).map((call) => call.args), [
    ['fetch', '--no-tags', 'origin', 'refs/heads/main'],
    ['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD'],
    ['merge', '--ff-only', '--no-overwrite-ignore', 'FETCH_HEAD'],
  ]);
  assert.ok(calls.every((call) => call.options.cwd === '/apps/api' && call.options.timeout === 120000));
});

test('private HTTPS credentials are scoped to fetch and never command arguments', async () => {
  const { calls, run } = checkout();
  await pullCheckout('/apps/api', { run, token: 'test-secret' });
  const fetch = calls.find((call) => call.args.includes('fetch'));
  assert.equal(fetch.options.env.GITHUB_TOKEN, 'test-secret');
  assert.ok(fetch.args.includes('credential.helper='));
  assert.ok(calls.every((call) => !call.args.join(' ').includes('test-secret')));
  assert.ok(calls.filter((call) => call !== fetch).every((call) => !call.options.env.GITHUB_TOKEN));
});

test('SSH uses noninteractive deploy key authentication', async () => {
  const { calls, run } = checkout({ url: 'git@github.com:owner/private.git' });
  await pullCheckout('/apps/api', { run, token: 'test-secret' });
  const fetch = calls.find((call) => call.args.includes('fetch'));
  assert.equal(fetch.options.env.GIT_SSH_COMMAND, 'ssh -o BatchMode=yes');
  assert.equal(fetch.options.env.GITHUB_TOKEN, undefined);
});

test('dirty checkouts fail without fetching', async () => {
  const { calls, run } = checkout({ dirty: '?? local.txt' });
  await assert.rejects(pullCheckout('/apps/api', { run }), /local changes/);
  assert.equal(calls.length, 2);
});

test('rejects credential-bearing and non-GitHub remotes', async () => {
  for (const url of ['https://token@github.com/owner/app.git', 'https://example.com/owner/app.git', 'file:///tmp/repo']) {
    const { calls, run } = checkout({ url });
    await assert.rejects(pullCheckout('/apps/api', { run }), /GitHub HTTPS or SSH/);
    assert.ok(!calls.some((call) => call.args.includes('fetch')));
  }
});

test('fetch failure and divergent history prevent merging and do not expose remote output', async () => {
  for (const failure of ['fetch', 'merge-base']) {
    const { calls, run } = checkout({ failure });
    await assert.rejects(pullCheckout('/apps/api', { run }), (error) => error.status === 409 && !error.message.includes('secret'));
    assert.ok(!calls.some((call) => call.args[0] === 'merge'));
  }
});

test('credential helper returns credentials only for GitHub HTTPS get requests', () => {
  const helper = fileURLToPath(new URL('../scripts/git-credential.js', import.meta.url));
  for (const [action, protocol, host, expected] of [
    ['get', 'https', 'github.com', 'username=x-access-token\npassword=test-secret\n\n'],
    ['get', 'https', 'example.com', ''],
    ['get', 'http', 'github.com', ''],
    ['store', 'https', 'github.com', ''],
    ['erase', 'https', 'github.com', ''],
  ]) {
    const result = spawnSync(process.execPath, [helper, action], {
      input: `protocol=${protocol}\nhost=${host}\n\n`, encoding: 'utf8',
      env: { ...process.env, GITHUB_TOKEN: 'test-secret' },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, expected);
  }
});

test('reads the current upstream repository', async () => {
  const { run } = checkout();
  assert.deepEqual(await readRepository('/apps/api', { run }), {
    remote: 'origin', repository: 'https://github.com/owner/app.git',
  });
});

test('changes the upstream remote without fetching, merging or switching branches', async () => {
  const { calls, run } = checkout();
  const result = await setRepository('/apps/api', ' git@github.com:owner/new-app.git ', { run });
  assert.deepEqual(result, { remote: 'origin', repository: 'git@github.com:owner/new-app.git' });
  assert.deepEqual(calls.at(-1).args, ['remote', 'set-url', 'origin', 'git@github.com:owner/new-app.git']);
  assert.ok(!calls.some((call) => call.args.includes('fetch') || call.args[0] === 'merge'));
});

test('invalid repository changes do not run Git', async () => {
  for (const url of ['', null, 'https://secret@github.com/owner/app.git', 'file:///tmp/repo', '--upload-pack=command']) {
    const { calls, run } = checkout();
    await assert.rejects(setRepository('/apps/api', url, { run }), (error) => error.status === 400);
    assert.equal(calls.length, 0);
  }
});

test('remote configuration failures are returned without leaking Git output', async () => {
  const { run } = checkout({ failure: 'set-url' });
  await assert.rejects(setRepository('/apps/api', 'https://github.com/owner/new-app.git', { run }),
    (error) => error.status === 409 && !error.message.includes('secret'));
});

test('detached HEAD can read and change origin without switching branches', async () => {
  const { calls, run } = checkout({ failure: 'symbolic-ref', remotes: ['backup', 'origin'] });
  assert.equal((await readRepository('/apps/api', { run })).remote, 'origin');
  const result = await setRepository('/apps/api', 'https://github.com/owner/new-app.git', { run });
  assert.equal(result.remote, 'origin');
  assert.deepEqual(calls.at(-1).args, ['remote', 'set-url', 'origin', 'https://github.com/owner/new-app.git']);
  assert.ok(!calls.some((call) => ['checkout', 'switch', 'fetch', 'merge'].includes(call.args[0])));
});

test('repository editing uses the single remote when origin and branch tracking are absent', async () => {
  for (const options of [
    { failure: 'symbolic-ref', remotes: ['github'] },
    { remote: '', remotes: ['github'] },
  ]) {
    const { calls, run } = checkout(options);
    assert.equal((await setRepository('/apps/api', 'https://github.com/owner/new-app.git', { run })).remote, 'github');
    assert.equal(calls.at(-1).args[2], 'github');
  }
});

test('repository editing follows the configured remote without requiring an upstream branch', async () => {
  const { calls, run } = checkout({ remote: 'github', failure: 'branch.main.merge' });
  assert.equal((await readRepository('/apps/api', { run })).remote, 'github');
  assert.ok(!calls.some((call) => call.args.includes('branch.main.merge')));
});

test('ambiguous or missing remotes do not change repository configuration', async () => {
  for (const remotes of [[], ['backup', 'github']]) {
    const { calls, run } = checkout({ failure: 'symbolic-ref', remotes });
    await assert.rejects(setRepository('/apps/api', 'https://github.com/owner/new-app.git', { run }),
      (error) => error.status === 409 && /Git remote/.test(error.message));
    assert.ok(!calls.some((call) => call.args.includes('set-url')));
  }
});

test('pulling still rejects detached HEAD before fetching', async () => {
  const { calls, run } = checkout({ failure: 'symbolic-ref' });
  await assert.rejects(pullCheckout('/apps/api', { run }), /Detached HEAD/);
  assert.ok(!calls.some((call) => call.args.includes('fetch')));
});

test('checkout diagnostics distinguish metadata, ownership and permission failures without exposing stderr', async () => {
  for (const [stderr, status, message] of [
    ['fatal: not a git repository; secret', 400, /not a Git checkout/],
    ['fatal: detected dubious ownership in repository; secret', 403, /safe.directory/],
    ['fatal: Permission denied; secret', 403, /lacks permission/],
  ]) {
    const run = async () => { throw Object.assign(new Error('secret'), { stderr }); };
    await assert.rejects(readRepository('/apps/api', { run }),
      (error) => error.status === status && message.test(error.message) && !error.message.includes('secret'));
  }
});

test('missing Git executable and missing working directory have different diagnostics', async () => {
  const run = async () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }); };
  const existingDirectory = fileURLToPath(new URL('../', import.meta.url));
  await assert.rejects(readRepository(existingDirectory, { run }),
    (error) => error.status === 503 && /process PATH/.test(error.message));
  const missingDirectory = fileURLToPath(new URL('../test/nonexistent-checkout/', import.meta.url));
  await assert.rejects(readRepository(missingDirectory, { run }),
    (error) => error.status === 400 && /does not exist/.test(error.message));
});