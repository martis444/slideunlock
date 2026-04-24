import asyncio
import logging
import os
import shutil
import tempfile
import time
import uuid
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

import stripe
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from supabase import Client, create_client

from engine.classifier import classify_all
from engine.harvester import harvest
from engine.pptx_unlocker import unlock
from engine.ungrouper import flatten_groups
from engine.xml_surgery import strip_locks

load_dotenv()

# ── config ────────────────────────────────────────────────────────────────────
def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip().strip("\"'")

SUPABASE_URL          = _env("SUPABASE_URL")
SUPABASE_SERVICE_KEY  = _env("SUPABASE_SERVICE_KEY")
STRIPE_SECRET_KEY     = _env("STRIPE_SECRET_KEY")
STRIPE_WEBHOOK_SECRET = _env("STRIPE_WEBHOOK_SECRET")
ALLOWED_ORIGIN        = _env("ALLOWED_ORIGIN", "http://localhost:3000")

_MAX_BYTES        = 100 * 1024 * 1024   # 100 MB
_PPTX_MAGIC       = b"PK\x03\x04"
_RATE_LIMIT_MAX   = 3
_RATE_LIMIT_WINDOW = 86_400             # 24 hours

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
log = logging.getLogger(__name__)

# ── Supabase client ───────────────────────────────────────────────────────────
_sb: Optional[Client] = None
if SUPABASE_URL and SUPABASE_SERVICE_KEY:
    _sb = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

# ── Stripe ────────────────────────────────────────────────────────────────────
if STRIPE_SECRET_KEY:
    stripe.api_key = STRIPE_SECRET_KEY

# ── in-memory rate limiter ────────────────────────────────────────────────────
_rate_store: dict[str, list[float]] = defaultdict(list)


def _check_rate_limit(ip: str) -> bool:
    """Returns True (allowed) or False (blocked). Stamps the request on allow."""
    now = time.time()
    valid = [t for t in _rate_store[ip] if now - t < _RATE_LIMIT_WINDOW]
    if len(valid) >= _RATE_LIMIT_MAX:
        _rate_store[ip] = valid
        return False
    valid.append(now)
    _rate_store[ip] = valid
    return True


# ── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(title="SlideUnlock API", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def enforce_size_limit(request: Request, call_next):
    cl = request.headers.get("content-length")
    if cl and int(cl) > _MAX_BYTES:
        return JSONResponse(status_code=413, content={"detail": "Request body exceeds 100 MB limit"})
    return await call_next(request)


# ── shared helpers ────────────────────────────────────────────────────────────

def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _bearer_token(request: Request) -> Optional[str]:
    auth = request.headers.get("Authorization", "")
    return auth[7:] if auth.startswith("Bearer ") else None


async def _read_validate(file: UploadFile) -> bytes:
    data = await file.read()
    if len(data) > _MAX_BYTES:
        raise HTTPException(413, "File exceeds 100 MB limit")
    if data[:4] != _PPTX_MAGIC:
        raise HTTPException(400, "Not a valid PPTX file (wrong magic bytes)")
    if not (file.filename or "").lower().endswith(".pptx"):
        raise HTTPException(400, "Only .pptx files are accepted")
    return data


# ── GET /health ───────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok"}


# ── POST /api/analyze ─────────────────────────────────────────────────────────

