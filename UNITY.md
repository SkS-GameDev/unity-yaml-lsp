# Unity YAML support

This fork of `yaml-language-server` adds first-class support for Unity text assets
(`.unity`, `.prefab`, `.asset`, `.mat`, `.anim`, `.controller`, `.meta`, and friends)
for LSP clients such as OpenCode.

## What it does

- Parses Unity YAML the way Unity does: `%YAML 1.1` scalar rules are overridden with
  the core schema (so `m_Name: On` stays a string), and the non-YAML `stripped`
  keyword is accepted without moving any offsets.
- Resolves a schema per Unity document: built-in components by `!u!<classId>`,
  `MonoBehaviour` and `ScriptableObject` documents by `m_Script.guid`.
- Validates fields and types. Built-in components are permissive about unknown
  fields (Unity adds/removes serialized fields between versions); user scripts are
  strict, so typos in serialized fields are reported.
- Reports broken references: duplicate `fileID`s, missing in-file `fileID`s, and
  `guid`s that do not exist in the project (`Assets`, `Packages`, and
  `Library/PackageCache` are indexed).
- Navigation: go to a `{fileID: ...}` target, or to the asset behind a `guid`
  (including the exact object in another prefab/scene). Hover shows the Unity class,
  object name, schema field descriptions, and reference targets.
- Document symbols for each Unity object, folding ranges, and field completion from
  the active class/script schema.
- Formatting is deliberately disabled for Unity assets: Unity owns their layout and
  a generic YAML formatter would rewrite tags, anchors, and scalar styles.

Diagnostics use errors for YAML syntax and duplicate fileIDs, and warnings for
schema findings, missing references, and missing assets.

## Build and install

```sh
npm install
npm run compile
npm link            # creates the global `unity-yaml-lsp` command
```

`npm link` (or `npm install -g .`) installs the server as a global binary, so the
OpenCode configuration contains no filesystem paths. The package and binary are
named `unity-yaml-lsp`; the stock `yaml-language-server` stays untouched.

On another machine, clone the fork and repeat those three commands, or publish the
package and run `npm install -g unity-yaml-lsp`.

## OpenCode configuration

```jsonc
"lsp": {
  "unity-yaml": {
    "command": ["unity-yaml-lsp", "--stdio"],
    "extensions": [
      ".unity", ".prefab", ".asset", ".mat", ".anim", ".controller",
      ".overrideController", ".physicMaterial", ".physicsMaterial2D",
      ".preset", ".mask", ".lighting", ".meta"
    ]
  }
}
```

The stock `yaml-language-server` cannot be configured this way in OpenCode: it pulls
settings through `workspace/configuration`, which OpenCode does not implement, and it
reports every Unity tag as an unresolved-tag error.

## Project schema

Field validation needs a schema generated from the project's Unity version. Install
`editor/UnityYamlSchemaExporter.cs` into `Assets/Editor/`, then run
**Tools → Unity YAML LSP → Export Schema**. It writes
`Library/UnityYaml/schema.json` and can be re-run after adding components or
serialized fields.

The exporter:

- instantiates built-in components in a temporary scene and reads their
  `SerializedObject` properties (class IDs come from the temporary scene YAML);
- reflects user `MonoBehaviour`/`ScriptableObject` fields, including
  `[SerializeField]`, `[FormerlySerializedAs]`, `[Tooltip]`, `[Range]`, enums,
  arrays/lists, and `[Serializable]` nested types;
- maps each script to its `MonoScript` GUID;
- exports asset classes (Material, AnimationClip, AnimatorController,
  AnimatorOverrideController, AvatarMask, Preset, TerrainData, LightingSettings) by
  creating temporary assets and reading their serialized fields;
- exports `ProjectSettings/*.asset` classes (GraphicsSettings, QualitySettings,
  TagManager, InputManager, EditorBuildSettings, PhysicsManager, TimeManager,
  AudioManager, and the rest) by loading the project settings objects;
- runs in batch mode: `Unity -batchmode -quit -projectPath <project> -executeMethod
  UnityYamlLsp.UnityYamlSchemaExporter.Export -logFile <log>`.

Without the schema the server still checks syntax and references, and skips field
validation.

## Tests

```sh
npm run compile
node --test out/test/unity.test.js   # Unity-specific tests
npm test                             # full upstream + Unity suite
node scripts/schema-check.mjs <project>/Library/UnityYaml/schema.json
```

## Known limits

- The schema is generated for one Unity version; regenerate it after upgrading Unity.
- Built-in components intentionally allow unknown fields; only user scripts are
  strict.
- Unity's YAML is ambiguous for unquoted strings and packed primitive arrays, so
  string fields accept numbers/booleans and array fields accept Unity's hex string
  form.
- Prefab override paths (`m_Modifications.propertyPath`) are not validated.
- Legacy serialized fields that reflection cannot see (`m_TypeName`, `m_HashCode`) are
  filtered out of strict script-schema diagnostics.
- `TerrainData` is not exported: Unity writes it without a YAML document header.
- Asset/project settings schemas are permissive about unknown fields (Unity adds and
  removes serialized fields between versions).
- Very large scenes (tens of MB) take seconds to validate on open; the server does
  not yet validate only the changed object.
- Rename and workspace-wide reference search for `fileID`/`guid` are not implemented.
