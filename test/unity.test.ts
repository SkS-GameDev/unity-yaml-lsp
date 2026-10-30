/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, beforeEach } from 'node:test';
import assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { yamlDocumentsCache } from '../src/languageservice/parser/yaml-documents.js';
import {
  attachUnityMetadata,
  findUnityReferenceAt,
  isTextUnityYaml,
  isUnityUri,
  preprocessUnityText,
} from '../src/languageservice/unity/unityUtils.js';
import {
  getUnitySchemaForDocument,
  getUnityProjectSchema,
  hasUnityGuid,
  resolveUnityGuid,
} from '../src/languageservice/unity/unityProject.js';
import { UnityReferenceValidator } from '../src/languageservice/services/validation/unity-references.js';
import { getUnityDefinition, getUnityDocumentSymbols, getUnityHover } from '../src/languageservice/unity/unityNavigation.js';

const SCRIPT_GUID = '0123456789abcdef0123456789abcdef';
const ASSET_GUID = 'fedcba9876543210fedcba9876543210';

const scene = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100
GameObject:
  m_Name: On
  m_Component:
  - component: {fileID: 200}
--- !u!4 &200 stripped
Transform:
  m_GameObject: {fileID: 100}
  m_LocalPosition: {x: 1, y: 2, z: 3}
