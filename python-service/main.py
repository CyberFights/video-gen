import hashlib
import io
import os
import shutil
import subprocess
import tempfile
import textwrap
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

app = FastAPI(title="Video Gen Renderer", version="2.0.0")

VIDEO_BACKEND = os.getenv("VIDEO_BACKEND", "cpu").lower()
WIDTH = int(os.getenv("VIDEO_WIDTH", "768"))
HEIGHT = int(os.getenv("VIDEO_HEIGHT", "432"))
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 25_000_000

PRESETS = {
    "cinematic": "CINEMATIC",
    "documentary": "DOCUMENTARY",
    "anime": "ANIME",
    "hyper_realistic": "HYPER REALISTIC",
}


def run(command: list[str]) -> None:
    process = subprocess.run(command, capture_output=True, text=True, check=False)
    if process.returncode != 0:
        error = process.stderr.strip()[-4000:]
        raise RuntimeError(f"{command[0]} exited with {process.returncode}: {error}")


def media_duration(media_path: Path) -> float:
    process = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(media_path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return float(process.stdout.strip())


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    paths = [
        Path("/usr/share/fonts/truetype/dejavu") / name,
        Path("/usr/share/fonts/dejavu") / name,
    ]
    for candidate in paths:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def palette(prompt: str, preset: str) -> tuple[tuple[int, int, int], tuple[int, int, int]]:
    digest = hashlib.sha256(f"{preset}:{prompt}".encode()).digest()
    first = (25 + digest[0] // 3, 20 + digest[1] // 4, 50 + digest[2] // 2)
    second = (20 + digest[3] // 4, 35 + digest[4] // 3, 65 + digest[5] // 2)
    return first, second


def gradient(first: tuple[int, int, int], second: tuple[int, int, int]) -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), first)
    draw = ImageDraw.Draw(image)
    for y in range(HEIGHT):
        mix = y / max(1, HEIGHT - 1)
        color = tuple(round(a * (1 - mix) + b * mix) for a, b in zip(first, second))
        draw.line((0, y, WIDTH, y), fill=color)
    return image


def decode_image(image_bytes: bytes | None) -> Image.Image | None:
    if not image_bytes:
        return None
    try:
        source = Image.open(io.BytesIO(image_bytes))
        source.load()
        return ImageOps.exif_transpose(source).convert("RGB")
    except Exception as error:
        raise HTTPException(status_code=415, detail="The character image is not valid.") from error


def title_card(
    image_bytes: bytes | None,
    prompt: str,
    character_tag: str | None,
    preset: str | None,
    style_tag: str | None,
    expression_profile: str,
) -> Image.Image:
    first, second = palette(prompt, preset or "cinematic")
    source = decode_image(image_bytes)

    if source:
        background = ImageOps.fit(source, (WIDTH, HEIGHT), method=Image.Resampling.LANCZOS)
        background = background.filter(ImageFilter.GaussianBlur(radius=1.4))
        background = ImageEnhance.Contrast(background).enhance(1.08)
    else:
        background = gradient(first, second)

    tint = {
        "happy": (255, 183, 67, 26),
        "angry": (255, 45, 40, 38),
        "sad": (45, 85, 180, 42),
    }.get(expression_profile, (*second, 18))
    canvas = background.convert("RGBA")
    canvas.alpha_composite(Image.new("RGBA", canvas.size, tint))

    # Dark lower-third keeps the story readable against arbitrary uploaded art.
    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    overlay_draw = ImageDraw.Draw(overlay)
    top = int(HEIGHT * 0.48)
    for y in range(top, HEIGHT):
        alpha = round(35 + 180 * ((y - top) / max(1, HEIGHT - top)))
        overlay_draw.line((0, y, WIDTH, y), fill=(4, 8, 18, alpha))
    canvas.alpha_composite(overlay)

    draw = ImageDraw.Draw(canvas)
    label_font = font(16, bold=True)
    story_font = font(30, bold=True)
    detail_font = font(14)
    label = PRESETS.get(preset or "", (preset or "SCENE").replace("_", " ").upper())
    if style_tag:
        label = f"{label}  •  {style_tag.replace('_', ' ').upper()}"
    draw.rounded_rectangle((34, 28, 34 + min(560, 18 + len(label) * 10), 60), radius=12, fill=(7, 12, 25, 178))
    draw.text((45, 35), label, font=label_font, fill=(229, 238, 255, 255))

    lines = textwrap.wrap(prompt.strip(), width=44)[:4] or ["Untitled scene"]
    line_height = 38
    story_y = HEIGHT - 44 - line_height * len(lines)
    for line in lines:
        draw.text((42, story_y), line, font=story_font, fill=(255, 255, 255, 255), stroke_width=1, stroke_fill=(0, 0, 0, 110))
        story_y += line_height

    if character_tag:
        detail = textwrap.shorten(character_tag, width=85, placeholder="…")
        draw.text((43, HEIGHT - 31), detail, font=detail_font, fill=(190, 207, 230, 255))

    return canvas.convert("RGB")


def render_cpu_scene(
    output: Path,
    image_bytes: bytes | None,
    prompt: str,
    frames: int,
    fps: int,
    character_tag: str | None,
    preset: str | None,
    style_tag: str | None,
    expression_profile: str,
) -> None:
    card = title_card(image_bytes, prompt, character_tag, preset, style_tag, expression_profile)
    still = output.with_suffix(".png")
    card.save(still, format="PNG")

    zoom_filter = (
        f"scale={WIDTH + 64}:{HEIGHT + 36},"
        f"zoompan=z='min(max(zoom,pzoom)+0.0007,1.08)':"
        f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:"
        f"s={WIDTH}x{HEIGHT}:fps={fps},format=yuv420p"
    )
    run([
        "ffmpeg", "-y", "-loop", "1", "-i", str(still),
        "-vf", zoom_filter,
        "-frames:v", str(frames),
        "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output),
    ])


def render_diffusers_scene(
    output: Path,
    image_bytes: bytes | None,
    prompt: str,
    frames: int,
    fps: int,
    guidance: float,
    seed: int | None,
) -> None:
    try:
        import torch
        from diffusers import HunyuanVideoPipeline, StableVideoDiffusionPipeline
        from diffusers.utils import export_to_video
    except ImportError as error:
        raise HTTPException(
            status_code=503,
            detail="VIDEO_BACKEND=diffusers requires requirements-ml.txt and a CUDA host.",
        ) from error

    if not torch.cuda.is_available():
        raise HTTPException(status_code=503, detail="The diffusers backend requires a CUDA GPU.")

    generator = torch.Generator(device="cuda")
    if seed is not None:
        generator.manual_seed(seed)

    if image_bytes:
        pipeline = StableVideoDiffusionPipeline.from_pretrained(
            os.getenv("IMAGE_MODEL_ID", "stabilityai/stable-video-diffusion-img2vid-xt"),
            torch_dtype=torch.float16,
            variant="fp16",
        ).to("cuda")
        source = decode_image(image_bytes)
        result = pipeline(image=source, num_frames=frames, generator=generator).frames[0]
    else:
        pipeline = HunyuanVideoPipeline.from_pretrained(
            os.getenv("TEXT_MODEL_ID", "tencent/HunyuanVideo"),
            torch_dtype=torch.float16,
        ).to("cuda")
        result = pipeline(
            prompt=prompt,
            num_frames=frames,
            guidance_scale=guidance,
            generator=generator,
        ).frames[0]

    export_to_video(result, str(output), fps=fps)


def cleanup(directory: str) -> None:
    shutil.rmtree(directory, ignore_errors=True)


@app.get("/")
@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "renderer", "backend": VIDEO_BACKEND}


