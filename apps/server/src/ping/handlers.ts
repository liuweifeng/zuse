import { MemoizeRpcs, PingResult } from "@zuse/contracts";
import { Effect, Layer } from "effect";

const PingPing = MemoizeRpcs.toLayerHandler("ping.ping", () =>
  Effect.succeed(PingResult.make({ message: "pong", receivedAt: new Date() })),
);

export const PingHandlersLayer = Layer.mergeAll(PingPing);
