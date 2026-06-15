# 3D 建物量體 Pipeline Plan（台北市）

## 目標

把台北市 3D 建物模型（`raw/buildings/`）轉成**白色 low-poly 量體**，依現有 5km tile
網格切分、依 20m DTM 地形起伏正確落地，前端低空時 stream 疊在地形上。

**最終視覺**：Mirror's Edge 風格 —— 純白量體、乾淨、強光照對比、邊緣清晰。

---

## 資料來源（raw/buildings/kmzs/）

台北市政府 3D 建物（Google Earth / SketchUp 匯出），多層 KML NetworkLink 樹：

```
Taipei3DBuilding_nl.kml          根：24 個 NetworkLink → 各區資料夾
└── <region>/<region>.kml        區根 (如 3357)
    └── <tile>_nl.kml            tile 網路連結
        └── <tile>_rN.kmz        ★ 實際資料 (ZIP，共 9037 個)
            ├── <tile>_rN.kml    多個 <Placemark><Model>
            ├── files/*.dae      COLLADA 建物網格（已是低面數擠出體）
            └── files/*.jpg      貼圖（★ 本計畫丟棄）
```

每個 `<Placemark><Model>`：
```xml
<Location><longitude/><latitude/><altitude>0</altitude></Location>
<Orientation><heading/><tilt/><roll/></Orientation>   ← 樣本全 0，仍需讀取套用
<Scale><x/><y/><z/></Scale>                            ← 樣本全 1
<Link><href>files/xxxx.dae</href></Link>
```

COLLADA：版本 1.4.1、**單位英吋（×0.0254 → 公尺）**、**Z_UP**、local 座標以 Location 為原點。

---

## 離線 Pipeline（Python，`buildings_to_glb.py`，repo 根目錄）

> **狀態**：PoC（區 3357）已完成並通過對齊驗證。以下反映實作現況。

### 1. 走訪 KMZ
`rglob raw/buildings/kmzs/**/*_r*.kmz`，跳過整棵 NetworkLink 樹（只是索引，不需解析）。
每個 KMZ：`zipfile` 開啟 → 讀內層 KML 取得每個 `<Model>` 的 (lon, lat, heading, scale, dae href)。

### 2. 解析 DAE（stdlib，無新依賴）
用 `xml.etree.ElementTree` 自寫解析（DAE 結構單純，避免引入 trimesh/pycollada）：
- 合併該 dae 內所有 `<geometry>/<mesh>`（建物拆成牆/頂多塊）。
- `<vertices>` → POSITION float_array；`<triangles>`（或 `<polylist>` fan 三角化）的 `<p>` 取 VERTEX
  offset、stride。
- 讀 `<unit meter>` 換算公尺；丟棄材質 / UV / 貼圖；假設 node transform 為 identity。

### 3. 座標 / 軸 / 單位轉換鏈（核心，務必正確）
```
頂點 local (inch, Z-up) → ×0.0254 公尺
套用 Orientation heading（繞 Z 旋轉，clockwise from north）+ Scale
local ENU：X=東, Y=北, Z=上
Location (lon/lat, WGS84) --pyproj 4326→3826--> TWD97 (E, N)
世界 TWD97：E' = E + xLocal,  N' = N + yLocal,  elev = zLocal
→ GLB 座標：x = E' - x_center,  z = -(N' - y_center),  y = elev (Y-up)
```
- `x_center / y_center` 從 `taiwan_100m.glb` 的 extras 取（與地形、tile 共用中心）。
- 子午線收斂（121.5°E vs 中央經線 121°E，約 0.2°）建物尺度可忽略。

### 4. 落地高度 clamp（最棘手）
源 `altitude=0` 相對的是他們自己的 DTM，**不可信任** → 用我們的 **raw 20m DTM**（`raw/taipei`）重新貼地。
- `TerrainSampler`：`load_tiles + build_grid`（step=1）建 20m 高度格，nearest 取樣。
- DTM 約 **42% no-data**（河道、被挖空的建物 footprint）→ NaN 命中時做**視窗最近有效格**搜尋：
  先 160m 視窗，footprint 四角全 miss 再擴到 ~1km（淡水河 / 社子島floodplain），最後才退全域 nanmin。
- 取 footprint **四角的最低地形高度**當基準 baseY，整棟平移到 baseY。
- `--foundation`（下沉量）**預設 0**（不下沉，基底直接坐地形上）；若 z-scale>1 浮空再調。
  → PoC 結果（3357）：895 棟、0 跳過，Y∈[-7, 124]m，對齊正確。

### 5. 兩種 LOD 表示（見下節） + 依 tile 切分
- `--mode {massing,box}`：massing=source 幾何；box=每棟 footprint AABB × 屋頂高 的方塊。
- `--tiled`：每棟依 Location 的 TWD97 (E, N) 算 5km tile key（同 `tile_dtm.py` 網格），
  同 tile 內 merge 成單一 flat-shaded geometry（position + per-face normal，無材質）。