@app.post("/scene")
async def generate_scene(
    prompt: Annotated[str, Query(min_length=1, max_length=3000)],
    frames: Annotated[int, Query(ge=1, le=300)] = 32,
    fps: Annotated[int, Query(ge=1, le=30)] = 15,
    guidance: Annotated[float, Query(ge=0, le=30)] = 7.5,
    seed: int | None = None,
    preset: str | None = None,
    character_tag: str | None = None,
    style_tag: str | None = None,
    breathing: bool = False,
    expression_profile: str = "neutral",
    image: Annotated[UploadFile | None, File()] = None,
):
    del breathing  # The CPU renderer always applies a subtle breathing/zoom motion.
    image_bytes = await image.read(MAX_UPLOAD_BYTES + 1) if image else None
    if image_bytes and len(image_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="The image is larger than 50 MB.")

    temporary_directory = tempfile.mkdtemp(prefix="video-gen-scene-")
    output = Path(temporary_directory) / "scene.mp4"
    try:
        if VIDEO_BACKEND == "diffusers":
            full_prompt = ", ".join(filter(None, [prompt, character_tag, style_tag]))
            await run_in_threadpool(
                render_diffusers_scene,
                output,
                image_bytes,
                full_prompt,
                frames,
                fps,
                guidance,
                seed,
            )
        elif VIDEO_BACKEND == "cpu":
            await run_in_threadpool(
                render_cpu_scene,
                output,
                image_bytes,
                prompt,
                frames,
                fps,
                character_tag,
                preset,
                style_tag,
                expression_profile,
            )
        else:
            raise HTTPException(status_code=500, detail=f"Unknown VIDEO_BACKEND: {VIDEO_BACKEND}")
    except HTTPException:
        cleanup(temporary_directory)
        raise
    except Exception as error:
        cleanup(temporary_directory)
        raise HTTPException(status_code=500, detail=str(error)) from error

    return FileResponse(
        output,
        media_type="video/mp4",
        filename="scene.mp4",
        background=BackgroundTask(cleanup, temporary_directory),
    )


