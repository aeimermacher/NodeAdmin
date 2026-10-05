import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('update restarts the registered unit only after Git succeeds', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nodeadmin-test-'));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  await fs.writeFile(path.join(directory, 'services.json'), JSON.stringify([
    { name: 'api', workingDirectory: '/apps/api', scope: 'system', unit: 'api.service', managed: false },
    { name: 'worker', workingDirectory: '/apps/worker' },
  ]));
  const calls = [];
  let failure;
  const fakeExec = () => {};
  fakeExec[promisify.custom] = async (command, args) => {
    calls.push({ command, args });
    if (command === 'git' && args[0] === failure) throw new Error('Git failure');
    let stdout = '';
    if (command === 'git') {
      if (args[0] === 'symbolic-ref') stdout = 'main';
      if (args[0] === 'config') stdout = args[2].endsWith('.remote') ? 'origin' : 'refs/heads/main';
      if (args[0] === 'remote') stdout = 'git@github.com:owner/app.git';
    } else if (args.includes('show')) {
      stdout = 'LoadState=loaded\nActiveState=active\nSubState=running\n';
    }
    return { stdout, stderr: '' };
  };
  const originalExec = childProcess.execFile;
  childProcess.execFile = fakeExec;
  syncBuiltinESMExports();
  context.after(async () => {
    childProcess.execFile = originalExec;
    syncBuiltinESMExports();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const services = await import('../src/services.js');

  for (const [name, expected] of [
    ['api', ['--no-ask-password', 'restart', 'api.service']],
    ['worker', ['--user', '--no-ask-password', 'restart', 'nodeadmin-worker.service']],
  ]) {
    calls.length = 0;
    const status = await services.action(name, 'update');
    assert.equal(status.activeState, 'active');
    const restartIndex = calls.findIndex((call) => call.command === 'systemctl' && call.args.includes('restart'));
    assert.deepEqual(calls[restartIndex].args, expected);
    assert.equal(calls[restartIndex - 1].args[0], 'merge');
  }

  for (failure of ['fetch', 'merge-base', 'merge']) {
    calls.length = 0;
    await assert.rejects(services.action('api', 'update'), (error) => error.status === 409);
    assert.ok(calls.every((call) => call.command !== 'systemctl'));
  }

  failure = undefined;
  calls.length = 0;
  const changed = await services.changeRepository('api', { repository: 'https://github.com/owner/new-app.git' });
  assert.equal(changed.repository, 'https://github.com/owner/new-app.git');
  assert.deepEqual(calls.at(-1).args, ['remote', 'set-url', 'origin', 'https://github.com/owner/new-app.git']);
  assert.ok(calls.every((call) => call.command !== 'systemctl'));
  await assert.rejects(services.changeRepository('missing', { repository: changed.repository }),
    (error) => error.status === 404);
});