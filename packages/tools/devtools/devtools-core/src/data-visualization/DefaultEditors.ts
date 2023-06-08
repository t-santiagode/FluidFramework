/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable jsdoc/require-jsdoc */
/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

/**
 * This module contains default {@link VisualizeSharedObject | visualization}
 * implementations for our DDSs.
 */

import { SharedCounter } from "@fluidframework/counter";

import { ISharedObject } from "@fluidframework/shared-object-base";
import { SharedString } from "@fluidframework/sequence";
import { EditSharedObject } from "./DataVisualization";

import { FluidObjectValueNode, VisualNodeKind } from "./VisualTree";

/**
 * Default {@link VisualizeSharedObject} for {@link SharedCounter}.
 */
export const editSharedCounter: EditSharedObject = async (
	sharedObject: ISharedObject,
	value: string,
): Promise<FluidObjectValueNode> => {
	console.log("Hit editSharedCounter");
	const sharedCounter = sharedObject as SharedCounter;
	const delta = Number.parseInt(value, 10) - sharedCounter.value;
	sharedCounter.increment(delta);
	return {
		fluidObjectId: sharedCounter.id,
		value: sharedCounter.value,
		typeMetadata: "SharedCounter",
		nodeKind: VisualNodeKind.FluidValueNode,
	};
};

export const editSharedString: EditSharedObject = async (
	sharedObject: ISharedObject,
	value: string,
): Promise<FluidObjectValueNode> => {
	console.log("Hit editSharedString");
	const sharedString = sharedObject as SharedString;
	sharedString.replaceText(0, sharedString.getLength(), value);
	return {
		fluidObjectId: "5",
		value: 5,
		typeMetadata: "SharedCounter",
		nodeKind: VisualNodeKind.FluidValueNode,
	};
};

/**
 * List of default editors included in the library.
 */
export const defaultEditors: Record<string, EditSharedObject> = {
	[SharedCounter.getFactory().type]: editSharedCounter,
	[SharedString.getFactory().type]: editSharedString,
};
