# Video Gen

A Railway-ready story-to-video application. The public Node service serves the React UI, stores character assets, creates scene timelines, and calls a private Python rendering service. The renderer uses FFmpeg and Pillow, so the default deployment works on Railway's CPU infrastructure.

## Railway architecture

| Service | Source root | Purpose | Public? |
| --- | --- | --- | --- |
| `app` | `/` | React UI, API, FFmpeg timeline assembly | Yes |
| `renderer` | `/python-service` | CPU scene rendering and audio muxing | No |
| `app-data` | mounted at `/data` | Uploaded characters and generated videos | — |

The old `railpack.yml` was removed because Railpack configuration describes one build, not a multi-service Railway project. The supported multi-service definition is [`.railway/railway.ts`](.railway/railway.ts).

## Deploy to Railway

Railway Infrastructure as Code requires the Railway CLI and a linked project. The checked-in definition deploys the repository's default `main` branch, so merge these changes to `main` before applying it:

```bash
npm install -g @railway/cli@latest  # IaC requires Railway CLI 5.42.1+
npm install
railway login
railway init          # omit this if the directory is already linked
railway config plan
railway config apply
```

The plan creates the `app` and `renderer` services and a 1 GB volume. Review the plan before applying it. In Railway, generate a public domain only for the **app** service. The app reaches the renderer over Railway private networking through the automatically configured `PYTHON_API_HOST` reference.

If you prefer the dashboard instead of IaC:

1. Create a service from this repository with root directory `/`. Railway finds the root `Dockerfile`.
2. Create another service from the same repository with root directory `/python-service`.
3. Set `PORT=8000` on the renderer.
4. On the app, set `PYTHON_API_HOST=${{renderer.RAILWAY_PRIVATE_DOMAIN}}` and `PYTHON_API_PORT=8000`.
5. Mount a volume at `/data` on the app and generate a public domain for the app.
6. Set both health-check paths to `/health`.

Do not expose the renderer publicly. Both services honor Railway's `PORT` variable. The renderer
starts through `python-service/serve.py`, which binds a dual-stack socket (`[::]`, IPv6 + IPv4) so
that Railway private networking and Railway's IPv4 health check both reach it; the app listens on
`0.0.0.0`.

## Rendering modes

`VIDEO_BACKEND=cpu` is the Railway default. It creates animated, styled story cards (using an uploaded character image when available), then synchronizes optional narration with the timeline. This gives the application a functional, deterministic fallback without downloading model weights at startup.

The original HunyuanVideo pipeline requires a CUDA GPU and tens of gigabytes of model memory; Railway does not provide a GPU runtime. To run the original model on a separate CUDA host:

1. Install PyTorch using the wheel for that host's CUDA version.
2. Install `python-service/requirements-ml.txt`.
3. Set `VIDEO_BACKEND=diffusers`.
4. Point the Railway app's `PYTHON_API_URL` at that renderer, or deploy the app and GPU renderer in a network that can reach each other.

The `/lipsync` endpoint uses Wav2Lip only when both `WAV2LIP_DIR` and `WAV2LIP_CHECKPOINT` resolve to an installed copy. On Railway it safely falls back to muxing the narration with each scene; it does not claim to synthesize mouth movement without the missing model and checkpoint.

## Run locally

With Docker:

```bash
docker compose up --build
```

Open <http://localhost:3000>. The renderer health endpoint is available at <http://localhost:8000/health>.

Without Docker, install FFmpeg and use two terminals:

```bash
# terminal 1
cd python-service
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python serve.py
```

```bash
# terminal 2 (from the repository root)
npm --prefix web install
npm --prefix web run build
npm --prefix node-service install
PUBLIC_DIR="$PWD/web/dist" DATA_DIR="$PWD/.data" npm --prefix node-service start
```

Then open <http://localhost:3000>.

## Environment variables