`;

function project(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'unity-yaml-lsp-'));
  mkdirSync(path.join(root, 'Assets'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

function schemaFile(extraClasses: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    classes: {
      '1': {
        name: 'GameObject',
        schema: {
          type: 'object',
          properties: {
            GameObject: {
              type: 'object',
              properties: {
                m_Name: { type: ['string', 'number', 'boolean', 'null'] },
                m_Component: { type: ['array', 'null'], items: { type: ['object', 'null'] } },
              },
              additionalProperties: true,
            },
          },
          required: ['GameObject'],
          additionalProperties: false,
        },
      },
      '4': {
        name: 'Transform',
        schema: {
          type: 'object',
          properties: {
            Transform: {
              type: 'object',
              properties: {
                m_GameObject: { type: ['object', 'null'] },
                m_LocalPosition: {
                  type: ['object', 'null'],
                  properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
                  additionalProperties: false,
                },
              },
              additionalProperties: true,
            },
          },
          required: ['Transform'],
          additionalProperties: false,
        },
      },
      ...extraClasses,
    },
    scripts: {
      [SCRIPT_GUID]: {
        name: 'Player',
        schema: {
          type: 'object',
          properties: {
            MonoBehaviour: {
              type: 'object',
              properties: {
                m_Script: { type: ['object', 'null'] },
                speed: { type: 'number' },
              },
              additionalProperties: false,
            },
          },
          required: ['MonoBehaviour'],
          additionalProperties: false,
        },
      },
    },
  });
}

function parseFile(root: string, relativePath: string): { uri: string; document: TextDocument; yaml: ReturnType<typeof yamlDocumentsCache.getYamlDocument> } {
  const uri = pathToFileURL(path.join(root, relativePath)).toString();
  const text = scene;
  const document = TextDocument.create(uri, 'yaml', 1, text);
  const yaml = yamlDocumentsCache.getYamlDocument(document);
  for (const item of yaml.documents) item.uri = uri;
  return { uri, document, yaml };
}

describe('Unity utilities', () => {
  beforeEach(() => yamlDocumentsCache.clear());

  it('recognises Unity files and content', () => {
    assert.equal(isUnityUri('file:///project/Assets/Scene.unity'), true);
    assert.equal(isUnityUri('file:///project/Assets/Player.prefab'), true);
    assert.equal(isUnityUri('file:///project/Assets/Thing.meta'), true);
    assert.equal(isUnityUri('file:///project/Assets/README.md'), false);
    assert.equal(isTextUnityYaml(scene), true);
    assert.equal(isTextUnityYaml('plain: text'), false);
    assert.equal(isTextUnityYaml('\u0000binary'), false);
  });

  it('preprocesses stripped without moving offsets', () => {
    const processed = preprocessUnityText(scene);
    assert.equal(processed.length, scene.length);
    assert.equal(processed.includes(' stripped'), false);
    assert.equal(processed.includes('%YAML 1.1'), true);
    const before = scene.indexOf('m_LocalPosition');
    const after = processed.indexOf('m_LocalPosition');
    assert.equal(before, after);
  });

  it('extracts class IDs, fileIDs and stripped markers from document tokens', () => {
    const { yaml } = parseFile(project({ 'Assets/Scene.unity': scene }), 'Assets/Scene.unity');
    assert.equal(yaml.documents.length, 2);
    assert.equal(yaml.documents[0].unityClassId, '1');
    assert.equal(yaml.documents[0].unityFileID, '100');
    assert.equal(yaml.documents[0].unityStripped, false);
    assert.equal(yaml.documents[1].unityClassId, '4');
    assert.equal(yaml.documents[1].unityFileID, '200');
    assert.equal(yaml.documents[1].unityStripped, true);
    assert.equal(yaml.documents[0].unityHeaderOffset, scene.indexOf('--- !u!1'));
  });

  it('keeps Unity strings as strings despite the 1.1 directive', () => {
    const { yaml } = parseFile(project({ 'Assets/Scene.unity': scene }), 'Assets/Scene.unity');
    const value = yaml.documents[0].internalDocument.toJS() as { GameObject: { m_Name: unknown } };
    assert.equal(value.GameObject.m_Name, 'On');
  });

  it('finds references on the cursor line', () => {
    const document = TextDocument.create('file:///project/Assets/Scene.unity', 'yaml', 1, scene);
    const line = scene.split('\n').findIndex((text) => text.includes('m_GameObject'));
    const character = scene.split('\n')[line].indexOf('{fileID') + 3;
    const reference = findUnityReferenceAt(document, { line, character });
    assert.equal(reference?.fileID, '100');
  });

  it('attaches metadata to already parsed documents', () => {
    const document = TextDocument.create('file:///project/Assets/Scene.unity', 'yaml', 1, scene);
    const parsed = yamlDocumentsCache.getYamlDocument(document);
    attachUnityMetadata(parsed, scene);
    assert.equal(parsed.documents[1].unityFileID, '200');
  });
});

describe('Unity project schemas', () => {
  beforeEach(() => yamlDocumentsCache.clear());

  it('loads a schema and routes class IDs and script GUIDs', () => {
    const root = project({
      'Assets/Scene.unity': scene,
      'Library/UnityYaml/schema.json': schemaFile(),
    });
    const { uri, yaml } = parseFile(root, 'Assets/Scene.unity');
    assert.equal(getUnityProjectSchema(uri)?.classes?.['1']?.name, 'GameObject');
    assert.equal(getUnitySchemaForDocument(uri, yaml.documents[0])?.type, 'object');

    const script = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!114 &300
MonoBehaviour:
  m_Script: {fileID: 11500000, guid: ${SCRIPT_GUID}, type: 3}
  speed: 5
`;
    const scriptDoc = TextDocument.create(pathToFileURL(path.join(root, 'Assets/Player.prefab')).toString(), 'yaml', 1, script);
    const parsedScript = yamlDocumentsCache.getYamlDocument(scriptDoc);
    parsedScript.documents[0].uri = scriptDoc.uri;
    const schema = getUnitySchemaForDocument(scriptDoc.uri, parsedScript.documents[0]) as { properties?: Record<string, unknown> };
    assert.ok(schema.properties?.MonoBehaviour);
  });

  it('returns null for stripped and unknown classes', () => {
    const root = project({
      'Assets/Scene.unity': scene,
      'Library/UnityYaml/schema.json': schemaFile(),
    });
    const { uri, yaml } = parseFile(root, 'Assets/Scene.unity');
    assert.equal(getUnitySchemaForDocument(uri, yaml.documents[1]), null);
  });

  it('resolves and checks GUIDs', () => {
    const root = project({
      'Assets/Scene.unity': scene,
      'Assets/Foo.cs.meta': `fileFormatVersion: 2\nguid: ${ASSET_GUID}\n`,
      'Library/UnityYaml/schema.json': schemaFile(),
    });
    const uri = pathToFileURL(path.join(root, 'Assets/Scene.unity')).toString();
    assert.equal(resolveUnityGuid(uri, ASSET_GUID), path.join(root, 'Assets/Foo.cs'));
    assert.equal(hasUnityGuid(uri, ASSET_GUID), true);
    assert.equal(hasUnityGuid(uri, '11111111111111111111111111111111'), false);
    assert.equal(hasUnityGuid(uri, '0000000000000000f000000000000000'), true);
  });
});

