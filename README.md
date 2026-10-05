# NodeAdmin

Web UI to start, stop, restart, add and remove Node.js programs on an Ubuntu server.
Each program is registered as a **systemd user service** (`nodeadmin-<name>.service`), so
processes keep running independently of NodeAdmin, restart on failure, and can start on boot.
Logs are read from the journal.

## Install (Ubuntu 26.04)

Run NodeAdmin as the Linux user that owns your Node.js apps (managed services run as that user).

```bash
sudo apt install nodejs npm git
# Keep this user's services running without an active login session, and start them on boot
sudo loginctl enable-linger "$USER"
sudo systemctl start "user@$(id -u).service"

git clone <repo> ~/nodeadmin && cd ~/nodeadmin
npm ci --omit=dev

npm run hash-password            # copy the printed line
cp .env.example .env && chmod 600 .env
nano .env                        # paste ADMIN_PASSWORD_HASH=...

mkdir -p ~/.config/systemd/user
cp deploy/nodeadmin.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now nodeadmin
```

The `loginctl` and `systemctl start user@...` commands above ensure the user manager and its
`/run/user/<uid>/bus` socket exist, even before the user logs in. If starting NodeAdmin under a
different account, run them for that account. To check the manager, use
`sudo -u <user> XDG_RUNTIME_DIR=/run/user/<uid> systemctl --user status`.

## Access

NodeAdmin listens on `127.0.0.1:3000` by default. Either:

- use an SSH tunnel: `ssh -L 3000:127.0.0.1:3000 user@server`, then open http://localhost:3000, or
- put it behind a TLS reverse proxy (nginx/Caddy) and set `COOKIE_SECURE=true` and `TRUST_PROXY=loopback`.

Do not expose it over plain HTTP on a public interface: it can run arbitrary programs as its user.

## Adding a service

- **Working directory**: absolute path of the app, e.g. `/home/app/my-api`
- **Script**: entry file relative to it, e.g. `server.js` (or `dist/index.js`)
- **Arguments**: space-separated
- **Environment**: `KEY=value` per line

## Pulling updates from GitHub

Use **Pull & restart** on a service to fetch its current branch's configured upstream,
fast-forward the existing checkout, then restart its systemd unit. This works for managed
and imported services with a working directory. The NodeAdmin Linux user needs write access
to the checkout and permission to restart the unit. Clone the repository on the server first;
this action does not clone repositories or switch branches.

Use **Edit** on an existing service to view or change its GitHub repository URL.
Saving updates the current branch's configured remote in the checkout's Git configuration.
If HEAD is detached or the branch has no remote, the editor uses `origin`, or the only
configured remote when `origin` is absent. Ambiguous remote choices are rejected.
Editing does not switch branches, pull code or restart the service. It also affects other services using that
same checkout. Both HTTPS and SSH URLs are supported; do not include tokens in the URL.
Use **Pull & restart** separately to deploy from the new remote; this still requires an
attached branch with a configured upstream. The branch name stays
unchanged and the new repository must have compatible history for a fast-forward update;
switching to an unrelated repository requires a separately prepared checkout.

Configure the checkout's upstream once, for example:

```bash
cd /home/app/my-api
git remote set-url origin https://github.com/OWNER/REPO.git
git branch --set-upstream-to=origin/main main
```

- **Public repos**: GitHub HTTPS URLs work without credentials.
- **Private repos via HTTPS**: set `GITHUB_TOKEN` in NodeAdmin's `.env`, then restart
  NodeAdmin. Use a fine-grained GitHub token restricted to the required repositories with
  **Contents: Read-only** permission (and organization approval where required). The token
  is passed only to the fetch process and its credential helper, not stored in service
  definitions, Git remotes or command arguments. Keep `.env` mode `600` and serve the panel
  over HTTPS or an SSH tunnel. Existing Git credential helpers also work when no token is set.
- **Private repos via SSH**: use `git@github.com:OWNER/REPO.git` or
  `ssh://git@github.com/OWNER/REPO.git` and configure a read-only GitHub deploy key for the
  NodeAdmin Linux user. Verify GitHub's host key and configure `known_hosts` beforehand.
  Keys must work non-interactively, including inside NodeAdmin's systemd environment;
  passphrase-protected keys require an available SSH agent. SSH authentication never uses
  `GITHUB_TOKEN`.

Local changes (including untracked files), detached HEAD, missing upstreams, local commits
ahead of upstream, and divergent history block the update. Ignored files such as `.env`
are left untouched. Fetch/fast-forward failures do not trigger a restart. Updates and other
service mutations are serialized. Each Git command has a two-minute timeout.

This updates source only: dependency installation, migrations and build steps are not run.
Prepare those separately when required. A restart failure leaves the new source in place;
there is no automatic rollback. Check service logs after deployment.

## Mail alerts

When `SMTP_HOST` and `ALERT_TO` are set in `.env`, NodeAdmin checks all services every 10 seconds
and mails you (with the last log lines) when one crashes or exits with an error, including crashes
that systemd restarted automatically. Stopping a service normally does not trigger an alert.
Alerts per service are limited to one per 15 minutes. Verify your settings with `npm run test-mail`.

## Importing existing services

Use **Import existing** to add a systemd service that already exists. Imported units are never
modified; **Unregister** only removes them from the panel.

- **User units** (`systemctl --user` of the NodeAdmin user) work without extra setup.
- **System units** (`/etc/systemd/system`) need root to control. Allow the NodeAdmin user to
  start/stop/restart specific units with a polkit rule, e.g. `/etc/polkit-1/rules.d/50-nodeadmin.rules`:

  ```js
  polkit.addRule(function (action, subject) {
    var units = ["my-api.service", "worker.service"];
    if (action.id == "org.freedesktop.systemd1.manage-units" &&
        subject.user == "aryan" &&
        units.indexOf(action.lookup("unit")) >= 0 &&
        ["start", "stop", "restart"].indexOf(action.lookup("verb")) >= 0) {
      return polkit.Result.YES;
    }
  });
  ```

  The autostart toggle (enable/disable) for system units is not covered by this rule; use
  `sudo systemctl enable|disable <unit>` for that.

  To read their logs, add the user to the journal group and restart its user manager:

  ```bash
  sudo usermod -aG systemd-journal aryan
  sudo systemctl restart user@$(id -u aryan)
  ```
