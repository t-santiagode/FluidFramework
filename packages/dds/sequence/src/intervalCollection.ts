/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

/* eslint-disable no-bitwise */

import { assert, TypedEventEmitter } from "@fluidframework/common-utils";
import { IEvent } from "@fluidframework/common-definitions";
import { UsageError } from "@fluidframework/container-utils";
import {
	addProperties,
	Client,
	compareReferencePositions,
	createMap,
	ICombiningOp,
	ISegment,
	MergeTreeDeltaType,
	minReferencePosition,
	PropertiesManager,
	PropertySet,
	RedBlackTree,
	LocalReferencePosition,
	ReferenceType,
	refTypeIncludesFlag,
	reservedRangeLabelsKey,
	UnassignedSequenceNumber,
	maxReferencePosition,
	createDetachedLocalReferencePosition,
	DetachedReferencePosition,
	SlidingPreference,
	PropertyAction,
} from "@fluidframework/merge-tree";
import { ISequencedDocumentMessage } from "@fluidframework/protocol-definitions";
import { LoggingError } from "@fluidframework/telemetry-utils";
import { v4 as uuid } from "uuid";
import {
	IMapMessageLocalMetadata,
	IValueFactory,
	IValueOpEmitter,
	IValueOperation,
	IValueType,
	IValueTypeOperationValue,
	SequenceOptions,
} from "./defaultMapInterfaces";
import { IInterval, IntervalConflictResolver } from "./intervalTree";
import { IOverlappingIntervalsIndex, createOverlappingIntervalsIndex } from "./intervalIndex";

const reservedIntervalIdKey = "intervalId";

/**
 * Values are used in persisted formats (ops) and revertibles.
 * @alpha
 */
export const IntervalOpType = {
	ADD: "add",
	DELETE: "delete",
	CHANGE: "change",
	PROPERTY_CHANGED: "propertyChanged",
	POSITION_REMOVE: "positionRemove",
} as const;

export enum IntervalType {
	Simple = 0x0,
	Nest = 0x1,

	/**
	 * SlideOnRemove indicates that the ends of the interval will slide if the segment
	 * they reference is removed and acked.
	 * See `packages\dds\merge-tree\docs\REFERENCEPOSITIONS.md` for details
	 * SlideOnRemove is the default interval behavior and does not need to be specified.
	 */
	SlideOnRemove = 0x2, // SlideOnRemove is default behavior - all intervals are SlideOnRemove

	/**
	 * A temporary interval, used internally
	 * @internal
	 */
	Transient = 0x4,
}

/**
 * Serialized object representation of an interval.
 * This representation is used for ops that create or change intervals.
 * @internal
 */
export interface ISerializedInterval {
	/**
	 * Sequence number at which `start` and `end` should be interpreted
	 *
	 * @remarks - It's unclear that this is necessary to store here.
	 * This should just be the refSeq on the op that modified the interval, which should be available via other means.
	 * At the time of writing, it's not plumbed through to the reconnect/rebase code, however, which does need it.
	 */
	sequenceNumber: number;
	/** Start position of the interval */
	start: number;
	/** End position of the interval */
	end: number;
	/** Interval type to create */
	intervalType: IntervalType;
	stickiness?: IntervalStickiness;
	/** Any properties the interval has */
	properties?: PropertySet;
}

/**
 * Represents a change that should be applied to an existing interval.
 * Changes can modify any of start/end/properties, with `undefined` signifying no change should be made.
 * @internal
 */
export type SerializedIntervalDelta = Omit<ISerializedInterval, "start" | "end" | "properties"> &
	Partial<Pick<ISerializedInterval, "start" | "end" | "properties">>;

/**
 * A size optimization to avoid redundantly storing keys when serializing intervals
 * as JSON for summaries.
 *
 * Intervals are of the format:
 *
 * [start, end, sequenceNumber, intervalType, properties, stickiness?]
 */
export type CompressedSerializedInterval =
	| [number, number, number, IntervalType, PropertySet, IntervalStickiness]
	| [number, number, number, IntervalType, PropertySet];

export interface ISerializedIntervalCollectionV2 {
	label: string;
	version: 2;
	intervals: CompressedSerializedInterval[];
}

/**
 * Decompress an interval after loading a summary from JSON. The exact format
 * of this compression is unspecified and subject to change
 */
function decompressInterval(
	interval: CompressedSerializedInterval,
	label?: string,
): ISerializedInterval {
	return {
		start: interval[0],
		end: interval[1],
		sequenceNumber: interval[2],
		intervalType: interval[3],
		properties: { ...interval[4], [reservedRangeLabelsKey]: [label] },
		stickiness: interval[5],
	};
}

/**
 * Compress an interval prior to serialization as JSON. The exact format of this
 * compression is unspecified and subject to change
 */
function compressInterval(interval: ISerializedInterval): CompressedSerializedInterval {
	const { start, end, sequenceNumber, intervalType, properties } = interval;

	const base: CompressedSerializedInterval = [
		start,
		end,
		sequenceNumber,
		intervalType,
		// remove the `referenceRangeLabels` property as it is already stored
		// in the `label` field of the summary
		{ ...properties, [reservedRangeLabelsKey]: undefined },
	];

	if (interval.stickiness !== undefined && interval.stickiness !== IntervalStickiness.END) {
		base.push(interval.stickiness);
	}

	return base;
}

function startReferenceSlidingPreference(stickiness: IntervalStickiness): SlidingPreference {
	// if any start stickiness, prefer sliding backwards
	return (stickiness & IntervalStickiness.START) !== 0
		? SlidingPreference.BACKWARD
		: SlidingPreference.FORWARD;
}

function endReferenceSlidingPreference(stickiness: IntervalStickiness): SlidingPreference {
	// if any end stickiness, prefer sliding forwards
	return (stickiness & IntervalStickiness.END) !== 0
		? SlidingPreference.FORWARD
		: SlidingPreference.BACKWARD;
}

export interface ISerializableInterval extends IInterval {
	/** Serializable bag of properties associated with the interval. */
	properties: PropertySet;
	/** @internal */
	propertyManager: PropertiesManager;
	/** @internal */
	serialize(): ISerializedInterval;
	/** @internal */
	addProperties(
		props: PropertySet,
		collaborating?: boolean,
		seq?: number,
	): PropertySet | undefined;
	/**
	 * Gets the id associated with this interval.
	 * When the interval is used as part of an interval collection, this id can be used to modify or remove the
	 * interval.
	 * @remarks - This signature includes `undefined` strictly for backwards-compatibility reasons, as older versions
	 * of Fluid didn't always write interval ids.
	 */
	getIntervalId(): string | undefined;
}

/**
 * @sealed
 */
export interface IIntervalHelpers<TInterval extends ISerializableInterval> {
	compareEnds(a: TInterval, b: TInterval): number;
	compareStarts?(a: TInterval, b: TInterval): number;
	/**
	 *
	 * @param label - label of the interval collection this interval is being added to. This parameter is
	 * irrelevant for transient intervals.
	 * @param start - numerical start position of the interval
	 * @param end - numerical end position of the interval
	 * @param client - client creating the interval
	 * @param intervalType - Type of interval to create. Default is SlideOnRemove
	 * @param op - If this create came from a remote client, op that created it. Default is undefined (i.e. local)
	 * @param fromSnapshot - If this create came from loading a snapshot. Default is false.
	 */
	create(
		label: string,
		start: number | undefined,
		end: number | undefined,
		client: Client | undefined,
		intervalType: IntervalType,
		op?: ISequencedDocumentMessage,
		fromSnapshot?: boolean,
		stickiness?: IntervalStickiness,
	): TInterval;
}

/**
 * Determines how an interval should expand when segments are inserted adjacent
 * to the range it spans
 *
 * Note that interval stickiness is currently an experimental feature and must
 * be explicitly enabled with the `intervalStickinessEnabled` flag
 */
export const IntervalStickiness = {
	/**
	 * Interval does not expand to include adjacent segments
	 */
	NONE: 0b00,

	/**
	 * Interval expands to include segments inserted adjacent to the start
	 */
	START: 0b01,

	/**
	 * Interval expands to include segments inserted adjacent to the end
	 *
	 * This is the default stickiness
	 */
	END: 0b10,

	/**
	 * Interval expands to include all segments inserted adjacent to it
	 */
	FULL: 0b11,
} as const;

/**
 * Determines how an interval should expand when segments are inserted adjacent
 * to the range it spans
 *
 * Note that interval stickiness is currently an experimental feature and must
 * be explicitly enabled with the `intervalStickinessEnabled` flag
 */
export type IntervalStickiness = typeof IntervalStickiness[keyof typeof IntervalStickiness];

/**
 * Serializable interval whose endpoints are plain-old numbers.
 */
export class Interval implements ISerializableInterval {
	/**
	 * {@inheritDoc ISerializableInterval.properties}
	 */
	public properties: PropertySet;
	/** @internal */
	public auxProps: PropertySet[] | undefined;
	/**
	 * {@inheritDoc ISerializableInterval.propertyManager}
	 * @deprecated - This API was never intended to be public and will be marked internal in a future release.
	 */
	public propertyManager: PropertiesManager;
	constructor(public start: number, public end: number, props?: PropertySet) {
		this.propertyManager = new PropertiesManager();
		this.properties = {};

		if (props) {
			this.addProperties(props);
		}
	}

	/**
	 * {@inheritDoc ISerializableInterval.getIntervalId}
	 */
	public getIntervalId(): string {
		const id = this.properties?.[reservedIntervalIdKey];
		assert(id !== undefined, 0x5e1 /* interval ID should not be undefined */);
		return `${id}`;
	}

	/**
	 * @returns an array containing any auxiliary property sets added with `addPropertySet`.
	 */
	public getAdditionalPropertySets(): PropertySet[] {
		return this.auxProps ?? [];
	}

	/**
	 * Adds an auxiliary set of properties to this interval.
	 * These properties can be recovered using `getAdditionalPropertySets`
	 * @param props - set of properties to add
	 * @remarks - This gets called as part of the default conflict resolver for `IIntervalCollection<Interval>`
	 * (i.e. non-sequence-based interval collections). However, the additional properties don't get serialized.
	 * This functionality seems half-baked.
	 */
	public addPropertySet(props: PropertySet) {
		if (this.auxProps === undefined) {
			this.auxProps = [];
		}
		this.auxProps.push(props);
	}

	/**
	 * {@inheritDoc ISerializableInterval.serialize}
	 * @internal
	 */
	public serialize(): ISerializedInterval {
		const serializedInterval: ISerializedInterval = {
			end: this.end,
			intervalType: 0,
			sequenceNumber: 0,
			start: this.start,
		};
		if (this.properties) {
			serializedInterval.properties = this.properties;
		}
		return serializedInterval;
	}

	/**
	 * {@inheritDoc IInterval.clone}
	 */
	public clone() {
		return new Interval(this.start, this.end, this.properties);
	}

