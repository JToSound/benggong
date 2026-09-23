// 驗證 IA-P2-2 理由：新增 focus param 係唔係真會令 isCanonical() 失敗？
// isCanonical(url) = url.search === toUrl(fromUrl(url)) && url.hash === ""
// 關鍵：toUrl/fromUrl 都喺 src/state/url.ts（B7 紅線）。若 B7 "唔可以改"，
// param 就永遠唔會 round-trip → isCanonical 恆 false。
import { readFileSync } from "node:fs";
const url = readFileSync("src/state/url.ts", "utf8");
// 檢查 toUrl 有無 "focus" / pendingFocus 序列化
console.log("toUrl 有序列化 focus/pendingFocus?", /focus/i.test(url.split("export function fromUrl")[0]));
console.log("URL_PARAM 有 focus?", /focus\s*:/.test(url));
// 檢查 isCanonical 定義
const m = url.match(/export function isCanonical[\s\S]*?\n}/);
console.log("isCanonical 實作:\n" + m[0]);
// 檢查 B7 是否真係冇改 url.ts（時間戳）
