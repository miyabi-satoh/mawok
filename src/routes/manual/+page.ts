import { platformFromUrl } from '$lib/keys';
import type { PageLoad } from './$types';

// 閉じるキーと本文の書き分けを OS で分ける
export const load: PageLoad = ({ url }) => ({ platform: platformFromUrl(url) });
