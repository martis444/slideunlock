# SlideUnlock — Project Bible

## Project Overview

SlideUnlock is a SaaS tool that unlocks protected/read-only PowerPoint files and returns a fully editable `.pptx`.

**The problem:** Presentations are frequently distributed with editing locks, shape-group nesting, or as flat exported images that strip all structure. Users can view these files but can't edit them.

**What SlideUnlock does:**
1. Strips all edit-protection locks (picLocks, spLocks, grpSpLocks) from every slide, layout, and master.
2. Flattens nested shape groups into individually positioned shapes.
3. For slides that are nothing but a full-bleed image (common when a deck was exported to PNGs and re-imported), uses Claude vision to visually reconstruct every text box, shape, connector, and fill — then verifies the result with SSIM before returning the file.

The output is a valid `.pptx` with unlocked, editable shapes. If reconstruction quality is below threshold, the original slide image is preserved as a hidden fallback so the slide still renders correctly.

---

## Stack

| Layer | Technology |
|---|---|
| Backend | FastAPI 0.111 · Python 3.12 · Railway |
| Frontend | Next.js 14 · TypeScript · Tailwind CSS · shadcn/ui · Vercel |
| Database / Auth | Supabase (Postgres + Auth) |
| Payments | Stripe (credit-based) |
| AI | Claude Sonnet (`claude-sonnet-4-6`) via Anthropic API |

**Key backend dependencies** (`requirements.txt`):
```
fastapi==0.111.0       uvicorn[standard]==0.29.0
python-pptx==0.6.23    lxml==5.2.2
anthropic==0.28.0      Pillow==10.3.0
scikit-image==0.23.2   scikit-learn==1.4.2
numpy==1.26.4          supabase==2.4.6
stripe==9.9.0          python-dotenv==1.0.1
```

---

## Architecture

### Directory Layout

```
slideunlock/
├── CLAUDE.md                  ← you are here
├── backend/
│   ├── main.py                ← FastAPI app + routes
│   ├── requirements.txt
│   ├── .env.example
│   └── engine/
│       ├── harvester.py       ← extracts StyleContext from PPTX zip
│       ├── classifier.py      ← detects flat-image slides
│       ├── ungrouper.py       ← flattens shape groups
│       ├── xml_surgery.py     ← strips lock elements/attributes
│       ├── ai_reconstructor.py← calls Claude, parses ShapeSpec JSON
│       ├── shape_builder.py   ← materialises ShapeSpecs into python-pptx shapes
│       ├── ssim_gate.py       ← SSIM verification + geometric nudge loop
│       └── pipeline.py        ← orchestrates all 7 steps above
├── frontend/                  ← Next.js app (not yet scaffolded)
└── supabase/
    └── migrations/            ← SQL migrations (not yet written)
```

### Backend — Engine Pipeline

Each step is a pure function; `pipeline.process_pptx(bytes) -> bytes` wires them together.

