/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
import React, { useState } from "react";

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
			return (
				<Stack horizontal>
					<StackItem>{<ValueView label={label} node={node} />}</StackItem>
					<StackItem>
						{
							<EditButton
								containerKey={containerKey}
								fluidObjectId={label}
								label={label}
							/>
						}
					</StackItem>
				</Stack>
			);
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
	const [value, setValue] = useState<string>("");

	const handleButtonClick = (): void => {
		const { containerKey, fluidObjectId, label } = props;
		console.log(label);
		const sendEditMessage = SendEdit.createMessage({
			containerKey,
			fluidObjectId,
			value,
		});
		setValue("");

		// using Refresh button as template
		// messageRelay.on();
		console.log("Button works");
		messageRelay.postMessage(sendEditMessage);
	};

	const handleTextFieldChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
		setValue(event.target.value);
	};

	const messageRelay = useMessageRelay();

	return (
		<div>
			<input type="text" value={value} onChange={handleTextFieldChange} />
			<button onClick={handleButtonClick}>Log Text</button>
		</div>
	);
}
