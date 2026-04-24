"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface WasmUnlockZoneProps {
  onResult: (resultBytes: Uint8Array, filename: string) => void;
  onProgress: (pct: number, msg: string) => void;
}

// Minimal Pyodide surface we actually use
interface Pyodide {
  loadPackage(pkgs: string[]): Promise<void>;
  globals: { set(name: string, value: unknown): void };
  runPython(code: string): PyProxy;
}

interface PyProxy {
  toJs(): Uint8Array;
  destroy(): void;
}

declare global {
  interface Window {
    loadPyodide(opts: { indexURL: string }): Promise<Pyodide>;
  }
}

const PYODIDE_INDEX = "https://cdn.jsdelivr.net/pyodide/v0.25.1/full/";

// String.raw prevents TS from interpreting Python's \d, \., etc. as escape sequences
const PYTHON_PIPELINE = String.raw`
import io, re, zipfile
from lxml import etree

_LOCK_ELEMENTS = frozenset(["picLocks", "spLocks", "grpSpLocks"])
_LOCK_ATTRS = frozenset([
    "noGrp", "noMove", "noResize", "noRot",
    "noSelect", "noEdit", "fLocksText", "noChangeAspect",
])

_SLIDE_PATTERNS = [
    re.compile(r"ppt/slides/slide\d+\.xml$"),
    re.compile(r"ppt/slideLayouts/slideLayout\d+\.xml$"),
    re.compile(r"ppt/slideMasters/slideMaster\d+\.xml$"),
]
_FILE_PAT = re.compile(r"ppt/slides/slide\d+\.xml$")

_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
_MAX_ITER = 20
_DRAWABLE = frozenset(["sp", "pic", "cxnSp", "grpSp"])


def _local(key):
    return key.split("}", 1)[-1] if "}" in key else key


def _strip_one(xml_bytes):
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
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True), removed


def _is_smartart(grp_sp):
    return any(_local(k) == "dgmRelIds" for elem in grp_sp.iter() for k in elem.attrib)


def _get_xfrm(elem):
    for pr_tag in (f"{{{_P}}}grpSpPr", f"{{{_P}}}spPr"):
        pr = elem.find(pr_tag)
        if pr is not None:
            xfrm = pr.find(f"{{{_A}}}xfrm")
            if xfrm is not None:
                return xfrm
    return None


def _flatten_once(sp_tree, slide_cx, slide_cy):
    grp_sps = [ch for ch in list(sp_tree) if _local(ch.tag) == "grpSp" and not _is_smartart(ch)]
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
        GX,   GY   = int(off.get("x",  0)),    int(off.get("y",  0))
        GCX,  GCY  = int(ext.get("cx", 0)),    int(ext.get("cy", 0))
        CHOX, CHOY = int(ch_off.get("x",  0)), int(ch_off.get("y",  0))
        CHCX, CHCY = int(ch_ext.get("cx", 0)), int(ch_ext.get("cy", 0))
        if CHCX == 0 or CHCY == 0:
            continue
        scale_x = GCX / CHCX
        scale_y = GCY / CHCY
        grp_rot = int(grp_xfrm.get("rot", 0))
        idx = list(sp_tree).index(grp_sp)
        for child in list(grp_sp):
            if _local(child.tag) not in _DRAWABLE:
                continue
            child_xfrm = _get_xfrm(child)
            if child_xfrm is not None:
                c_off = child_xfrm.find(f"{{{_A}}}off")
                c_ext = child_xfrm.find(f"{{{_A}}}ext")
                if c_off is not None and c_ext is not None:
                    CX,  CY  = int(c_off.get("x",  0)), int(c_off.get("y",  0))
                    CCX, CCY = int(c_ext.get("cx", 0)), int(c_ext.get("cy", 0))
                    c_off.set("x",  str(int(GX + (CX - CHOX) * scale_x)))
                    c_off.set("y",  str(int(GY + (CY - CHOY) * scale_y)))
                    c_ext.set("cx", str(int(CCX * scale_x)))
                    c_ext.set("cy", str(int(CCY * scale_y)))
                    abs_rot = grp_rot + int(child_xfrm.get("rot", 0))
                    if abs_rot != 0:
                        child_xfrm.set("rot", str(abs_rot))
            grp_sp.remove(child)
            sp_tree.insert(idx, child)
            idx += 1
        sp_tree.remove(grp_sp)
        flattened += 1
    return flattened


def process_pptx_wasm(input_data):
    raw    = bytes(input_data)
    in_buf = io.BytesIO(raw)
    out_buf = io.BytesIO()
    overrides: dict = {}

    with zipfile.ZipFile(in_buf, "r") as zf:
        names = zf.namelist()

        slide_cx, slide_cy = 12192000, 6858000
        if "ppt/presentation.xml" in names:
            try:
                prs_root = etree.fromstring(zf.read("ppt/presentation.xml"))
                sld_sz   = prs_root.find(f".//{{{_P}}}sldSz")
                if sld_sz is not None:
                    slide_cx = int(sld_sz.get("cx", slide_cx))
                    slide_cy = int(sld_sz.get("cy", slide_cy))
            except Exception:
                pass

        for name in names:
            if not any(pat.match(name) for pat in _SLIDE_PATTERNS):
                continue
            original = zf.read(name)
            modified = original
            changed  = False

            try:
                stripped, n = _strip_one(modified)
                if n > 0:
                    modified = stripped
                    changed  = True
            except Exception:
                pass

            if _FILE_PAT.match(name):
                try:
                    root    = etree.fromstring(modified)
                    sp_tree = root.find(f".//{{{_P}}}spTree")
                    if sp_tree is not None:
                        total = 0
                        for _ in range(_MAX_ITER):
                            n      = _flatten_once(sp_tree, slide_cx, slide_cy)
                            total += n
                            if n == 0:
                                break
                        if total > 0:
                            modified = etree.tostring(
                                root, xml_declaration=True, encoding="UTF-8", standalone=True
                            )
                            changed = True
                except Exception:
                    pass

            if changed:
                overrides[name] = modified

    in_buf.seek(0)
    with zipfile.ZipFile(in_buf, "r") as zf_in:
        with zipfile.ZipFile(out_buf, "w", compression=zipfile.ZIP_DEFLATED) as zf_out:
            for info in zf_in.infolist():
                data = overrides.get(info.filename) or zf_in.read(info.filename)
                zf_out.writestr(info, data)

    return out_buf.getvalue()


result_bytes = process_pptx_wasm(_wasm_input)
result_bytes
`;

