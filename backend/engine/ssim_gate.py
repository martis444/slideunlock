import logging
import os
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image
from skimage.metrics import structural_similarity

from lxml import etree

log = logging.getLogger(__name__)

_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
_A = "http://schemas.openxmlformats.org/drawingml/2006/main"

_DRAWABLE_TAGS = frozenset(["sp", "pic", "cxnSp", "graphicFrame"])


# ── public helpers ────────────────────────────────────────────────────────────

def render_slide_to_png(pptx_path: str, slide_index: int, tmp_dir: str) -> bytes:
    """
    Use LibreOffice headless to render one slide from a PPTX to PNG bytes.
    Clears stale output files before each run so we always read fresh output.
    """
    soffice = _find_soffice()
    stem = Path(pptx_path).stem

    # Remove stale PNGs from a previous render of the same file
    for stale in Path(tmp_dir).glob(f"{stem}*.png"):
        stale.unlink(missing_ok=True)

    subprocess.run(
        [soffice, "--headless", "--convert-to", "png", "--outdir", tmp_dir, pptx_path],
        capture_output=True,
        timeout=120,
        check=False,
    )

    # Probe several naming patterns LibreOffice uses across versions/platforms
    candidates = [
        Path(tmp_dir) / f"{stem}-{slide_index + 1:03d}.png",
        Path(tmp_dir) / f"{stem}.png",
        Path(tmp_dir) / f"{stem}-{slide_index + 1}.png",
    ]
    for c in candidates:
        if c.exists():
            return c.read_bytes()

    # Fall back: pick the (slide_index)-th sorted PNG in tmp_dir
    all_pngs = sorted(Path(tmp_dir).glob(f"{stem}*.png"))
    if all_pngs:
        idx = min(slide_index, len(all_pngs) - 1)
        return all_pngs[idx].read_bytes()

    raise RuntimeError(
        f"LibreOffice produced no PNG output for {pptx_path!r} "
        f"(slide {slide_index}, searched {tmp_dir})"
    )


def compute_ssim(img1_bytes: bytes, img2_bytes: bytes) -> float:
    """SSIM between two images; img2 is resized to match img1 if needed."""
    arr1 = np.asarray(Image.open(img1_bytes if hasattr(img1_bytes, "read") else
                                  __import__("io").BytesIO(img1_bytes)).convert("RGB"))
    img2 = Image.open(img2_bytes if hasattr(img2_bytes, "read") else
                       __import__("io").BytesIO(img2_bytes)).convert("RGB")
    if img2.size != (arr1.shape[1], arr1.shape[0]):
        img2 = img2.resize((arr1.shape[1], arr1.shape[0]), Image.LANCZOS)
    arr2 = np.asarray(img2)
    return float(structural_similarity(arr1, arr2, channel_axis=2))


def unhide_fallback_png(slide_shapes_spTree) -> None:
    """Remove hidden='1' from the __fallback_png__ cNvPr so it renders visible."""
    for elem in slide_shapes_spTree.iter():
        cNvPr = None
        if elem.tag == f"{{{_P}}}cNvPr":
            cNvPr = elem
        if cNvPr is not None and cNvPr.get("descr") == "__fallback_png__":
            cNvPr.attrib.pop("hidden", None)
            return


# ── private helpers ───────────────────────────────────────────────────────────

def _find_soffice() -> str:
    for candidate in [
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
        "/usr/bin/soffice",
        "/usr/bin/libreoffice",
    ]:
        if os.path.isfile(candidate):
            return candidate
    found = shutil.which("soffice") or shutil.which("libreoffice")
    return found or "soffice"


def _slide_root(spTree) -> etree._Element:
    """Walk up the element tree to find the <p:sld> root."""
    node = spTree
    while node.getparent() is not None:
        node = node.getparent()
    return node


def _write_slide_xml(pptx_path: str, slide_index: int, root_elem: etree._Element) -> None:
    """Replace the slide XML entry inside the PPTX zip atomically."""
    entry = f"ppt/slides/slide{slide_index + 1}.xml"
    xml_bytes = etree.tostring(
        root_elem,
        xml_declaration=True,
        encoding="UTF-8",
        standalone=True,
    )
    tmp = pptx_path + "._ssim_tmp"
    with zipfile.ZipFile(pptx_path, "r") as zin:
        with zipfile.ZipFile(tmp, "w") as zout:
            for info in zin.infolist():
                data = xml_bytes if info.filename == entry else zin.read(info.filename)
                zout.writestr(info, data)
    os.replace(tmp, pptx_path)


def _drawable_shapes(spTree) -> list:
    """Return non-fallback drawable shape elements in document order."""
    result = []
    for elem in spTree:
        local = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
        if local not in _DRAWABLE_TAGS:
            continue
        cNvPr = elem.find(f".//{{{_P}}}cNvPr")
        if cNvPr is not None and cNvPr.get("descr") == "__fallback_png__":
            continue
        result.append(elem)
    return result