	/**
	 * {@inheritDoc IInterval.compare}
	 */
	public compare(b: Interval) {
		const startResult = this.compareStart(b);
		if (startResult === 0) {
			const endResult = this.compareEnd(b);
			if (endResult === 0) {
				const thisId = this.getIntervalId();
				if (thisId) {
					const bId = b.getIntervalId();
					if (bId) {
						return thisId > bId ? 1 : thisId < bId ? -1 : 0;
					}
					return 0;
				}
				return 0;
			} else {
				return endResult;
			}
		} else {
			return startResult;
		}
	}

	/**
	 * {@inheritDoc IInterval.compareStart}
	 */
	public compareStart(b: Interval) {
		return this.start - b.start;
	}

	/**
	 * {@inheritDoc IInterval.compareEnd}
	 */
	public compareEnd(b: Interval) {
		return this.end - b.end;
	}

	/**
	 * {@inheritDoc IInterval.overlaps}
	 */
	public overlaps(b: Interval) {
		const result = this.start <= b.end && this.end >= b.start;
		return result;
	}

	/**
	 * {@inheritDoc IInterval.union}
	 * @deprecated - This API was never intended to be public and will be marked internal in a future release.
	 */
	public union(b: Interval) {
		return new Interval(
			Math.min(this.start, b.start),
			Math.max(this.end, b.end),
			this.properties,
		);
	}

	public getProperties() {
		return this.properties;
	}

	/**
	 * {@inheritDoc ISerializableInterval.addProperties}
	 * @deprecated - This API was never intended to be public and will be marked internal in a future release.
	 */
	public addProperties(
		newProps: PropertySet,
		collaborating: boolean = false,
		seq?: number,
		op?: ICombiningOp,
	): PropertySet | undefined {
		if (newProps) {
			this.initializeProperties();
			return this.propertyManager.addProperties(
				this.properties,
				newProps,
				op,
				seq,
				collaborating,
			);
		}
	}

	/**
	 * {@inheritDoc IInterval.modify}
	 * @deprecated - This API was never intended to be public and will be marked internal in a future release.
	 */
	public modify(label: string, start: number, end: number, op?: ISequencedDocumentMessage) {
		const startPos = start ?? this.start;
		const endPos = end ?? this.end;
		if (this.start === startPos && this.end === endPos) {
			// Return undefined to indicate that no change is necessary.
			return;
		}
		const newInterval = new Interval(startPos, endPos);
		if (this.properties) {
			newInterval.initializeProperties();
			this.propertyManager.copyTo(
				this.properties,
				newInterval.properties,
				newInterval.propertyManager,
			);
		}
		return newInterval;
	}

	private initializeProperties(): void {
		if (!this.propertyManager) {
			this.propertyManager = new PropertiesManager();
		}
		if (!this.properties) {
			this.properties = createMap<any>();
		}
	}
}

/**
 * Interval implementation whose ends are associated with positions in a mutatable sequence.
 * As such, when content is inserted into the middle of the interval, the interval expands to
 * include that content.
 *
 * @remarks - The endpoint's position should be treated exclusively to get reasonable behavior--i.e.
 * an interval referring to "hello" in "hello world" should have a start position of 0 and an end
 * position of 5.
 *
 * To see why, consider what happens if "llo wor" is removed from the string to make "held".
 * The interval's startpoint remains on the "h" (it isn't altered), but the interval's endpoint
 * slides forward to the next unremoved position, which is the "l" in "held".
 * Users would generally expect the interval to now refer to "he" (as it is the subset of content
 * remaining after the removal), hence the "l" should be excluded.
 * If the interval endpoint was treated inclusively, the interval would now refer to "hel", which
 * is undesirable.
 *
 * Since the end of an interval is treated exclusively but cannot be greater than or equal to the
 * length of the associated sequence, application models which leverage interval collections should
 * consider inserting a marker at the end of the sequence to represent the end of the content.
 */
export class SequenceInterval implements ISerializableInterval {
	/**
	 * {@inheritDoc ISerializableInterval.properties}
	 */
	public properties: PropertySet;
	/**
	 * {@inheritDoc ISerializableInterval.propertyManager}
	 * @deprecated - This API was never intended to be public and will be marked internal in a future release.
	 */
	public propertyManager: PropertiesManager;

	constructor(
		private readonly client: Client,
		/**
		 * Start endpoint of this interval.
		 * @remarks - This endpoint can be resolved into a character position using the SharedString it's a part of.
		 */
		public start: LocalReferencePosition,
		/**
		 * End endpoint of this interval.
		 * @remarks - This endpoint can be resolved into a character position using the SharedString it's a part of.
		 */
		public end: LocalReferencePosition,
		public intervalType: IntervalType,
		props?: PropertySet,
		public readonly stickiness: IntervalStickiness = IntervalStickiness.END,
	) {
		this.propertyManager = new PropertiesManager();
		this.properties = {};

		if (props) {
			this.addProperties(props);
		}
	}

	private callbacks?: Record<"beforePositionChange" | "afterPositionChange", () => void>;

	/**
	 * Subscribes to position change events on this interval if there are no current listeners.
	 * @internal
	 */
	public addPositionChangeListeners(
		beforePositionChange: () => void,
		afterPositionChange: () => void,
	): void {
		if (this.callbacks === undefined) {
			this.callbacks = {
				beforePositionChange,
				afterPositionChange,
			};

			const startCbs = (this.start.callbacks ??= {});
			const endCbs = (this.end.callbacks ??= {});
			startCbs.beforeSlide = endCbs.beforeSlide = beforePositionChange;
			startCbs.afterSlide = endCbs.afterSlide = afterPositionChange;
		}
	}

	/**
	 * Removes the currently subscribed position change listeners.
	 * @internal
	 */
	public removePositionChangeListeners(): void {
		if (this.callbacks) {
			this.callbacks = undefined;
			this.start.callbacks = undefined;
			this.end.callbacks = undefined;
		}
	}

	/**
	 * {@inheritDoc ISerializableInterval.serialize}
	 * @internal
	 */
	public serialize(): ISerializedInterval {
		const startPosition = this.client.localReferencePositionToPosition(this.start);
		const endPosition = this.client.localReferencePositionToPosition(this.end);
		const serializedInterval: ISerializedInterval = {
			end: endPosition,
			intervalType: this.intervalType,
			sequenceNumber: this.client.getCurrentSeq(),
			start: startPosition,
		};

		if (this.properties) {
			serializedInterval.properties = this.properties;
		}
		if (this.stickiness !== IntervalStickiness.END) {
			serializedInterval.stickiness = this.stickiness;
		}

		return serializedInterval;
	}

	/**
	 * {@inheritDoc IInterval.clone}
	 */
	public clone() {
		return new SequenceInterval(
			this.client,
			this.start,
			this.end,
			this.intervalType,
			this.properties,
			this.stickiness,
		);
	}

	/**
	 * {@inheritDoc IInterval.compare}
	 */
	public compare(b: SequenceInterval) {
		const startResult = this.compareStart(b);
		if (startResult === 0) {
			const endResult = this.compareEnd(b);
			if (endResult === 0) {
				const thisId = this.getIntervalId();
				if (thisId) {
					const bId = b.getIntervalId();
					if (bId) {
						return thisId > bId ? 1 : thisId < bId ? -1 : 0;
					}
					return 0;
				}
				return 0;
			} else {
				return endResult;
			}
		} else {
			return startResult;
		}
	}

	/**
	 * {@inheritDoc IInterval.compareStart}
	 */
	public compareStart(b: SequenceInterval) {
		return compareReferencePositions(this.start, b.start);
	}

	/**
	 * {@inheritDoc IInterval.compareEnd}
	 */
	public compareEnd(b: SequenceInterval) {
		return compareReferencePositions(this.end, b.end);
	}

	/**
	 * {@inheritDoc IInterval.overlaps}
	 */
	public overlaps(b: SequenceInterval) {
		const result =
			compareReferencePositions(this.start, b.end) <= 0 &&
			compareReferencePositions(this.end, b.start) >= 0;
		return result;
	}

	/**
	 * {@inheritDoc ISerializableInterval.getIntervalId}
	 */
	public getIntervalId(): string {
		const id = this.properties?.[reservedIntervalIdKey];
		assert(id !== undefined, 0x5e2 /* interval ID should not be undefined */);
		return `${id}`;
	}

	/**
	 * {@inheritDoc IInterval.union}
	 * @deprecated - This API was never intended to be public and will be marked internal in a future release.
	 */
	public union(b: SequenceInterval) {
		return new SequenceInterval(
			this.client,
			minReferencePosition(this.start, b.start),
			maxReferencePosition(this.end, b.end),
			this.intervalType,
		);
	}

	/**
	 * {@inheritDoc ISerializableInterval.addProperties}
	 * @deprecated - This API was never intended to be public and will be marked internal in a future release.
	 */
	public addProperties(
		newProps: PropertySet,
		collab: boolean = false,
		seq?: number,
		op?: ICombiningOp,
	): PropertySet | undefined {
		this.initializeProperties();
		return this.propertyManager.addProperties(this.properties, newProps, op, seq, collab);
	}

	/**
	 * @returns whether this interval overlaps two numerical positions.
	 */
	public overlapsPos(bstart: number, bend: number) {
		const startPos = this.client.localReferencePositionToPosition(this.start);
		const endPos = this.client.localReferencePositionToPosition(this.end);
		return endPos > bstart && startPos < bend;
	}

	/**
	 * {@inheritDoc IInterval.modify}
	 * @deprecated - This API was never intended to be public and will be marked internal in a future release.
	 */
	public modify(
		label: string,
		start: number,
		end: number,
		op?: ISequencedDocumentMessage,
		localSeq?: number,
		stickiness: IntervalStickiness = IntervalStickiness.END,
	) {
		const getRefType = (baseType: ReferenceType): ReferenceType => {
			let refType = baseType;
			if (op === undefined) {
				refType &= ~ReferenceType.SlideOnRemove;
				refType |= ReferenceType.StayOnRemove;
			}
			return refType;
		};

		let startRef = this.start;
		if (start !== undefined) {
			startRef = createPositionReference(
				this.client,
				start,
				getRefType(this.start.refType),
				op,
				undefined,
				localSeq,
				startReferenceSlidingPreference(stickiness),
			);
			if (this.start.properties) {
				startRef.addProperties(this.start.properties);
			}
		}

		let endRef = this.end;
		if (end !== undefined) {
			endRef = createPositionReference(
				this.client,
				end,
				getRefType(this.end.refType),
				op,
				undefined,
				localSeq,
				endReferenceSlidingPreference(stickiness),
			);
			if (this.end.properties) {
				endRef.addProperties(this.end.properties);
			}
		}

		const newInterval = new SequenceInterval(this.client, startRef, endRef, this.intervalType);
		if (this.properties) {
			newInterval.initializeProperties();
			this.propertyManager.copyTo(
				this.properties,
				newInterval.properties,
				newInterval.propertyManager,
			);
		}
		return newInterval;
	}

