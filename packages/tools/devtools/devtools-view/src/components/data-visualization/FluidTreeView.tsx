/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
import React from "react";

import { HasContainerKey, FluidObjectTreeNode } from "@fluid-experimental/devtools-core";

import { DataVisualizationTreeProps } from "./CommonInterfaces";
import { TreeDataView } from "./TreeDataView";
import { TreeHeader } from "./TreeHeader";
import { TreeItem } from "./TreeItem";

/**
 * {@link TreeView} input props.
 */
export interface FluidTreeViewProps
	extends HasContainerKey,
		DataVisualizationTreeProps<FluidObjectTreeNode> {}

/**
 * Render data with type VisualNodeKind.FluidTreeNode and render its children.
 */
export function FluidTreeView(props: FluidTreeViewProps): React.ReactElement {
	const { containerKey, label, node } = props;
	console.log(label);
	const childNodes = Object.entries(node.children).map(([key, fluidObject]) => (
		<TreeDataView key={key} containerKey={containerKey} label={key} node={fluidObject} />
	));

	const header = <TreeHeader label={"FluidObject"} nodeTypeMetadata={node.typeMetadata} />;

	return <TreeItem header={header}>{childNodes}</TreeItem>;
}
