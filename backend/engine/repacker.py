import logging
import os
import posixpath
import warnings
import zipfile
from lxml import etree

logger = logging.getLogger(__name__)


def repack(
    input_pptx_path: str,
    output_pptx_path: str,
    modified_entries: dict[str, bytes],
    new_media: dict[str, bytes] | None = None,
) -> None:
    with zipfile.ZipFile(input_pptx_path, "r") as zin:
        with zipfile.ZipFile(output_pptx_path, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                if item.filename in modified_entries:
                    zout.writestr(item, modified_entries[item.filename])
                else:
                    zout.writestr(item, zin.read(item.filename))

            if new_media:
                for media_path, media_bytes in new_media.items():
                    zout.writestr(media_path, media_bytes)

    with zipfile.ZipFile(output_pptx_path, "r") as z:
        names = set(z.namelist())

        ct = z.read("[Content_Types].xml")
        etree.fromstring(ct)

        for name in names:
            if not name.endswith(".rels"):
                continue
            rels_xml = z.read(name)
            tree = etree.fromstring(rels_xml)
            ns = "{http://schemas.openxmlformats.org/package/2006/relationships}"
            for rel in tree.findall(f"{ns}Relationship"):
                target = rel.get("Target")
                if not target or target.startswith("http") or target.startswith("/"):
                    continue
                parts = name.split("/")
                base = "/".join(parts[: parts.index("_rels")])
                resolved = posixpath.normpath(base + "/" + target if base else target)
                if resolved not in names:
                    warnings.warn(f"Broken rId target: {resolved} (from {name})")

    size = os.path.getsize(output_pptx_path)
    logger.info("Repacked to %s (%d bytes)", output_pptx_path, size)
