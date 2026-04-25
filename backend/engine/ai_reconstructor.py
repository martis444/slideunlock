import asyncio
import concurrent.futures
import json
import logging
import os
import re
import time
from io import BytesIO

from dotenv import load_dotenv
from google import genai
from google.genai import types
from PIL import Image

log = logging.getLogger(__name__)

MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"]
_REQUEST_TIMEOUT = 200      # seconds per attempt; complex slides need 80-120s on preview models
_RETRY_DELAYS    = [2, 4]   # sleep before retry-1 and retry-2 of the same model
_MAX_OUTPUT_TOKENS = 32768  # complex slides easily exceed 8k tokens of JSON output
_EMU_PER_INCH    = 914400

_VALID_TYPES = frozenset([
    "rectangle", "rounded_rect", "oval", "textbox", "line", "connector",
    "triangle", "diamond", "pentagon", "hexagon",
    "arrow_right", "arrow_left", "arrow_double",
    "callout_rect", "callout_rounded_rect",
])

_FIELD_ALIASES = {
    "shape_type": "type", "kind": "type", "shape": "type",
    "box_x": "x",  "pos_x": "x",  "left": "x",
    "box_y": "y",  "pos_y": "y",  "top":  "y",
    "width": "cx", "box_width": "cx", "w": "cx",
    "height": "cy","box_height": "cy","h": "cy",
}

_TYPE_ALIASES = {
    "text_box": "textbox", "text box": "textbox",
    "round_rect": "rounded_rect", "rounded_rectangle": "rounded_rect",
    "right_arrow": "arrow_right", "left_arrow": "arrow_left",
    "double_arrow": "arrow_double", "arrow": "arrow_right",
    "circle": "oval", "ellipse": "oval",
    "rect": "rectangle",
}

_FENCE_RE = re.compile(r"^```[a-zA-Z]*\s*\n(.*?)```\s*$", re.DOTALL)

_RETRYABLE_FRAGMENTS = ("503", "unavailable", "overloaded", "deadline", "resource exhausted", "429")


# ── prompt ───────────────────────────────────────────────────────────────────

def _build_system_prompt(style_ctx: dict, slide_cx: int, slide_cy: int) -> str:
    fonts = ", ".join(
        style_ctx.get("font_names", style_ctx.get("fonts", []))
    ) or "Arial, Calibri"
    colors = ", ".join(
        f"#{c}" for c in style_ctx.get("theme_colors", [])
    ) or "(none)"

    return (
        f"You are a PowerPoint slide reconstruction engine. "
        f"Analyse the provided slide image and return a JSON array of ShapeSpec objects "
        f"that faithfully recreates every visible element at pixel-accurate positions.\n\n"
        f"SLIDE: {slide_cx} x {slide_cy} EMU "
        f"({slide_cx / _EMU_PER_INCH:.3f} x {slide_cy / _EMU_PER_INCH:.3f} inches)\n"
        f"FONTS: {fonts}. Use exact values only.\n"
        f"COLORS: {colors}. Use exact values only.\n\n"
        f"COORDINATE RULES:\n"
        f"- All x,y coordinates MUST be multiples of 12700 (PowerPoint grid)\n"
        f"- All cx,cy MUST be multiples of 25400\n"
        f"- Measure precisely: pixel_position / image_width * slide_cx = EMU value. "
        f"Round to nearest grid.\n\n"
        f"VALID SHAPE TYPES (use EXACTLY these strings, nothing else):\n"
        f"  rectangle | rounded_rect | oval | textbox | line | connector | triangle |\n"
        f"  diamond | pentagon | hexagon | arrow_right | arrow_left | arrow_double |\n"
        f"  callout_rect | callout_rounded_rect\n\n"
        f"CRITICAL FIELD NAMES — do not rename, abbreviate, or invent alternatives:\n"
        f'  "type"  NOT "shape_type" / "kind" / "shape"\n'
        f'  "x"     NOT "box_x" / "pos_x" / "left"\n'
        f'  "y"     NOT "box_y" / "pos_y" / "top"\n'
        f'  "cx"    NOT "width" / "box_width" / "w"\n'
        f'  "cy"    NOT "height" / "box_height" / "h"\n\n'
        f"EXAMPLE OBJECT (copy structure exactly, change only values):\n"
        '{{"id":100,"type":"textbox","z_order":0,"x":457200,"y":274638,'
        '"cx":3200400,"cy":685800,"rot":0,'
        '"text_runs":[{{"text":"Title","font_name":"Calibri","font_size_pt":24.0,'
        '"bold":true,"italic":false,"underline":false,"font_color_hex":"FFFFFF",'
        '"align":"left","line_spacing_pt":28.0,"space_before_pt":0.0,"space_after_pt":0.0}}],'
        '"v_align":"top","fill_type":"none","fill_opacity":1.0,'
        '"line_hex":"000000","line_width_pt":0.0,"line_dash":"solid"}}\n\n'
        f"RULES:\n"
        f"- x, y, cx, cy MUST be integers (no floats, no strings)\n"
        f"- font_size_pt must be a float (24.0 not 24)\n"
        f"- Use text_runs array (NEVER a flat 'text' field)\n"
        f"- paragraph-level fields (align, line_spacing_pt, space_before_pt, space_after_pt) "
        f"on FIRST run of each paragraph ONLY\n"
        f'- Separate paragraphs with {{"paragraph_break": true}}\n'
        f"- Output ONLY valid JSON array, no markdown fences, no explanation"
    )


