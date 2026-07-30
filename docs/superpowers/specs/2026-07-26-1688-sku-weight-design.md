# 1688 SKU 重量采集设计

## 目标

当 1688 “商品件重尺”按 SKU 提供不同重量时，扩展必须保存每个实际 SKU 的准确重量，不能因为重量不一致而丢弃整张表，也不能猜测一个统一商品重量。

## 数据流

扩展继续优先读取 `context.result.data.productPackInfo.fields.pieceWeightScale.pieceWeightScaleInfo`。包装行通过 1688 `skuId` 与 `skuModel.skuInfoMap` 中的实际 SKU 精确关联，并把克转换为千克字符串写入 `skus[].weightKg`。

只有所有包装行重量一致时才继续填写商品级 `weightKg`。重量不同但每个实际 SKU 都成功匹配时，商品级 `weightKg` 保持 `null`，重量诊断为 `captured`；存在未匹配或无效重量时诊断为 `capture_failed`。

## 验收

- 商品 `1022498388851` 的 13 个实际 SKU 均保存重量。
- 12 个帽子 SKU 为 `0.08kg`，防风绳 SKU 为 `0.01kg`。
- 商品级重量不伪造统一值。
- 重量字段不再导致该商品成为部分采集。
- SKU 重量通过 V3 契约并原样保存到 `product_revisions.source_payload.skus`。
