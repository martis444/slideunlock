"use client";

import { useState } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase =
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ? createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      )
    : null;

type Mode = "signin" | "signup";

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) { setError("Auth not configured"); return; }
    setLoading(true);
    setError(null);
    setSuccess(null);

    if (mode === "signup") {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${window.location.origin}/app` },
      });
      if (error) setError(error.message);
      else setSuccess("Check your email for a confirmation link.");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
      else window.location.href = "/app";
    }
    setLoading(false);
  };

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "12px 14px",
    borderRadius: 10, border: "1px solid #2a3555",
    background: "rgba(255,255,255,0.04)",
    color: "#e0e4ef", fontSize: 14,
    outline: "none", boxSizing: "border-box",
  };

  const btnStyle: React.CSSProperties = {
    width: "100%", padding: "13px",
    borderRadius: 12, border: "none",
    background: loading ? "rgba(99,102,241,0.4)" : "linear-gradient(135deg, #6366f1, #8b5cf6)",
    color: "#fff", fontSize: 15, fontWeight: 600,
    cursor: loading ? "not-allowed" : "pointer",
    transition: "opacity 0.2s",
  };

  return (
    <div style={{
      minHeight: "100vh", background: "#080b14",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "system-ui, sans-serif", padding: "24px",
    }}>
      <div style={{
        background: "rgba(15, 20, 35, 0.8)",
        border: "1px solid #1e2940",
        borderRadius: 20, padding: "48px 40px",
        width: "100%", maxWidth: 400,
      }}>
        {/* Logo */}
        <div style={{
          width: 48, height: 48, borderRadius: 14,
          background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 22, margin: "0 auto 20px",
        }}>🔓</div>

        <h1 style={{ color: "#e0e4ef", fontSize: 22, fontWeight: 800, marginBottom: 8, textAlign: "center" }}>
          {mode === "signin" ? "Sign in to SlideUnlock" : "Create your account"}
        </h1>
        <p style={{ color: "#6b7394", fontSize: 14, marginBottom: 32, textAlign: "center" }}>
          Unlock, edit, and download your PPTX files
        </p>

        {error && (
          <div style={{
            background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 10, padding: "10px 14px",
            color: "#fca5a5", fontSize: 13, marginBottom: 20,
          }}>{error}</div>
        )}

        {success && (
          <div style={{
            background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)",
            borderRadius: 10, padding: "10px 14px",
            color: "#86efac", fontSize: 13, marginBottom: 20,
          }}>{success}</div>
        )}

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <input
            type="email" placeholder="Email" required
            value={email} onChange={(e) => setEmail(e.target.value)}
            style={inputStyle}
          />
          <input
            type="password" placeholder="Password" required minLength={6}
            value={password} onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
          />
          <button type="submit" disabled={loading} style={btnStyle}>
            {loading ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>

        <p style={{ color: "#6b7394", fontSize: 13, textAlign: "center", marginTop: 24 }}>
          {mode === "signin" ? "Don't have an account? " : "Already have an account? "}
          <button
            onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(null); setSuccess(null); }}
            style={{ background: "none", border: "none", color: "#a0a8f1", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
          >
            {mode === "signin" ? "Sign up" : "Sign in"}
          </button>
        </p>
      </div>
    </div>
  );
}
