#if UNITY_EDITOR
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.Serialization;

namespace UnityYamlLsp
{
    public static class UnityYamlSchemaExporter
    {
        private const string TempScenePath = "Assets/__UnityYamlSchemaTemp.unity";
        private const string OutputRelativePath = "Library/UnityYaml/schema.json";

        private static readonly HashSet<string> PermissiveFields = new HashSet<string>(StringComparer.Ordinal)
        {
            "m_EnabledAudioTracks",
            "m_DirectAudioMutes",
        };

        [MenuItem("Tools/Unity YAML LSP/Export Schema")]
        public static void ExportMenu()
        {
            Debug.Log(Export());
        }

        public static string Export()
        {
            var projectRoot = Path.GetDirectoryName(Application.dataPath);
            var classes = new Dictionary<string, object>();
            var scripts = new Dictionary<string, object>();
            var notes = new List<string>();
            var scene = default(Scene);
            var previousActive = SceneManager.GetActiveScene();
            try
            {
                if (File.Exists(Path.Combine(projectRoot, TempScenePath)))
                {
                    AssetDatabase.DeleteAsset(TempScenePath);
                }
                scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Additive);

                var instances = new List<Component>();
                var root = new GameObject("__UnityYamlSchemaRoot");
                SceneManager.MoveGameObjectToScene(root, scene);
                instances.Add(root.transform);

                var componentTypes = TypeCache.GetTypesDerivedFrom<Component>()
                    .Where(t => t != null && !t.IsAbstract && !t.IsGenericTypeDefinition)
                    .Where(t => t.Namespace == null || !t.Namespace.StartsWith("UnityEditor"))
                    .Where(t => !typeof(Editor).IsAssignableFrom(t))
                    .OrderBy(t => t.FullName, StringComparer.Ordinal)
                    .ToList();

                foreach (var type in componentTypes)
                {
                    if (type == typeof(Transform)) continue;
                    try
                    {
                        GameObject go;
                        if (typeof(RectTransform).IsAssignableFrom(type))
                        {
                            go = new GameObject(type.Name, typeof(RectTransform));
                            SceneManager.MoveGameObjectToScene(go, scene);
                            if (type == typeof(RectTransform))
                            {
                                instances.Add(go.GetComponent<RectTransform>());
                                continue;
                            }
                        }
                        else
                        {
                            go = new GameObject(type.Name);
                            SceneManager.MoveGameObjectToScene(go, scene);
                        }

                        var component = go.AddComponent(type);
                        if (component == null) continue;
                        instances.Add(component);
                        foreach (var dependency in go.GetComponents<Component>())
                        {
                            instances.Add(dependency);
                        }
                    }
                    catch (Exception e)
                    {
                        notes.Add(type.Name + ": " + e.GetType().Name);
                    }
                }

                instances = instances.Where(c => c != null).Distinct().ToList();
                EditorSceneManager.SaveScene(scene, TempScenePath);
                var yaml = File.ReadAllText(Path.Combine(projectRoot, TempScenePath));
                var classIds = ReadClassIds(yaml);

                foreach (var component in instances)
                {
                    var type = component.GetType();
                    string classId;
                    if (!classIds.TryGetValue(type.Name, out classId)) continue;
                    try
                    {
                        classes[classId] = new Dictionary<string, object>
                        {
                            { "name", type.Name },
                            { "schema", BuildComponentSchema(component) },
                        };
                    }
                    catch (Exception e)
                    {
                        notes.Add(type.Name + " schema: " + e.Message);
                    }
                }

                string gameObjectClassId;
                if (classIds.TryGetValue("GameObject", out gameObjectClassId))
                {
                    classes[gameObjectClassId] = new Dictionary<string, object>
                    {
                        { "name", "GameObject" },
                        { "schema", BuildGameObjectSchema(root) },
                    };
                }

                var scriptMap = BuildScriptGuidMap();
                var scriptTypes = TypeCache.GetTypesDerivedFrom<MonoBehaviour>()
                    .Concat(TypeCache.GetTypesDerivedFrom<ScriptableObject>())
                    .Where(t => t != null && !t.IsAbstract && !t.IsGenericTypeDefinition)
                    .Where(t => t.Namespace == null || !t.Namespace.StartsWith("UnityEditor"))
                    .Distinct()
                    .OrderBy(t => t.FullName, StringComparer.Ordinal)
                    .ToList();

                foreach (var type in scriptTypes)
                {
                    string guid;
                    if (!scriptMap.TryGetValue(type, out guid)) continue;
                    try
                    {
                        var properties = MonoBehaviourBaseProperties();
                        CollectScriptFields(type, properties, new HashSet<string>(properties.Keys), new HashSet<Type>());
                        var inner = ObjectSchema(properties, true);
                        var wrapper = ObjectSchema(
                            new Dictionary<string, object> { { "MonoBehaviour", inner } },
                            true,
                            new List<object> { "MonoBehaviour" });
                        scripts[guid] = new Dictionary<string, object>
                        {
                            { "name", type.FullName },
                            { "schema", wrapper },
                        };
                    }
                    catch (Exception e)
                    {
                        notes.Add(type.FullName + " script: " + e.Message);
                    }
                }

                var output = new Dictionary<string, object>
                {
                    { "version", 1 },
                    { "unityVersion", Application.unityVersion },
                    { "generatedAt", DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) },
                    { "classes", classes },
                    { "scripts", scripts },
                };
                var json = Json.Write(output);
                var outputPath = Path.Combine(projectRoot, OutputRelativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(outputPath));
                File.WriteAllText(outputPath, json);
                return "Exported " + classes.Count + " classes, " + scripts.Count + " scripts to " + outputPath +
                       " (" + json.Length + " bytes). Notes: " + string.Join("; ", notes.Take(20));
            }
            finally
            {
                if (scene.IsValid()) EditorSceneManager.CloseScene(scene, true);
                if (File.Exists(Path.Combine(projectRoot, TempScenePath))) AssetDatabase.DeleteAsset(TempScenePath);
                if (previousActive.IsValid()) SceneManager.SetActiveScene(previousActive);
                AssetDatabase.Refresh();
            }
        }

        private static Dictionary<string, string> ReadClassIds(string yaml)
        {
            var result = new Dictionary<string, string>();
            var regex = new Regex(@"(?m)^--- !u!(\d+) &-?\d+\r?\n(\w+):");
            foreach (Match match in regex.Matches(yaml))
            {
                var name = match.Groups[2].Value;
                if (!result.ContainsKey(name)) result[name] = match.Groups[1].Value;
            }
            return result;
        }

        private static Dictionary<string, object> BuildComponentSchema(Component component)
        {
            var properties = ReadSerializedProperties(component);
            var inner = ObjectSchema(properties, true);
            MakePermissive(inner);
            var wrapper = new Dictionary<string, object> { { component.GetType().Name, inner } };
            return ObjectSchema(wrapper, true, new List<object> { component.GetType().Name });
        }

        private static Dictionary<string, object> BuildGameObjectSchema(GameObject gameObject)
        {
            var properties = ReadSerializedProperties(gameObject);
            var inner = ObjectSchema(properties, true);
            MakePermissive(inner);
            return ObjectSchema(new Dictionary<string, object> { { "GameObject", inner } }, true, new List<object> { "GameObject" });
        }

        private static void MakePermissive(object schema)
        {
            var dictionary = schema as Dictionary<string, object>;
            if (dictionary == null) return;
            object additional;
            if (dictionary.TryGetValue("additionalProperties", out additional) && additional is bool && !(bool)additional)
            {
                dictionary.Remove("additionalProperties");
            }
            object properties;
            if (dictionary.TryGetValue("properties", out properties))
            {
                var map = properties as Dictionary<string, object>;
                if (map != null)
                {
                    foreach (var value in map.Values) MakePermissive(value);
                }
            }
            object items;
            if (dictionary.TryGetValue("items", out items)) MakePermissive(items);
        }

        private static Dictionary<string, object> ReadSerializedProperties(UnityEngine.Object target)
        {
            var root = new SchemaNode();
            var serialized = new SerializedObject(target);
            var iterator = serialized.GetIterator();
            while (iterator.Next(true))
            {
                if (iterator.propertyPath.EndsWith(".Array.size", StringComparison.Ordinal)) continue;
                AddProperty(root, iterator);
            }
            var properties = NodeToProperties(root);
            if (!properties.ContainsKey("serializedVersion")) properties["serializedVersion"] = NumberSchema();
            return properties;
        }

        private static void AddProperty(SchemaNode root, SerializedProperty property)
        {
            var segments = property.propertyPath.Split('.');
            var node = root;
            for (var i = 0; i < segments.Length; i++)
            {
                if (node.ForceLeaf) return;
                var segment = segments[i];
                if (segment == "Array")
                {
                    node.IsArray = true;
                    if (node.Element == null) node.Element = new SchemaNode();
                    node = node.Element;
                    continue;
                }
                if (segment.StartsWith("data[", StringComparison.Ordinal))
                {
                    if (i == segments.Length - 1) ApplyLeaf(node, property);
                    continue;
                }
                SchemaNode child;
                if (!node.Children.TryGetValue(segment, out child))
                {
                    child = new SchemaNode();
                    node.Children[segment] = child;
                }
                node = child;
            }
            var last = segments[segments.Length - 1];
            if (last != "Array" && !last.StartsWith("data[", StringComparison.Ordinal)) ApplyLeaf(node, property);
        }

        private static void ApplyLeaf(SchemaNode node, SerializedProperty property)
        {
            switch (property.propertyType)
            {
                case SerializedPropertyType.ObjectReference:
                case SerializedPropertyType.ExposedReference:
                    node.IsReference = true;
                    return;
                case SerializedPropertyType.ManagedReference:
                    node.LeafKind = "any";
                    return;
                case SerializedPropertyType.Integer:
                case SerializedPropertyType.LayerMask:
                case SerializedPropertyType.Boolean:
                case SerializedPropertyType.Float:
                case SerializedPropertyType.FixedBufferSize:
                    node.LeafKind = "number";
                    return;
                case SerializedPropertyType.String:
                case SerializedPropertyType.Character:
                case SerializedPropertyType.Hash128:
                    node.LeafKind = "string";
                    node.ForceLeaf = true;
                    return;
                case SerializedPropertyType.Enum:
                    node.LeafKind = "number";
                    if (property.enumDisplayNames != null && property.enumDisplayNames.Length > 0)
                    {
                        node.Description = string.Join(" | ", property.enumDisplayNames);
                    }
                    return;
                default:
                    node.LeafKind = "any";
                    return;
            }
        }

        private static Dictionary<string, object> NodeToProperties(SchemaNode node)
        {
            var properties = new Dictionary<string, object>();
            foreach (var child in node.Children)
            {
                properties[child.Key] = PermissiveFields.Contains(child.Key) ? AnySchema() : NodeToSchema(child.Value);
            }
            return properties;
        }

        private static Dictionary<string, object> NodeToSchema(SchemaNode node)
        {
            if (node.ForceLeaf)
            {
                return StringSchema();
            }
            if (node.IsArray)
            {
                var items = node.Element != null ? NodeToSchema(node.Element) : AnySchema();
                return ArraySchema(items);
            }
            if (node.Children.Count > 0)
            {
                if (node.Children.ContainsKey("m_FileID") && node.Children.ContainsKey("m_PathID")) return ReferenceSchema();
                var properties = NodeToProperties(node);
                if (!properties.ContainsKey("serializedVersion")) properties["serializedVersion"] = NumberSchema();
                return ObjectSchema(properties, true);
            }
            if (node.IsReference) return ReferenceSchema();

            Dictionary<string, object> schema;
            if (node.LeafKind == "number") schema = NumberSchema();
            else if (node.LeafKind == "string") schema = StringSchema();
            else schema = AnySchema();
            if (node.Description != null) schema["description"] = node.Description;
            return schema;
        }

        private static Dictionary<Type, string> BuildScriptGuidMap()
        {
            var result = new Dictionary<Type, string>();
            foreach (var guid in AssetDatabase.FindAssets("t:MonoScript"))
            {
                var assetPath = AssetDatabase.GUIDToAssetPath(guid);
                var script = AssetDatabase.LoadAssetAtPath<MonoScript>(assetPath);
                if (script == null) continue;
                var type = script.GetClass();
                if (type != null && !result.ContainsKey(type)) result[type] = guid;
            }
            return result;
        }

        private static void CollectScriptFields(Type type, Dictionary<string, object> properties, HashSet<string> names, HashSet<Type> seen)
        {
            var current = type;
            while (current != null &&
                   current != typeof(MonoBehaviour) &&
                   current != typeof(ScriptableObject) &&
                   current != typeof(Behaviour) &&
                   current != typeof(Component) &&
                   current != typeof(UnityEngine.Object) &&
                   current != typeof(object))
            {
                foreach (var field in current.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
                {
                    if (names.Contains(field.Name)) continue;
                    if (!IsSerializedField(field)) continue;
                    names.Add(field.Name);
                    properties[field.Name] = FieldSchema(field, seen);
                    foreach (FormerlySerializedAsAttribute attribute in field.GetCustomAttributes(typeof(FormerlySerializedAsAttribute), true))
                    {
                        if (attribute.oldName != null && !names.Contains(attribute.oldName))
                        {
                            names.Add(attribute.oldName);
                            properties[attribute.oldName] = FieldSchema(field, seen);
                        }
                    }
                }
                current = current.BaseType;
            }
        }

        private static bool IsSerializedField(FieldInfo field)
        {
            if (field.IsStatic || field.IsLiteral || field.IsInitOnly) return false;
            if (field.GetCustomAttributes(typeof(NonSerializedAttribute), true).Length > 0) return false;
            if (field.IsPublic) return true;
            return field.GetCustomAttributes(typeof(SerializeField), true).Length > 0;
        }

        private static Dictionary<string, object> FieldSchema(FieldInfo field, HashSet<Type> seen)
        {
            if (field.GetCustomAttributes(typeof(SerializeReference), true).Length > 0) return AnySchema();
            var schema = TypeSchema(field.FieldType, seen);

            var tooltip = field.GetCustomAttributes(typeof(TooltipAttribute), true).OfType<TooltipAttribute>().FirstOrDefault();
            if (tooltip != null && !string.IsNullOrEmpty(tooltip.tooltip)) schema["description"] = tooltip.tooltip;

            var range = field.GetCustomAttributes(typeof(RangeAttribute), true).OfType<RangeAttribute>().FirstOrDefault();
            if (range != null && schema.ContainsKey("type") && Equals(schema["type"], "number"))
            {
                schema["minimum"] = range.min;
                schema["maximum"] = range.max;
            }
            return schema;
        }

        private static Dictionary<string, object> TypeSchema(Type type, HashSet<Type> seen)
        {
            var nullable = Nullable.GetUnderlyingType(type);
            if (nullable != null) type = nullable;

            if (type == typeof(bool)) return NumberSchema();
            if (type.IsEnum) return EnumSchema(type);
            if (type == typeof(string) || type == typeof(char)) return StringSchema();
            if (type == typeof(byte) || type == typeof(sbyte) ||
                type == typeof(short) || type == typeof(ushort) ||
                type == typeof(int) || type == typeof(uint) ||
                type == typeof(long) || type == typeof(ulong) ||
                type == typeof(float) || type == typeof(double) ||
                type == typeof(decimal))
            {
                return NumberSchema();
            }
            if (typeof(UnityEngine.Object).IsAssignableFrom(type)) return ReferenceSchema();

            if (type == typeof(Vector2)) return VectorSchema("x", "y");
            if (type == typeof(Vector3)) return VectorSchema("x", "y", "z");
            if (type == typeof(Vector4)) return VectorSchema("x", "y", "z", "w");
            if (type == typeof(Vector2Int)) return VectorSchema("x", "y");
            if (type == typeof(Vector3Int)) return VectorSchema("x", "y", "z");
            if (type == typeof(Quaternion)) return VectorSchema("x", "y", "z", "w");
            if (type == typeof(Color)) return VectorSchema("r", "g", "b", "a");
            if (type == typeof(Color32))
            {
                return ObjectSchema(new Dictionary<string, object>
                {
                    { "serializedVersion", NumberSchema() },
                    { "rgba", NumberSchema() },
                }, true);
            }
            if (type == typeof(Rect) || type == typeof(RectInt))
            {
                return ObjectSchema(new Dictionary<string, object>
                {
                    { "serializedVersion", NumberSchema() },
                    { "x", NumberSchema() },
                    { "y", NumberSchema() },
                    { "width", NumberSchema() },
                    { "height", NumberSchema() },
                }, true);
            }
            if (type == typeof(Bounds))
            {
                return ObjectSchema(new Dictionary<string, object>
                {
                    { "m_Center", VectorSchema("x", "y", "z") },
                    { "m_Extent", VectorSchema("x", "y", "z") },
                }, true);
            }
            if (type == typeof(BoundsInt))
            {
                return ObjectSchema(new Dictionary<string, object>
                {
                    { "m_Position", VectorSchema("x", "y", "z") },
                    { "m_Size", VectorSchema("x", "y", "z") },
                }, true);
            }
            if (type == typeof(LayerMask))
            {
                return new Dictionary<string, object>
                {
                    { "type", new List<object> { "object", "number", "null" } },
                    {
                        "properties", new Dictionary<string, object>
                        {
                            { "serializedVersion", NumberSchema() },
                            { "m_Bits", NumberSchema() },
                        }
                    },
                    { "additionalProperties", false },
                };
            }
            if (type == typeof(AnimationCurve) || type == typeof(Gradient)) return AnySchema();

            if (type.IsArray)
            {
                return ArraySchema(TypeSchema(type.GetElementType(), seen));
            }
            if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(List<>))
            {
                return ArraySchema(TypeSchema(type.GetGenericArguments()[0], seen));
            }
            if (type.GetCustomAttributes(typeof(SerializableAttribute), false).Length > 0)
            {
                if (seen.Contains(type)) return AnySchema();
                seen.Add(type);
                var properties = new Dictionary<string, object>();
                CollectSerializableFields(type, properties, new HashSet<string>(), seen);
                if (!properties.ContainsKey("serializedVersion")) properties["serializedVersion"] = NumberSchema();
                return ObjectSchema(properties, true);
            }
            return AnySchema();
        }

        private static void CollectSerializableFields(Type type, Dictionary<string, object> properties, HashSet<string> names, HashSet<Type> seen)
        {
            var current = type;
            while (current != null && current != typeof(object))
            {
                foreach (var field in current.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
                {
                    if (names.Contains(field.Name)) continue;
                    if (!IsSerializedField(field)) continue;
                    names.Add(field.Name);
                    properties[field.Name] = FieldSchema(field, seen);
                }
                current = current.BaseType;
            }
        }

        private static Dictionary<string, object> EnumSchema(Type type)
        {
            var schema = NumberSchema();
            var flags = type.GetCustomAttributes(typeof(FlagsAttribute), false).Length > 0;
            var names = Enum.GetNames(type);
            var values = Enum.GetValues(type);
            var descriptions = new List<string>();
            var enumValues = new List<object>();
            try
            {
                for (var i = 0; i < values.Length; i++)
                {
                    enumValues.Add(Convert.ToInt64(values.GetValue(i), CultureInfo.InvariantCulture));
                    descriptions.Add(names[i]);
                }
                if (!flags) schema["enum"] = enumValues;
                schema["description"] = string.Join(" | ", descriptions);
            }
            catch
            {
                // Wide enums are left unconstrained.
            }
            return schema;
        }

        private static Dictionary<string, object> MonoBehaviourBaseProperties()
        {
            return new Dictionary<string, object>
            {
                { "m_ObjectHideFlags", NumberSchema() },
                { "m_CorrespondingSourceObject", ReferenceSchema() },
                { "m_PrefabInstance", ReferenceSchema() },
                { "m_PrefabAsset", ReferenceSchema() },
                { "m_GameObject", ReferenceSchema() },
                { "m_Enabled", NumberSchema() },
                { "m_EditorHideFlags", NumberSchema() },
                { "m_Script", ReferenceSchema() },
                { "m_Name", StringSchema() },
                { "m_EditorClassIdentifier", StringSchema() },
                {
                    "references", ObjectSchema(new Dictionary<string, object>
                    {
                        { "version", NumberSchema() },
                        { "RefIds", ArraySchema(AnySchema()) },
                    }, true)
                },
                { "serializedVersion", NumberSchema() },
            };
        }

        private static Dictionary<string, object> VectorSchema(params string[] names)
        {
            var properties = new Dictionary<string, object>();
            foreach (var name in names) properties[name] = NumberSchema();
            return ObjectSchema(properties, true);
        }

        private static Dictionary<string, object> ObjectSchema(Dictionary<string, object> properties, bool additionalProperties, List<object> required = null)
        {
            var schema = new Dictionary<string, object>
            {
                { "type", new List<object> { "object", "null" } },
                { "properties", properties },
            };
            if (additionalProperties) schema["additionalProperties"] = false;
            if (required != null) schema["required"] = required;
            return schema;
        }

        private static Dictionary<string, object> ArraySchema(Dictionary<string, object> items)
        {
            return new Dictionary<string, object>
            {
                { "type", new List<object> { "array", "null", "string" } },
                { "items", items },
            };
        }

        private static Dictionary<string, object> ReferenceSchema()
        {
            return new Dictionary<string, object>
            {
                { "type", new List<object> { "object", "null" } },
                {
                    "properties", new Dictionary<string, object>
                    {
                        { "fileID", NumberSchema() },
                        { "guid", StringSchema() },
                        { "type", NumberSchema() },
                    }
                },
                { "additionalProperties", false },
            };
        }

        private static Dictionary<string, object> NumberSchema()
        {
            return new Dictionary<string, object> { { "type", "number" } };
        }

        private static Dictionary<string, object> StringSchema()
        {
            return new Dictionary<string, object> { { "type", new List<object> { "string", "number", "boolean", "null" } } };
        }

        private static Dictionary<string, object> AnySchema()
        {
            return new Dictionary<string, object>();
        }

        private sealed class SchemaNode
        {
            public readonly Dictionary<string, SchemaNode> Children = new Dictionary<string, SchemaNode>();
            public bool IsArray;
            public bool ForceLeaf;
            public SchemaNode Element;
            public string LeafKind;
            public string Description;
            public bool IsReference;
        }

        private static class Json
        {
            public static string Write(object value)
            {
                var builder = new StringBuilder();
                WriteValue(builder, value);
                return builder.ToString();
            }

            private static void WriteValue(StringBuilder builder, object value)
            {
                if (value == null)
                {
                    builder.Append("null");
                    return;
                }
                if (value is string)
                {
                    WriteString(builder, (string)value);
                    return;
                }
                if (value is bool)
                {
                    builder.Append((bool)value ? "true" : "false");
                    return;
                }
                if (value is IDictionary<string, object>)
                {
                    builder.Append('{');
                    var first = true;
                    foreach (var pair in (IDictionary<string, object>)value)
                    {
                        if (!first) builder.Append(',');
                        first = false;
                        WriteString(builder, pair.Key);
                        builder.Append(':');
                        WriteValue(builder, pair.Value);
                    }
                    builder.Append('}');
                    return;
                }
                if (value is IEnumerable)
                {
                    builder.Append('[');
                    var first = true;
                    foreach (var item in (IEnumerable)value)
                    {
                        if (!first) builder.Append(',');
                        first = false;
                        WriteValue(builder, item);
                    }
                    builder.Append(']');
                    return;
                }
                if (value is int || value is long || value is short || value is byte ||
                    value is uint || value is ulong || value is ushort || value is sbyte ||
                    value is float || value is double || value is decimal)
                {
                    builder.Append(Convert.ToString(value, CultureInfo.InvariantCulture));
                    return;
                }
                WriteString(builder, Convert.ToString(value, CultureInfo.InvariantCulture));
            }

            private static void WriteString(StringBuilder builder, string value)
            {
                builder.Append('"');
                foreach (var character in value)
                {
                    switch (character)
                    {
                        case '"': builder.Append("\\\""); break;
                        case '\\': builder.Append("\\\\"); break;
                        case '\n': builder.Append("\\n"); break;
                        case '\r': builder.Append("\\r"); break;
                        case '\t': builder.Append("\\t"); break;
                        default:
                            if (character < 32) builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                            else builder.Append(character);
                            break;
                    }
                }
                builder.Append('"');
            }
        }
    }
}
#endif
