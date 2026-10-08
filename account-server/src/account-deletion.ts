/**
 * アカウントを消す (→ docs/account-server.md「アカウントを消す」)。削除の請求は問い合わせで受け、運営者が `scripts/delete-account.mjs` で流す。
 * 残高 (grants)・トークン・サインインの状態・外部のサインインの結び付きは、外部キーで一緒に消える。
 * 購入の台帳 (purchases) は、外部キーで結び付きだけが外れて残る。使った分の記録 (consumptions) はもともとアカウントと結ばない。
 * どの文も `?1` にメールアドレス (小文字) を取る。スクリプトからも読むので、ほかのモジュールを import しない。
 */
export const DELETE_ACCOUNT_STATEMENTS = [
	'DELETE FROM checkouts WHERE account_id = (SELECT id FROM accounts WHERE email = ?1)',
	// 台帳に残すのは、取引の id・製品・額・日時・取り消したか・MP の取引か・国内の取引かだけ。
	`UPDATE purchases SET card_country = NULL, buyer_country = NULL, detached_at = unixepoch()
	 WHERE account_id = (SELECT id FROM accounts WHERE email = ?1)`,
	'DELETE FROM email_logins WHERE email = ?1',
	'DELETE FROM accounts WHERE email = ?1'
];
