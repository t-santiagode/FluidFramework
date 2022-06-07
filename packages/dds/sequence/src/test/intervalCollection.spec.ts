/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";
import { IChannelServices } from "@fluidframework/datastore-definitions";
import { ReferenceType } from "@fluidframework/merge-tree";
import {
    MockFluidDataStoreRuntime,
    MockContainerRuntimeFactory,
    MockContainerRuntimeFactoryForReconnection,
    MockContainerRuntimeForReconnection,
    MockStorage,
} from "@fluidframework/test-runtime-utils";
import { SharedString } from "../sharedString";
import { SharedStringFactory } from "../sequenceFactory";
import { IntervalCollection, IntervalType, SequenceInterval } from "../intervalCollection";

const assertIntervals = (
    sharedString: SharedString,
    intervalCollection: IntervalCollection<SequenceInterval>,
    expected: readonly { start: number; end: number; }[],
    validateOverlapping: boolean = true,
) => {
    const actual = Array.from(intervalCollection);
    if (validateOverlapping && sharedString.getLength() > 0) {
        const overlapping = intervalCollection.findOverlappingIntervals(0, sharedString.getLength() - 1);
        assert.deepEqual(actual, overlapping, "Interval search returned inconsistent results");
    }
    assert.strictEqual(actual.length, expected.length,
        `findOverlappingIntervals() must return the expected number of intervals`);

    const actualPos = actual.map((interval) => {
        const start = sharedString.localRefToPos(interval.start);
        const end = sharedString.localRefToPos(interval.end);
        return { start, end };
    });
    assert.deepEqual(actualPos, expected, "intervals are not as expected");
};

function assertIntervalEquals(
    string: SharedString,
    interval: SequenceInterval,
    endpoints: { start: number; end: number; },
): void {
    assert.equal(string.localRefToPos(interval.start), endpoints.start, "mismatched start");
    assert.equal(string.localRefToPos(interval.end), endpoints.end, "mismatched end");
}

