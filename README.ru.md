# unity-yaml-lsp (русская версия)

Форк `yaml-language-server` с поддержкой текстовых ассетов Unity. Полное описание
upstream-возможностей — в [README.md](README.md), детали Unity — в [UNITY.md](UNITY.md).

## Что делает

- Разбирает Unity YAML так же, как Unity: `%YAML 1.1` с core-схемой (чтобы
  `m_Name: On` оставалось строкой), ключевое слово `stripped` принимается без сдвига
  смещений.
- Подбирает схему для каждого документа: встроенные компоненты по `!u!<classId>`,
  `MonoBehaviour` и `ScriptableObject` — по `m_Script.guid`.
- Проверяет поля и типы. Встроенные компоненты терпимы к неизвестным полям (Unity
  добавляет и убирает их между версиями), пользовательские скрипты строгие — опечатки
  в сериализованных полях видны.
- Сообщает о битых ссылках: дубли `fileID`, отсутствующие `fileID` в файле, `guid`,
  которых нет в проекте (`Assets`, `Packages`, `Library/PackageCache`).
- Навигация: переход по `{fileID: ...}` и по ассету за `guid` (включая конкретный
  объект в другом префабе/сцене). Hover показывает класс Unity, имя объекта, описание
  поля и цель ссылки.
- Символы документов, folding, автодополнение полей по схеме класса/скрипта.
- Форматирование для Unity-ассетов отключено: раскладкой владеет Unity.

## Установка

```sh
npm install -g unity-yaml-lsp
```

Появится глобальная команда `unity-yaml-lsp`; штатный `yaml-language-server` не
затрагивается.

Из исходников:

```sh
npm install
npm run compile
npm link
```

## OpenCode

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

## Схема проекта

Для проверки полей нужна схема, сгенерированная под версию Unity проекта.
Установи `editor/UnityYamlSchemaExporter.cs` в `Assets/Editor/` и запусти
**Tools → Unity YAML LSP → Export Schema** (или batch-команду ниже). Схема пишется в
`Library/UnityYaml/schema.json` и пересобирается после добавления компонентов или
сериализованных полей.

```sh
Unity -batchmode -quit -projectPath <project> \
  -executeMethod UnityYamlLsp.UnityYamlSchemaExporter.Export \
  -logFile <log>
```

`-nographics` на некоторых сборках Unity падает — запускай без него.

Экспортёр:

- создаёт временную сцену и читает `SerializedObject` встроенных компонентов;
- отражает поля пользовательских `MonoBehaviour`/`ScriptableObject`, включая
  `[SerializeField]`, `[FormerlySerializedAs]`, `[Tooltip]`, `[Range]`, enum,
  массивы/списки и вложенные `[Serializable]`-типы;
- экспортирует ассеты Material, AnimationClip, AnimatorController,
  AnimatorOverrideController, AvatarMask, Preset, LightingSettings;
- экспортирует классы `ProjectSettings/*.asset` (GraphicsSettings, QualitySettings,
  TagManager, InputManager, EditorBuildSettings, PhysicsManager и остальные);
- скрипты из `Packages/` и `Library/PackageCache/` помечает как permissive: пакетный
  код может хранить legacy-поля, пользовательский код остаётся строгим.

Проверить схему без Unity:

```sh
node scripts/schema-check.mjs <project>/Library/UnityYaml/schema.json
```

## Тесты

```sh
npm run compile
node --test out/test/unity.test.js          # Unity-специфичные тесты
node --test out/test/unity-legacy-fields.test.js
npm test                                    # полный upstream + Unity
```

## Ограничения

- Схема генерируется под одну версию Unity; после обновления её нужно пересобрать.
- Встроенные компоненты намеренно допускают неизвестные поля; строгие только скрипты.
- Legacy-поля `m_TypeName` и `m_HashCode` фильтруются из диагностик.
- Пути prefab override (`m_Modifications.propertyPath`) не проверяются.
- `TerrainData` не экспортируется: Unity пишет его без YAML-заголовка документа.
- Очень большие сцены (десятки MB) валидируются секундами; изменённый объект отдельно
  не проверяется.
- Rename и поиск ссылок по `fileID`/`guid` не реализованы.
