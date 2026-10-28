# claude-mods

Mods and agents for Claude Code on my servers, driven from my phone through Remote Control.

## server-dashboard

A pane beside the chat that shows, refreshed every 30 seconds:

- Host, uptime, CPU load, memory and disk, with bars that turn yellow at 75% and red at 90%
- The app's current git commit and whether it has uncommitted changes
- Whether the app is up, from its health check URL
- The last deploys and rollbacks

It adds the **Deploy**, **Rollback** and **Refresh** buttons and these slash commands:

| Command | What it does |
| --- | --- |
| `/server` | Open the dashboard pane |
| `/deploy` | git pull, install/build if needed, restart, verify, report. Asks before anything risky. |
| `/rollback` | Go back to the commit before the last deploy. Asks you to confirm first. |
| `/health` | One-line health summary |

It also blocks dangerous commands outright: `rm -rf /`, reboot/shutdown, `mkfs`, `dd` to a disk, `git push --force`, `DROP TABLE`, and AWS delete/terminate commands.

### Install (on each server)

```bash
claude plugin install server-dashboard --marketplace HyperInt1825/claude-mods
```

Or at the Claude Code prompt:

```
/plugin install server-dashboard --marketplace HyperInt1825/claude-mods
```

Answer `y` to add the marketplace, pick the **user** scope, then fill in the settings (all optional):

- **App folder**: e.g. `/var/www/myapp`
- **Restart command**: e.g. `sudo systemctl restart myapp`, `docker compose up -d --build`, `pm2 restart myapp`
- **Health check URL**: e.g. `http://localhost:3000/health`

Change them later with `/config`. Restart `claude remote-control` after installing so new sessions pick it up.

### Update

```bash
claude plugin update server-dashboard
```