def _update_xfrm(elem, spec: dict) -> None:
    """Sync x, y, cx, cy from spec into the element's <a:xfrm>."""
    xfrm = elem.find(f".//{{{_A}}}xfrm")
    if xfrm is None:
        return
    off = xfrm.find(f"{{{_A}}}off")
    ext = xfrm.find(f"{{{_A}}}ext")
    if off is not None:
        off.set("x",  str(spec["x"]))
        off.set("y",  str(spec["y"]))
    if ext is not None:
        ext.set("cx", str(spec["cx"]))
        ext.set("cy", str(spec["cy"]))


# ── main API ──────────────────────────────────────────────────────────────────

def verify_and_nudge(
    original_slide_image: bytes,
    rebuilt_pptx_path: str,
    slide_index: int,
    slide_shapes_spTree,
    specs: list[dict],
    ssim_threshold: float = 0.995,
) -> tuple[bool, float, str]:
    """
    Render the rebuilt PPTX, compare SSIM against the original slide image, and
    attempt geometric nudges to recover lost fidelity.

    Returns (passed, final_ssim, status) where status is 'done' or 'fallback_png'.
    Never raises — any unexpected error returns (False, 0.0, 'fallback_png').
    """
    tmp_dir = tempfile.mkdtemp(prefix="ssim_")
    try:
        slide_root = _slide_root(slide_shapes_spTree)

        # Build spec-id → element mapping using insertion order from build_slide
        sorted_specs = sorted(specs, key=lambda s: s.get("z_order", 0))
        elems        = _drawable_shapes(slide_shapes_spTree)
        spec_to_elem = {s["id"]: e for s, e in zip(sorted_specs, elems)}

        def _render() -> bytes:
            """Sync all spec xfrm values, save zip, render, return PNG bytes."""
            for s in specs:
                e = spec_to_elem.get(s["id"])
                if e is not None:
                    _update_xfrm(e, s)
            _write_slide_xml(rebuilt_pptx_path, slide_index, slide_root)
            return render_slide_to_png(rebuilt_pptx_path, slide_index, tmp_dir)

        def _ssim_after_nudge() -> float:
            return compute_ssim(original_slide_image, _render())

        # ── initial render ────────────────────────────────────────────────────
        initial_png = render_slide_to_png(rebuilt_pptx_path, slide_index, tmp_dir)
        score = compute_ssim(original_slide_image, initial_png)
        if score >= ssim_threshold:
            return (True, score, "done")

        # ── Round 1: cx nudge on mixed-font text boxes ────────────────────────
        mixed_font_specs = [
            s for s in specs
            if "text_runs" in s
            and len({
                r["font_name"]
                for r in s["text_runs"]
                if not r.get("paragraph_break") and "font_name" in r
            }) > 1
        ]
        for spec in mixed_font_specs[:5]:
            for delta in (+914, -914, +1828, -1828):
                spec["cx"] += delta
                new_score = _ssim_after_nudge()
                if new_score > score:
                    score = new_score
                    break
                spec["cx"] -= delta   # revert
            if score >= ssim_threshold:
                return (True, score, "done")

        # ── Round 2: best single x/y nudge across all shapes ─────────────────
        best_delta: tuple | None = None
        best_score = score
        for spec in specs:
            for axis in ("x", "y"):
                for delta in (+914, -914):
                    spec[axis] += delta
                    new_score = _ssim_after_nudge()
                    if new_score - score >= 0.001 and new_score > best_score:
                        best_score = new_score
                        best_delta = (spec["id"], axis, delta)
                    spec[axis] -= delta   # always revert during search

        if best_delta:
            sid, axis, delta = best_delta
            target = next(s for s in specs if s["id"] == sid)
            target[axis] += delta
            score = best_score

        if score >= ssim_threshold:
            return (True, score, "done")

        # ── Round 3: cy nudge on 3 tallest text boxes ─────────────────────────
        text_specs = sorted(
            [s for s in specs if "text_runs" in s],
            key=lambda s: s["cy"],
            reverse=True,
        )[:3]
        for spec in text_specs:
            for delta in (+914, -914):
                spec["cy"] += delta
                new_score = _ssim_after_nudge()
                if new_score > score:
                    score = new_score
                    break
                spec["cy"] -= delta

        # ── final render ──────────────────────────────────────────────────────
        final_png = render_slide_to_png(rebuilt_pptx_path, slide_index, tmp_dir)
        score = compute_ssim(original_slide_image, final_png)

        if score >= ssim_threshold:
            return (True, score, "done")

        unhide_fallback_png(slide_shapes_spTree)
        return (False, score, "fallback_png")

    except Exception:
        log.exception("verify_and_nudge: unexpected error")
        try:
            unhide_fallback_png(slide_shapes_spTree)
        except Exception:
            pass
        return (False, 0.0, "fallback_png")

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
