import posixpath
import re
from zipfile import ZipFile

from lxml import etree

_P     = "http://schemas.openxmlformats.org/presentationml/2006/main"
_A     = "http://schemas.openxmlformats.org/drawingml/2006/main"
_R     = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_RELS  = "http://schemas.openxmlformats.org/package/2006/relationships"

_SLIDE_PAT = re.compile(r"ppt/slides/slide(\d+)\.xml$")


# ── small helpers ────────────────────────────────────────────────────────────

def _local(key: str) -> str:
    return key.split("}", 1)[-1] if "}" in key else key


def _parse_rels(rels_bytes: bytes) -> dict[str, str]:
    """Return {rId: Target} from a .rels XML blob."""
    if not rels_bytes:
        return {}
    root = etree.fromstring(rels_bytes)
    return {
        rel.get("Id"): rel.get("Target", "")
        for rel in root.iter(f"{{{_RELS}}}Relationship")
        if rel.get("Id")
    }


def _resolve_media_path(target: str) -> str:
    """Turn a rels-relative Target into a normalised zip-entry path."""
    return posixpath.normpath("ppt/slides/" + target)


def _shape_id(elem: etree._Element) -> str | None:
    cNvPr = elem.find(f".//{{{_P}}}cNvPr")
    return cNvPr.get("id") if cNvPr is not None else None


def _first_rid(elem: etree._Element) -> str | None:
    """Return the first r:id / r:embed / r:link found in elem's subtree."""
    for e in elem.iter():
        for suffix in ("id", "embed", "link"):
            val = e.get(f"{{{_R}}}{suffix}")
            if val:
                return val
    return None


def _graphicdata_uri(frame: etree._Element) -> str:
    gd = frame.find(f".//{{{_A}}}graphicData")
    return gd.get("uri", "") if gd is not None else ""


_DECORATIVE_PH_TYPES = frozenset(["title", "sldNum", "dt", "ftr", "hdr"])

def _is_decorative_ph(sp: etree._Element) -> bool:
    """True for placeholders that carry no user content (title, slide#, date, footer)."""
    ph = sp.find(f".//{{{_P}}}ph")
    return ph is not None and ph.get("type", "body") in _DECORATIVE_PH_TYPES


def _has_dgm_relids(elem: etree._Element) -> bool:
    return any(
        _local(k) == "dgmRelIds"
        for e in elem.iter()
        for k in e.attrib
    )


def _pic_ext(pic: etree._Element) -> tuple[int, int]:
    """Return (cx, cy) from a pic's spPr xfrm, or (0, 0) if absent."""
    sp_pr = pic.find(f"{{{_P}}}spPr")
    if sp_pr is None:
        return 0, 0
    xfrm = sp_pr.find(f"{{{_A}}}xfrm")
    if xfrm is None:
        return 0, 0
    ext = xfrm.find(f"{{{_A}}}ext")
    if ext is None:
        return 0, 0
    return int(ext.get("cx", 0)), int(ext.get("cy", 0))


def _pic_rid(pic: etree._Element) -> str | None:
    blip = pic.find(f".//{{{_A}}}blip")
    if blip is not None:
        rid = blip.get(f"{{{_R}}}embed")
        if rid:
            return rid
    return _first_rid(pic)


# ── main classifiers ─────────────────────────────────────────────────────────