	private initializeProperties(): void {
		if (!this.propertyManager) {
			this.propertyManager = new PropertiesManager();
		}
		if (!this.properties) {
			this.properties = createMap<any>();
		}
	}
}

export function createPositionReferenceFromSegoff(
	client: Client,
	segoff: { segment: ISegment | undefined; offset: number | undefined },
	refType: ReferenceType,
	op?: ISequencedDocumentMessage,
	localSeq?: number,
	fromSnapshot?: boolean,
	slidingPreference?: SlidingPreference,
): LocalReferencePosition {
	if (segoff.segment) {
		const ref = client.createLocalReferencePosition(
			segoff.segment,
			segoff.offset,
			refType,
			undefined,
			slidingPreference,
		);
		return ref;
	}

	// Creating references on detached segments is allowed for:
	// - Transient segments
	// - References coming from a remote client (location may have been concurrently removed)
	// - References being rebased to a new sequence number
	//   (segment they originally referred to may have been removed with no suitable replacement)
	if (
		!op &&
		!localSeq &&
		!fromSnapshot &&
		!refTypeIncludesFlag(refType, ReferenceType.Transient)
	) {
		throw new UsageError("Non-transient references need segment");
	}

	return createDetachedLocalReferencePosition(refType);
}

function createPositionReference(
	client: Client,
	pos: number,
	refType: ReferenceType,
	op?: ISequencedDocumentMessage,
	fromSnapshot?: boolean,
	localSeq?: number,
	slidingPreference?: SlidingPreference,
): LocalReferencePosition {
	let segoff;
	if (op) {
		assert(
			(refType & ReferenceType.SlideOnRemove) !== 0,
			0x2f5 /* op create references must be SlideOnRemove */,
		);
		segoff = client.getContainingSegment(pos, {
			referenceSequenceNumber: op.referenceSequenceNumber,
			clientId: op.clientId,
		});
		segoff = client.getSlideToSegment(segoff);
	} else {
		assert(
			(refType & ReferenceType.SlideOnRemove) === 0 || !!fromSnapshot,
			0x2f6 /* SlideOnRemove references must be op created */,
		);
		segoff = client.getContainingSegment(pos, undefined, localSeq);
	}

	return createPositionReferenceFromSegoff(
		client,
		segoff,
		refType,
		op,
		localSeq,
		fromSnapshot,
		slidingPreference,
	);
}

export function createSequenceInterval(
	label: string,
	start: number,
	end: number,
	client: Client,
	intervalType: IntervalType,
	op?: ISequencedDocumentMessage,
	fromSnapshot?: boolean,
	stickiness: IntervalStickiness = IntervalStickiness.END,
): SequenceInterval {
	let beginRefType = ReferenceType.RangeBegin;
	let endRefType = ReferenceType.RangeEnd;
	if (intervalType === IntervalType.Transient) {
		beginRefType = ReferenceType.Transient;
		endRefType = ReferenceType.Transient;
	} else {
		if (intervalType === IntervalType.Nest) {
			beginRefType = ReferenceType.NestBegin;
			endRefType = ReferenceType.NestEnd;
		}
		// All non-transient interval references must eventually be SlideOnRemove
		// To ensure eventual consistency, they must start as StayOnRemove when
		// pending (created locally and creation op is not acked)
		if (op || fromSnapshot) {
			beginRefType |= ReferenceType.SlideOnRemove;
			endRefType |= ReferenceType.SlideOnRemove;
		} else {
			beginRefType |= ReferenceType.StayOnRemove;
			endRefType |= ReferenceType.StayOnRemove;
		}
	}

	const startLref = createPositionReference(
		client,
		start,
		beginRefType,
		op,
		fromSnapshot,
		undefined,
		startReferenceSlidingPreference(stickiness),
	);

	const endLref = createPositionReference(
		client,
		end,
		endRefType,
		op,
		fromSnapshot,
		undefined,
		endReferenceSlidingPreference(stickiness),
	);

	const rangeProp = {
		[reservedRangeLabelsKey]: [label],
	};
	startLref.addProperties(rangeProp);
	endLref.addProperties(rangeProp);

	const ival = new SequenceInterval(
		client,
		startLref,
		endLref,
		intervalType,
		rangeProp,
		stickiness,
	);
	return ival;
}

export function createIntervalIndex() {
	const helpers: IIntervalHelpers<Interval> = {
		compareEnds: compareIntervalEnds,
		create: createInterval,
	};
	const lc = new LocalIntervalCollection<Interval>(undefined as any as Client, "", helpers);
	return lc;
}

/**
 * Collection of intervals.
 *
 * Implementers of this interface will typically implement additional APIs to support efficiently querying a collection
 * of intervals in some manner, for example:
 * - "find all intervals with start endpoint between these two points"
 * - "find all intervals which overlap this range"
 * etc.
 */
export interface IntervalIndex<TInterval extends ISerializableInterval> {
	/**
	 * Adds an interval to the index.
	 * @remarks - Application code should never need to invoke this method on their index for production scenarios:
	 * Fluid handles adding and removing intervals from an index in response to sequence or interval changes.
	 */
	add(interval: TInterval): void;

	/**
	 * Removes an interval from the index.
	 * @remarks - Application code should never need to invoke this method on their index for production scenarios:
	 * Fluid handles adding and removing intervals from an index in response to sequence or interval changes.
	 */
	remove(interval: TInterval): void;
}

class IdIntervalIndex<TInterval extends ISerializableInterval>
	implements IntervalIndex<TInterval>, Iterable<TInterval>
{
	private readonly intervalIdMap: Map<string, TInterval> = new Map();

	public add(interval: TInterval) {
		const id = interval.getIntervalId();
		assert(
			id !== undefined,
			0x2c0 /* "ID must be created before adding interval to collection" */,
		);
		// Make the ID immutable.
		Object.defineProperty(interval.properties, reservedIntervalIdKey, {
			configurable: false,
			enumerable: true,
			writable: false,
		});
		this.intervalIdMap.set(id, interval);
	}

	public remove(interval: TInterval) {
		const id = interval.getIntervalId();
		assert(id !== undefined, 0x311 /* expected id to exist on interval */);
		this.intervalIdMap.delete(id);
	}

	public getIntervalById(id: string) {
		return this.intervalIdMap.get(id);
	}

	public [Symbol.iterator]() {
		return this.intervalIdMap.values();
	}
}

class EndpointIndex<TInterval extends ISerializableInterval> implements IntervalIndex<TInterval> {
	private readonly endIntervalTree: RedBlackTree<TInterval, TInterval>;

	constructor(
		private readonly client: Client,
		private readonly helpers: IIntervalHelpers<TInterval>,
	) {
		// eslint-disable-next-line @typescript-eslint/unbound-method
		this.endIntervalTree = new RedBlackTree<TInterval, TInterval>(helpers.compareEnds);
	}

	public previousInterval(pos: number) {
		const transientInterval = this.helpers.create(
			"transient",
			pos,
			pos,
			this.client,
			IntervalType.Transient,
		);
		const rbNode = this.endIntervalTree.floor(transientInterval);
		if (rbNode) {
			return rbNode.data;
		}
	}

	public nextInterval(pos: number) {
		const transientInterval = this.helpers.create(
			"transient",
			pos,
			pos,
			this.client,
			IntervalType.Transient,
		);
		const rbNode = this.endIntervalTree.ceil(transientInterval);
		if (rbNode) {
			return rbNode.data;
		}
	}

	public add(interval: TInterval): void {
		this.endIntervalTree.put(interval, interval);
	}

	public remove(interval: TInterval): void {
		this.endIntervalTree.remove(interval);
	}
}

/**
 * Collection of intervals.
 *
 * Provide additional APIs to support efficiently querying a collection of intervals whose endpoints fall within a specified range.
 */
export interface IEndpointInRangeIndex<TInterval extends ISerializableInterval>
	extends IntervalIndex<TInterval> {
	/**
	 * @returns an array of all intervals contained in this collection whose endpoints locate in the range [start, end] (includes both ends)
	 */
	findIntervalsWithEndpointInRange(start: number, end: number);
}

/**
 * Collection of intervals.
 *
 * Provide additional APIs to support efficiently querying a collection of intervals whose startpoints fall within a specified range.
 */
export interface IStartpointInRangeIndex<TInterval extends ISerializableInterval>
	extends IntervalIndex<TInterval> {
	/**
	 * @returns an array of all intervals contained in this collection whose startpoints locate in the range [start, end] (includes both ends)
	 */
	findIntervalsWithStartpointInRange(start: number, end: number);
}

/**
 * Interface for intervals that have comparison override properties.
 */
const forceCompare = Symbol();

interface HasComparisonOverride {
	[forceCompare]: number;
}

/**
 * Compares two objects based on their comparison override properties.
 * @returns A number indicating the order of the intervals (negative for a is lower than b, 0 for tie, positive for a is greater than b).
 */
function compareOverrideables(
	a: Partial<HasComparisonOverride>,
	b: Partial<HasComparisonOverride>,
): number {
	const forceCompareA = a[forceCompare] ?? 0;
	const forceCompareB = b[forceCompare] ?? 0;

	return forceCompareA - forceCompareB;
}

class EndpointInRangeIndex<TInterval extends ISerializableInterval>
	implements IEndpointInRangeIndex<TInterval>
{
	private readonly intervalTree;

	constructor(
		private readonly helpers: IIntervalHelpers<TInterval>,
		private readonly client: Client,
	) {
		this.intervalTree = new RedBlackTree<TInterval, TInterval>((a: TInterval, b: TInterval) => {
			const compareEndsResult = helpers.compareEnds(a, b);
			if (compareEndsResult !== 0) {
				return compareEndsResult;
			}

			const overrideablesComparison = compareOverrideables(
				a as Partial<HasComparisonOverride>,
				b as Partial<HasComparisonOverride>,
			);
			if (overrideablesComparison !== 0) {
				return overrideablesComparison;
			}

			const aId = a.getIntervalId();
			const bId = b.getIntervalId();
			if (aId !== undefined && bId !== undefined) {
				return aId.localeCompare(bId);
			}
			return 0;
		});
	}

	public add(interval: TInterval): void {
		this.intervalTree.put(interval, interval);
	}

	public remove(interval: TInterval): void {
		this.intervalTree.remove(interval);
	}

	public findIntervalsWithEndpointInRange(start: number, end: number) {
		if (start <= 0 || start > end || this.intervalTree.isEmpty()) {
			return [];
		}
		const results: TInterval[] = [];
		const action: PropertyAction<TInterval, TInterval> = (node) => {
			results.push(node.data);
			return true;
		};

		const transientStartInterval = this.helpers.create(
			"transient",
			start,
			start,
			this.client,
			IntervalType.Transient,
		);

		const transientEndInterval = this.helpers.create(
			"transient",
			end,
			end,
			this.client,
			IntervalType.Transient,
		);

		// Add comparison overrides to the transient intervals
		(transientStartInterval as Partial<HasComparisonOverride>)[forceCompare] = -1;
		(transientEndInterval as Partial<HasComparisonOverride>)[forceCompare] = 1;

		this.intervalTree.mapRange(action, results, transientStartInterval, transientEndInterval);
		return results;
	}
}