@app.post("/api/analyze")
async def analyze(request: Request, file: UploadFile):
    data = await _read_validate(file)

    tmp_dir = tempfile.mkdtemp(prefix="su_analyze_")
    try:
        pptx_path = os.path.join(tmp_dir, "input.pptx")
        with open(pptx_path, "wb") as f:
            f.write(data)

        # Step 1 — harvest style context
        with zipfile.ZipFile(pptx_path) as z:
            style_ctx = harvest(z)

        # Step 2 — classify slides
        reports = classify_all(pptx_path, style_ctx)

        # Steps 3+4 — dry-run lock strip and ungroup on a copy
        copy_path = os.path.join(tmp_dir, "copy.pptx")
        shutil.copy(pptx_path, copy_path)
        lock_changes  = strip_locks(copy_path)
        group_changes = flatten_groups(copy_path)

        flat_slide_nums = [r["slide_num"] for r in reports if r["is_flat_image"]]
        has_animations  = any(r["has_animations"] for r in reports)

        pass_through_counts: dict[str, int] = defaultdict(int)
        for r in reports:
            for pt in r.get("pass_through_shapes", []):
                pass_through_counts[pt["type"]] += 1

        return {
            "filename":                file.filename,
            "total_slides":            len(reports),
            "slide_cx_emu":            style_ctx["slide_cx_emu"],
            "slide_cy_emu":            style_ctx["slide_cy_emu"],
            "theme_colors":            style_ctx["theme_colors"],
            "flat_image_slides":       flat_slide_nums,
            "pass_through_shape_counts": dict(pass_through_counts),
            "locked_elements_count":   len(lock_changes),
            "grouped_elements_count":  len(group_changes),
            "has_animations":          has_animations,
            "estimated_seconds":       len(flat_slide_nums) * 70 + 5,
        }

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


# ── POST /api/unlock ──────────────────────────────────────────────────────────

@app.post("/api/unlock")
async def unlock_endpoint(
    request: Request,
    background_tasks: BackgroundTasks,
    file: UploadFile,
    basic_only: bool = Form(default=True),
    reconstruct_flat: bool = Form(default=False),
):
    token = _bearer_token(request)
    ip    = _client_ip(request)

    # Reconstruction requires auth
    if reconstruct_flat and not basic_only:
        if not token:
            raise HTTPException(401, "Authentication required for reconstruction mode")
        if _sb:
            try:
                _sb.auth.get_user(token)
            except Exception:
                raise HTTPException(401, "Invalid or expired token")

    # Rate-limit anonymous unlock requests
    if not token and not _check_rate_limit(ip):
        raise HTTPException(429, "Rate limit exceeded: 3 free unlocks per day")

    data              = await _read_validate(file)
    job_id            = str(uuid.uuid4())
    original_filename = file.filename or "upload.pptx"

    if _sb:
        _sb.table("jobs").insert({
            "id":                job_id,
            "status":            "queued",
            "original_filename": original_filename,
            "created_at":        datetime.now(timezone.utc).isoformat(),
        }).execute()

    background_tasks.add_task(
        _run_unlock_job,
        job_id=job_id,
        pptx_bytes=data,
        original_filename=original_filename,
        basic_only=basic_only,
        reconstruct_flat=reconstruct_flat,
    )

    return {"job_id": job_id, "status": "queued"}


async def _run_unlock_job(
    job_id: str,
    pptx_bytes: bytes,
    original_filename: str,
    basic_only: bool,
    reconstruct_flat: bool,
) -> None:
    def _sync() -> None:
        tmp_dir     = tempfile.mkdtemp(prefix=f"su_job_{job_id[:8]}_")
        input_path  = os.path.join(tmp_dir, "input.pptx")
        output_path = os.path.join(tmp_dir, "output.pptx")
        try:
            with open(input_path, "wb") as f:
                f.write(pptx_bytes)

            if _sb:
                _sb.table("jobs").update({"status": "processing"}).eq("id", job_id).execute()

            result = unlock(
                input_path=input_path,
                output_path=output_path,
                basic_only=basic_only,
                reconstruct_flat=reconstruct_flat,
            )

            ssim_scores = {
                str(s["slide_num"]): s["ssim_score"]
                for s in result["slides"]
                if s.get("ssim_score") is not None
            }

            output_file_url: Optional[str] = None
            if _sb:
                stem        = original_filename.rsplit(".", 1)[0]
                storage_key = f"{job_id}/{stem}_unlocked.pptx"
                with open(output_path, "rb") as f:
                    raw = f.read()
                _sb.storage.from_("pptx-processed").upload(
                    storage_key,
                    raw,
                    {"content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation"},
                )
                output_file_url = (
                    _sb.storage.from_("pptx-processed").get_public_url(storage_key)
                )
                _sb.table("jobs").update({
                    "status":           "done",
                    "output_file_url":  output_file_url,
                    "ssim_scores":      ssim_scores,
                    "slide_count":      len(result["slides"]),
                    "flat_slide_count": sum(
                        1 for s in result["slides"] if s.get("reconstruction_status") != "skipped"
                    ),
                    "completed_at":     datetime.now(timezone.utc).isoformat(),
                }).eq("id", job_id).execute()

            log.info("Job %s done — %d slides, ssim=%s", job_id, len(result["slides"]), ssim_scores)

        except Exception as exc:
            log.exception("Job %s failed", job_id)
            if _sb:
                _sb.table("jobs").update({
                    "status":       "failed",
                    "error":        str(exc)[:2000],
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                }).eq("id", job_id).execute()
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    await asyncio.to_thread(_sync)