describe("SharedString interval collections", () => {
    let sharedString: SharedString;
    let dataStoreRuntime1: MockFluidDataStoreRuntime;

    beforeEach(() => {
        dataStoreRuntime1 = new MockFluidDataStoreRuntime();
        sharedString = new SharedString(dataStoreRuntime1, "shared-string-1", SharedStringFactory.Attributes);
    });

    describe("in a connected state with a remote SharedString", () => {
        let sharedString2: SharedString;
        let containerRuntimeFactory: MockContainerRuntimeFactory;

        beforeEach(() => {
            containerRuntimeFactory = new MockContainerRuntimeFactory();

            // Connect the first SharedString.
            dataStoreRuntime1.local = false;
            const containerRuntime1 = containerRuntimeFactory.createContainerRuntime(dataStoreRuntime1);
            const services1 = {
                deltaConnection: containerRuntime1.createDeltaConnection(),
                objectStorage: new MockStorage(),
            };
            sharedString.initializeLocal();
            sharedString.connect(services1);

            // Create and connect a second SharedString.
            const dataStoreRuntime2 = new MockFluidDataStoreRuntime();
            const containerRuntime2 = containerRuntimeFactory.createContainerRuntime(dataStoreRuntime2);
            const services2 = {
                deltaConnection: containerRuntime2.createDeltaConnection(),
                objectStorage: new MockStorage(),
            };

            sharedString2 = new SharedString(dataStoreRuntime2, "shared-string-2", SharedStringFactory.Attributes);
            sharedString2.initializeLocal();
            sharedString2.connect(services2);
        });

        it("can maintain interval consistency", () => {
            const collection1 = sharedString.getIntervalCollection("test");
            sharedString.insertText(0, "xyz");
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test");
            assert.notStrictEqual(collection2, undefined, "undefined");
            assert.strictEqual(sharedString.getText(), sharedString2.getText(), "not equal text");

            sharedString.insertText(0, "abc");
            const interval = collection1.add(1, 1, IntervalType.SlideOnRemove);
            const intervalId = interval.getIntervalId();
            sharedString2.insertText(0, "wha");

            containerRuntimeFactory.processAllMessages();
            assert.strictEqual(sharedString.getText(), "whaabcxyz", "different text 1");
            assert.strictEqual(sharedString.getText(), "whaabcxyz", "different text 2");

            assertIntervals(sharedString, collection1, [
                { start: 4, end: 4 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 4, end: 4 },
            ]);

            collection2.change(intervalId, 1, 6);
            sharedString.removeText(0, 2);
            collection1.change(intervalId, 0, 5);

            containerRuntimeFactory.processAllMessages();

            assertIntervals(sharedString, collection1, [
                { start: 0, end: 5 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 0, end: 5 },
            ]);

            collection1.change(intervalId, sharedString.getLength() - 1, sharedString.getLength() - 1);

            containerRuntimeFactory.processAllMessages();

            assertIntervals(sharedString, collection1, [
                { start: sharedString.getLength() - 1, end: sharedString.getLength() - 1 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: sharedString2.getLength() - 1, end: sharedString2.getLength() - 1 },
            ]);
        });

        it("errors creating invalid intervals", () => {
            const collection1 = sharedString.getIntervalCollection("test");
            containerRuntimeFactory.processAllMessages();

            assert.throws(() => collection1.add(0, 0, IntervalType.SlideOnRemove),
                "Should throw creating interval on empty string");
            assert.throws(() => collection1.add(1, 3, IntervalType.SlideOnRemove),
                "Should throw creating interval on empty string");
            sharedString.insertText(0, "ABCD");
            containerRuntimeFactory.processAllMessages();
            assert.throws(() => collection1.add(2, 5, IntervalType.SlideOnRemove),
                "Should throw creating interval past end of string");
            // There is no check for creating an interval at a negative offset
            // assert.throws(() => collection1.add(-1, 2, IntervalType.SlideOnRemove),
            //     "Should throw creating interval at negative position");
        });

        it("can create and slide interval to a marker", () => {
            sharedString.insertText(0, "ABCD");
            sharedString.insertMarker(4, ReferenceType.Tile, { nodeType: "Paragraph" });
            const collection1 = sharedString.getIntervalCollection("test");
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test");

            collection1.add(3, 4, IntervalType.SlideOnRemove);
            containerRuntimeFactory.processAllMessages();

            assertIntervals(sharedString, collection1, [
                { start: 3, end: 4 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 3, end: 4 },
            ]);

            sharedString.removeRange(3, 4);
            containerRuntimeFactory.processAllMessages();

            assertIntervals(sharedString, collection1, [
                { start: 3, end: 3 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 3, end: 3 },
            ]);
        });

        it("can slide intervals nearer", () => {
            const collection1 = sharedString.getIntervalCollection("test");
            sharedString.insertText(0, "ABCD");
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test");

            // Conflicting remove/add interval at end of string
            collection1.add(1, 3, IntervalType.SlideOnRemove);
            sharedString2.removeRange(3, 4);
            containerRuntimeFactory.processAllMessages();
            assertIntervals(sharedString, collection1, [
                { start: 1, end: 2 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 1, end: 2 },
            ]);

            // Remove location of end of interval
            sharedString.removeRange(2, 3);
            assert.equal(sharedString.getText(), "AB");
            assertIntervals(sharedString, collection1, [
                // odd behavior - end of interval doesn't slide
                // until ack, so position beyond end of string
                { start: 1, end: 2 },
            ]);
            containerRuntimeFactory.processAllMessages();
            assertIntervals(sharedString, collection1, [
                { start: 1, end: 1 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 1, end: 1 },
            ]);

            // Remove location of start and end of interval
            sharedString.removeRange(1, 2);
            assertIntervals(sharedString, collection1, [
                // odd behavior - start of interval doesn't slide
                // until ack, so not found by overlapping search
                { start: 1, end: 1 },
            ], false);
            containerRuntimeFactory.processAllMessages();
            assertIntervals(sharedString, collection1, [
                { start: 0, end: 0 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 0, end: 0 },
            ]);

            // Interval on empty string
            sharedString.removeRange(0, 1);
            assertIntervals(sharedString, collection1, [
                // Search finds interval at end of string
                { start: 0, end: 0 },
            ]);
            containerRuntimeFactory.processAllMessages();
            assertIntervals(sharedString, collection1, [
                // Interval becomes detached when string is acked empty
                { start: -1, end: -1 },
            ], false);
            assertIntervals(sharedString2, collection2, [
                { start: -1, end: -1 },
            ], false);
        });

        it("can slide intervals nearer to locally removed segment", () => {
            const collection1 = sharedString.getIntervalCollection("test");
            sharedString.insertText(0, "ABCD");
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test");

            sharedString2.removeRange(3, 4);
            collection1.add(1, 3, IntervalType.SlideOnRemove);
            sharedString.removeRange(1, 3);
            containerRuntimeFactory.processAllMessages();
            assertIntervals(sharedString, collection1, [
                { start: 0, end: 0 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 0, end: 0 },
            ]);
        });

        it("consistent after remove all/insert text conflict", () => {
            const collection1 = sharedString.getIntervalCollection("test");
            sharedString.insertText(0, "ABCD");
            collection1.add(1, 3, IntervalType.SlideOnRemove);
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test");

            sharedString.insertText(0, "XYZ");
            sharedString2.removeRange(0, 4);
            containerRuntimeFactory.processAllMessages();
            assertIntervals(sharedString, collection1, [
                { start: 2, end: 2 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 2, end: 2 },
            ]);

            sharedString2.removeRange(0, 3);
            sharedString.insertText(0, "PQ");
            containerRuntimeFactory.processAllMessages();
            assertIntervals(sharedString, collection1, [
                { start: -1, end: -1 },
            ], false);
            assertIntervals(sharedString2, collection2, [
                { start: -1, end: -1 },
            ], false);

            sharedString2.removeRange(0, 2);
            containerRuntimeFactory.processAllMessages();
            assertIntervals(sharedString, collection1, [
                { start: -1, end: -1 },
            ], false);
            assertIntervals(sharedString2, collection2, [
                { start: -1, end: -1 },
            ], false);
        });

        it("can slide intervals on remove ack", () => {
            const collection1 = sharedString.getIntervalCollection("test");
            sharedString.insertText(0, "ABCD");
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test");

            collection1.add(1, 3, IntervalType.SlideOnRemove);
            containerRuntimeFactory.processAllMessages();

            sharedString.insertText(2, "X");
            assert.strictEqual(sharedString.getText(), "ABXCD");
            assertIntervals(sharedString, collection1, [
                { start: 1, end: 4 },
            ]);

            sharedString2.removeRange(1, 2);
            assert.strictEqual(sharedString2.getText(), "ACD");
            assertIntervals(sharedString2, collection2, [
                { start: 1, end: 2 },
            ]);

            containerRuntimeFactory.processAllMessages();
            assert.strictEqual(sharedString.getText(), "AXCD");
            assert.strictEqual(sharedString2.getText(), "AXCD");

            assertIntervals(sharedString, collection1, [
                { start: 1, end: 3 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 1, end: 3 },
            ]);
        });

        it("can slide intervals to segment not referenced by remove", () => {
            const collection1 = sharedString.getIntervalCollection("test");
            sharedString.insertText(0, "ABCD");
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test");

            sharedString.insertText(2, "X");
            assert.strictEqual(sharedString.getText(), "ABXCD");
            collection1.add(1, 3, IntervalType.SlideOnRemove);

            sharedString2.removeRange(1, 2);
            assert.strictEqual(sharedString2.getText(), "ACD");

            containerRuntimeFactory.processAllMessages();
            assert.strictEqual(sharedString.getText(), "AXCD");
            assert.strictEqual(sharedString2.getText(), "AXCD");

            assertIntervals(sharedString2, collection2, [
                { start: 1, end: 2 },
            ]);
            assertIntervals(sharedString, collection1, [
                { start: 1, end: 2 },
            ]);
        });

        it("can slide intervals on create ack", () => {
            // Create and connect a third SharedString.
            const dataStoreRuntime3 = new MockFluidDataStoreRuntime();
            const containerRuntime3 = containerRuntimeFactory.createContainerRuntime(dataStoreRuntime3);
            const services3 = {
                deltaConnection: containerRuntime3.createDeltaConnection(),
                objectStorage: new MockStorage(),
            };

            const sharedString3 = new SharedString(
                dataStoreRuntime3, "shared-string-3", SharedStringFactory.Attributes);
            sharedString3.initializeLocal();
            sharedString3.connect(services3);

            const collection1 = sharedString.getIntervalCollection("test");
            sharedString.insertText(0, "ABCD");
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test");
            const collection3 = sharedString3.getIntervalCollection("test");

            sharedString.removeRange(1, 2);
            assert.strictEqual(sharedString.getText(), "ACD");

            sharedString2.insertText(2, "X");
            assert.strictEqual(sharedString2.getText(), "ABXCD");

            collection3.add(1, 3, IntervalType.SlideOnRemove);

            containerRuntimeFactory.processAllMessages();
            assert.strictEqual(sharedString.getText(), "AXCD");
            assert.strictEqual(sharedString2.getText(), "AXCD");
            assert.strictEqual(sharedString3.getText(), "AXCD");

            assertIntervals(sharedString, collection1, [
                { start: 1, end: 3 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 1, end: 3 },
            ]);
            assertIntervals(sharedString3, collection3, [
                { start: 1, end: 3 },
            ]);
        });

        it("can slide intervals on change ack", () => {
            // Create and connect a third SharedString.
            const dataStoreRuntime3 = new MockFluidDataStoreRuntime();
            const containerRuntime3 = containerRuntimeFactory.createContainerRuntime(dataStoreRuntime3);
            const services3 = {
                deltaConnection: containerRuntime3.createDeltaConnection(),
                objectStorage: new MockStorage(),
            };

            const sharedString3 = new SharedString(
                dataStoreRuntime3, "shared-string-3", SharedStringFactory.Attributes);
            sharedString3.initializeLocal();
            sharedString3.connect(services3);

            const collection1 = sharedString.getIntervalCollection("test");
            sharedString.insertText(0, "ABCD");
            const interval = collection1.add(0, 0, IntervalType.SlideOnRemove);
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test");
            const collection3 = sharedString3.getIntervalCollection("test");

            sharedString.removeRange(1, 2);
            assert.strictEqual(sharedString.getText(), "ACD");

            sharedString2.insertText(2, "X");
            assert.strictEqual(sharedString2.getText(), "ABXCD");

            collection3.change(interval.getIntervalId(), 1, 3);

            containerRuntimeFactory.processAllMessages();
            assert.strictEqual(sharedString.getText(), "AXCD");
            assert.strictEqual(sharedString2.getText(), "AXCD");
            assert.strictEqual(sharedString3.getText(), "AXCD");

            assertIntervals(sharedString, collection1, [
                { start: 1, end: 3 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 1, end: 3 },
            ]);
            assertIntervals(sharedString3, collection3, [
                { start: 1, end: 3 },
            ]);

            sharedString.removeRange(3, 4);
            assertIntervals(sharedString, collection1, [
                { start: 1, end: 3 },
            ]);
            containerRuntimeFactory.processAllMessages();

            assertIntervals(sharedString, collection1, [
                { start: 1, end: 2 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 1, end: 2 },
            ]);
            assertIntervals(sharedString3, collection3, [
                { start: 1, end: 2 },
            ]);
        });

        it("can slide intervals on create before remove", () => {
            const collection1 = sharedString.getIntervalCollection("test");
            sharedString.insertText(0, "ABCD");
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test");

            collection2.add(2, 3, IntervalType.SlideOnRemove);

            sharedString.removeRange(1, 3);

            containerRuntimeFactory.processAllMessages();

            assertIntervals(sharedString2, collection2, [
                { start: 1, end: 1 },
            ]);
            assertIntervals(sharedString, collection1, [
                { start: 1, end: 1 },
            ]);
        });

        it("can slide intervals on remove before create", () => {
            const collection1 = sharedString.getIntervalCollection("test");
            sharedString.insertText(0, "ABCDE");
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test");

            sharedString.removeRange(1, 3);
            assert.strictEqual(sharedString.getText(), "ADE");

            collection2.add(1, 3, IntervalType.SlideOnRemove);

            containerRuntimeFactory.processAllMessages();

            // before fixing this, at this point the start range on sharedString
            // is on the removed segment. Can't detect that from the interval API.
            assertIntervals(sharedString2, collection2, [
                { start: 1, end: 1 },
            ]);
            assertIntervals(sharedString, collection1, [
                { start: 1, end: 1 },
            ]);

            // More operations reveal the problem
            sharedString.insertText(2, "X");
            assert.strictEqual(sharedString.getText(), "ADXE");
            sharedString2.removeRange(1, 2);
            assert.strictEqual(sharedString2.getText(), "AE");

            containerRuntimeFactory.processAllMessages();
            assert.strictEqual(sharedString.getText(), "AXE");

            assertIntervals(sharedString2, collection2, [
                { start: 1, end: 1 },
            ]);
            assertIntervals(sharedString, collection1, [
                { start: 1, end: 1 },
            ]);
        });

        it("can maintain different offsets on removed segment", () => {
            const collection1 = sharedString.getIntervalCollection("test");
            sharedString.insertText(0, "ABCD");
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test");

            collection1.add(1, 3, IntervalType.SlideOnRemove);
            sharedString.insertText(2, "XY");
            assert.strictEqual(sharedString.getText(), "ABXYCD");

            sharedString2.removeRange(0, 4);
            assert.strictEqual(sharedString2.getText(), "");

            containerRuntimeFactory.processAllMessages();
            assert.strictEqual(sharedString.getText(), "XY");
            assert.strictEqual(sharedString2.getText(), "XY");

            assertIntervals(sharedString, collection1, [
                { start: 0, end: 1 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 0, end: 1 },
            ]);
        });

        it("tolerates creation of an interval with no segment due to concurrent delete", () => {
            sharedString.insertText(0, "ABCDEF");
            const collection1 = sharedString.getIntervalCollection("test");
            const collection2 = sharedString2.getIntervalCollection("test");
            containerRuntimeFactory.processAllMessages();
            sharedString2.removeRange(0, sharedString2.getLength());
            collection1.add(1, 1, IntervalType.SlideOnRemove);
            sharedString2.insertText(0, "X");
            containerRuntimeFactory.processAllMessages();
            assertIntervals(sharedString, collection1, [{ start: -1, end: -1 }], false);
            assertIntervals(sharedString2, collection2, [{ start: -1, end: -1 }], false);
        });

        it("can maintain consistency of LocalReference's when segments are packed", async () => {
            // sharedString.insertMarker(0, ReferenceType.Tile, { nodeType: "Paragraph" });

            const collection1 = sharedString.getIntervalCollection("test2");
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test2");

            sharedString.insertText(0, "a");
            sharedString.insertText(1, "b");
            sharedString.insertText(2, "c");
            sharedString.insertText(3, "d");
            sharedString.insertText(4, "e");
            sharedString.insertText(5, "f");

            containerRuntimeFactory.processAllMessages();

            assert.strictEqual(sharedString.getText(), "abcdef", "incorrect text 1");
            assert.strictEqual(sharedString2.getText(), "abcdef", "incorrect text 2");

            collection1.add(2, 2, IntervalType.SlideOnRemove);

            containerRuntimeFactory.processAllMessages();

            assertIntervals(sharedString, collection1, [
                { start: 2, end: 2 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 2, end: 2 },
            ]);

            sharedString.insertText(0, "a");
            sharedString.insertText(1, "b");
            sharedString.insertText(2, "c");
            sharedString.insertText(3, "d");
            sharedString.insertText(4, "e");
            sharedString.insertText(5, "f");

            containerRuntimeFactory.processAllMessages();

            assert.strictEqual(sharedString.getText(), "abcdefabcdef", "incorrect text 2");
            assert.strictEqual(sharedString2.getText(), "abcdefabcdef", "incorrect text 3");

            collection1.add(5, 5, IntervalType.SlideOnRemove);
            collection1.add(2, 2, IntervalType.SlideOnRemove);

            containerRuntimeFactory.processAllMessages();

            assertIntervals(sharedString, collection1, [
                { start: 2, end: 2 },
                { start: 5, end: 5 },
                { start: 8, end: 8 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 2, end: 2 },
                { start: 5, end: 5 },
                { start: 8, end: 8 },
            ]);

            // Summarize to cause Zamboni to pack segments. Confirm consistency after packing.
            await sharedString2.summarize();

            assertIntervals(sharedString, collection1, [
                { start: 2, end: 2 },
                { start: 5, end: 5 },
                { start: 8, end: 8 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 2, end: 2 },
                { start: 5, end: 5 },
                { start: 8, end: 8 },
            ]);
        });

        it("ignores remote changes that would be overridden by multiple local ones", () => {
            // The idea of this test is to verify multiple pending local changes are tracked accurately.
            // No tracking at all of pending changes would cause collection 1 to see all 5 values: 0, 1, 2, 3, 4.
            // Tracking that there is only a local change, but not which one it was might cause collection 1 to
            // see 4 values: 0, 2, 3, 4.
            // Correct tracking should cause collection1 to only see 3 values: 0, 2, 4
            sharedString.insertText(0, "ABCDEF");
            const collection1 = sharedString.getIntervalCollection("test");
            const endpointsForCollection1: { start: number; end: number; }[] = [];
            const sequenceIntervalToEndpoints = (interval: SequenceInterval): { start: number; end: number; } => ({
                start: sharedString.localRefToPos(interval.start),
                end: sharedString.localRefToPos(interval.end),
            });

            collection1.on("addInterval", (interval) => {
                endpointsForCollection1.push(sequenceIntervalToEndpoints(interval));
            });
            collection1.on("changeInterval", (interval) => {
                const { start, end } = sequenceIntervalToEndpoints(interval);
                // IntervalCollection is a bit noisy when it comes to change events; this logic makes sure
                // to only append for actually changed values.
                const prevValue = endpointsForCollection1[endpointsForCollection1.length - 1];
                if (prevValue.start !== start || prevValue.end !== end) {
                    endpointsForCollection1.push({ start, end });
                }
            });

            const id = collection1.add(0, 0, IntervalType.SlideOnRemove).getIntervalId();
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test");

            collection2.change(id, 1, 1);
            collection1.change(id, 2, 2);

            assertIntervalEquals(sharedString2, collection2.getIntervalById(id), { start: 1, end: 1 });
            assertIntervalEquals(sharedString, collection1.getIntervalById(id), { start: 2, end: 2 });

            collection2.change(id, 3, 3);
            collection1.change(id, 4, 4);
            containerRuntimeFactory.processAllMessages();
            assert.deepEqual(endpointsForCollection1, [
                { start: 0, end: 0 },
                { start: 2, end: 2 },
                { start: 4, end: 4 },
            ]);
        });

        describe("intervalCollection comparator consistency", () => {
            // This is a regression suite for an issue caught by fuzz testing:
            // if intervals A, B, C are created which initially compare A < B < C,
            // it's possible that string operations can change this order. Specifically,
            // removing substrings of text can make LocalReferences which previously compared
            // unequal now compare equal. Since the interval comparator is lexicographical on
            // the array [start reference, end reference, id], collapsing previously-unequal
            // references to now equal ones can cause issues.
            // The immediate way this manifests is that attempting to remove the interval fails
            // in red-black tree code, since the key isn't at the expected location.
            let collection: IntervalCollection<SequenceInterval>;
            beforeEach(() => {
                sharedString.insertText(0, "ABCDEFG");
                collection = sharedString.getIntervalCollection("test");
            });

            it("retains intervalTree coherency when falling back to end comparison", () => {
                collection.add(1, 6, IntervalType.SlideOnRemove);
                collection.add(2, 5, IntervalType.SlideOnRemove);
                const initiallyLargest = collection.add(3, 4, IntervalType.SlideOnRemove);
                sharedString.removeRange(1, 4);
                // Interval slide doesn't happen until creation is acked, so interval sort order
                // is still by start position, which do not compare equal despite all appearing to be 1
                assertIntervals(sharedString, collection, [
                    { start: 1, end: 3 },
                    { start: 1, end: 2 },
                    { start: 1, end: 1 },
                ]);
                collection.removeIntervalById(initiallyLargest.getIntervalId());
                assertIntervals(sharedString, collection, [
                    { start: 1, end: 3 },
                    { start: 1, end: 2 },
                ]);
                containerRuntimeFactory.processAllMessages();
                // After processing messages, intervals slide and order is as expected.
                assertIntervals(sharedString, collection, [
                    { start: 1, end: 2 },
                    { start: 1, end: 3 },
                ]);
            });

            it("retains intervalTree coherency after slide when falling back to end comparison", () => {
                collection.add(1, 6, IntervalType.SlideOnRemove);
                collection.add(2, 5, IntervalType.SlideOnRemove);
                const initiallyLargest = collection.add(3, 4, IntervalType.SlideOnRemove);
                sharedString.removeRange(1, 4);
                assertIntervals(sharedString, collection, [
                    { start: 1, end: 3 },
                    { start: 1, end: 2 },
                    { start: 1, end: 1 },
                ]);
                containerRuntimeFactory.processAllMessages();
                assertIntervals(sharedString, collection, [
                    { start: 1, end: 1 },
                    { start: 1, end: 2 },
                    { start: 1, end: 3 },
                ]);
                collection.removeIntervalById(initiallyLargest.getIntervalId());
                assertIntervals(sharedString, collection, [
                    { start: 1, end: 2 },
                    { start: 1, end: 3 },
                ]);
                containerRuntimeFactory.processAllMessages();
                assertIntervals(sharedString, collection, [
                    { start: 1, end: 2 },
                    { start: 1, end: 3 },
                ]);
            });

            it("retains intervalTree coherency when falling back to id comparison", () => {
                const [idLowest, idMiddle, idLargest] = ["a", "b", "c"];
                collection.add(0, 1, IntervalType.SlideOnRemove, { intervalId: idLargest });
                collection.add(0, 2, IntervalType.SlideOnRemove, { intervalId: idMiddle });
                collection.add(0, 3, IntervalType.SlideOnRemove, { intervalId: idLowest });
                sharedString.removeRange(1, 4);
                assertIntervals(sharedString, collection, [
                    { start: 0, end: 1 },
                    { start: 0, end: 1 },
                    { start: 0, end: 1 },
                ]);
                collection.removeIntervalById(idLowest);
                assertIntervals(sharedString, collection, [
                    { start: 0, end: 1 },
                    { start: 0, end: 1 },
                ]);
                containerRuntimeFactory.processAllMessages();
                assertIntervals(sharedString, collection, [
                    { start: 0, end: 1 },
                    { start: 0, end: 1 },
                ]);
            });

            it("retains intervalTree coherency after slide when falling back to id comparison", () => {
                const [idLowest, idMiddle, idLargest] = ["a", "b", "c"];
                collection.add(0, 1, IntervalType.SlideOnRemove, { intervalId: idLargest });
                collection.add(0, 2, IntervalType.SlideOnRemove, { intervalId: idMiddle });
                collection.add(0, 3, IntervalType.SlideOnRemove, { intervalId: idLowest });
                sharedString.removeRange(1, 4);
                assertIntervals(sharedString, collection, [
                    { start: 0, end: 1 },
                    { start: 0, end: 1 },
                    { start: 0, end: 1 },
                ]);
                containerRuntimeFactory.processAllMessages();
                assertIntervals(sharedString, collection, [
                    { start: 0, end: 1 },
                    { start: 0, end: 1 },
                    { start: 0, end: 1 },
                ]);
                collection.removeIntervalById(idLowest);
                assertIntervals(sharedString, collection, [
                    { start: 0, end: 1 },
                    { start: 0, end: 1 },
                ]);
                containerRuntimeFactory.processAllMessages();
                assertIntervals(sharedString, collection, [
                    { start: 0, end: 1 },
                    { start: 0, end: 1 },
                ]);
            });

            it("retains intervalTree coherency after slide on create ack", () => {
                // The code in createAck needs to change the reference positions for an interval.
                // The test verifies that is done correctly and that the listener is added
                // to fix the interval position on subsequent slide.
                containerRuntimeFactory.processAllMessages();
                collection.add(4, 4, IntervalType.SlideOnRemove);
                collection.add(4, 5, IntervalType.SlideOnRemove);

                sharedString2.removeRange(1, 2);

                const initiallySmallest = collection.add(1, 6, IntervalType.SlideOnRemove);

                sharedString2.removeRange(1, 3);

                assertIntervals(sharedString, collection, [
                    { start: 1, end: 6 },
                    { start: 4, end: 4 },
                    { start: 4, end: 5 },
                ]);

                containerRuntimeFactory.processAllMessages();
                assertIntervals(sharedString, collection, [
                    { start: 1, end: 1 },
                    { start: 1, end: 2 },
                    { start: 1, end: 3 },
                ]);
                collection.removeIntervalById(initiallySmallest.getIntervalId());
                assertIntervals(sharedString, collection, [
                    { start: 1, end: 1 },
                    { start: 1, end: 2 },
                ]);
                containerRuntimeFactory.processAllMessages();
                assertIntervals(sharedString, collection, [
                    { start: 1, end: 1 },
                    { start: 1, end: 2 },
                ]);
            });
        });

        it("test IntervalCollection creation events", () => {
            let createCalls1 = 0;
            const createInfo1 = [];
            const createCallback1 = (label: string, local: boolean, target: SharedString) => {
                assert.strictEqual(target, sharedString, "Expected event to target sharedString");
                createInfo1[createCalls1++] = { local, label };
            };
            sharedString.on("createIntervalCollection", createCallback1);

            let createCalls2 = 0;
            const createInfo2 = [];
            const createCallback2 = (label: string, local: boolean, target: SharedString) => {
                assert.strictEqual(target, sharedString2, "Expected event to target sharedString2");
                createInfo2[createCalls2++] = { local, label };
            };
            sharedString2.on("createIntervalCollection", createCallback2);

            sharedString.insertText(0, "hello world");
            containerRuntimeFactory.processAllMessages();

            const collection1: IntervalCollection<SequenceInterval> = sharedString.getIntervalCollection("test1");
            const interval1 = collection1.add(0, 1, IntervalType.SlideOnRemove);
            collection1.change(interval1.getIntervalId(), 1, 4);

            const collection2: IntervalCollection<SequenceInterval> = sharedString2.getIntervalCollection("test2");
            const interval2 = collection2.add(0, 2, IntervalType.SlideOnRemove);
            collection2.removeIntervalById(interval2.getIntervalId());

            const collection3: IntervalCollection<SequenceInterval> = sharedString2.getIntervalCollection("test3");
            collection3.add(0, 3, IntervalType.SlideOnRemove);

            containerRuntimeFactory.processAllMessages();

            const verifyCreateEvents = (s: SharedString, createInfo, infoArray) => {
                let i = 0;
                const labels = s.getIntervalCollectionLabels();
                for (const label of labels) {
                    assert.equal(label, infoArray[i].label, `Bad label ${i}: ${label}`);
                    assert.equal(label, createInfo[i].label, `Bad label ${i}: ${createInfo[i].label}`);
                    assert.equal(
                        createInfo[i].local, infoArray[i].local, `Bad local value ${i}: ${createInfo[i].local}`);
                    i++;
                }
                assert.equal(infoArray.length, createInfo.length, `Wrong number of create calls: ${i}`);
            };
            verifyCreateEvents(sharedString, createInfo1, [
                { label: "intervalCollections/test1", local: true },
                { label: "intervalCollections/test2", local: false },
                { label: "intervalCollections/test3", local: false },
            ]);
            verifyCreateEvents(sharedString2, createInfo2, [
                { label: "intervalCollections/test2", local: true },
                { label: "intervalCollections/test3", local: true },
                { label: "intervalCollections/test1", local: false },
            ]);
        });

        it("can be concurrently created", () => {
            sharedString.insertText(0, "hello world");
            const collection1 = sharedString.getIntervalCollection("test");
            const collection2 = sharedString2.getIntervalCollection("test");
            containerRuntimeFactory.processAllMessages();
            assert.equal(Array.from(collection1).length, 0);
            assert.equal(Array.from(collection2).length, 0);
        });

        it("doesn't slide references on ack if there are pending remote changes", () => {
            sharedString.insertText(0, "ABCDEF");
            const collection1 = sharedString.getIntervalCollection("test");
            const collection2 = sharedString2.getIntervalCollection("test");
            containerRuntimeFactory.processAllMessages();
            sharedString.removeRange(3, 6);
            const interval = collection2.add(3, 4, IntervalType.SlideOnRemove);
            collection2.change(interval.getIntervalId(), 1, 5);

            assert.equal(containerRuntimeFactory.outstandingMessageCount, 3, "Unexpected number of ops");
            containerRuntimeFactory.processOneMessage();
            assertIntervals(sharedString2, collection2, [{ start: 1, end: 3 /* hasn't yet been acked */ }]);
            containerRuntimeFactory.processOneMessage();
            assertIntervals(sharedString2, collection2, [{ start: 1, end: 3 /* hasn't yet been acked */ }]);
            containerRuntimeFactory.processOneMessage();
            assertIntervals(sharedString2, collection2, [{ start: 1, end: 2 }]);

            assert.equal(sharedString.getText(), "ABC");
            assertIntervals(sharedString, collection1, [{ start: 1, end: 2 }]);
        });
    });

    // TODO: Enable this test suite once correctness issues with reconnect are addressed.
    // See https://github.com/microsoft/FluidFramework/issues/8739 for more context.
    describe.skip("reconnect", () => {
        let containerRuntimeFactory: MockContainerRuntimeFactoryForReconnection;
        let containerRuntime1: MockContainerRuntimeForReconnection;
        let containerRuntime2: MockContainerRuntimeForReconnection;
        let sharedString2: SharedString;

        let collection1: IntervalCollection<SequenceInterval>;
        let collection2: IntervalCollection<SequenceInterval>;
        let interval: SequenceInterval;

        beforeEach(async () => {
            containerRuntimeFactory = new MockContainerRuntimeFactoryForReconnection();

            // Connect the first SharedString.
            containerRuntime1 = containerRuntimeFactory.createContainerRuntime(dataStoreRuntime1);
            const services1: IChannelServices = {
                deltaConnection: containerRuntime1.createDeltaConnection(),
                objectStorage: new MockStorage(),
            };
            sharedString.initializeLocal();
            sharedString.connect(services1);

            // Create and connect a second SharedString.
            const runtime2 = new MockFluidDataStoreRuntime();
            containerRuntime2 = containerRuntimeFactory.createContainerRuntime(runtime2);
            sharedString2 = new SharedString(runtime2, "shared-string-2", SharedStringFactory.Attributes);
            const services2: IChannelServices = {
                deltaConnection: containerRuntime2.createDeltaConnection(),
                objectStorage: new MockStorage(),
            };
            sharedString2.initializeLocal();
            sharedString2.connect(services2);

            sharedString.insertText(0, "hello friend");
            collection1 = sharedString.getIntervalCollection("test");
            containerRuntimeFactory.processAllMessages();

            collection2 = sharedString2.getIntervalCollection("test");
            containerRuntimeFactory.processAllMessages();

            // Note: at the start of each test, this interval is only visible to client 1.
            interval = collection1.add(6, 8, IntervalType.SlideOnRemove); // the "fr" in "friend"
        });

        it("addInterval resubmitted with concurrent insert", async () => {
            containerRuntime1.connected = false;

            sharedString2.insertText(7, "amily its my f");
            containerRuntimeFactory.processAllMessages();

            containerRuntime1.connected = true;
            containerRuntimeFactory.processAllMessages();

            assert.equal(sharedString2.getText(), "hello family its my friend");
            assertIntervals(sharedString2, collection2, [
                { start: 6, end: 22 },
            ]);
            assertIntervals(sharedString, collection1, [
                { start: 6, end: 22 },
            ]);
        });

        it("addInterval resubmitted with concurrent delete", async () => {
            containerRuntime1.connected = false;

            sharedString2.removeText(5, 9);
            containerRuntimeFactory.processAllMessages();

            containerRuntime1.connected = true;
            containerRuntimeFactory.processAllMessages();

            assert.equal(sharedString2.getText(), "helloend");
            assertIntervals(sharedString2, collection2, [
                { start: 5, end: 5 },
            ]);
            assertIntervals(sharedString, collection1, [
                { start: 5, end: 5 },
            ]);
        });

        it("delete resubmitted with concurrent insert", async () => {
            containerRuntimeFactory.processAllMessages();
            containerRuntime1.connected = false;

            collection1.removeIntervalById(interval.getIntervalId());
            sharedString2.insertText(7, "amily its my f");
            containerRuntimeFactory.processAllMessages();

            containerRuntime1.connected = true;
            containerRuntimeFactory.processAllMessages();

            // Verify that the changes were correctly received by the second SharedString
            assert.equal(sharedString2.getText(), "hello family its my friend");
            assertIntervals(sharedString2, collection2, []);
            assertIntervals(sharedString, collection1, []);
        });

        it("change resubmitted with concurrent insert", async () => {
            containerRuntimeFactory.processAllMessages();
            containerRuntime1.connected = false;

            collection1.change(interval.getIntervalId(), 5, 9); // " fri"
            sharedString2.insertText(7, "amily its my f");
            containerRuntimeFactory.processAllMessages();

            containerRuntime1.connected = true;
            containerRuntimeFactory.processAllMessages();

            assert.equal(sharedString2.getText(), "hello family its my friend");
            assertIntervals(sharedString2, collection2, [
                { start: 5, end: 23 },
            ]);
            assertIntervals(sharedString, collection1, [
                { start: 5, end: 23 },
            ]);
        });

        it("change resubmitted with concurrent delete", async () => {
            containerRuntimeFactory.processAllMessages();
            containerRuntime1.connected = false;

            collection1.change(interval.getIntervalId(), 5, 9); // " fri"
            sharedString2.removeText(8, 10);
            containerRuntimeFactory.processAllMessages();

            containerRuntime1.connected = true;
            containerRuntimeFactory.processAllMessages();

            assert.equal(sharedString2.getText(), "hello frnd");
            assertIntervals(sharedString2, collection2, [
                { start: 5, end: 8 },
            ]);
            assertIntervals(sharedString, collection1, [
                { start: 5, end: 8 },
            ]);
        });
    });
});