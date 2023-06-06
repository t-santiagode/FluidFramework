/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
import React from "react";

import {
	HasContainerKey,
	VisualNodeKind,
	SendEdit,
	// Edit,
	// FluidObjectNode,
	// GetDataVisualization,
	// ISourcedDevtoolsMessage,
	// InboundHandlers,
	// handleIncomingMessage,
} from "@fluid-experimental/devtools-core";

import { Button } from "@fluentui/react-components";
import { VehicleShip24Filled } from "@fluentui/react-icons";
import { Stack, StackItem } from "@fluentui/react";
import { useMessageRelay } from "../../MessageRelayContext";
import { DataVisualizationTreeProps } from "./CommonInterfaces";
import { FluidHandleView, FluidHandleViewProps } from "./FluidHandleView";
import { TreeView } from "./TreeView";
import { FluidTreeView } from "./FluidTreeView";
import { ValueView } from "./ValueView";
import { FluidValueView } from "./FluidValueView";
import { UnknownFluidObjectView } from "./UnknownFluidObjectView";
import { UnknownDataView } from "./UnknownDataView";
// import { TreeHeader } from "./TreeHeader";
// import { TreeItem } from "./TreeItem";

/**
 * {@link TreeDataView} input props.
 */
export interface TreeDataViewProps extends HasContainerKey, DataVisualizationTreeProps {}

/**
 * Displays visual summary trees for DDS_s within the container based on the current node's type.
 */
export function TreeDataView(props: TreeDataViewProps): React.ReactElement {
	const { containerKey, label, node } = props;

	switch (node.nodeKind) {
		/**
		 * Node with children.
		 */
		case VisualNodeKind.TreeNode:
			return <TreeView containerKey={containerKey} label={label} node={node} />;
		/**
		 * FluidObjectNode with children.
		 */
		case VisualNodeKind.FluidTreeNode:
			return <FluidTreeView containerKey={containerKey} label={label} node={node} />;
		/**
		 * Node with primitive value.
		 */
		case VisualNodeKind.ValueNode:
			return <ValueView label={label} node={node} />;
		/**
		 * FluidObjectNode with primitive value.
		 */
		case VisualNodeKind.FluidValueNode:
			return (
				<Stack horizontal>
					<StackItem>{<FluidValueView label={label} node={node} />}</StackItem>
					<StackItem>
						{
							<EditButton
								containerKey={containerKey}
								fluidObjectId={node.fluidObjectId}
								label={label}
							/>
						}
					</StackItem>
				</Stack>
			);
		/**
		 * Unknown data type.
		 */
		case VisualNodeKind.UnknownObjectNode:
			return <UnknownDataView label={label} node={node} />;
		/**
		 * Unknown SharedObject data type.
		 */
		case VisualNodeKind.FluidUnknownObjectNode:
			return <UnknownFluidObjectView label={label} node={node} />;
		/**
		 * POST request to FluidClientDebugger.
		 */
		case VisualNodeKind.FluidHandleNode:
			return (
				<FluidHandleView
					containerKey={containerKey}
					fluidObjectId={node.fluidObjectId}
					label={label}
				/>
			);
		default:
			console.log("DevTools hit unknown data. This is NOT expected.");
			return <></>;
	}
}

function EditButton(props: FluidHandleViewProps): React.ReactElement {
	// const { containerKey, fluidObjectId, label } = props;
	// const messageRelay = useMessageRelay();

	// const [edit, setEdit] = React.useState<React.ReactElement | undefined>();

	// React.useEffect(() => {
	// 	/**
	// 	 * Handlers for inbound message related to Send Edit.
	// 	 */
	// 	const inboundMessageHandlers: InboundHandlers = {
	// 		[Edit.MessageType]: async (untypedMessage) => {
	// 			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	// 			const message = untypedMessage as Edit.Message;
	// 			if (
	// 				message.data.containerKey === containerKey &&
	// 				message.data.fluidObjectId === fluidObjectId
	// 			) {
	// 				console.log(message.data.value);
	// 				return true;
	// 			} else {
	// 				return false;
	// 			}
	// 		},
	// 	};

	// 	/**
	// 	 * Event handler for messages coming from the Message Relay.
	// 	 */
	// 	function messageHandler(message: Partial<ISourcedDevtoolsMessage>): void {
	// 		handleIncomingMessage(message, inboundMessageHandlers, {
	// 			context: loggingContext,
	// 		});
	// 	}

	// 	function handleEditClick(): void {
	// 		messageRelay.on("message", messageHandler);

	// 		// POST Request for FluidObjectNode.
	// 		messageRelay.postMessage(
	// 			SendEdit.createMessage({
	// 				containerKey,
	// 				fluidObjectId,
	// 			}),
	// 		);
	// 	}
	// }, [containerKey, setEdit, fluidObjectId, messageRelay]);

	// // if (visualTree === undefined) {
	// // 	const header = <TreeHeader label={label} inlineValue={<Spinner size="tiny" />} />;
	// // 	return <TreeItem header={header} />;
	// // }
	// const transparentButtonStyle = {
	// 	backgroundColor: "transparent",
	// 	border: "none",
	// 	cursor: "pointer",
	// };
	// return (
	// 	<Button
	// 		icon={<VehicleShip24Filled />}
	// 		color="red"
	// 		style={transparentButtonStyle}
	// 		onClick={handleEditClick}
	// 		aria-label="Edit Value"
	// 	></Button>
	// );

	const messageRelay = useMessageRelay();

	function handleEditClick(): void {
		const { containerKey, fluidObjectId, label } = props;
		console.log(label);
		const sendEditMessage = SendEdit.createMessage({
			containerKey,
			fluidObjectId,
		});

		// using Refresh button as template
		// messageRelay.on();
		console.log("Button works");
		messageRelay.postMessage(sendEditMessage);
	}
	const transparentButtonStyle = {
		backgroundColor: "transparent",
		border: "none",
		cursor: "pointer",
	};

	return (
		<Button
			icon={<VehicleShip24Filled />}
			color="red"
			style={transparentButtonStyle}
			onClick={handleEditClick}
			aria-label="Edit Value"
		></Button>
	);
}