@app.post("/lipsync")
async def lipsync(
    video: Annotated[UploadFile, File()],
    audio: Annotated[UploadFile, File()],
):
    temporary_directory = tempfile.mkdtemp(prefix="video-gen-sync-")
    directory = Path(temporary_directory)
    video_path = directory / "input.mp4"
    audio_path = directory / "input-audio"
    output = directory / "synced.mp4"

    try:
        video_bytes = await video.read(MAX_UPLOAD_BYTES + 1)
        audio_bytes = await audio.read(MAX_UPLOAD_BYTES + 1)
        if len(video_bytes) > MAX_UPLOAD_BYTES or len(audio_bytes) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="A media file is larger than 50 MB.")
        video_path.write_bytes(video_bytes)
        audio_path.write_bytes(audio_bytes)

        wav2lip_directory = Path(os.getenv("WAV2LIP_DIR", "/opt/Wav2Lip"))
        checkpoint = Path(os.getenv("WAV2LIP_CHECKPOINT", str(wav2lip_directory / "checkpoints/wav2lip_gan.pth")))
        inference = wav2lip_directory / "inference.py"
        if inference.exists() and checkpoint.exists():
            await run_in_threadpool(
                run,
                [
                    "python", str(inference),
                    "--checkpoint_path", str(checkpoint),
                    "--face", str(video_path),
                    "--audio", str(audio_path),
                    "--outfile", str(output),
                ],
            )
            mode = "wav2lip"
        else:
            # Railway has no GPU. This keeps scene timing and sound functional; users can
            # point the service at a mounted Wav2Lip install on a CUDA-capable host.
            await run_in_threadpool(
                run,
                [
                    "ffmpeg", "-y", "-i", str(video_path), "-i", str(audio_path),
                    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac",
                    "-b:a", "128k", "-shortest", "-movflags", "+faststart", str(output),
                ],
            )
            mode = "audio-mux"
    except HTTPException:
        cleanup(temporary_directory)
        raise
    except Exception as error:
        cleanup(temporary_directory)
        raise HTTPException(status_code=500, detail=str(error)) from error

    return FileResponse(
        output,
        media_type="video/mp4",
        filename="synced.mp4",
        headers={"X-Lipsync-Mode": mode},
        background=BackgroundTask(cleanup, temporary_directory),
    )


@app.post("/align")
async def align(
    transcript: Annotated[str, Form(min_length=1)],
    audio: Annotated[UploadFile, File()],
):
    """Return an inexpensive uniform alignment for compatibility with older clients."""
    temporary_directory = tempfile.mkdtemp(prefix="video-gen-align-")
    audio_path = Path(temporary_directory) / "audio"
    try:
        audio_bytes = await audio.read(MAX_UPLOAD_BYTES + 1)
        if len(audio_bytes) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="The audio file is larger than 50 MB.")
        audio_path.write_bytes(audio_bytes)
        duration = await run_in_threadpool(media_duration, audio_path)
        words = transcript.split()
        step = duration / max(1, len(words))
        result = {
            "words": [
                {"word": word.lower().strip(".,!?;:\"'"), "start": index * step, "end": (index + 1) * step}
                for index, word in enumerate(words)
            ]
        }
        return JSONResponse(result)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=400, detail=f"Could not align audio: {error}") from error
    finally:
        cleanup(temporary_directory)
