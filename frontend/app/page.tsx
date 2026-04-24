import Link from "next/link";
import { JetBrains_Mono, Outfit } from "next/font/google";
import ProcessingDemo from "../components/ProcessingDemo";

// ── Fonts ──────────────────────────────────────────────────────────────────────
const outfit = Outfit({ subsets: ["latin"], display: "swap" });
const mono   = JetBrains_Mono({ subsets: ["latin"], display: "swap" });

const SANS = outfit.style.fontFamily;
const MONO = mono.style.fontFamily;

// ── Data ───────────────────────────────────────────────────────────────────────

const ISSUES = [
  { icon: "🖼️", label: "Flat Image Slides",   desc: "Diagrams rendered as a single PNG instead of editable shapes" },
  { icon: "🔒", label: "Locked Elements",      desc: "picLocks, noMove, noResize preventing any editing" },
  { icon: "📦", label: "Grouped Shapes",       desc: "Elements welded together so you can't select individually" },
  { icon: "🔗", label: "Frozen Connectors",    desc: "Arrows and lines baked into images, not native connectors" },
];

const STEPS = [
  { num: "01", title: "Upload",       desc: "Drop your AI-generated PPTX" },
  { num: "02", title: "Analyze",      desc: "We detect locked, grouped & image-only slides" },
  { num: "03", title: "Reconstruct",  desc: "AI rebuilds flat images as native editable shapes" },
  { num: "04", title: "Download",     desc: "Get a pixel-perfect editable clone" },
];

const PRICING = [
  {
    name: "Starter", price: "Free", period: "",
    features: ["3 files/month", "Basic unlock (locks & groups)", "Up to 10 slides", "Standard processing"],
    cta: "Start Free", accent: false,
  },
  {
    name: "Pro", price: "$12", period: "/mo",
    features: ["50 files/month", "AI diagram reconstruction", "Unlimited slides", "Priority processing", "Batch upload"],
    cta: "Go Pro", accent: true,
  },
  {
    name: "Team", price: "$39", period: "/mo",
    features: ["Unlimited files", "Full AI reconstruction", "API access", "Custom branding", "Dedicated support"],
    cta: "Contact Us", accent: false,
  },
];

const HOW_BUILT = [
  { label: "Engine",   value: "python-pptx · lxml · Claude API" },
  { label: "Frontend", value: "Next.js · Pyodide (local mode)" },
  { label: "Infra",    value: "Supabase (auth + storage) · Railway (Python worker)" },
  { label: "Fidelity", value: "SSIM gate at 0.995 threshold" },
];

// ── PricingCard (Server Component — hover via CSS class) ───────────────────────

