/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

/**
 * A key used to identify and differentiate Containers registered with the {@link IFluidDevtools}.
 *
 * @remarks Each Container registered with the Devtools must be assigned a unique `containerKey`.
 *
 * @example "Canvas Container"
 *
 * @public
 */
export type ContainerKey = string;

/**
 * Common interface for data associated with a particular Container registered with the Devtools.
 *
 * @public
 */
export interface HasContainerKey {
	/**
	 * {@inheritDoc ContainerKey}
	 */
	containerKey: ContainerKey;
}

/**
 * A unique ID for a Fluid object
 *
 * @public
 */
export type FluidObjectId = string;

/**
 * Base interface used in message data for events targeting a particular Fluid object (DDS) via
 * a unique ID.
 *
 * @internal
 */
export interface HasFluidObjectId {
	/**
	 * The ID of the Fluid object (DDS) associated with data or a request.
	 */
	fluidObjectId: FluidObjectId;
}

/**
 * Base interface used in message data for events targeting a particular Fluid object (DDS) via
 * a unique ID.
 *
 * @internal
 */
export interface HasValue {
	value: string;
}
