/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { HasContainerKey, HasFluidObjectId } from "../../CommonInterfaces";
import { IDevtoolsMessage } from "../Messages";

/**
 * Encapsulates types and logic related to {@link SendEdit.Message}.
 *
 * @internal
 */
export namespace SendEdit {
	/**
	 * {@link SendEdit.Message} {@link IDevtoolsMessage."type"}.
	 *
	 * @internal
	 */
	export const MessageType = "SEND_EDIT";

	/**
	 * Message data format used by {@link GetDataVisualization.Message}.
	 *
	 * @internal
	 */
	export type MessageData = HasContainerKey & HasFluidObjectId;

	/**
	 * Inbound message requesting the list of Containers for which Devtools have been registered.
	 * Will result in the {@link SendEdit.Message} message being posted.
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
	 * Creates a {@link SendEdit.Message}.
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
