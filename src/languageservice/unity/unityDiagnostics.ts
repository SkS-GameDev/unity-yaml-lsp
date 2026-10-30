/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { YAMLDocDiagnostic } from '../utils/parseUtils.js';

const UNITY_TAG_PREFIX = 'Unresolved tag: tag:unity3d.com,2011:';

/**
 * Unity tags are deliberately unresolved: registering every class ID would need
 * a list that changes with each Unity release. The warning carries no useful
 * information for Unity assets, so it is dropped for them only.
 */
export function filterUnityParserDiagnostics(diagnostics: YAMLDocDiagnostic[]): YAMLDocDiagnostic[] {
  return diagnostics.filter((diagnostic) => {
    if (diagnostic.message.startsWith(UNITY_TAG_PREFIX)) return false;
    if (diagnostic.message.startsWith('Unused anchor')) return false;
    return true;
  });
}
