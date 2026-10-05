const $ = (sel) => document.querySelector(sel);
let refreshTimer = null;
let logsFor = null;
let editingService = null;
const pendingActions = new Map();

async function api(method, url, body) {
  const headers = { 'X-Requested-With': 'NodeAdmin' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401 && url !== '/api/login') {
    showLogin();
    throw new Error('Session expired');
  }
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = res.status === 204 ? null : isJson ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function toast(message, isError = true) {
  const t = $('#toast');
  t.textContent = message;
  t.className = isError ? 'error' : 'ok';
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 5000);
}

function showLogin() {
  clearInterval(refreshTimer);
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
}

function showApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  refresh();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, 5000);
}

function stateClass(state) {
  if (state === 'active') return 'ok';
  if (state === 'failed') return 'bad';
  if (state === 'activating' || state === 'deactivating' || state === 'reloading') return 'warn';
  return 'off';
}

async function doAction(name, action) {
  if (pendingActions.has(name)) return;
  if (action === 'update' && !confirm(`Pull the upstream GitHub branch and restart "${name}"?`)) return;
  pendingActions.set(name, action);
  refresh();
  try {
    const status = await api('POST', `/api/services/${encodeURIComponent(name)}/${action}`, {});
    if (action === 'update' && status.activeState !== 'active') {
      toast(`${name}: source updated and restart requested; service is ${status.activeState}. Check logs.`);
    } else {
      toast(`${name}: ${action === 'update' ? 'pulled and restarted' : `${action} OK`}`, false);
    }
  } catch (err) {
    toast(`${name}: ${err.message}`);
  } finally {
    pendingActions.delete(name);
    refresh();
  }
}

async function removeService(svc) {
  const question = svc.managed
    ? `Remove service "${svc.name}"? It will be stopped and its unit file deleted.`
    : `Remove "${svc.name}" from the panel? The unit ${svc.unit} itself is left untouched.`;
  if (!confirm(question)) return;
  const name = svc.name;
  try {
    await api('DELETE', `/api/services/${encodeURIComponent(name)}`);
    toast(`${name} removed`, false);
  } catch (err) {
    toast(err.message);
  }
  refresh();
}

function renderRow(svc) {
  const st = svc.status || {};
  const active = st.activeState === 'active';
  const pending = pendingActions.get(svc.name);
  const btn = (label, onclick, disabled = false, className = '') =>
    el('button', { textContent: label, onclick, disabled: disabled || Boolean(pending), className });

  return el(
    'tr',
    {},
    el(
      'td',
      {},
      el('strong', { textContent: svc.name }),
      svc.managed ? '' : el('span', { className: 'tag', textContent: svc.scope, title: svc.unit }),
      el('div', { className: 'muted', textContent: svc.description }),
      svc.workingDirectory
        ? el('a', {
            href: '#',
            className: 'readme-link',
            textContent: 'README',
            onclick: (e) => {
              e.preventDefault();
              openReadme(svc.name);
            },
          })
        : '',
    ),
    el('td', {}, el('span', {
      className: `badge ${pending ? 'warn' : stateClass(st.activeState)}`,
      textContent: pending ? (pending === 'update' ? 'Pulling & restarting...' : `${pending}...`)
        : st.subState ? `${st.activeState} (${st.subState})` : st.activeState,
      title: st.error || '',
    })),
    el('td', { textContent: st.pid ?? '' }),
    el('td', { textContent: active && st.since ? st.since : '' }),
    el('td', {}, btn(st.enabled ? 'On' : 'Off', () => doAction(svc.name, st.enabled ? 'disable' : 'enable'))),
    el('td', {
      className: 'mono',
      textContent: svc.managed ? [svc.script, ...svc.args].join(' ') : svc.command,
      title: svc.workingDirectory,
    }),
    el(
      'td',
      { className: 'row-actions' },
      btn('Start', () => doAction(svc.name, 'start'), active),
      btn('Stop', () => doAction(svc.name, 'stop'), !active),
      btn('Restart', () => doAction(svc.name, 'restart')),
      btn('Pull & restart', () => doAction(svc.name, 'update'), !svc.workingDirectory),
      btn('Edit', () => openEdit(svc.name), !svc.workingDirectory),
      btn('Logs', () => openLogs(svc.name)),
      btn(svc.managed ? 'Remove' : 'Unregister', () => removeService(svc), false, 'danger'),
    ),
  );
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const list = await api('GET', '/api/services');
    $('#services').replaceChildren(...list.map(renderRow));
    $('#empty').hidden = list.length > 0;
  } catch (err) {
    toast(err.message);
  } finally {
    refreshing = false;
  }
}

async function loadLogs() {
  $('#logs').textContent = 'Loading...';
  try {
    $('#logs').textContent = (await api('GET', `/api/services/${encodeURIComponent(logsFor)}/logs?lines=300`)) || '(no output)';
    $('#logs').scrollTop = $('#logs').scrollHeight;
  } catch (err) {
    $('#logs').textContent = err.message;
  }
}

function openLogs(name) {
  logsFor = name;
  $('#logs-title').textContent = `Logs: ${name}`;
  $('#logs-dialog').showModal();
  loadLogs();
}

