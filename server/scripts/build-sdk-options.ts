/**
 * SDK option codegen: reads ComponentDefSchema from protobuf-es bindings and emits:
 *   - `generated/options.ts` — one `*Options` interface per ComponentDef variant,
 *     keyed by snake_case field names.
 *   - `generated/factory.ts` — per-variant `build*` functions + a PascalCase
 *     dispatch table for `component(id, type, props)`.
 *
 * Derives interfaces from proto so any new proto field that is missing from the
 * SDK becomes a compile error in `apps:typecheck`.
 *
 * Run: `task protocol:gen`. Drift check: `task protocol:gen-check`.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DescField, DescMessage } from '@bufbuild/protobuf'
import { ComponentDefSchema } from '@moumantai/protocol/generated/moumantai/v1'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(__dirname, '..', 'src', 'server', 'protocol', 'components', 'generated')

// Per-(message, field) TS type overrides: proto wire type is `string`; these are
// authoring-time refinements via sdk-types that don't change the wire shape.

const FIELD_TYPE_OVERRIDES: Record<string, string> = {
  'ColumnComponent.vertical_arrangement': 'Arrangement',
  'ColumnComponent.horizontal_alignment': 'Alignment',
  'RowComponent.horizontal_arrangement': 'Arrangement',
  'RowComponent.vertical_alignment': 'Alignment',
  'BoxComponent.content_alignment': 'Alignment',
  'BoxComponent.child_alignment': 'Alignment[]',
  // Intent axes: authors emit semantic emphasis/tone; framework maps to visual treatment.
  'ButtonComponent.emphasis': 'ButtonEmphasis',
  'ButtonComponent.tone': 'ButtonTone',
  'CardComponent.emphasis': 'CardEmphasis',
  'CardComponent.tone': 'CardTone',
  'ChipComponent.tone': 'ChipTone',
  'FabComponent.size': 'FabSize',
  'ImageComponent.fit': 'ImageFit',
  'DateTimeInputComponent.mode': "'date' | 'time' | 'datetime'",
}

const SDK_TYPE_IMPORTS = new Set([
  'Arrangement',
  'Alignment',
  'ButtonEmphasis',
  'ButtonTone',
  'CardEmphasis',
  'CardTone',
  'ChipTone',
  'FabSize',
  'ImageFit',
])

/** PascalCase type label for `component(id, type, props)` — strip the `Component` suffix. */

function typeLabelFor(messageName: string): string {
  return messageName.replace(/Component$/, '')
}

// Per-field codegen: derives the Options interface TS type and builder expression.

interface FieldCodegen {
  /** Snake_case prop name in the Options interface. */
  snake: string
  /** CamelCase TS field name on the proto message setter. */
  camel: string
  /** TS type for the Options interface. */
  optionType: string
  /** Expression for the `create(<Schema>, { camelField: <here> })` slot. */
  builderExpr: (propAccess: string) => string
}

function mapField(messageName: string, f: DescField): FieldCodegen | null {
  if (f.name === 'modifier') return null // handled by ModifierProps base
  const snake = f.name
  const camel = f.localName
  const overrideKey = `${messageName}.${snake}`
  const override = FIELD_TYPE_OVERRIDES[overrideKey]

  // Repeated fields
  if (f.fieldKind === 'list') {
    if (f.listKind === 'scalar' && f.scalar === 9 /* STRING */) {
      const optionType = override ?? 'string[]'
      return {
        snake,
        camel,
        optionType,
        builderExpr: (a) => `${a} ?? []`,
      }
    }
    return null // no other repeated kinds in current proto
  }

  // Scalar fields
  if (f.fieldKind === 'scalar') {
    const scalarMap: Record<number, string> = {
      // protobuf-es ScalarType values
      1: 'number', // DOUBLE
      2: 'number', // FLOAT
      3: 'number', // INT64
      4: 'number', // UINT64
      5: 'number', // INT32
      6: 'number', // FIXED64
      7: 'number', // FIXED32
      8: 'boolean', // BOOL
      9: 'string', // STRING
      12: 'Uint8Array', // BYTES
      13: 'number', // UINT32
      15: 'number', // SFIXED32
      16: 'number', // SFIXED64
      17: 'number', // SINT32
      18: 'number', // SINT64
    }
    const tsType = override ?? scalarMap[f.scalar as number] ?? 'unknown'
    return {
      snake,
      camel,
      optionType: tsType,
      builderExpr: (a) => a,
    }
  }

  // Message fields
  if (f.fieldKind === 'message') {
    const msgName = f.message.typeName
    switch (msgName) {
      case 'moumantai.v1.DynamicString':
        return {
          snake,
          camel,
          optionType: 'DynamicValue<string>',
          builderExpr: (a) => `dynString(${a})`,
        }
      case 'moumantai.v1.DynamicBool':
        return {
          snake,
          camel,
          optionType: 'DynamicValue<boolean>',
          builderExpr: (a) => `dynBool(${a})`,
        }
      case 'moumantai.v1.DynamicInt32':
        return {
          snake,
          camel,
          optionType: 'DynamicValue<number>',
          builderExpr: (a) => `dynInt32(${a})`,
        }
      case 'moumantai.v1.DynamicDouble':
        return {
          snake,
          camel,
          optionType: 'DynamicValue<number>',
          builderExpr: (a) => `dynDouble(${a})`,
        }
      case 'moumantai.v1.Action':
        return {
          snake,
          camel,
          optionType: 'Action',
          builderExpr: (a) => `${a} as Action | undefined`,
        }
      case 'moumantai.v1.SelectOptions':
        return {
          snake,
          camel,
          optionType: 'SelectOptionsInput',
          builderExpr: (a) => `selectOptions(${a})`,
        }
      case 'moumantai.v1.ListChildren':
        return {
          snake,
          camel,
          optionType: 'ListChildrenInput',
          builderExpr: (a) => `listChildren(${a})`,
        }
      default:
        return null
    }
  }

  // Enum fields
  if (f.fieldKind === 'enum') {
    const enumName = f.enum.name
    return {
      snake,
      camel,
      optionType: enumName,
      builderExpr: (a) => a,
    }
  }

  return null
}

