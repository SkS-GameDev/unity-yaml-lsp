/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Diagnostic } from 'vscode-languageserver-types';
import type { YAMLDocDiagnostic } from '../utils/parseUtils.js';

const UNITY_TAG_PREFIX = 'Unresolved tag: tag:unity3d.com,2011:';

/**
 * Unity tags are deliberately unresolved: registering every class ID would need
 * a list that changes with each Unity release. The warning carries no useful
 * information for Unity assets, so it is dropped for them only.
 */
const LEGACY_PROPERTY = /^Property (m_TypeName|m_HashCode) is not allowed\.$/;

/**
 * Unity writes a few legacy serialized fields that the reflected script schema
 * cannot see, so strict unknown-property diagnostics are false positives there.
 */
export function filterUnitySchemaDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((diagnostic) => {
    const message = typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value;
    return !LEGACY_PROPERTY.test(message);
  });
}

export function filterUnityParserDiagnostics(diagnostics: YAMLDocDiagnostic[]): YAMLDocDiagnostic[] {
  return diagnostics.filter((diagnostic) => {
    if (diagnostic.message.startsWith(UNITY_TAG_PREFIX)) return false;
    if (diagnostic.message.startsWith('Unused anchor')) return false;
    return true;
  });
}