- 輸出兩組，key 對齊：
  ```
  output/building_tiles/<key>.glb      ← massing
  output/building_boxes/<key>.glb      ← box
  output/building_tiles/index.json     ← {center, tileSize, tiles:[{key,url,cx,cz}]}
  ```
- 只產生**有建物的 tile**（台北市 ≈ 15–25 個 5km cell）。

### 6. 壓縮
draco（沿用 `gltf-pipeline`，同 `just compress-glb`）。新增 `just buildings` target。

### Nix 依賴
**已足夠**：`pyproj` + `numpy`（flake.nix 已有）。DAE/KML 用 stdlib，**無需** trimesh/lxml。
draco 用既有 `gltf-pipeline`。

---

## 建物 LOD 策略

source 本身已是低面擠出體（一棟幾十個三角形）→ **不做網格 decimation**。改為準備**兩種離散
表示**，與地形 20m/100m tile 同構：

| LOD | 內容 | 三角形/棟 | 用途 |
|---|---|---|---|
| **massing** | source 幾何（屋頂形狀、退縮） | ~數十 | 低空近距 |
| **box** | footprint AABB 擠出 × 屋頂高 | 12 | 高空 / 遠距 → 簡單方塊 |

box 是**重新生成**的極簡盒子（非簡化網格），剛好是 Mirror's Edge 的乾淨方塊感；全台北用 box
也僅數十萬面，可一次顯示。box 的高度 = 該棟最高頂點，基底 clamp 同 massing。

### 三段高度切換（沿用 `updateTiles` frustum streaming）
```
alt > BUILDING_FAR (整島尺度)   → 建物全卸（縮成 sub-pixel，無意義）
alt 中 (城市概覽)               → frustum 內全用 box → 看得到整片白色方塊群
alt 低 + 近距 (< BUILDING_DETAIL) → massing；該距離外仍 box
```

## 前端整合（src/main.js）

- 新增 `buildingTiles`（massing Map）、`buildingBoxes`（box Map）+ `buildingGroup`，
  複用 `updateTiles()` 的 frustum / cap / nearest-first / hysteresis；多一個 `BUILDING_FAR`
  高度上限（超過全卸）與 `BUILDING_DETAIL` 近距門檻（massing↔box）。
- 共用白色材質：`MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 })`，套用既有
  hillshade / 太陽 uniform（重用 `terrainMat` 的 onBeforeCompile，注意 r163 `clone()` 不複製
  hook，需手動 `mat.onBeforeCompile = terrainMat.onBeforeCompile` + 獨立 cacheKey）。
- 載入時 GLB mesh 直接 `add` 到 group（geometry 已在 pipeline 對齊世界座標，無需再轉）。

---

## 視覺風格（Mirror's Edge，分階段）

1. **v1**：純白量體 + 既有日照 hillshade（清楚的明暗面）。
2. **後續**：`EdgesGeometry` 描邊或 postprocessing outline（乾淨黑/灰邊）、
   SSAO（角落陰影增強體積感）、少量紅色點綴（地標）、天空盒提亮。

---

## 執行順序

1. ~~**PoC（單一區 3357）**：座標轉換 + 單 KMZ 解析 + 落地 clamp，產 1 個 merged GLB，目視驗證對齊~~
   ✅ 完成（`buildings_to_glb.py`，前端臨時 loader 載 `buildings_poc.glb`）。
2. **box LOD 生成**：`buildings_to_glb.py` 加 `--mode box`（footprint AABB × 屋頂高）。
3. **tile 切分**：加 `--tiled`，依 5km 網格切 massing + box 兩組 tile + index。
4. **批次 pipeline**：擴到全 9037 KMZ（24 區），輸出兩組 tile + draco，加 `just buildings`（含平行解 zip）。
5. **前端 streaming**：接 massing/box 兩組 Map + 三段高度切換，移除臨時 PoC loader。

---

## 待確認 / 風險

- **落地策略**：footprint 最低角 + 下沉 5m 是否足夠？山邊建物需 PoC 實測微調。
- **DAE 解析穩定度**：9037 檔中可能有畸形 / 空 mesh，pipeline 需容錯（跳過並記數）。
- **heading 方向定義**：KML heading 為 clockwise-from-true-north；投影到 TWD97 grid 需確認
  旋轉正負號（PoC 用幾棟有方向性的建物對照驗證）。
- **資料量**：輸出預估很小（純量體無貼圖），但 build 時要解 9037 個 zip，需平行化。
- **部署**：`building_tiles/` 體積小，可考慮直接 stage 進 `public/`（不像 20m tiles 那麼肥）。