_USER_PROMPT = (
    "Reconstruct this slide as a JSON array of ShapeSpec objects. "
    "Cover every visible text block, shape, line, and graphical element. "
    "Use the slide dimensions, fonts, and colors provided in the system prompt."
)


# ── image preprocessing ───────────────────────────────────────────────────────

_MAX_UPSCALE_WIDTH = 2048   # cap to avoid ballooning API inference time


def _preprocess_image(image_bytes: bytes) -> bytes:
    """2x LANCZOS upscale (capped at 2048px wide) for sharper text recognition."""
    img = Image.open(BytesIO(image_bytes))
    w, h = img.size
    scale = min(2.0, _MAX_UPSCALE_WIDTH / w)
    if scale > 1.0:
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ── response helpers ──────────────────────────────────────────────────────────

def _parse_response(raw: str) -> list | None:
    text = raw.strip()
    m = _FENCE_RE.match(text)
    if m:
        text = m.group(1).strip()
    start, end = text.find("["), text.rfind("]")
    if start != -1 and end > start:
        text = text[start : end + 1]
    try:
        data = json.loads(text)
        return data if isinstance(data, list) else None
    except json.JSONDecodeError as exc:
        log.debug("JSON parse error: %s", exc)
        return None


def _normalize(shape: dict) -> dict:
    out = {_FIELD_ALIASES.get(k, k): v for k, v in shape.items()}
    if "type" in out:
        out["type"] = _TYPE_ALIASES.get(out["type"], out["type"])
    for field in ("x", "y", "cx", "cy"):
        if field in out and isinstance(out[field], float):
            out[field] = int(out[field])
    return out


def _validate(shapes: list) -> list[dict]:
    out = []
    for s in shapes:
        if not isinstance(s, dict):
            continue
        s = _normalize(s)
        if s.get("type") not in _VALID_TYPES:
            log.debug("Dropping shape: unknown type %r", s.get("type"))
            continue
        if not all(isinstance(s.get(f), int) for f in ("x", "y", "cx", "cy")):
            log.debug("Dropping shape: non-int geometry in %r", s.get("id"))
            continue
        out.append(s)
    return out


def _is_daily_quota_exhausted(exc: Exception) -> bool:
    """Daily quota (limit: 0) won't clear in seconds — skip model immediately."""
    msg = str(exc)
    return "PerDay" in msg and "limit: 0" in msg


def _is_retryable(exc: Exception) -> bool:
    if _is_daily_quota_exhausted(exc):
        return False
    msg = str(exc).lower()
    return any(k in msg for k in _RETRYABLE_FRAGMENTS)


