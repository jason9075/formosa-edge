# 效能與版面優化策略 — PC vs Mobile

本文件記錄 Formosa's Edge 針對**桌機(PC)**與**行動裝置(Mobile)**採用的兩套不同優化策略,
以及背後的取捨理由。所有設定集中由兩個偵測旗標驅動,避免散落各處難以維護。

## 偵測機制

專案用**兩個獨立**的判斷條件,各自負責不同層面:

| 旗標 | 定義 | 位置 | 負責範圍 | 特性 |
|------|------|------|----------|------|
| `IS_MOBILE` | `matchMedia('(pointer: coarse)').matches` | `src/main.js:69` | renderer / 效能取捨 | 載入時固定一次 |
| `mobilePanelMQ` | `matchMedia('(max-width: 767px)')` | `src/main.js:592` | UI 版面配置 | 隨轉向 / 縮放即時變動 |

> **為何分開?**
> - 效能取捨看的是「硬體本質」——觸控裝置幾乎都是行動 GPU(Mali / Adreno / PowerVR,
>   記憶體常 < 1 GB)且靠電池供電,這類特性在 session 期間不會變,所以用 `pointer: coarse`
>   一次判定即可。
> - 版面配置看的是「當下可用寬度」——使用者可能轉向或調整視窗,需要即時回應,所以用
>   `max-width: 767px` 斷點並監聽 `change`。

---

## 一、Renderer / 效能策略(由 `IS_MOBILE` 驅動)

| 項目 | PC | Mobile | 理由 |
|------|----|--------|------|
| **DPR 上限** (`DPR_CAP`) | `min(dpr, 2)` | `min(dpr, 1.5)` | fragment 工作量是 DPR²;手機回報 2.5–3.5,不設限會多 6–12 倍負擔 |
| **MSAA** (`antialias`) | `true` | `false` | MSAA 在行動 GPU 昂貴;DPR 已 clamp,關閉後視覺差異小 |
| **陰影類型** | `PCFSoftShadowMap` | `PCFShadowMap` | soft 版多一輪取樣;手機改用基本 PCF |
| **陰影貼圖** | `2048²` | `1024²` | 縮小貼圖省 GPU 記憶體與第二個 render pass |
| **`logarithmicDepthBuffer`** | ON | **ON(刻意保留)** | 關閉會讓全島 z-fighting(near=1 .. far=1e6),比它在 tile-based GPU 的 fillrate 成本嚴重得多 |
| **FPS 上限** (`FRAME_MIN_MS`) | 無上限(`0`) | ~30fps(`33` ms) | 場景多為靜態,30fps 省一半 GPU 繪製、電池與發熱;`rAF` 仍持續,只 gate render body |

對應程式碼:`src/main.js:70`(DPR)、`77`(MSAA)、`79`(陰影類型)、`294`(陰影貼圖)、
`2348`(FPS)、`112` / `620`(`setPixelRatio`,後者在 `resize()` 重設以因應轉向)。

### Tile 串流工作集(由 `IS_MOBILE` 驅動)

| 常數 | PC | Mobile | 理由 |
|------|----|--------|------|
| `DETAIL_DIST` | `18000` m | `9000` m | 縮小 20 m 細節 tile 半徑,降低同時下載量(細節 tile 共 ~184 MB) |
| `DETAIL_MAX` | `160` | `48` | 常駐 20 m tile 上限;手機記憶體 < 1 GB,160 個 Draco mesh 易被 OS 殺掉分頁 |
| `BASE_MAX` | `320` | `96` | 常駐 100 m tile 上限 |
| `MAX_CONCURRENT` | `8` | `4` | 行動網路 / HTTP-1.1 下並發過多反而互搶頻寬 |

對應程式碼:`src/main.js:509`、`512`、`513`、`514`。

---

## 二、UI 版面策略(由 `mobilePanelMQ` / CSS `@media (max-width: 767px)` 驅動)

| 元件 | PC | Mobile | 說明 |
|------|----|--------|------|
| **控制面板** | 右側固定 panel,向右滑出收合 | **頂部 sheet**,向上滑出收合 | 手機橫向空間有限,改為頂部下拉式 |
| **收合把手** | 右緣垂直 tab,圖示 `‹` / `›` | 底緣置中水平 grip,圖示 `▴` / `▾` | 圖示方向隨版面切換(`setPanelOpen`) |
| **指北針 gizmo** | 左下角(footer 上方) | **左上角**(header 下方) | 讓出左下角給 PAN 圓盤 |
| **相機 PAN 圓盤** | 不顯示 | **左下角虛擬搖桿** | 觸控無中鍵拖曳 PAN,故補一個拇指可操作的搖桿 |
| **Debug HUD** | 左上角(預設) | **右下角**(避開頂部 sheet) | 預設位置避免被頂部面板遮住;仍可拖曳 |
| **底部 bar** | 三欄 | 兩欄(隱藏操作提示) | 窄螢幕重排 |

對應程式碼:
- 面板 / 把手版面:`src/style.css` 的 `@media (max-width: 767px)` 區塊。
- 把手圖示切換:`src/main.js` `setPanelOpen()`(`mobilePanelMQ.matches` 判斷)。
- 指北針位置:`src/main.js` `renderGizmo()`(`mobilePanelMQ.matches` 分支)。
- PAN 圓盤邏輯:`src/main.js` `applyPanDial()` 與 `#pan-dial` 事件處理。
- Debug HUD 預設位置:`src/main.js` 建立 `stats` 後依 `IS_MOBILE` 設定 bottom-right。

### 相機 PAN 圓盤(virtual joystick)細節

- **外觀**:純白圓鈕 + 深色四向移動箭頭(data-URI SVG),外圈為透明觸控區。
- **互動**:`pointerdown/move` 將旋鈕偏移正規化為 `[-1, 1]` 向量,放開時 CSS transition 彈回中心。
- **平移運算**:`applyPanDial(dt)` 每幀在 `controls.update()` 前,沿地面(XZ)平面平移
  `camera.position` 與 `controls.target`。速度乘上「相機 ↔ target 距離」確保遠近縮放手感一致,
  並乘 `dt` 使 30 / 60 fps 行為相同。
- **與 LOD 協調**:拖曳時設 `cameraMoving = true` 抑制 20 m tile 串流,放開 300 ms 後恢復
  (沿用既有 `movingTimer` 機制)。

---

## 三、觸控 / viewport(全行動裝置適用)

- `index.html` viewport meta:`maximum-scale=1, user-scalable=no, viewport-fit=cover`
  — 防止頁面 pinch 縮放與 canvas 手勢衝突。
- `#canvas` 與 `#pan-dial`:`touch-action: none` — 把手勢完全交給 OrbitControls / 搖桿,
  不讓瀏覽器攔截成捲動或縮放。

---

## 已知踩雷與設計決定

1. **`setViewport` / `setScissor` 內部已乘 pixelRatio**:gizmo 程式碼若再手動 `* dpr` 會雙重縮放。
   在左下角時誤差小看不出來,移到左上角後 `y` 會超出 buffer 高度導致指北針消失。修正後一律傳 CSS px。
2. **`logarithmicDepthBuffer` 不在手機關閉**:雖然 fillrate 成本較高,但關閉的 z-fighting 代價更糟。
   若日後要省這筆,正解是「相機高度自適應 near plane」而非直接關掉。
3. **真 on-demand rendering 改用 FPS cap 取代**:render-on-invalidate 需在每個會改變場景的互動點手動
   標記重繪,touch-point 多、回歸風險高;30fps cap 拿到大部分電池 / 散熱收益且零正確性風險。
