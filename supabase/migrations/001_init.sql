CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE users (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  plan text NOT NULL DEFAULT 'free',   -- 'free' | 'pro' | 'team'
  stripe_customer_id text,
  usage_count int NOT NULL DEFAULT 0,
  usage_reset_at timestamptz NOT NULL DEFAULT date_trunc('month', now()) + interval '1 month'
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  original_filename text,
  input_file_url text,
  output_file_url text,
  status text NOT NULL DEFAULT 'queued',  -- queued|processing|done|failed
  basic_only boolean DEFAULT true,
  reconstruct_flat boolean DEFAULT false,
  locked_removed int,
  groups_flattened int,
  ssim_scores jsonb,
  style_context jsonb,
  error_message text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE job_slides (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id uuid REFERENCES jobs(id) ON DELETE CASCADE,
  slide_num int NOT NULL,
  is_flat bool DEFAULT false,
  ssim_score float,
  native_shape_count int,
  reconstruction_status text,  -- skipped|done|fallback_png
  pass_through_type text,
  created_at timestamptz DEFAULT now()
);

-- RLS policies
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_slides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own data" ON users FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can read own jobs" ON jobs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Service role can do everything" ON jobs FOR ALL USING (true);