def classify_slide(
    slide_xml_bytes: bytes,
    rels_xml_bytes: bytes,
    slide_cx: int,
    slide_cy: int,
    slide_num: int,
) -> dict:
    """
    Analyse one slide and return a SlideReport dict.
    """
    root = etree.fromstring(slide_xml_bytes)
    rels = _parse_rels(rels_xml_bytes)

    sp_tree = root.find(f".//{{{_P}}}spTree")
    if sp_tree is None:
        return {
            "slide_num": slide_num,
            "is_flat_image": False,
            "flat_image_rId": None,
            "flat_image_media_path": None,
            "pass_through_shapes": [],
            "native_shape_count": 0,
            "image_count": 0,
            "has_animations": False,
        }

    sps     = sp_tree.findall(f".//{{{_P}}}sp")
    pics    = sp_tree.findall(f".//{{{_P}}}pic")
    frames  = sp_tree.findall(f".//{{{_P}}}graphicFrame")

    pass_through: list[dict] = []
    smartart_sp_ids: set[int] = set()
    video_pic_ids: set[int]   = set()

    # SmartArt via sp (dgmRelIds on any descendant)
    for sp in sps:
        if _has_dgm_relids(sp):
            pass_through.append({
                "type": "SmartArt",
                "shape_id": _shape_id(sp),
                "rId": _first_rid(sp),
            })
            smartart_sp_ids.add(id(sp))

    # graphicFrame shapes
    for frame in frames:
        uri = _graphicdata_uri(frame)
        entry = {"shape_id": _shape_id(frame), "rId": _first_rid(frame)}
        if "diagram" in uri:
            pass_through.append({**entry, "type": "SmartArt"})
        elif "chart" in uri:
            pass_through.append({**entry, "type": "Chart"})
        elif "table" in uri:
            pass_through.append({**entry, "type": "Table"})

    # Video pics
    for pic in pics:
        if pic.find(f".//{{{_A}}}videoFile") is not None:
            pass_through.append({
                "type": "Video",
                "shape_id": _shape_id(pic),
                "rId": _first_rid(pic),
            })
            video_pic_ids.add(id(pic))

    # Animations
    has_animations = root.find(f".//{{{_P}}}timing") is not None

    native_sps  = [sp  for sp  in sps  if id(sp)  not in smartart_sp_ids]
    image_pics  = [pic for pic in pics if id(pic) not in video_pic_ids]

    native_shape_count = len(native_sps)
    image_count        = len(image_pics)

    # ── Flat-image detection ─────────────────────────────────────────────────
    is_flat_image        = False
    flat_image_rId       = None
    flat_image_media_path = None

    if len(image_pics) == 1:
        the_pic = image_pics[0]
        pcx, pcy = _pic_ext(the_pic)
        if pcx > 0 and pcy > 0:
            coverage = (pcx * pcy) / (slide_cx * slide_cy)
            if coverage >= 0.60:
                is_flat_image  = True
                flat_image_rId = _pic_rid(the_pic)
                if flat_image_rId and flat_image_rId in rels:
                    flat_image_media_path = _resolve_media_path(
                        rels[flat_image_rId]
                    )

    return {
        "slide_num":             slide_num,
        "is_flat_image":         is_flat_image,
        "flat_image_rId":        flat_image_rId,
        "flat_image_media_path": flat_image_media_path,
        "pass_through_shapes":   pass_through,
        "native_shape_count":    native_shape_count,
        "image_count":           image_count,
        "has_animations":        has_animations,
    }


def classify_all(zip_path: str, style_ctx: dict) -> list[dict]:
    """
    Classify every slide in a PPTX zip.  Uses slide dimensions from style_ctx
    (as returned by harvester.harvest).
    """
    slide_cx = style_ctx.get("slide_cx_emu", 12192000)
    slide_cy = style_ctx.get("slide_cy_emu", 6858000)

    results: list[dict] = []

    with ZipFile(zip_path) as zf:
        slides = sorted(
            (int(m.group(1)), name)
            for name in zf.namelist()
            for m in (_SLIDE_PAT.match(name),)
            if m
        )

        for slide_num, name in slides:
            slide_bytes = zf.read(name)

            basename  = name.rsplit("/", 1)[-1]
            rels_path = f"ppt/slides/_rels/{basename}.rels"
            try:
                rels_bytes = zf.read(rels_path)
            except KeyError:
                rels_bytes = b""

            results.append(
                classify_slide(slide_bytes, rels_bytes, slide_cx, slide_cy, slide_num)
            )

    return results
