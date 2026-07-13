# Deploying r6checker.xyz to an UpCloud VPS

This guide walks you through deploying the entire stack — Node app, Cloudflare
Tunnel, multi-IP rotation, and the captcha solver — on a fresh UpCloud VPS.

## 0. What you need before starting

- UpCloud account with billing set up
- Cloudflare account with `r6checker.xyz` already configured (you have this)
- Your existing `.env` file from local development
- Capsolver API key (sign up at https://www.capsolver.com, fund $5 minimum, copy the API key from your dashboard)

## 1. Spin up the VPS

In the UpCloud control panel → **Deploy** → **Cloud Servers**:

| Setting | Recommended |
|---|---|
| **Plan** | $5/month "1xCPU, 1GB RAM, 25GB SSD" works fine for ~50 users/day. Bump to $20/month "2xCPU, 4GB RAM" if you expect heavy traffic. |
| **Location** | Pick one close to your Ubisoft account's region. US East (NYC) or EU West (Amsterdam) are safe defaults. |
| **OS** | **Ubuntu 24.04 LTS** (or 22.04 if you prefer) |
| **SSH key** | Add your public key (don't use password auth) |
| **Firewall** | Enable; allow only ports 22 (SSH) and outbound. We do NOT need 80/443 inbound — Cloudflare Tunnel handles that. |

### Add multiple IPs (for free IP rotation)

On the server creation page, scroll down to **Network**. UpCloud lets you assign
multiple **public IPv4 addresses** to one server. Add 3–5 extras (~$1/month each).
You'll get them like:

```
83.136.250.10  (primary)
83.136.250.42
83.136.250.43
83.136.250.44
```

These are what `LOCAL_IP_POOL` uses for outbound rotation — no proxy needed.

Click **Deploy**.

## 2. Initial server setup

SSH in:
```bash
ssh root@<your-server-ip>
```

Update + create a non-root user (security hygiene):
```bash
apt update && apt upgrade -y
adduser r6  --gecos "" --disabled-password
usermod -aG sudo r6
mkdir -p /home/<deploy-user>/.ssh && cp ~/.ssh/authorized_keys /home/<deploy-user>/.ssh/
chown -R <deploy-user>:<deploy-user> /home/<deploy-user>/.ssh && chmod 700 /home/<deploy-user>/.ssh && chmod 600 /home/<deploy-user>/.ssh/authorized_keys
```

Then `exit` and `ssh r6@<your-server-ip>` for the rest.

Install Node.js 20 + git + build tools (needed for `node-gyp`):
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git build-essential
node --version  # should print v20.x.x
```

Install Playwright system dependencies (Camoufox is a Playwright Firefox build):
```bash
sudo npx --yes playwright install-deps firefox
```

## 3. Assign the extra IPs to the network interface

UpCloud assigns the extra IPs to your account but you still need to bind them
to the interface on the server. List your current IPs:
```bash
ip -4 addr show
```

You'll see your primary IP listed. For each extra IP from your UpCloud panel:
```bash
sudo ip addr add 83.136.250.42/32 dev eth0
sudo ip addr add 83.136.250.43/32 dev eth0
sudo ip addr add 83.136.250.44/32 dev eth0
```

Make them persist across reboots — add to `/etc/netplan/50-cloud-init.yaml`
inside the `eth0` block:
```yaml
network:
  version: 2
  ethernets:
    eth0:
      addresses:
        - 83.136.250.10/24    # your primary (probably already there)
        - 83.136.250.42/32
        - 83.136.250.43/32
        - 83.136.250.44/32
      # ... existing gateway/dns config stays
```

Apply: `sudo netplan apply`. Verify: `ip -4 addr show eth0` lists all of them.

## 4. Clone the repo + install dependencies

```bash
cd ~
git clone https://github.com/ePhishing/r6-locker.git r6checker
cd r6checker
npm ci --omit=dev
npx playwright install firefox
```

## 5. Create the `.env` file

```bash
nano .env
```

Paste this template — fill in YOUR values where shown:
```bash
# Public site
SITE_URL=https://r6checker.xyz
PORT=3000
NODE_ENV=production

# Discord OAuth (from discord.com/developers/applications)
DISCORD_CLIENT_ID=1508320258929459331
DISCORD_CLIENT_SECRET=<your discord secret>
DISCORD_REDIRECT_URI=https://r6checker.xyz/auth/discord/callback

# Random 64-hex-char string: openssl rand -hex 32
COOKIE_SECRET=<paste 64 hex chars here>

# Browser (Camoufox)
HEADLESS=true
MAX_BROWSERS=10

# ── ROTATION: pick ONE of the next two blocks ─────────────────────
# OPTION A: use DataImpulse rotating residential proxy (fresh IP per request)
USE_PROXY=true
PROXY_PROTOCOL=http
PROXY_HOST=gw.dataimpulse.com
PROXY_PORT=823
PROXY_USER=<your dataimpulse user>
PROXY_PASS=<your dataimpulse pass>
PROXY_INSECURE=false

# OPTION B: use your VPS's local IPs (free, faster — recommended if you have them)
# USE_PROXY=false
# LOCAL_IP_POOL=83.136.250.10,83.136.250.42,83.136.250.43,83.136.250.44
# LOCAL_IP_STRATEGY=round-robin
# ─────────────────────────────────────────────────────────────────

# DataDome solver — Capsolver primary, 2captcha fallback
CAPSOLVER_API_KEY=<your capsolver key>
CAPTCHA_API_KEY=c531467dcbe6289afa7003e488b5470a

HIDE_FROM_RECENT=
```

Save with `Ctrl-O Enter Ctrl-X`. Lock down permissions:
```bash
chmod 600 .env
```

## 6. Run the app as a systemd service

Create `/etc/systemd/system/r6checker.service`:
```bash
sudo tee /etc/systemd/system/r6checker.service > /dev/null <<'EOF'
[Unit]
Description=R6Checker.xyz app server
After=network.target

[Service]
Type=simple
User=r6
WorkingDirectory=/home/<deploy-user>/r6checker
EnvironmentFile=/home/<deploy-user>/r6checker/.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
StandardOutput=append:/home/<deploy-user>/r6checker/.cache/server.log
StandardError=append:/home/<deploy-user>/r6checker/.cache/server.log

[Install]
WantedBy=multi-user.target
EOF

mkdir -p /home/<deploy-user>/r6checker/.cache
sudo systemctl daemon-reload
sudo systemctl enable --now r6checker
```

Verify it's up:
```bash
sudo systemctl status r6checker
curl http://localhost:3000/health
```

Health response should include `rotation.localIP.poolSize: 4` (or whatever
your pool size is) if you went with OPTION B.

## 7. Install + configure Cloudflare Tunnel

```bash
# install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /tmp/cloudflared
sudo install /tmp/cloudflared /usr/local/bin/cloudflared

# log in (opens a URL — paste into your browser, select r6checker.xyz)
cloudflared tunnel login
```

Use your EXISTING tunnel (the one already serving r6checker.xyz). Don't
create a new one — that would break DNS. Find the tunnel ID:
```bash
cloudflared tunnel list
```

Copy the credentials file from your old machine:
```bash
# On your local machine:
scp ~/.cloudflared/<tunnel-id>.json r6@<your-server-ip>:~/.cloudflared/
```

Create `~/.cloudflared/config.yml`:
```yaml
tunnel: <your-tunnel-id>
credentials-file: /home/<deploy-user>/.cloudflared/<your-tunnel-id>.json
ingress:
  - hostname: r6checker.xyz
    service: http://localhost:3000
  - hostname: www.r6checker.xyz
    service: http://localhost:3000
  - service: http_status:404
```

Run it as a service:
```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

## 8. Verify everything end-to-end

```bash
# 1. health endpoint on the server itself
curl http://localhost:3000/health

# 2. health endpoint through Cloudflare (proves the tunnel works)
curl https://r6checker.xyz/health

# 3. test page diagnostic — check rotation is active
# Visit https://r6checker.xyz/test in your browser
```

If `/health` shows `rotation.localIP.poolSize` > 0, your local IPs are
loaded. If `USE_PROXY: true`, the DataImpulse proxy is configured.

Visit `https://r6checker.xyz/test`, leave the default URL, click Send.
Refresh a few times — the **Outbound IP** value should rotate through your
VPS IPs (or proxy IPs).

## 9. Open `/login` and complete the first sign-in

Open `https://r6checker.xyz/login` from your home browser. With Capsolver
+ local IP rotation in place, the bare login should work without showing the
iframe fallback. If DataDome still blocks the first attempt, the server's
captcha solver will fire automatically (~10-30s) and retry.

Check `/admin/sessions` after success: `"hasRememberMeTicket": true` means
the next 30 days of re-auths happen with zero DataDome challenges.

## 10. Updates + logs

```bash
# logs
tail -f ~/r6checker/.cache/server.log
sudo journalctl -u cloudflared -f

# pull updates from GitHub
cd ~/r6checker
git pull
npm ci --omit=dev
sudo systemctl restart r6checker

# restart just the tunnel
sudo systemctl restart cloudflared
```

## 11. Hardening checklist

- [ ] `ufw` enabled with only port 22 inbound: `sudo ufw allow 22 && sudo ufw enable`
- [ ] `fail2ban` installed: `sudo apt install fail2ban -y`
- [ ] Automatic security updates: `sudo apt install unattended-upgrades -y`
- [ ] SSH password auth disabled in `/etc/ssh/sshd_config`: `PasswordAuthentication no`
- [ ] `.env` permissions 600 — only `r6` user can read

## Cost summary

| Item | Monthly |
|---|---|
| UpCloud VPS (1xCPU/1GB) | $5 |
| 4 extra IPs ($1 each) | $4 |
| Capsolver (first 1000 solves ≈ $1) | ~$1–5 depending on traffic |
| Cloudflare Tunnel | free |
| Cloudflare DNS for r6checker.xyz | free |
| **Total** | **~$10–15/mo** |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `EADDRNOTAVAIL` on outbound requests | An IP in `LOCAL_IP_POOL` isn't actually on the interface. Run `ip -4 addr show` and remove anything missing from .env. |
| `/health` shows `rotation.localIP.poolSize: 0` | Either `LOCAL_IP_POOL` env var is missing/empty, or all IPs failed the `os.networkInterfaces()` check. See systemd logs. |
| Camoufox launch fails | Run `npx playwright install firefox` again. Check `sudo systemctl status r6checker` for the actual error. |
| Cloudflare Tunnel 530 | Tunnel is down. `sudo systemctl restart cloudflared` then check `journalctl -u cloudflared -f`. |
| Login works but inventory empty | Ubisoft session may have expired. Check `~/r6checker/.cache/ubi-sessions/`. Re-login from `/login` page. |