class StartpointInRangeIndex<TInterval extends ISerializableInterval>
	implements IStartpointInRangeIndex<TInterval>
{
	private readonly intervalTree;

	constructor(
		private readonly helpers: IIntervalHelpers<TInterval>,
		private readonly client: Client,
	) {
		this.intervalTree = new RedBlackTree<TInterval, TInterval>((a: TInterval, b: TInterval) => {
			assert(
				typeof helpers.compareStarts === "function",
				0x6d1 /* compareStarts does not exist in the helpers */,
			);

			const compareStartsResult = helpers.compareStarts(a, b);
			if (compareStartsResult !== 0) {
				return compareStartsResult;
			}

			const overrideablesComparison = compareOverrideables(
				a as Partial<HasComparisonOverride>,
				b as Partial<HasComparisonOverride>,
			);
			if (overrideablesComparison !== 0) {
				return overrideablesComparison;
			}
			const aId = a.getIntervalId();
			const bId = b.getIntervalId();
			if (aId !== undefined && bId !== undefined) {
				return aId.localeCompare(bId);
			}
			return 0;
		});
	}

	public add(interval: TInterval): void {
		this.intervalTree.put(interval, interval);
	}

	public remove(interval: TInterval): void {
		this.intervalTree.remove(interval);
	}

	public findIntervalsWithStartpointInRange(start: number, end: number) {
		if (start <= 0 || start > end || this.intervalTree.isEmpty()) {
			return [];
		}
		const results: TInterval[] = [];
		const action: PropertyAction<TInterval, TInterval> = (node) => {
			results.push(node.data);
			return true;
		};

		const transientStartInterval = this.helpers.create(
			"transient",
			start,
			start,
			this.client,
			IntervalType.Transient,
		);

		const transientEndInterval = this.helpers.create(
			"transient",
			end,
			end,
			this.client,
			IntervalType.Transient,
		);

		// Add comparison overrides to the transient intervals
		(transientStartInterval as Partial<HasComparisonOverride>)[forceCompare] = -1;
		(transientEndInterval as Partial<HasComparisonOverride>)[forceCompare] = 1;

		this.intervalTree.mapRange(action, results, transientStartInterval, transientEndInterval);
		return results;
	}
}

export function createEndpointInRangeIndex<TInterval extends ISerializableInterval>(
	helpers: IIntervalHelpers<TInterval>,
	client: Client,
): IEndpointInRangeIndex<TInterval> {
	return new EndpointInRangeIndex<TInterval>(helpers, client);
}

export function createStartpointInRangeIndex<TInterval extends ISerializableInterval>(
	helpers: IIntervalHelpers<TInterval>,
	client: Client,
): IStartpointInRangeIndex<TInterval> {
	return new StartpointInRangeIndex<TInterval>(helpers, client);
}

export class LocalIntervalCollection<TInterval extends ISerializableInterval> {
	private static readonly legacyIdPrefix = "legacy";
	public readonly overlappingIntervalsIndex: IOverlappingIntervalsIndex<TInterval>;
	public readonly idIntervalIndex: IdIntervalIndex<TInterval>;
	public readonly endIntervalIndex: EndpointIndex<TInterval>;
	private readonly indexes: Set<IntervalIndex<TInterval>>;

	constructor(
		private readonly client: Client,
		private readonly label: string,
		private readonly helpers: IIntervalHelpers<TInterval>,
		/** Callback invoked each time one of the endpoints of an interval slides. */
		private readonly onPositionChange?: (
			interval: TInterval,
			previousInterval: TInterval,
		) => void,
	) {
		this.overlappingIntervalsIndex = createOverlappingIntervalsIndex(client, helpers);
		this.idIntervalIndex = new IdIntervalIndex();
		this.endIntervalIndex = new EndpointIndex(client, helpers);
		this.indexes = new Set([
			this.overlappingIntervalsIndex,
			this.idIntervalIndex,
			this.endIntervalIndex,
		]);
	}

	public createLegacyId(start: number, end: number): string {
		// Create a non-unique ID based on start and end to be used on intervals that come from legacy clients
		// without ID's.
		return `${LocalIntervalCollection.legacyIdPrefix}${start}-${end}`;
	}

	/**
	 * Validates that a serialized interval has the ID property. Creates an ID
	 * if one does not already exist
	 *
	 * @param serializedInterval - The interval to be checked
	 * @returns The interval's existing or newly created id
	 */
	public ensureSerializedId(serializedInterval: ISerializedInterval): string {
		let id: string | undefined = serializedInterval.properties?.[reservedIntervalIdKey];
		if (id === undefined) {
			// Back-compat: 0.39 and earlier did not have IDs on intervals. If an interval from such a client
			// comes over the wire, create a non-unique one based on start/end.
			// This will allow all clients to refer to this interval consistently.
			id = this.createLegacyId(serializedInterval.start, serializedInterval.end);
			const newProps = {
				[reservedIntervalIdKey]: id,
			};
			serializedInterval.properties = addProperties(serializedInterval.properties, newProps);
		}
		// Make the ID immutable for safety's sake.
		Object.defineProperty(serializedInterval.properties, reservedIntervalIdKey, {
			configurable: false,
			enumerable: true,
			writable: false,
		});

		return id;
	}

	private removeIntervalFromIndexes(interval: TInterval) {
		for (const index of this.indexes) {
			index.remove(interval);
		}
	}

	public appendIndex(index: IntervalIndex<TInterval>) {
		this.indexes.add(index);
	}

	public removeIndex(index: IntervalIndex<TInterval>): boolean {
		return this.indexes.delete(index);
	}

	public removeExistingInterval(interval: TInterval) {
		this.removeIntervalFromIndexes(interval);
		this.removeIntervalListeners(interval);
	}

	public createInterval(
		start: number,
		end: number,
		intervalType: IntervalType,
		op?: ISequencedDocumentMessage,
		stickiness: IntervalStickiness = IntervalStickiness.END,
	): TInterval {
		return this.helpers.create(
			this.label,
			start,
			end,
			this.client,
			intervalType,
			op,
			undefined,
			stickiness,
		);
	}

	public addInterval(
		start: number,
		end: number,
		intervalType: IntervalType,
		props?: PropertySet,
		op?: ISequencedDocumentMessage,
		stickiness: IntervalStickiness = IntervalStickiness.END,
	) {
		const interval: TInterval = this.createInterval(start, end, intervalType, op, stickiness);
		if (interval) {
			if (!interval.properties) {
				interval.properties = createMap<any>();
			}

			if (props) {
				// This check is intended to prevent scenarios where a random interval is created and then
				// inserted into a collection. The aim is to ensure that the collection is created first
				// then the user can create/add intervals based on the collection
				if (
					props[reservedRangeLabelsKey] !== undefined &&
					props[reservedRangeLabelsKey][0] !== this.label
				) {
					throw new LoggingError(
						"Adding an interval that belongs to another interval collection is not permitted",
					);
				}
				interval.addProperties(props);
			}
			interval.properties[reservedIntervalIdKey] ??= uuid();
			this.add(interval);
		}
		return interval;
	}

	private linkEndpointsToInterval(interval: TInterval): void {
		if (interval instanceof SequenceInterval) {
			interval.start.addProperties({ interval });
			interval.end.addProperties({ interval });
		}
	}

	private addIntervalToIndexes(interval: TInterval) {
		for (const index of this.indexes) {
			index.add(interval);
		}
	}

	public add(interval: TInterval): void {
		this.linkEndpointsToInterval(interval);
		this.addIntervalToIndexes(interval);
		this.addIntervalListeners(interval);
	}

	public changeInterval(
		interval: TInterval,
		start: number | undefined,
		end: number | undefined,
		op?: ISequencedDocumentMessage,
		localSeq?: number,
	) {
		const newInterval = interval.modify(this.label, start, end, op, localSeq) as
			| TInterval
			| undefined;
		if (newInterval) {
			this.removeExistingInterval(interval);
			this.add(newInterval);
		}
		return newInterval;
	}

	public serialize(): ISerializedIntervalCollectionV2 {
		return {
			label: this.label,
			intervals: Array.from(this.idIntervalIndex, (interval) =>
				compressInterval(interval.serialize()),
			),
			version: 2,
		};
	}

	private addIntervalListeners(interval: TInterval) {
		const cloneRef = (ref: LocalReferencePosition) => {
			const segment = ref.getSegment();
			if (segment === undefined) {
				// Cloning is unnecessary: refs which have slid off the string entirely
				// never get slid back on. Creation code for refs doesn't accept undefined segment
				// either, so this must be special-cased.
				return ref;
			}

			return this.client.createLocalReferencePosition(
				segment,
				ref.getOffset(),
				ReferenceType.Transient,
				ref.properties,
				ref.slidingPreference,
			);
		};
		if (interval instanceof SequenceInterval) {
			let previousInterval: (TInterval & SequenceInterval) | undefined;
			let pendingChanges = 0;
			interval.addPositionChangeListeners(
				() => {
					pendingChanges++;
					// Note: both start and end can change and invoke beforeSlide on each endpoint before afterSlide.
					if (!previousInterval) {
						previousInterval = interval.clone() as TInterval & SequenceInterval;
						previousInterval.start = cloneRef(previousInterval.start);
						previousInterval.end = cloneRef(previousInterval.end);
						this.removeIntervalFromIndexes(interval);
					}
				},
				() => {
					assert(
						previousInterval !== undefined,
						0x3fa /* Invalid interleaving of before/after slide */,
					);
					pendingChanges--;
					if (pendingChanges === 0) {
						this.addIntervalToIndexes(interval);
						this.onPositionChange?.(interval, previousInterval);
						previousInterval = undefined;
					}
				},
			);
		}
	}

	private removeIntervalListeners(interval: TInterval) {
		if (interval instanceof SequenceInterval) {
			interval.removePositionChangeListeners();
		}
	}
}

export const compareSequenceIntervalEnds = (a: SequenceInterval, b: SequenceInterval): number =>
	compareReferencePositions(a.end, b.end);

export const compareSequenceIntervalStarts = (a: SequenceInterval, b: SequenceInterval): number =>
	compareReferencePositions(a.start, b.start);

export const sequenceIntervalHelpers: IIntervalHelpers<SequenceInterval> = {
	compareEnds: compareSequenceIntervalEnds,
	compareStarts: compareSequenceIntervalStarts,
	create: createSequenceInterval,
};

export const intervalHelpers: IIntervalHelpers<Interval> = {
	compareEnds: (a: Interval, b: Interval) => a.end - b.end,
	compareStarts: (a: Interval, b: Interval) => a.start - b.start,
	create: createInterval,
};

