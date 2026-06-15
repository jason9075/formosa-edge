# LOD Refactor Plan

## 目標架構

```
高空 (alt > FAR_ALT_EXIT = 22000)
  → 只顯示 monolithic taiwan_100m.glb
  → 所有 tiles 卸載

【緩衝區 FAR_ALT_ENTER ~ FAR_ALT_EXIT】
  → 維持當前狀態不切換（hysteresis）
  → 從低空上升：繼續顯示 tiles，直到超過 FAR_ALT_EXIT
  → 從高空下降：繼續顯示 monolithic，直到低於 FAR_ALT_ENTER

低空 (alt < FAR_ALT_ENTER = 18000) + camera 移動中
  → 隱藏 monolithic
  → frustum 內所有 tile → 100m (base_tiles/)
  → 不載新 20m tiles；已載入的 20m 保留不 dispose

低空 (alt < FAR_ALT_ENTER = 18000) + camera 靜止
  → 隱藏 monolithic
  → frustum 內近距 (< DETAIL_DIST) → 20m tiles
  → frustum 內遠距 → 100m tiles
```

## 過渡邏輯（避免黑屏）

高空 → 低空切換時：
1. monolithic **保持顯示**
2. 開始載入 camera 附近的 100m tiles（frustum culling）
3. 等視野內 tile 全部 loaded（`wantBase` 全部在 `baseTiles` 中）才隱藏 monolithic

低空 → 高空切換時：
1. 先顯示 monolithic
2. 然後 dispose 所有 tiles

## 需要修改的地方（src/main.js）

### 1. 新增 cameraMoving 狀態

```javascript
let cameraMoving = false;
let movingTimer = null;
controls.addEventListener('change', () => {
  cameraMoving = true;
  clearTimeout(movingTimer);
  movingTimer = setTimeout(() => { cameraMoving = false; }, 300);
});
```

### 2. 新增 tilesModeActive 狀態

控制 monolithic 顯示/隱藏，避免黑屏：

```javascript
let tilesModeActive = false; // true = monolithic hidden, tiles running
```

### 3. 移除 BASE_DIST 距離限制

目前 `BASE_DIST = 70000` 限制 100m tile 載入距離，改成純 frustum 判斷（全 frustum 內都載）。
`DETAIL_DIST` 保留（靜止時近距升 20m 的門檻）。

保留的常數：
- `FAR_ALT_EXIT = 22000` — tile 模式退出高度（上升超過此值 → monolithic）
- `FAR_ALT_ENTER = 18000` — tile 模式進入高度（下降低於此值 → tiles）
- 兩者之間為緩衝區，維持當前狀態（hysteresis，避免在邊界頻繁切換）
- `DETAIL_DIST = 18000` — 靜止時 20m 載入半徑
- `DETAIL_EVICT = 24000` — 20m evict 距離
- `LOD_HYST = 4000` — anti-thrash
- `DETAIL_MAX = 160` — 20m 上限
- `BASE_MAX = 320` — 100m 上限（全 frustum 可能超過，視情況調高）
- `MAX_CONCURRENT = 8`

移除：
- `BASE_DIST = 70000`
- `BASE_EVICT = 85000`（改用 frustum 自然淘汰，out-of-frustum 的 tile 三.js 不渲染但還在記憶體；需另訂 evict 策略）

### 4. 重寫 updateTiles()

```
updateTiles():
  alt = camera.y - terrainBBox.min.y

  if alt > FAR_ALT:
    if tilesModeActive:
      show monolithic
      dispose all tiles
      tilesModeActive = false
    return

  // 低空模式
  if !tilesModeActive:
    // pre-warm：先載 100m，載完再切
    [開始載入視野內 100m tiles]
    if [視野內所有 cell 都在 baseTiles 中]:
      hide monolithic
      tilesModeActive = true
    return  // 還在等預熱，monolithic 繼續顯示

  // 正式 tile 模式
  frustum culling → 取得可見 cells

  evictions:
    - 20m: 超過 DETAIL_EVICT 或不在 frustum 的丟掉
    - 100m: 不在 frustum 的丟掉（純 frustum 邊界）

  if cameraMoving:
    // 只載 100m，不動 20m（已載的保留）
    for cell in visible:
      if !baseTiles.has(cell) && !baseLoading.has(cell):
        loadTile(cell, 'base')

  else:  // 靜止
    for cell in visible:
      d = distance(camera, cell)
      if d < DETAIL_DIST:
        upgrade: dispose 100m if exists, load 20m if missing
      else:
        downgrade: dispose 20m if exists (beyond DETAIL_EVICT + LOD_HYST), load 100m if missing

  capTiles(detailTiles, DETAIL_MAX)
  capTiles(baseTiles, BASE_MAX)
```

### 5. Stencil 拿掉

不再需要 backdrop stencil：
- `terrainMat` 移除 stencil 相關設定
- `tileMat` 移除 stencil write
- `tileMat.customProgramCacheKey` 改名（因為 stencil 設定不同了，原本的 'terrain-grid-tile-v1' 可繼續用）

## 待確認

- `BASE_MAX = 320` 夠不夠？全台低空 frustum 可能有 200–400 個 cell，視 FOV 和高度而定。
- 100m evict 策略：out-of-frustum 的 tile 要不要主動 dispose，還是靠 cap 自然淘汰？
  建議：靠 `capTiles` 按距離淘汰，不主動 dispose（避免 camera 快速掃視時一直 reload）。
- pre-warm 觸發時機：用 `detailFrameCount % 15` 的節奏同步處理，還是另開一次性邏輯？
