/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

// Required for testing support of null values
/* eslint-disable unicorn/no-null */

import { expect } from "chai";

import { SharedCell } from "@fluidframework/cell";
import { MockFluidDataStoreRuntime } from "@fluidframework/test-runtime-utils";
import { editSharedCell } from "../data-visualization";

describe("DefaultEditors unit tests", () => {
	it("SharedCell", async () => {
		const runtime = new MockFluidDataStoreRuntime();
		const sharedCell = new SharedCell("test-cell", runtime, SharedCell.getFactory().attributes);

		await editSharedCell(sharedCell, { data: true });

		const expected = false;

		expect(sharedCell.get()).to.deep.equal(expected);
	});
});