### App

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port |
| `DATA_DIR` | `node-service/data` | Character, upload, and generated-video storage |
| `PUBLIC_DIR` | `node-service/public` | Built frontend directory |
| `PYTHON_API_URL` | — | Complete renderer URL; takes precedence over host/port |
| `PYTHON_API_HOST` | — | Renderer private hostname |
| `PYTHON_API_PORT` | `8000` | Renderer private port |
| `PYTHON_API_TIMEOUT_MS` | `600000` | Per-render request timeout |
| `PYTHON_API_HEALTH_TIMEOUT_MS` | `5000` | Renderer health-check timeout |
| `PYTHON_API_RETRIES` | `3` | Connection attempts per renderer request |

Run `npm --prefix node-service run doctor` inside the app service to verify these settings against
the live renderer (DNS, TCP connect, and `/health`); it exits non-zero when the renderer is
unreachable.

### Renderer

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8000` | HTTP listen port |
| `VIDEO_BACKEND` | `cpu` | `cpu` or optional `diffusers` |
| `LOG_LEVEL` | `info` | uvicorn log level |
| `VIDEO_WIDTH` / `VIDEO_HEIGHT` | `768` / `432` | CPU output dimensions |
| `WAV2LIP_DIR` | `/opt/Wav2Lip` | Optional Wav2Lip checkout |
| `WAV2LIP_CHECKPOINT` | `$WAV2LIP_DIR/checkpoints/wav2lip_gan.pth` | Optional checkpoint |

## Troubleshooting

### `ECONNREFUSED 127.0.0.1:8000` during generation

`127.0.0.1:8000` is the local-development fallback. Seeing it in a deployment means the app
service has no renderer address: neither `PYTHON_API_URL` nor `PYTHON_API_HOST` was set (or the
Railway variable reference resolved to an empty string), so the app looked for a renderer inside
its own container.

Check what the app resolved:

```bash
curl https://<app-domain>/health           # shows renderer.url and renderer.source
curl https://<app-domain>/health/renderer  # 200 when reachable, 503 with the reason otherwise
```

If `renderer.source` is `fallback`, set on the **app** service either
`PYTHON_API_HOST=${{renderer.RAILWAY_PRIVATE_DOMAIN}}` with `PYTHON_API_PORT=8000`, or a complete
`PYTHON_API_URL`, then redeploy. The variable reference only resolves once the renderer service
exists, so apply the renderer first.

If `renderer.source` is set but the renderer is still unreachable, confirm the renderer is
deployed, healthy on `/health`, listening on `PORT=8000`, and in the same Railway project and
environment (private networking does not cross environments).

### `ECONNREFUSED` with a `*.railway.internal` host

```text
The renderer at http://<name>.railway.internal:8000 is unreachable (ECONNREFUSED).
```

`ECONNREFUSED` (unlike `ENOTFOUND`) means private DNS resolved and the TCP connection was
actively refused: the address is right but nothing is listening on that port. Run the built-in
diagnostic from the **app** service — it prints the resolved config, the DNS records, a TCP probe
per address, and the `/health` response:

```bash
railway ssh --service app   # or: railway run --service app npm --prefix node-service run doctor
npm --prefix node-service run doctor
```

Two causes account for nearly every case:

1. **The host is the wrong service — usually the app itself.** The renderer service in this repo
   is named `renderer`, so its private domain is `renderer.railway.internal`. A host like
   `video-gen.railway.internal` is the *app's* own domain (Railway names the private domain after
   the service, and the app service is often named after the repository), so the app dials itself
   on port 8000, where only port 3000 is listening. Set `PYTHON_API_HOST` to a reference to the
   renderer service, `${{renderer.RAILWAY_PRIVATE_DOMAIN}}`, not to a hard-coded name or to this
   service, then redeploy. The app logs this at startup and `doctor` reports it as a failure.
2. **The renderer is listening on IPv4 only.** Railway environments created before 2025-10-16
   have an IPv6-only private network, so a renderer bound to `0.0.0.0` refuses private-network
   connections even though it is running and its public health check passes. `uvicorn --host ::`
   does not fix this either: uvicorn passes the host to asyncio, which sets `IPV6_V6ONLY`, and
   then Railway's IPv4 health check fails instead. The renderer therefore starts via
   `python serve.py`, which binds one dual-stack socket. Its log line should read:

   ```text
   Renderer listening on [::]:8000 (IPv6 + IPv4).
   ```

   If the renderer logs `Uvicorn running on http://0.0.0.0:8000`, it is running an old start
   command — clear any custom start command on the service so the image `CMD` applies, and
   redeploy.

