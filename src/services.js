import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import MarkdownIt from 'markdown-it';
import { pullCheckout, readRepository, setRepository } from './git.js';

const run = promisify(execFile);

const UNIT_PREFIX = 'nodeadmin-';
const UNIT_DIR = path.join(os.homedir(), '.config', 'systemd', 'user');
const DATA_FILE = path.resolve(process.env.DATA_DIR || 'data', 'services.json');
const NODE_BIN = process.env.NODE_BIN || process.execPath;

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9:_.@-]*\.service$/;
const ACTIONS = new Set(['start', 'stop', 'restart', 'enable', 'disable', 'update']);

// systemctl --user needs the user's runtime dir to reach the user manager.
const childEnv = {
  ...process.env,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.()}`,
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const unitName = (name) => `${UNIT_PREFIX}${name}.service`;
const unitPath = (name) => path.join(UNIT_DIR, unitName(name));

const normalizeScope = (scope) => (scope === 'system' ? 'system' : 'user');
const scopeArgs = (scope) => (scope === 'system' ? [] : ['--user']);

async function systemctl(scope, ...args) {
  try {
    return await run('systemctl', [...scopeArgs(scope), '--no-ask-password', ...args], {
      env: childEnv,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    const msg = (err.stderr || err.message).trim();
    if (/Failed to connect to (?:user scope )?bus|No such file or directory/i.test(msg)) {
      throw new HttpError(
        503,
        `${msg}. The systemd user manager is unavailable. On the server, run ` +
          '`sudo loginctl enable-linger aryan && sudo systemctl start user@$(id -u aryan).service`, ' +
          'then verify with `sudo -u aryan XDG_RUNTIME_DIR=/run/user/$(id -u aryan) systemctl --user status`. ' +
          'Replace aryan with the Linux account running NodeAdmin, then retry.',
      );
    }
    if (/Interactive authentication required|Access denied/i.test(msg)) {
      throw new HttpError(403, `${msg} Grant access with a polkit rule (see README).`);
    }
    throw new HttpError(500, msg);
  }
}

async function showProps(scope, unit, props) {
  const { stdout } = await systemctl(scope, 'show', unit, `--property=${props.join(',')}`);
  return Object.fromEntries(
    stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const i = line.indexOf('=');
        return [line.slice(0, i), line.slice(i + 1)];
      }),
  );
}

// Entries created before import support have no scope/unit/managed fields.
const withDefaults = (svc) => ({ scope: 'user', unit: unitName(svc.name), managed: true, ...svc });

let lock = Promise.resolve();
function exclusive(fn) {
  const result = lock.then(fn);
  lock = result.catch(() => {});
  return result;
}

async function load() {
  try {
    return JSON.parse(await fs.readFile(DATA_FILE, 'utf8')).map(withDefaults);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function save(list) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
  await fs.rename(tmp, DATA_FILE);
}

async function findOrThrow(name) {
  const svc = (await load()).find((s) => s.name === name);
  if (!svc) throw new HttpError(404, 'Service not found');
  return svc;
}

function validate(input) {
  const str = (v) => String(v ?? '').trim();
  const name = str(input.name);
  const description = str(input.description);
  const workingDirectory = str(input.workingDirectory);
  const script = str(input.script);
  const args = Array.isArray(input.args) ? input.args.map(String) : [];
  const env = {};

  if (!NAME_RE.test(name)) {
    throw new HttpError(400, 'Name must be lowercase letters, digits and dashes (max 63 characters)');
  }
  if (!path.posix.isAbsolute(workingDirectory)) {
    throw new HttpError(400, 'Working directory must be an absolute path');
  }
  if (!script) throw new HttpError(400, 'Script is required');

  if (input.env && typeof input.env === 'object') {
    for (const [key, value] of Object.entries(input.env)) {
      if (!ENV_KEY_RE.test(key)) throw new HttpError(400, `Invalid environment variable name: ${key}`);
      env[key] = String(value);
    }
  }

  for (const v of [description, workingDirectory, script, ...args, ...Object.values(env)]) {
    if (/[\0\r\n]/.test(v)) throw new HttpError(400, 'Values must not contain line breaks');
  }

  return { name, description, workingDirectory, script, args, env };
}

// Escaping for systemd unit files: % starts a specifier, $ expands variables in ExecStart.
const escSpecifiers = (s) => s.replace(/%/g, '%%');
const quote = (s) => `"${escSpecifiers(s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'))}"`;
const execArg = (s) => quote(s).replace(/\$/g, '$$$$');

function renderUnit(svc) {
  const execStart = [NODE_BIN, svc.script, ...svc.args].map(execArg).join(' ');
  const envLines = Object.entries(svc.env).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`);
  return [
    '[Unit]',
    `Description=${escSpecifiers(svc.description || svc.name)}`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${escSpecifiers(svc.workingDirectory)}`,
    `ExecStart=${execStart}`,
    ...envLines,
    'Restart=on-failure',
    'RestartSec=3',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

async function status(svc) {
  try {
    const props = await showProps(svc.scope, svc.unit, [
      'LoadState',
      'ActiveState',
      'SubState',
      'MainPID',
      'ActiveEnterTimestamp',
      'UnitFileState',
      'Result',
      'NRestarts',
      'InvocationID',
    ]);
    if (props.LoadState === 'not-found') return { activeState: 'not-found' };
    return {
      activeState: props.ActiveState,
      subState: props.SubState,
      pid: Number(props.MainPID) || null,
      since: props.ActiveEnterTimestamp || null,
      enabled: props.UnitFileState === 'enabled',
      result: props.Result,
      restarts: Number(props.NRestarts) || 0,
      invocationId: props.InvocationID,
    };
  } catch (err) {
    return { activeState: 'unknown', error: err.message };
  }
}

export async function list() {
  const services = await load();
  return Promise.all(services.map(async (svc) => ({ ...svc, status: await status(svc) })));
}

export function create(input) {
  return exclusive(async () => {
    const svc = validate(input);
    const services = await load();
    if (services.some((s) => s.name === svc.name)) {
      throw new HttpError(409, 'A service with this name already exists');
    }
    const stat = await fs.stat(svc.workingDirectory).catch(() => null);
    if (!stat?.isDirectory()) throw new HttpError(400, 'Working directory does not exist');

    await fs.mkdir(UNIT_DIR, { recursive: true });
    await fs.writeFile(unitPath(svc.name), renderUnit(svc), { mode: 0o600 });
    await systemctl('user', 'daemon-reload');
    const entry = withDefaults(svc);
    services.push(entry);
    await save(services);

    if (input.autostart) await systemctl('user', 'enable', entry.unit);
    if (input.start) await systemctl('user', 'start', entry.unit);
    return entry;
  });
}

function defaultName(unit) {
  const base = unit
    .slice(0, -'.service'.length)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return base || 'service';
}

export function importUnit(input) {
  return exclusive(async () => {
    const scope = normalizeScope(input.scope);
    let unit = String(input.unit ?? '').trim();
    if (!unit.endsWith('.service')) unit += '.service';
    if (!UNIT_RE.test(unit) || unit.endsWith('@.service')) {
      throw new HttpError(400, 'Invalid unit name');
    }
    const name = String(input.name ?? '').trim() || defaultName(unit);
    if (!NAME_RE.test(name)) {
      throw new HttpError(400, 'Name must be lowercase letters, digits and dashes (max 63 characters)');
    }

    const services = await load();
    if (services.some((s) => s.name === name)) {
      throw new HttpError(409, 'A service with this name already exists');
    }
    if (services.some((s) => s.scope === scope && s.unit === unit)) {
      throw new HttpError(409, 'This unit is already in the panel');
    }

    const props = await showProps(scope, unit, ['LoadState', 'Description', 'ExecStart', 'WorkingDirectory']);
    if (props.LoadState !== 'loaded') throw new HttpError(404, `No ${scope} unit named ${unit}`);

    const svc = {
      name,
      description: props.Description || '',
      scope,
      unit,
      managed: false,
      workingDirectory: props.WorkingDirectory || '',
      command: /argv\[\]=(.*?) ;/.exec(props.ExecStart)?.[1] ?? '',
    };
    services.push(svc);
    await save(services);
    return svc;
  });
}

export async function listUnits(scope) {
  scope = normalizeScope(scope);
  const { stdout } = await systemctl(scope, 'list-unit-files', '--type=service', '--no-legend', '--plain');
  const registered = new Set((await load()).filter((s) => s.scope === scope).map((s) => s.unit));
  return stdout
    .split('\n')
    .map((line) => line.split(/\s+/)[0])
    .filter(
      (u) =>
        UNIT_RE.test(u) && !u.endsWith('@.service') && !u.startsWith(UNIT_PREFIX) && !registered.has(u),
    );
}

export function remove(name) {
  return exclusive(async () => {
    const svc = await findOrThrow(name);
    // Imported units are only unregistered; their unit files belong to someone else.
    if (svc.managed) {
      await systemctl('user', 'disable', '--now', svc.unit).catch(() => {});
      await fs.rm(unitPath(name), { force: true });
      await systemctl('user', 'daemon-reload');
    }
    await save((await load()).filter((s) => s.name !== name));
  });
}

export function action(name, act) {
  return exclusive(async () => {
    if (!ACTIONS.has(act)) throw new HttpError(400, 'Unknown action');
    const svc = await findOrThrow(name);
    if (act === 'update') await pullCheckout(svc.workingDirectory);
    await systemctl(svc.scope, act === 'update' ? 'restart' : act, svc.unit);
    return status(svc);
  });
}

export async function repository(name) {
  const svc = await findOrThrow(name);
  return readRepository(svc.workingDirectory);
}

export function changeRepository(name, input) {
  return exclusive(async () => {
    const svc = await findOrThrow(name);
    return setRepository(svc.workingDirectory, input.repository);
  });
}

export async function logs(name, lines = 200) {
  const svc = await findOrThrow(name);
  const n = Math.min(Math.max(Number.parseInt(lines, 10) || 200, 1), 2000);
  try {
    const { stdout } = await run(
      'journalctl',
      [...scopeArgs(svc.scope), '-u', svc.unit, '-n', String(n), '--no-pager', '-o', 'short-iso'],
      { env: childEnv, maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout;
  } catch (err) {
    throw new HttpError(500, (err.stderr || err.message).trim());
  }
}

const README_RE = /^readme(\.md|\.markdown|\.txt)?$/i;
const README_MAX_BYTES = 1024 * 1024;

// html: false escapes raw HTML in READMEs, and markdown-it rejects javascript: links, so output is safe to insert.
const markdown = new MarkdownIt({ html: false, linkify: true });
markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener noreferrer');
  return self.renderToken(tokens, idx, options);
};

export async function readme(name) {
  const svc = await findOrThrow(name);
  if (!svc.workingDirectory) throw new HttpError(404, 'This service has no working directory');
  const entries = await fs.readdir(svc.workingDirectory, { withFileTypes: true }).catch(() => []);
  const file = entries
    .filter((e) => e.isFile() && README_RE.test(e.name))
    .sort((a, b) => /\.md$/i.test(b.name) - /\.md$/i.test(a.name))[0];
  if (!file) throw new HttpError(404, `No README found in ${svc.workingDirectory}`);

  const filePath = path.join(svc.workingDirectory, file.name);
  const { size } = await fs.stat(filePath);
  if (size > README_MAX_BYTES) throw new HttpError(413, 'README is too large to display');
  const content = await fs.readFile(filePath, 'utf8');
  const html = /\.txt$/i.test(file.name)
    ? `<pre>${markdown.utils.escapeHtml(content)}</pre>`
    : markdown.render(content);
  return { file: filePath, html };
}
