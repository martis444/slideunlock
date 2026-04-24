import logging
import re
from zipfile import ZipFile

from lxml import etree

log = logging.getLogger(__name__)

_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
_A = "http://schemas.openxmlformats.org/drawingml/2006/main"

_FILE_PAT = re.compile(r"ppt/slides/slide\d+\.xml$")
_MAX_ITER = 20
_DRAWABLE = frozenset(["sp", "pic", "cxnSp", "grpSp"])


def _local(key: str) -> str:
    return key.split("}", 1)[-1] if "}" in key else key


def _is_smartart(grp_sp: etree._Element) -> bool:
    """Return True if any descendant carries a dgmRelIds attribute (SmartArt)."""
    return any(
        _local(k) == "dgmRelIds"
        for elem in grp_sp.iter()
        for k in elem.attrib
    )


def _get_xfrm(elem: etree._Element) -> etree._Element | None:
    """Return <a:xfrm> from <p:grpSpPr> (groups) or <p:spPr> (shapes)."""
    for pr_tag in (f"{{{_P}}}grpSpPr", f"{{{_P}}}spPr"):
        pr = elem.find(pr_tag)
        if pr is not None:
            xfrm = pr.find(f"{{{_A}}}xfrm")
            if xfrm is not None:
                return xfrm
    return None


def _flatten_once(sp_tree: etree._Element, slide_cx: int, slide_cy: int) -> int:
    """
    Promote all direct grpSp children of sp_tree into sp_tree, applying
    the group transform to each child's position and size.
    Returns the number of groups removed.
    """
    grp_sps = [
        ch for ch in list(sp_tree)
        if _local(ch.tag) == "grpSp" and not _is_smartart(ch)
    ]

    flattened = 0

    for grp_sp in grp_sps:
        grp_sp_pr = grp_sp.find(f"{{{_P}}}grpSpPr")
        if grp_sp_pr is None:
            continue

        grp_xfrm = grp_sp_pr.find(f"{{{_A}}}xfrm")
        if grp_xfrm is None:
            continue

        off    = grp_xfrm.find(f"{{{_A}}}off")
        ext    = grp_xfrm.find(f"{{{_A}}}ext")
        ch_off = grp_xfrm.find(f"{{{_A}}}chOff")
        ch_ext = grp_xfrm.find(f"{{{_A}}}chExt")

        if any(e is None for e in (off, ext, ch_off, ch_ext)):
            continue

        GX   = int(off.get("x",  0))
        GY   = int(off.get("y",  0))
        GCX  = int(ext.get("cx", 0))
        GCY  = int(ext.get("cy", 0))
        CHOX = int(ch_off.get("x",  0))
        CHOY = int(ch_off.get("y",  0))
        CHCX = int(ch_ext.get("cx", 0))
        CHCY = int(ch_ext.get("cy", 0))

        if CHCX == 0 or CHCY == 0:
            continue  # degenerate group; avoid div-by-zero

        scale_x = GCX / CHCX
        scale_y = GCY / CHCY
        grp_rot = int(grp_xfrm.get("rot", 0))

        # Snapshot insertion point before we mutate sp_tree
        idx = list(sp_tree).index(grp_sp)

        for child in list(grp_sp):
            if _local(child.tag) not in _DRAWABLE:
                continue

            child_xfrm = _get_xfrm(child)
            if child_xfrm is not None:
                child_off = child_xfrm.find(f"{{{_A}}}off")
                child_ext = child_xfrm.find(f"{{{_A}}}ext")

                if child_off is not None and child_ext is not None:
                    CX  = int(child_off.get("x",  0))
                    CY  = int(child_off.get("y",  0))
                    CCX = int(child_ext.get("cx", 0))
                    CCY = int(child_ext.get("cy", 0))
                    child_rot = int(child_xfrm.get("rot", 0))

                    abs_x   = int(GX + (CX - CHOX) * scale_x)
                    abs_y   = int(GY + (CY - CHOY) * scale_y)
                    abs_cx  = int(CCX * scale_x)
                    abs_cy  = int(CCY * scale_y)
                    abs_rot = grp_rot + child_rot

                    child_off.set("x",  str(abs_x))
                    child_off.set("y",  str(abs_y))
                    child_ext.set("cx", str(abs_cx))
                    child_ext.set("cy", str(abs_cy))

                    if abs_rot != 0:
                        child_xfrm.set("rot", str(abs_rot))

                    # Preserve chOff/chExt on nested grpSp — they define the
                    # internal coordinate space needed by the next iteration.

            grp_sp.remove(child)
            sp_tree.insert(idx, child)
            idx += 1

        sp_tree.remove(grp_sp)
        flattened += 1

    return flattened


def flatten_groups(zip_path: str) -> dict[str, bytes]:
    """
    Iteratively flatten all groups in every slide of a PPTX zip.
    Returns {zip_entry_name: modified_bytes} for changed slides only.
    Does not write to disk.
    """
    changed: dict[str, bytes] = {}

    with ZipFile(zip_path) as zf:
        slide_cx, slide_cy = 12192000, 6858000
        try:
            with zf.open("ppt/presentation.xml") as f:
                prs_root = etree.parse(f).getroot()
            sld_sz = prs_root.find(f".//{{{_P}}}sldSz")
            if sld_sz is not None:
                slide_cx = int(sld_sz.get("cx", slide_cx))
                slide_cy = int(sld_sz.get("cy", slide_cy))
        except (KeyError, etree.XMLSyntaxError):
            pass

        targets = sorted(
            name for name in zf.namelist()
            if _FILE_PAT.match(name)
        )

        for name in targets:
            original = zf.read(name)
            try:
                root = etree.fromstring(original)
            except etree.XMLSyntaxError:
                log.warning("Skipping unparseable slide: %s", name)
                continue

            sp_tree = root.find(f".//{{{_P}}}spTree")
            if sp_tree is None:
                continue

            total_flattened = 0
            for _ in range(_MAX_ITER):
                n = _flatten_once(sp_tree, slide_cx, slide_cy)
                total_flattened += n
                if n == 0:
                    break

            if total_flattened > 0:
                modified = etree.tostring(
                    root,
                    xml_declaration=True,
                    encoding="UTF-8",
                    standalone=True,
                )
                changed[name] = modified
                label = name.rsplit("/", 1)[-1]
                log.info("Flattened %d group(s) from %s", total_flattened, label)

    return changed
