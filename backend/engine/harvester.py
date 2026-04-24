import json
import re
import sys
from io import BytesIO
from xml.etree import ElementTree as ET
from zipfile import ZipFile

import numpy as np
from PIL import Image
from sklearn.cluster import KMeans

_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
_REL_IMAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"

NS = {"a": _A, "p": _P}

_COLOR_KEYS = ["dk1", "lt1", "dk2", "lt2",
               "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"]


def _parse_slide_size(zip_file: ZipFile) -> tuple[int, int]:
    try:
        with zip_file.open("ppt/presentation.xml") as f:
            root = ET.parse(f).getroot()
        sld_sz = root.find(".//p:sldSz", NS)
        if sld_sz is not None:
            return int(sld_sz.get("cx", 12192000)), int(sld_sz.get("cy", 6858000))
    except KeyError:
        pass
    return 12192000, 6858000


def _parse_theme_colors(zip_file: ZipFile) -> list[str]:
    try:
        with zip_file.open("ppt/theme/theme1.xml") as f:
            root = ET.parse(f).getroot()
    except KeyError:
        return []

    clr_scheme = root.find(f".//{{{_A}}}themeElements/{{{_A}}}clrScheme")
    if clr_scheme is None:
        return []

    colors: list[str] = []
    for key in _COLOR_KEYS:
        elem = clr_scheme.find(f"{{{_A}}}{key}")
        if elem is None:
            continue
        srgb = elem.find(f"{{{_A}}}srgbClr")
        if srgb is not None:
            colors.append(srgb.get("val", "000000"))
            continue
        sys_clr = elem.find(f"{{{_A}}}sysClr")
        if sys_clr is not None:
            colors.append(sys_clr.get("lastClr", "000000"))
    return colors


def _parse_font_names(zip_file: ZipFile) -> list[str]:
    fonts: set[str] = set()

    for name in zip_file.namelist():
        if name.startswith("ppt/fonts/") and name != "ppt/fonts/":
            stem = name.rsplit("/", 1)[-1].rsplit(".", 1)[0]
            if stem:
                fonts.add(stem)

    try:
        with zip_file.open("ppt/theme/theme1.xml") as f:
            root = ET.parse(f).getroot()
        font_scheme = root.find(f".//{{{_A}}}fontScheme")
        if font_scheme is not None:
            for font_list in font_scheme:  # a:majorFont, a:minorFont
                for font_elem in font_list:
                    tf = font_elem.get("typeface", "")
                    if tf and not tf.startswith("+"):
                        fonts.add(tf)
    except KeyError:
        pass

    return sorted(fonts)


def _dominant_colors(data: bytes, k: int = 5) -> list[str]:
    img = Image.open(BytesIO(data)).convert("RGB").resize((50, 50), Image.LANCZOS)
    pixels = np.asarray(img, dtype=np.float32).reshape(-1, 3)
    k = min(k, len(pixels))
    km = KMeans(n_clusters=k, random_state=0, n_init="auto")
    km.fit(pixels)
    counts = np.bincount(km.labels_, minlength=k)
    order = np.argsort(-counts)
    return ["{:02x}{:02x}{:02x}".format(*map(int, km.cluster_centers_[i])) for i in order]


def _parse_image_colors(zip_file: ZipFile) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    media_cache: dict[str, list[str]] = {}  # media_path -> colors

    rel_paths = sorted(
        n for n in zip_file.namelist()
        if re.match(r"ppt/slides/_rels/slide\d+\.xml\.rels$", n)
    )

    for rel_path in rel_paths:
        with zip_file.open(rel_path) as f:
            root = ET.parse(f).getroot()

        for rel in root:
            if rel.get("Type") != _REL_IMAGE:
                continue
            r_id = rel.get("Id", "")
            target = rel.get("Target", "")

            # Resolve ../media/imageN.ext -> ppt/media/imageN.ext
            if target.startswith("../"):
                media_path = "ppt/" + target[3:]
            else:
                media_path = "ppt/slides/" + target

            if r_id in result:
                continue

            if media_path in media_cache:
                result[r_id] = media_cache[media_path]
                continue

            try:
                with zip_file.open(media_path) as img_f:
                    data = img_f.read()
                colors = _dominant_colors(data)
                media_cache[media_path] = colors
                result[r_id] = colors
            except Exception:
                # Skip unreadable formats (WMF, EMF, SVG, corrupted files)
                pass

    return result


def harvest(pptx_zip: ZipFile) -> dict:
    cx, cy = _parse_slide_size(pptx_zip)
    return {
        "slide_cx_emu": cx,
        "slide_cy_emu": cy,
        "theme_colors": _parse_theme_colors(pptx_zip),
        "font_names": _parse_font_names(pptx_zip),
        "image_dominant_hex": _parse_image_colors(pptx_zip),
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python harvester.py <file.pptx>", file=sys.stderr)
        sys.exit(1)
    with ZipFile(sys.argv[1]) as zf:
        ctx = harvest(zf)
    ctx_display = dict(ctx)
    ctx_display["image_dominant_hex"] = {
        k: v for k, v in list(ctx["image_dominant_hex"].items())[:3]
    }
    print(json.dumps(ctx_display, indent=2))
    print(f"\n({len(ctx['image_dominant_hex'])} total image entries)")