```
input .pptx bytes
      │
      ▼
xml_surgery.strip_locks()
  Removes picLocks / spLocks / grpSpLocks elements and all lock-related
  attributes from every slide, layout, and master XML entry in the zip.
      │
      ▼
ungrouper.flatten_groups()
  Iteratively (up to 20 passes) promotes grpSp children to the top-level
  spTree, applying the group's scale and offset transform to each child.
  Skips SmartArt groups (detected via dgmRelIds attribute).
      │
      ▼
harvester.harvest()  →  StyleContext
  Reads slide dimensions, theme colour palette, embedded font names,
  and dominant colours (k-means, k=5) for each image rId.
      │
      ▼
classifier.classify_all()  →  [SlideReport, ...]
  For each slide: counts native shapes, images, SmartArt, Charts, Tables,
  Videos. Marks a slide as is_flat_image=True when it contains exactly
  one image covering ≥80% of the slide area with no other native shapes.
      │
      ▼  (only for flat-image slides)
ai_reconstructor.reconstruct()  →  [ShapeSpec, ...]
  Sends the embedded PNG to Claude (claude-sonnet-4-6, max_tokens=8096)
  with a system prompt containing slide dimensions, theme colours, and
  font names. Parses the returned JSON array. Retries once if the first
  response is not valid JSON.
      │
      ▼
shape_builder.build_slide()
  Inserts a hidden fallback PNG of the original image at z=0, then adds
  all reconstructed shapes in z_order sequence: auto-shapes, textboxes,
  connectors. Applies fill, gradient, line, text runs, rotation.
      │
      ▼
ssim_gate.verify_and_nudge()
  Renders the rebuilt slide to PNG via LibreOffice headless, computes
  structural similarity (SSIM) against the original image.
  If score < 0.995, runs up to 3 nudge rounds (±914 EMU = ±0.001 in):
    Round 1 — cx on mixed-font text boxes (up to 5)
    Round 2 — best single x/y nudge across all shapes
    Round 3 — cy on the 3 tallest text boxes
  Falls back to un-hiding the fallback PNG if score stays below threshold.
      │
      ▼
output .pptx bytes
```

### Database Schema

```sql
-- Users (mirrors auth.users, extended for billing)
users:
  id                 uuid  PK  → auth.users.id
  email              text
  stripe_customer_id text  nullable
  credits            int   default 0
  created_at         timestamptz

-- One row per upload/unlock request
jobs:
  id                 uuid  PK
  user_id            uuid  FK → users.id  (nullable for anonymous)
  status             text  -- pending | processing | done | failed
  original_filename  text
  slide_count        int   nullable
  flat_slide_count   int   nullable
  error              text  nullable
  created_at         timestamptz
  completed_at       timestamptz  nullable

-- One row per slide in a job
job_slides:
  id                     uuid  PK
  job_id                 uuid  FK → jobs.id
  slide_num              int   -- 1-based
  is_flat_image          bool
  ssim_score             numeric(6,4)  nullable
  reconstruction_status  text  -- native | done | fallback_png | skipped
  created_at             timestamptz
```

### API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | none | Liveness check; returns `{"status":"ok"}` |
| `POST` | `/api/unlock` | optional JWT | Upload `.pptx`, receive `*_unlocked.pptx` |

**POST /api/unlock**
- Request: `multipart/form-data`, field `file` (`.pptx`, max 50 MB)
- Auth: optional `Authorization: Bearer <supabase-jwt>`; when present, deducts one credit
- Response: binary `.pptx` download
- Response headers: `Content-Disposition`, `X-Original-Filename`
- Errors: `400` wrong format · `402` no credits · `413` too large · `500` pipeline error

---

## Key Types & Constants

### StyleContext (dict)
```python
{
  "slide_cx_emu":        int,          # slide width  (default 12 192 000)
  "slide_cy_emu":        int,          # slide height (default  6 858 000)
  "theme_colors":        list[str],    # hex strings, up to 10 (dk1…accent6)
  "font_names":          list[str],    # sorted; from embedded fonts + theme
  "image_dominant_hex":  dict[str, list[str]],  # rId → top-5 hex colours
}
```