# ── GET /api/job/{job_id} ─────────────────────────────────────────────────────

_PHASE_LABELS = {
    "queued":     "Queued — waiting to start",
    "processing": "Processing — unlocking your file",
    "done":       "Done — your file is ready",
    "failed":     "Failed",
}


@app.get("/api/job/{job_id}")
async def get_job(job_id: str):
    if not _sb:
        raise HTTPException(503, "Database not configured")
    try:
        row = _sb.table("jobs").select("*").eq("id", job_id).single().execute()
    except Exception:
        raise HTTPException(404, f"Job {job_id!r} not found")

    d = row.data
    status = d.get("status", "unknown")
    return {
        "status":       status,
        "phase_label":  _PHASE_LABELS.get(status, status),
        "ssim_scores":  d.get("ssim_scores"),
        "download_url": d.get("output_file_url"),
        "error":        d.get("error"),
    }


# ── GET /api/download/{file_id} ───────────────────────────────────────────────

@app.get("/api/download/{file_id:path}")
async def download(file_id: str, original_name: str = "output.pptx"):
    if not _sb:
        raise HTTPException(503, "Database not configured")
    try:
        raw = _sb.storage.from_("pptx-processed").download(file_id)
    except Exception:
        raise HTTPException(404, "File not found in storage")

    stem     = original_name.rsplit(".", 1)[0]
    out_name = f"unlocked_{stem}.pptx"
    return StreamingResponse(
        iter([raw]),
        media_type=(
            "application/vnd.openxmlformats-officedocument"
            ".presentationml.presentation"
        ),
        headers={"Content-Disposition": f'attachment; filename="{out_name}"'},
    )


# ── POST /api/webhook/stripe ──────────────────────────────────────────────────

_SUBSCRIPTION_PLAN: dict[str, str] = {
    "customer.subscription.created": "active",
    "customer.subscription.updated": "active",
    "customer.subscription.deleted": "free",
}


@app.post("/api/webhook/stripe")
async def stripe_webhook(request: Request):
    if not STRIPE_WEBHOOK_SECRET:
        raise HTTPException(503, "Stripe not configured")

    payload = await request.body()
    sig     = request.headers.get("stripe-signature", "")

    try:
        event = stripe.Webhook.construct_event(payload, sig, STRIPE_WEBHOOK_SECRET)
    except Exception as exc:
        log.warning("Stripe webhook error: %s", exc)
        raise HTTPException(400, "Invalid Stripe signature or payload")

    event_type   = event["type"]
    subscription = event.get("data", {}).get("object", {})
    customer_id  = subscription.get("customer")

    plan = _SUBSCRIPTION_PLAN.get(event_type)
    if plan and customer_id and _sb:
        _sb.table("users").update({"plan": plan}).eq(
            "stripe_customer_id", customer_id
        ).execute()
        log.info("Stripe %s → customer=%s plan=%s", event_type, customer_id, plan)

    return {"received": True}