class SequenceIntervalCollectionFactory
	implements IValueFactory<IntervalCollection<SequenceInterval>>
{
	public load(
		emitter: IValueOpEmitter,
		raw: ISerializedInterval[] | ISerializedIntervalCollectionV2 = [],
		options?: Partial<SequenceOptions>,
	): IntervalCollection<SequenceInterval> {
		return new IntervalCollection<SequenceInterval>(
			sequenceIntervalHelpers,
			true,
			emitter,
			raw,
			options,
		);
	}

	public store(
		value: IntervalCollection<SequenceInterval>,
	): ISerializedInterval[] | ISerializedIntervalCollectionV2 {
		return value.serializeInternal();
	}
}

export class SequenceIntervalCollectionValueType
	implements IValueType<IntervalCollection<SequenceInterval>>
{
	public static Name = "sharedStringIntervalCollection";

	public get name(): string {
		return SequenceIntervalCollectionValueType.Name;
	}

	public get factory(): IValueFactory<IntervalCollection<SequenceInterval>> {
		return SequenceIntervalCollectionValueType._factory;
	}

	public get ops(): Map<string, IValueOperation<IntervalCollection<SequenceInterval>>> {
		return SequenceIntervalCollectionValueType._ops;
	}

	private static readonly _factory: IValueFactory<IntervalCollection<SequenceInterval>> =
		new SequenceIntervalCollectionFactory();

	private static readonly _ops = makeOpsMap<SequenceInterval>();
}

const compareIntervalEnds = (a: Interval, b: Interval) => a.end - b.end;

function createInterval(
	label: string,
	start: number,
	end: number,
	client: Client,
	intervalType?: IntervalType,
	op?: ISequencedDocumentMessage,
	fromSnapshot?: boolean,
): Interval {
	const rangeProp: PropertySet = {};

	if (label && label.length > 0) {
		rangeProp[reservedRangeLabelsKey] = [label];
	}

	return new Interval(start, end, rangeProp);
}

class IntervalCollectionFactory implements IValueFactory<IntervalCollection<Interval>> {
	public load(
		emitter: IValueOpEmitter,
		raw: ISerializedInterval[] | ISerializedIntervalCollectionV2 = [],
		options?: Partial<SequenceOptions>,
	): IntervalCollection<Interval> {
		const helpers: IIntervalHelpers<Interval> = {
			compareEnds: compareIntervalEnds,
			create: createInterval,
		};
		const collection = new IntervalCollection<Interval>(helpers, false, emitter, raw, options);
		collection.attachGraph(undefined as any as Client, "");
		return collection;
	}

	public store(value: IntervalCollection<Interval>): ISerializedIntervalCollectionV2 {
		return value.serializeInternal();
	}
}

export class IntervalCollectionValueType implements IValueType<IntervalCollection<Interval>> {
	public static Name = "sharedIntervalCollection";

	public get name(): string {
		return IntervalCollectionValueType.Name;
	}

	public get factory(): IValueFactory<IntervalCollection<Interval>> {
		return IntervalCollectionValueType._factory;
	}

	public get ops(): Map<string, IValueOperation<IntervalCollection<Interval>>> {
		return IntervalCollectionValueType._ops;
	}

	private static readonly _factory: IValueFactory<IntervalCollection<Interval>> =
		new IntervalCollectionFactory();
	private static readonly _ops = makeOpsMap<Interval>();
}

export function makeOpsMap<T extends ISerializableInterval>(): Map<
	string,
	IValueOperation<IntervalCollection<T>>
> {
	const rebase = (
		collection: IntervalCollection<T>,
		op: IValueTypeOperationValue,
		localOpMetadata: IMapMessageLocalMetadata,
	) => {
		const { localSeq } = localOpMetadata;
		const rebasedValue = collection.rebaseLocalInterval(op.opName, op.value, localSeq);
		const rebasedOp = { ...op, value: rebasedValue };
		return { rebasedOp, rebasedLocalOpMetadata: localOpMetadata };
	};

	return new Map<string, IValueOperation<IntervalCollection<T>>>([
		[
			IntervalOpType.ADD,
			{
				process: (collection, params, local, op, localOpMetadata) => {
					// if params is undefined, the interval was deleted during
					// rebasing
					if (!params) {
						return;
					}
					assert(op !== undefined, 0x3fb /* op should exist here */);
					collection.ackAdd(params, local, op, localOpMetadata);
				},
				rebase,
			},
		],
		[
			IntervalOpType.DELETE,
			{
				process: (collection, params, local, op) => {
					assert(op !== undefined, 0x3fc /* op should exist here */);
					collection.ackDelete(params, local, op);
				},
				rebase: (collection, op, localOpMetadata) => {
					// Deletion of intervals is based on id, so requires no rebasing.
					return { rebasedOp: op, rebasedLocalOpMetadata: localOpMetadata };
				},
			},
		],
		[
			IntervalOpType.CHANGE,
			{
				process: (collection, params, local, op, localOpMetadata) => {
					// if params is undefined, the interval was deleted during
					// rebasing
					if (!params) {
						return;
					}
					assert(op !== undefined, 0x3fd /* op should exist here */);
					collection.ackChange(params, local, op, localOpMetadata);
				},
				rebase,
			},
		],
	]);
}

export type DeserializeCallback = (properties: PropertySet) => void;

class IntervalCollectionIterator<TInterval extends ISerializableInterval>
	implements Iterator<TInterval>
{
	private readonly results: TInterval[];
	private index: number;

	constructor(
		collection: IntervalCollection<TInterval>,
		iteratesForward: boolean = true,
		start?: number,
		end?: number,
	) {
		this.results = [];
		this.index = 0;

		collection.gatherIterationResults(this.results, iteratesForward, start, end);
	}

	public next(): IteratorResult<TInterval> {
		if (this.index < this.results.length) {
			return {
				value: this.results[this.index++],
				done: false,
			};
		}

		return {
			value: undefined,
			done: true,
		};
	}
}

/**
 * Change events emitted by `IntervalCollection`s
 */
export interface IIntervalCollectionEvent<TInterval extends ISerializableInterval> extends IEvent {
	/**
	 * This event is invoked whenever the endpoints of an interval may have changed.
	 * This can happen on:
	 * - local endpoint modification
	 * - ack of a remote endpoint modification
	 * - position change due to segment sliding (slides due to mergeTree segment deletion will always appear local)
	 * The `interval` argument reflects the new values.
	 * `previousInterval` contains transient `ReferencePosition`s at the same location as the interval's original
	 * endpoints. These references should be used for position information only.
	 * `local` reflects whether the change originated locally.
	 * `op` is defined if and only if the server has acked this change.
	 * `slide` is true if the change is due to sliding on removal of position
	 */
	(
		event: "changeInterval",
		listener: (
			interval: TInterval,
			previousInterval: TInterval,
			local: boolean,
			op: ISequencedDocumentMessage | undefined,
			slide: boolean,
		) => void,
	);
	/**
	 * This event is invoked whenever an interval is added or removed from the collection.
	 * `local` reflects whether the change originated locally.
	 * `op` is defined if and only if the server has acked this change.
	 */
	(
		event: "addInterval" | "deleteInterval",
		listener: (
			interval: TInterval,
			local: boolean,
			op: ISequencedDocumentMessage | undefined,
		) => void,
	);
	/**
	 * This event is invoked whenever an interval's properties have changed.
	 * `interval` reflects the state of the updated properties.
	 * `propertyDeltas` is a map-like whose keys contain all values that were changed, and whose
	 * values contain all previous values of the property set.
	 * This object can be used directly in a call to `changeProperties` to revert the property change if desired.
	 * `local` reflects whether the change originated locally.
	 * `op` is defined if and only if the server has acked this change.
	 */
	(
		event: "propertyChanged",
		listener: (
			interval: TInterval,
			propertyDeltas: PropertySet,
			local: boolean,
			op: ISequencedDocumentMessage | undefined,
		) => void,
	);
}

/**
 * Collection of intervals that supports addition, modification, removal, and efficient spatial querying.
 * Changes to this collection will be incur updates on collaborating clients (i.e. they are not local-only).
 */
export interface IIntervalCollection<TInterval extends ISerializableInterval>
	extends TypedEventEmitter<IIntervalCollectionEvent<TInterval>> {
	readonly attached: boolean;
	/**
	 * Attaches an index to this collection.
	 * All intervals which are part of this collection will be added to the index, and the index will automatically
	 * be updated when this collection updates due to local or remote changes.
	 *
	 * @remarks - After attaching an index to an interval collection, applications should typically store this
	 * index somewhere in their in-memory data model for future reference and querying.
	 */
	attachIndex(index: IntervalIndex<TInterval>): void;
	/**
	 * Detaches an index from this collection.
	 * All intervals which are part of this collection will be removed from the index, and updates to this collection
	 * due to local or remote changes will no longer incur updates to the index.
	 *
	 * @returns - Return false if the target index cannot be found in the indexes, otherwise remove all intervals in the index and return true
	 */
	detachIndex(index: IntervalIndex<TInterval>): boolean;
	/**
	 * @returns the interval in this collection that has the provided `id`.
	 * If no interval in the collection has this `id`, returns `undefined`.
	 */
	getIntervalById(id: string): TInterval | undefined;
	/**
	 * Creates a new interval and add it to the collection.
	 * @param start - interval start position (inclusive)
	 * @param end - interval end position (exclusive)
	 * @param intervalType - type of the interval. All intervals are SlideOnRemove. Intervals may not be Transient.
	 * @param props - properties of the interval
	 * @param stickiness - {@link (IntervalStickiness:type)} to apply to the added interval.
	 * @returns - the created interval
	 * @remarks - See documentation on {@link SequenceInterval} for comments on interval endpoint semantics: there are subtleties
	 * with how the current half-open behavior is represented.
	 */
	add(
		start: number,
		end: number,
		intervalType: IntervalType,
		props?: PropertySet,
		stickiness?: IntervalStickiness,
	): TInterval;
	/**
	 * Removes an interval from the collection.
	 * @param id - Id of the interval to remove
	 * @returns the removed interval
	 */
	removeIntervalById(id: string): TInterval | undefined;
	/**
	 * Changes the properties on an existing interval.
	 * @param id - Id of the interval whose properties should be changed
	 * @param props - Property set to apply to the interval. Shallow merging is used between any existing properties
	 * and `prop`, i.e. the interval will end up with a property object equivalent to `{ ...oldProps, ...props }`.
	 */
	changeProperties(id: string, props: PropertySet);
	/**
	 * Changes the endpoints of an existing interval.
	 * @param id - Id of the interval to change
	 * @param start - New start value, if defined. `undefined` signifies this endpoint should be left unchanged.
	 * @param end - New end value, if defined. `undefined` signifies this endpoint should be left unchanged.
	 * @returns the interval that was changed, if it existed in the collection.
	 */
	change(id: string, start?: number, end?: number): TInterval | undefined;

	attachDeserializer(onDeserialize: DeserializeCallback): void;
	/**
	 * @returns an iterator over all intervals in this collection.
	 */
	[Symbol.iterator](): Iterator<TInterval>;

	/**
	 * @returns a forward iterator over all intervals in this collection with start point equal to `startPosition`.
	 */
	CreateForwardIteratorWithStartPosition(startPosition: number): Iterator<TInterval>;

	/**
	 * @returns a backward iterator over all intervals in this collection with start point equal to `startPosition`.
	 */
	CreateBackwardIteratorWithStartPosition(startPosition: number): Iterator<TInterval>;

	/**
	 * @returns a forward iterator over all intervals in this collection with end point equal to `endPosition`.
	 */
	CreateForwardIteratorWithEndPosition(endPosition: number): Iterator<TInterval>;

	/**
	 * @returns a backward iterator over all intervals in this collection with end point equal to `endPosition`.
	 */
	CreateBackwardIteratorWithEndPosition(endPosition: number): Iterator<TInterval>;

	/**
	 * Gathers iteration results that optionally match a start/end criteria into the provided array.
	 * @param results - Array to gather the results into. In lieu of a return value, this array will be populated with
	 * intervals matching the query upon edit.
	 * @param iteratesForward - whether or not iteration should be in the forward direction
	 * @param start - If provided, only match intervals whose start point is equal to `start`.
	 * @param end - If provided, only match intervals whose end point is equal to `end`.
	 */
	gatherIterationResults(
		results: TInterval[],
		iteratesForward: boolean,
		start?: number,
		end?: number,
	): void;

	/**
	 * @returns an array of all intervals in this collection that overlap with the interval
	 * `[startPosition, endPosition]`.
	 */
	findOverlappingIntervals(startPosition: number, endPosition: number): TInterval[];

	/**
	 * Applies a function to each interval in this collection.
	 */
	map(fn: (interval: TInterval) => void): void;

	previousInterval(pos: number): TInterval | undefined;

	nextInterval(pos: number): TInterval | undefined;
}

