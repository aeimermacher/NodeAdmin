import * as services from './services.js';
import { mailEnabled, sendMail } from './mailer.js';

const INTERVAL_MS = (Number(process.env.MONITOR_INTERVAL_SECONDS) || 10) * 1000;
const COOLDOWN_MS = (Number(process.env.ALERT_COOLDOWN_MINUTES) || 15) * 60 * 1000;

const state = new Map(); // service name -> { failed, restarts, invocationId, alertedInvocation, lastAlertAt }

async function alert(svc, st, reason) {
  const entry = state.get(svc.name);
  const now = Date.now();
  if (entry.lastAlertAt && now - entry.lastAlertAt < COOLDOWN_MS) {
    console.warn(`Alert for ${svc.name} suppressed (cooldown): ${reason}`);
    return;
  }
  entry.lastAlertAt = now;

  const recentLogs = await services.logs(svc.name, 30).catch((err) => `(could not read logs: ${err.message})`);
  const body = [
    `Service:   ${svc.name}`,
    `Unit:      ${svc.unit} (${svc.scope})`,
    `Reason:    ${reason}`,
    `State:     ${st.activeState} (${st.subState})`,
    `Result:    ${st.result}`,
    `Restarts:  ${st.restarts}`,
    `Time:      ${new Date(now).toISOString()}`,
    '',
    `Further alerts for this service are suppressed for ${COOLDOWN_MS / 60000} minutes.`,
    '',
    'Last log lines:',
    recentLogs,
  ].join('\n');

  try {
    await sendMail(`${svc.name} stopped unexpectedly`, body);
    console.log(`Alert mail sent for ${svc.name}: ${reason}`);
  } catch (err) {
    console.error(`Failed to send alert mail for ${svc.name}:`, err.message);
  }
}

async function check() {
  const list = await services.list();
  for (const svc of list) {
    const st = svc.status;
    if (!st || st.activeState === 'unknown' || st.activeState === 'not-found') continue;

    // A result other than "success" means the process died on its own (crash, signal, timeout...).
    const failed = st.result !== 'success';
    const prev = state.get(svc.name);
    const next = {
      failed,
      restarts: st.restarts,
      invocationId: st.invocationId,
      alertedInvocation: prev?.alertedInvocation,
      lastAlertAt: prev?.lastAlertAt,
    };
    state.set(svc.name, next);
    if (!prev) continue;

    if (failed && !prev.failed) {
      next.alertedInvocation = st.invocationId;
      await alert(svc, st, `exited with result "${st.result}"`);
    } else if (st.restarts > prev.restarts && prev.alertedInvocation !== prev.invocationId) {
      // Crashed and was restarted by systemd between two checks.
      await alert(svc, st, `crashed and was restarted automatically (restart #${st.restarts})`);
    }
  }
  for (const name of state.keys()) {
    if (!list.some((s) => s.name === name)) state.delete(name);
  }
}

export function startMonitor() {
  if (!mailEnabled) {
    console.log('Mail alerts disabled (set SMTP_HOST and ALERT_TO to enable)');
    return;
  }
  console.log(`Mail alerts enabled, checking every ${INTERVAL_MS / 1000}s`);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await check();
    } catch (err) {
      console.error('Monitor check failed:', err.message);
    } finally {
      running = false;
    }
  };
  tick();
  setInterval(tick, INTERVAL_MS).unref();
}