function PricingCard({ plan }: { plan: (typeof PRICING)[number] }) {
  return (
    <div
      className={`su-card ${plan.accent ? "su-card-accent" : "su-card-plain"}`}
      style={{
        background: plan.accent
          ? "linear-gradient(170deg, rgba(99,102,241,0.15), rgba(139,92,246,0.05))"
          : "rgba(15, 20, 35, 0.5)",
        border: `1px solid ${plan.accent ? "#6366f155" : "#1e2940"}`,
        borderRadius: 20,
        padding: "32px 24px",
        position: "relative",
        overflow: "hidden",
        flex: "1 1 260px",
        maxWidth: 340,
      }}
    >
      {plan.accent && (
        <div style={{
          position: "absolute", top: 14, right: 14,
          fontSize: 10, fontWeight: 700, color: "#6366f1",
          background: "rgba(99,102,241,0.15)",
          padding: "4px 12px", borderRadius: 20,
          fontFamily: MONO, letterSpacing: 1,
        }}>
          POPULAR
        </div>
      )}

      <div style={{ fontSize: 14, fontWeight: 600, color: "#8890a8", marginBottom: 8 }}>
        {plan.name}
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 20 }}>
        <span style={{ fontSize: 42, fontWeight: 800, color: "#e0e4ef" }}>{plan.price}</span>
        {plan.period && <span style={{ fontSize: 14, color: "#5a6480" }}>{plan.period}</span>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
        {plan.features.map(f => (
          <div key={f} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "#a0a8c4" }}>
            <span style={{ color: plan.accent ? "#6366f1" : "#00ff88", fontSize: 14, flexShrink: 0 }}>✓</span>
            {f}
          </div>
        ))}
      </div>

      <Link
        href="/app"
        style={{
          display: "block",
          padding: "14px",
          borderRadius: 12,
          border: plan.accent ? "none" : "1px solid #2a3555",
          background: plan.accent ? "linear-gradient(135deg, #6366f1, #8b5cf6)" : "transparent",
          color: plan.accent ? "#fff" : "#a0a8c4",
          fontSize: 14, fontWeight: 600,
          textDecoration: "none",
          textAlign: "center",
        }}
      >
        {plan.cta}
      </Link>
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function Home() {
  return (
    <div style={{
      minHeight: "100vh",
      background: "#080b14",
      color: "#e0e4ef",
      fontFamily: SANS,
      overflowX: "hidden",
    }}>
      {/* Hover effects for Server-Component sections */}
      <style>{`
        .su-card { transition: transform 0.3s, box-shadow 0.3s; }
        .su-card:hover { transform: translateY(-4px); }
        .su-card-accent:hover { box-shadow: 0 12px 40px rgba(99,102,241,0.2); }
        .su-card-plain:hover  { box-shadow: 0 12px 40px rgba(0,0,0,0.3); }
        .su-issue:hover { border-color: rgba(99,102,241,0.27) !important; }
        .su-cta-primary { transition: transform 0.2s, box-shadow 0.2s; }
        .su-cta-primary:hover { transform: translateY(-2px); box-shadow: 0 8px 40px rgba(99,102,241,0.5); }
        .su-cta-outline:hover { background: rgba(255,255,255,0.05) !important; }
        .su-nav-link:hover { background: rgba(99,102,241,0.15) !important; }
      `}</style>

      {/* ── Ambient background ── */}
      <div style={{
        position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0,
        background: `
          radial-gradient(ellipse 600px 400px at 20% 20%, rgba(99,102,241,0.06) 0%, transparent 70%),
          radial-gradient(ellipse 500px 500px at 80% 60%, rgba(139,92,246,0.04) 0%, transparent 70%),
          radial-gradient(ellipse 400px 300px at 50% 90%, rgba(0,255,136,0.03) 0%, transparent 70%)
        `,
      }} />

      {/* ── Nav ── */}
      <nav style={{
        position: "sticky", top: 0, zIndex: 100,
        padding: "16px 24px",
        background: "rgba(8, 11, 20, 0.85)",
        backdropFilter: "blur(20px)",
        borderBottom: "1px solid #1e294033",
      }}>
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          maxWidth: 1100, margin: "0 auto",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 34, height: 34, borderRadius: 10,
              background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 16,
            }}>🔓</div>
            <span style={{
              fontSize: 18, fontWeight: 800,
              background: "linear-gradient(135deg, #e0e4ef, #8b5cf6)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}>SlideUnlock</span>
          </div>

          <Link
            href="/app"
            className="su-nav-link"
            style={{
              padding: "8px 20px", borderRadius: 10,
              border: "1px solid #6366f144",
              background: "rgba(99,102,241,0.1)",
              color: "#a0a8f1", fontSize: 13, fontWeight: 600,
              textDecoration: "none",
              transition: "background 0.2s",
            }}
          >
            Get Started
          </Link>
        </div>
      </nav>

      {/* ── Content ── */}
      <div style={{ position: "relative", zIndex: 1, maxWidth: 1100, margin: "0 auto", padding: "0 24px" }}>

        {/* ── Hero ── */}
        <section style={{ textAlign: "center", padding: "80px 0 60px" }}>
          <div style={{
            display: "inline-block",
            fontSize: 11, fontWeight: 700, color: "#6366f1",
            background: "rgba(99,102,241,0.1)",
            border: "1px solid rgba(99,102,241,0.2)",
            padding: "6px 16px", borderRadius: 20,
            fontFamily: MONO, letterSpacing: 1,
            marginBottom: 24,
          }}>
            AI-GENERATED PPTX → FULLY EDITABLE
          </div>

          <h1 style={{
            fontSize: "clamp(36px, 7vw, 64px)",
            fontWeight: 900, lineHeight: 1.05,
            marginBottom: 20, letterSpacing: "-0.03em",
          }}>
            <span style={{ display: "block" }}>Your AI slides are</span>
            <span style={{
              background: "linear-gradient(135deg, #ff4466, #ff6b6b, #ffaa00)",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
            }}>locked.</span>
            <span style={{ display: "block", marginTop: 4 }}>We </span>
            <span style={{
              background: "linear-gradient(135deg, #00ff88, #00cc6a, #6366f1)",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
            }}>unlock</span>
            <span> them.</span>
          </h1>

          <p style={{
            fontSize: 17, color: "#6b7394",
            maxWidth: 520, margin: "0 auto 36px",
            lineHeight: 1.6,
          }}>
            ChatGPT & AI tools export PPTX files with locked elements, grouped shapes, and diagrams
            baked as flat images. SlideUnlock reconstructs every slide into fully editable native PowerPoint.
          </p>

          <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap" }}>
            <Link
              href="/app"
              className="su-cta-primary"
              style={{
                padding: "16px 36px", borderRadius: 14,
                background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
                color: "#fff", fontSize: 16, fontWeight: 700,
                textDecoration: "none",
                boxShadow: "0 4px 30px rgba(99,102,241,0.4)",
                display: "inline-block",
              }}
            >
              Upload PPTX Free
            </Link>
            <a
              href="#demo"
              className="su-cta-outline"
              style={{
                padding: "16px 36px", borderRadius: 14,
                border: "1px solid #2a3555",
                background: "transparent",
                color: "#a0a8c4", fontSize: 16, fontWeight: 600,
                textDecoration: "none", display: "inline-block",
                transition: "background 0.2s",
              }}
            >
              See How It Works ↓
            </a>
          </div>
        </section>

        {/* ── Problem ── */}
        <section style={{ padding: "60px 0" }}>
          <h2 style={{
            fontSize: 28, fontWeight: 800, textAlign: "center",
            marginBottom: 12, letterSpacing: "-0.02em",
          }}>
            The AI PPTX Problem
          </h2>
          <p style={{
            fontSize: 14, color: "#6b7394", textAlign: "center",
            maxWidth: 480, margin: "0 auto 36px",
          }}>
            AI tools generate beautiful-looking slides, but the files are practically frozen.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
            {ISSUES.map(issue => (
              <div
                key={issue.label}
                className="su-issue"
                style={{
                  background: "rgba(15, 20, 35, 0.6)",
                  border: "1px solid #1e2940",
                  borderRadius: 16, padding: "24px 20px",
                  transition: "border-color 0.3s",
                }}
              >
                <div style={{ fontSize: 28, marginBottom: 12 }}>{issue.icon}</div>
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{issue.label}</div>
                <div style={{ fontSize: 13, color: "#6b7394", lineHeight: 1.5 }}>{issue.desc}</div>
              </div>
            ))}
          </div>
        </section>

        {/* ── How It Works ── */}
        <section style={{ padding: "60px 0" }}>
          <h2 style={{
            fontSize: 28, fontWeight: 800, textAlign: "center",
            marginBottom: 36, letterSpacing: "-0.02em",
          }}>
            How SlideUnlock Works
          </h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
            {STEPS.map(step => (
              <div key={step.num} style={{
                background: "rgba(15, 20, 35, 0.4)",
                border: "1px solid #1e2940",
                borderRadius: 16, padding: "28px 20px",
              }}>
                <div style={{
                  fontSize: 36, fontWeight: 900, color: "#6366f118",
                  fontFamily: MONO, marginBottom: 12,
                }}>{step.num}</div>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>{step.title}</div>
                <div style={{ fontSize: 13, color: "#6b7394", lineHeight: 1.5 }}>{step.desc}</div>
              </div>
            ))}
          </div>
        </section>

        {/* ── Live Demo ── */}
        <section id="demo" style={{ padding: "60px 0" }}>
          <h2 style={{
            fontSize: 28, fontWeight: 800, textAlign: "center",
            marginBottom: 8, letterSpacing: "-0.02em",
          }}>
            Try It Live
          </h2>
          <p style={{ fontSize: 14, color: "#6b7394", textAlign: "center", marginBottom: 32 }}>
            Interactive demo using a real AI-generated PPTX
          </p>
          <ProcessingDemo />
        </section>

        {/* ── Under the Hood ── */}
        <section style={{ padding: "60px 0" }}>
          <h2 style={{
            fontSize: 28, fontWeight: 800, textAlign: "center",
            marginBottom: 36, letterSpacing: "-0.02em",
          }}>
            Under the Hood
          </h2>
          <div style={{
            background: "rgba(15, 20, 35, 0.5)",
            border: "1px solid #1e2940",
            borderRadius: 20, padding: "32px 28px",
            fontFamily: MONO, fontSize: 13,
            color: "#8890a8", lineHeight: 1.8, overflowX: "auto",
          }}>
            <div><span style={{ color: "#6366f1" }}>{"// Pipeline Architecture"}</span></div>
            <div style={{ marginTop: 8 }}>
              <span style={{ color: "#ff6b6b" }}>1.</span>{" "}
              <span style={{ color: "#e0e4ef" }}>XML Surgery</span>
              {" — Strip picLocks, noMove, noResize, noGrp"}
            </div>
            <div>
              <span style={{ color: "#ff6b6b" }}>2.</span>{" "}
              <span style={{ color: "#e0e4ef" }}>Shape Liberation</span>
              {" — Flatten grpSp into individual sp elements"}
            </div>
            <div>
              <span style={{ color: "#ff6b6b" }}>3.</span>{" "}
              <span style={{ color: "#e0e4ef" }}>Flat Image Detection</span>
              {" — Flag slides where 1 pic = entire content"}
            </div>
            <div>
              <span style={{ color: "#ff6b6b" }}>4.</span>{" "}
              <span style={{ color: "#e0e4ef" }}>AI Vision Reconstruction</span>
              {" — Claude analyzes flat images"}
            </div>
            <div>
              <span style={{ color: "#ff6b6b" }}>5.</span>{" "}
              <span style={{ color: "#e0e4ef" }}>Shape Generation</span>
              {" — python-pptx rebuilds as native elements"}
            </div>
            <div>
              <span style={{ color: "#ff6b6b" }}>6.</span>{" "}
              <span style={{ color: "#e0e4ef" }}>Fidelity Check</span>
              {" — SSIM pixel diff between original & clone"}
            </div>
          </div>
        </section>

        {/* ── Pricing ── */}
        <section style={{ padding: "60px 0" }}>
          <h2 style={{
            fontSize: 28, fontWeight: 800, textAlign: "center",
            marginBottom: 8, letterSpacing: "-0.02em",
          }}>
            Pricing
          </h2>
          <p style={{ fontSize: 14, color: "#6b7394", textAlign: "center", marginBottom: 36 }}>
            Start free, upgrade when you need more.
          </p>
          <div style={{ display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap" }}>
            {PRICING.map(plan => <PricingCard key={plan.name} plan={plan} />)}
          </div>
        </section>

        {/* ── How It's Built ── */}
        <section style={{ padding: "20px 0 60px" }}>
          <h2 style={{
            fontSize: 28, fontWeight: 800, textAlign: "center",
            marginBottom: 36, letterSpacing: "-0.02em",
          }}>
            {"How It's Built"}
          </h2>
          <div style={{
            background: "rgba(15, 20, 35, 0.5)",
            border: "1px solid #1e2940",
            borderRadius: 20, overflow: "hidden",
          }}>
            {HOW_BUILT.map((row, i) => (
              <div
                key={row.label}
                style={{
                  display: "flex", alignItems: "center",
                  padding: "18px 28px",
                  borderBottom: i < HOW_BUILT.length - 1 ? "1px solid #1e2940" : "none",
                  gap: 24,
                }}
              >
                <div style={{
                  width: 80, flexShrink: 0,
                  fontSize: 11, fontWeight: 700,
                  color: "#6366f1", fontFamily: MONO,
                  letterSpacing: 0.5, textTransform: "uppercase",
                }}>
                  {row.label}
                </div>
                <div style={{ fontSize: 13, color: "#c5cbe0", fontFamily: MONO, lineHeight: 1.5 }}>
                  {row.value}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── Bottom CTA ── */}
        <section style={{ padding: "20px 0 80px", textAlign: "center" }}>
          <div style={{
            background: "linear-gradient(170deg, rgba(99,102,241,0.1), rgba(139,92,246,0.05))",
            border: "1px solid #6366f122",
            borderRadius: 24, padding: "60px 32px",
          }}>
            <h2 style={{
              fontSize: 32, fontWeight: 900,
              marginBottom: 14, letterSpacing: "-0.02em",
            }}>
              Stop wrestling with locked slides.
            </h2>
            <p style={{
              fontSize: 15, color: "#6b7394",
              maxWidth: 400, margin: "0 auto 28px",
            }}>
              Upload your PPTX and get an editable clone in under 60 seconds.
            </p>
            <Link
              href="/app"
              className="su-cta-primary"
              style={{
                padding: "18px 48px", borderRadius: 14,
                background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
                color: "#fff", fontSize: 17, fontWeight: 700,
                textDecoration: "none", display: "inline-block",
                boxShadow: "0 4px 30px rgba(99,102,241,0.4)",
              }}
            >
              Try SlideUnlock Free →
            </Link>
          </div>
        </section>

        {/* ── Footer ── */}
        <footer style={{
          padding: "24px 0 40px",
          borderTop: "1px solid #1e2940",
          textAlign: "center",
          fontSize: 12, color: "#3a4260",
          fontFamily: MONO,
        }}>
          SlideUnlock © 2026 · python-pptx · lxml · Claude API · Next.js · Pyodide
        </footer>
      </div>
    </div>
  );
}
