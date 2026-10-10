-- Mawok を結ぶ流れを、確認コードを見比べる形から、ブラウザを Mawok の待ち受け (127.0.0.1) へ戻す形にする
-- (→ docs/account-server.md「Mawok とアカウントを結ぶ」)。

DROP TABLE links;

-- 「この Mawok と結ぶ」で作った、一度きりのコード。Mawok がトークンに替えたら消す。
CREATE TABLE link_codes (
	code_hash TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	-- Mawok が申し込みに付けた、検証用の値の SHA-256 (16進)。替えるときに検証用の値そのものと照らす。
	challenge TEXT NOT NULL,
	name TEXT NOT NULL,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);

-- 窓口の画面で、どのデバイスの Mawok かを見分けられるように。名前の無い行 (この版より前に結んだもの) は「Mawok」と出す。
ALTER TABLE app_tokens ADD COLUMN name TEXT;
