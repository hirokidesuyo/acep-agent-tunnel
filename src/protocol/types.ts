import { randomUUID } from "node:crypto";
import { z } from "zod";

export const ACEP_PROTOCOL_VERSION = "acep/1.0" as const;

export const TrustModeSchema = z.enum(["trusted", "public"]);
export type TrustMode = z.infer<typeof TrustModeSchema>;

export const SenderRoleSchema = z.enum(["host", "seeker"]);
export type SenderRole = z.infer<typeof SenderRoleSchema>;

export const MessageTypeSchema = z.enum([
  "HANDSHAKE",
  "QUERY",
  "NEED_INFO",
  "ANSWER",
  "CLOSE",
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const HandshakePayloadSchema = z.object({
  purpose: z.string(),
  trust_mode: TrustModeSchema,
  capabilities: z.array(z.string()).default([]),
  context_summary: z.string().optional(),
});

export const QueryPayloadSchema = z.object({
  question: z.string(),
  context_slots: z.record(z.unknown()).default({}),
  requested_slots: z.array(z.string()).default([]),
});

export const NeedInfoPayloadSchema = z.object({
  reason: z.string(),
  requested_slots: z.array(z.string()).min(1),
});

export const AnswerPayloadSchema = z.object({
  summary: z.string(),
  provided_slots: z.record(z.unknown()).default({}),
  verification_steps: z.array(z.string()).default([]),
});

export const ClosePayloadSchema = z.object({
  reason: z.enum(["resolved", "timeout", "cancelled"]),
});

export const AcepMessageSchema = z.object({
  protocol: z.literal(ACEP_PROTOCOL_VERSION),
  channel_id: z.string().min(1),
  message_id: z.string().min(1),
  reply_to: z.string().nullable().default(null),
  sender_role: SenderRoleSchema,
  type: MessageTypeSchema,
  timestamp: z.string(),
  payload: z.record(z.unknown()),
});

export type AcepMessage = z.infer<typeof AcepMessageSchema>;

export function createAcepMessage(params: {
  channel_id: string;
  sender_role: SenderRole;
  type: MessageType;
  payload: Record<string, unknown>;
  reply_to?: string | null;
}): AcepMessage {
  return {
    protocol: ACEP_PROTOCOL_VERSION,
    channel_id: params.channel_id,
    message_id: `msg_${randomUUID().slice(0, 12)}`,
    reply_to: params.reply_to ?? null,
    sender_role: params.sender_role,
    type: params.type,
    timestamp: new Date().toISOString(),
    payload: params.payload,
  };
}
