/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { fail } from "../../util";
import * as F from "./format";
import { isSkipMark } from "./utils";

/**
 * Dummy value used in place of the actual tag.
 * TODO: give `invert` access real tag data.
 */
export const DUMMY_INVERT_TAG: F.ChangesetTag = "Dummy Invert Changeset Tag";

export type NodeChangeInverter<TNodeChange> = (change: TNodeChange) => TNodeChange;

/**
 * Inverts a given changeset.
 * @param change - The changeset to produce the inverse of.
 * @returns The inverse of the given `change` such that the inverse can be applied after `change`.
 *
 * WARNING! This implementation is incomplete:
 * - It is unable to produce adequate inverses for set-value and delete operations.
 * This is because changesets are not given IDs.
 * - Support for moves is not implemented.
 * - Support for slices is not implemented.
 */
export function invert<TNodeChange>(
    change: F.Changeset<TNodeChange>,
    invertChild: NodeChangeInverter<TNodeChange>,
): F.Changeset<TNodeChange> {
    // TODO: support the input change being a squash
    const opIdToTag = (id: F.OpId): F.ChangesetTag => {
        return DUMMY_INVERT_TAG;
    };
    return invertMarkList(change, opIdToTag, invertChild);
}

type IdToTagLookup = (id: F.OpId) => F.ChangesetTag;

function invertMarkList<TNodeChange>(
    markList: F.MarkList<TNodeChange>,
    opIdToTag: IdToTagLookup,
    invertChild: NodeChangeInverter<TNodeChange>,
): F.MarkList<TNodeChange> {
    const inverseMarkList: F.MarkList<TNodeChange> = [];
    for (const mark of markList) {
        const inverseMarks = invertMark(mark, opIdToTag, invertChild);
        inverseMarkList.push(...inverseMarks);
    }
    return inverseMarkList;
}

function invertMark<TNodeChange>(
    mark: F.Mark<TNodeChange>,
    opIdToTag: IdToTagLookup,
    invertChild: NodeChangeInverter<TNodeChange>,
): F.Mark<TNodeChange>[] {
    if (isSkipMark(mark)) {
        return [mark];
    } else {
        switch (mark.type) {
            case "Insert":
            case "MInsert": {
                return [
                    {
                        type: "Delete",
                        id: mark.id,
                        count: mark.type === "Insert" ? mark.content.length : 1,
                    },
                ];
            }
            case "Delete": {
                return [
                    {
                        type: "Revive",
                        id: mark.id,
                        tomb: opIdToTag(mark.id),
                        count: mark.count,
                    },
                ];
            }
            case "Revive": {
                return [
                    {
                        type: "Delete",
                        id: mark.id,
                        count: mark.count,
                    },
                ];
            }
            case "Modify": {
                return [
                    {
                        type: "Modify",
                        changes: invertChild(mark.changes),
                    },
                ];
            }
            default:
                fail("Not implemented");
        }
    }
}