// Emit the generated files.

interface VariantCodegen {
  /** Proto message name (e.g. `TextComponent`). */
  messageName: string
  /** Oneof case name (e.g. `text`, `switchToggle`). */
  oneofCase: string
  /** PascalCase type label (e.g. `Text`, `Switch`). */
  typeLabel: string
  /** Options interface name (e.g. `TextOptions`). */
  optionsName: string
  /** Schema constant name (e.g. `TextComponentSchema`). */
  schemaName: string
  fields: FieldCodegen[]
  enumNames: Set<string>
}

const variants: VariantCodegen[] = []
const allEnumNames = new Set<string>()
const allSdkTypeImports = new Set<string>()

const componentOneof = ComponentDefSchema.oneofs.find((o) => o.name === 'component')!

for (const variantField of componentOneof.fields) {
  if (variantField.fieldKind !== 'message') continue
  const msg = variantField.message
  const messageName = msg.name
  const typeLabel = typeLabelFor(messageName)
  const optionsName = `${typeLabel}Options`
  const schemaName = `${messageName}Schema`
  const enumNames = new Set<string>()
  const fields: FieldCodegen[] = []

  for (const f of msg.fields) {
    const cg = mapField(messageName, f)
    if (!cg) continue
    fields.push(cg)
    if (f.fieldKind === 'enum') {
      enumNames.add(f.enum.name)
      allEnumNames.add(f.enum.name)
    }
    const override = FIELD_TYPE_OVERRIDES[`${messageName}.${f.name}`]
    if (override) {
      for (const t of SDK_TYPE_IMPORTS) {
        if (override.includes(t)) allSdkTypeImports.add(t)
      }
    }
  }

  variants.push({
    messageName,
    oneofCase: variantField.localName,
    typeLabel,
    optionsName,
    schemaName,
    fields,
    enumNames,
  })
}

// Emit options.ts

const optionsBanner = `/* eslint-disable */
// AUTO-GENERATED from shared/protocol/proto/moumantai/v1/components.proto.
// Run \`task protocol:gen\` to regenerate. Do not hand-edit.
//
// Per-variant Options interfaces for the SDK component builders. Keys are
// snake_case to match the wire field names (LLM-authored faces use the
// same names). Closed unions imported from sdk-types are authoring-time
// refinements over wire-honest \`string\` fields.
`

const sdkTypeList = [...allSdkTypeImports].sort()
const enumImports = [...allEnumNames].sort()

const optionsImports: string[] = [
  `import type { DynamicValue, Action, SelectOptionsInput, ListChildrenInput, ModifierProps } from '../common.js'`,
]
if (sdkTypeList.length > 0) {
  optionsImports.push(
    `import type { ${sdkTypeList.join(', ')} } from '@moumantai/protocol/design-system/sdk-types'`,
  )
}
if (enumImports.length > 0) {
  optionsImports.push(
    `import type { ${enumImports.join(', ')} } from '@moumantai/protocol/generated/moumantai/v1'`,
  )
}

