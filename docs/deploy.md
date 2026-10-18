# Deploying the public server

One container, SQLite on a volume. Fits a 2 vCPU / 4 GB VPS. Read [security.md](security.md) first.

Not included yet (planned for scale-out): Postgres instead of SQLite, a Redis job queue, S3 for
screenshots, several workers. The code keeps storage and scanning behind interfaces, so these are
swaps, not rewrites.

## 1. Prepare the machine

- Docker with the Compose plugin, a domain pointing at the machine.
- A reverse proxy that terminates TLS. Caddy example (`/etc/caddy/Caddyfile`):

  ```
  doctor.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8080
  }
  ```

  The app trusts `X-Forwarded-For` (`--trust-proxy`) because only this proxy can reach it
  (the compose file publishes the port on `127.0.0.1` only).

## 2. Configure

```bash
cp .env.example .env
openssl rand -hex 32   # put the result into WEBDOCTOR_SECRET
# set WEBDOCTOR_HOST=doctor.example.com
```

`WEBDOCTOR_SECRET` signs session tokens. Changing it logs everyone out (their old results become
unreachable and are deleted after the retention period).

## 3. Egress firewall (do not skip)

The guard is the first line; this is the second. Block the container network from private ranges and
the metadata service, keep the internet open. Find the compose network's subnet:

```bash
docker network inspect web-doctor_default --format '{{(index .IPAM.Config 0).Subnet}}'
```

Then, with `SUBNET` set to that value (Linux, `iptables`; the `DOCKER-USER` chain is evaluated before
Docker's own rules):

```bash
SUBNET=172.20.0.0/16
for range in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 127.0.0.0/8; do
  sudo iptables -I DOCKER-USER -s "$SUBNET" -d "$range" -j DROP
done
sudo ip6tables -I DOCKER-USER -s fd00::/8 -d fc00::/7 -j DROP   # adapt if you use IPv6
```

Persist the rules with your distribution's mechanism (`iptables-persistent`, `nftables`, or a
systemd unit). Check from inside the container that the metadata address is unreachable:

```bash
docker compose exec webdoctor node -e "fetch('http://169.254.169.254/',{signal:AbortSignal.timeout(3000)}).then(()=>console.log('REACHABLE (bad)'),()=>console.log('blocked (good)'))"
```

Note the guard already refuses that address; this checks the firewall independently, by going
around the application (a plain `fetch` in Node, which does not use the guard).

If you also use the cloud provider's firewall, deny egress to the metadata IP there as well.

## 4. Start

```bash
docker compose up -d --build
docker compose logs -f
curl -s https://doctor.example.com/api/health   # {"ok":true,"mode":"public"}
```

`--demo` is enabled in the compose file: the Broken Shop demo is offered as the first example
address. Remove `--demo` to run without it.

## 5. Operate

- **Updates:** `git pull && docker compose up -d --build`. Migrations run on start.
- **Backups:** results are temporary by design (24 h). Nothing to back up except `.env`.
- **Retention:** `--retention-hours` (default 24). A sweep runs at start and every 10 minutes and
  deletes old runs from the database and from disk.
- **Limits:** change defaults in `apps/api/src/server.ts` (`DEFAULT_PUBLIC_LIMITS`) or pass
  `--max-pages`. The web form follows `GET /api/config`.
- **Logs:** JSON in `docker compose logs`; scan failures log the real error, visitors see a generic
  message.
- **Abuse:** the user agent is `WebDoctor/0.0`. If a site owner complains, stop the container and
  check the logs.

## Local run without Docker

```bash
pnpm install
pnpm --filter @webdoctor/web build
WEBDOCTOR_SECRET=dev pnpm webdoctor serve --demo --port 8080
# open http://127.0.0.1:8080/
```
