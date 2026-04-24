"use client";

import { useEffect, useRef, useState } from "react";

const MONO = "'JetBrains Mono', 'Courier New', monospace";

interface Slide {
  num: number;
  title: string;
  shapes: number;
  images: number;
  groups: number;
  status: "flat" | "partial" | "editable";
}

const SLIDES: Slide[] = [
  { num: 1, title: "Architecture Topology",   shapes: 0,  images: 1,  groups: 0, status: "flat"     },
  { num: 2, title: "Business Tech Platform",  shapes: 2,  images: 1,  groups: 0, status: "partial"  },
  { num: 3, title: "EDA Title Slide",         shapes: 2,  images: 1,  groups: 0, status: "partial"  },
  { num: 4, title: "EDA Overview",            shapes: 1,  images: 1,  groups: 0, status: "flat"     },
  { num: 5, title: "AEM Components",          shapes: 65, images: 10, groups: 0, status: "editable" },
  { num: 6, title: "Topology & Transport",    shapes: 41, images: 0,  groups: 5, status: "partial"  },
  { num: 7, title: "Closing Slide",           shapes: 0,  images: 1,  groups: 0, status: "flat"     },
];

function AnalysisCard({ slide, delay }: { slide: Slide; delay: number }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(t);
  }, [delay]);

  const c =
    slide.status === "editable" ? "#00ff88" :
    slide.status === "partial"  ? "#ffaa00" : "#ff4466";
  const label =
    slide.status === "editable" ? "EDITABLE" :
    slide.status === "partial"  ? "PARTIAL"  : "FLAT IMAGE";

  return (
    <div style={{
      opacity: visible ? 1 : 0,
      transform: visible ? "translateY(0)" : "translateY(20px)",
      transition: "all 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
      background: "rgba(15, 20, 35, 0.7)",
      border: `1px solid ${c}33`,
      borderRadius: 12,
      padding: "14px 18px",
      display: "flex",
      alignItems: "center",
      gap: 14,
      backdropFilter: "blur(10px)",
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: 10,
        background: `linear-gradient(135deg, ${c}22, ${c}08)`,
        display: "flex", alignItems: "center", justifyContent: "center",
        border: `1px solid ${c}44`,
        fontSize: 18, fontWeight: 700, color: c, fontFamily: MONO,
        flexShrink: 0,
      }}>
        {slide.num}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#e0e4ef", marginBottom: 3 }}>
          {slide.title}
        </div>
        <div style={{ fontSize: 11, color: "#8890a8" }}>
          {slide.shapes} shapes · {slide.images} images · {slide.groups} groups
        </div>
      </div>
      <div style={{
        fontSize: 10, fontWeight: 700, color: c,
        background: `${c}15`,
        padding: "4px 10px", borderRadius: 20,
        fontFamily: MONO, letterSpacing: 0.5,
        whiteSpace: "nowrap", flexShrink: 0,
      }}>
        {label}
      </div>
    </div>
  );
}

