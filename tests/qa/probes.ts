/**
 * probes.ts — 注入瀏覽器嘅 init script 源碼。
 *
 * 為何要呢個檔
 * ============
 * Q3 / Q4 要讀 canvas **像素**（flatRatio / meanGrad），Q7 要知 App 真正
 * 畫咗邊啲標籤同字級，Q10 要 longtask，Q11 要知「此區未有細節資料」
 * 呢句字有冇真係畫過。呢啲全部要喺**頁面載入之前**掛鈎（`addInitScript`）
 * 先捉得到。
 *
 * ⚠️ 呢個檔**零 import**、零 Node API —— 純字串，令 vitest（node 環境）
 * 同 Playwright 都可以直接食。
 *
 * ⚠️ 註解內唔可以出現 `*` 加 `/` 嘅序列（會提早終止 block comment）。
 */

/** 量測結果（由 `window.__b9` 提供）。 */
export interface B9CanvasMetrics {
  flatRatio: number;
  veryFlatRatio: number;
  meanGrad: number;
  edgeDensity: number;
  width: number;
  height: number;
}

/** 一次 canvas `fillText` 嘅記錄。 */
export interface B9LabelRec {
  /** 畫嘅字串（真係由 App 傳入）。 */
  t: string;
  /** `ctx.font` 全文，例如 `600 13.5px "Noto Sans TC", ...`。 */
  font: string;
  /** 文字基準點（CSS px，canvas 左上角為原點）。 */
  x: number;
  y: number;
  align: string;
  baseline: string;
}

export interface B9LongTask {
  start: number;
  dur: number;
}

/** `window.__b9` 嘅形狀（喺頁面 context 用）。 */
export interface B9Probe {
  labels: B9LabelRec[];
  longTasks: B9LongTask[];
  metrics(canvas: HTMLCanvasElement): B9CanvasMetrics;
}

/**
 * 主 init script。
 *
 * 三件事：
 *   1. dismiss onboarding（令卡片唔遮地圖，量測先確定）
 *   2. 掛 `fillText` 鈎（Q7 標籤字級／Q11 狀態文字）
 *   3. 開 `longtask` PerformanceObserver（Q10）
 */
export const B9_INIT_SCRIPT = `
(() => {
  try { localStorage.setItem("binggang.onboarding.dismissed", "1"); } catch (e) {}

  var b9 = {
    labels: [],
    longTasks: [],
    metrics: function (canvas) {
      var ctx = canvas.getContext("2d");
      var W = canvas.width, H = canvas.height;
      var d = ctx.getImageData(0, 0, W, H).data;
      var N = W * H;
      var lum = new Float32Array(N);
      for (var i = 0; i < N; i++) {
        lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
      }
      var flat = 0, veryFlat = 0, tot = 0, gs = 0, edge = 0;
      for (var y = 1; y < H - 1; y++) {
        var row = y * W;
        for (var x = 1; x < W - 1; x++) {
          var k = row + x;
          var g = Math.abs(lum[k + 1] - lum[k - 1]) + Math.abs(lum[k + W] - lum[k - W]);
          tot++;
          gs += g;
          if (g < 4) flat++;
          if (g < 2) veryFlat++;
          if (g > 24) edge++;
        }
      }
      return {
        flatRatio: flat / tot,
        veryFlatRatio: veryFlat / tot,
        meanGrad: gs / tot,
        edgeDensity: edge / tot,
        width: W,
        height: H
      };
    }
  };
  window.__b9 = b9;

  var P = CanvasRenderingContext2D.prototype;
  if (!P.__b9Hooked) {
    P.__b9Hooked = true;
    var orig = P.fillText;
    P.fillText = function (t, x, y) {
      try {
        window.__b9.labels.push({
          t: String(t),
          font: String(this.font),
          x: x,
          y: y,
          align: String(this.textAlign),
          baseline: String(this.textBaseline)
        });
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  }

  try {
    new PerformanceObserver(function (list) {
      var es = list.getEntries();
      for (var i = 0; i < es.length; i++) {
        window.__b9.longTasks.push({ start: es[i].startTime, dur: es[i].duration });
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch (e) {}
})();
`;

/** 讀 `window.__b9` 嘅型別斷言（頁面 context 冇 TS 型別）。 */
export function b9Window(): B9Probe {
  return (window as unknown as { __b9: B9Probe }).__b9;
}