/**
 * {@inheritdoc IIntervalCollection}
 */
export class IntervalCollection<TInterval extends ISerializableInterval>
	extends TypedEventEmitter<IIntervalCollectionEvent<TInterval>>
	implements IIntervalCollection<TInterval>
{
	private savedSerializedIntervals?: ISerializedInterval[];
	private localCollection: LocalIntervalCollection<TInterval> | undefined;
	private onDeserialize: DeserializeCallback | undefined;
	private client: Client | undefined;
	private readonly localSeqToSerializedInterval = new Map<
		number,
		ISerializedInterval | SerializedIntervalDelta
	>();
	private readonly localSeqToRebasedInterval = new Map<
		number,
		ISerializedInterval | SerializedIntervalDelta
	>();
	private readonly pendingChangesStart: Map<string, ISerializedInterval[]> = new Map<
		string,
		ISerializedInterval[]
	>();
	private readonly pendingChangesEnd: Map<string, ISerializedInterval[]> = new Map<
		string,
		ISerializedInterval[]
	>();

	public get attached(): boolean {
		return !!this.localCollection;
	}

	/** @internal */
	constructor(
		private readonly helpers: IIntervalHelpers<TInterval>,
		private readonly requiresClient: boolean,
		private readonly emitter: IValueOpEmitter,
		serializedIntervals: ISerializedInterval[] | ISerializedIntervalCollectionV2,
		private readonly options: Partial<SequenceOptions> = {},
	) {
		super();

		this.savedSerializedIntervals = Array.isArray(serializedIntervals)
			? serializedIntervals
			: serializedIntervals.intervals.map((i) =>
					decompressInterval(i, serializedIntervals.label),
			  );
	}

	/**
	 * {@inheritdoc IIntervalCollection.attachIndex}
	 */
	public attachIndex(index: IntervalIndex<TInterval>): void {
		if (!this.attached) {
			throw new LoggingError("The local interval collection must exist");
		}
		for (const interval of this) {
			index.add(interval);
		}

		this.localCollection?.appendIndex(index);
	}

	/**
	 * {@inheritdoc IIntervalCollection.detachIndex}
	 */
	public detachIndex(index: IntervalIndex<TInterval>): boolean {
		if (!this.attached) {
			throw new LoggingError("The local interval collection must exist");
		}

		// Avoid removing intervals if the index does not exist
		if (!this.localCollection?.removeIndex(index)) {
			return false;
		}

		for (const interval of this) {
			index.remove(interval);
		}

		return true;
	}

	private rebasePositionWithSegmentSlide(
		pos: number,
		seqNumberFrom: number,
		localSeq: number,
	): number | undefined {
		if (!this.client) {
			throw new LoggingError("mergeTree client must exist");
		}
		const { clientId } = this.client.getCollabWindow();
		const { segment, offset } = this.client.getContainingSegment(
			pos,
			{
				referenceSequenceNumber: seqNumberFrom,
				clientId: this.client.getLongClientId(clientId),
			},
			localSeq,
		);

		// if segment is undefined, it slid off the string
		assert(segment !== undefined, 0x54e /* No segment found */);

		const segoff = this.client.getSlideToSegment({ segment, offset }) ?? segment;

		// case happens when rebasing op, but concurrently entire string has been deleted
		if (segoff.segment === undefined || segoff.offset === undefined) {
			return DetachedReferencePosition;
		}

		assert(
			offset !== undefined && 0 <= offset && offset < segment.cachedLength,
			0x54f /* Invalid offset */,
		);
		return this.client.findReconnectionPosition(segoff.segment, localSeq) + segoff.offset;
	}

	private computeRebasedPositions(
		localSeq: number,
	): ISerializedInterval | SerializedIntervalDelta {
		assert(
			this.client !== undefined,
			0x550 /* Client should be defined when computing rebased position */,
		);
		const original = this.localSeqToSerializedInterval.get(localSeq);
		assert(
			original !== undefined,
			0x551 /* Failed to store pending serialized interval info for this localSeq. */,
		);
		const rebased = { ...original };
		const { start, end, sequenceNumber } = original;
		if (start !== undefined) {
			rebased.start = this.rebasePositionWithSegmentSlide(start, sequenceNumber, localSeq);
		}
		if (end !== undefined) {
			rebased.end = this.rebasePositionWithSegmentSlide(end, sequenceNumber, localSeq);
		}
		return rebased;
	}

	/** @internal */
	public attachGraph(client: Client, label: string) {
		if (this.attached) {
			throw new LoggingError("Only supports one Sequence attach");
		}

		if (client === undefined && this.requiresClient) {
			throw new LoggingError("Client required for this collection");
		}

		// Instantiate the local interval collection based on the saved intervals
		this.client = client;
		if (client) {
			client.on("normalize", () => {
				for (const localSeq of this.localSeqToSerializedInterval.keys()) {
					this.localSeqToRebasedInterval.set(
						localSeq,
						this.computeRebasedPositions(localSeq),
					);
				}
			});
		}

		this.localCollection = new LocalIntervalCollection<TInterval>(
			client,
			label,
			this.helpers,
			(interval, previousInterval) => this.emitChange(interval, previousInterval, true, true),
		);
		if (this.savedSerializedIntervals) {
			for (const serializedInterval of this.savedSerializedIntervals) {
				this.localCollection.ensureSerializedId(serializedInterval);
				const { start, end, intervalType, properties, stickiness } = serializedInterval;
				const interval = this.helpers.create(
					label,
					start,
					end,
					client,
					intervalType,
					undefined,
					true,
					stickiness,
				);
				if (properties) {
					interval.addProperties(properties);
				}
				this.localCollection.add(interval);
			}
		}
		this.savedSerializedIntervals = undefined;
	}

	/**
	 * Gets the next local sequence number, modifying this client's collab window in doing so.
	 */
	private getNextLocalSeq(): number {
		if (this.client) {
			return ++this.client.getCollabWindow().localSeq;
		}

		return 0;
	}

	private emitChange(
		interval: TInterval,
		previousInterval: TInterval,
		local: boolean,
		slide: boolean,
		op?: ISequencedDocumentMessage,
	): void {
		// Temporarily make references transient so that positional queries work (non-transient refs
		// on resolve to DetachedPosition on any segments that don't contain them). The original refType
		// is restored as single-endpoint changes re-use previous references.
		let startRefType: ReferenceType;
		let endRefType: ReferenceType;
		if (previousInterval instanceof SequenceInterval) {
			startRefType = previousInterval.start.refType;
			endRefType = previousInterval.end.refType;
			previousInterval.start.refType = ReferenceType.Transient;
			previousInterval.end.refType = ReferenceType.Transient;
			this.emit("changeInterval", interval, previousInterval, local, op, slide);
			previousInterval.start.refType = startRefType;
			previousInterval.end.refType = endRefType;
		} else {
			this.emit("changeInterval", interval, previousInterval, local, op, slide);
		}
	}

	/**
	 * {@inheritdoc IIntervalCollection.getIntervalById}
	 */
	public getIntervalById(id: string) {
		if (!this.localCollection) {
			throw new LoggingError("attach must be called before accessing intervals");
		}
		return this.localCollection.idIntervalIndex.getIntervalById(id);
	}

	/**
	 * {@inheritdoc IIntervalCollection.add}
	 */
	public add(
		start: number,
		end: number,
		intervalType: IntervalType,
		props?: PropertySet,
		stickiness: IntervalStickiness = IntervalStickiness.END,
	): TInterval {
		if (!this.localCollection) {
			throw new LoggingError("attach must be called prior to adding intervals");
		}
		if (intervalType & IntervalType.Transient) {
			throw new LoggingError("Can not add transient intervals");
		}
		if (stickiness !== IntervalStickiness.END && !this.options.intervalStickinessEnabled) {
			throw new UsageError(
				"attempted to set interval stickiness without enabling `intervalStickinessEnabled` feature flag",
			);
		}

		const interval: TInterval = this.localCollection.addInterval(
			start,
			end,
			intervalType,
			props,
			undefined,
			stickiness,
		);

		if (interval) {
			const serializedInterval = {
				end,
				intervalType,
				properties: interval.properties,
				sequenceNumber: this.client?.getCurrentSeq() ?? 0,
				start,
				stickiness,
			};
			const localSeq = this.getNextLocalSeq();
			this.localSeqToSerializedInterval.set(localSeq, serializedInterval);
			// Local ops get submitted to the server. Remote ops have the deserializer run.
			this.emitter.emit("add", undefined, serializedInterval, { localSeq });
		}

		this.emit("addInterval", interval, true, undefined);

		return interval;
	}

	private deleteExistingInterval(
		interval: TInterval,
		local: boolean,
		op?: ISequencedDocumentMessage,
	) {
		if (!this.localCollection) {
			throw new LoggingError("Attach must be called before accessing intervals");
		}
		// The given interval is known to exist in the collection.
		this.localCollection.removeExistingInterval(interval);

		if (interval) {
			// Local ops get submitted to the server. Remote ops have the deserializer run.
			if (local) {
				this.emitter.emit("delete", undefined, interval.serialize(), {
					localSeq: this.getNextLocalSeq(),
				});
			} else {
				if (this.onDeserialize) {
					this.onDeserialize(interval);
				}
			}
		}

		this.emit("deleteInterval", interval, local, op);
	}

	/**
	 * {@inheritdoc IIntervalCollection.removeIntervalById}
	 */
	public removeIntervalById(id: string) {
		if (!this.localCollection) {
			throw new LoggingError("Attach must be called before accessing intervals");
		}
		const interval = this.localCollection.idIntervalIndex.getIntervalById(id);
		if (interval) {
			this.deleteExistingInterval(interval, true, undefined);
		}
		return interval;
	}

	/**
	 * {@inheritdoc IIntervalCollection.changeProperties}
	 */
	public changeProperties(id: string, props: PropertySet) {
		if (!this.attached) {
			throw new LoggingError("Attach must be called before accessing intervals");
		}
		if (typeof id !== "string") {
			throw new LoggingError("Change API requires an ID that is a string");
		}
		if (!props) {
			throw new LoggingError("changeProperties should be called with a property set");
		}
		// prevent the overwriting of an interval label, it should remain unchanged
		// once it has been inserted into the collection.
		if (props[reservedRangeLabelsKey] !== undefined) {
			throw new LoggingError(
				"The label property should not be modified once inserted to the collection",
			);
		}

		const interval = this.getIntervalById(id);
		if (interval) {
			// Pass Unassigned as the sequence number to indicate that this is a local op that is waiting for an ack.
			const deltaProps = interval.addProperties(props, true, UnassignedSequenceNumber);
			const serializedInterval: ISerializedInterval = interval.serialize();

			// Emit a change op that will only change properties. Add the ID to
			// the property bag provided by the caller.
			serializedInterval.start = undefined as any;
			serializedInterval.end = undefined as any;

			serializedInterval.properties = props;
			serializedInterval.properties[reservedIntervalIdKey] = interval.getIntervalId();
			const localSeq = this.getNextLocalSeq();
			this.localSeqToSerializedInterval.set(localSeq, serializedInterval);
			this.emitter.emit("change", undefined, serializedInterval, { localSeq });
			this.emit("propertyChanged", interval, deltaProps, true, undefined);
		}
	}

	/**
	 * {@inheritdoc IIntervalCollection.change}
	 */
	public change(id: string, start?: number, end?: number): TInterval | undefined {
		if (!this.localCollection) {
			throw new LoggingError("Attach must be called before accessing intervals");
		}

		// Force id to be a string.
		if (typeof id !== "string") {
			throw new LoggingError("Change API requires an ID that is a string");
		}

		const interval = this.getIntervalById(id);
		if (interval) {
			const newInterval = this.localCollection.changeInterval(interval, start, end);
			if (!newInterval) {
				return undefined;
			}
			const serializedInterval: SerializedIntervalDelta = interval.serialize();
			serializedInterval.start = start;
			serializedInterval.end = end;
			// Emit a property bag containing only the ID, as we don't intend for this op to change any properties.
			serializedInterval.properties = {
				[reservedIntervalIdKey]: interval.getIntervalId(),
			};
			const localSeq = this.getNextLocalSeq();
			this.localSeqToSerializedInterval.set(localSeq, serializedInterval);
			this.emitter.emit("change", undefined, serializedInterval, { localSeq });
			this.addPendingChange(id, serializedInterval);
			this.emitChange(newInterval, interval, true, false);
			return newInterval;
		}
		// No interval to change
		return undefined;
	}

	private addPendingChange(id: string, serializedInterval: SerializedIntervalDelta) {
		if (serializedInterval.start !== undefined) {
			this.addPendingChangeHelper(id, this.pendingChangesStart, serializedInterval);
		}
		if (serializedInterval.end !== undefined) {
			this.addPendingChangeHelper(id, this.pendingChangesEnd, serializedInterval);
		}
	}

	private addPendingChangeHelper(
		id: string,
		pendingChanges: Map<string, SerializedIntervalDelta[]>,
		serializedInterval: SerializedIntervalDelta,
	) {
		let entries: SerializedIntervalDelta[] | undefined = pendingChanges.get(id);
		if (!entries) {
			entries = [];
			pendingChanges.set(id, entries);
		}
		entries.push(serializedInterval);
	}

	private removePendingChange(serializedInterval: SerializedIntervalDelta) {
		// Change ops always have an ID.
		const id: string = serializedInterval.properties?.[reservedIntervalIdKey];
		if (serializedInterval.start !== undefined) {
			this.removePendingChangeHelper(id, this.pendingChangesStart, serializedInterval);
		}
		if (serializedInterval.end !== undefined) {
			this.removePendingChangeHelper(id, this.pendingChangesEnd, serializedInterval);
		}
	}

	private removePendingChangeHelper(
		id: string,
		pendingChanges: Map<string, SerializedIntervalDelta[]>,
		serializedInterval: SerializedIntervalDelta,
	) {
		const entries = pendingChanges.get(id);
		if (entries) {
			const pendingChange = entries.shift();
			if (entries.length === 0) {
				pendingChanges.delete(id);
			}
			if (
				pendingChange?.start !== serializedInterval.start ||
				pendingChange?.end !== serializedInterval.end
			) {
				throw new LoggingError("Mismatch in pending changes");
			}
		}
	}

	private hasPendingChangeStart(id: string) {
		const entries = this.pendingChangesStart.get(id);
		return entries && entries.length !== 0;
	}

	private hasPendingChangeEnd(id: string) {
		const entries = this.pendingChangesEnd.get(id);
		return entries && entries.length !== 0;
	}

	/** @internal */
	public ackChange(
		serializedInterval: ISerializedInterval,
		local: boolean,
		op: ISequencedDocumentMessage,
		localOpMetadata: IMapMessageLocalMetadata | undefined,
	) {
		if (!this.localCollection) {
			throw new LoggingError("Attach must be called before accessing intervals");
		}

		if (local) {
			assert(
				localOpMetadata !== undefined,
				0x552 /* op metadata should be defined for local op */,
			);
			this.localSeqToSerializedInterval.delete(localOpMetadata?.localSeq);
			// This is an ack from the server. Remove the pending change.
			this.removePendingChange(serializedInterval);
		}

		// Note that the ID is in the property bag only to allow us to find the interval.
		// This API cannot change the ID, and writing to the ID property will result in an exception. So we
		// strip it out of the properties here.
		const { [reservedIntervalIdKey]: id, ...newProps } = serializedInterval.properties ?? {};
		assert(id !== undefined, 0x3fe /* id must exist on the interval */);
		const interval: TInterval | undefined = this.getIntervalById(id);
		if (!interval) {
			// The interval has been removed locally; no-op.
			return;
		}

		if (local) {
			// Let the propertyManager prune its pending change-properties set.
			interval.propertyManager?.ackPendingProperties({
				type: MergeTreeDeltaType.ANNOTATE,
				props: serializedInterval.properties ?? {},
			});

			this.ackInterval(interval, op);
		} else {
			// If there are pending changes with this ID, don't apply the remote start/end change, as the local ack
			// should be the winning change.
			let start: number | undefined;
			let end: number | undefined;
			// Track pending start/end independently of one another.
			if (!this.hasPendingChangeStart(id)) {
				start = serializedInterval.start;
			}
			if (!this.hasPendingChangeEnd(id)) {
				end = serializedInterval.end;
			}

			let newInterval = interval;
			if (start !== undefined || end !== undefined) {
				// If changeInterval gives us a new interval, work with that one. Otherwise keep working with
				// the one we originally found in the tree.
				newInterval =
					this.localCollection.changeInterval(interval, start, end, op) ?? interval;
			}
			const deltaProps = newInterval.addProperties(newProps, true, op.sequenceNumber);
			if (this.onDeserialize) {
				this.onDeserialize(newInterval);
			}

			if (newInterval !== interval) {
				this.emitChange(newInterval, interval, local, false, op);
			}

			const changedProperties = Object.keys(newProps).length > 0;
			if (changedProperties) {
				this.emit("propertyChanged", interval, deltaProps, local, op);
			}
		}
	}

	/**
	 * @deprecated - This functionality was useful when adding two intervals at the same start/end positions resulted
	 * in a conflict. This is no longer the case (as of PR#6407), as interval collections support multiple intervals
	 * at the same location and gives each interval a unique id.
	 *
	 * As such, the conflict resolver is never invoked and unnecessary. This API will be removed in an upcoming release.
	 */
	public addConflictResolver(_: IntervalConflictResolver<TInterval>): void {
		if (!this.localCollection) {
			throw new LoggingError("attachSequence must be called");
		}
	}

	/**
	 * {@inheritdoc IIntervalCollection.attachDeserializer}
	 */
	public attachDeserializer(onDeserialize: DeserializeCallback): void {
		// If no deserializer is specified can skip all processing work
		if (!onDeserialize) {
			return;
		}

		// Start by storing the callbacks so that any subsequent modifications make use of them
		this.onDeserialize = onDeserialize;

		// Trigger the async prepare work across all values in the collection
		if (this.attached) {
			this.map(onDeserialize);
		}
	}

	/**
	 * Returns new interval after rebasing. If undefined, the interval was
	 * deleted as a result of rebasing. This can occur if the interval applies
	 * to a range that no longer exists, and the interval was unable to slide.
	 *
	 * @internal
	 */
	public rebaseLocalInterval(
		opName: string,
		serializedInterval: SerializedIntervalDelta,
		localSeq: number,
	): SerializedIntervalDelta | undefined {
		if (!this.client) {
			// If there's no associated mergeTree client, the originally submitted op is still correct.
			return serializedInterval;
		}
		if (!this.attached) {
			throw new LoggingError("attachSequence must be called");
		}

		const { intervalType, properties } = serializedInterval;

		const { start: startRebased, end: endRebased } =
			this.localSeqToRebasedInterval.get(localSeq) ?? this.computeRebasedPositions(localSeq);

		const intervalId = properties?.[reservedIntervalIdKey];
		const localInterval = this.localCollection?.idIntervalIndex.getIntervalById(intervalId);

		const rebased: SerializedIntervalDelta = {
			start: startRebased,
			end: endRebased,
			intervalType,
			sequenceNumber: this.client?.getCurrentSeq() ?? 0,
			properties,
		};

		if (
			opName === "change" &&
			(this.hasPendingChangeStart(intervalId) || this.hasPendingChangeEnd(intervalId))
		) {
			this.removePendingChange(serializedInterval);
			this.addPendingChange(intervalId, rebased);
		}

		// if the interval slid off the string, rebase the op to be a noop and delete the interval.
		if (
			startRebased === DetachedReferencePosition ||
			endRebased === DetachedReferencePosition
		) {
			if (localInterval) {
				this.localCollection?.removeExistingInterval(localInterval);
			}
			return undefined;
		}

		if (localInterval !== undefined) {
			// we know we must be using `SequenceInterval` because `this.client` exists
			assert(
				localInterval instanceof SequenceInterval,
				0x3a0 /* localInterval must be `SequenceInterval` when used with client */,
			);
			// The rebased op may place this interval's endpoints on different segments. Calling `changeInterval` here
			// updates the local client's state to be consistent with the emitted op.
			this.localCollection?.changeInterval(
				localInterval,
				startRebased,
				endRebased,
				undefined,
				localSeq,
			);
		}

		return rebased;
	}

	private getSlideToSegment(lref: LocalReferencePosition) {
		if (!this.client) {
			throw new LoggingError("client does not exist");
		}
		const segoff = { segment: lref.getSegment(), offset: lref.getOffset() };
		if (segoff.segment?.localRefs?.has(lref) !== true) {
			return undefined;
		}
		const newSegoff = this.client.getSlideToSegment(segoff);
		const value: { segment: ISegment | undefined; offset: number | undefined } | undefined =
			segoff.segment === newSegoff.segment && segoff.offset === newSegoff.offset
				? undefined
				: newSegoff;
		return value;
	}

	private setSlideOnRemove(lref: LocalReferencePosition) {
		let refType = lref.refType;
		refType = refType & ~ReferenceType.StayOnRemove;
		refType = refType | ReferenceType.SlideOnRemove;
		lref.refType = refType;
	}

	private ackInterval(interval: TInterval, op: ISequencedDocumentMessage) {
		// Only SequenceIntervals need potential sliding
		if (!(interval instanceof SequenceInterval)) {
			return;
		}

		if (
			!refTypeIncludesFlag(interval.start, ReferenceType.StayOnRemove) &&
			!refTypeIncludesFlag(interval.end, ReferenceType.StayOnRemove)
		) {
			return;
		}

		const newStart = this.getSlideToSegment(interval.start);
		const newEnd = this.getSlideToSegment(interval.end);

		const id = interval.properties[reservedIntervalIdKey];
		const hasPendingStartChange = this.hasPendingChangeStart(id);
		const hasPendingEndChange = this.hasPendingChangeEnd(id);

		if (!hasPendingStartChange) {
			this.setSlideOnRemove(interval.start);
		}

		if (!hasPendingEndChange) {
			this.setSlideOnRemove(interval.end);
		}

		const needsStartUpdate = newStart !== undefined && !hasPendingStartChange;
		const needsEndUpdate = newEnd !== undefined && !hasPendingEndChange;

		if (needsStartUpdate || needsEndUpdate) {
			if (!this.localCollection) {
				throw new LoggingError("Attach must be called before accessing intervals");
			}

			// `interval`'s endpoints will get modified in-place, so clone it prior to doing so for event emission.
			const oldInterval = interval.clone() as TInterval & SequenceInterval;

			// In this case, where we change the start or end of an interval,
			// it is necessary to remove and re-add the interval listeners.
			// This ensures that the correct listeners are added to the LocalReferencePosition.
			this.localCollection.removeExistingInterval(interval);
			if (!this.client) {
				throw new LoggingError("client does not exist");
			}

			if (needsStartUpdate) {
				const props = interval.start.properties;
				interval.start = createPositionReferenceFromSegoff(
					this.client,
					newStart,
					interval.start.refType,
					op,
					startReferenceSlidingPreference(interval.stickiness),
				);
				if (props) {
					interval.start.addProperties(props);
				}
				const oldSeg = oldInterval.start.getSegment();
				// remove and rebuild start interval as transient for event
				this.client.removeLocalReferencePosition(oldInterval.start);
				oldInterval.start.refType = ReferenceType.Transient;
				oldSeg?.localRefs?.addLocalRef(oldInterval.start, oldInterval.start.getOffset());
			}
			if (needsEndUpdate) {
				const props = interval.end.properties;
				interval.end = createPositionReferenceFromSegoff(
					this.client,
					newEnd,
					interval.end.refType,
					op,
					endReferenceSlidingPreference(interval.stickiness),
				);
				if (props) {
					interval.end.addProperties(props);
				}
				// remove and rebuild end interval as transient for event
				const oldSeg = oldInterval.end.getSegment();
				this.client.removeLocalReferencePosition(oldInterval.end);
				oldInterval.end.refType = ReferenceType.Transient;
				oldSeg?.localRefs?.addLocalRef(oldInterval.end, oldInterval.end.getOffset());
			}
			this.localCollection.add(interval);
			this.emitChange(interval, oldInterval as TInterval, true, true, op);
		}
	}

	/** @internal */
	public ackAdd(
		serializedInterval: ISerializedInterval,
		local: boolean,
		op: ISequencedDocumentMessage,
		localOpMetadata: IMapMessageLocalMetadata | undefined,
	) {
		if (local) {
			assert(
				localOpMetadata !== undefined,
				0x553 /* op metadata should be defined for local op */,
			);
			this.localSeqToSerializedInterval.delete(localOpMetadata.localSeq);
			const id: string = serializedInterval.properties?.[reservedIntervalIdKey];
			const localInterval = this.getIntervalById(id);
			if (localInterval) {
				this.ackInterval(localInterval, op);
			}
			return;
		}

		if (!this.localCollection) {
			throw new LoggingError("attachSequence must be called");
		}

		this.localCollection.ensureSerializedId(serializedInterval);

		const interval: TInterval = this.localCollection.addInterval(
			serializedInterval.start,
			serializedInterval.end,
			serializedInterval.intervalType,
			serializedInterval.properties,
			op,
			serializedInterval.stickiness,
		);

		if (interval) {
			if (this.onDeserialize) {
				this.onDeserialize(interval);
			}
		}

		this.emit("addInterval", interval, local, op);

		return interval;
	}

	/** @internal */
	public ackDelete(
		serializedInterval: ISerializedInterval,
		local: boolean,
		op: ISequencedDocumentMessage,
	): void {
		if (local) {
			// Local ops were applied when the message was created and there's no "pending delete"
			// state to bookkeep: remote operation application takes into account possibility of
			// locally deleted interval whenever a lookup happens.
			return;
		}

		if (!this.localCollection) {
			throw new LoggingError("attach must be called prior to deleting intervals");
		}

		const id = this.localCollection.ensureSerializedId(serializedInterval);
		const interval = this.localCollection.idIntervalIndex.getIntervalById(id);
		if (interval) {
			this.deleteExistingInterval(interval, local, op);
		}
	}

	/**
	 * @internal
	 */
	public serializeInternal(): ISerializedIntervalCollectionV2 {
		if (!this.localCollection) {
			throw new LoggingError("attachSequence must be called");
		}

		return this.localCollection.serialize();
	}

	/**
	 * @returns an iterator over all intervals in this collection.
	 */
	public [Symbol.iterator](): IntervalCollectionIterator<TInterval> {
		const iterator = new IntervalCollectionIterator<TInterval>(this);
		return iterator;
	}

	/**
	 * {@inheritdoc IIntervalCollection.CreateForwardIteratorWithStartPosition}
	 */
	public CreateForwardIteratorWithStartPosition(
		startPosition: number,
	): IntervalCollectionIterator<TInterval> {
		const iterator = new IntervalCollectionIterator<TInterval>(this, true, startPosition);
		return iterator;
	}

	/**
	 * {@inheritdoc IIntervalCollection.CreateBackwardIteratorWithStartPosition}
	 */
	public CreateBackwardIteratorWithStartPosition(
		startPosition: number,
	): IntervalCollectionIterator<TInterval> {
		const iterator = new IntervalCollectionIterator<TInterval>(this, false, startPosition);
		return iterator;
	}

	/**
	 * {@inheritdoc IIntervalCollection.CreateForwardIteratorWithEndPosition}
	 */
	public CreateForwardIteratorWithEndPosition(
		endPosition: number,
	): IntervalCollectionIterator<TInterval> {
		const iterator = new IntervalCollectionIterator<TInterval>(
			this,
			true,
			undefined,
			endPosition,
		);
		return iterator;
	}

	/**
	 * {@inheritdoc IIntervalCollection.CreateBackwardIteratorWithEndPosition}
	 */
	public CreateBackwardIteratorWithEndPosition(
		endPosition: number,
	): IntervalCollectionIterator<TInterval> {
		const iterator = new IntervalCollectionIterator<TInterval>(
			this,
			false,
			undefined,
			endPosition,
		);
		return iterator;
	}

	/**
	 * {@inheritdoc IIntervalCollection.gatherIterationResults}
	 */
	public gatherIterationResults(
		results: TInterval[],
		iteratesForward: boolean,
		start?: number,
		end?: number,
	) {
		if (!this.localCollection) {
			return;
		}

		this.localCollection.overlappingIntervalsIndex.gatherIterationResults(
			results,
			iteratesForward,
			start,
			end,
		);
	}

	/**
	 * {@inheritdoc IIntervalCollection.findOverlappingIntervals}
	 */
	public findOverlappingIntervals(startPosition: number, endPosition: number): TInterval[] {
		if (!this.localCollection) {
			throw new LoggingError("attachSequence must be called");
		}

		return this.localCollection.overlappingIntervalsIndex.findOverlappingIntervals(
			startPosition,
			endPosition,
		);
	}

	/**
	 * {@inheritdoc IIntervalCollection.map}
	 */
	public map(fn: (interval: TInterval) => void) {
		if (!this.localCollection) {
			throw new LoggingError("attachSequence must be called");
		}

		for (const interval of this.localCollection.idIntervalIndex) {
			fn(interval);
		}
	}

	/**
	 * {@inheritdoc IIntervalCollection.previousInterval}
	 */
	public previousInterval(pos: number): TInterval | undefined {
		if (!this.localCollection) {
			throw new LoggingError("attachSequence must be called");
		}

		return this.localCollection.endIntervalIndex.previousInterval(pos);
	}

	/**
	 * {@inheritdoc IIntervalCollection.nextInterval}
	 */
	public nextInterval(pos: number): TInterval | undefined {
		if (!this.localCollection) {
			throw new LoggingError("attachSequence must be called");
		}

		return this.localCollection.endIntervalIndex.nextInterval(pos);
	}
}

/**
 * Information that identifies an interval within a `Sequence`.
 */
export interface IntervalLocator {
	/**
	 * Label for the collection the interval is a part of
	 */
	label: string;
	/**
	 * Interval within that collection
	 */
	interval: SequenceInterval;
}

/**
 * Returns an object that can be used to find the interval a given LocalReferencePosition belongs to.
 * @returns undefined if the reference position is not the endpoint of any interval (e.g. it was created
 * on the merge tree directly by app code), otherwise an {@link IntervalLocator} for the interval this
 * endpoint is a part of.
 */
export function intervalLocatorFromEndpoint(
	potentialEndpoint: LocalReferencePosition,
): IntervalLocator | undefined {
	const { interval, [reservedRangeLabelsKey]: collectionNameArray } =
		potentialEndpoint.properties ?? {};
	return interval && collectionNameArray?.length === 1
		? { label: collectionNameArray[0], interval }
		: undefined;
}