export default function ProcessingDemo() {
  const [phase, setPhase] = useState<"idle" | "analyzing" | "results" | "fixed">("idle");
  const [progress, setProgress] = useState(0);
  const ivRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (ivRef.current) clearInterval(ivRef.current); }, []);

  const startAnalysis = () => {
    setPhase("analyzing");
    setProgress(0);
    let p = 0;
    ivRef.current = setInterval(() => {
      p += Math.random() * 15 + 5;
      if (p >= 100) {
        p = 100;
        if (ivRef.current) clearInterval(ivRef.current);
        setTimeout(() => setPhase("results"), 400);
      }
      setProgress(Math.min(p, 100));
    }, 200);
  };

  const flatCount     = SLIDES.filter(s => s.status === "flat").length;
  const partialCount  = SLIDES.filter(s => s.status === "partial").length;
  const editableCount = SLIDES.filter(s => s.status === "editable").length;

  return (
    <div style={{
      background: "linear-gradient(170deg, #0a0e1a 0%, #111827 50%, #0d1117 100%)",
      borderRadius: 20,
      border: "1px solid #1e2940",
      overflow: "hidden",
      maxWidth: 560,
      margin: "0 auto",
    }}>
      {/* Title bar */}
      <div style={{
        padding: "16px 24px",
        borderBottom: "1px solid #1e2940",
        display: "flex", alignItems: "center", gap: 10,
      }}>
        <div style={{ display: "flex", gap: 6 }}>
          {(["#ff5f57", "#febc2e", "#28c840"] as const).map(c => (
            <div key={c} style={{ width: 10, height: 10, borderRadius: "50%", background: c }} />
          ))}
        </div>
        <div style={{ flex: 1, textAlign: "center", fontSize: 12, color: "#5a6480", fontFamily: MONO }}>
          slideunlock.io/analyze
        </div>
      </div>

      <div style={{ padding: "28px 24px" }}>
        {/* ── Idle ── */}
        {phase === "idle" && (
          <div
            onClick={startAnalysis}
            role="button"
            tabIndex={0}
            onKeyDown={e => e.key === "Enter" && startAnalysis()}
            style={{
              border: "2px dashed #2a3555",
              borderRadius: 16, padding: "48px 24px",
              textAlign: "center", cursor: "pointer",
              transition: "all 0.3s",
              background: "rgba(99, 102, 241, 0.03)",
              outline: "none",
            }}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = "#6366f1";
              e.currentTarget.style.background = "rgba(99, 102, 241, 0.08)";
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = "#2a3555";
              e.currentTarget.style.background = "rgba(99, 102, 241, 0.03)";
            }}
          >
            <div style={{ fontSize: 42, marginBottom: 12 }}>📄</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#c5cbe0", marginBottom: 6 }}>
              Drop your PPTX here
            </div>
            <div style={{ fontSize: 13, color: "#6b7394" }}>
              Click to simulate analysis on the TCS sample
            </div>
          </div>
        )}

        {/* ── Analyzing ── */}
        {phase === "analyzing" && (
          <div style={{ textAlign: "center", padding: "32px 0" }}>
            <style>{`@keyframes su-spin { to { transform: rotate(360deg) } }`}</style>
            <div style={{
              width: 72, height: 72, margin: "0 auto 20px",
              borderRadius: "50%",
              border: "3px solid #1e2940",
              borderTopColor: "#6366f1",
              animation: "su-spin 1s linear infinite",
            }} />
            <div style={{ fontSize: 15, fontWeight: 600, color: "#c5cbe0", marginBottom: 10 }}>
              Analyzing PPTX structure...
            </div>
            <div style={{
              height: 6, borderRadius: 3, background: "#1a2038",
              overflow: "hidden", margin: "0 40px",
            }}>
              <div style={{
                height: "100%", width: `${progress}%`,
                background: "linear-gradient(90deg, #6366f1, #8b5cf6)",
                borderRadius: 3, transition: "width 0.2s",
              }} />
            </div>
            <div style={{ fontSize: 12, color: "#5a6480", marginTop: 8, fontFamily: MONO }}>
              {progress < 30
                ? "Unpacking XML..."
                : progress < 60
                  ? "Scanning shapes & locks..."
                  : progress < 90
                    ? "Detecting flat images..."
                    : "Finalizing report..."}
            </div>
          </div>
        )}

        {/* ── Results / Fixed ── */}
        {(phase === "results" || phase === "fixed") && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 20 }}>
              {[
                { label: "Flat Image", count: flatCount,     color: "#ff4466" },
                { label: "Partial",    count: partialCount,  color: "#ffaa00" },
                { label: "Editable",   count: editableCount, color: "#00ff88" },
              ].map(s => (
                <div key={s.label} style={{
                  background: `${s.color}08`, border: `1px solid ${s.color}22`,
                  borderRadius: 12, padding: "14px 12px", textAlign: "center",
                }}>
                  <div style={{ fontSize: 26, fontWeight: 800, color: s.color, fontFamily: MONO }}>
                    {s.count}
                  </div>
                  <div style={{ fontSize: 11, color: "#8890a8", marginTop: 2 }}>{s.label}</div>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
              {SLIDES.map((s, i) => (
                <AnalysisCard
                  key={s.num}
                  slide={phase === "fixed" ? { ...s, status: "editable" } : s}
                  delay={i * 120}
                />
              ))}
            </div>

            <button
              onClick={() => setPhase(phase === "results" ? "fixed" : "idle")}
              style={{
                width: "100%", padding: "16px", borderRadius: 14,
                border: "none",
                background: phase === "fixed"
                  ? "linear-gradient(135deg, #00ff88, #00cc6a)"
                  : "linear-gradient(135deg, #6366f1, #8b5cf6)",
                color: phase === "fixed" ? "#0a0e1a" : "#fff",
                fontSize: 15, fontWeight: 700, cursor: "pointer",
                boxShadow: phase === "fixed"
                  ? "0 4px 24px rgba(0, 255, 136, 0.3)"
                  : "0 4px 24px rgba(99, 102, 241, 0.3)",
                transition: "transform 0.2s",
              }}
              onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; }}
              onMouseLeave={e => { e.currentTarget.style.transform = "translateY(0)"; }}
            >
              {phase === "fixed" ? "✓ Download Editable PPTX" : "🔓 Unlock & Reconstruct All Slides"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
