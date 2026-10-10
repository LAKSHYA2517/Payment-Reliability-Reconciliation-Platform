-- Up Migration

CREATE TYPE payment_status AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELED');

CREATE TABLE payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref  TEXT UNIQUE,
  amount_cents  BIGINT NOT NULL CHECK (amount_cents > 0),
  currency      TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- No default on purpose: the Payment Service decides every status, including the first.
  status        payment_status NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE payments;
DROP TYPE payment_status;