# ── public API ────────────────────────────────────────────────────────────────

def reconstruct_slide(
    image_path: str,
    style_ctx: dict,
    slide_cx: int,
    slide_cy: int,
) -> list:
    """
    Call Gemini to reconstruct a flat-image slide. Tries each model in MODELS
    with up to len(_RETRY_DELAYS)+1 attempts and exponential backoff.
    Returns a validated list of ShapeSpec dicts, or [] if all models fail.
    """
    load_dotenv()
    client     = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    start_time = time.time()

    with open(image_path, "rb") as f:
        raw_bytes = f.read()
    processed  = _preprocess_image(raw_bytes)
    image_part = types.Part.from_bytes(data=processed, mime_type="image/png")

    system_text = _build_system_prompt(style_ctx, slide_cx, slide_cy)
    gen_config  = types.GenerateContentConfig(
        system_instruction=system_text,
        temperature=0,
        top_p=0.1,
        max_output_tokens=_MAX_OUTPUT_TOKENS,
        # thinking_budget=0: disables internal reasoning tokens on Gemini 2.5+/3+,
        # reclaiming them for output. Without this, models burn ~30k tokens on thinking
        # and truncate the JSON response at ~2-3k chars.
        thinking_config=types.ThinkingConfig(thinking_budget=0),
    )

    for model_name in MODELS:
        # attempts: 1 initial + len(_RETRY_DELAYS) retries
        for attempt in range(1, len(_RETRY_DELAYS) + 2):
            if attempt > 1:
                delay = _RETRY_DELAYS[attempt - 2]
                log.info("Backing off %ds before retry", delay)
                time.sleep(delay)

            print(f"Using {model_name}, attempt {attempt}")

            try:
                def _call(m=model_name):
                    return client.models.generate_content(
                        model=m,
                        contents=[image_part, _USER_PROMPT],
                        config=gen_config,
                    )

                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
                    fut = ex.submit(_call)
                    try:
                        resp = fut.result(timeout=_REQUEST_TIMEOUT)
                    except concurrent.futures.TimeoutError:
                        fut.cancel()
                        raise TimeoutError(
                            f"{model_name} timed out after {_REQUEST_TIMEOUT}s"
                        )

                shapes = _parse_response(resp.text)
                if shapes is not None:
                    validated = _validate(shapes)
                    if validated:
                        elapsed = time.time() - start_time
                        first   = validated[0]
                        print(
                            f"reconstruct_slide: {model_name} | {elapsed:.1f}s | "
                            f"{len(validated)} shapes | "
                            f"first shape x={first.get('x')} y={first.get('y')}"
                        )
                        return validated

                # Valid API response but unparseable / empty output — don't retry
                log.warning("%s attempt %d: no valid shapes in response; skipping model", model_name, attempt)
                break

            except Exception as exc:
                if _is_retryable(exc) and attempt <= len(_RETRY_DELAYS):
                    log.warning("%s attempt %d: retryable error (%s)", model_name, attempt, exc)
                    # loop continues to next attempt
                else:
                    log.warning("%s attempt %d: error (%s); moving to next model", model_name, attempt, exc)
                    break  # try next model

    elapsed = time.time() - start_time
    log.error("reconstruct_slide: all models exhausted after %.1fs", elapsed)
    return []


async def reconstruct_slide_async(
    image_path: str,
    style_ctx: dict,
    slide_cx: int,
    slide_cy: int,
) -> list:
    """Async wrapper — runs reconstruct_slide in a thread pool."""
    return await asyncio.to_thread(
        reconstruct_slide, image_path, style_ctx, slide_cx, slide_cy
    )


def reconstruct(
    image_bytes: bytes,
    style_ctx: dict,
    slide_cx: int,
    slide_cy: int,
) -> list:
    """Backward-compat wrapper for pptx_unlocker.py (accepts bytes, not path)."""
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        tmp.write(image_bytes)
        tmp_path = tmp.name
    try:
        return reconstruct_slide(tmp_path, style_ctx, slide_cx, slide_cy)
    finally:
        os.unlink(tmp_path)