export default function WasmUnlockZone({ onResult, onProgress }: WasmUnlockZoneProps) {
  const pyodideRef = useRef<Pyodide | null>(null);
  const [pyodideReady, setPyodideReady] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load Pyodide once on mount
  useEffect(() => {
    let cancelled = false;

    async function init() {
      onProgress(5, "Loading Python runtime…");
      const script = document.createElement("script");
      script.src = `${PYODIDE_INDEX}pyodide.js`;
      script.crossOrigin = "anonymous";

      await new Promise<void>((resolve, reject) => {
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load Pyodide script"));
        document.head.appendChild(script);
      });

      if (cancelled) return;
      onProgress(30, "Starting Python interpreter…");
      const pyodide = await window.loadPyodide({ indexURL: PYODIDE_INDEX });

      if (cancelled) return;
      onProgress(60, "Loading lxml…");
      await pyodide.loadPackage(["lxml"]);

      if (cancelled) return;
      pyodideRef.current = pyodide;
      setPyodideReady(true);
      onProgress(100, "Ready — drop your file");
    }

    init().catch((err) => {
      console.error("Pyodide init failed:", err);
      onProgress(0, "Failed to load Python runtime");
    });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const processFile = useCallback(
    async (file: File) => {
      if (!pyodideRef.current || processing) return;
      if (!file.name.toLowerCase().endsWith(".pptx")) {
        onProgress(0, "Only .pptx files are supported");
        return;
      }

      setProcessing(true);
      onProgress(10, "Reading file…");

      try {
        const buffer = await file.arrayBuffer();
        const inputBytes = new Uint8Array(buffer);

        onProgress(30, "Stripping locks and flattening groups…");

        const pyodide = pyodideRef.current;
        pyodide.globals.set("_wasm_input", inputBytes);
        const proxy = pyodide.runPython(PYTHON_PIPELINE);
        const resultBytes = proxy.toJs();
        proxy.destroy();

        onProgress(90, "Packaging result…");

        // Auto-download
        const stem = file.name.replace(/\.pptx$/i, "");
        const outName = `${stem}_unlocked.pptx`;
        const blob = new Blob([resultBytes as Uint8Array<ArrayBuffer>], {
          type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = outName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        onProgress(100, "Done — file downloaded");
        onResult(resultBytes, outName);
      } catch (err) {
        console.error("WASM processing error:", err);
        onProgress(0, `Error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setProcessing(false);
      }
    },
    [processing, onResult, onProgress],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) processFile(file);
    },
    [processFile],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback(() => setIsDragging(false), []);

  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processFile(file);
      e.target.value = "";
    },
    [processFile],
  );

  const isInteractive = pyodideReady && !processing;

  return (
    <div className="flex flex-col items-center gap-4 w-full">
      {/* Drop zone */}
      <div
        role="button"
        tabIndex={isInteractive ? 0 : -1}
        aria-label="Drop zone for PPTX files"
        onClick={() => isInteractive && inputRef.current?.click()}
        onKeyDown={(e) => e.key === "Enter" && isInteractive && inputRef.current?.click()}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        className={[
          "w-full max-w-lg rounded-2xl border-2 border-dashed px-8 py-14",
          "flex flex-col items-center gap-3 transition-colors duration-150",
          isInteractive
            ? "cursor-pointer hover:border-blue-500 hover:bg-blue-50"
            : "cursor-default opacity-60",
          isDragging
            ? "border-blue-500 bg-blue-50"
            : "border-gray-300 bg-white",
        ].join(" ")}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-10 w-10 text-gray-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
          />
        </svg>

        <p className="text-sm font-medium text-gray-700">
          {processing
            ? "Processing…"
            : pyodideReady
              ? "Drop your .pptx here, or click to browse"
              : "Loading Python runtime…"}
        </p>
        <p className="text-xs text-gray-400">Max 100 MB · .pptx only</p>
      </div>

      {/* Privacy badge */}
      <p className="flex items-center gap-1.5 text-xs text-gray-500">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-3.5 w-3.5 text-green-500"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M10 1.944A11.954 11.954 0 012.166 5C2.056 5.649 2 6.319 2 7c0 5.225 3.34 9.67 8 11.317C14.66 16.67 18 12.225 18 7c0-.682-.057-1.35-.166-2A11.954 11.954 0 0110 1.944zM11 14a1 1 0 11-2 0 1 1 0 012 0zm-1-7a1 1 0 00-1 1v3a1 1 0 102 0V8a1 1 0 00-1-1z"
            clipRule="evenodd"
          />
        </svg>
        Your file never leaves the browser — processed entirely on-device
      </p>

      <input
        ref={inputRef}
        type="file"
        accept=".pptx"
        className="hidden"
        onChange={onFileChange}
      />
    </div>
  );
}
