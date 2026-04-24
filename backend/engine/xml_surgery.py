import logging
import re
from zipfile import ZipFile

from lxml import etree

log = logging.getLogger(__name__)

_LOCK_ELEMENTS = frozenset(["picLocks", "spLocks", "grpSpLocks"])
_LOCK_ATTRS = frozenset([
    "noGrp", "noMove", "noResize", "noRot",
    "noSelect", "noEdit", "fLocksText", "noChangeAspect",
])

_FILE_PATTERNS = [
    re.compile(r"ppt/slides/slide\d+\.xml$"),
    re.compile(r"ppt/slideLayouts/slideLayout\d+\.xml$"),
    re.compile(r"ppt/slideMasters/slideMaster\d+\.xml$"),
]


def _local(key: str) -> str:
    """Return the local name from a Clark-notation key like {ns}name."""
    return key.split("}", 1)[-1] if "}" in key else key


def _strip_one(xml_bytes: bytes) -> tuple[bytes, int]:
    root = etree.fromstring(xml_bytes)
    removed = 0

    for tag in _LOCK_ELEMENTS:
        for elem in root.xpath(f'.//*[local-name()="{tag}"]'):
            parent = elem.getparent()
            if parent is not None:
                parent.remove(elem)
                removed += 1

    for elem in root.iter():
        keys = [k for k in elem.attrib if _local(k) in _LOCK_ATTRS]
        for k in keys:
            del elem.attrib[k]
            removed += 1

    new_bytes = etree.tostring(
        root,
        xml_declaration=True,
        encoding="UTF-8",
        standalone=True,
    )
    return new_bytes, removed


def strip_locks(zip_path: str) -> dict[str, bytes]:
    """
    Strip picLocks / spLocks / grpSpLocks elements and all lock-related
    attributes from every slide, layout, and master in a PPTX zip.

    Returns a dict of {zip_entry_name: modified_bytes} for files that
    changed. Does not write to disk.
    """
    changed: dict[str, bytes] = {}

    with ZipFile(zip_path) as zf:
        targets = sorted(
            name for name in zf.namelist()
            if any(pat.match(name) for pat in _FILE_PATTERNS)
        )

        for name in targets:
            original = zf.read(name)
            try:
                modified, n_removed = _strip_one(original)
            except etree.XMLSyntaxError:
                log.warning("Skipping unparseable entry: %s", name)
                continue

            if n_removed > 0:
                changed[name] = modified
                label = name.rsplit("/", 1)[-1]
                log.info("Stripped %d lock elements from %s", n_removed, label)

    return changed
