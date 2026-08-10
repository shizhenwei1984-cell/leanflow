import { createHash, randomUUID } from "node:crypto";
import type { OperationLease, RepositoryFingerprint } from "./state";
import {
	validationStatesDigest,
	type ValidationSemanticState,
	type ValidationSemanticStatus,
} from "./validation";

export const FINALIZED_GATE_SNAPSHOT_VERSION = 2 as const;
export const OPERATIONAL_RETRY_SNAPSHOT_VERSION = 1 as const;

export type OperationalInterruption = "tool_error" | "session_switch" | "transport_error" | "invalid_gate_output";

export interface FinalizedGateSnapshot {
	version: 2;
	/** Cryptographically unpredictable commit binding shared only with the durable state entry. */
	finalizationCommitNonce: string;
	runId: string;
	planSlug: string;
	planDigest: string;
	approvedValidationDigest: string;
	buildRecordRound: number;
	buildRecordDigest: string;
	buildArtifactDigest: string;
	diffArtifactDigest: string;
	evidenceArtifactDigest: string;
	repositoryFingerprint: RepositoryFingerprint;
	validationStates: ValidationSemanticState[];
	validationStatesDigest: string;
	semanticEvidenceDigest: string;
	finalizedAt: string;
}

export interface OperationalRetrySnapshot {
	version: 1;
	originalGateLease: OperationLease;
	finalizedSnapshotDigest: string;
	interruptedBy: OperationalInterruption;
	createdAt: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINALIZED_KEYS = [
	"version",
	"finalizationCommitNonce",
	"runId",
	"planSlug",
	"planDigest",
	"approvedValidationDigest",
	"buildRecordRound",
	"buildRecordDigest",
	"buildArtifactDigest",
	"diffArtifactDigest",
	"evidenceArtifactDigest",
	"repositoryFingerprint",
	"validationStates",
	"validationStatesDigest",
	"semanticEvidenceDigest",
	"finalizedAt",
] as const;
const RETRY_KEYS = ["version", "originalGateLease", "finalizedSnapshotDigest", "interruptedBy", "createdAt"] as const;
const FINGERPRINT_KEYS = ["head", "trackedDiffDigest", "untrackedDigest", "combinedDigest"] as const;
const LEASE_KEYS = [
	"toolCallId",
	"kind",
	"runId",
	"cycle",
	"startedAt",
	"snapshotDigest",
	"planDigest",
	"buildRecordRound",
	"repositoryFingerprint",
	"lspTarget",
] as const;
const VALIDATION_STATE_KEYS = ["id", "status", "observationId", "normalizedOutputDigest", "repositoryFingerprintAfter"] as const;
const VALIDATION_STATUSES = new Set<ValidationSemanticStatus>(["missing", "failed", "stale", "passed"]);
const INTERRUPTION_TYPES = new Set<OperationalInterruption>([
	"tool_error",
	"session_switch",
	"transport_error",
	"invalid_gate_output",
]);

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isSha(value: unknown): value is string {
	return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function isFinalizationCommitNonce(value: unknown): value is string {
	return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

function parseRepositoryFingerprint(value: unknown): RepositoryFingerprint | undefined {
	if (!isPlainRecord(value) || !hasExactKeys(value, FINGERPRINT_KEYS)) return undefined;
	if (
		!nonEmpty(value.head) ||
		!isSha(value.trackedDiffDigest) ||
		!isSha(value.untrackedDigest) ||
		!isSha(value.combinedDigest)
	) {
		return undefined;
	}
	return {
		head: value.head,
		trackedDiffDigest: value.trackedDiffDigest,
		untrackedDigest: value.untrackedDigest,
		combinedDigest: value.combinedDigest,
	};
}

function parseValidationStates(value: unknown): ValidationSemanticState[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const states: ValidationSemanticState[] = [];
	const seen = new Set<string>();
	for (const candidate of value) {
		if (
			!isPlainRecord(candidate) ||
			!Object.keys(candidate).every((key) => (VALIDATION_STATE_KEYS as readonly string[]).includes(key))
		) {
			return undefined;
		}
		if (
			!nonEmpty(candidate.id) ||
			!VALIDATION_STATUSES.has(candidate.status as ValidationSemanticStatus) ||
			(candidate.status !== "missing" && !nonEmpty(candidate.observationId)) ||
			(candidate.normalizedOutputDigest !== undefined && !isSha(candidate.normalizedOutputDigest)) ||
			(candidate.repositoryFingerprintAfter !== undefined && !isSha(candidate.repositoryFingerprintAfter)) ||
			seen.has(candidate.id)
		) {
			return undefined;
		}
		seen.add(candidate.id);
		states.push({
			id: candidate.id,
			status: candidate.status as ValidationSemanticStatus,
			...(candidate.observationId !== undefined ? { observationId: candidate.observationId as string } : {}),
			...(candidate.normalizedOutputDigest !== undefined
				? { normalizedOutputDigest: candidate.normalizedOutputDigest as string }
				: {}),
			...(candidate.repositoryFingerprintAfter !== undefined
				? { repositoryFingerprintAfter: candidate.repositoryFingerprintAfter as string }
				: {}),
		});
	}
	return states;
}

function parseOperationLease(value: unknown): OperationLease | undefined {
	if (!isPlainRecord(value) || !Object.keys(value).every((key) => (LEASE_KEYS as readonly string[]).includes(key))) return undefined;
	const fingerprint = parseRepositoryFingerprint(value.repositoryFingerprint);
	if (
		value.kind !== "gate" ||
		!nonEmpty(value.toolCallId) ||
		!nonEmpty(value.runId) ||
		!Number.isInteger(value.cycle) ||
		(value.cycle as number) < 1 ||
		typeof value.startedAt !== "number" ||
		!Number.isFinite(value.startedAt) ||
		!isSha(value.snapshotDigest) ||
		!isSha(value.planDigest) ||
		!Number.isInteger(value.buildRecordRound) ||
		(value.buildRecordRound as number) < 1 ||
		!fingerprint ||
		value.lspTarget !== undefined
	) {
		return undefined;
	}
	return {
		toolCallId: value.toolCallId,
		kind: "gate",
		runId: value.runId,
		cycle: value.cycle as number,
		startedAt: value.startedAt,
		snapshotDigest: value.snapshotDigest,
		planDigest: value.planDigest,
		buildRecordRound: value.buildRecordRound as number,
		repositoryFingerprint: fingerprint,
	};
}

export function finalizedGateSnapshotDigest(snapshot: FinalizedGateSnapshot): string {
	return sha256(JSON.stringify(snapshot));
}

export function semanticEvidenceDigest(
	approvedValidationDigest: string,
	repositoryFingerprint: RepositoryFingerprint,
	states: readonly ValidationSemanticState[],
): string {
	return sha256(
		JSON.stringify({
			approvedValidationDigest,
			repositoryFingerprint: repositoryFingerprint.combinedDigest,
			validationStates: states.map((state) => ({
				id: state.id,
				status: state.status,
				...(state.normalizedOutputDigest !== undefined
					? { normalizedOutputDigest: state.normalizedOutputDigest }
					: {}),
				...(state.repositoryFingerprintAfter !== undefined
					? { repositoryFingerprintAfter: state.repositoryFingerprintAfter }
					: {}),
			})),
		}),
	);
}

export function createFinalizedGateSnapshot(
	input: Omit<
		FinalizedGateSnapshot,
		"version" | "finalizationCommitNonce" | "validationStatesDigest" | "semanticEvidenceDigest" | "finalizedAt"
	> & { finalizedAt?: string; finalizationCommitNonce?: string },
): FinalizedGateSnapshot {
	const snapshot: FinalizedGateSnapshot = {
		version: FINALIZED_GATE_SNAPSHOT_VERSION,
		finalizationCommitNonce: input.finalizationCommitNonce ?? randomUUID(),
		runId: input.runId,
		planSlug: input.planSlug,
		planDigest: input.planDigest,
		approvedValidationDigest: input.approvedValidationDigest,
		buildRecordRound: input.buildRecordRound,
		buildRecordDigest: input.buildRecordDigest,
		buildArtifactDigest: input.buildArtifactDigest,
		diffArtifactDigest: input.diffArtifactDigest,
		evidenceArtifactDigest: input.evidenceArtifactDigest,
		repositoryFingerprint: input.repositoryFingerprint,
		validationStates: input.validationStates.map((state) => ({ ...state })),
		validationStatesDigest: validationStatesDigest(input.validationStates),
		semanticEvidenceDigest: semanticEvidenceDigest(
			input.approvedValidationDigest,
			input.repositoryFingerprint,
			input.validationStates,
		),
		finalizedAt: input.finalizedAt ?? new Date().toISOString(),
	};
	const parsed = parseFinalizedGateSnapshot(snapshot);
	if (!parsed) throw new Error("cannot create an invalid finalized Gate snapshot");
	return parsed;
}

export function parseFinalizedGateSnapshot(value: unknown): FinalizedGateSnapshot | undefined {
	if (!isPlainRecord(value) || !hasExactKeys(value, FINALIZED_KEYS)) return undefined;
	const repositoryFingerprint = parseRepositoryFingerprint(value.repositoryFingerprint);
	const validationStates = parseValidationStates(value.validationStates);
	if (
		value.version !== FINALIZED_GATE_SNAPSHOT_VERSION ||
		!isFinalizationCommitNonce(value.finalizationCommitNonce) ||
		!nonEmpty(value.runId) ||
		!RUN_ID_PATTERN.test(value.runId) ||
		!nonEmpty(value.planSlug) ||
		!isSha(value.planDigest) ||
		!isSha(value.approvedValidationDigest) ||
		!Number.isInteger(value.buildRecordRound) ||
		(value.buildRecordRound as number) < 1 ||
		!isSha(value.buildRecordDigest) ||
		!isSha(value.buildArtifactDigest) ||
		!isSha(value.diffArtifactDigest) ||
		!isSha(value.evidenceArtifactDigest) ||
		!repositoryFingerprint ||
		!validationStates ||
		!isSha(value.validationStatesDigest) ||
		!isSha(value.semanticEvidenceDigest) ||
		!nonEmpty(value.finalizedAt) ||
		!Number.isFinite(Date.parse(value.finalizedAt))
	) {
		return undefined;
	}
	const parsed: FinalizedGateSnapshot = {
		version: FINALIZED_GATE_SNAPSHOT_VERSION,
		finalizationCommitNonce: value.finalizationCommitNonce,
		runId: value.runId,
		planSlug: value.planSlug,
		planDigest: value.planDigest,
		approvedValidationDigest: value.approvedValidationDigest,
		buildRecordRound: value.buildRecordRound as number,
		buildRecordDigest: value.buildRecordDigest,
		buildArtifactDigest: value.buildArtifactDigest,
		diffArtifactDigest: value.diffArtifactDigest,
		evidenceArtifactDigest: value.evidenceArtifactDigest,
		repositoryFingerprint,
		validationStates,
		validationStatesDigest: value.validationStatesDigest,
		semanticEvidenceDigest: value.semanticEvidenceDigest,
		finalizedAt: value.finalizedAt,
	};
	if (validationStatesDigest(parsed.validationStates) !== parsed.validationStatesDigest) return undefined;
	if (
		semanticEvidenceDigest(parsed.approvedValidationDigest, parsed.repositoryFingerprint, parsed.validationStates) !==
		parsed.semanticEvidenceDigest
	) {
		return undefined;
	}
	return parsed;
}

export function createOperationalRetrySnapshot(
	originalGateLease: OperationLease,
	finalizedSnapshot: FinalizedGateSnapshot,
	interruptedBy: OperationalInterruption,
	now = new Date().toISOString(),
): OperationalRetrySnapshot {
	const retry: OperationalRetrySnapshot = {
		version: OPERATIONAL_RETRY_SNAPSHOT_VERSION,
		originalGateLease,
		finalizedSnapshotDigest: finalizedGateSnapshotDigest(finalizedSnapshot),
		interruptedBy,
		createdAt: now,
	};
	const parsed = parseOperationalRetrySnapshot(retry);
	if (!parsed) throw new Error("cannot create an invalid operational retry snapshot");
	return parsed;
}

export function parseOperationalRetrySnapshot(value: unknown): OperationalRetrySnapshot | undefined {
	if (!isPlainRecord(value) || !hasExactKeys(value, RETRY_KEYS)) return undefined;
	const originalGateLease = parseOperationLease(value.originalGateLease);
	if (
		value.version !== OPERATIONAL_RETRY_SNAPSHOT_VERSION ||
		!originalGateLease ||
		!isSha(value.finalizedSnapshotDigest) ||
		!INTERRUPTION_TYPES.has(value.interruptedBy as OperationalInterruption) ||
		!nonEmpty(value.createdAt) ||
		!Number.isFinite(Date.parse(value.createdAt))
	) {
		return undefined;
	}
	return {
		version: OPERATIONAL_RETRY_SNAPSHOT_VERSION,
		originalGateLease,
		finalizedSnapshotDigest: value.finalizedSnapshotDigest,
		interruptedBy: value.interruptedBy as OperationalInterruption,
		createdAt: value.createdAt,
	};
}
