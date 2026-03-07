# F-01: Adapters — Implementation Plan

## Overview
Pure logic converters between apcore and A2A types. No I/O, no side effects.

## Files

### `src/adapters/skill-mapper.ts`
Port of `apcore_a2a/adapters/skill_mapper.py`

**Class: `SkillMapper`**
- `toSkill(descriptor: ModuleDescriptor): AgentSkill | null` — convert ModuleDescriptor to AgentSkill
  - Return null if no description
  - Build AgentSkill with: id, name (humanized), description, tags, inputModes, outputModes, examples
- `humanizeModuleId(moduleId: string): string` — `"image.resize"` → `"Image Resize"`
- `computeInputModes(descriptor): string[]` — schema.type === "string" → ["application/json", "text/plain"], else ["application/json"]
- `computeOutputModes(descriptor): string[]` — no schema → ["text/plain"], else ["application/json"]
- `buildExamples(descriptor): string[]` — up to 10 example titles

**Key difference from Python:**
- Use `@a2a-js/sdk` `AgentSkill` type instead of Pydantic model
- Use optional chaining `descriptor?.description` instead of `getattr()`

### `src/adapters/agent-card.ts`
Port of `apcore_a2a/adapters/agent_card.py`

**Class: `AgentCardBuilder`**
- Constructor takes `SkillMapper`
- `build(registry, opts): AgentCard` — build and cache card
- `getCachedOrBuild(registry, opts): AgentCard` — return cached if available
- `buildExtended(baseCard): AgentCard` — deep copy for authenticated users
- `invalidateCache(): void` — clear cached cards

**Key difference:**
- Use `structuredClone()` instead of Pydantic `.model_copy(deep=True)`

### `src/adapters/schema.ts`
Port of `apcore_a2a/adapters/schema.py`

**Class: `SchemaConverter`**
- `convertInputSchema(descriptor): JsonSchema` — convert with $ref inlining
- `convertOutputSchema(descriptor): JsonSchema` — same
- `detectRootType(schema): "string" | "object" | "unknown"`
- `inlineRefs(schema, defs, seen?, depth?)` — recursive $ref resolution
- `resolveRef(refPath, defs): JsonSchema` — resolve `#/$defs/Name`
- `ensureObjectType(schema): JsonSchema` — guarantee `type: "object"` at root

**Constants:** `MAX_REF_DEPTH = 32`

### `src/adapters/parts.ts`
Port of `apcore_a2a/adapters/parts.py`

**Class: `PartConverter`**
- Constructor takes optional `SchemaConverter`
- `partsToInput(parts: Part[], descriptor): Record<string, unknown> | string`
  - Validate single part (throw on empty or multiple)
  - TextPart + object schema → JSON.parse; TextPart + string schema → raw text
  - DataPart → return .data
  - FilePart → throw unsupported
- `outputToParts(output: unknown, taskId?: string): Artifact`
  - null → empty parts
  - string → TextPart
  - object → DataPart
  - array → TextPart(JSON.stringify)
  - other → TextPart(String(output))

**Key difference:**
- Use `@a2a-js/sdk` Part/TextPart/DataPart/FilePart/Artifact types
- Use `crypto.randomUUID()` instead of Python uuid4

### `src/adapters/errors.ts`
Port of `apcore_a2a/adapters/errors.py`

**Class: `ErrorMapper`**
- `toJsonRpcError(error: unknown): { code: number; message: string }`
  - Check for `.code` property (apcore error codes)
  - MODULE_NOT_FOUND → -32601
  - SCHEMA_VALIDATION_ERROR → -32602
  - ACL_DENIED → -32001 (masked as "Task not found")
  - MODULE_TIMEOUT → -32603
  - Safety limits → -32603
  - INVALID_INPUT → -32602
  - TimeoutError → -32603
  - Default → -32603 "Internal server error"
- `sanitizeMessage(message: string): string` — strip file paths, truncate to 500 chars

**Constants:**
```typescript
const CODE_METHOD_NOT_FOUND = -32601;
const CODE_INVALID_PARAMS = -32602;
const CODE_INTERNAL_ERROR = -32603;
const CODE_TASK_NOT_FOUND = -32001;
```

## TDD Tasks

### T-01.1: SkillMapper
1. RED: test humanizeModuleId converts dots and underscores
2. GREEN: implement humanizeModuleId
3. RED: test toSkill returns null for missing description
4. GREEN: implement toSkill
5. RED: test computeInputModes for string/object/empty schemas
6. GREEN: implement computeInputModes/computeOutputModes
7. RED: test buildExamples truncates at 10
8. GREEN: implement buildExamples

### T-01.2: AgentCardBuilder
1. RED: test build creates card with skills from registry
2. GREEN: implement build
3. RED: test caching (getCachedOrBuild returns same card)
4. GREEN: implement caching
5. RED: test invalidateCache clears cache
6. GREEN: implement invalidateCache
7. RED: test buildExtended returns deep copy
8. GREEN: implement buildExtended

### T-01.3: SchemaConverter
1. RED: test empty schema → {type: "object", properties: {}}
2. GREEN: implement convertSchema
3. RED: test $ref inlining removes $defs
4. GREEN: implement inlineRefs + resolveRef
5. RED: test circular $ref throws ValueError
6. GREEN: add circular detection
7. RED: test depth limit (MAX_REF_DEPTH)
8. GREEN: add depth check
9. RED: test detectRootType
10. GREEN: implement detectRootType

### T-01.4: PartConverter
1. RED: test TextPart with object schema → JSON.parse
2. GREEN: implement partsToInput
3. RED: test empty parts throws
4. GREEN: add validation
5. RED: test outputToParts for string/dict/null/list
6. GREEN: implement outputToParts

### T-01.5: ErrorMapper
1. RED: test MODULE_NOT_FOUND → -32601
2. GREEN: implement toJsonRpcError
3. RED: test ACL_DENIED → masked -32001
4. GREEN: add ACL masking
5. RED: test sanitizeMessage strips paths
6. GREEN: implement sanitizeMessage
