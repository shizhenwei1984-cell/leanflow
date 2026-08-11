import { randomUUID } from "node:crypto";
import type { LeanFlowPhase, LeanFlowState } from "./state";

/**
 * Immutable authority captured before an asynchronous control-plane operation
 * starts. A result may affect state only while this exact authority remains
 * active; toolCallId is correlation-only and never authority.
 */
export interface ControlOperationIdentity {
	operationId: string;
	sessionId: string;
	runId: string;
	activationEpoch: number;
	phase: LeanFlowPhase;
	planDigest?: string;
	artifactIdentity?: string;
	createdAt: number;
}

export interface ActiveControlAuthority {
	sessionId: string;
	runId: string | undefined;
	activationEpoch: number;
	phase: LeanFlowPhase;
	planDigest: string | undefined;
}


export type ControlOperationKind =
	| "canonical_plan_refresh"
	| "proposal_mutation"
	| "approval_write"
	| "lsp_probe"
	| "gate_call"
	| "marker_publication";

export interface PendingControlOperation<T> {
	kind: ControlOperationKind;
	identity: ControlOperationIdentity;
	payload: T;
}

export function createControlOperationIdentity(
	authority: ActiveControlAuthority,
	artifactIdentity?: string,
	operationId: string = randomUUID(),
): ControlOperationIdentity {
	if (!authority.runId) throw new Error("LeanFlow control operation requires an active run ID");
	return Object.freeze({
		operationId,
		sessionId: authority.sessionId,
		runId: authority.runId,
		activationEpoch: authority.activationEpoch,
		phase: authority.phase,
		...(authority.planDigest ? { planDigest: authority.planDigest } : {}),
		...(artifactIdentity ? { artifactIdentity } : {}),
		createdAt: Date.now(),
	});
}

export function isControlOperationCurrent(
	identity: ControlOperationIdentity,
	authority: ActiveControlAuthority,
): boolean {
	return (
		identity.sessionId === authority.sessionId &&
		identity.runId === authority.runId &&
		identity.activationEpoch === authority.activationEpoch &&
		identity.phase === authority.phase &&
		identity.planDigest === authority.planDigest
	);
}

/**
 * The shared commit gate. Specialized callback gates add lease/artifact checks,
 * but no callback may mutate state unless this identity still owns the active
 * session, run, activation, phase, and plan revision.
 */
export function canCommitOperation(identity: ControlOperationIdentity, currentState: LeanFlowState): boolean {
	return (
		currentState.controlSessionId === identity.sessionId &&
		currentState.runId === identity.runId &&
		currentState.controlOperationEpoch === identity.activationEpoch &&
		currentState.phase === identity.phase &&
		currentState.planDigest === identity.planDigest
	);
}

/**
 * A control operation may change its own phase synchronously before awaiting
 * follow-up effects. Continuations retain the original session/run/epoch and
 * artifact authority, but never let a later activation inherit that work.
 */
export function isControlOperationContinuationCurrent(
	identity: ControlOperationIdentity,
	authority: ActiveControlAuthority,
): boolean {
	return (
		identity.sessionId === authority.sessionId &&
		identity.runId === authority.runId &&
		identity.activationEpoch === authority.activationEpoch &&
		identity.planDigest === authority.planDigest
	);
}

/**
 * Correlates a tool result to immutable authority. The key is transport-only;
 * callers receive an identity and must validate it before mutating state.
 */
/**
 * Pending control operations are keyed by immutable operation identity.
 * toolCallId remains an internal transport correlation only and is never
 * consulted as state authority.
 */
export class PendingOperationRegistry<T> {
	readonly #operations = new Map<string, PendingControlOperation<T>>();
	readonly #transport = new Map<string, string>();

	register(
		toolCallId: string,
		identity: ControlOperationIdentity,
		operation: Omit<PendingControlOperation<T>, "identity">,
	): { ok: true } | { ok: false; reason: "duplicate_transport" } {
		if (this.#transport.has(toolCallId) || this.#operations.has(identity.operationId)) {
			return { ok: false, reason: "duplicate_transport" };
		}
		this.#operations.set(identity.operationId, Object.freeze({ ...operation, identity }));
		this.#transport.set(toolCallId, identity.operationId);
		return { ok: true };
	}

	peekTransport(toolCallId: string): PendingControlOperation<T> | undefined {
		const operationId = this.#transport.get(toolCallId);
		return operationId === undefined ? undefined : this.#operations.get(operationId);
	}

	takeTransportIfKind(
		toolCallId: string,
		expectedKind: ControlOperationKind,
	): PendingControlOperation<T> | undefined {
		const operationId = this.#transport.get(toolCallId);
		if (operationId === undefined) return undefined;
		const operation = this.#operations.get(operationId);
		if (!operation || operation.kind !== expectedKind) return undefined;
		this.#transport.delete(toolCallId);
		this.#operations.delete(operationId);
		return operation;
	}

	list(predicate: (operation: PendingControlOperation<T>) => boolean): readonly PendingControlOperation<T>[] {
		return [...this.#operations.values()].filter(predicate);
	}

	drain(predicate: (operation: PendingControlOperation<T>) => boolean): PendingControlOperation<T>[] {
		const drained = this.list(predicate);
		for (const operation of drained) this.#operations.delete(operation.identity.operationId);
		this.#pruneTransport();
		return [...drained];
	}

	invalidateEpoch(epoch: number): void {
		this.drain((operation) => operation.identity.activationEpoch <= epoch);
	}

	invalidateRun(runId: string): void {
		this.drain((operation) => operation.identity.runId === runId);
	}

	pendingTransport(kind?: ControlOperationKind): readonly string[] {
		return [...this.#transport].flatMap(([toolCallId, operationId]) => {
			const operation = this.#operations.get(operationId);
			return operation && (kind === undefined || operation.kind === kind) ? [toolCallId] : [];
		});
	}

	count(kind?: ControlOperationKind): number {
		return kind === undefined ? this.#operations.size : this.pendingTransport(kind).length;
	}

	isConsistent(): boolean {
		const operationIds = new Set<string>();
		for (const operationId of this.#transport.values()) {
			if (!this.#operations.has(operationId) || operationIds.has(operationId)) return false;
			operationIds.add(operationId);
		}
		return operationIds.size === this.#operations.size;
	}

	clear(): void {
		this.#operations.clear();
		this.#transport.clear();
	}

	#pruneTransport(): void {
		for (const [toolCallId, operationId] of this.#transport) {
			if (!this.#operations.has(operationId)) this.#transport.delete(toolCallId);
		}
	}
}

