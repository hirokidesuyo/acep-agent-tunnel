import { describe, it, expect } from "vitest";
import {
  ACEP_PROTOCOL_VERSION,
  AcepMessageSchema,
  createAcepMessage,
} from "../src/protocol/types.js";

describe("ACEP Protocol", () => {
  it("creates and validates a QUERY message", () => {
    const msg = createAcepMessage({
      channel_id: "ch_123",
      sender_role: "seeker",
      type: "QUERY",
      payload: {
        question: "Why is Gemma running at 50 tok/s?",
        context_slots: { gpu: "RTX4090", backend: "llama.cpp" },
        requested_slots: ["quantization", "launch_args"],
      },
    });

    expect(msg.protocol).toBe(ACEP_PROTOCOL_VERSION);
    expect(msg.channel_id).toBe("ch_123");
    expect(msg.message_id).toMatch(/^msg_/);
    expect(AcepMessageSchema.parse(msg)).toEqual(msg);
  });

  it("rejects invalid protocol version", () => {
    const invalid = {
      protocol: "acep/9.9",
      channel_id: "ch_123",
      message_id: "msg_1",
      reply_to: null,
      sender_role: "seeker",
      type: "QUERY",
      timestamp: new Date().toISOString(),
      payload: { question: "hi" },
    };
    expect(() => AcepMessageSchema.parse(invalid)).toThrow();
  });
});