Also confirm the renderer is deployed in the same project **and** environment as the app
(private networking does not cross environments) and that `PYTHON_API_PORT` matches the
renderer's `PORT`.

### `ENOTFOUND` with `http://renderer:8000`

`renderer` is the Docker Compose service name from `compose.yaml`; it only resolves inside the
Compose network. Seeing `The renderer at http://renderer:8000 is unreachable (ENOTFOUND)` means
that value was copied somewhere the name does not exist:

- **On Railway:** remove `PYTHON_API_URL=http://renderer:8000` and instead set
  `PYTHON_API_HOST=${{renderer.RAILWAY_PRIVATE_DOMAIN}}` with `PYTHON_API_PORT=8000` (or
  `PYTHON_API_URL=http://${{renderer.RAILWAY_PRIVATE_DOMAIN}}:8000`). Railway private DNS
  resolves `<service>.railway.internal`, never the bare Compose-style service name.
- **Running locally without Docker:** unset `PYTHON_API_URL` (the app then falls back to
  `http://127.0.0.1:8000`) and start the renderer with
  `python serve.py` from `python-service/`.
- **With Docker Compose:** the checked-in `compose.yaml` wires this up; `ENOTFOUND` there means
  the renderer container is not running or the app was started outside the Compose network. Run
  `docker compose up --build` and check `docker compose ps` / `docker compose logs renderer`.

### `ENOTFOUND` with a `<service>.<project>.railway.internal` host

```text
Renderer configured at http://renderer.video-gen.railway.internal:8000 (from PYTHON_API_HOST).
Renderer health check failed: The renderer at http://renderer.video-gen.railway.internal:8000 is unreachable (ENOTFOUND).
```

Railway private hostnames are exactly `<service-name>.railway.internal` — **the project name is not part
of the hostname**. `renderer.video-gen.railway.internal` slides the project name (`video-gen`) between
the service name and `railway.internal`, so no such DNS record exists anywhere on Railway: the lookup
fails with `ENOTFOUND` even when the renderer is deployed and healthy. The renderer's private domain is
`renderer.railway.internal`.

This happens when `PYTHON_API_HOST` is typed by hand from a guessed hostname format. Never hard-code a
private hostname; use a reference so Railway fills in the real value:

```bash
PYTHON_API_HOST=${{renderer.RAILWAY_PRIVATE_DOMAIN}}   # resolves to renderer.railway.internal
PYTHON_API_PORT=8000
```

Applying [`.railway/railway.ts`](.railway/railway.ts) sets exactly that reference. The app also detects
the extra-label form on its own: the startup log, `/health/renderer`, generation errors, and `doctor`
call out the invalid hostname, and when the corrected `<service>.railway.internal` name resolves and
answers `/health`, they confirm it as the renderer's real private domain.

Two related signals:

- **`Video Gen is listening on 0.0.0.0:8080`.** Railway injects `PORT=8080` at runtime when a service
  declares no `PORT` of its own. The app works on any port, but an 8080 here means the app service has
  no declared `PORT` — which in turn means the checked-in IaC definition (which declares `PORT=3000`
  and the `PYTHON_API_HOST` reference) has not been applied to that environment. Fixing the one
  renderer variable by hand works, but applying the IaC fixes all of it and keeps it reproducible.
- **If the renderer service is genuinely *named* `renderer.video-gen`**, then the hostname is valid
  after all, and `ENOTFOUND` means that service is not running in this environment — check its deploy
  logs and health check. `npm --prefix node-service run doctor` prints this service's own name plus
  the DNS/TCP/`/health` evidence needed to tell the two cases apart.

## Checks

```bash
npm test
python -m compileall -q python-service
```
