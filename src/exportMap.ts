/**
 * 將地圖匯出成 PNG。
 *
 * 技術難點：SVG → Canvas 嘅 `<image>` 外部資源
 * ============================================
 * SVG 入面嘅底圖係 `<image href="assets/...png">`（外部檔案）。
 * 直接將 SVG 序列化成 data URL 再畫落 canvas，外部圖**唔會載入**
 * （canvas 對 SVG 內嘅外部資源有 taint 限制），結果匯出嘅圖只有
 * 標記、冇底圖。
 *
 * 解法：匯出之前先將所有 `<image>` 嘅 href **換成 inline data URL**
 * （fetch → base64）。同源資源冇 CORS 問題。
 *
 * ⚠️ 為何唔用 `foreignObject`：Safari 對 SVG 內嘅 foreignObject 支援
 *    唔完整，而且會將 HTML 樣式帶入 SVG，令匯出結果同畫面唔一致。
 *
 * Phase L 新增：向量底圖係 `<canvas>`
 * ==================================
 * 向量底圖唔喺 SVG 入面（見 `src/map/VectorBasemap.ts`），所以序列化
 * SVG **完全唔會包含底圖** —— 實測匯出嘅 PNG 由 800 KB 跌到 58 KB，
 * 即係得一層標記。
 *
 * 解法：呼叫者傳入底圖 `<canvas>`，匯出時先畫底圖，再畫 SVG。
 */

/** 將一個 URL 轉成 data URL。 */
async function toDataUrl(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`載入 ${url} 失敗：HTTP ${r.status}`);
  const blob = await r.blob();
  return await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error(`讀取 ${url} 失敗`));
    fr.readAsDataURL(blob);
  });
}

export interface ExportOptions {
  /** 輸出倍率（1 = 畫面像素；2 = Retina）。 */
  scale?: number;
  /** 檔名（唔含副檔名）。 */
  filename?: string;
  /** 背景色（唔填就用透明）。 */
  background?: string;
  /**
   * 向量底圖 `<canvas>`。
   *
   * 有傳入嘅話，會先畫佢再畫 SVG —— 因為底圖唔屬於 SVG 樹，
   * 序列化 SVG 攞唔到。
   */
  underlay?: HTMLCanvasElement | null;
}

/**
 * 將 SVG 地圖匯出成 PNG 並觸發下載。
 *
 * 回傳實際輸出嘅尺寸，方便顯示提示。
 */
export async function exportMapPng(
  svg: SVGSVGElement,
  opts: ExportOptions = {},
): Promise<{ width: number; height: number; filename: string }> {
  const scale = opts.scale ?? 2;
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    throw new Error("地圖未載入，無法匯出");
  }

  // 1. 複製 SVG（唔可以改原本嘅 DOM）
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  clone.setAttribute("width", String(rect.width));
  clone.setAttribute("height", String(rect.height));

  // 2. 將所有 <image> 嘅 href 換成 data URL
  const images = Array.from(clone.querySelectorAll("image"));
  const originals = Array.from(svg.querySelectorAll("image"));
  for (let i = 0; i < images.length; i++) {
    const href =
      originals[i]?.getAttribute("href") ||
      originals[i]?.getAttribute("xlink:href") ||
      "";
    if (!href || href.startsWith("data:")) continue;
    try {
      const abs = new URL(href, document.baseURI).href;
      const dataUrl = await toDataUrl(abs);
      images[i].setAttribute("href", dataUrl);
      images[i].removeAttribute("xlink:href");
    } catch (e) {
      // 單一圖層載入失敗唔應該令成個匯出失敗 —— 至少其餘內容要出到
      console.warn("[匯出] 略過圖層", href, e);
      images[i].remove();
    }
  }

  // 3. 序列化 → Blob URL → Image
  const svgStr = new XMLSerializer().serializeToString(clone);
  const svgBlob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
  const svgUrl = URL.createObjectURL(svgBlob);

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("SVG 載入失敗（可能含不支援嘅內容）"));
      el.src = svgUrl;
    });

    // 4. 畫落 canvas
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(rect.width * scale);
    canvas.height = Math.round(rect.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("瀏覽器唔支援 canvas 2D");
    if (opts.background) {
      ctx.fillStyle = opts.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    // 先畫向量底圖（如果當下用緊），再畫 SVG 標記層
    if (opts.underlay && opts.underlay.width > 0) {
      ctx.drawImage(opts.underlay, 0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    // 5. 下載
    const filename = `${opts.filename ?? "binggang-map"}.png`;
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) throw new Error("產生 PNG 失敗");

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 延遲釋放：即刻 revoke 可能令下載中斷
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    return { width: canvas.width, height: canvas.height, filename };
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}
