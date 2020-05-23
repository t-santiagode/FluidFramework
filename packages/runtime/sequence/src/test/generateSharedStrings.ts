/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { SnapshotLegacy as Snapshot } from "@fluidframework/merge-tree";
// eslint-disable-next-line import/no-extraneous-dependencies
import * as mocks from "@fluidframework/test-runtime-utils";
import { SharedString } from "../sharedString";
import { SharedStringFactory } from "../sequenceFactory";

export const LocationBase: string = "src/test/snapshots/";

export const supportedVersions = new Map<string, any>([
    ["legacy", {}],
    ["v1", { newMergeTreeSnapshotFormat: true }]]);

export function* generateStrings(): Generator<[string, SharedString]> {
    for (const [version, options] of supportedVersions) {
        const documentId = "fakeId";
        const runtime: mocks.MockRuntime = new mocks.MockRuntime();
        for (const key of Object.keys(options)) {
            runtime.options[key] = options[key];
        }
        const insertText = "text";

        let sharedString = new SharedString(runtime, documentId, SharedStringFactory.Attributes);
        sharedString.initializeLocal();
        // Small enough so snapshot won't have body
        for (let i = 0; i < (Snapshot.sizeOfFirstChunk / insertText.length) / 2; ++i) {
            sharedString.insertText(0, `${insertText}${i}`);
        }

        yield [`${version}/headerOnly`, sharedString];

        sharedString = new SharedString(runtime, documentId, SharedStringFactory.Attributes);
        sharedString.initializeLocal();
        // Big enough that snapshot will have body
        for (let i = 0; i < (Snapshot.sizeOfFirstChunk / insertText.length) * 2; ++i) {
            sharedString.insertText(0, `${insertText}${i}`);
        }

        yield [`${version}/headerAndBody`, sharedString];

        sharedString = new SharedString(runtime, documentId, SharedStringFactory.Attributes);
        sharedString.initializeLocal();
        // Very big sharedString
        for (let i = 0; i < Snapshot.sizeOfFirstChunk; ++i) {
            sharedString.insertText(0, `${insertText}-${i}`);
        }

        yield [`${version}/largeBody`, sharedString];

        sharedString = new SharedString(runtime, documentId, SharedStringFactory.Attributes);
        sharedString.initializeLocal();
        // SharedString with markers
        for (let i = 0; i < (Snapshot.sizeOfFirstChunk / insertText.length) * 2; ++i) {
            sharedString.insertText(0, `${insertText}${i}`);
        }
        for (let i = 0; i < sharedString.getLength(); i += 70) {
            sharedString.insertMarker(i, 1, {
                ItemType: "Paragraph",
                Properties: { Bold: false },
                markerId: `marker${i}`,
                referenceTileLabels: ["Eop"],
            });
        }

        yield [`${version}/withMarkers`, sharedString];

        sharedString = new SharedString(runtime, documentId, SharedStringFactory.Attributes);
        sharedString.initializeLocal();
        // SharedString with annotations
        for (let i = 0; i < (Snapshot.sizeOfFirstChunk / insertText.length) * 2; ++i) {
            sharedString.insertText(0, `${insertText}${i}`);
        }
        for (let i = 0; i < sharedString.getLength(); i += 70) {
            sharedString.annotateRange(i, i + 10, { bold: true });
        }

        yield [`${version}/withAnnotations`, sharedString];

        sharedString = new SharedString(runtime, documentId, SharedStringFactory.Attributes);
        sharedString.initializeLocal();
        // Very big sharedString
        for (let i = 0; i < Snapshot.sizeOfFirstChunk; ++i) {
            sharedString.insertText(0, `${insertText}-${i}`);
        }

        yield [`${version}/largeBody`, sharedString];
    }
}