### ShapeSpec (dict — Claude's output, shape_builder's input)
```python
{
  # required for all shapes
  "id":       int,    # starts at 100, increments
  "type":     str,    # see valid types below
  "z_order":  int,    # 0 = bottom
  "x":  int, "y":  int,   # position, EMU
  "cx": int, "cy": int,   # size, EMU
  "rot": int,             # 1/60000 degrees (0 = no rotation)

  # optional — omit entirely when shape has no text
  "text_runs": [
    {
      "text":           str,
      "font_name":      str,
      "font_size_pt":   float,     # exact, e.g. 11.0 not 11
      "bold":           bool,
      "italic":         bool,
      "underline":      bool,
      "font_color_hex": str,       # RRGGBB
      # paragraph-level — FIRST run of each paragraph only:
      "align":            str,     # left | center | right | justify
      "line_spacing_pt":  float,
      "space_before_pt":  float,
      "space_after_pt":   float,
    },
    {"paragraph_break": True},     # paragraph separator — no other fields
    ...
  ],

  "v_align":             str,    # top | middle | bottom
  "fill_type":           str,    # solid | gradient | none
  "fill_hex":            str,    # RRGGBB — solid only
  "fill_opacity":        float,  # 0.0–1.0
  "gradient_stops":      list,   # [{pos, hex, opacity}]
  "gradient_angle_deg":  float,
  "line_hex":            str,    # RRGGBB
  "line_width_pt":       float,  # 0 = no border
  "line_dash":           str,    # solid | dash | dot | dashDot
  "corner_radius_emu":   int,    # rounded_rect only

  # connector-only (omit for non-connectors)
  "connector_type": str,         # straight | elbow | curved
  "start_x": int, "start_y": int,
  "end_x":   int, "end_y":   int,
  "start_arrow": str, "end_arrow": str,
  "start_shape_id": int | None, "end_shape_id": int | None,
  "start_anchor": int, "end_anchor": int,  # 0=top 1=right 2=bottom 3=left
}
```

**Valid shape types:**
```
arrow_double  arrow_left  arrow_right  callout_rect  callout_rounded_rect
connector  diamond  hexagon  line  oval  pentagon
rectangle  rounded_rect  textbox  triangle
```

### EMU Conversion
```
1 inch  = 914 400 EMU
1 pt    =  12 700 EMU
Default slide: 12 192 000 × 6 858 000 EMU  (13.33 × 7.5 in, 16:9)
```

### SSIM Gate Constants
```python
SSIM_THRESHOLD  = 0.995   # pass/fail cutoff
NUDGE_STEP_EMU  = 914     # ≈ 0.001 inch per nudge step
MAX_NUDGE_DELTA = 1828    # 2 steps maximum per axis
```

---

## Current Status

### Built ✅
- Full engine pipeline (`harvester` → `classifier` → `ungrouper` → `xml_surgery` → `ai_reconstructor` → `shape_builder` → `ssim_gate` → `pipeline`)
- FastAPI app with `/health` and `/api/unlock`
- `requirements.txt` with all backend dependencies

### Not yet built ❌
- Frontend (Next.js) — directory exists but is empty
- Supabase migrations — directory exists but is empty
- Stripe webhook handler
- Auth middleware in the API (endpoint exists but credit/job tracking is scaffolded, not wired)
- Railway deployment config (`railway.toml` / `Dockerfile`)
- `.env` files (`.env.example` exists in `backend/`)

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Claude API key for slide reconstruction |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Yes | Service-role key (bypasses RLS for backend writes) |
| `STRIPE_SECRET_KEY` | Yes | Stripe secret key for credit purchases |
| `STRIPE_WEBHOOK_SECRET` | Yes | Stripe webhook signing secret |
| `ALLOWED_ORIGIN` | Yes | CORS origin for the frontend (e.g. `https://slideunlock.com`) |

### Frontend (`.env.local`)
*(not yet defined — will need Supabase anon key, Stripe publishable key, API base URL)*

---

## Development Commands

```bash
# Backend — run locally
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # fill in your keys
uvicorn main:app --reload --port 8000

# Backend — quick smoke test (requires a real .pptx)
curl -X POST http://localhost:8000/api/unlock \
  -F "file=@sample.pptx" \
  -o sample_unlocked.pptx

# Frontend — not yet scaffolded
cd frontend
# npx create-next-app@14 . --typescript --tailwind --app
# npm run dev

# LibreOffice (required for SSIM rendering on macOS)
# Install from https://www.libreoffice.org/download/
# Expected path: /Applications/LibreOffice.app/Contents/MacOS/soffice
```

---

## Coding Behavior Guidelines

Behavioral guidelines to reduce common LLM coding mistakes.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.
