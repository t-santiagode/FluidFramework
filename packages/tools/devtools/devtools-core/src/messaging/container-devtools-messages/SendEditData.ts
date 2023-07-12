/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { HasContainerKey, HasEditType, HasFluidObjectId, HasNewData } from "../../CommonInterfaces";
import { IDevtoolsMessage } from "../Messages";

/**
 * Encapsulates types and logic related to {@link SendEditData.Message}.
 *
 * @internal
 */
export namespace SendEditData {
	/**
	 * {@link GetDataVisualization.Message} {@link IDevtoolsMessage."type"}.
	 *
	 * @internal
	 */
	export const MessageType = "SEND_EDIT_DATA";

	/**
	 * Message data format used by {@link GetDataVisualization.Message}.
	 *
	 * @internal
	 */
	export type MessageData = HasContainerKey & HasFluidObjectId & HasNewData & HasEditType;

	/**
	 * Inbound message requesting a visualization for a specific DDS via its associated {@link HasFluidObjectId.fluidObjectId}.
	 *
	 * Will result in the {@link DataVisualization.Message} message being posted.
	 *
	 * @internal
	 */
	export interface Message extends IDevtoolsMessage<MessageData> {
		/**
		 * {@inheritDoc IDevtoolsMessage."type"}
		 */
		type: typeof MessageType;
	}

	/**
	 * Creates a {@link SendEditData.Message} from the provided {@link SendEditData.MessageData}.
	 *
	 * @internal
	 */
	export function createMessage(data: MessageData): Message {
		return {
			data,
			type: MessageType,
		};
	}
}
