-- AI アクションをやめたので、残高の表 (付与・使った分・中継の印) を消す。
-- 使った分 (consumptions) は付与 (grants) を指すので先に消す。購入の台帳 (purchases) は Pro の請求書の分を残すので消さない。
DROP TABLE consumptions;
DROP TABLE grants;
DROP TABLE ai_in_flight;
