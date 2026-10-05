-- Search projection: a derived copy of the archive, rebuilt idempotently.
-- It is not the archive and never the source of completeness.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS search;

-- A chunk never crosses a chat or topic boundary and stores the exact message ids.
-- Messages are grouped into fixed time buckets so that late (backfilled) messages
-- rebuild only their own bucket deterministically.
CREATE TABLE search.chunks (
  account_id       bigint NOT NULL,
  chat_id          bigint NOT NULL,
  topic_key        bigint NOT NULL DEFAULT 0,
  bucket_start     timestamptz NOT NULL,
  part             integer NOT NULL,
  message_ids      bigint[] NOT NULL,
  first_sent_at    timestamptz NOT NULL,
  last_sent_at     timestamptz NOT NULL,
  body             text NOT NULL,
  body_hash        text NOT NULL,
  tsv              tsvector GENERATED ALWAYS AS (
                     to_tsvector('russian', body) || to_tsvector('simple', body)
                   ) STORED,
  embedding        vector(1024),
  embedding_model  text,
  indexed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, chat_id, topic_key, bucket_start, part)
);

CREATE INDEX chunks_tsv_idx ON search.chunks USING gin (tsv);
CREATE INDEX chunks_time_idx ON search.chunks (account_id, last_sent_at);
CREATE INDEX chunks_pending_embedding_idx ON search.chunks (account_id) WHERE embedding IS NULL;
CREATE INDEX chunks_embedding_idx ON search.chunks USING hnsw (embedding vector_cosine_ops);

-- Indexer checkpoint per account and archive generation.
CREATE TABLE search.cursor (
  account_id   bigint NOT NULL,
  generation   integer NOT NULL,
  last_seq     bigint NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, generation)
);
