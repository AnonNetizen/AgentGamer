import { z } from "zod";
import { createTypertRemoteInfo } from "@deepseek-ai/dsh-typert-protocol/remote-info";

// Explicit contribution uses the same lazy descriptors as DSH's generated controllers.
const text = {
  mode: "strict" as const,
  typeSymbol: "string",
  create: () => z.string(),
  jsonSchema: { type: "string" },
};
export const remoteInfo = createTypertRemoteInfo(
  {
    package: "dsh-plugin-agentgamer",
    methods: {
      "agentgamer/request": {
        service: "agentgamer",
        invocation: { kind: "direct" },
        parameters: [
          { name: "operation", source: "json", codec: text, strictCodec: text },
          { name: "payload", source: "json", codec: text, strictCodec: text },
        ],
        result: text,
      },
    },
  },
  z,
);
