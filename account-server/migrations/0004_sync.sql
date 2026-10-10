-- Pro の機器間同期。窓口は復号できない暗号文だけを置く。

CREATE TABLE sync_accounts (
	account_id TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
	key_id TEXT,
	seq INTEGER NOT NULL DEFAULT 0,
	purged_seq INTEGER NOT NULL DEFAULT 0,
	bytes INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sync_items (
	account_id TEXT NOT NULL REFERENCES sync_accounts (account_id) ON DELETE CASCADE,
	collection TEXT NOT NULL CHECK (collection IN ('settings', 'history')),
	id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
	data BLOB,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (account_id, collection, id),
	CHECK ((deleted = 0 AND data IS NOT NULL) OR (deleted = 1 AND data IS NULL))
);
CREATE INDEX sync_items_account_seq ON sync_items (account_id, seq);
