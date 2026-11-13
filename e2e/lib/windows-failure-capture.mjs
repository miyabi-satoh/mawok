// run.mjs と msix-run.mjs が各テストファイルの前に `--import` で読み込む。テストの本体が落ちたら、その時点の画面と窓の一覧を残す
// (テストファイルごとに書かずに済むよう、ここで全体に掛ける)。アプリを閉じるテストファイルの afterEach はこの afterEach より
// 先に回るので、閉じる所 (setup.mjs の closeClient) でも残す (os.mjs の captureIfFailed)。本体の中の finally で閉じた窓は、もう写らない
import { afterEach, beforeEach } from 'node:test';
import { captureIfFailed, trackTest } from './os.mjs';

beforeEach((t) => trackTest(t));
afterEach(() => captureIfFailed());
