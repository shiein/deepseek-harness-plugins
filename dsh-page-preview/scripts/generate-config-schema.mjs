/** 从运行时结构生成配置 JSON Schema（方案 §8）；仅更新本仓库协议文件。 */
import { writeFile } from 'node:fs/promises'
import { configJsonSchema } from '../src/shared/config/schema.ts'
await writeFile(new URL('../schema/page-preview.config.schema.json', import.meta.url), JSON.stringify(configJsonSchema(), null, 2) + '\n')
