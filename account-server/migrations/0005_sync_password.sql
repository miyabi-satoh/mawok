-- 同期の鍵を、利用者が決める同期のパスワードで包んで置く (→ docs/sync.md「同期のパスワード」)。
-- 窓口は包んだ鍵を解釈しない。パスワードも鍵そのものも窓口には届かない。

ALTER TABLE sync_accounts ADD COLUMN wrapped_key TEXT;
