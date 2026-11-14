# Deploying on AWS without losing data

**The rule:** the code lives in `/opt/checkin` and gets replaced on every update. All data
(database, uploaded logos and photos, backups) lives on a **separate EBS volume mounted at `/data`**.
Updates never touch `/data`, and the app refuses to start in production if `DB_PATH` points anywhere
inside the code folder.

```
EC2 (t4g.medium, Ubuntu 24.04 arm64)
├── /opt/checkin        code (git clone) — replaced on each deploy
├── /etc/checkin/checkin.env   settings + secrets
└── /data               separate EBS volume — survives deploys, reboots and instance replacement
    ├── checkin.db      the database
    ├── uploads/        logos and photos
    └── backups/        copies made before every deploy
Caddy (HTTPS) → Node app on 127.0.0.1:4000
Litestream → S3 (continuous database backup)
```

## One-time setup

### 1. Server and data volume
1. Launch an EC2 instance: **Ubuntu 24.04 LTS (arm64)**, **t4g.medium**. Security group: SSH (22) from
   your IP only, HTTP (80) and HTTPS (443) from anywhere. Give it an IAM role with access to your backup
   S3 bucket (for Litestream).
2. Create an **EBS gp3 volume** (20 GB is plenty to start) in the **same Availability Zone**, and attach it.
3. Format and mount it at `/data` (check the device name with `lsblk`, often `/dev/nvme1n1`):
   ```bash
   sudo mkfs.ext4 -L checkin-data /dev/nvme1n1
   sudo mkdir -p /data
   echo 'LABEL=checkin-data /data ext4 defaults,nofail 0 2' | sudo tee -a /etc/fstab
   sudo mount -a && df -h /data
   ```
4. In **EC2 → Lifecycle Manager**, create a policy that snapshots this volume **daily** and keeps 14.

### 2. Software
```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git caddy
sudo useradd --system --create-home --shell /bin/bash checkin
sudo mkdir -p /opt/checkin /etc/checkin /data/uploads /data/backups
sudo chown -R checkin:checkin /opt/checkin /data
sudo -u checkin git clone https://github.com/<you>/checkin-system.git /opt/checkin
```
Private repository? Add a read-only **deploy key** to the repo and clone over SSH.

### 3. Settings
```bash
sudo cp /opt/checkin/deploy/aws/checkin.env.example /etc/checkin/checkin.env
sudo nano /etc/checkin/checkin.env          # fill in APP_URL, JWT_SECRET, SMTP_*, PLATFORM_OWNER_*
sudo chown root:checkin /etc/checkin/checkin.env && sudo chmod 640 /etc/checkin/checkin.env
```

### 4. Move your existing data from Render (skip for a fresh start)
1. On Render, open your service's **Shell** and make a consistent copy:
   `cd server && DB_PATH=/var/data/data.db BACKUP_DIR=/var/data/export node scripts/backup.js`
2. Download `/var/data/export/checkin-….db` and the `/var/data/uploads` folder. Render supports
   `scp` to paid services (see Render's "SSH" docs), or use any file transfer you prefer.
3. Upload them to the EC2 server as `/data/checkin.db` and `/data/uploads/`, then
   `sudo chown -R checkin:checkin /data`.
4. Do this in a quiet period, and stop the Render service right after so no new check-ins land there.

### 5. Start it
```bash
sudo -u checkin bash -c 'cd /opt/checkin && npm ci --prefix server --omit=dev && npm ci --prefix client && npm run build --prefix client'
sudo cp /opt/checkin/deploy/aws/checkin.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now checkin
sudo journalctl -u checkin -n 20 --no-pager
```
Look for `[db] Database: /data/checkin.db — N institutions, N people, N attendance records`.
If you see **"a NEW, EMPTY one was created"** and you expected data, stop and check step 4.

Let the `checkin` user restart the service (used by the deploy script):
```bash
echo 'checkin ALL=(root) NOPASSWD: /usr/bin/systemctl restart checkin, /usr/bin/journalctl -u checkin *' | sudo tee /etc/sudoers.d/checkin
```

### 6. HTTPS and domain
Point your domain's DNS (an A record) at the instance's **Elastic IP**, then:
```bash
sudo cp /opt/checkin/deploy/aws/Caddyfile /etc/caddy/Caddyfile   # edit the domain first
sudo systemctl reload caddy
```

### 7. Continuous backups
- **Database → S3 every second:** install [Litestream](https://litestream.io/install/), edit the bucket in
  `deploy/aws/litestream.yml`, copy it to `/etc/litestream.yml`, then `sudo systemctl enable --now litestream`.
- **Uploads → S3 hourly:** `sudo -u checkin crontab -e` and add
  `0 * * * * aws s3 sync /data/uploads s3://YOUR-BACKUP-BUCKET/uploads --only-show-errors`
- **Daily volume snapshots:** step 1.4.

## Every update

```bash
ssh ubuntu@your-server
sudo -u checkin bash /opt/checkin/deploy/aws/deploy.sh
```
It checks `/data` is mounted, **backs up the database**, pulls `main`, installs, builds, restarts
(a few seconds of downtime), and checks `/api/health`. If the new version doesn't come up, it puts
the previous code back automatically. It refuses to run between 07:00 and 09:00 (Kigali time)
unless you add `FORCE=1`.

## Restoring

| Situation | What to do |
|---|---|
| A release changed data badly | `sudo systemctl stop checkin`, copy the newest `/data/backups/checkin-….db` over `/data/checkin.db` (and delete `checkin.db-wal`, `checkin.db-shm`), start again |
| Need a specific moment | `litestream restore -timestamp 2026-11-20T09:15:00Z -o /data/restored.db /data/checkin.db`, then swap it in as above |
| Instance lost | Launch a new instance, attach the volume (or a snapshot of it) at `/data`, repeat setup steps 2, 3, 5, 6 |

Practise one restore before launch and time it.