describe('Unity reference diagnostics', () => {
  beforeEach(() => yamlDocumentsCache.clear());

  it('accepts local fileID references', () => {
    const root = project({ 'Assets/Scene.unity': scene, 'Library/UnityYaml/schema.json': schemaFile() });
    const { document, yaml } = parseFile(root, 'Assets/Scene.unity');
    const validator = new UnityReferenceValidator();
    const diagnostics = yaml.documents.flatMap((item) => validator.validate(document, item));
    assert.equal(diagnostics.length, 0);
  });

  it('reports missing fileIDs, duplicate fileIDs and missing GUIDs', () => {
    const text = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100
GameObject:
  m_Name: Test
--- !u!4 &100
Transform:
  m_GameObject: {fileID: 999}
  m_Mesh: {fileID: 1, guid: 11111111111111111111111111111111, type: 3}
`;
    const root = project({ 'Assets/Scene.unity': text, 'Library/UnityYaml/schema.json': schemaFile() });
    const uri = pathToFileURL(path.join(root, 'Assets/Scene.unity')).toString();
    const document = TextDocument.create(uri, 'yaml', 1, text);
    const yaml = yamlDocumentsCache.getYamlDocument(document);
    for (const item of yaml.documents) item.uri = uri;
    const validator = new UnityReferenceValidator();
    const diagnostics = yaml.documents.flatMap((item) => validator.validate(document, item));
    assert.equal(diagnostics.length, 3);
    assert.ok(diagnostics.some((item) => String(item.message).includes('Duplicate fileID 100')));
    assert.ok(diagnostics.some((item) => String(item.message).includes('fileID 999 not found')));
    assert.ok(diagnostics.some((item) => String(item.message).includes('guid 11111111111111111111111111111111 not found')));
  });
});

describe('Unity navigation', () => {
  beforeEach(() => yamlDocumentsCache.clear());

  it('defines local fileID references', () => {
    const root = project({ 'Assets/Scene.unity': scene, 'Library/UnityYaml/schema.json': schemaFile() });
    const { uri, document, yaml } = parseFile(root, 'Assets/Scene.unity');
    const line = scene.split('\n').findIndex((text) => text.includes('m_GameObject'));
    const character = scene.split('\n')[line].indexOf('{fileID') + 3;
    const definition = getUnityDefinition(document, { line, character });
    assert.equal(definition?.[0].targetUri, uri);
    assert.equal(definition?.[0].targetRange.start.line, scene.split('\n').indexOf('--- !u!1 &100'));
    assert.ok(yaml.documents[0].unityHeaderOffset !== undefined);
  });

  it('defines GUID references into another asset', () => {
    const prefab = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &555
GameObject:
  m_Name: Source
`;
    const root = project({
      'Assets/Scene.unity': scene,
      'Assets/Source.prefab': prefab,
      'Assets/Source.prefab.meta': `fileFormatVersion: 2\nguid: ${ASSET_GUID}\n`,
      'Library/UnityYaml/schema.json': schemaFile(),
    });
    const text = scene.replace('m_LocalPosition: {x: 1, y: 2, z: 3}', `m_Mesh: {fileID: 555, guid: ${ASSET_GUID}, type: 3}`);
    const uri = pathToFileURL(path.join(root, 'Assets/Scene.unity')).toString();
    const document = TextDocument.create(uri, 'yaml', 1, text);
    yamlDocumentsCache.getYamlDocument(document);
    const line = text.split('\n').findIndex((item) => item.includes('m_Mesh'));
    const character = text.split('\n')[line].indexOf('{fileID') + 3;
    const definition = getUnityDefinition(document, { line, character });
    assert.ok(definition?.[0].targetUri.endsWith('Source.prefab'));
    assert.equal(definition?.[0].targetRange.start.line, 2);
  });

  it('builds document symbols and hover', () => {
    const root = project({ 'Assets/Scene.unity': scene, 'Library/UnityYaml/schema.json': schemaFile() });
    const { document } = parseFile(root, 'Assets/Scene.unity');
    const symbols = getUnityDocumentSymbols(document);
    assert.equal(symbols?.length, 2);
    assert.ok(symbols?.[0].name.includes('GameObject'));
    const headerLine = scene.split('\n').indexOf('--- !u!1 &100');
    const hover = getUnityHover(document, { line: headerLine, character: 5 });
    assert.ok(hover?.contents && JSON.stringify(hover.contents).includes('GameObject'));
  });
});
