"""《病港》Phase B — OpenRouter extraction pipeline 核心。

設計（master prompt §7）：
- 只讀 data/private/cleaned/bing-gang.clean.jsonl；全文永不離開 private
- 章節分批 → strict JSON schema validation → 低 temperature
- run ledger（只記 metadata+hash）、retry 一次、可中斷續跑 cache
- confidence + evidence_excerpt 全部留喺 data/private/
- 無 key 時 exit non-zero 並顯示粵文說明，唔會偽造任何結果

本模組只提供基建（client、segmentation、validation、ledger、cache）；
真正全書 run 由 scripts/run_extraction.py 執行。
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from novel_lib import SCHEMA_VERSION, parse_jsonl  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CLEANED = REPO_ROOT / "data/private/cleaned/bing-gang.clean.jsonl"
PRIVATE_DIR = REPO_ROOT / "data/private"
CACHE_DIR = PRIVATE_DIR / "cache/extraction-runs"
LEDGER_PATH = PRIVATE_DIR / "review/extraction-ledger.jsonl"

# ---- 分段參數 ----
SEGMENT_CHAR_BUDGET = 6000  # 每段正文上限（字符）；章節過長會切分
MAX_CHAPTER_CHARS = 12000  # 超過就必須切分

# extraction temperature：master prompt §7.2 規定 0–0.2
EXTRACTION_TEMPERATURE = 0.1


class ExtractionConfigError(RuntimeError):
    """配置錯誤（缺 key 等）。"""


def load_env(repo_root: Path = REPO_ROOT) -> dict[str, str]:
    """極簡 .env 讀取（唔覆蓋已存在環境變數）。"""
    env_path = repo_root / ".env"
    values: dict[str, str] = {}
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            values[k.strip()] = v.strip().strip('"').strip("'")
    return values


def require_api_key() -> tuple[str, str]:
    """由 OPENROUTER_API_KEY 讀 key（環境變數優先，其次 .env）。

    缺 key 時 raise ExtractionConfigError，絕不繼續。
    回傳 (api_key, base_url)。
    """
    env = load_env()
    api_key = os_environ_get("OPENROUTER_API_KEY") or env.get("OPENROUTER_API_KEY", "")
    if not api_key:
        raise ExtractionConfigError(
            "缺少 OPENROUTER_API_KEY。\n"
            "請喺專案根目錄建立 .env（可複製 .env.example），加入：\n"
            "  OPENROUTER_API_KEY=sk-or-v1-…\n"
            "  OPENROUTER_EXTRACTION_MODEL=<你想用嘅模型>\n"
            "或者直接 export OPENROUTER_API_KEY。設定好之後重新執行。"
        )
    base_url = os_environ_get("OPENROUTER_BASE_URL") or env.get(
        "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"
    )
    return api_key, base_url


def os_environ_get(name: str) -> str:
    import os

    return os.environ.get(name, "").strip()


@dataclass
class Segment:
    """一章可以切成多個 segment 送 model。"""

    chapter: int
    segment_index: int
    text: str
    prompt_hash: str = ""
    cache_key: str = ""


def build_segments(chapter: int, content: str) -> list[Segment]:
    """按段落邊界切分，每段 ≤ SEGMENT_CHAR_BUDGET。

    切分策略：以 \n\n 分段貪心合併；單段超長先硬切（保留句子完整性盡量）。
    """
    if len(content) <= SEGMENT_CHAR_BUDGET:
        paras = [content]
    else:
        paras: list[str] = []
        current: list[str] = []
        size = 0
        for p in content.split("\n\n"):
            plen = len(p)
            if size + plen > SEGMENT_CHAR_BUDGET and current:
                paras.append("\n\n".join(current))
                current, size = [], 0
            # 單一段落本身就超長：硬切
            while len(p) > SEGMENT_CHAR_BUDGET:
                paras.append(p[:SEGMENT_CHAR_BUDGET])
                p = p[SEGMENT_CHAR_BUDGET:]
            current.append(p)
            size += len(p)
        if current:
            paras.append("\n\n".join(current))

    segments = []
    for i, text in enumerate(paras):
        h = hashlib.sha256(
            json.dumps(
                {"chapter": chapter, "segment": i, "text": text},
                ensure_ascii=False,
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()
        segments.append(Segment(chapter=chapter, segment_index=i, text=text, prompt_hash=h))
    return segments


def iter_cleaned_rows(path: Path = DEFAULT_CLEANED):
    """逐章 yield (issue_index, chapter_num, content)；唔會複製全文入記憶體以外嘅地方。"""
    rows = parse_jsonl(path)
    for r in sorted(rows, key=lambda x: x["issue_index"]):
        yield r["issue_index"], r["chapter_num"], r["content"]


# ============================================================
# OpenRouter client（標準庫 urllib，無額外依賴）
# ============================================================


class OpenRouterClient:
    def __init__(self, api_key: str, base_url: str, timeout_s: int = 90):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self.calls_made = 0

    def chat(self, model: str, messages: list[dict], temperature: float, max_tokens: int = 16000) -> str:
        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
        }
        req = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                # OpenRouter 建議標識 app
                "HTTP-Referer": "https://github.com/bing-gang-map",
                "X-Title": "Bing Gang Map Extraction",
            },
            method="POST",
        )
        self.calls_made += 1
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                body_bytes = resp.read()
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")[:300]
            if e.code == 429:
                # 上游限流：標記清楚俾 retry 邏輯用更長 backoff
                raise RuntimeError(f"OpenRouter HTTP 429 rate-limited：{body}") from e
            raise RuntimeError(f"OpenRouter HTTP {e.code}：{body}") from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"OpenRouter 連線失敗：{e.reason}") from e
        # 上游間歇性會回傳截斷／HTML 錯誤頁（非 JSON）——當作可 retry，
        # 唔可以令成個 pipeline crash。
        try:
            data = json.loads(body_bytes.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            preview = body_bytes[:120].decode("utf-8", errors="replace")
            raise RuntimeError(f"OpenRouter 回應非 JSON（{e}）：{preview!r}") from e
        try:
            choice = data["choices"][0]
            content = choice["message"].get("content")
            finish = choice.get("finish_reason")
        except (KeyError, IndexError) as e:
            raise RuntimeError(f"OpenRouter 回應格式異常：{e}") from e
        if not content or not isinstance(content, str):
            # reasoning 模型可能燒盡 max_tokens 喺 reasoning，content 變 null；
            # finish_reason=length 即係要加大預算。當作可 retry 錯誤回報。
            raise RuntimeError(f"OpenRouter 回應 content 空白或非字串（finish_reason={finish}）")
        return content


# ============================================================
# Run ledger + cache（全部私有）
# ============================================================


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class RunLedger:
    """JSONL ledger：只記 metadata 同 hash，永遠不記正文或完整 request/response。"""

    def __init__(self, path: Path = LEDGER_PATH):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, record: dict) -> None:
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

    def completed_keys(self) -> set[str]:
        done: set[str] = set()
        if not self.path.exists():
            return done
        with open(self.path, encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("status") == "ok":
                    done.add(f"{rec['chapter']}:{rec.get('segment_index', 0)}")
        return done


class ExtractionCache:
    """以 cache_key（prompt_hash+model+schema version）儲存 LLM raw JSON 回應。

    用途：中斷續跑、retry 免重複計費。內容屬私有 material。
    """

    def __init__(self, root: Path = CACHE_DIR, run_id: str = ""):
        self.root = root / run_id if run_id else root
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        return self.root / f"{key}.json"

    def get(self, key: str):
        p = self._path(key)
        if p.exists():
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                return None
        return None

    def put(self, key: str, value: dict) -> None:
        self._path(key).write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def call_with_retry(
    client: OpenRouterClient,
    model: str,
    system_prompt: str,
    user_prompt: str,
    cache: ExtractionCache,
    ledger: RunLedger,
    chapter: int,
    segment_index: int,
    schema_version: str,
    max_attempts: int = 2,
    backoff_s: float = 3.0,
) -> tuple[dict | None, str]:
    """呼叫 LLM 並驗證 strict JSON。回傳 (parsed_dict|None, status)。

    status ∈ ok / invalid_schema_review_queue / error
    retry 上限 master prompt §7.1：invalid 可 retry 一次。
    """
    cache_key = hashlib.sha256(
        json.dumps(
            {
                "model": model,
                "system": system_prompt,
                "user": user_prompt,
                "temp": EXTRACTION_TEMPERATURE,
                "schema_version": schema_version,
            },
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()

    cached = cache.get(cache_key)
    attempts_log = []

    # 兩層 retry：暫時性錯誤（429/連線）可以等多幾次；
    # schema/JSON 錯誤按 master prompt §7.1 只 retry 一次。
    MAX_TRANSIENT = 6
    transient_attempt = 0
    attempt = 0
    parsed = None

    while True:
        attempt += 1
        if cached and cached.get("_valid") and parsed is None:
            parsed = cached["parsed"]
            status = "ok"
            break

        try:
            raw = client.chat(
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=EXTRACTION_TEMPERATURE,
            )
            assert isinstance(raw, str) and raw.strip(), "回應空白"
        except (RuntimeError, AssertionError) as e:
            msg = str(e)
            is_transient = (
                "429" in msg
                or "連線" in msg
                or "回應 content 空白" in msg
                or "格式異常" in msg
                or "回應非 JSON" in msg
            )
            attempts_log.append({"attempt": attempt, "error": msg[:200]})
            if not is_transient:
                ledger.append(_ledger_rec(chapter, segment_index, model, user_prompt, schema_version, "error", attempts_log))
                return None, "error"
            transient_attempt += 1
            # 每日配額（free-models-per-day）要等重置：10 分鐘週期守夜探測，
            # 最長約 20 小時；配額恢復後自動全速繼續，唔使人手干預。
            if "per-day" in msg:
                if transient_attempt > 120:
                    ledger.append(_ledger_rec(chapter, segment_index, model, user_prompt, schema_version, "error", attempts_log))
                    return None, "error"
                attempts_log.append({"attempt": attempt, "note": "daily quota - 守夜等待 600s"})
                time.sleep(600)
                continue
            if transient_attempt >= MAX_TRANSIENT:
                ledger.append(_ledger_rec(chapter, segment_index, model, user_prompt, schema_version, "error", attempts_log))
                return None, "error"
            wait = min(120.0, backoff_s * (2 ** (transient_attempt - 1)))  # 3s→6s→12s→24s→48s(→96s cap 120)
            time.sleep(wait)
            continue

        try:
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                # 部分模型會包 ```json fence 或前後空白；剝完再試
                stripped = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
                parsed = json.loads(stripped)
        except json.JSONDecodeError as e:
            attempts_log.append({"attempt": attempt, "error": f"invalid JSON: {e}"})
            n_json_err = sum(1 for a in attempts_log if "invalid JSON" in a["error"])
            if n_json_err >= max_attempts:
                ledger.append(_ledger_rec(chapter, segment_index, model, user_prompt, schema_version, "invalid_schema_review_queue", attempts_log))
                return None, "invalid_schema_review_queue"
            time.sleep(backoff_s * n_json_err)
            continue

        if isinstance(parsed, dict):
            status = "ok"
            break
        attempts_log.append({"attempt": attempt, "error": "response 唔係 object"})
        n_bad = sum(1 for a in attempts_log if "object" in a["error"])
        if n_bad >= max_attempts:
            ledger.append(_ledger_rec(chapter, segment_index, model, user_prompt, schema_version, "invalid_schema_review_queue", attempts_log))
            return None, "invalid_schema_review_queue"
        time.sleep(backoff_s)

    if status == "ok":
        cache.put(cache_key, {"_valid": True, "parsed": parsed})
        ledger.append(_ledger_rec(chapter, segment_index, model, user_prompt, schema_version, "ok", attempts_log))
        return parsed, "ok"

    ledger.append(_ledger_rec(chapter, segment_index, model, user_prompt, schema_version, "invalid_schema_review_queue", attempts_log))
    return None, "invalid_schema_review_queue"


def _ledger_rec(
    chapter: int, seg: int, model: str, user_prompt: str, schema_version: str, status: str, attempts: list
) -> dict:
    return {
        "run_ts": now_iso(),
        "chapter": chapter,
        "segment_index": seg,
        "model_id": model,
        "temperature": EXTRACTION_TEMPERATURE,
        # 只記 hash，唔記正文
        "prompt_hash": hashlib.sha256(user_prompt.encode("utf-8")).hexdigest(),
        "schema_version": schema_version,
        "status": status,
        "attempts": attempts[:2],
    }


# ============================================================
# Candidate 儲存（私有）
# ============================================================


@dataclass
class CandidateStore:
    """candidates.jsonl append-only store（private evidence）。"""

    path: Path = PRIVATE_DIR / "evidence/candidates.jsonl"
    count: int = field(default=0, init=False)

    def __post_init__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.count = self.count_existing()

    def count_existing(self) -> int:
        if not self.path.exists():
            return 0
        n = 0
        with open(self.path, encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    n += 1
        return n

    def append(self, cand: dict) -> None:
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(cand, ensure_ascii=False) + "\n")
        self.count += 1
