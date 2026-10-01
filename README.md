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

Do not expose the renderer publicly. Both services listen on `0.0.0.0` and honor Railway's `PORT` variable.

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
uvicorn main:app --host 0.0.0.0 --port 8000
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

### Renderer

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8000` | HTTP listen port |
| `VIDEO_BACKEND` | `cpu` | `cpu` or optional `diffusers` |
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
  `uvicorn main:app --host 0.0.0.0 --port 8000` from `python-service/`.
- **With Docker Compose:** the checked-in `compose.yaml` wires this up; `ENOTFOUND` there means
  the renderer container is not running or the app was started outside the Compose network. Run
  `docker compose up --build` and check `docker compose ps` / `docker compose logs renderer`.

## Checks

```bash
npm test
python -m compileall -q python-service
```