async function openReadme(name) {
  $('#readme-title').textContent = `README: ${name}`;
  $('#readme-file').textContent = '';
  $('#readme').textContent = 'Loading...';
  $('#readme-dialog').showModal();
  try {
    const { file, html } = await api('GET', `/api/services/${encodeURIComponent(name)}/readme`);
    $('#readme-file').textContent = file;
    // Server renders with raw HTML disabled, so this is escaped markup only.
    $('#readme').innerHTML = html || '<p>(empty)</p>';
  } catch (err) {
    $('#readme').textContent = err.message;
  }
}

async function openEdit(name) {
  const editing = { name };
  editingService = editing;
  const form = $('#edit-form');
  form.reset();
  $('#edit-title').textContent = `Edit service: ${name}`;
  $('#edit-remote').textContent = 'Loading repository...';
  $('#edit-error').hidden = true;
  form.repository.disabled = true;
  $('#edit-save').disabled = true;
  $('#edit-dialog').showModal();
  try {
    const data = await api('GET', `/api/services/${encodeURIComponent(name)}/repository`);
    if (editingService !== editing) return;
    form.repository.value = data.repository;
    $('#edit-remote').textContent = `Remote: ${data.remote}`;
  } catch (err) {
    if (editingService !== editing) return;
    $('#edit-remote').textContent = '';
    $('#edit-error').textContent = err.message;
    $('#edit-error').hidden = false;
  } finally {
    if (editingService === editing) {
      form.repository.disabled = false;
      $('#edit-save').disabled = false;
      form.repository.focus();
    }
  }
}

$('#edit-cancel').addEventListener('click', () => $('#edit-dialog').close());
$('#edit-dialog').addEventListener('close', () => { editingService = null; });
$('#edit-dialog').addEventListener('cancel', (event) => {
  if (editingService && pendingActions.has(editingService.name)) event.preventDefault();
});
$('#edit-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const editing = editingService;
  if (!editing || pendingActions.has(editing.name)) return;
  const form = event.target;
  const repository = form.repository.value.trim();
  pendingActions.set(editing.name, 'edit');
  form.repository.disabled = true;
  $('#edit-save').disabled = true;
  $('#edit-cancel').disabled = true;
  $('#edit-error').hidden = true;
  refresh();
  try {
    await api('PATCH', `/api/services/${encodeURIComponent(editing.name)}`, { repository });
    $('#edit-dialog').close();
    toast(`${editing.name}: repository saved`, false);
  } catch (err) {
    $('#edit-error').textContent = err.message;
    $('#edit-error').hidden = false;
  } finally {
    pendingActions.delete(editing.name);
    form.repository.disabled = false;
    $('#edit-save').disabled = false;
    $('#edit-cancel').disabled = false;
    refresh();
  }
});

function parseEnv(text) {
  const env = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) throw new Error(`Invalid environment line: ${line}`);
    env[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return env;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    await api('POST', '/api/login', { password: form.password.value });
    form.reset();
    showApp();
  } catch (err) {
    toast(err.message);
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/logout', {}).catch(() => {});
  showLogin();
});

$('#add-btn').addEventListener('click', () => $('#add-dialog').showModal());
$('#add-cancel').addEventListener('click', () => $('#add-dialog').close());

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('POST', '/api/services', {
      name: f.name.value.trim(),
      description: f.description.value.trim(),
      workingDirectory: f.workingDirectory.value.trim(),
      script: f.script.value.trim(),
      args: f.args.value.match(/\S+/g) || [],
      env: parseEnv(f.env.value),
      autostart: f.autostart.checked,
      start: f.start.checked,
    });
    toast(`${f.name.value} created`, false);
    f.reset();
    $('#add-dialog').close();
    refresh();
  } catch (err) {
    toast(err.message);
  }
});

async function loadUnitOptions() {
  const scope = $('#import-form').scope.value;
  try {
    const units = await api('GET', `/api/units?scope=${scope}`);
    $('#unit-options').replaceChildren(...units.map((u) => el('option', { value: u })));
  } catch (err) {
    toast(err.message);
  }
}

$('#import-btn').addEventListener('click', () => {
  $('#import-dialog').showModal();
  loadUnitOptions();
});
$('#import-form').scope.addEventListener('change', loadUnitOptions);
$('#import-cancel').addEventListener('click', () => $('#import-dialog').close());

$('#import-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const svc = await api('POST', '/api/services/import', {
      scope: f.scope.value,
      unit: f.unit.value.trim(),
      name: f.name.value.trim(),
    });
    toast(`${svc.unit} imported as ${svc.name}`, false);
    f.reset();
    $('#import-dialog').close();
    refresh();
  } catch (err) {
    toast(err.message);
  }
});

$('#logs-refresh').addEventListener('click', loadLogs);
$('#logs-close').addEventListener('click', () => $('#logs-dialog').close());
$('#readme-close').addEventListener('click', () => $('#readme-dialog').close());

api('GET', '/api/me')
  .then((me) => (me.authenticated ? showApp() : showLogin()))
  .catch(showLogin);
