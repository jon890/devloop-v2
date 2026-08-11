import { createHash } from "node:crypto";
import { canonicalJson, type CanonicalJsonValue, EvidencePacketSchema, type EvidencePacket } from "@devloop/shared";

export function canonicalString(value: unknown): string {
  return canonicalJson(value as CanonicalJsonValue);
}

export function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function hashCanonical(value: unknown): string {
  return sha256(canonicalString(value));
}

export function packetWithContentHash(packet: Omit<EvidencePacket, "contentHash">): EvidencePacket {
  return EvidencePacketSchema.parse({ ...packet, contentHash: hashCanonical(packet) });
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
