/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { ISharedObject } from "@fluidframework/shared-object-base";
import { Serializable } from "@fluidframework/datastore-definitions";
import { EditType, HasFluidObjectId } from "../CommonInterfaces";

/**
 * Generates a description of the edit to be applied to {@link @fluidframework/shared-object-base#ISharedObject}'s
 * current state.
 *
 * @param sharedObject - The {@link @fluidframework/shared-object-base#ISharedObject} whose data will be edited.
 * @param edit - Describes what changes will be made using {@link Edit}.
 *
 * @public
 */
export type EditSharedObject = (sharedObject: ISharedObject, edit: Edit) => Promise<void>;

/**
 * Interface to contain information necesary for an edit
 * @public
 */
export interface Edit {
	/**
	 * Type contains the {@link EditType} of the edit being preformed
	 */
	type?: EditType;

	/**
	 * Data contains the new data that will be edited into the DDS
	 */
	data: Serializable<unknown>;
}

/**
 * Interface to contain information necesary for an edit of a SharedObject
 * @internal
 */
export interface SharedObjectEdit extends Edit, HasFluidObjectId {}
