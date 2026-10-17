-- 使った分を売値に直す式 (purchases.amount × milli_yen ÷ grant_size) を、アカウントを消して付与の行が無くなった後も出せるように、
-- 引いた付与の付けた量 (grants.granted) を引く時点で写す (→ docs/account-server.md「残高」)。
ALTER TABLE consumptions ADD COLUMN grant_size INTEGER CHECK (grant_size > 0);
-- もうある行は、付与の行が残っていればそこから写す。grant_id は Pro の導入より前の行に無いので、購入の分は台帳の番号でも引く。
UPDATE consumptions SET grant_size = coalesce(
	(SELECT granted FROM grants WHERE grants.id = consumptions.grant_id),
	(SELECT granted FROM grants WHERE grants.purchase_id = consumptions.purchase_id)
);