const optionsBody: string[] = []
for (const v of variants) {
  optionsBody.push(
    `/** Options for the ${v.typeLabel} component (wire variant \`${v.oneofCase}\`). */`,
  )
  optionsBody.push(`export interface ${v.optionsName} extends ModifierProps {`)
  for (const f of v.fields) {
    optionsBody.push(`  ${f.snake}?: ${f.optionType}`)
  }
  optionsBody.push(`}`)
  optionsBody.push(``)
}

const optionsContent = [optionsBanner, ...optionsImports, ``, ...optionsBody].join('\n')

// Emit factory.ts

const factoryBanner = `/* eslint-disable */
// AUTO-GENERATED from shared/protocol/proto/moumantai/v1/components.proto.
// Run \`task protocol:gen\` to regenerate. Do not hand-edit.
//
// Per-variant builder functions + dispatch table. The factory in common.ts
// delegates to this table, so adding a proto field automatically threads
// through both the Options interface and the ComponentDef construction
// without any hand-written sync code.
`

const factoryImports: string[] = [`import { create } from '@bufbuild/protobuf'`]

const schemaImports: string[] = []
for (const v of variants) {
  schemaImports.push(v.schemaName)
}
factoryImports.push(
  `import { ComponentDefSchema, ${schemaImports.sort().join(', ')} } from '@moumantai/protocol/generated/moumantai/v1'`,
)
factoryImports.push(`import type { ComponentDef, Action } from '../common.js'`)
factoryImports.push(
  `import { dynString, dynBool, dynInt32, dynDouble, selectOptions, listChildren, buildModifier } from '../common.js'`,
)
const optionsImportList = variants.map((v) => `${v.optionsName}`).sort()
factoryImports.push(`import type { ${optionsImportList.join(', ')} } from './options.js'`)

const factoryBody: string[] = []
for (const v of variants) {
  const setters: string[] = []
  for (const f of v.fields) {
    setters.push(`    ${f.camel}: ${f.builderExpr(`props.${f.snake}`)},`)
  }
  setters.push(`    modifier: buildModifier(props),`)
  factoryBody.push(
    `function build${v.typeLabel}(id: string, props: ${v.optionsName}): ComponentDef {`,
  )
  factoryBody.push(`  const value = create(${v.schemaName}, {`)
  factoryBody.push(...setters)
  factoryBody.push(`  })`)
  factoryBody.push(
    `  return create(ComponentDefSchema, { id, component: { case: '${v.oneofCase}', value } })`,
  )
  factoryBody.push(`}`)
  factoryBody.push(``)
}

// Dispatch table
factoryBody.push(`/**`)
factoryBody.push(` * Dispatch table keyed by the PascalCase type label used in`)
factoryBody.push(` * \`component(id, type, props)\`. Switch is keyed as 'Switch' even though`)
factoryBody.push(` * the oneof case is 'switchToggle' (cf. SwitchComponent message name).`)
factoryBody.push(` */`)
factoryBody.push(`// eslint-disable-next-line @typescript-eslint/no-explicit-any`)
factoryBody.push(
  `export const factoryDispatch: Record<string, (id: string, props: any) => ComponentDef> = {`,
)
for (const v of variants) {
  factoryBody.push(`  ${v.typeLabel}: build${v.typeLabel},`)
}
factoryBody.push(`}`)
factoryBody.push(``)

const factoryContent = [factoryBanner, ...factoryImports, ``, ...factoryBody].join('\n')

// Write files (or check drift in --check mode).

fs.mkdirSync(OUT_DIR, { recursive: true })
const optionsPath = path.join(OUT_DIR, 'options.ts')
const factoryPath = path.join(OUT_DIR, 'factory.ts')

const checkMode = process.argv.includes('--check')

function compareOrWrite(p: string, content: string): boolean {
  if (checkMode) {
    if (!fs.existsSync(p)) {
      console.error(`[gen-check] missing: ${p}`)
      return false
    }
    const existing = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
    const expected = content.replace(/\r\n/g, '\n')
    if (existing !== expected) {
      console.error(`[gen-check] drift: ${p}`)
      return false
    }
    return true
  } else {
    fs.writeFileSync(p, content)
    console.log(`wrote ${p}`)
    return true
  }
}

const ok1 = compareOrWrite(optionsPath, optionsContent)
const ok2 = compareOrWrite(factoryPath, factoryContent)
if (checkMode && (!ok1 || !ok2)) {
  console.error(`\nRun \`task protocol:gen\` to regenerate SDK options.`)
  process.exit(1)
}
